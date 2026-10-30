package app_test

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/rsa"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/go-jose/go-jose/v4"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"discgo/api/internal/app"
	"discgo/api/internal/config"
	"discgo/api/internal/protocol"
)

// env is one API instance on its own PostgreSQL schema.
type env struct {
	t      *testing.T
	srv    *httptest.Server
	google *fakeGoogle
	app    *app.App
}

func newEnv(t *testing.T) *env {
	t.Helper()
	return newEnvWith(t, func(*config.Config) {})
}

// newEnvWith lets a test change the configuration before the API starts.
func newEnvWith(t *testing.T, configure func(*config.Config)) *env {
	t.Helper()
	base := os.Getenv("TEST_DATABASE_URL")
	if base == "" {
		base = "postgres://discgo:discgo@localhost:5432/discgo?sslmode=disable"
	}
	ctx := context.Background()
	admin, err := pgx.Connect(ctx, base)
	if err != nil {
		t.Skipf("no test database (%v); start it with `make infra-up` or set TEST_DATABASE_URL", err)
	}
	schema := "test_" + strings.ReplaceAll(uuid.NewString(), "-", "")[:12]
	if _, err := admin.Exec(ctx, "create schema "+schema); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_, _ = admin.Exec(context.Background(), "drop schema "+schema+" cascade")
		admin.Close(context.Background())
	})

	google := newFakeGoogle(t)
	cfg := config.Config{
		DatabaseURL:        base + "&search_path=" + schema,
		CommunityName:      "Test",
		GoogleIssuer:       google.srv.URL,
		GoogleClientID:     "client-id",
		GoogleClientSecret: "client-secret",
		AuthRedirect:       "discgo://auth",
		SessionTTL:         time.Hour,
		AuthDev:            true,
		LiveKitURL:         "ws://livekit.test",
		LiveKitAPIKey:      "devkey",
		LiveKitAPISecret:   "devsecret-0123456789abcdef0123456789",
		P2PMaxParticipants: 2,
		P2PSwitchDelay:     300 * time.Millisecond,
		P2PBlockTTL:        time.Hour,
		STUNURLs:           []string{"stun:stun.test:3478"},
		MaxUploadBytes:     1 << 20,
	}
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	if testing.Verbose() {
		log = slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: slog.LevelWarn}))
	}
	// The OAuth redirect URI must point at this server, so its address is fixed first.
	var handler http.Handler
	srv := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		handler.ServeHTTP(w, r)
	}))
	cfg.PublicURL = "http://" + srv.Listener.Addr().String()
	configure(&cfg)
	a, err := app.New(ctx, cfg, log, app.Overrides{Storage: fakeStorage{}, VoiceGrace: 200 * time.Millisecond})
	if err != nil {
		t.Fatal(err)
	}
	handler = a.Handler
	srv.Start()
	bg, stop := context.WithCancel(ctx)
	go a.WatchReleases(bg)
	t.Cleanup(func() {
		stop()
		srv.Close()
		a.Pool.Close()
	})
	return &env{t: t, srv: srv, google: google, app: a}
}

type fakeStorage struct{}

func (fakeStorage) PresignPut(_ context.Context, userID uuid.UUID, name, _ string, _ int64) (string, string, error) {
	key := "att/" + userID.String() + "/" + uuid.NewString() + "/" + name
	return key, "https://s3.test/" + key + "?put", nil
}

func (fakeStorage) PresignGet(key string) string { return "https://s3.test/" + key + "?get" }

// --- REST helpers ---

type client struct {
	e     *env
	token string
	user  protocol.Me
}

// call performs a JSON request and decodes the response into out (if non-nil).
func (e *env) call(token, method, path string, body, out any) int {
	e.t.Helper()
	var rd io.Reader
	if body != nil {
		b, _ := json.Marshal(body)
		rd = bytes.NewReader(b)
	}
	req, _ := http.NewRequest(method, e.srv.URL+path, rd)
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	req.Header.Set("Content-Type", "application/json")
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		e.t.Fatal(err)
	}
	defer res.Body.Close()
	data, _ := io.ReadAll(res.Body)
	if out != nil && len(data) > 0 {
		if err := json.Unmarshal(data, out); err != nil {
			e.t.Fatalf("%s %s: decode %q: %v", method, path, data, err)
		}
	}
	return res.StatusCode
}

func (c *client) call(method, path string, body, out any) int {
	c.e.t.Helper()
	return c.e.call(c.token, method, path, body, out)
}

// devLogin logs in through POST /v1/auth/dev and the code exchange.
func (e *env) devLogin(email string) (*client, int, string) {
	e.t.Helper()
	var res struct {
		Code  string                `json:"code"`
		Error struct{ Code string } `json:"error"`
	}
	status := e.call("", "POST", "/v1/auth/dev", map[string]string{"email": email, "name": strings.Split(email, "@")[0]}, &res)
	if status != http.StatusOK {
		return nil, status, res.Error.Code
	}
	return e.exchange(res.Code), status, ""
}

func (e *env) exchange(code string) *client {
	e.t.Helper()
	var out struct {
		Token string      `json:"token"`
		User  protocol.Me `json:"user"`
	}
	if st := e.call("", "POST", "/v1/auth/exchange", map[string]string{"code": code}, &out); st != http.StatusOK {
		e.t.Fatalf("exchange: status %d", st)
	}
	return &client{e: e, token: out.Token, user: out.User}
}

func (e *env) mustLogin(email string) *client {
	e.t.Helper()
	c, status, code := e.devLogin(email)
	if c == nil {
		e.t.Fatalf("login %s: %d %s", email, status, code)
	}
	return c
}

// --- gateway helpers ---

type ws struct {
	t      *testing.T
	conn   *websocket.Conn
	frames chan protocol.Frame
	ready  protocol.Ready
}

func (c *client) connect(p2p bool) *ws {
	c.e.t.Helper()
	return c.connectAs(p2p, "test")
}

// connectAs identifies with a given client app version.
func (c *client) connectAs(p2p bool, version string) *ws {
	c.e.t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	conn, _, err := websocket.Dial(ctx, "ws"+strings.TrimPrefix(c.e.srv.URL, "http")+"/v1/gateway", nil)
	if err != nil {
		c.e.t.Fatal(err)
	}
	conn.SetReadLimit(1 << 20)
	w := &ws{t: c.e.t, conn: conn, frames: make(chan protocol.Frame, 256)}
	c.e.t.Cleanup(func() { conn.Close(websocket.StatusNormalClosure, "") })
	ident := protocol.Identify{Token: c.token}
	ident.Client.Version = version
	ident.Client.P2P = p2p
	w.send(protocol.OpIdentify, ident)
	go func() {
		for {
			_, data, err := conn.Read(context.Background())
			if err != nil {
				close(w.frames)
				return
			}
			var f protocol.Frame
			_ = json.Unmarshal(data, &f)
			w.frames <- f
		}
	}()
	w.expect(protocol.OpReady, &w.ready)
	return w
}

func (w *ws) send(op string, d any) {
	w.t.Helper()
	b, _ := json.Marshal(protocol.NewFrame(op, d))
	if err := w.conn.Write(context.Background(), websocket.MessageText, b); err != nil {
		w.t.Fatal(err)
	}
}

// expect skips frames until one with op arrives and decodes it into out.
func (w *ws) expect(op string, out any) {
	w.t.Helper()
	w.expectWhere(op, out, func() bool { return true })
}

// expectWhere skips frames until op arrives and match (run after decoding) holds.
func (w *ws) expectWhere(op string, out any, match func() bool) {
	w.t.Helper()
	timeout := time.After(3 * time.Second)
	for {
		select {
		case f, ok := <-w.frames:
			if !ok {
				w.t.Fatalf("connection closed while waiting for %s", op)
			}
			if f.Op != op {
				continue
			}
			if out != nil {
				if err := json.Unmarshal(f.D, out); err != nil {
					w.t.Fatal(err)
				}
			}
			if match() {
				return
			}
		case <-timeout:
			w.t.Fatalf("timed out waiting for %s", op)
		}
	}
}

// --- fake Google (OIDC discovery, authorize, token, JWKS) ---

type fakeGoogle struct {
	t   *testing.T
	srv *httptest.Server
	key *rsa.PrivateKey

	mu     sync.Mutex
	nonces map[string]string // code -> nonce
	// Identity returned for the next login.
	Sub, Email, Name string
}

func newFakeGoogle(t *testing.T) *fakeGoogle {
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	g := &fakeGoogle{t: t, key: key, nonces: map[string]string{}}
	mux := http.NewServeMux()
	g.srv = httptest.NewServer(mux)
	t.Cleanup(g.srv.Close)
	mux.HandleFunc("/.well-known/openid-configuration", func(w http.ResponseWriter, r *http.Request) {
		json.NewEncoder(w).Encode(map[string]any{
			"issuer":                                g.srv.URL,
			"authorization_endpoint":                g.srv.URL + "/authorize",
			"token_endpoint":                        g.srv.URL + "/token",
			"jwks_uri":                              g.srv.URL + "/jwks",
			"id_token_signing_alg_values_supported": []string{"RS256"},
		})
	})
	mux.HandleFunc("/jwks", func(w http.ResponseWriter, r *http.Request) {
		json.NewEncoder(w).Encode(jose.JSONWebKeySet{Keys: []jose.JSONWebKey{{Key: &key.PublicKey, KeyID: "k1", Algorithm: "RS256", Use: "sig"}}})
	})
	// The "user" approves immediately: redirect back with a code.
	mux.HandleFunc("/authorize", func(w http.ResponseWriter, r *http.Request) {
		q := r.URL.Query()
		code := hex.EncodeToString([]byte(uuid.NewString()))[:16]
		g.mu.Lock()
		g.nonces[code] = q.Get("nonce")
		g.mu.Unlock()
		http.Redirect(w, r, q.Get("redirect_uri")+"?state="+url.QueryEscape(q.Get("state"))+"&code="+code, http.StatusFound)
	})
	mux.HandleFunc("/token", func(w http.ResponseWriter, r *http.Request) {
		_ = r.ParseForm()
		g.mu.Lock()
		nonce, ok := g.nonces[r.Form.Get("code")]
		delete(g.nonces, r.Form.Get("code"))
		g.mu.Unlock()
		if !ok {
			http.Error(w, `{"error":"invalid_grant"}`, http.StatusBadRequest)
			return
		}
		claims := map[string]any{
			"iss": g.srv.URL, "aud": "client-id", "sub": g.Sub, "nonce": nonce,
			"iat": time.Now().Unix(), "exp": time.Now().Add(time.Hour).Unix(),
			"email": g.Email, "email_verified": true, "name": g.Name, "picture": "https://lh3.googleusercontent.com/a/photo=s96-c",
		}
		signer, _ := jose.NewSigner(jose.SigningKey{Algorithm: jose.RS256, Key: g.key},
			(&jose.SignerOptions{}).WithType("JWT").WithHeader("kid", "k1"))
		payload, _ := json.Marshal(claims)
		jws, _ := signer.Sign(payload)
		idToken, _ := jws.CompactSerialize()
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprintf(w, `{"access_token":"at","token_type":"Bearer","expires_in":3600,"id_token":%q}`, idToken)
	})
	return g
}
