// Package protocol holds the JSON shapes shared by REST and the gateway
// (PLAN 5.2, 5.3). Mirror of desktop/src/shared/protocol.ts — keep both in sync;
// testdata/*.json are the contract fixtures both sides are checked against.
package protocol

import (
	"encoding/json"
	"time"

	"github.com/google/uuid"

	"discgo/api/internal/db"
)

type User struct {
	ID string `json:"id"`
	// The Gmail address without "@gmail.com" (whole address for other domains).
	Username    string `json:"username"`
	DisplayName string `json:"display_name"`
	AvatarURL   string `json:"avatar_url"`
	Role        string `json:"role"`
}

// Me is the authenticated user, with private fields.
type Me struct {
	User
	Email string `json:"email"`
}

type Member struct {
	User
	Status string `json:"status"` // "online" | "offline"
}

type Channel struct {
	ID       string `json:"id"`
	Kind     string `json:"kind"` // "text" | "voice"
	Name     string `json:"name"`
	Position int32  `json:"position"`
}

type Attachment struct {
	Key         string `json:"key"`
	Name        string `json:"name"`
	ContentType string `json:"content_type"`
	Size        int64  `json:"size"`
	Width       *int   `json:"width,omitempty"`
	Height      *int   `json:"height,omitempty"`
	// Pre-signed GET URL, filled in responses only.
	URL string `json:"url,omitempty"`
}

type Message struct {
	ID          string       `json:"id"`
	ChannelID   string       `json:"channel_id"`
	AuthorID    string       `json:"author_id"`
	Content     string       `json:"content"`
	Attachments []Attachment `json:"attachments"`
	CreatedAt   time.Time    `json:"created_at"`
	EditedAt    *time.Time   `json:"edited_at"`
}

// Relationship is a friend or a pending friend request, seen from the user who
// receives it.
type Relationship struct {
	User  User      `json:"user"`
	Type  string    `json:"type"` // "friend" | "incoming" | "outgoing"
	Since time.Time `json:"since"`
}

type RelationshipRemove struct {
	UserID string `json:"user_id"`
}

type VoiceState struct {
	UserID    string  `json:"user_id"`
	ChannelID *string `json:"channel_id"` // null when the user left voice
	SelfMute  bool    `json:"self_mute"`
	SelfDeaf  bool    `json:"self_deaf"`
}

// VoiceSession tells a participant how to carry media for its channel (PLAN 3.2).
// Mode "idle" (alone in the channel) means: connect to nothing yet.
type VoiceSession struct {
	ChannelID  string `json:"channel_id"`
	SessionID  string `json:"session_id"`
	Mode       string `json:"mode"` // "idle" | "p2p" | "sfu"
	PeerUserID string `json:"peer_user_id,omitempty"`
	// In p2p: true for the peer with the smaller user id (perfect negotiation).
	Polite     bool   `json:"polite,omitempty"`
	LiveKitURL string `json:"livekit_url,omitempty"`
}

type RTCSignal struct {
	SessionID  string          `json:"session_id"`
	ToUserID   string          `json:"to_user_id,omitempty"`
	FromUserID string          `json:"from_user_id,omitempty"`
	Stream     string          `json:"stream"` // "av" | "screen"
	Type       string          `json:"type"`   // "offer" | "answer" | "ice"
	Payload    json.RawMessage `json:"payload"`
}

type Community struct {
	Name string `json:"name"`
}

// AppUpdate tells an older app that a new version is published (PLAN fase 9A).
// The app downloads it through its own signed updater; this is only the trigger.
type AppUpdate struct {
	Version string `json:"version"`
	Notes   string `json:"notes"`
}

type Ready struct {
	User         Me            `json:"user"`
	Community    Community     `json:"community"`
	Members      []Member      `json:"members"`
	Channels     []Channel     `json:"channels"`
	VoiceStates  []VoiceState  `json:"voice_states"`
	VoiceSession *VoiceSession `json:"voice_session"`
	// Only the receiving user's friends and pending requests.
	Relationships []Relationship `json:"relationships"`
}

// Frame is one gateway message in either direction.
type Frame struct {
	Op string          `json:"op"`
	D  json.RawMessage `json:"d,omitempty"`
}

// Gateway ops, server -> client.
const (
	OpReady            = "ready"
	OpMessageCreate    = "message_create"
	OpMessageUpdate    = "message_update"
	OpMessageDelete    = "message_delete"
	OpChannelCreate    = "channel_create"
	OpChannelUpdate    = "channel_update"
	OpChannelDelete    = "channel_delete"
	OpMemberAdd        = "member_add"
	OpMemberUpdate     = "member_update"
	OpPresenceUpdate   = "presence_update"
	OpVoiceStateUpdate = "voice_state_update"
	OpVoiceSession     = "voice_session"
	OpRTCSignal        = "rtc_signal"
	// A friend or request was added or changed type; sent only to the two users.
	OpRelationshipAdd    = "relationship_add"
	OpRelationshipRemove = "relationship_remove"
	// Sent to connections whose client version is older than the published one.
	OpAppUpdate = "app_update"
	OpError     = "error"
)

// Gateway ops, client -> server.
const (
	OpIdentify   = "identify"
	OpVoiceJoin  = "voice_join"
	OpVoiceLeave = "voice_leave"
	OpVoiceState = "voice_state"
	OpP2PFailed  = "p2p_failed"
	OpPing       = "ping"
	OpPong       = "pong"
)

type Identify struct {
	Token  string `json:"token"`
	Client struct {
		Version string `json:"version"`
		P2P     bool   `json:"p2p"`
	} `json:"client"`
}

type VoiceJoin struct {
	ChannelID string `json:"channel_id"`
	SelfMute  bool   `json:"self_mute"`
	SelfDeaf  bool   `json:"self_deaf"`
	// The session the client still has media for when it rejoins after a gateway
	// reconnect; empty after an app start (e.g. an update restart).
	SessionID string `json:"session_id,omitempty"`
}

type VoiceStateChange struct {
	SelfMute bool `json:"self_mute"`
	SelfDeaf bool `json:"self_deaf"`
}

type P2PFailed struct {
	SessionID string `json:"session_id"`
	Reason    string `json:"reason"`
}

type PresenceUpdate struct {
	UserID string `json:"user_id"`
	Status string `json:"status"`
}

type MessageDelete struct {
	ID        string `json:"id"`
	ChannelID string `json:"channel_id"`
}

type ChannelDelete struct {
	ID string `json:"id"`
}

type Error struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

func NewFrame(op string, d any) Frame {
	raw, err := json.Marshal(d)
	if err != nil {
		panic(err) // only our own types are marshalled
	}
	return Frame{Op: op, D: raw}
}

func FromUser(u db.User) User {
	return User{ID: u.ID.String(), Username: u.Username, DisplayName: u.DisplayName, AvatarURL: u.AvatarUrl, Role: u.Role}
}

func FromMe(u db.User) Me {
	return Me{User: FromUser(u), Email: u.Email}
}

func FromChannel(c db.Channel) Channel {
	return Channel{ID: c.ID.String(), Kind: c.Kind, Name: c.Name, Position: c.Position}
}

func FromRelationship(u db.User, kind string, since time.Time) Relationship {
	return Relationship{User: FromUser(u), Type: kind, Since: since.UTC()}
}

// FromMessage converts a row; sign turns attachment keys into download URLs.
func FromMessage(m db.Message, sign func(key string) string) (Message, error) {
	out := Message{
		ID:          m.ID.String(),
		ChannelID:   m.ChannelID.String(),
		AuthorID:    m.AuthorID.String(),
		Content:     m.Content,
		Attachments: []Attachment{},
		CreatedAt:   m.CreatedAt.UTC(),
		EditedAt:    utcPtr(m.EditedAt),
	}
	if err := json.Unmarshal(m.Attachments, &out.Attachments); err != nil {
		return out, err
	}
	for i := range out.Attachments {
		out.Attachments[i].URL = sign(out.Attachments[i].Key)
	}
	return out, nil
}

func ChannelIDPtr(id uuid.UUID) *string {
	s := id.String()
	return &s
}

func utcPtr(t *time.Time) *time.Time {
	if t == nil {
		return nil
	}
	u := t.UTC()
	return &u
}
