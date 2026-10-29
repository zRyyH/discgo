package httpapi

import (
	"net/http"
	"strings"

	"github.com/google/uuid"
	"github.com/livekit/protocol/webhook"

	"discgo/api/internal/voice"
)

func (s *Server) iceServers(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{
		"ice_servers": []map[string]any{{"urls": s.STUNURLs}},
	})
}

// voiceToken issues a LiveKit token for the caller's current voice channel,
// only while that channel is in sfu mode.
func (s *Server) voiceToken(w http.ResponseWriter, r *http.Request) {
	id, ok := pathID(w, r)
	if !ok {
		return
	}
	kind := r.URL.Query().Get("kind")
	if kind == "" {
		kind = "user"
	}
	if kind != "user" && kind != "screen" {
		writeError(w, http.StatusBadRequest, "bad_request", `kind must be "user" or "screen"`)
		return
	}
	user := currentUser(r)
	channelID, mode, inVoice := s.Voice.Current(user.ID)
	if !inVoice || channelID != id {
		writeError(w, http.StatusForbidden, "not_in_voice", "join the voice channel first")
		return
	}
	if mode != voice.SFU {
		writeError(w, http.StatusConflict, "not_sfu", "this channel is not using the SFU right now")
		return
	}
	token, err := s.LiveKit.Token(id.String(), user.ID.String(), user.DisplayName, kind)
	if err != nil {
		s.internal(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"token": token})
}

// livekitWebhook receives LiveKit room events (PLAN 5.3), signed with the API key.
// They only confirm voice state: the gateway stays the source of truth.
func (s *Server) livekitWebhook(w http.ResponseWriter, r *http.Request) {
	if s.LiveKitKeys == nil {
		writeError(w, http.StatusNotFound, "not_found", "not found")
		return
	}
	ev, err := webhook.ReceiveWebhookEvent(r, s.LiveKitKeys)
	if err != nil {
		writeError(w, http.StatusUnauthorized, "bad_signature", err.Error())
		return
	}
	if ev.Participant == nil || ev.Room == nil || strings.HasSuffix(ev.Participant.Identity, "#screen") {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	userID, err1 := uuid.Parse(ev.Participant.Identity)
	channelID, err2 := uuid.Parse(ev.Room.Name)
	if err1 == nil && err2 == nil {
		switch ev.Event {
		case webhook.EventParticipantJoined:
			s.Voice.SFUJoined(userID, channelID)
		case webhook.EventParticipantLeft:
			s.Voice.SFULeft(userID, channelID)
		}
	}
	w.WriteHeader(http.StatusNoContent)
}
