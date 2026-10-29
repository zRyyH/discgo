// Package livekit mints access tokens for the SFU (PLAN 5.2). The room is the
// voice channel id; a screen share publishes as a second identity
// "{user_id}#screen" that cannot subscribe and names its owner in metadata.
package livekit

import (
	"encoding/json"
	"errors"
	"time"

	lkauth "github.com/livekit/protocol/auth"
)

const tokenTTL = 6 * time.Hour

type Issuer struct {
	key, secret string
}

func NewIssuer(key, secret string) *Issuer {
	return &Issuer{key: key, secret: secret}
}

// Token returns a join token; kind is "user" or "screen".
func (i *Issuer) Token(room, userID, name, kind string) (string, error) {
	if i.key == "" || i.secret == "" {
		return "", errors.New("livekit is not configured")
	}
	grant := &lkauth.VideoGrant{RoomJoin: true, Room: room}
	identity := userID
	meta, _ := json.Marshal(map[string]string{"owner": userID, "kind": kind})
	if kind == "screen" {
		identity = userID + "#screen"
		grant.SetCanSubscribe(false)
		grant.SetCanPublishData(false)
	}
	return lkauth.NewAccessToken(i.key, i.secret).
		SetVideoGrant(grant).
		SetIdentity(identity).
		SetName(name).
		SetMetadata(string(meta)).
		SetValidFor(tokenTTL).
		ToJWT()
}
