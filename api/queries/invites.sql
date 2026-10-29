-- name: CreateInvite :one
insert into invites (code, created_by, max_uses, expires_at)
values ($1, $2, $3, $4)
returning *;

-- name: ListInvites :many
select * from invites order by created_at desc;

-- name: DeleteInvite :execrows
delete from invites where code = $1;

-- name: ClaimInvite :one
-- Consumes one use of a valid invite; no row when expired, used up or unknown.
update invites set uses = uses + 1
where code = $1
  and (expires_at is null or expires_at > now())
  and (max_uses is null or uses < max_uses)
returning *;
