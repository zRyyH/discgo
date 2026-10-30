// Package gateway is the WebSocket at /v1/gateway (PLAN 5.3): presence, live
// events, voice join/leave and the relay of P2P signalling. Every (re)connect
// starts with identify -> ready, a full resync.
package gateway

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"sync"
	"sync/atomic"
	"time"

	"github.com/coder/websocket"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"discgo/api/internal/auth"
	"discgo/api/internal/db"
	"discgo/api/internal/protocol"
	"discgo/api/internal/releases"
	"discgo/api/internal/voice"
)

const (
	identifyTimeout = 10 * time.Second
	writeTimeout    = 10 * time.Second
	pingEvery       = 25 * time.Second
	sendBuffer      = 256
	readLimit       = 256 << 10 // SDP offers with many candidates fit comfortably
)

type Hub struct {
	Log       *slog.Logger
	Auth      *auth.Service
	Queries   *db.Queries
	Voice     *voice.Manager
	Community string
	// The published desktop version (PLAN fase 9A); nil when RELEASES_URL is unset.
	Releases interface {
		Latest() (protocol.AppUpdate, bool)
	}

	nextID atomic.Uint64
	mu     sync.RWMutex
	conns  map[uint64]*conn
	byUser map[uuid.UUID]map[uint64]*conn
}

type conn struct {
	id      uint64
	userID  uuid.UUID
	p2p     bool
	version string // client app version from identify
	send    chan []byte
	cancel  context.CancelFunc
}

func NewHub(log *slog.Logger, pool *pgxpool.Pool, a *auth.Service, community string) *Hub {
	return &Hub{
		Log:       log,
		Auth:      a,
		Queries:   db.New(pool),
		Community: community,
		conns:     map[uint64]*conn{},
		byUser:    map[uuid.UUID]map[uint64]*conn{},
	}
}

// Broadcast sends an event to every identified connection.
func (h *Hub) Broadcast(op string, d any) {
	msg := encode(op, d)
	h.mu.RLock()
	defer h.mu.RUnlock()
	for _, c := range h.conns {
		h.trySend(c, msg)
	}
}

// SendToUser sends an event to every connection of one user.
func (h *Hub) SendToUser(userID uuid.UUID, op string, d any) {
	msg := encode(op, d)
	h.mu.RLock()
	defer h.mu.RUnlock()
	for _, c := range h.byUser[userID] {
		h.trySend(c, msg)
	}
}

// AppUpdate tells every connection running an older app version to update.
func (h *Hub) AppUpdate(rel protocol.AppUpdate) {
	msg := encode(protocol.OpAppUpdate, rel)
	h.mu.RLock()
	defer h.mu.RUnlock()
	for _, c := range h.conns {
		if releases.Older(c.version, rel.Version) {
			h.trySend(c, msg)
		}
	}
}

// Online reports whether the user has at least one connection.
func (h *Hub) Online(userID uuid.UUID) bool {
	h.mu.RLock()
	defer h.mu.RUnlock()
	return len(h.byUser[userID]) > 0
}

// VoiceState implements voice.Notifier.
func (h *Hub) VoiceState(st protocol.VoiceState) {
	h.Broadcast(protocol.OpVoiceStateUpdate, st)
}

// VoiceSession implements voice.Notifier.
func (h *Hub) VoiceSession(_ uuid.UUID, connID uint64, s protocol.VoiceSession) {
	h.sendTo(connID, encode(protocol.OpVoiceSession, s))
}

func (h *Hub) sendTo(connID uint64, msg []byte) {
	h.mu.RLock()
	defer h.mu.RUnlock()
	if c, ok := h.conns[connID]; ok {
		h.trySend(c, msg)
	}
}

// trySend never blocks the caller: a client that cannot keep up is dropped and
// resyncs on reconnect.
func (h *Hub) trySend(c *conn, msg []byte) {
	select {
	case c.send <- msg:
	default:
		h.Log.Warn("gateway: slow client dropped", "user_id", c.userID, "conn", c.id)
		c.cancel()
	}
}

func (h *Hub) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	// Auth is the identify token, not cookies, so any origin may connect.
	ws, err := websocket.Accept(w, r, &websocket.AcceptOptions{InsecureSkipVerify: true})
	if err != nil {
		return
	}
	ws.SetReadLimit(readLimit)
	ctx, cancel := context.WithCancel(r.Context())
	defer cancel()

	user, ident, err := h.identify(ctx, ws)
	if err != nil {
		ws.Close(websocket.StatusPolicyViolation, err.Error())
		return
	}
	c := &conn{
		id: h.nextID.Add(1), userID: user.ID, p2p: ident.Client.P2P, version: ident.Client.Version,
		send: make(chan []byte, sendBuffer), cancel: cancel,
	}
	ready, err := h.ready(ctx, user)
	if err != nil {
		h.Log.Error("gateway: ready", "err", err)
		ws.Close(websocket.StatusInternalError, "ready failed")
		return
	}
	// ready is queued before registering so it is always the first frame.
	c.send <- encode(protocol.OpReady, ready)
	if h.Releases != nil {
		if rel, ok := h.Releases.Latest(); ok && releases.Older(c.version, rel.Version) {
			c.send <- encode(protocol.OpAppUpdate, rel)
		}
	}
	if first := h.register(c); first {
		h.Broadcast(protocol.OpPresenceUpdate, protocol.PresenceUpdate{UserID: user.ID.String(), Status: "online"})
	}
	h.Log.Info("gateway: connected", "user_id", user.ID, "conn", c.id, "version", ident.Client.Version)

	go h.writeLoop(ctx, ws, c)
	err = h.readLoop(ctx, ws, c)
	cancel()

	if last := h.unregister(c); last {
		h.Broadcast(protocol.OpPresenceUpdate, protocol.PresenceUpdate{UserID: user.ID.String(), Status: "offline"})
	}
	if h.Voice != nil {
		h.Voice.ConnClosed(user.ID, c.id)
	}
	status := websocket.CloseStatus(err)
	h.Log.Info("gateway: disconnected", "user_id", user.ID, "conn", c.id, "status", status)
	ws.Close(websocket.StatusNormalClosure, "")
}

func (h *Hub) identify(ctx context.Context, ws *websocket.Conn) (db.User, protocol.Identify, error) {
	ctx, cancel := context.WithTimeout(ctx, identifyTimeout)
	defer cancel()
	var f protocol.Frame
	var ident protocol.Identify
	_, data, err := ws.Read(ctx)
	if err != nil {
		return db.User{}, ident, err
	}
	if json.Unmarshal(data, &f) != nil || f.Op != protocol.OpIdentify || json.Unmarshal(f.D, &ident) != nil {
		return db.User{}, ident, errors.New("expected identify")
	}
	user, err := h.Auth.Authenticate(ctx, ident.Token)
	if err != nil {
		return db.User{}, ident, errors.New("unauthorized")
	}
	return user, ident, nil
}

func (h *Hub) ready(ctx context.Context, user db.User) (protocol.Ready, error) {
	users, err := h.Queries.ListUsers(ctx)
	if err != nil {
		return protocol.Ready{}, err
	}
	channels, err := h.Queries.ListChannels(ctx)
	if err != nil {
		return protocol.Ready{}, err
	}
	rels, err := h.Queries.ListRelationships(ctx, user.ID)
	if err != nil {
		return protocol.Ready{}, err
	}
	out := protocol.Ready{
		User:          protocol.FromMe(user),
		Community:     protocol.Community{Name: h.Community},
		Members:       make([]protocol.Member, 0, len(users)),
		Channels:      make([]protocol.Channel, 0, len(channels)),
		VoiceStates:   []protocol.VoiceState{},
		Relationships: make([]protocol.Relationship, 0, len(rels)),
	}
	for _, r := range rels {
		out.Relationships = append(out.Relationships, protocol.FromRelationship(r.User, r.Kind, r.Since))
	}
	for _, u := range users {
		status := "offline"
		if u.ID == user.ID || h.Online(u.ID) {
			status = "online"
		}
		out.Members = append(out.Members, protocol.Member{User: protocol.FromUser(u), Status: status})
	}
	for _, c := range channels {
		out.Channels = append(out.Channels, protocol.FromChannel(c))
	}
	if h.Voice != nil {
		out.VoiceStates = h.Voice.States()
		out.VoiceSession = h.Voice.SessionFor(user.ID)
	}
	return out, nil
}

func (h *Hub) register(c *conn) (first bool) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.conns[c.id] = c
	set := h.byUser[c.userID]
	if set == nil {
		set = map[uint64]*conn{}
		h.byUser[c.userID] = set
	}
	set[c.id] = c
	return len(set) == 1
}

func (h *Hub) unregister(c *conn) (last bool) {
	h.mu.Lock()
	defer h.mu.Unlock()
	delete(h.conns, c.id)
	set := h.byUser[c.userID]
	delete(set, c.id)
	if len(set) == 0 {
		delete(h.byUser, c.userID)
		return true
	}
	return false
}

func (h *Hub) writeLoop(ctx context.Context, ws *websocket.Conn, c *conn) {
	ping := time.NewTicker(pingEvery)
	defer ping.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case msg := <-c.send:
			wctx, cancel := context.WithTimeout(ctx, writeTimeout)
			err := ws.Write(wctx, websocket.MessageText, msg)
			cancel()
			if err != nil {
				c.cancel()
				return
			}
		case <-ping.C:
			pctx, cancel := context.WithTimeout(ctx, writeTimeout)
			err := ws.Ping(pctx)
			cancel()
			if err != nil {
				c.cancel()
				return
			}
		}
	}
}

func (h *Hub) readLoop(ctx context.Context, ws *websocket.Conn, c *conn) error {
	for {
		_, data, err := ws.Read(ctx)
		if err != nil {
			return err
		}
		var f protocol.Frame
		if err := json.Unmarshal(data, &f); err != nil {
			h.reply(c, "bad_frame", "invalid JSON frame")
			continue
		}
		if err := h.handle(ctx, c, f); err != nil {
			h.reply(c, "bad_request", err.Error())
		}
	}
}

func (h *Hub) handle(ctx context.Context, c *conn, f protocol.Frame) error {
	switch f.Op {
	case protocol.OpPing:
		h.sendTo(c.id, encode(protocol.OpPong, json.RawMessage(f.D)))
	case protocol.OpVoiceJoin:
		var d protocol.VoiceJoin
		if err := json.Unmarshal(f.D, &d); err != nil {
			return err
		}
		id, err := uuid.Parse(d.ChannelID)
		if err != nil {
			return errors.New("invalid channel_id")
		}
		ch, err := h.Queries.GetChannel(ctx, id)
		if err != nil || ch.Kind != "voice" {
			return errors.New("not a voice channel")
		}
		h.Voice.Join(c.userID, c.id, id, c.p2p, d.SelfMute, d.SelfDeaf, d.SessionID)
	case protocol.OpVoiceLeave:
		h.Voice.Leave(c.userID)
	case protocol.OpVoiceState:
		var d protocol.VoiceStateChange
		if err := json.Unmarshal(f.D, &d); err != nil {
			return err
		}
		return h.Voice.SetState(c.userID, d.SelfMute, d.SelfDeaf)
	case protocol.OpRTCSignal:
		var d protocol.RTCSignal
		if err := json.Unmarshal(f.D, &d); err != nil {
			return err
		}
		to, err := uuid.Parse(d.ToUserID)
		if err != nil {
			return errors.New("invalid to_user_id")
		}
		target, ok := h.Voice.RelayTarget(c.userID, to, d.SessionID)
		if !ok {
			return errors.New("rtc_signal outside the current p2p session")
		}
		d.FromUserID, d.ToUserID = c.userID.String(), ""
		h.sendTo(target, encode(protocol.OpRTCSignal, d))
	case protocol.OpP2PFailed:
		var d protocol.P2PFailed
		if err := json.Unmarshal(f.D, &d); err != nil {
			return err
		}
		h.Log.Info("gateway: p2p failed", "user_id", c.userID, "session_id", d.SessionID, "reason", d.Reason)
		h.Voice.P2PFailed(c.userID, d.SessionID)
	default:
		return errors.New("unknown op " + f.Op)
	}
	return nil
}

func (h *Hub) reply(c *conn, code, message string) {
	h.sendTo(c.id, encode(protocol.OpError, protocol.Error{Code: code, Message: message}))
}

func encode(op string, d any) []byte {
	b, err := json.Marshal(protocol.NewFrame(op, d))
	if err != nil {
		panic(err)
	}
	return b
}
