package httpapi

import (
	"errors"
	"html/template"
	"net/http"
	"net/url"
	"strings"

	"discgo/api/internal/auth"
	"discgo/api/internal/db"
	"discgo/api/internal/protocol"
)

func (s *Server) googleStart(w http.ResponseWriter, r *http.Request) {
	// This opens in the browser, so failures get the HTML page, not JSON.
	u, err := s.Auth.GoogleAuthURL(r.Context())
	if errors.Is(err, auth.ErrNotConfigured) {
		renderLogin(w, http.StatusServiceUnavailable, loginPageData{
			Message: "O login com o Google ainda não foi configurado neste servidor (GOOGLE_CLIENT_ID e GOOGLE_CLIENT_SECRET).",
		})
		return
	}
	if err != nil {
		s.Log.Error("google start failed", "err", err)
		renderLogin(w, http.StatusBadGateway, loginPageData{Message: "Não foi possível falar com o Google agora. Tente de novo em instantes."})
		return
	}
	http.Redirect(w, r, u, http.StatusFound)
}

func (s *Server) googleCallback(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	if e := q.Get("error"); e != "" {
		renderLogin(w, http.StatusBadRequest, loginPageData{Message: "O Google não autorizou o login (" + e + ")."})
		return
	}
	code, user, err := s.Auth.GoogleCallback(r.Context(), q.Get("state"), q.Get("code"))
	if err != nil {
		s.Log.Warn("google callback failed", "err", err)
		renderLogin(w, http.StatusBadRequest, loginPageData{Message: "Não foi possível concluir o login. Volte ao DiscGo e tente de novo."})
		return
	}
	first, _, _ := strings.Cut(user.DisplayName, " ")
	renderLogin(w, http.StatusOK, loginPageData{
		Redirect: template.URL(s.AuthRedirect + "?code=" + url.QueryEscape(code)),
		Name:     first,
		Username: user.Username,
		Avatar:   user.AvatarUrl,
		Initial:  initial(user.DisplayName),
	})
}

func initial(name string) string {
	for _, r := range name {
		return strings.ToUpper(string(r))
	}
	return "?"
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
		Avatar string `json:"avatar_url"`
	}
	if !decode(w, r, &body) {
		return
	}
	body.Email = strings.ToLower(strings.TrimSpace(body.Email))
	if body.Email == "" {
		writeError(w, http.StatusBadRequest, "bad_request", "email is required")
		return
	}
	code, _, err := s.Auth.Login(r.Context(), auth.Identity{
		Subject: "dev:" + body.Email, Email: body.Email, DisplayName: body.Name, AvatarURL: body.Avatar,
	})
	if err != nil {
		s.internal(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"code": code})
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

type loginPageData struct {
	Redirect template.URL // discgo://auth?code=… on success
	Name     string
	Username string
	Avatar   string
	Initial  string // shown when there is no photo
	Message  string // the error, when Redirect is empty
}

// The page the browser shows at the end of the Google login. Same tokens as
// desktop/src/styles.css.
var loginPage = template.Must(template.New("login").Parse(`<!doctype html>
<html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>DiscGo</title>
{{if .Redirect}}<meta http-equiv="refresh" content="1;url={{.Redirect}}">{{end}}
<style>
:root{color-scheme:dark}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px;background:#0b0c10;color:#e7e9f0;
  font:14px/1.5 "Inter",system-ui,-apple-system,"Segoe UI",sans-serif;
  background-image:radial-gradient(600px 400px at 20% 10%,rgba(139,156,255,.14),transparent 70%),radial-gradient(500px 360px at 85% 90%,rgba(61,220,151,.08),transparent 70%)}
main{width:100%;max-width:400px;padding:36px 32px 32px;background:#111218;border:1px solid #262a3a;border-radius:18px;text-align:center;
  box-shadow:0 24px 64px rgba(0,0,0,.5);animation:in .25s ease-out}
@keyframes in{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}
@media (prefers-reduced-motion:reduce){main{animation:none}}
.brand{display:inline-flex;align-items:center;gap:8px;margin-bottom:28px;color:#9ba1b5;font-size:13px;font-weight:600;letter-spacing:.02em}
.mark{width:22px;height:22px;border-radius:50%;border:4px solid #8b9cff}
.photo{position:relative;width:88px;height:88px;margin:0 auto 18px}
.photo img,.photo .ph{width:88px;height:88px;border-radius:50%;object-fit:cover;outline:2px solid #262a3a;outline-offset:3px}
.photo .ph{display:grid;place-items:center;background:#1e2130;font-size:32px;font-weight:600}
.badge{position:absolute;right:-2px;bottom:-2px;width:28px;height:28px;border-radius:50%;background:#3ddc97;border:4px solid #111218;display:grid;place-items:center}
.err{width:64px;height:64px;margin:0 auto 18px;border-radius:50%;display:grid;place-items:center;background:rgba(255,92,108,.12);color:#ff5c6c;font-size:28px;font-weight:700}
h1{font-size:22px;line-height:1.3;margin:0 0 8px;font-weight:650}
p{color:#9ba1b5;margin:0 0 22px}p:last-child{margin:0}
b{color:#e7e9f0;font-weight:600}
.user{display:inline-block;padding:2px 8px;border-radius:6px;background:#1e2130;color:#e7e9f0;font:600 13px/1.6 ui-monospace,"JetBrains Mono",monospace}
a.btn{display:block;padding:11px 16px;border-radius:10px;background:#8b9cff;color:#0b0c10;text-decoration:none;font-weight:600}
a.btn:hover{background:#a1afff}
small{display:block;margin-top:16px;color:#646b80;font-size:12px}
</style></head><body><main>
<div class="brand"><span class="mark"></span>DiscGo</div>
{{if .Redirect}}
<div class="photo">{{if .Avatar}}<img src="{{.Avatar}}" alt="" referrerpolicy="no-referrer">{{else}}<div class="ph">{{.Initial}}</div>{{end}}
<span class="badge"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#0b0c10" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg></span></div>
<h1>Tudo certo{{if .Name}}, {{.Name}}{{end}}!</h1>
<p>Você entrou como <span class="user">{{.Username}}</span><br>O DiscGo vai abrir sozinho. Depois, pode fechar esta aba.</p>
<a class="btn" href="{{.Redirect}}">Abrir o DiscGo</a>
<small>Se o navegador perguntar, permita abrir o DiscGo.</small>
{{else}}
<div class="err">!</div>
<h1>Não foi possível entrar</h1>
<p>{{.Message}}</p>
{{end}}
</main></body></html>`))

func renderLogin(w http.ResponseWriter, status int, d loginPageData) {
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_ = loginPage.Execute(w, d)
}
