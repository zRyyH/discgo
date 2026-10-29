// Package auth implements login (PLAN 3.1): Google OAuth code flow in the
// system browser, a one-time code handed to the app through the discgo://
// deep link, and opaque 30-day sessions stored as SHA-256 hashes.
package auth

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"fmt"
	"strings"
	"sync"
	"time"

	"github.com/coreos/go-oidc/v3/oidc"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"golang.org/x/oauth2"

	"discgo/api/internal/db"
)

var (
	ErrInviteRequired = errors.New("invite required")
	ErrInviteInvalid  = errors.New("invite invalid, expired or used up")
	ErrInvalidCode    = errors.New("login code invalid or expired")
	ErrUnauthorized   = errors.New("invalid or expired session")
	ErrNotConfigured  = errors.New("google login is not configured")
)

const (
	codeTTL  = 60 * time.Second
	stateTTL = 10 * time.Minute
	// last_used_at is refreshed at most this often.
	touchEvery = time.Hour
)

type Config struct {
	Issuer       string
	ClientID     string
	ClientSecret string
	RedirectURL  string
	SessionTTL   time.Duration
}

// Identity is a verified external identity.
type Identity struct {
	Subject     string // stored in users.google_sub ("dev:<email>" for dev logins)
	Email       string
	DisplayName string
	AvatarURL   string
}

// UserChanged is called after a login creates a member (created=true) or
// changes an existing member's name, email or avatar.
type UserChanged func(u db.User, created bool)

type Service struct {
	pool      *pgxpool.Pool
	q         *db.Queries
	cfg       Config
	onChanged UserChanged

	oidcOnce sync.Once
	provider *oidc.Provider
	oidcErr  error

	mu     sync.Mutex
	states map[string]pendingLogin
	codes  map[string]issuedCode
}

type pendingLogin struct {
	invite  string
	nonce   string
	expires time.Time
}

type issuedCode struct {
	userID  uuid.UUID
	expires time.Time
}

func New(pool *pgxpool.Pool, cfg Config, onChanged UserChanged) *Service {
	return &Service{
		pool:      pool,
		q:         db.New(pool),
		cfg:       cfg,
		onChanged: onChanged,
		states:    map[string]pendingLogin{},
		codes:     map[string]issuedCode{},
	}
}

func (s *Service) oauth(ctx context.Context) (*oauth2.Config, *oidc.Provider, error) {
	if s.cfg.ClientID == "" || s.cfg.ClientSecret == "" {
		return nil, nil, ErrNotConfigured
	}
	s.oidcOnce.Do(func() {
		s.provider, s.oidcErr = oidc.NewProvider(context.WithoutCancel(ctx), s.cfg.Issuer)
	})
	if s.oidcErr != nil {
		return nil, nil, fmt.Errorf("oidc discovery: %w", s.oidcErr)
	}
	return &oauth2.Config{
		ClientID:     s.cfg.ClientID,
		ClientSecret: s.cfg.ClientSecret,
		RedirectURL:  s.cfg.RedirectURL,
		Endpoint:     s.provider.Endpoint(),
		Scopes:       []string{oidc.ScopeOpenID, "email", "profile"},
	}, s.provider, nil
}

// GoogleAuthURL starts a login; invite is only needed on the first login.
func (s *Service) GoogleAuthURL(ctx context.Context, invite string) (string, error) {
	conf, _, err := s.oauth(ctx)
	if err != nil {
		return "", err
	}
	state, nonce := randomToken(24), randomToken(24)
	s.mu.Lock()
	s.gcLocked()
	s.states[state] = pendingLogin{invite: strings.TrimSpace(invite), nonce: nonce, expires: time.Now().Add(stateTTL)}
	s.mu.Unlock()
	return conf.AuthCodeURL(state, oidc.Nonce(nonce), oauth2.SetAuthURLParam("prompt", "select_account")), nil
}

// GoogleCallback finishes the browser flow and returns a one-time code for the app.
func (s *Service) GoogleCallback(ctx context.Context, state, code string) (string, error) {
	s.mu.Lock()
	pending, ok := s.states[state]
	delete(s.states, state)
	s.mu.Unlock()
	if !ok || time.Now().After(pending.expires) {
		return "", errors.New("login expired, start again from the app")
	}
	conf, provider, err := s.oauth(ctx)
	if err != nil {
		return "", err
	}
	tok, err := conf.Exchange(ctx, code)
	if err != nil {
		return "", fmt.Errorf("code exchange: %w", err)
	}
	rawID, _ := tok.Extra("id_token").(string)
	idToken, err := provider.Verifier(&oidc.Config{ClientID: s.cfg.ClientID}).Verify(ctx, rawID)
	if err != nil {
		return "", fmt.Errorf("id_token: %w", err)
	}
	if idToken.Nonce != pending.nonce {
		return "", errors.New("id_token nonce mismatch")
	}
	var claims struct {
		Email         string `json:"email"`
		EmailVerified bool   `json:"email_verified"`
		Name          string `json:"name"`
		Picture       string `json:"picture"`
	}
	if err := idToken.Claims(&claims); err != nil {
		return "", err
	}
	if !claims.EmailVerified {
		return "", errors.New("google account email is not verified")
	}
	return s.Login(ctx, Identity{
		Subject:     idToken.Subject,
		Email:       claims.Email,
		DisplayName: claims.Name,
		AvatarURL:   claims.Picture,
	}, pending.invite)
}

// Login resolves an identity to a member (first user becomes admin, everyone
// else needs an invite the first time) and issues a one-time code.
func (s *Service) Login(ctx context.Context, id Identity, invite string) (string, error) {
	if id.DisplayName == "" {
		id.DisplayName, _, _ = strings.Cut(id.Email, "@")
	}
	var user db.User
	var created, changed bool
	err := pgx.BeginFunc(ctx, s.pool, func(tx pgx.Tx) error {
		q := s.q.WithTx(tx)
		if err := q.LockUserCreation(ctx); err != nil {
			return err
		}
		existing, err := q.GetUserByGoogleSub(ctx, id.Subject)
		if err == nil {
			changed = existing.Email != id.Email || existing.DisplayName != id.DisplayName || existing.AvatarUrl != id.AvatarURL
			if !changed {
				user = existing
				return nil
			}
			user, err = q.UpdateUserProfile(ctx, db.UpdateUserProfileParams{
				ID: existing.ID, Email: id.Email, DisplayName: id.DisplayName, AvatarUrl: id.AvatarURL,
			})
			return err
		}
		if !errors.Is(err, pgx.ErrNoRows) {
			return err
		}
		count, err := q.CountUsers(ctx)
		if err != nil {
			return err
		}
		role := "admin"
		if count > 0 {
			role = "member"
			if invite == "" {
				return ErrInviteRequired
			}
			if _, err := q.ClaimInvite(ctx, invite); errors.Is(err, pgx.ErrNoRows) {
				return ErrInviteInvalid
			} else if err != nil {
				return err
			}
		}
		user, err = q.CreateUser(ctx, db.CreateUserParams{
			ID: uuid.Must(uuid.NewV7()), GoogleSub: id.Subject, Email: id.Email,
			DisplayName: id.DisplayName, AvatarUrl: id.AvatarURL, Role: role,
		})
		created = true
		return err
	})
	if err != nil {
		return "", err
	}
	if (created || changed) && s.onChanged != nil {
		s.onChanged(user, created)
	}
	code := randomToken(24)
	s.mu.Lock()
	s.gcLocked()
	s.codes[code] = issuedCode{userID: user.ID, expires: time.Now().Add(codeTTL)}
	s.mu.Unlock()
	return code, nil
}

// Exchange trades a one-time code for a session token.
func (s *Service) Exchange(ctx context.Context, code string) (string, db.User, error) {
	s.mu.Lock()
	issued, ok := s.codes[code]
	delete(s.codes, code)
	s.mu.Unlock()
	if !ok || time.Now().After(issued.expires) {
		return "", db.User{}, ErrInvalidCode
	}
	user, err := s.q.GetUser(ctx, issued.userID)
	if err != nil {
		return "", db.User{}, err
	}
	token := randomToken(32)
	err = s.q.CreateSession(ctx, db.CreateSessionParams{
		ID:        uuid.Must(uuid.NewV7()),
		UserID:    user.ID,
		TokenHash: hashToken(token),
		ExpiresAt: time.Now().Add(s.cfg.SessionTTL),
	})
	return token, user, err
}

// Authenticate resolves a bearer token to its user.
func (s *Service) Authenticate(ctx context.Context, token string) (db.User, error) {
	if token == "" {
		return db.User{}, ErrUnauthorized
	}
	row, err := s.q.GetSessionUser(ctx, hashToken(token))
	if errors.Is(err, pgx.ErrNoRows) {
		return db.User{}, ErrUnauthorized
	}
	if err != nil {
		return db.User{}, err
	}
	if time.Since(row.Session.LastUsedAt) > touchEvery {
		_ = s.q.TouchSession(ctx, row.Session.ID)
	}
	return row.User, nil
}

func (s *Service) Logout(ctx context.Context, token string) error {
	return s.q.DeleteSession(ctx, hashToken(token))
}

func (s *Service) gcLocked() {
	now := time.Now()
	for k, v := range s.states {
		if now.After(v.expires) {
			delete(s.states, k)
		}
	}
	for k, v := range s.codes {
		if now.After(v.expires) {
			delete(s.codes, k)
		}
	}
}

func randomToken(n int) string {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		panic(err)
	}
	return base64.RawURLEncoding.EncodeToString(b)
}

// NewInviteCode returns a short invite code: 10 chars from 32 unambiguous symbols (50 bits).
func NewInviteCode() string {
	const alphabet = "abcdefghjkmnpqrstuvwxyz023456789" // no i, l, o, 1
	b := make([]byte, 10)
	if _, err := rand.Read(b); err != nil {
		panic(err)
	}
	for i := range b {
		b[i] = alphabet[b[i]&31]
	}
	return string(b)
}

func hashToken(token string) []byte {
	h := sha256.Sum256([]byte(token))
	return h[:]
}
