// Package app wires the API together; cmd/api and the integration tests share it.
package app

import (
	"context"
	"log/slog"
	"net/http"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"discgo/api/internal/auth"
	"discgo/api/internal/config"
	"discgo/api/internal/db"
	"discgo/api/internal/gateway"
	"discgo/api/internal/httpapi"
	"discgo/api/internal/livekit"
	"discgo/api/internal/protocol"
	"discgo/api/internal/storage"
	"discgo/api/internal/voice"
)

type App struct {
	Handler http.Handler
	Pool    *pgxpool.Pool
	Voice   *voice.Manager
}

// Overrides replace dependencies in tests.
type Overrides struct {
	Storage    httpapi.Storage
	VoiceGrace time.Duration
}

// New opens the database, applies migrations and builds the HTTP handler.
func New(ctx context.Context, cfg config.Config, log *slog.Logger, o Overrides) (*App, error) {
	pool, err := db.Open(ctx, cfg.DatabaseURL)
	if err != nil {
		return nil, err
	}
	if err := db.Migrate(ctx, pool, log); err != nil {
		pool.Close()
		return nil, err
	}

	var hub *gateway.Hub
	authSvc := auth.New(pool, auth.Config{
		Issuer:       cfg.GoogleIssuer,
		ClientID:     cfg.GoogleClientID,
		ClientSecret: cfg.GoogleClientSecret,
		RedirectURL:  cfg.PublicURL + "/v1/auth/google/callback",
		SessionTTL:   cfg.SessionTTL,
	}, func(u db.User, created bool) {
		if created {
			hub.Broadcast(protocol.OpMemberAdd, protocol.Member{User: protocol.FromUser(u), Status: "offline"})
		} else {
			hub.Broadcast(protocol.OpMemberUpdate, protocol.FromUser(u))
		}
	})
	hub = gateway.NewHub(log, pool, authSvc, cfg.CommunityName)
	voiceMgr := voice.New(voice.Config{
		MaxP2P:      cfg.P2PMaxParticipants,
		SwitchDelay: cfg.P2PSwitchDelay,
		BlockTTL:    cfg.P2PBlockTTL,
		Grace:       o.VoiceGrace,
		LiveKitURL:  cfg.LiveKitURL,
	}, hub)
	hub.Voice = voiceMgr

	store := o.Storage
	if store == nil {
		store = httpapi.NoStorage{}
		if cfg.S3Bucket != "" {
			s3, err := storage.New(ctx, storage.Config{
				Region: cfg.S3Region, Bucket: cfg.S3Bucket, Endpoint: cfg.S3Endpoint, CreateBucket: cfg.S3CreateBucket,
			})
			if err != nil {
				pool.Close()
				return nil, err
			}
			store = s3
		} else {
			log.Warn("S3_BUCKET not set: uploads disabled")
		}
	}

	api := &httpapi.Server{
		Log:            log,
		Pool:           pool,
		Queries:        db.New(pool),
		Auth:           authSvc,
		Hub:            hub,
		Voice:          voiceMgr,
		Storage:        store,
		LiveKit:        livekit.NewIssuer(cfg.LiveKitAPIKey, cfg.LiveKitAPISecret),
		LiveKitKeys:    livekit.KeyProvider(cfg.LiveKitAPIKey, cfg.LiveKitAPISecret),
		STUNURLs:       cfg.STUNURLs,
		AuthDev:        cfg.AuthDev,
		AuthRedirect:   cfg.AuthRedirect,
		MaxUploadBytes: cfg.MaxUploadBytes,
	}
	return &App{Handler: api.Handler(), Pool: pool, Voice: voiceMgr}, nil
}

// CleanupSessions deletes expired sessions every few hours until ctx ends.
func (a *App) CleanupSessions(ctx context.Context, log *slog.Logger) {
	q := db.New(a.Pool)
	t := time.NewTicker(6 * time.Hour)
	defer t.Stop()
	for {
		if n, err := q.DeleteExpiredSessions(ctx); err != nil && ctx.Err() == nil {
			log.Warn("session cleanup", "err", err)
		} else if n > 0 {
			log.Info("expired sessions removed", "count", n)
		}
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		}
	}
}
