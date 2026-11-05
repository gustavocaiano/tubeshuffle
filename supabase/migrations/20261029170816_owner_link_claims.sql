-- The migration runner must wrap this entire file in one transaction. Do not
-- run individual statements or apply to a remote without separate approval.
-- Compatibility copy of auth.uid(): trust only gateway-verified, isolated GUCs;
-- compare the installed auth.uid() implementation for drift before deployment.
do $migration$
declare
  migrator oid := (select oid from pg_catalog.pg_roles where rolname = current_user);
  executor oid := (select oid from pg_catalog.pg_roles where rolname = 'tubeshuffle_link_executor');
  own_grant_exists boolean;
  create_was_effective boolean;
  membership_before jsonb;
  schema_acl_before aclitem[];
  function_metadata_before jsonb;
  prior_search_path text := pg_catalog.current_setting('search_path');
  f record;
begin
  -- RESET ROLE is only safe if it restores the exact entry identity.
  if current_user <> session_user then
    raise exception 'migration requires current_user = session_user';
  end if;
  if pg_catalog.current_setting('server_version_num')::integer < 160000 or executor is null then
    raise exception 'expected PostgreSQL 16+ and existing executor';
  end if;
  if (not (select rolsuper from pg_catalog.pg_roles where oid = migrator)
      and not exists (select 1 from pg_catalog.pg_auth_members where roleid = executor and member = migrator and admin_option))
     or exists (select 1 from pg_catalog.pg_auth_members where roleid = executor and member = migrator and set_option)
      or (not (select rolsuper from pg_catalog.pg_roles where oid = migrator)
          and pg_catalog.pg_has_role(current_user, 'tubeshuffle_link_executor', 'SET')) then
    raise exception 'expected direct ADMIN membership and no effective SET membership';
  end if;
  select coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(m) order by m.grantor), '[]'::jsonb)
    into membership_before from pg_catalog.pg_auth_members m
    where m.roleid = executor and m.member = migrator;
  select exists (select 1 from pg_catalog.pg_auth_members
    where roleid = executor and member = migrator and grantor = migrator) into own_grant_exists;
  select nspacl into schema_acl_before from pg_catalog.pg_namespace where nspname = 'public';
  create_was_effective := pg_catalog.has_schema_privilege('tubeshuffle_link_executor', 'public', 'CREATE');
  select pg_catalog.jsonb_agg(pg_catalog.to_jsonb(p) - 'prosrc' order by p.oid)
    into function_metadata_before from pg_catalog.pg_proc p
    where p.oid in ('public.is_approved_owner()'::regprocedure, 'public.save_playlist_link(text)'::regprocedure);

  if not exists (select 1 from pg_catalog.pg_roles where oid = executor and not rolcanlogin and not rolbypassrls and not rolsuper)
     or exists (select 1 from pg_catalog.pg_class where oid in ('public.playlist_links'::regclass, 'private.approved_owner'::regclass) and relowner = executor) then
    raise exception 'unexpected executor attributes or table ownership';
  end if;
  -- Compare the entire SQL body byte-for-byte, including whitespace. Even
  -- semantically equivalent drift requires independent review.
  if not exists (select 1 from pg_catalog.pg_proc p join pg_catalog.pg_language l on l.oid = p.prolang
      where p.oid = 'auth.uid()'::regprocedure and l.lanname = 'sql'
        and p.prorettype = 'uuid'::regtype and not p.prosecdef
        and p.prosrc = $uid$
  select 
  coalesce(
    nullif(current_setting('request.jwt.claim.sub', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
  )::uuid
$uid$) then
    raise exception 'unexpected auth.uid() definition';
  end if;
  if not pg_catalog.has_schema_privilege('authenticated', 'auth', 'USAGE')
     or not pg_catalog.has_function_privilege('authenticated', 'auth.uid()', 'EXECUTE') then
    raise exception 'authenticated cannot use auth.uid()';
  end if;
  if exists (select 1 from pg_catalog.pg_auth_members where member = executor)
     or exists (select 1 from pg_catalog.pg_roles r where r.rolname in ('anon', 'authenticated')
       and (pg_catalog.pg_has_role(r.oid, executor, 'MEMBER')
            or pg_catalog.pg_has_role(r.oid, executor, 'SET')
            or pg_catalog.pg_has_role(r.oid, executor, 'USAGE'))) then
    raise exception 'unexpected executor role graph';
  end if;
  if pg_catalog.has_schema_privilege(executor, 'public', 'CREATE')
     or not pg_catalog.has_schema_privilege(executor, 'public', 'USAGE')
     or not pg_catalog.has_schema_privilege(executor, 'private', 'USAGE')
     or not pg_catalog.has_table_privilege(executor, 'private.approved_owner', 'SELECT')
     or not pg_catalog.has_table_privilege(executor, 'public.playlist_links', 'SELECT')
     or not pg_catalog.has_table_privilege(executor, 'public.playlist_links', 'INSERT')
     or pg_catalog.has_table_privilege(executor, 'private.approved_owner', 'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
     or pg_catalog.has_table_privilege(executor, 'public.playlist_links', 'UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
     or pg_catalog.has_any_column_privilege(executor, 'private.approved_owner', 'INSERT,UPDATE,REFERENCES')
     or pg_catalog.has_any_column_privilege(executor, 'public.playlist_links', 'UPDATE,REFERENCES') then
    raise exception 'unexpected executor privileges';
  end if;
  if exists (select 1 from pg_catalog.pg_roles r where r.rolname in ('anon','authenticated')
      and (pg_catalog.has_schema_privilege(r.oid, 'private', 'USAGE,CREATE')
        or pg_catalog.has_table_privilege(r.oid, 'private.approved_owner', 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
        or pg_catalog.has_table_privilege(r.oid, 'public.playlist_links', 'INSERT,UPDATE,TRUNCATE,REFERENCES,TRIGGER')
        or pg_catalog.has_any_column_privilege(r.oid, 'public.playlist_links', 'INSERT,UPDATE,REFERENCES')
        or pg_catalog.has_any_column_privilege(r.oid, 'private.approved_owner', 'SELECT,INSERT,UPDATE,REFERENCES'))) then
    raise exception 'unexpected client privileges';
  end if;
  if not exists (select 1 from pg_catalog.pg_class where oid = 'public.playlist_links'::regclass and relrowsecurity and not relforcerowsecurity) then
    raise exception 'unexpected RLS state';
  end if;
  perform pg_catalog.set_config('search_path', 'pg_catalog', true);
  if (select count(*) from pg_catalog.pg_policy where polrelid = 'public.playlist_links'::regclass) <> 4
     or (select count(*) from pg_catalog.pg_policy p where p.polrelid = 'public.playlist_links'::regclass and p.polpermissive and (
       (p.polname = 'executor_select' and p.polcmd = 'r' and p.polroles = array[executor] and pg_catalog.pg_get_expr(p.polqual, p.polrelid) = 'true' and p.polwithcheck is null)
       or (p.polname = 'executor_insert' and p.polcmd = 'a' and p.polroles = array[executor] and p.polqual is null and pg_catalog.pg_get_expr(p.polwithcheck, p.polrelid) = 'true')
       or (p.polname in ('owner_select','owner_delete') and p.polcmd = case p.polname when 'owner_select' then 'r'::"char" else 'd'::"char" end
         and p.polroles = array[(select oid from pg_catalog.pg_roles where rolname = 'authenticated')]
         and p.polwithcheck is null and pg_catalog.pg_get_expr(p.polqual, p.polrelid) = '((( SELECT auth.uid() AS uid) = user_id) AND ( SELECT public.is_approved_owner() AS is_approved_owner))')
     )) <> 4 then
    raise exception 'unexpected RLS policies';
  end if;
  perform pg_catalog.set_config('search_path', prior_search_path, true);
  for f in select p.oid, p.proowner, p.prosecdef, p.proconfig, p.prosrc, p.provolatile,
                  l.lanname
    from pg_catalog.pg_proc p join pg_catalog.pg_language l on l.oid = p.prolang
    where p.oid in ('public.is_approved_owner()'::regprocedure, 'public.save_playlist_link(text)'::regprocedure)
    loop
    if exists (select 1 from pg_catalog.pg_proc p where p.oid = f.oid and
       (p.prokind <> 'f' or p.proisstrict or p.proretset <> (f.oid = 'public.save_playlist_link(text)'::regprocedure)
        or p.pronargdefaults <> 0 or p.provariadic <> 0 or p.proleakproof)) then
      raise exception 'unexpected function attributes';
    end if;
    if f.proowner <> executor or not f.prosecdef or f.proconfig is distinct from array['search_path=""']::text[]
       or (f.oid = 'public.is_approved_owner()'::regprocedure and
           (f.lanname <> 'sql' or f.provolatile <> 's' or f.prosrc <> $old_helper$
  select exists (
    select 1 from private.approved_owner
    where singleton and user_id = (select auth.uid())
  );
$old_helper$))
       or (f.oid = 'public.save_playlist_link(text)'::regprocedure and
           (f.lanname <> 'plpgsql' or f.provolatile <> 'v' or f.prosrc <> $old_save$
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
$old_save$)) then
      raise exception 'unexpected function definition or security settings';
    end if;
    if pg_catalog.has_function_privilege('anon', f.oid, 'EXECUTE')
       or not pg_catalog.has_function_privilege('authenticated', f.oid, 'EXECUTE')
       or exists (select 1 from pg_catalog.aclexplode(coalesce((select proacl from pg_catalog.pg_proc where oid = f.oid), pg_catalog.acldefault('f', executor))) a where a.grantee = 0 and a.privilege_type = 'EXECUTE') then
      raise exception 'unexpected function execute privileges';
    end if;
    if exists (select 1 from pg_catalog.aclexplode(coalesce((select proacl from pg_catalog.pg_proc where oid = f.oid), pg_catalog.acldefault('f', executor))) a
      where a.privilege_type = 'EXECUTE' and (a.grantee not in (executor, (select oid from pg_catalog.pg_roles where rolname = 'authenticated')) or a.is_grantable)) then
      raise exception 'unexpected function ACL';
    end if;
    if (f.oid = 'public.is_approved_owner()'::regprocedure and (select pg_catalog.pg_get_function_result(f.oid)) <> 'boolean')
       or (f.oid = 'public.save_playlist_link(text)'::regprocedure and (select pg_catalog.pg_get_function_result(f.oid)) <> 'TABLE(created boolean, youtube_playlist_id text, created_at timestamp with time zone, limit_reached boolean)') then
      raise exception 'unexpected function result signature';
    end if;
    if (f.oid = 'public.is_approved_owner()'::regprocedure and pg_catalog.pg_get_function_arguments(f.oid) <> '')
       or (f.oid = 'public.save_playlist_link(text)'::regprocedure and pg_catalog.pg_get_function_arguments(f.oid) <> 'id text') then
      raise exception 'unexpected function argument metadata';
    end if;
  end loop;
  if not pg_catalog.has_function_privilege('tubeshuffle_link_executor', 'public.is_approved_owner()', 'EXECUTE') then
    raise exception 'executor cannot execute helper';
  end if;

  if own_grant_exists then
    execute pg_catalog.format('grant tubeshuffle_link_executor to %I with set true', current_user);
  else
    execute pg_catalog.format('grant tubeshuffle_link_executor to %I with set true, inherit false', current_user);
  end if;
  if not create_was_effective then
    grant create on schema public to tubeshuffle_link_executor;
  end if;
  set local role tubeshuffle_link_executor;
  execute $replacement_helper$create or replace function public.is_approved_owner() returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from private.approved_owner
    where singleton and user_id = (select coalesce(nullif(pg_catalog.current_setting('request.jwt.claim.sub', true), ''), (nullif(pg_catalog.current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'))::uuid)
  );
$$;$replacement_helper$;
  execute $replacement_save$create or replace function public.save_playlist_link(id text)
returns table (created boolean, youtube_playlist_id text, created_at timestamptz, limit_reached boolean)
language plpgsql security definer set search_path = ''
as $$
declare
  caller uuid := coalesce(nullif(pg_catalog.current_setting('request.jwt.claim.sub', true), ''), (nullif(pg_catalog.current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'))::uuid;
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
$$;$replacement_save$;
  reset role;
  if not create_was_effective then
    revoke create on schema public from tubeshuffle_link_executor;
  end if;
  if own_grant_exists then
    execute pg_catalog.format('revoke set option for tubeshuffle_link_executor from %I granted by %I', current_user, current_user);
  else
    execute pg_catalog.format('revoke tubeshuffle_link_executor from %I granted by %I', current_user, current_user);
  end if;
  if membership_before is distinct from (select coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(m) order by m.grantor), '[]'::jsonb)
      from pg_catalog.pg_auth_members m where m.roleid = executor and m.member = migrator)
     or schema_acl_before is distinct from (select nspacl from pg_catalog.pg_namespace where nspname = 'public')
     or function_metadata_before is distinct from (select pg_catalog.jsonb_agg(pg_catalog.to_jsonb(p) - 'prosrc' order by p.oid)
       from pg_catalog.pg_proc p where p.oid in ('public.is_approved_owner()'::regprocedure, 'public.save_playlist_link(text)'::regprocedure)) then
    raise exception 'temporary privileges or function metadata were not restored exactly';
  end if;
end
$migration$;
