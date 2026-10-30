// Package releases watches the desktop updater manifest (latest.json, PLAN
// fase 9A) so the gateway can tell connected apps to update right away.
package releases

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"

	"discgo/api/internal/protocol"
)

// Watcher polls the manifest with If-None-Match and calls OnChange when the
// published version changes (not for the first one it sees).
type Watcher struct {
	URL      string
	Every    time.Duration
	Client   *http.Client
	Log      *slog.Logger
	OnChange func(protocol.AppUpdate)

	mu      sync.RWMutex
	latest  protocol.AppUpdate
	etag    string
	lastErr string
}

// Latest is the last published version seen; ok is false before the first poll.
func (w *Watcher) Latest() (protocol.AppUpdate, bool) {
	w.mu.RLock()
	defer w.mu.RUnlock()
	return w.latest, w.latest.Version != ""
}

// Run polls until ctx ends.
func (w *Watcher) Run(ctx context.Context) {
	t := time.NewTicker(w.Every)
	defer t.Stop()
	for {
		w.poll(ctx)
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		}
	}
}

func (w *Watcher) poll(ctx context.Context) {
	rel, changed, err := w.fetch(ctx)
	if err != nil {
		// Logged once per distinct error: the bucket may simply have no release yet.
		if msg := err.Error(); msg != w.lastErr && ctx.Err() == nil {
			w.lastErr = msg
			w.Log.Warn("releases: manifest unavailable", "url", w.URL, "err", err)
		}
		return
	}
	w.lastErr = ""
	if !changed {
		return
	}
	w.mu.Lock()
	prev := w.latest
	w.latest = rel
	w.mu.Unlock()
	if prev.Version == rel.Version {
		return
	}
	w.Log.Info("releases: version published", "version", rel.Version, "previous", prev.Version)
	if prev.Version != "" && w.OnChange != nil {
		w.OnChange(rel)
	}
}

func (w *Watcher) fetch(ctx context.Context) (protocol.AppUpdate, bool, error) {
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, w.URL, nil)
	if err != nil {
		return protocol.AppUpdate{}, false, err
	}
	if w.etag != "" {
		req.Header.Set("If-None-Match", w.etag)
	}
	client := w.Client
	if client == nil {
		client = http.DefaultClient
	}
	res, err := client.Do(req)
	if err != nil {
		return protocol.AppUpdate{}, false, err
	}
	defer res.Body.Close()
	switch res.StatusCode {
	case http.StatusNotModified:
		return protocol.AppUpdate{}, false, nil
	case http.StatusOK:
	default:
		return protocol.AppUpdate{}, false, fmt.Errorf("status %d", res.StatusCode)
	}
	var m struct {
		Version string `json:"version"`
		Notes   string `json:"notes"`
	}
	if err := json.NewDecoder(io.LimitReader(res.Body, 1<<20)).Decode(&m); err != nil {
		return protocol.AppUpdate{}, false, err
	}
	if _, ok := parse(m.Version); !ok {
		return protocol.AppUpdate{}, false, fmt.Errorf("invalid version %q", m.Version)
	}
	w.etag = res.Header.Get("ETag")
	return protocol.AppUpdate{Version: strings.TrimPrefix(m.Version, "v"), Notes: m.Notes}, true, nil
}

// Older reports whether client is an older release than latest. Versions that
// are not X.Y.Z (dev builds, the browser) are never older.
func Older(client, latest string) bool {
	c, ok1 := parse(client)
	l, ok2 := parse(latest)
	if !ok1 || !ok2 {
		return false
	}
	for i := range c {
		if c[i] != l[i] {
			return c[i] < l[i]
		}
	}
	return false
}

func parse(v string) ([3]int, bool) {
	var out [3]int
	v, _, _ = strings.Cut(strings.TrimPrefix(v, "v"), "-")
	parts := strings.Split(v, ".")
	if len(parts) != 3 {
		return out, false
	}
	for i, p := range parts {
		n, err := strconv.Atoi(p)
		if err != nil || n < 0 {
			return out, false
		}
		out[i] = n
	}
	return out, true
}
