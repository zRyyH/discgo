-- name: GetUser :one
select * from users where id = $1;

-- name: GetUserByGoogleSub :one
select * from users where google_sub = $1;

-- name: GetUserByUsernameKey :one
select * from users where username_key = $1;

-- name: UsernameKeyExists :one
select exists(select 1 from users where username_key = $1);

-- name: ListUsers :many
select * from users order by display_name, id;

-- name: CountUsers :one
select count(*) from users;

-- name: CreateUser :one
insert into users (id, google_sub, email, display_name, avatar_url, role, username, username_key)
values ($1, $2, $3, $4, $5, $6, $7, $8)
returning *;

-- name: UpdateUserProfile :one
update users set email = $2, display_name = $3, avatar_url = $4
where id = $1
returning *;

-- name: UpdateUserRole :one
update users set role = $2 where id = $1 returning *;

-- name: LockUserCreation :exec
-- Serializes "first user becomes admin" and username picking between concurrent logins.
select pg_advisory_xact_lock(7461001);
