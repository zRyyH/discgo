-- name: CreateSession :exec
insert into sessions (id, user_id, token_hash, expires_at) values ($1, $2, $3, $4);

-- name: GetSessionUser :one
select sqlc.embed(sessions), sqlc.embed(users)
from sessions join users on users.id = sessions.user_id
where sessions.token_hash = $1 and sessions.expires_at > now();

-- name: TouchSession :exec
update sessions set last_used_at = now() where id = $1;

-- name: DeleteSession :exec
delete from sessions where token_hash = $1;

-- name: DeleteExpiredSessions :execrows
delete from sessions where expires_at <= now();
