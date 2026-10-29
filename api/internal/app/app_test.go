package app_test

import (
	"bytes"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"testing"
	"time"

	lkauth "github.com/livekit/protocol/auth"

	"discgo/api/internal/protocol"
)

// Phase 2 acceptance: first user is admin, the second needs an invite, sessions persist.
func TestLoginAndInvites(t *testing.T) {
	e := newEnv(t)
	admin := e.mustLogin("ana@test", "")
	if admin.user.Role != "admin" {
		t.Fatalf("first user role %q, want admin", admin.user.Role)
	}

	if _, status, code := e.devLogin("bruno@test", ""); status != http.StatusForbidden || code != "invite_required" {
		t.Fatalf("second user without invite: %d %s", status, code)
	}
	if _, status, code := e.devLogin("bruno@test", "nope"); status != http.StatusForbidden || code != "invite_invalid" {
		t.Fatalf("bad invite: %d %s", status, code)
	}

	var inv protocol.Invite
	if st := admin.call("POST", "/v1/invites", map[string]any{"max_uses": 1}, &inv); st != http.StatusCreated {
		t.Fatalf("create invite: %d", st)
	}
	bruno := e.mustLogin("bruno@test", inv.Code)
	if bruno.user.Role != "member" {
		t.Fatalf("invited user role %q", bruno.user.Role)
	}
	if _, status, _ := e.devLogin("carla@test", inv.Code); status != http.StatusForbidden {
		t.Fatalf("invite reused: %d", status)
	}

	// Existing members log in again without an invite; tokens are independent sessions.
	again := e.mustLogin("bruno@test", "")
	var me protocol.Me
	if st := again.call("GET", "/v1/me", nil, &me); st != http.StatusOK || me.ID != bruno.user.ID {
		t.Fatalf("me: %d %+v", st, me)
	}
	if st := bruno.call("GET", "/v1/invites", nil, nil); st != http.StatusForbidden {
		t.Fatalf("member listed invites: %d", st)
	}

	if st := again.call("POST", "/v1/auth/logout", nil, nil); st != http.StatusNoContent {
		t.Fatalf("logout: %d", st)
	}
	if st := again.call("GET", "/v1/me", nil, nil); st != http.StatusUnauthorized {
		t.Fatalf("token still valid after logout: %d", st)
	}
	if st := bruno.call("GET", "/v1/me", nil, nil); st != http.StatusOK {
		t.Fatalf("other session affected by logout: %d", st)
	}

	// One-time codes cannot be replayed.
	var res struct{ Code string }
	e.call("", "POST", "/v1/auth/dev", map[string]string{"email": "ana@test"}, &res)
	e.exchange(res.Code)
	if st := e.call("", "POST", "/v1/auth/exchange", map[string]string{"code": res.Code}, nil); st != http.StatusUnauthorized {
		t.Fatalf("code replay: %d", st)
	}
}

// The Google flow end to end against a fake OIDC provider.
func TestGoogleLogin(t *testing.T) {
	e := newEnv(t)
	e.google.Sub, e.google.Email, e.google.Name = "g-123", "dani@gmail.test", "Dani"

	// Browser: /start -> provider -> /callback -> page that opens discgo://auth?code=...
	res, err := http.Get(e.srv.URL + "/v1/auth/google/start")
	if err != nil {
		t.Fatal(err)
	}
	page, _ := io.ReadAll(res.Body)
	res.Body.Close()
	m := regexp.MustCompile(`discgo://auth\?code=([A-Za-z0-9_%-]+)`).FindSubmatch(page)
	if res.StatusCode != http.StatusOK || m == nil {
		t.Fatalf("callback page: %d %s", res.StatusCode, page)
	}
	code, _ := url.QueryUnescape(string(m[1]))
	c := e.exchange(code)
	if c.user.DisplayName != "Dani" || c.user.Email != "dani@gmail.test" || c.user.Role != "admin" {
		t.Fatalf("user: %+v", c.user)
	}

	// A second Google account without invite gets the explanatory page.
	e.google.Sub, e.google.Email = "g-456", "eva@gmail.test"
	res, err = http.Get(e.srv.URL + "/v1/auth/google/start")
	if err != nil {
		t.Fatal(err)
	}
	page, _ = io.ReadAll(res.Body)
	res.Body.Close()
	if res.StatusCode != http.StatusForbidden || !strings.Contains(string(page), "convite") {
		t.Fatalf("no-invite page: %d %s", res.StatusCode, page)
	}

	// With an invite in /start it works.
	inv := e.invite(c)
	e.google.Sub, e.google.Email = "g-456", "eva@gmail.test"
	res, err = http.Get(e.srv.URL + "/v1/auth/google/start?invite=" + inv)
	if err != nil {
		t.Fatal(err)
	}
	page, _ = io.ReadAll(res.Body)
	res.Body.Close()
	if m = regexp.MustCompile(`discgo://auth\?code=([A-Za-z0-9_%-]+)`).FindSubmatch(page); m == nil {
		t.Fatalf("invited login failed: %d %s", res.StatusCode, page)
	}
}

// Phase 3 acceptance: two clients get message_create in under 100 ms.
func TestMessagesAndEvents(t *testing.T) {
	e := newEnv(t)
	ana := e.mustLogin("ana@test", "")
	bruno := e.mustLogin("bruno@test", e.invite(ana))

	var ch protocol.Channel
	if st := bruno.call("POST", "/v1/channels", map[string]string{"kind": "text", "name": "geral"}, nil); st != http.StatusForbidden {
		t.Fatalf("member created a channel: %d", st)
	}
	if st := ana.call("POST", "/v1/channels", map[string]string{"kind": "text", "name": " geral "}, &ch); st != http.StatusCreated || ch.Name != "geral" {
		t.Fatalf("create channel: %d %+v", st, ch)
	}

	wa, wb := ana.connect(true), bruno.connect(true)
	if len(wb.ready.Channels) != 1 || wb.ready.User.ID != bruno.user.ID || wb.ready.Community.Name != "Test" {
		t.Fatalf("ready: %+v", wb.ready)
	}

	start := time.Now()
	var sent protocol.Message
	if st := ana.call("POST", "/v1/channels/"+ch.ID+"/messages", map[string]string{"content": "oi"}, &sent); st != http.StatusCreated {
		t.Fatalf("post message: %d", st)
	}
	var gotA, gotB protocol.Message
	wa.expect(protocol.OpMessageCreate, &gotA)
	wb.expect(protocol.OpMessageCreate, &gotB)
	elapsed := time.Since(start)
	if gotB.ID != sent.ID || gotA.ID != sent.ID || gotB.Content != "oi" {
		t.Fatalf("message_create: %+v / %+v", gotA, gotB)
	}
	t.Logf("POST -> message_create on both clients: %v", elapsed)
	if elapsed > 100*time.Millisecond {
		t.Fatalf("message_create took %v, budget 100 ms", elapsed)
	}

	// Edit/delete: author only.
	if st := bruno.call("PATCH", "/v1/messages/"+sent.ID, map[string]string{"content": "x"}, nil); st != http.StatusForbidden {
		t.Fatalf("non-author edit: %d", st)
	}
	var edited protocol.Message
	if st := ana.call("PATCH", "/v1/messages/"+sent.ID, map[string]string{"content": "oi!"}, &edited); st != http.StatusOK || edited.EditedAt == nil {
		t.Fatalf("edit: %d %+v", st, edited)
	}
	wb.expect(protocol.OpMessageUpdate, nil)
	if st := ana.call("DELETE", "/v1/messages/"+sent.ID, nil, nil); st != http.StatusNoContent {
		t.Fatalf("delete: %d", st)
	}
	var del protocol.MessageDelete
	wb.expect(protocol.OpMessageDelete, &del)
	if del.ID != sent.ID || del.ChannelID != ch.ID {
		t.Fatalf("message_delete: %+v", del)
	}

	// Pagination: newest first, `before` walks back.
	for i := range 7 {
		ana.call("POST", "/v1/channels/"+ch.ID+"/messages", map[string]string{"content": string(rune('a' + i))}, nil)
	}
	var page1, page2 []protocol.Message
	bruno.call("GET", "/v1/channels/"+ch.ID+"/messages?limit=5", nil, &page1)
	bruno.call("GET", "/v1/channels/"+ch.ID+"/messages?limit=5&before="+page1[4].ID, nil, &page2)
	if len(page1) != 5 || len(page2) != 2 || page1[0].Content != "g" || page2[1].Content != "a" {
		t.Fatalf("pages: %v / %v", contents(page1), contents(page2))
	}

	// Attachments must come from the caller's own uploads.
	var up struct{ Key, URL string }
	if st := bruno.call("POST", "/v1/uploads/presign", map[string]any{"name": "foto.png", "content_type": "image/png", "size": 1234}, &up); st != http.StatusOK || up.URL == "" {
		t.Fatalf("presign: %d %+v", st, up)
	}
	if st := bruno.call("POST", "/v1/uploads/presign", map[string]any{"name": "big.bin", "size": 2 << 20}, nil); st != http.StatusBadRequest {
		t.Fatalf("oversized presign: %d", st)
	}
	att := map[string]any{"key": up.Key, "name": "foto.png", "content_type": "image/png", "size": 1234}
	if st := ana.call("POST", "/v1/channels/"+ch.ID+"/messages", map[string]any{"attachments": []any{att}}, nil); st != http.StatusBadRequest {
		t.Fatalf("attachment of another user accepted: %d", st)
	}
	var withAtt protocol.Message
	if st := bruno.call("POST", "/v1/channels/"+ch.ID+"/messages", map[string]any{"attachments": []any{att}}, &withAtt); st != http.StatusCreated {
		t.Fatalf("attachment message: %d", st)
	}
	if len(withAtt.Attachments) != 1 || !strings.HasSuffix(withAtt.Attachments[0].URL, "?get") {
		t.Fatalf("attachment url: %+v", withAtt.Attachments)
	}
}

func TestPresenceAndMembers(t *testing.T) {
	e := newEnv(t)
	ana := e.mustLogin("ana@test", "")
	wa := ana.connect(true)

	bruno := e.mustLogin("bruno@test", e.invite(ana))
	var added protocol.Member
	wa.expect(protocol.OpMemberAdd, &added)
	if added.ID != bruno.user.ID {
		t.Fatalf("member_add: %+v", added)
	}

	wb := bruno.connect(true)
	var p protocol.PresenceUpdate
	wa.expectWhere(protocol.OpPresenceUpdate, &p, func() bool { return p.UserID == bruno.user.ID && p.Status == "online" })
	if online := statusOf(wb.ready.Members, ana.user.ID); online != "online" {
		t.Fatalf("ana in bruno's ready: %s", online)
	}
	wb.conn.CloseNow()
	wa.expectWhere(protocol.OpPresenceUpdate, &p, func() bool { return p.UserID == bruno.user.ID && p.Status == "offline" })
}

// Phase 3 acceptance: p2p with two, sfu when the third joins, back to p2p 10 s
// (here 300 ms) after the third leaves, and p2p_failed forces sfu.
func TestVoiceModes(t *testing.T) {
	e := newEnv(t)
	ana := e.mustLogin("ana@test", "")
	inv := func() string { return e.invite(ana) }
	bruno := e.mustLogin("bruno@test", inv())
	carla := e.mustLogin("carla@test", inv())
	var vc protocol.Channel
	ana.call("POST", "/v1/channels", map[string]string{"kind": "voice", "name": "Sala"}, &vc)

	wa, wb, wc := ana.connect(true), bruno.connect(true), carla.connect(true)
	join := map[string]any{"channel_id": vc.ID}
	var sa, sb protocol.VoiceSession

	wa.send(protocol.OpVoiceJoin, join)
	wa.expect(protocol.OpVoiceSession, &sa)
	if sa.Mode != "idle" {
		t.Fatalf("alone: %+v", sa)
	}
	if st := ana.call("GET", "/v1/channels/"+vc.ID+"/voice-token", nil, nil); st != http.StatusConflict {
		t.Fatalf("voice-token while idle: %d", st)
	}

	wb.send(protocol.OpVoiceJoin, join)
	wa.expectWhere(protocol.OpVoiceSession, &sa, func() bool { return sa.Mode == "p2p" })
	wb.expectWhere(protocol.OpVoiceSession, &sb, func() bool { return sb.Mode == "p2p" })
	if sa.SessionID != sb.SessionID || sa.PeerUserID != bruno.user.ID {
		t.Fatalf("p2p sessions: %+v / %+v", sa, sb)
	}

	// Signalling relay inside the p2p session.
	wa.send(protocol.OpRTCSignal, protocol.RTCSignal{SessionID: sa.SessionID, ToUserID: bruno.user.ID, Stream: "av", Type: "offer", Payload: []byte(`{"sdp":"v=0"}`)})
	var sig protocol.RTCSignal
	wb.expect(protocol.OpRTCSignal, &sig)
	if sig.FromUserID != ana.user.ID || sig.Type != "offer" || string(sig.Payload) != `{"sdp":"v=0"}` {
		t.Fatalf("relayed signal: %+v", sig)
	}

	switchStart := time.Now()
	wc.send(protocol.OpVoiceJoin, join)
	for _, w := range []*ws{wa, wb, wc} {
		var s protocol.VoiceSession
		w.expectWhere(protocol.OpVoiceSession, &s, func() bool { return s.Mode == "sfu" })
		if s.LiveKitURL != "ws://livekit.test" {
			t.Fatalf("sfu session: %+v", s)
		}
	}
	t.Logf("third join -> sfu on all clients: %v", time.Since(switchStart))
	var tok struct{ Token string }
	if st := carla.call("GET", "/v1/channels/"+vc.ID+"/voice-token?kind=screen", nil, &tok); st != http.StatusOK || tok.Token == "" {
		t.Fatalf("voice-token in sfu: %d", st)
	}
	if st := carla.call("GET", "/v1/channels/"+vc.ID+"/voice-token?kind=bogus", nil, nil); st != http.StatusBadRequest {
		t.Fatalf("bad kind: %d", st)
	}
	wa.send(protocol.OpRTCSignal, protocol.RTCSignal{SessionID: sa.SessionID, ToUserID: bruno.user.ID, Stream: "av", Type: "ice", Payload: []byte(`{}`)})
	var gwErr protocol.Error
	wa.expect(protocol.OpError, &gwErr)

	leaveAt := time.Now()
	wc.send(protocol.OpVoiceLeave, nil)
	wa.expectWhere(protocol.OpVoiceSession, &sa, func() bool { return sa.Mode == "p2p" })
	if d := time.Since(leaveAt); d < 250*time.Millisecond {
		t.Fatalf("went back to p2p after %v, before the switch delay", d)
	}
	wb.expectWhere(protocol.OpVoiceSession, &sb, func() bool { return sb.Mode == "p2p" })

	wb.send(protocol.OpP2PFailed, protocol.P2PFailed{SessionID: sb.SessionID, Reason: "ice failed"})
	wa.expectWhere(protocol.OpVoiceSession, &sa, func() bool { return sa.Mode == "sfu" })
	wb.expectWhere(protocol.OpVoiceSession, &sb, func() bool { return sb.Mode == "sfu" })

	// Voice state is visible to everyone, including people outside the channel.
	wa.send(protocol.OpVoiceState, protocol.VoiceStateChange{SelfMute: true})
	var vs protocol.VoiceState
	wc.expectWhere(protocol.OpVoiceStateUpdate, &vs, func() bool { return vs.UserID == ana.user.ID && vs.SelfMute })
}

func contents(ms []protocol.Message) []string {
	out := make([]string, len(ms))
	for i, m := range ms {
		out[i] = m.Content
	}
	return out
}

func statusOf(ms []protocol.Member, id string) string {
	for _, m := range ms {
		if m.ID == id {
			return m.Status
		}
	}
	return ""
}

// LiveKit participant_left without a voice_leave removes the user after the grace period.
func TestLiveKitWebhook(t *testing.T) {
	e := newEnv(t)
	ana := e.mustLogin("ana@test", "")
	bruno := e.mustLogin("bruno@test", e.invite(ana))
	carla := e.mustLogin("carla@test", e.invite(ana))
	var vc protocol.Channel
	ana.call("POST", "/v1/channels", map[string]string{"kind": "voice", "name": "Sala"}, &vc)
	wa, wb, wc := ana.connect(true), bruno.connect(true), carla.connect(true)
	for _, w := range []*ws{wa, wb, wc} {
		w.send(protocol.OpVoiceJoin, map[string]any{"channel_id": vc.ID})
	}
	var s protocol.VoiceSession
	wa.expectWhere(protocol.OpVoiceSession, &s, func() bool { return s.Mode == "sfu" })

	post := func(secret, event string) int {
		body, _ := json.Marshal(map[string]any{
			"event":       event,
			"room":        map[string]string{"name": vc.ID},
			"participant": map[string]string{"identity": carla.user.ID},
		})
		sum := sha256.Sum256(body)
		tok, _ := lkauth.NewAccessToken("devkey", secret).SetSha256(base64.StdEncoding.EncodeToString(sum[:])).SetValidFor(time.Minute).ToJWT()
		req, _ := http.NewRequest("POST", e.srv.URL+"/v1/livekit/webhook", bytes.NewReader(body))
		req.Header.Set("Authorization", tok)
		req.Header.Set("Content-Type", "application/webhook+json")
		res, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		res.Body.Close()
		return res.StatusCode
	}
	if st := post("wrong-secret-0123456789abcdef0123456789", "participant_left"); st != http.StatusUnauthorized {
		t.Fatalf("unsigned webhook accepted: %d", st)
	}
	if st := post("devsecret-0123456789abcdef0123456789", "participant_left"); st != http.StatusNoContent {
		t.Fatalf("webhook: %d", st)
	}
	var vs protocol.VoiceState
	wa.expectWhere(protocol.OpVoiceStateUpdate, &vs, func() bool { return vs.UserID == carla.user.ID && vs.ChannelID == nil })
}
