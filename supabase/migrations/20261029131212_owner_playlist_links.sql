-- The pin is intentionally empty until a trusted administrator provisions it.
-- No application role may inherit or SET this NOLOGIN role.
create role tubeshuffle_link_executor nologin noinherit nobypassrls;

create schema if not exists private;
revoke all on schema private from public, anon, authenticated;

create table private.approved_owner (
  singleton boolean primary key default true check (singleton),
  user_id uuid not null
);
revoke all on private.approved_owner from public, anon, authenticated;

create table public.playlist_links (
  user_id uuid not null,
  youtube_playlist_id text collate "C" not null
    check (youtube_playlist_id ~ '^[A-Za-z0-9_-]{10,80}$'),
  created_at timestamptz not null default pg_catalog.now(),
  primary key (user_id, youtube_playlist_id)
);
alter table public.playlist_links enable row level security;
revoke all on public.playlist_links from public, anon, authenticated;
grant select, delete on public.playlist_links to authenticated;

grant usage on schema private, public, auth to tubeshuffle_link_executor;
grant select on private.approved_owner to tubeshuffle_link_executor;
grant select, insert on public.playlist_links to tubeshuffle_link_executor;
grant execute on function auth.uid() to tubeshuffle_link_executor;

-- A dedicated role has only the table rights needed by these definers. RLS
-- remains enabled and its policies give this role no UPDATE or DELETE path.
create policy executor_select on public.playlist_links for select
  to tubeshuffle_link_executor using (true);
create policy executor_insert on public.playlist_links for insert
  to tubeshuffle_link_executor with check (true);

create function public.is_approved_owner() returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from private.approved_owner
    where singleton and user_id = (select auth.uid())
  );
$$;
revoke all on function public.is_approved_owner() from public, anon, authenticated;
grant execute on function public.is_approved_owner() to authenticated;

create policy owner_select on public.playlist_links for select to authenticated
  using ((select auth.uid()) = user_id and (select public.is_approved_owner()));
create policy owner_delete on public.playlist_links for delete to authenticated
  using ((select auth.uid()) = user_id and (select public.is_approved_owner()));

-- Every unprivileged creator uses this one transaction-scoped lock. A single
-- namespace key suffices because the application supports exactly one owner.
-- Deletes can race, but only decrease the count; cap failures may be conservative.
create function public.save_playlist_link(id text)
returns table (created boolean, youtube_playlist_id text, created_at timestamptz, limit_reached boolean)
language plpgsql security definer set search_path = ''
as $$
declare
  caller uuid := auth.uid();
  existing public.playlist_links%rowtype;
begin
  if caller is null or not public.is_approved_owner() then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  if id is null or id collate "C" !~ '^[A-Za-z0-9_-]{10,80}$' then
    raise exception 'invalid playlist id' using errcode = '22023';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(1414745171, 1);
  -- Pin changes serialize with this transaction only if operators block traffic;
  -- recheck after waiting to avoid authorizing against a stale pin.
  if not public.is_approved_owner() then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  select l.* into existing from public.playlist_links as l
    where l.user_id = caller and l.youtube_playlist_id = id;
  if found then
    return query select false, existing.youtube_playlist_id, existing.created_at, false;
    return;
  end if;
  if (select pg_catalog.count(*) from public.playlist_links as l where l.user_id = caller) >= 5000 then
    return query select false, null::text, null::timestamptz, true;
    return;
  end if;
  insert into public.playlist_links as l (user_id, youtube_playlist_id)
    values (caller, id) returning l.* into existing;
  return query select true, existing.youtube_playlist_id, existing.created_at, false;
end;
$$;
revoke all on function public.save_playlist_link(text) from public, anon, authenticated;
grant execute on function public.save_playlist_link(text) to authenticated;
-- The definer invokes the other definer; it is not a client-facing grant.
grant execute on function public.is_approved_owner() to tubeshuffle_link_executor;

-- PostgreSQL requires the new function owner to have CREATE on its schema.
-- PG16+ CREATEROLE creates an ADMIN membership without SET: ownership transfer
-- additionally requires SET. Grant only for the transfer, then remove SET again.
do $$ begin
  execute pg_catalog.format('grant tubeshuffle_link_executor to %I with set true, inherit false', current_user);
end $$;
grant create on schema public to tubeshuffle_link_executor;
alter function public.is_approved_owner() owner to tubeshuffle_link_executor;
alter function public.save_playlist_link(text) owner to tubeshuffle_link_executor;
revoke create on schema public from tubeshuffle_link_executor;
do $$ begin
  execute pg_catalog.format('revoke set option for tubeshuffle_link_executor from %I', current_user);
end $$;
