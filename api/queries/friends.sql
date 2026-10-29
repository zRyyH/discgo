-- name: LockFriends :exec
-- Serializes friendship changes, so crossing requests cannot both stay pending.
select pg_advisory_xact_lock(7461002);

-- name: ListRelationships :many
-- Friends and pending requests of a user, seen from that user.
select sqlc.embed(users), r.kind, r.since
from (
    select friend_id as other_id, 'friend'::text as kind, created_at as since from friends where user_id = $1
    union all
    select to_id, 'outgoing'::text, created_at from friend_requests where from_id = $1
    union all
    select from_id, 'incoming'::text, created_at from friend_requests where to_id = $1
) r
join users on users.id = r.other_id
order by r.since, users.id;

-- name: AreFriends :one
select exists(select 1 from friends where user_id = $1 and friend_id = $2);

-- name: FriendRequestExists :one
select exists(select 1 from friend_requests where from_id = $1 and to_id = $2);

-- name: CreateFriendRequest :one
insert into friend_requests (from_id, to_id) values ($1, $2) returning created_at;

-- name: DeleteFriendRequest :execrows
delete from friend_requests where from_id = $1 and to_id = $2;

-- name: CreateFriendship :one
insert into friends (user_id, friend_id) values ($1, $2), ($2, $1) returning created_at;

-- name: DeleteFriendship :execrows
delete from friends where (user_id = $1 and friend_id = $2) or (user_id = $2 and friend_id = $1);
