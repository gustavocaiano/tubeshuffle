-- Run with psql -v ON_ERROR_STOP=1 as a privileged role on a disposable DB.
begin;

do $$
begin
  if has_table_privilege('anon', 'public.playlist_links', 'SELECT')
     or has_table_privilege('authenticated', 'public.playlist_links', 'INSERT')
     or has_table_privilege('authenticated', 'public.playlist_links', 'UPDATE')
     or has_table_privilege('authenticated', 'private.approved_owner', 'SELECT')
     or has_schema_privilege('authenticated', 'private', 'USAGE')
     or has_function_privilege('anon', 'public.save_playlist_link(text)', 'EXECUTE')
     or has_function_privilege('anon', 'public.is_approved_owner()', 'EXECUTE') then
    raise exception 'unexpected client privilege';
  end if;
  if not has_function_privilege('authenticated', 'public.save_playlist_link(text)', 'EXECUTE') then
    raise exception 'missing RPC privilege';
  end if;
  if pg_has_role('anon', 'tubeshuffle_link_executor', 'USAGE')
     or pg_has_role('anon', 'tubeshuffle_link_executor', 'SET')
     or pg_has_role('authenticated', 'tubeshuffle_link_executor', 'USAGE')
     or pg_has_role('authenticated', 'tubeshuffle_link_executor', 'SET') then
    raise exception 'client can inherit or set executor role';
  end if;
  if exists (select 1 from pg_catalog.pg_roles where rolname = 'tubeshuffle_link_executor'
      and (rolsuper or rolbypassrls or rolcanlogin))
     or exists (select 1 from pg_catalog.pg_auth_members where member = 'tubeshuffle_link_executor'::regrole)
     or not has_schema_privilege('authenticated', 'auth', 'USAGE')
     or not has_function_privilege('authenticated', 'auth.uid()', 'EXECUTE') then
    raise exception 'unexpected executor role or auth access';
  end if;
  if has_schema_privilege('tubeshuffle_link_executor', 'public', 'CREATE')
     or has_table_privilege('tubeshuffle_link_executor', 'private.approved_owner', 'INSERT')
     or has_table_privilege('tubeshuffle_link_executor', 'public.playlist_links', 'DELETE')
     or has_table_privilege('tubeshuffle_link_executor', 'public.playlist_links', 'UPDATE') then
    raise exception 'unexpected executor privilege';
  end if;
  if (select count(*) from pg_catalog.pg_proc p
      join pg_catalog.pg_namespace n on n.oid = p.pronamespace
      join pg_catalog.pg_roles r on r.oid = p.proowner
      where n.nspname = 'public' and p.oid in
        ('public.save_playlist_link(text)'::regprocedure, 'public.is_approved_owner()'::regprocedure)
        and r.rolname = 'tubeshuffle_link_executor' and p.prosecdef) <> 2 then
    raise exception 'incorrect definer function ownership';
  end if;
end $$;

-- Disposable test DB only: clear any existing fixtures, then restore by rollback.
delete from public.playlist_links;
delete from private.approved_owner;
select set_config('request.jwt.claim.sub', '11111111-1111-1111-1111-111111111111', true);
set local role authenticated;
do $$ begin
  if public.is_approved_owner() then raise exception 'missing pin allowed'; end if;
  begin
    perform public.save_playlist_link('abcdefghij');
    raise exception 'missing pin created link';
  exception when insufficient_privilege then null; end;
end $$;
reset role;
insert into private.approved_owner (user_id) values ('11111111-1111-1111-1111-111111111111');
set local role authenticated;
do $$
declare a record; b record;
begin
  if not public.is_approved_owner() then raise exception 'owner denied'; end if;
  select * into a from public.save_playlist_link('abcdefghij');
  select * into b from public.save_playlist_link('abcdefghij');
  if not a.created or b.created or a.created_at is distinct from b.created_at or b.limit_reached then
    raise exception 'idempotence failed';
  end if;
  begin
    perform public.save_playlist_link('https://youtube.com/playlist?list=abcdefghij');
    raise exception 'invalid ID accepted';
  exception when invalid_parameter_value then null; end;
  begin
    insert into public.playlist_links (user_id, youtube_playlist_id)
      values ('11111111-1111-1111-1111-111111111111', 'directinsert');
    raise exception 'direct insert accepted';
  exception when insufficient_privilege then null; end;
  begin
    update public.playlist_links set youtube_playlist_id = 'directupdate';
    raise exception 'direct update accepted';
  exception when insufficient_privilege then null; end;
end $$;

select set_config('request.jwt.claim.sub', '22222222-2222-2222-2222-222222222222', true);
do $$ begin
  if public.is_approved_owner() or (select count(*) from public.playlist_links) <> 0 then
    raise exception 'non-owner can see data';
  end if;
  delete from public.playlist_links;
  begin
    perform public.save_playlist_link('nonownerid');
    raise exception 'non-owner created link';
  exception when insufficient_privilege then null; end;
end $$;
reset role;
do $$ begin
  if (select count(*) from public.playlist_links) <> 1 then raise exception 'non-owner deleted data'; end if;
end $$;

-- A trusted operator seeds the boundary, never a permitted client writer.
insert into public.playlist_links (user_id, youtube_playlist_id)
select '11111111-1111-1111-1111-111111111111'::uuid, 'seed_' || lpad(n::text, 10, '0')
from generate_series(1, 4999) as n;
select set_config('request.jwt.claim.sub', '11111111-1111-1111-1111-111111111111', true);
set local role authenticated;
do $$
declare r record;
begin
  select * into r from public.save_playlist_link('abcdefghij');
  if r.created or r.limit_reached then raise exception 'existing at cap failed'; end if;
  select * into r from public.save_playlist_link('another_valid_id');
  if not r.limit_reached or r.created or r.youtube_playlist_id is not null then raise exception 'cap failed'; end if;
  delete from public.playlist_links where youtube_playlist_id = 'abcdefghij';
  select * into r from public.save_playlist_link('another_valid_id');
  if not r.created or r.limit_reached then raise exception 'save after delete failed'; end if;
end $$;
reset role;
delete from private.approved_owner;
set local role authenticated;
do $$ begin
  if public.is_approved_owner() or (select count(*) from public.playlist_links) <> 0 then
    raise exception 'pin removal did not close access';
  end if;
end $$;
rollback;
