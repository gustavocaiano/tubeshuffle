-- Disposable PostgreSQL fixture only; not for deployment.
create role anon nologin;
create role authenticated nologin;
create role supabase_admin nologin;
create schema auth authorization supabase_admin;
set role supabase_admin;
create function auth.uid() returns uuid language sql stable as $$
  select 
  coalesce(
    nullif(current_setting('request.jwt.claim.sub', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
  )::uuid
$$;
grant usage on schema auth to authenticated;
grant execute on function auth.uid() to authenticated;
reset role;
