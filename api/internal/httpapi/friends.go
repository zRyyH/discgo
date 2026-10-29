package httpapi

// Friends: a request goes to a username (the Gmail address without
// "@gmail.com") and becomes a friendship when the other side accepts. Both users
// get relationship_add / relationship_remove over the gateway.

import (
	"errors"
	"net/http"
	"time"

	"github.com/jackc/pgx/v5"

	"discgo/api/internal/auth"
	"discgo/api/internal/db"
	"discgo/api/internal/protocol"
)

// apiError is a refusal decided inside a transaction.
type apiError struct {
	status  int
	code    string
	message string
}

func (e *apiError) Error() string { return e.message }

var (
	errNoSuchUser       = &apiError{http.StatusNotFound, "user_not_found", "no user with this username"}
	errSelfRequest      = &apiError{http.StatusBadRequest, "self_request", "you cannot add yourself"}
	errAlreadyFriends   = &apiError{http.StatusConflict, "already_friends", "already friends"}
	errAlreadyRequested = &apiError{http.StatusConflict, "already_requested", "friend request already sent"}
	errNoRequest        = &apiError{http.StatusNotFound, "no_request", "no friend request from this user"}
	errNoRelationship   = &apiError{http.StatusNotFound, "not_found", "no friend or request with this user"}
)

func (s *Server) listFriends(w http.ResponseWriter, r *http.Request) {
	rels, err := s.Queries.ListRelationships(r.Context(), currentUser(r).ID)
	if err != nil {
		s.internal(w, r, err)
		return
	}
	out := make([]protocol.Relationship, 0, len(rels))
	for _, rel := range rels {
		out = append(out, protocol.FromRelationship(rel.User, rel.Kind, rel.Since))
	}
	writeJSON(w, http.StatusOK, out)
}

// addFriend sends a request to a username, or accepts the one that user
// already sent us.
func (s *Server) addFriend(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Username string `json:"username"`
	}
	if !decode(w, r, &body) {
		return
	}
	key := auth.UsernameKey(body.Username)
	if key == "" {
		writeError(w, http.StatusBadRequest, "bad_request", "username is required")
		return
	}
	me := currentUser(r)
	var other db.User
	var kind string
	var since time.Time
	err := s.friendTx(r, func(q *db.Queries) error {
		var err error
		other, err = q.GetUserByUsernameKey(r.Context(), key)
		if errors.Is(err, pgx.ErrNoRows) {
			return errNoSuchUser
		}
		if err != nil {
			return err
		}
		if other.ID == me.ID {
			return errSelfRequest
		}
		if friends, err := q.AreFriends(r.Context(), db.AreFriendsParams{UserID: me.ID, FriendID: other.ID}); err != nil {
			return err
		} else if friends {
			return errAlreadyFriends
		}
		if sent, err := q.FriendRequestExists(r.Context(), db.FriendRequestExistsParams{FromID: me.ID, ToID: other.ID}); err != nil {
			return err
		} else if sent {
			return errAlreadyRequested
		}
		theirs, err := q.DeleteFriendRequest(r.Context(), db.DeleteFriendRequestParams{FromID: other.ID, ToID: me.ID})
		if err != nil {
			return err
		}
		if theirs > 0 {
			kind = "friend"
			since, err = q.CreateFriendship(r.Context(), db.CreateFriendshipParams{UserID: me.ID, FriendID: other.ID})
			return err
		}
		kind = "outgoing"
		since, err = q.CreateFriendRequest(r.Context(), db.CreateFriendRequestParams{FromID: me.ID, ToID: other.ID})
		return err
	})
	if s.friendError(w, r, err) {
		return
	}
	s.pushRelationship(me, other, kind, since)
	status := http.StatusCreated
	if kind == "friend" {
		status = http.StatusOK
	}
	writeJSON(w, status, protocol.FromRelationship(other, kind, since))
}

// acceptFriend accepts the request the user {id} sent us.
func (s *Server) acceptFriend(w http.ResponseWriter, r *http.Request) {
	id, ok := pathID(w, r)
	if !ok {
		return
	}
	me := currentUser(r)
	var other db.User
	var since time.Time
	err := s.friendTx(r, func(q *db.Queries) error {
		n, err := q.DeleteFriendRequest(r.Context(), db.DeleteFriendRequestParams{FromID: id, ToID: me.ID})
		if err != nil {
			return err
		}
		if n == 0 {
			return errNoRequest
		}
		if since, err = q.CreateFriendship(r.Context(), db.CreateFriendshipParams{UserID: me.ID, FriendID: id}); err != nil {
			return err
		}
		other, err = q.GetUser(r.Context(), id)
		return err
	})
	if s.friendError(w, r, err) {
		return
	}
	s.pushRelationship(me, other, "friend", since)
	writeJSON(w, http.StatusOK, protocol.FromRelationship(other, "friend", since))
}

// removeFriend ends a friendship, declines a request we got or cancels one we
// sent, whichever exists with the user {id}.
func (s *Server) removeFriend(w http.ResponseWriter, r *http.Request) {
	id, ok := pathID(w, r)
	if !ok {
		return
	}
	me := currentUser(r)
	err := s.friendTx(r, func(q *db.Queries) error {
		var total int64
		for _, del := range []func() (int64, error){
			func() (int64, error) {
				return q.DeleteFriendship(r.Context(), db.DeleteFriendshipParams{UserID: me.ID, FriendID: id})
			},
			func() (int64, error) {
				return q.DeleteFriendRequest(r.Context(), db.DeleteFriendRequestParams{FromID: me.ID, ToID: id})
			},
			func() (int64, error) {
				return q.DeleteFriendRequest(r.Context(), db.DeleteFriendRequestParams{FromID: id, ToID: me.ID})
			},
		} {
			n, err := del()
			if err != nil {
				return err
			}
			total += n
		}
		if total == 0 {
			return errNoRelationship
		}
		return nil
	})
	if s.friendError(w, r, err) {
		return
	}
	s.Hub.SendToUser(me.ID, protocol.OpRelationshipRemove, protocol.RelationshipRemove{UserID: id.String()})
	s.Hub.SendToUser(id, protocol.OpRelationshipRemove, protocol.RelationshipRemove{UserID: me.ID.String()})
	w.WriteHeader(http.StatusNoContent)
}

// friendTx runs fn in a transaction that holds the friendship lock, so two
// requests crossing each other end as one friendship.
func (s *Server) friendTx(r *http.Request, fn func(q *db.Queries) error) error {
	return pgx.BeginFunc(r.Context(), s.Pool, func(tx pgx.Tx) error {
		q := s.Queries.WithTx(tx)
		if err := q.LockFriends(r.Context()); err != nil {
			return err
		}
		return fn(q)
	})
}

// friendError writes the response for a failed friend change; false when err is nil.
func (s *Server) friendError(w http.ResponseWriter, r *http.Request, err error) bool {
	var ae *apiError
	switch {
	case err == nil:
		return false
	case errors.As(err, &ae):
		writeError(w, ae.status, ae.code, ae.message)
	default:
		s.internal(w, r, err)
	}
	return true
}

// pushRelationship tells both users about their new relationship; kind is
// how it looks from me.
func (s *Server) pushRelationship(me, other db.User, kind string, since time.Time) {
	mirror := map[string]string{"friend": "friend", "outgoing": "incoming", "incoming": "outgoing"}[kind]
	s.Hub.SendToUser(me.ID, protocol.OpRelationshipAdd, protocol.FromRelationship(other, kind, since))
	s.Hub.SendToUser(other.ID, protocol.OpRelationshipAdd, protocol.FromRelationship(me, mirror, since))
}
