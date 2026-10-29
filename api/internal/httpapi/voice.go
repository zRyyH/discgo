package httpapi

import (
	"net/http"

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
