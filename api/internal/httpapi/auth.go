package httpapi

import (
	"errors"
	"html/template"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/jackc/pgx/v5/pgtype"

	"discgo/api/internal/auth"
	"discgo/api/internal/db"
	"discgo/api/internal/protocol"
)

func (s *Server) googleStart(w http.ResponseWriter, r *http.Request) {
	u, err := s.Auth.GoogleAuthURL(r.Context(), r.URL.Query().Get("invite"))
	if errors.Is(err, auth.ErrNotConfigured) {
		writeError(w, http.StatusServiceUnavailable, "not_configured", err.Error())
		return
	}
	if err != nil {
		s.internal(w, r, err)
		return
	}
	http.Redirect(w, r, u, http.StatusFound)
}

func (s *Server) googleCallback(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	if e := q.Get("error"); e != "" {
		renderLogin(w, http.StatusBadRequest, "", "O Google não autorizou o login ("+e+").")
		return
	}
	code, err := s.Auth.GoogleCallback(r.Context(), q.Get("state"), q.Get("code"))
	switch {
	case errors.Is(err, auth.ErrInviteRequired):
		renderLogin(w, http.StatusForbidden, "", "Esta conta ainda não faz parte da comunidade. Peça um convite, informe o código no DiscGo e entre de novo.")
	case errors.Is(err, auth.ErrInviteInvalid):
		renderLogin(w, http.StatusForbidden, "", "O convite é inválido, expirou ou já foi usado.")
	case err != nil:
		s.Log.Warn("google callback failed", "err", err)
		renderLogin(w, http.StatusBadRequest, "", "Não foi possível concluir o login. Tente de novo pelo DiscGo.")
	default:
		renderLogin(w, http.StatusOK, s.AuthRedirect+"?code="+url.QueryEscape(code), "")
	}
}

// devLogin is the Google-free login for development (AUTH_DEV=true).
func (s *Server) devLogin(w http.ResponseWriter, r *http.Request) {
	if !s.AuthDev {
		writeError(w, http.StatusNotFound, "not_found", "not found")
		return
	}
	var body struct {
		Email  string `json:"email"`
		Name   string `json:"name"`
		Invite string `json:"invite"`
	}
	if !decode(w, r, &body) {
		return
	}
	body.Email = strings.ToLower(strings.TrimSpace(body.Email))
	if body.Email == "" {
		writeError(w, http.StatusBadRequest, "bad_request", "email is required")
		return
	}
	code, err := s.Auth.Login(r.Context(), auth.Identity{Subject: "dev:" + body.Email, Email: body.Email, DisplayName: body.Name}, body.Invite)
	if s.loginError(w, err) {
		return
	}
	if err != nil {
		s.internal(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"code": code})
}

func (s *Server) loginError(w http.ResponseWriter, err error) bool {
	switch {
	case errors.Is(err, auth.ErrInviteRequired):
		writeError(w, http.StatusForbidden, "invite_required", "an invite is required for the first login")
	case errors.Is(err, auth.ErrInviteInvalid):
		writeError(w, http.StatusForbidden, "invite_invalid", "invite is invalid, expired or used up")
	default:
		return false
	}
	return true
}

func (s *Server) exchange(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Code string `json:"code"`
	}
	if !decode(w, r, &body) {
		return
	}
	token, user, err := s.Auth.Exchange(r.Context(), body.Code)
	if errors.Is(err, auth.ErrInvalidCode) {
		writeError(w, http.StatusUnauthorized, "invalid_code", err.Error())
		return
	}
	if err != nil {
		s.internal(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"token": token, "user": protocol.FromMe(user)})
}

func (s *Server) logout(w http.ResponseWriter, r *http.Request) {
	if err := s.Auth.Logout(r.Context(), bearer(r)); err != nil {
		s.internal(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) me(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, protocol.FromMe(currentUser(r)))
}

func (s *Server) listUsers(w http.ResponseWriter, r *http.Request) {
	users, err := s.Queries.ListUsers(r.Context())
	if err != nil {
		s.internal(w, r, err)
		return
	}
	out := make([]protocol.Member, 0, len(users))
	for _, u := range users {
		status := "offline"
		if s.Hub.Online(u.ID) {
			status = "online"
		}
		out = append(out, protocol.Member{User: protocol.FromUser(u), Status: status})
	}
	writeJSON(w, http.StatusOK, out)
}

func (s *Server) updateUser(w http.ResponseWriter, r *http.Request) {
	id, ok := pathID(w, r)
	if !ok {
		return
	}
	var body struct {
		Role string `json:"role"`
	}
	if !decode(w, r, &body) {
		return
	}
	if body.Role != "admin" && body.Role != "member" {
		writeError(w, http.StatusBadRequest, "bad_request", `role must be "admin" or "member"`)
		return
	}
	if id == currentUser(r).ID && body.Role != "admin" {
		writeError(w, http.StatusBadRequest, "bad_request", "admins cannot demote themselves")
		return
	}
	u, err := s.Queries.UpdateUserRole(r.Context(), db.UpdateUserRoleParams{ID: id, Role: body.Role})
	if err != nil {
		s.notFoundOr(w, r, err, "user")
		return
	}
	s.Hub.Broadcast(protocol.OpMemberUpdate, protocol.FromUser(u))
	writeJSON(w, http.StatusOK, protocol.FromUser(u))
}

func (s *Server) listInvites(w http.ResponseWriter, r *http.Request) {
	invites, err := s.Queries.ListInvites(r.Context())
	if err != nil {
		s.internal(w, r, err)
		return
	}
	out := make([]protocol.Invite, 0, len(invites))
	for _, i := range invites {
		out = append(out, protocol.FromInvite(i))
	}
	writeJSON(w, http.StatusOK, out)
}

func (s *Server) createInvite(w http.ResponseWriter, r *http.Request) {
	var body struct {
		MaxUses        *int32 `json:"max_uses"`
		ExpiresInHours *int   `json:"expires_in_hours"`
	}
	if !decode(w, r, &body) {
		return
	}
	params := db.CreateInviteParams{Code: auth.NewInviteCode(), CreatedBy: currentUser(r).ID}
	if body.MaxUses != nil {
		if *body.MaxUses < 1 {
			writeError(w, http.StatusBadRequest, "bad_request", "max_uses must be >= 1")
			return
		}
		params.MaxUses = pgtype.Int4{Int32: *body.MaxUses, Valid: true}
	}
	if body.ExpiresInHours != nil {
		if *body.ExpiresInHours < 1 {
			writeError(w, http.StatusBadRequest, "bad_request", "expires_in_hours must be >= 1")
			return
		}
		t := time.Now().Add(time.Duration(*body.ExpiresInHours) * time.Hour)
		params.ExpiresAt = &t
	}
	inv, err := s.Queries.CreateInvite(r.Context(), params)
	if err != nil {
		s.internal(w, r, err)
		return
	}
	writeJSON(w, http.StatusCreated, protocol.FromInvite(inv))
}

func (s *Server) deleteInvite(w http.ResponseWriter, r *http.Request) {
	n, err := s.Queries.DeleteInvite(r.Context(), r.PathValue("code"))
	if err != nil {
		s.internal(w, r, err)
		return
	}
	if n == 0 {
		writeError(w, http.StatusNotFound, "not_found", "invite not found")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

var loginPage = template.Must(template.New("login").Parse(`<!doctype html>
<html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>DiscGo</title>
{{if .Redirect}}<meta http-equiv="refresh" content="0;url={{.Redirect}}">{{end}}
<style>
:root{color-scheme:dark}body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0b0c10;color:#e7e9f0;font:15px/1.5 system-ui,sans-serif}
main{max-width:420px;padding:32px;background:#171923;border:1px solid #262a3a;border-radius:14px}
h1{font-size:18px;margin:0 0 8px}p{color:#9ba1b5;margin:0 0 16px}a{display:inline-block;padding:8px 14px;border-radius:10px;background:#8b9cff;color:#0b0c10;text-decoration:none;font-weight:600}
</style></head><body><main>
{{if .Redirect}}<h1>Login concluído</h1><p>Voltando para o DiscGo. Se nada acontecer, use o botão abaixo e depois feche esta aba.</p><a href="{{.Redirect}}">Abrir o DiscGo</a>
{{else}}<h1>Não foi possível entrar</h1><p>{{.Message}}</p>{{end}}
</main></body></html>`))

func renderLogin(w http.ResponseWriter, status int, redirect, message string) {
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_ = loginPage.Execute(w, map[string]any{"Redirect": template.URL(redirect), "Message": message})
}
