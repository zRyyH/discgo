// Package config loads the API configuration from environment variables.
package config

import (
	"fmt"
	"log/slog"
	"os"
	"strconv"
	"strings"
	"time"
)

type Config struct {
	HTTPAddr    string
	DatabaseURL string
	LogLevel    slog.Level
	// Public base URL of the API, used for the OAuth redirect URI.
	PublicURL     string
	CommunityName string

	GoogleIssuer       string
	GoogleClientID     string
	GoogleClientSecret string
	// Where the browser is sent after login; the one-time code is appended.
	AuthRedirect string
	SessionTTL   time.Duration
	// Enables POST /v1/auth/dev (login without Google). Never in production.
	AuthDev bool

	LiveKitURL       string
	LiveKitAPIKey    string
	LiveKitAPISecret string

	P2PMaxParticipants int
	P2PSwitchDelay     time.Duration
	P2PBlockTTL        time.Duration
	STUNURLs           []string

	S3Region       string
	S3Bucket       string
	S3Endpoint     string // non-empty for MinIO in dev
	S3CreateBucket bool
	MaxUploadBytes int64

	// The desktop updater manifest (latest.json); empty disables forced updates.
	ReleasesURL  string
	ReleasesPoll time.Duration
}

func Load() (Config, error) {
	var errs []string
	c := Config{
		HTTPAddr:      env("HTTP_ADDR", ":8080"),
		DatabaseURL:   env("DATABASE_URL", ""),
		PublicURL:     strings.TrimRight(env("PUBLIC_URL", "http://localhost:8080"), "/"),
		CommunityName: env("COMMUNITY_NAME", "DiscGo"),

		GoogleIssuer:       env("GOOGLE_ISSUER", "https://accounts.google.com"),
		GoogleClientID:     env("GOOGLE_CLIENT_ID", ""),
		GoogleClientSecret: env("GOOGLE_CLIENT_SECRET", ""),
		AuthRedirect:       env("AUTH_REDIRECT", "discgo://auth"),

		LiveKitURL:       env("LIVEKIT_URL", ""),
		LiveKitAPIKey:    env("LIVEKIT_API_KEY", ""),
		LiveKitAPISecret: env("LIVEKIT_API_SECRET", ""),
		STUNURLs:         list(env("STUN_URLS", "stun:stun.l.google.com:19302")),

		S3Region:   env("S3_REGION", "sa-east-1"),
		S3Bucket:   env("S3_BUCKET", ""),
		S3Endpoint: env("S3_ENDPOINT", ""),

		ReleasesURL: env("RELEASES_URL", ""),
	}
	if c.DatabaseURL == "" {
		errs = append(errs, "DATABASE_URL is required")
	}
	if err := c.LogLevel.UnmarshalText([]byte(env("LOG_LEVEL", "info"))); err != nil {
		errs = append(errs, "LOG_LEVEL: "+err.Error())
	}
	c.SessionTTL = duration("SESSION_TTL", 30*24*time.Hour, &errs)
	c.P2PSwitchDelay = duration("P2P_SWITCH_DELAY", 10*time.Second, &errs)
	c.P2PBlockTTL = duration("P2P_BLOCK_TTL", time.Hour, &errs)
	c.ReleasesPoll = duration("RELEASES_POLL", time.Minute, &errs)
	c.AuthDev = boolean("AUTH_DEV", false, &errs)
	c.S3CreateBucket = boolean("S3_CREATE_BUCKET", false, &errs)
	c.P2PMaxParticipants = integer("P2P_MAX_PARTICIPANTS", 2, &errs)
	c.MaxUploadBytes = int64(integer("MAX_UPLOAD_MB", 25, &errs)) << 20
	if len(errs) > 0 {
		return c, fmt.Errorf("config: %s", strings.Join(errs, "; "))
	}
	return c, nil
}

func env(key, def string) string {
	if v := strings.TrimSpace(os.Getenv(key)); v != "" {
		return v
	}
	return def
}

func list(v string) []string {
	var out []string
	for _, s := range strings.Split(v, ",") {
		if s = strings.TrimSpace(s); s != "" {
			out = append(out, s)
		}
	}
	return out
}

func duration(key string, def time.Duration, errs *[]string) time.Duration {
	v := env(key, "")
	if v == "" {
		return def
	}
	d, err := time.ParseDuration(v)
	if err != nil {
		*errs = append(*errs, key+": "+err.Error())
	}
	return d
}

func boolean(key string, def bool, errs *[]string) bool {
	v := env(key, "")
	if v == "" {
		return def
	}
	b, err := strconv.ParseBool(v)
	if err != nil {
		*errs = append(*errs, key+": "+err.Error())
	}
	return b
}

func integer(key string, def int, errs *[]string) int {
	v := env(key, "")
	if v == "" {
		return def
	}
	n, err := strconv.Atoi(v)
	if err != nil {
		*errs = append(*errs, key+": "+err.Error())
	}
	return n
}
