-- Template only. Generate validated SQL with manual_fixture_generator.py; see runbook.
-- Run this entire DO statement once, never a selection of it.
do $fixture$
declare
  fixture_id constant text := 'REPLACE_WITH_SYNTHETIC_ID';
  owner_fingerprint constant text := 'REPLACE_WITH_SHA256_FINGERPRINT';
  fixture_time constant timestamptz := '2000-01-01 00:00:00+00';
  owner_id uuid;
  affected integer;
begin
  if fixture_id collate "C" !~ '^tsfixture_[A-Za-z0-9_-]{20,70}$'
     or owner_fingerprint collate "C" !~ '^[0-9a-f]{64}$' then
    raise exception 'invalid private input';
  end if;
  perform pg_catalog.set_config('row_security', 'off', true);
  perform pg_catalog.pg_advisory_xact_lock(1414745171, 1);
  lock table private.approved_owner in share mode;
  lock table public.playlist_links in share row exclusive mode;
  if (select count(*) from private.approved_owner) <> 1 then
    raise exception 'pin check failed; stop';
  end if;
  select user_id into owner_id from private.approved_owner
    where singleton and pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(user_id::text, 'UTF8')), 'hex') = owner_fingerprint;
  if not found then raise exception 'pin check failed; stop'; end if;
  if exists (select 1 from public.playlist_links where user_id = owner_id)
     or exists (select 1 from public.playlist_links where youtube_playlist_id = fixture_id) then
    raise exception 'precondition failed; stop';
  end if;
  insert into public.playlist_links (user_id, youtube_playlist_id, created_at)
    values (owner_id, fixture_id, fixture_time);
  get diagnostics affected = row_count;
  if affected <> 1 then raise exception 'unexpected row count; stop'; end if;
end
$fixture$;
