package protocol

import (
	"encoding/json"
	"flag"
	"os"
	"path/filepath"
	"testing"
	"time"
)

var update = flag.Bool("update", false, "rewrite testdata/*.json")

// The fixtures are the wire contract with desktop/src/shared/protocol.ts:
// a change here is a protocol change (PLAN 0, section 13).
func TestContractFixtures(t *testing.T) {
	ch := "0192f5d2-7c1e-7a10-9f00-00000000c001"
	edited := time.Date(2026, 10, 29, 18, 5, 0, 0, time.UTC)
	w, h := 640, 480
	fixtures := map[string]any{
		"ready": NewFrame(OpReady, Ready{
			User:      Me{User: User{ID: "0192f5d2-7c1e-7a10-9f00-0000000000a1", Username: "ana.silva", DisplayName: "Ana", AvatarURL: "", Role: "admin"}, Email: "ana.silva@gmail.com"},
			Community: Community{Name: "DiscGo"},
			Members: []Member{
				{User: User{ID: "0192f5d2-7c1e-7a10-9f00-0000000000a1", Username: "ana.silva", DisplayName: "Ana", Role: "admin"}, Status: "online"},
				{User: User{ID: "0192f5d2-7c1e-7a10-9f00-0000000000b2", Username: "bruno", DisplayName: "Bruno", Role: "member"}, Status: "offline"},
			},
			Channels:      []Channel{{ID: ch, Kind: "voice", Name: "Sala", Position: 0}},
			VoiceStates:   []VoiceState{{UserID: "0192f5d2-7c1e-7a10-9f00-0000000000a1", ChannelID: &ch, SelfMute: true}},
			VoiceSession:  &VoiceSession{ChannelID: ch, SessionID: "0192f5d2-7c1e-7a10-9f00-00000000s001", Mode: "idle"},
			Relationships: []Relationship{{User: User{ID: "0192f5d2-7c1e-7a10-9f00-0000000000b2", Username: "bruno", DisplayName: "Bruno", Role: "member"}, Type: "incoming", Since: edited}},
		}),
		"relationship_remove": NewFrame(OpRelationshipRemove, RelationshipRemove{UserID: "0192f5d2-7c1e-7a10-9f00-0000000000b2"}),
		"app_update":          NewFrame(OpAppUpdate, AppUpdate{Version: "0.2.0", Notes: "Correções"}),
		"message_create": NewFrame(OpMessageCreate, Message{
			ID: "0192f5d2-7c1e-7a10-9f00-00000000m001", ChannelID: ch, AuthorID: "0192f5d2-7c1e-7a10-9f00-0000000000a1",
			Content: "oi", CreatedAt: time.Date(2026, 10, 29, 18, 0, 0, 0, time.UTC), EditedAt: &edited,
			Attachments: []Attachment{{Key: "att/u/1/foto.png", Name: "foto.png", ContentType: "image/png", Size: 1234, Width: &w, Height: &h, URL: "https://s3/..."}},
		}),
		"voice_session_p2p": NewFrame(OpVoiceSession, VoiceSession{
			ChannelID: ch, SessionID: "0192f5d2-7c1e-7a10-9f00-00000000s002", Mode: "p2p",
			PeerUserID: "0192f5d2-7c1e-7a10-9f00-0000000000b2", Polite: true,
		}),
		"voice_session_sfu": NewFrame(OpVoiceSession, VoiceSession{
			ChannelID: ch, SessionID: "0192f5d2-7c1e-7a10-9f00-00000000s003", Mode: "sfu", LiveKitURL: "wss://lk.example.com",
		}),
		"voice_state_left": NewFrame(OpVoiceStateUpdate, VoiceState{UserID: "0192f5d2-7c1e-7a10-9f00-0000000000b2"}),
		"rtc_signal": NewFrame(OpRTCSignal, RTCSignal{
			SessionID: "0192f5d2-7c1e-7a10-9f00-00000000s002", FromUserID: "0192f5d2-7c1e-7a10-9f00-0000000000a1",
			Stream: "screen", Type: "offer", Payload: json.RawMessage(`{"sdp":"v=0\r\n"}`),
		}),
	}
	for name, v := range fixtures {
		got, err := json.MarshalIndent(v, "", "  ")
		if err != nil {
			t.Fatal(err)
		}
		got = append(got, '\n')
		path := filepath.Join("testdata", name+".json")
		if *update {
			if err := os.WriteFile(path, got, 0o644); err != nil {
				t.Fatal(err)
			}
			continue
		}
		want, err := os.ReadFile(path)
		if err != nil {
			t.Fatalf("%s: %v (run go test ./internal/protocol -update)", path, err)
		}
		if string(want) != string(got) {
			t.Errorf("%s changed:\n%s\nwant:\n%s", path, got, want)
		}
	}
}
