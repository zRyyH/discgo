// Package httpapi wires the REST routes (PLAN 5.2). All routes are under /v1,
// authenticated with "Authorization: Bearer <session token>" unless noted.
package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	lkauth "github.com/livekit/protocol/auth"

	"discgo/api/internal/auth"
	"discgo/api/internal/db"
	"discgo/api/internal/gateway"
	"discgo/api/internal/livekit"
	"discgo/api/internal/storage"
	"discgo/api/internal/voice"
)

const maxJSONBody = 1 << 20

// Storage is the part of storage.Store the handlers use (fake in tests).
type Storage interface {
	PresignPut(ctx context.Context, userID uuid.UUID, name, contentType string, size int64) (key, url string, err error)
	PresignGet(key string) string
}

type Server struct {
	Log     *slog.Logger
	Pool    *pgxpool.Pool
	Queries *db.Queries
	Auth    *auth.Service
	Hub     *gateway.Hub
	Voice   *voice.Manager
	Storage Storage
	LiveKit *livekit.Issuer
	// Verifies LiveKit webhooks; nil disables the endpoint.
	LiveKitKeys lkauth.KeyProvider
	STUNURLs    []string
	AuthDev     bool
	// Where the browser goes after a Google login (discgo://auth); ?code= is appended.
	AuthRedirect   string
	MaxUploadBytes int64
}

type ctxKey struct{}

func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", s.healthz)

	mux.HandleFunc("GET /v1/auth/google/start", s.googleStart)
	mux.HandleFunc("GET /v1/auth/google/callback", s.googleCallback)
	mux.HandleFunc("POST /v1/auth/dev", s.devLogin)
	mux.HandleFunc("POST /v1/auth/exchange", s.exchange)
	mux.Handle("POST /v1/auth/logout", s.authed(s.logout))
	mux.Handle("GET /v1/me", s.authed(s.me))

	mux.Handle("GET /v1/users", s.authed(s.listUsers))
	mux.Handle("PATCH /v1/users/{id}", s.admin(s.updateUser))
	mux.Handle("GET /v1/invites", s.admin(s.listInvites))
	mux.Handle("POST /v1/invites", s.admin(s.createInvite))
	mux.Handle("DELETE /v1/invites/{code}", s.admin(s.deleteInvite))

	mux.Handle("GET /v1/channels", s.authed(s.listChannels))
	mux.Handle("POST /v1/channels", s.admin(s.createChannel))
	mux.Handle("PATCH /v1/channels/{id}", s.admin(s.updateChannel))
	mux.Handle("DELETE /v1/channels/{id}", s.admin(s.deleteChannel))
	mux.Handle("GET /v1/channels/{id}/messages", s.authed(s.listMessages))
	mux.Handle("POST /v1/channels/{id}/messages", s.authed(s.createMessage))
	mux.Handle("PATCH /v1/messages/{id}", s.authed(s.updateMessage))
	mux.Handle("DELETE /v1/messages/{id}", s.authed(s.deleteMessage))
	mux.Handle("POST /v1/uploads/presign", s.authed(s.presignUpload))

	mux.Handle("GET /v1/rtc/ice-servers", s.authed(s.iceServers))
	mux.Handle("GET /v1/channels/{id}/voice-token", s.authed(s.voiceToken))
	mux.HandleFunc("POST /v1/livekit/webhook", s.livekitWebhook)
	mux.Handle("GET /v1/gateway", s.Hub)

	return s.recover(s.logRequests(cors(mux)))
}

func (s *Server) healthz(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 2*time.Second)
	defer cancel()
	if err := s.Pool.Ping(ctx); err != nil {
		writeError(w, http.StatusServiceUnavailable, "db_unavailable", "database unreachable")
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

// authed resolves the bearer token; the user is available through currentUser.
func (s *Server) authed(next http.HandlerFunc) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		user, err := s.Auth.Authenticate(r.Context(), bearer(r))
		if errors.Is(err, auth.ErrUnauthorized) {
			writeError(w, http.StatusUnauthorized, "unauthorized", "invalid or expired session")
			return
		}
		if err != nil {
			s.internal(w, r, err)
			return
		}
		next(w, r.WithContext(context.WithValue(r.Context(), ctxKey{}, user)))
	})
}

func (s *Server) admin(next http.HandlerFunc) http.Handler {
	return s.authed(func(w http.ResponseWriter, r *http.Request) {
		if currentUser(r).Role != "admin" {
			writeError(w, http.StatusForbidden, "forbidden", "admins only")
			return
		}
		next(w, r)
	})
}

func currentUser(r *http.Request) db.User {
	return r.Context().Value(ctxKey{}).(db.User)
}

func bearer(r *http.Request) string {
	h := r.Header.Get("Authorization")
	if t, ok := strings.CutPrefix(h, "Bearer "); ok {
		return strings.TrimSpace(t)
	}
	return ""
}

// cors: the desktop app runs on its own origin and authenticates with a bearer
// token (no cookies), so any origin is allowed.
func cors(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h := w.Header()
		h.Set("Access-Control-Allow-Origin", "*")
		if r.Method == http.MethodOptions {
			h.Set("Access-Control-Allow-Methods", "GET, POST, PATCH, DELETE, OPTIONS")
			h.Set("Access-Control-Allow-Headers", "Authorization, Content-Type")
			h.Set("Access-Control-Max-Age", "86400")
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next.ServeHTTP(w, r)
	})
}

type statusWriter struct {
	http.ResponseWriter
	status int
}

func (w *statusWriter) WriteHeader(code int) {
	w.status = code
	w.ResponseWriter.WriteHeader(code)
}

// Unwrap lets the WebSocket upgrade reach the underlying Hijacker.
func (w *statusWriter) Unwrap() http.ResponseWriter { return w.ResponseWriter }

func (s *Server) logRequests(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		sw := &statusWriter{ResponseWriter: w, status: http.StatusOK}
		next.ServeHTTP(sw, r)
		if r.URL.Path == "/healthz" {
			return
		}
		s.Log.Info("http", "method", r.Method, "path", r.URL.Path, "status", sw.status, "ms", time.Since(start).Milliseconds())
	})
}

func (s *Server) recover(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		defer func() {
			if v := recover(); v != nil {
				if v == http.ErrAbortHandler {
					panic(v)
				}
				s.Log.Error("panic", "path", r.URL.Path, "panic", v)
				writeError(w, http.StatusInternalServerError, "internal", "internal error")
			}
		}()
		next.ServeHTTP(w, r)
	})
}

func (s *Server) internal(w http.ResponseWriter, r *http.Request, err error) {
	s.Log.Error("request failed", "method", r.Method, "path", r.URL.Path, "err", err)
	writeError(w, http.StatusInternalServerError, "internal", "internal error")
}

// notFoundOr maps pgx.ErrNoRows to 404 and anything else to 500.
func (s *Server) notFoundOr(w http.ResponseWriter, r *http.Request, err error, what string) {
	if errors.Is(err, pgx.ErrNoRows) {
		writeError(w, http.StatusNotFound, "not_found", what+" not found")
		return
	}
	s.internal(w, r, err)
}

func decode(w http.ResponseWriter, r *http.Request, v any) bool {
	dec := json.NewDecoder(io.LimitReader(r.Body, maxJSONBody))
	dec.DisallowUnknownFields()
	if err := dec.Decode(v); err != nil {
		writeError(w, http.StatusBadRequest, "bad_request", "invalid JSON body: "+err.Error())
		return false
	}
	return true
}

func pathID(w http.ResponseWriter, r *http.Request) (uuid.UUID, bool) {
	id, err := uuid.Parse(r.PathValue("id"))
	if err != nil {
		writeError(w, http.StatusBadRequest, "bad_request", "invalid id")
		return uuid.Nil, false
	}
	return id, true
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func writeError(w http.ResponseWriter, status int, code, message string) {
	writeJSON(w, status, map[string]any{"error": map[string]string{"code": code, "message": message}})
}

var _ Storage = (*storage.Store)(nil)

// NoStorage is used when S3 is not configured: uploads are refused.
type NoStorage struct{}

func (NoStorage) PresignPut(context.Context, uuid.UUID, string, string, int64) (string, string, error) {
	return "", "", errors.New("uploads are not configured (S3_BUCKET)")
}

func (NoStorage) PresignGet(string) string { return "" }
