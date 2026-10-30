package voice

import (
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"

	"discgo/api/internal/protocol"
)

type recorder struct {
	mu       sync.Mutex
	states   []protocol.VoiceState
	sessions map[uuid.UUID][]protocol.VoiceSession
}

func newRecorder() *recorder {
	return &recorder{sessions: map[uuid.UUID][]protocol.VoiceSession{}}
}

func (r *recorder) VoiceState(st protocol.VoiceState) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.states = append(r.states, st)
}

func (r *recorder) VoiceSession(userID uuid.UUID, _ uint64, s protocol.VoiceSession) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.sessions[userID] = append(r.sessions[userID], s)
}

// last returns the newest session the user received.
func (r *recorder) last(t *testing.T, id uuid.UUID) protocol.VoiceSession {
	t.Helper()
	r.mu.Lock()
	defer r.mu.Unlock()
	s := r.sessions[id]
	if len(s) == 0 {
		t.Fatalf("user %s got no voice_session", id)
	}
	return s[len(s)-1]
}

func (r *recorder) count(id uuid.UUID) int {
	r.mu.Lock()
	defer r.mu.Unlock()
	return len(r.sessions[id])
}

func newManager(out Notifier) *Manager {
	return New(Config{MaxP2P: 2, SwitchDelay: 100 * time.Millisecond, BlockTTL: time.Hour, Grace: 50 * time.Millisecond, LiveKitURL: "wss://lk"}, out)
}

func ids(n int) []uuid.UUID {
	out := make([]uuid.UUID, n)
	for i := range out {
		out[i] = uuid.Must(uuid.NewV7())
	}
	return out
}

func eventually(t *testing.T, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for !cond() {
		if time.Now().After(deadline) {
			t.Fatalf("timed out waiting for %s", what)
		}
		time.Sleep(5 * time.Millisecond)
	}
}

func TestModeRule(t *testing.T) {
	rec := newRecorder()
	m := newManager(rec)
	ch := uuid.Must(uuid.NewV7())
	u := ids(3)

	m.Join(u[0], 1, ch, true, false, false, "")
	if s := rec.last(t, u[0]); s.Mode != Idle {
		t.Fatalf("alone: mode %q, want idle", s.Mode)
	}

	// Second participant: straight to p2p, no hysteresis from idle.
	m.Join(u[1], 2, ch, true, false, false, "")
	a, b := rec.last(t, u[0]), rec.last(t, u[1])
	if a.Mode != P2P || b.Mode != P2P || a.SessionID != b.SessionID {
		t.Fatalf("two: got %+v / %+v, want same p2p session", a, b)
	}
	if a.PeerUserID != u[1].String() || b.PeerUserID != u[0].String() {
		t.Fatalf("peers wrong: %+v / %+v", a, b)
	}
	if a.Polite == b.Polite || a.Polite != (u[0].String() < u[1].String()) {
		t.Fatalf("polite must be the smaller user id: %v / %v", a.Polite, b.Polite)
	}

	// Third: sfu immediately for everyone.
	m.Join(u[2], 3, ch, true, false, false, "")
	for _, id := range u {
		if s := rec.last(t, id); s.Mode != SFU || s.LiveKitURL != "wss://lk" {
			t.Fatalf("three: %s got %+v, want sfu", id, s)
		}
	}
	sfuSession := rec.last(t, u[0]).SessionID

	// Back to two: stays sfu until the switch delay, then p2p.
	m.Leave(u[2])
	if s := rec.last(t, u[0]); s.SessionID != sfuSession {
		t.Fatalf("switched before the delay: %+v", s)
	}
	eventually(t, "p2p after delay", func() bool { return rec.last(t, u[0]).Mode == P2P })
	if rec.last(t, u[1]).Mode != P2P {
		t.Fatal("peer not switched to p2p")
	}

	// Down to one: idle.
	m.Leave(u[1])
	if s := rec.last(t, u[0]); s.Mode != Idle {
		t.Fatalf("alone again: %+v", s)
	}
}

func TestSwitchCancelledWhenMembershipChanges(t *testing.T) {
	rec := newRecorder()
	m := newManager(rec)
	ch := uuid.Must(uuid.NewV7())
	u := ids(3)
	for i, id := range u {
		m.Join(id, uint64(i+1), ch, true, false, false, "")
	}
	m.Leave(u[2])
	m.Join(u[2], 3, ch, true, false, false, "") // back to three before the delay
	time.Sleep(200 * time.Millisecond)
	for _, id := range u {
		if s := rec.last(t, id); s.Mode != SFU {
			t.Fatalf("%s switched to %s although the channel had three people", id, s.Mode)
		}
	}
}

func TestP2PFailedBlocksPair(t *testing.T) {
	rec := newRecorder()
	m := newManager(rec)
	ch := uuid.Must(uuid.NewV7())
	u := ids(2)
	m.Join(u[0], 1, ch, true, false, false, "")
	m.Join(u[1], 2, ch, true, false, false, "")
	p2p := rec.last(t, u[0])

	m.P2PFailed(u[1], "stale-session") // ignored
	if rec.last(t, u[0]).SessionID != p2p.SessionID {
		t.Fatal("stale p2p_failed changed the session")
	}
	m.P2PFailed(u[1], p2p.SessionID)
	if s := rec.last(t, u[0]); s.Mode != SFU {
		t.Fatalf("after p2p_failed: %+v", s)
	}

	// Blocked for BlockTTL: rejoining does not bring p2p back.
	m.Leave(u[1])
	m.Join(u[1], 2, ch, true, false, false, "")
	time.Sleep(150 * time.Millisecond)
	if s := rec.last(t, u[0]); s.Mode != SFU {
		t.Fatalf("blocked pair went p2p: %+v", s)
	}
}

func TestP2PFailedIgnoredWhenPeerIsGone(t *testing.T) {
	rec := newRecorder()
	m := newManager(rec)
	ch := uuid.Must(uuid.NewV7())
	u := ids(2)
	m.Join(u[0], 1, ch, true, false, false, "")
	m.Join(u[1], 2, ch, true, false, false, "")
	p2p := rec.last(t, u[0])

	// u[1]'s app died: its gateway connection closed, then u[0]'s ICE gives up.
	m.ConnClosed(u[1], 2)
	m.P2PFailed(u[0], p2p.SessionID)
	if s := rec.last(t, u[0]); s.SessionID != p2p.SessionID {
		t.Fatalf("switched to %s because the peer left", s.Mode)
	}
	// It comes back within the grace period: still p2p, nothing blocked.
	m.Join(u[1], 3, ch, true, false, false, "")
	if s := rec.last(t, u[1]); s.Mode != P2P {
		t.Fatalf("rejoin got %+v", s)
	}
}

func TestNotP2PCapableUsesSFU(t *testing.T) {
	rec := newRecorder()
	m := newManager(rec)
	ch := uuid.Must(uuid.NewV7())
	u := ids(2)
	m.Join(u[0], 1, ch, true, false, false, "")
	m.Join(u[1], 2, ch, false, false, false, "")
	if s := rec.last(t, u[0]); s.Mode != SFU {
		t.Fatalf("got %+v, want sfu", s)
	}
}

func TestRelayTarget(t *testing.T) {
	rec := newRecorder()
	m := newManager(rec)
	ch := uuid.Must(uuid.NewV7())
	u := ids(3)
	m.Join(u[0], 10, ch, true, false, false, "")
	m.Join(u[1], 20, ch, true, false, false, "")
	sid := rec.last(t, u[0]).SessionID
	if conn, ok := m.RelayTarget(u[0], u[1], sid); !ok || conn != 20 {
		t.Fatalf("relay = %d, %v", conn, ok)
	}
	if _, ok := m.RelayTarget(u[0], u[1], "other"); ok {
		t.Fatal("relay accepted a wrong session id")
	}
	m.Join(u[2], 30, ch, true, false, false, "")
	if _, ok := m.RelayTarget(u[0], u[1], rec.last(t, u[0]).SessionID); ok {
		t.Fatal("relay accepted in sfu mode")
	}
}

func TestGraceAndRejoin(t *testing.T) {
	rec := newRecorder()
	m := newManager(rec)
	ch := uuid.Must(uuid.NewV7())
	u := ids(2)
	m.Join(u[0], 1, ch, true, false, false, "")
	m.Join(u[1], 2, ch, true, false, false, "")
	sid := rec.last(t, u[0]).SessionID

	// Reconnect within the grace period, media still up: same session, peer untouched.
	m.ConnClosed(u[1], 2)
	before, peerBefore := rec.count(u[1]), rec.count(u[0])
	m.Join(u[1], 3, ch, true, false, false, sid)
	if rec.count(u[1]) != before+1 || rec.last(t, u[1]).SessionID != sid || rec.count(u[0]) != peerBefore {
		t.Fatal("rejoin did not resend the current session")
	}
	time.Sleep(100 * time.Millisecond)
	if _, _, ok := m.Current(u[1]); !ok {
		t.Fatal("user removed although it reconnected")
	}

	// The app restarted (an update): no media left, so both get a new p2p session.
	m.ConnClosed(u[1], 3)
	m.Join(u[1], 4, ch, true, false, false, "")
	a, b := rec.last(t, u[0]), rec.last(t, u[1])
	if a.Mode != P2P || a.SessionID == sid || b.SessionID != a.SessionID {
		t.Fatalf("restart rejoin: peer %+v, restarted %+v", a, b)
	}

	// No reconnect: removed after the grace period.
	m.ConnClosed(u[1], 4)
	eventually(t, "removal after grace", func() bool {
		_, _, ok := m.Current(u[1])
		return !ok
	})
	if s := rec.last(t, u[0]); s.Mode != Idle {
		t.Fatalf("remaining user: %+v", s)
	}
}

func TestSFUWebhookRemovesStaleParticipant(t *testing.T) {
	rec := newRecorder()
	m := newManager(rec)
	ch := uuid.Must(uuid.NewV7())
	u := ids(3)
	for i, id := range u {
		m.Join(id, uint64(i+1), ch, true, false, false, "")
	}
	// u[2] drops out of LiveKit and comes back: stays.
	m.SFULeft(u[2], ch)
	m.SFUJoined(u[2], ch)
	time.Sleep(100 * time.Millisecond)
	if _, _, ok := m.Current(u[2]); !ok {
		t.Fatal("removed although it rejoined the room")
	}
	// u[2] drops out for good: removed after the grace period.
	m.SFULeft(u[2], ch)
	eventually(t, "removal", func() bool {
		_, _, ok := m.Current(u[2])
		return !ok
	})
}
