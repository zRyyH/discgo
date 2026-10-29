// Package voice keeps voice state in memory (single API process) and decides
// each channel's transport (PLAN 2.2, 3.2):
//
//	1 participant            -> idle (connect to nothing)
//	2, both p2p-capable,
//	pair not blocked         -> p2p (immediately from idle; after SwitchDelay from sfu)
//	otherwise                -> sfu (immediately)
//
// Every mode change gets a new session id and a voice_session for every member.
// A failed p2p session blocks the pair for BlockTTL and switches to sfu.
package voice

import (
	"errors"
	"sync"
	"time"

	"github.com/google/uuid"

	"discgo/api/internal/protocol"
)

const (
	Idle = "idle"
	P2P  = "p2p"
	SFU  = "sfu"
)

var ErrNotInVoice = errors.New("not in a voice channel")

type Config struct {
	// P2P is used for exactly two participants when this is >= 2; 0 disables P2P.
	MaxP2P      int
	SwitchDelay time.Duration
	BlockTTL    time.Duration
	// How long a participant whose gateway connection dropped keeps its place.
	Grace      time.Duration
	LiveKitURL string
}

// Notifier delivers voice events; it is called without the manager lock held.
type Notifier interface {
	// VoiceState goes to every connected client.
	VoiceState(protocol.VoiceState)
	// VoiceSession goes to the participant's voice connection only.
	VoiceSession(userID uuid.UUID, connID uint64, s protocol.VoiceSession)
}

type Manager struct {
	cfg Config
	out Notifier

	mu      sync.Mutex
	rooms   map[uuid.UUID]*room
	users   map[uuid.UUID]*participant
	blocked map[[2]uuid.UUID]time.Time
}

type participant struct {
	userID    uuid.UUID
	channelID uuid.UUID
	connID    uint64 // 0 while the gateway connection is gone (grace period)
	p2p       bool
	mute      bool
	deaf      bool
	grace     *time.Timer
}

type room struct {
	members   map[uuid.UUID]*participant
	mode      string
	sessionID string
	pending   *time.Timer // scheduled sfu -> p2p switch
	gen       uint64      // bumps on every membership change; stale timers check it
}

type outbox struct {
	states   []protocol.VoiceState
	sessions []sessionMsg
}

type sessionMsg struct {
	userID uuid.UUID
	connID uint64
	s      protocol.VoiceSession
}

func New(cfg Config, out Notifier) *Manager {
	if cfg.Grace == 0 {
		cfg.Grace = 10 * time.Second
	}
	return &Manager{
		cfg:     cfg,
		out:     out,
		rooms:   map[uuid.UUID]*room{},
		users:   map[uuid.UUID]*participant{},
		blocked: map[[2]uuid.UUID]time.Time{},
	}
}

// Join puts the user in channelID (leaving any other voice channel). Joining the
// channel the user is already in rebinds it to connID, e.g. after a reconnect.
func (m *Manager) Join(userID uuid.UUID, connID uint64, channelID uuid.UUID, p2p, mute, deaf bool) {
	m.mu.Lock()
	o := &outbox{}
	if p, ok := m.users[userID]; ok {
		if p.channelID == channelID {
			stopTimer(&p.grace)
			p.connID, p.p2p = connID, p2p
			if p.mute != mute || p.deaf != deaf {
				p.mute, p.deaf = mute, deaf
				o.states = append(o.states, p.state())
			}
			m.sendSession(o, m.rooms[channelID], p)
			m.mu.Unlock()
			m.flush(o)
			return
		}
		m.leaveLocked(p, o)
	}
	p := &participant{userID: userID, channelID: channelID, connID: connID, p2p: p2p, mute: mute, deaf: deaf}
	r := m.rooms[channelID]
	if r == nil {
		r = &room{members: map[uuid.UUID]*participant{}, mode: Idle, sessionID: newID()}
		m.rooms[channelID] = r
	}
	r.members[userID] = p
	m.users[userID] = p
	o.states = append(o.states, p.state())
	m.recompute(channelID, r, o, p)
	m.mu.Unlock()
	m.flush(o)
}

func (m *Manager) Leave(userID uuid.UUID) {
	m.mu.Lock()
	o := &outbox{}
	if p, ok := m.users[userID]; ok {
		m.leaveLocked(p, o)
	}
	m.mu.Unlock()
	m.flush(o)
}

func (m *Manager) SetState(userID uuid.UUID, mute, deaf bool) error {
	m.mu.Lock()
	p, ok := m.users[userID]
	if !ok {
		m.mu.Unlock()
		return ErrNotInVoice
	}
	p.mute, p.deaf = mute, deaf
	st := p.state()
	m.mu.Unlock()
	m.out.VoiceState(st)
	return nil
}

// ConnClosed starts the grace period if connID carried the user's voice.
func (m *Manager) ConnClosed(userID uuid.UUID, connID uint64) {
	m.mu.Lock()
	defer m.mu.Unlock()
	p, ok := m.users[userID]
	if !ok || p.connID != connID {
		return
	}
	p.connID = 0
	stopTimer(&p.grace)
	p.grace = time.AfterFunc(m.cfg.Grace, func() {
		m.mu.Lock()
		o := &outbox{}
		if m.users[userID] == p && p.connID == 0 {
			m.leaveLocked(p, o)
		}
		m.mu.Unlock()
		m.flush(o)
	})
}

// P2PFailed blocks the pair of a failed p2p session and moves the channel to sfu.
func (m *Manager) P2PFailed(userID uuid.UUID, sessionID string) {
	m.mu.Lock()
	o := &outbox{}
	if p, ok := m.users[userID]; ok {
		r := m.rooms[p.channelID]
		if a, b, ok := pairOf(r); ok && r.mode == P2P && r.sessionID == sessionID {
			other := a
			if other == p {
				other = b
			}
			// A peer whose app closed or crashed also looks like a failed connection;
			// its gateway connection is gone too, and the grace period handles it.
			if other.connID != 0 {
				m.blocked[pairKey(a, b)] = time.Now().Add(m.cfg.BlockTTL)
				m.recompute(p.channelID, r, o, nil)
			}
		}
	}
	m.mu.Unlock()
	m.flush(o)
}

// RelayTarget validates a P2P signal and returns the recipient's connection.
func (m *Manager) RelayTarget(from, to uuid.UUID, sessionID string) (uint64, bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	p, q := m.users[from], m.users[to]
	if p == nil || q == nil || p == q || p.channelID != q.channelID || q.connID == 0 {
		return 0, false
	}
	r := m.rooms[p.channelID]
	return q.connID, r.mode == P2P && r.sessionID == sessionID
}

// Current returns the user's channel and mode.
func (m *Manager) Current(userID uuid.UUID) (uuid.UUID, string, bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	p, ok := m.users[userID]
	if !ok {
		return uuid.Nil, "", false
	}
	return p.channelID, m.rooms[p.channelID].mode, true
}

// SessionFor is the user's current session, for the gateway `ready`.
func (m *Manager) SessionFor(userID uuid.UUID) *protocol.VoiceSession {
	m.mu.Lock()
	defer m.mu.Unlock()
	p, ok := m.users[userID]
	if !ok {
		return nil
	}
	s := m.session(p.channelID, m.rooms[p.channelID], p)
	return &s
}

func (m *Manager) States() []protocol.VoiceState {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := make([]protocol.VoiceState, 0, len(m.users))
	for _, p := range m.users {
		out = append(out, p.state())
	}
	return out
}

// ChannelRemoved disconnects everyone from a deleted channel.
func (m *Manager) ChannelRemoved(channelID uuid.UUID) {
	m.mu.Lock()
	o := &outbox{}
	if r, ok := m.rooms[channelID]; ok {
		for _, p := range r.members {
			m.leaveLocked(p, o)
		}
	}
	m.mu.Unlock()
	m.flush(o)
}

func (m *Manager) leaveLocked(p *participant, o *outbox) {
	stopTimer(&p.grace)
	delete(m.users, p.userID)
	r := m.rooms[p.channelID]
	delete(r.members, p.userID)
	o.states = append(o.states, protocol.VoiceState{UserID: p.userID.String()})
	if len(r.members) == 0 {
		stopTimer(&r.pending)
		delete(m.rooms, p.channelID)
		return
	}
	m.recompute(p.channelID, r, o, nil)
}

// recompute applies the mode rule after a membership change. joined, if set,
// gets the current session even when the mode does not change.
func (m *Manager) recompute(channelID uuid.UUID, r *room, o *outbox, joined *participant) {
	r.gen++
	stopTimer(&r.pending)
	desired := m.desired(r)
	switch {
	case desired == r.mode:
		if joined != nil {
			m.sendSession(o, r, joined)
		}
	case desired == P2P && r.mode == SFU:
		// Hysteresis: only go back to p2p after the pair has been stable for SwitchDelay.
		gen := r.gen
		r.pending = time.AfterFunc(m.cfg.SwitchDelay, func() {
			m.mu.Lock()
			o := &outbox{}
			if cur := m.rooms[channelID]; cur == r && r.gen == gen && m.desired(r) == P2P {
				r.pending = nil
				m.switchMode(channelID, r, P2P, o)
			}
			m.mu.Unlock()
			m.flush(o)
		})
		if joined != nil {
			m.sendSession(o, r, joined)
		}
	default:
		m.switchMode(channelID, r, desired, o)
	}
}

func (m *Manager) desired(r *room) string {
	switch n := len(r.members); {
	case n <= 1:
		return Idle
	case n == 2 && m.cfg.MaxP2P >= 2:
		a, b, _ := pairOf(r)
		if a.p2p && b.p2p && !time.Now().Before(m.blocked[pairKey(a, b)]) {
			return P2P
		}
	}
	return SFU
}

func (m *Manager) switchMode(channelID uuid.UUID, r *room, mode string, o *outbox) {
	r.mode = mode
	r.sessionID = newID()
	for _, p := range r.members {
		o.sessions = append(o.sessions, sessionMsg{p.userID, p.connID, m.session(channelID, r, p)})
	}
}

func (m *Manager) sendSession(o *outbox, r *room, p *participant) {
	o.sessions = append(o.sessions, sessionMsg{p.userID, p.connID, m.session(p.channelID, r, p)})
}

func (m *Manager) session(channelID uuid.UUID, r *room, p *participant) protocol.VoiceSession {
	s := protocol.VoiceSession{ChannelID: channelID.String(), SessionID: r.sessionID, Mode: r.mode}
	switch r.mode {
	case P2P:
		for id := range r.members {
			if id != p.userID {
				s.PeerUserID = id.String()
				s.Polite = p.userID.String() < s.PeerUserID
			}
		}
	case SFU:
		s.LiveKitURL = m.cfg.LiveKitURL
	}
	return s
}

func (m *Manager) flush(o *outbox) {
	for _, st := range o.states {
		m.out.VoiceState(st)
	}
	for _, s := range o.sessions {
		if s.connID != 0 {
			m.out.VoiceSession(s.userID, s.connID, s.s)
		}
	}
}

func (p *participant) state() protocol.VoiceState {
	return protocol.VoiceState{
		UserID:    p.userID.String(),
		ChannelID: protocol.ChannelIDPtr(p.channelID),
		SelfMute:  p.mute,
		SelfDeaf:  p.deaf,
	}
}

func pairOf(r *room) (*participant, *participant, bool) {
	if len(r.members) != 2 {
		return nil, nil, false
	}
	var ps []*participant
	for _, p := range r.members {
		ps = append(ps, p)
	}
	return ps[0], ps[1], true
}

func pairKey(a, b *participant) [2]uuid.UUID {
	if a.userID.String() > b.userID.String() {
		a, b = b, a
	}
	return [2]uuid.UUID{a.userID, b.userID}
}

func stopTimer(t **time.Timer) {
	if *t != nil {
		(*t).Stop()
		*t = nil
	}
}

func newID() string {
	return uuid.Must(uuid.NewV7()).String()
}
