package httpapi

import (
	"encoding/json"
	"net/http"
	"strconv"
	"strings"
	"unicode/utf8"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgtype"

	"discgo/api/internal/db"
	"discgo/api/internal/protocol"
	"discgo/api/internal/storage"
)

const (
	maxContentRunes = 4000
	maxAttachments  = 10
	defaultPage     = 50
	maxPage         = 100
)

func (s *Server) listChannels(w http.ResponseWriter, r *http.Request) {
	chs, err := s.Queries.ListChannels(r.Context())
	if err != nil {
		s.internal(w, r, err)
		return
	}
	out := make([]protocol.Channel, 0, len(chs))
	for _, c := range chs {
		out = append(out, protocol.FromChannel(c))
	}
	writeJSON(w, http.StatusOK, out)
}

func (s *Server) createChannel(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Kind string `json:"kind"`
		Name string `json:"name"`
	}
	if !decode(w, r, &body) {
		return
	}
	name, ok := channelName(w, body.Name)
	if !ok {
		return
	}
	if body.Kind != "text" && body.Kind != "voice" {
		writeError(w, http.StatusBadRequest, "bad_request", `kind must be "text" or "voice"`)
		return
	}
	ch, err := s.Queries.CreateChannel(r.Context(), db.CreateChannelParams{ID: uuid.Must(uuid.NewV7()), Kind: body.Kind, Name: name})
	if err != nil {
		s.internal(w, r, err)
		return
	}
	s.Hub.Broadcast(protocol.OpChannelCreate, protocol.FromChannel(ch))
	writeJSON(w, http.StatusCreated, protocol.FromChannel(ch))
}

func (s *Server) updateChannel(w http.ResponseWriter, r *http.Request) {
	id, ok := pathID(w, r)
	if !ok {
		return
	}
	var body struct {
		Name     *string `json:"name"`
		Position *int32  `json:"position"`
	}
	if !decode(w, r, &body) {
		return
	}
	params := db.UpdateChannelParams{ID: id}
	if body.Name != nil {
		name, ok := channelName(w, *body.Name)
		if !ok {
			return
		}
		params.Name = pgtype.Text{String: name, Valid: true}
	}
	if body.Position != nil {
		params.Position = pgtype.Int4{Int32: *body.Position, Valid: true}
	}
	ch, err := s.Queries.UpdateChannel(r.Context(), params)
	if err != nil {
		s.notFoundOr(w, r, err, "channel")
		return
	}
	s.Hub.Broadcast(protocol.OpChannelUpdate, protocol.FromChannel(ch))
	writeJSON(w, http.StatusOK, protocol.FromChannel(ch))
}

func (s *Server) deleteChannel(w http.ResponseWriter, r *http.Request) {
	id, ok := pathID(w, r)
	if !ok {
		return
	}
	n, err := s.Queries.DeleteChannel(r.Context(), id)
	if err != nil {
		s.internal(w, r, err)
		return
	}
	if n == 0 {
		writeError(w, http.StatusNotFound, "not_found", "channel not found")
		return
	}
	s.Voice.ChannelRemoved(id)
	s.Hub.Broadcast(protocol.OpChannelDelete, protocol.ChannelDelete{ID: id.String()})
	w.WriteHeader(http.StatusNoContent)
}

func channelName(w http.ResponseWriter, name string) (string, bool) {
	name = strings.TrimSpace(name)
	if n := utf8.RuneCountInString(name); n < 1 || n > 100 {
		writeError(w, http.StatusBadRequest, "bad_request", "name must have 1 to 100 characters")
		return "", false
	}
	return name, true
}

// textChannel loads the {id} channel and checks it accepts messages.
func (s *Server) textChannel(w http.ResponseWriter, r *http.Request) (db.Channel, bool) {
	id, ok := pathID(w, r)
	if !ok {
		return db.Channel{}, false
	}
	ch, err := s.Queries.GetChannel(r.Context(), id)
	if err != nil {
		s.notFoundOr(w, r, err, "channel")
		return db.Channel{}, false
	}
	if ch.Kind != "text" {
		writeError(w, http.StatusBadRequest, "bad_request", "not a text channel")
		return db.Channel{}, false
	}
	return ch, true
}

func (s *Server) listMessages(w http.ResponseWriter, r *http.Request) {
	ch, ok := s.textChannel(w, r)
	if !ok {
		return
	}
	params := db.ListMessagesParams{ChannelID: ch.ID, Limit: defaultPage}
	if v := r.URL.Query().Get("limit"); v != "" {
		n, err := strconv.Atoi(v)
		if err != nil || n < 1 || n > maxPage {
			writeError(w, http.StatusBadRequest, "bad_request", "limit must be 1 to 100")
			return
		}
		params.Limit = int32(n)
	}
	if v := r.URL.Query().Get("before"); v != "" {
		before, err := uuid.Parse(v)
		if err != nil {
			writeError(w, http.StatusBadRequest, "bad_request", "invalid before")
			return
		}
		params.Before = uuid.NullUUID{UUID: before, Valid: true}
	}
	rows, err := s.Queries.ListMessages(r.Context(), params)
	if err != nil {
		s.internal(w, r, err)
		return
	}
	out := make([]protocol.Message, 0, len(rows))
	for _, m := range rows {
		pm, err := protocol.FromMessage(m, s.Storage.PresignGet)
		if err != nil {
			s.internal(w, r, err)
			return
		}
		out = append(out, pm)
	}
	writeJSON(w, http.StatusOK, out)
}

func (s *Server) createMessage(w http.ResponseWriter, r *http.Request) {
	ch, ok := s.textChannel(w, r)
	if !ok {
		return
	}
	user := currentUser(r)
	var body struct {
		Content     string                `json:"content"`
		Attachments []protocol.Attachment `json:"attachments"`
	}
	if !decode(w, r, &body) {
		return
	}
	body.Content = strings.TrimSpace(body.Content)
	if !validContent(w, body.Content, len(body.Attachments) > 0) {
		return
	}
	if len(body.Attachments) > maxAttachments {
		writeError(w, http.StatusBadRequest, "bad_request", "at most 10 attachments")
		return
	}
	for i, a := range body.Attachments {
		if !strings.HasPrefix(a.Key, storage.KeyPrefix(user.ID)) || a.Size < 0 || a.Size > s.MaxUploadBytes {
			writeError(w, http.StatusBadRequest, "bad_request", "invalid attachment "+strconv.Itoa(i))
			return
		}
		body.Attachments[i].URL = ""
	}
	if body.Attachments == nil {
		body.Attachments = []protocol.Attachment{}
	}
	atts, _ := json.Marshal(body.Attachments)
	m, err := s.Queries.CreateMessage(r.Context(), db.CreateMessageParams{
		ID: uuid.Must(uuid.NewV7()), ChannelID: ch.ID, AuthorID: user.ID, Content: body.Content, Attachments: atts,
	})
	if err != nil {
		s.internal(w, r, err)
		return
	}
	pm, err := protocol.FromMessage(m, s.Storage.PresignGet)
	if err != nil {
		s.internal(w, r, err)
		return
	}
	s.Hub.Broadcast(protocol.OpMessageCreate, pm)
	writeJSON(w, http.StatusCreated, pm)
}

func validContent(w http.ResponseWriter, content string, hasAttachments bool) bool {
	if content == "" && !hasAttachments {
		writeError(w, http.StatusBadRequest, "bad_request", "message is empty")
		return false
	}
	if utf8.RuneCountInString(content) > maxContentRunes {
		writeError(w, http.StatusBadRequest, "bad_request", "message longer than 4000 characters")
		return false
	}
	return true
}

// ownMessage loads the {id} message and checks the caller wrote it.
func (s *Server) ownMessage(w http.ResponseWriter, r *http.Request) (db.Message, bool) {
	id, ok := pathID(w, r)
	if !ok {
		return db.Message{}, false
	}
	m, err := s.Queries.GetMessage(r.Context(), id)
	if err != nil {
		s.notFoundOr(w, r, err, "message")
		return db.Message{}, false
	}
	if m.AuthorID != currentUser(r).ID {
		writeError(w, http.StatusForbidden, "forbidden", "only the author can change this message")
		return db.Message{}, false
	}
	return m, true
}

func (s *Server) updateMessage(w http.ResponseWriter, r *http.Request) {
	m, ok := s.ownMessage(w, r)
	if !ok {
		return
	}
	var body struct {
		Content string `json:"content"`
	}
	if !decode(w, r, &body) {
		return
	}
	body.Content = strings.TrimSpace(body.Content)
	if !validContent(w, body.Content, string(m.Attachments) != "[]") {
		return
	}
	m, err := s.Queries.UpdateMessageContent(r.Context(), db.UpdateMessageContentParams{ID: m.ID, Content: body.Content})
	if err != nil {
		s.internal(w, r, err)
		return
	}
	pm, err := protocol.FromMessage(m, s.Storage.PresignGet)
	if err != nil {
		s.internal(w, r, err)
		return
	}
	s.Hub.Broadcast(protocol.OpMessageUpdate, pm)
	writeJSON(w, http.StatusOK, pm)
}

func (s *Server) deleteMessage(w http.ResponseWriter, r *http.Request) {
	m, ok := s.ownMessage(w, r)
	if !ok {
		return
	}
	if _, err := s.Queries.DeleteMessage(r.Context(), m.ID); err != nil {
		s.internal(w, r, err)
		return
	}
	s.Hub.Broadcast(protocol.OpMessageDelete, protocol.MessageDelete{ID: m.ID.String(), ChannelID: m.ChannelID.String()})
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) presignUpload(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Name        string `json:"name"`
		ContentType string `json:"content_type"`
		Size        int64  `json:"size"`
	}
	if !decode(w, r, &body) {
		return
	}
	if body.Size < 1 || body.Size > s.MaxUploadBytes {
		writeError(w, http.StatusBadRequest, "too_large", "file must be 1 byte to "+strconv.FormatInt(s.MaxUploadBytes>>20, 10)+" MB")
		return
	}
	if body.ContentType == "" {
		body.ContentType = "application/octet-stream"
	}
	key, url, err := s.Storage.PresignPut(r.Context(), currentUser(r).ID, body.Name, body.ContentType, body.Size)
	if err != nil {
		s.internal(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"key":     key,
		"url":     url,
		"method":  http.MethodPut,
		"headers": map[string]string{"Content-Type": body.ContentType},
	})
}
