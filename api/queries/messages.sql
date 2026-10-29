-- name: ListMessages :many
-- Newest first; `before` = the oldest id the client already has (null for the latest page).
select * from messages
where channel_id = $1 and (sqlc.narg(before)::uuid is null or id < sqlc.narg(before)::uuid)
order by id desc
limit $2;

-- name: GetMessage :one
select * from messages where id = $1;

-- name: CreateMessage :one
insert into messages (id, channel_id, author_id, content, attachments)
values ($1, $2, $3, $4, $5)
returning *;

-- name: UpdateMessageContent :one
update messages set content = $2, edited_at = now() where id = $1 returning *;

-- name: DeleteMessage :execrows
delete from messages where id = $1;
