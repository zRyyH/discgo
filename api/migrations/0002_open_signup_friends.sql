-- Open sign-up with Google (no invites) and friends by username.
drop table invites;

-- username: the Gmail address without "@gmail.com" (the whole address for other
-- domains). username_key is the lookup form: lowercase, and without dots for
-- Gmail, which ignores them, so it is unique like the mailbox. Set once, when the
-- account is created; auth.Username is the same rule in Go.
alter table users add column username text, add column username_key text;
update users set username = case
    when lower(split_part(email, '@', 2)) in ('gmail.com', 'googlemail.com') then lower(split_part(email, '@', 1))
    else lower(email)
end;
update users set username_key = case when position('@' in username) = 0 then replace(username, '.', '') else username end;
alter table users alter column username set not null, alter column username_key set not null;
create unique index users_username_key_idx on users (username_key);

-- Pending friend requests; accepting one turns it into a friendship.
create table friend_requests (
    from_id    uuid not null references users (id) on delete cascade,
    to_id      uuid not null references users (id) on delete cascade,
    created_at timestamptz not null default now(),
    primary key (from_id, to_id),
    check (from_id <> to_id)
);
create index friend_requests_to_id_idx on friend_requests (to_id);

-- Friendships, stored in both directions.
create table friends (
    user_id    uuid not null references users (id) on delete cascade,
    friend_id  uuid not null references users (id) on delete cascade,
    created_at timestamptz not null default now(),
    primary key (user_id, friend_id),
    check (user_id <> friend_id)
);
