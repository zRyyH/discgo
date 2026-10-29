-- name: ListChannels :many
select * from channels order by kind, position, id;

-- name: GetChannel :one
select * from channels where id = $1;

-- name: CreateChannel :one
insert into channels (id, kind, name, position)
values ($1, $2, $3, (select coalesce(max(position), -1) + 1 from channels where kind = $2))
returning *;

-- name: UpdateChannel :one
update channels set
  name = coalesce(sqlc.narg(name), name),
  position = coalesce(sqlc.narg(position), position)
where id = $1
returning *;

-- name: DeleteChannel :execrows
delete from channels where id = $1;
