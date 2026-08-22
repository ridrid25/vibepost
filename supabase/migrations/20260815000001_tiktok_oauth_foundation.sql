-- TikTok OAuth and raw API capture foundation.
--
-- IMPORTANT: this migration intentionally does NOT create the canonical
-- videos/metrics schema. Content Brigade v2 requires a real OAuth-authorized
-- response from the target account before those fields are finalized.

create table public.tiktok_accounts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  provider_app_id text not null,
  open_id text not null,
  display_name text,
  token_secret_id uuid,
  token_generation bigint not null default 0 check (token_generation >= 0),
  scopes text[] not null default '{}',
  access_expires_at timestamptz,
  refresh_expires_at timestamptz,
  auth_status text not null default 'active'
    check (auth_status in ('active', 'expired', 'reauth_required', 'revoking', 'revoked_pending', 'provider_revoked', 'revoked', 'error')),
  schema_status text not null default 'unverified'
    check (schema_status in ('unverified', 'fixture_captured', 'verified')),
  schema_verified_at timestamptz,
  schema_verified_by uuid references auth.users (id) on delete set null,
  verified_fixture_hashes text[],
  verified_schema_fingerprints text[],
  last_synced_at timestamptz,
  backfill_cursor bigint,
  backfill_complete boolean not null default false,
  next_sync_at timestamptz not null default now(),
  sync_claimed_at timestamptz,
  sync_lease_token uuid,
  last_error text,
  last_tiktok_log_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (provider_app_id, open_id),
  unique (id, user_id)
);

create index idx_tiktok_accounts_due
  on public.tiktok_accounts (auth_status, next_sync_at)
  where auth_status = 'active';
create index idx_tiktok_accounts_user on public.tiktok_accounts (user_id, created_at desc);

alter table public.tiktok_accounts enable row level security;
create policy "tiktok_accounts_owner_read" on public.tiktok_accounts
  for select using ((select auth.uid()) = user_id);

create trigger trg_tiktok_accounts_updated_at
  before update on public.tiktok_accounts
  for each row execute function public.set_updated_at();

-- One-time OAuth state. Only service_role can read or mutate these rows.
-- The browser receives the raw state; only its SHA-256 hash is persisted.
create table public.tiktok_oauth_states (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  state_hash text not null unique,
  redirect_uri text not null,
  expires_at timestamptz not null default (now() + interval '10 minutes'),
  used_at timestamptz,
  created_at timestamptz not null default now()
);
create index idx_tiktok_oauth_states_expiry on public.tiktok_oauth_states (expires_at);
alter table public.tiktok_oauth_states enable row level security;

create or replace function public.consume_tiktok_oauth_state(p_state_hash text)
returns table (state_id uuid, user_id uuid, redirect_uri text)
language sql
security definer
set search_path = ''
as $$
  update public.tiktok_oauth_states as s
     set used_at = now()
   where s.state_hash = p_state_hash
     and s.used_at is null
     and s.expires_at > now()
  returning s.id, s.user_id, s.redirect_uri;
$$;
revoke execute on function public.consume_tiktok_oauth_state(text) from public, anon, authenticated;
grant execute on function public.consume_tiktok_oauth_state(text) to service_role;

create table public.tiktok_sync_runs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  account_id uuid not null,
  trigger_type text not null check (trigger_type in ('manual', 'scheduled', 'oauth_probe')),
  idempotency_key text not null,
  status text not null default 'running'
    check (status in ('running', 'completed', 'failed', 'reauth_required')),
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  cursor_before bigint,
  cursor_after bigint,
  http_status integer,
  api_error_code text,
  tiktok_log_id text,
  error text,
  items_seen integer not null default 0 check (items_seen >= 0),
  items_written integer not null default 0 check (items_written >= 0),
  unique (account_id, idempotency_key),
  unique (id, user_id),
  foreign key (account_id, user_id)
    references public.tiktok_accounts (id, user_id) on delete cascade
);
create index idx_tiktok_sync_runs_account on public.tiktok_sync_runs (account_id, started_at desc);
alter table public.tiktok_sync_runs enable row level security;
create policy "tiktok_sync_runs_owner_read" on public.tiktok_sync_runs
  for select using ((select auth.uid()) = user_id);

-- Sanitized response examples plus a machine-readable inventory of JSON paths.
-- They are the evidence gate for the future normalized schema.
create table public.tiktok_api_fixtures (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  account_id uuid not null,
  sync_run_id uuid not null,
  endpoint text not null,
  api_version text not null default 'v2',
  captured_at timestamptz not null default now(),
  redacted_response jsonb not null,
  response_sha256 text not null,
  field_inventory jsonb not null default '[]'::jsonb,
  schema_fingerprint text not null,
  verified_at timestamptz,
  verified_by uuid references auth.users (id) on delete set null,
  unique (account_id, endpoint, response_sha256),
  foreign key (account_id, user_id)
    references public.tiktok_accounts (id, user_id) on delete cascade,
  foreign key (sync_run_id, user_id)
    references public.tiktok_sync_runs (id, user_id) on delete cascade
);
create index idx_tiktok_api_fixtures_account
  on public.tiktok_api_fixtures (account_id, endpoint, captured_at desc);
alter table public.tiktok_api_fixtures enable row level security;
create policy "tiktok_api_fixtures_owner_read" on public.tiktok_api_fixtures
  for select using ((select auth.uid()) = user_id);

-- Unsanitized video items remain backend-only. They are retained temporarily
-- so no fields are lost before the live payload has been reviewed.
create table public.tiktok_raw_video_items (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  account_id uuid not null,
  sync_run_id uuid not null,
  endpoint text not null,
  external_video_id text,
  raw_payload jsonb not null,
  payload_sha256 text not null,
  captured_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '14 days'),
  unique (sync_run_id, payload_sha256),
  foreign key (account_id, user_id)
    references public.tiktok_accounts (id, user_id) on delete cascade,
  foreign key (sync_run_id, user_id)
    references public.tiktok_sync_runs (id, user_id) on delete cascade
);
create index idx_tiktok_raw_video_items_account
  on public.tiktok_raw_video_items (account_id, captured_at desc);
create index idx_tiktok_raw_video_items_expiry
  on public.tiktok_raw_video_items (expires_at);
alter table public.tiktok_raw_video_items enable row level security;

-- One JSON bundle per account. Access and refresh tokens never enter a public
-- table and are never returned to authenticated clients.
create or replace function public.store_tiktok_token_bundle(
  p_account_id uuid,
  p_bundle text,
  p_expected_generation bigint default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_secret_id uuid;
  v_generation bigint;
begin
  select a.token_secret_id, a.token_generation
    into v_secret_id, v_generation
    from public.tiktok_accounts a
   where a.id = p_account_id
   for update;
  if not found then
    raise exception 'TikTok account not found';
  end if;
  if p_expected_generation is not null and v_generation <> p_expected_generation then
    raise exception using
      errcode = '40001',
      message = 'token_generation_conflict';
  end if;

  if v_secret_id is null then
    v_secret_id := vault.create_secret(
      p_bundle,
      'tiktok_account_' || p_account_id::text,
      'VibePost TikTok OAuth token bundle'
    );
  else
    perform vault.update_secret(v_secret_id, p_bundle);
  end if;
  update public.tiktok_accounts
     set token_secret_id = v_secret_id,
         token_generation = token_generation + 1
   where id = p_account_id;
  return v_secret_id;
end;
$$;

create or replace function public.get_tiktok_token_bundle(p_account_id uuid)
returns text
language sql
security definer
set search_path = ''
as $$
  select s.decrypted_secret
    from public.tiktok_accounts a
    join vault.decrypted_secrets s on s.id = a.token_secret_id
   where a.id = p_account_id;
$$;

revoke execute on function public.store_tiktok_token_bundle(uuid, text, bigint)
  from public, anon, authenticated;
revoke execute on function public.get_tiktok_token_bundle(uuid)
  from public, anon, authenticated;
grant execute on function public.store_tiktok_token_bundle(uuid, text, bigint) to service_role;
grant execute on function public.get_tiktok_token_bundle(uuid) to service_role;

create or replace function public.cleanup_tiktok_token_bundle()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if old.token_secret_id is not null then
    delete from vault.secrets where id = old.token_secret_id;
  end if;
  return old;
end;
$$;
revoke execute on function public.cleanup_tiktok_token_bundle()
  from public, anon, authenticated;
create trigger trg_tiktok_accounts_cleanup_token
  after delete on public.tiktok_accounts
  for each row execute function public.cleanup_tiktok_token_bundle();

-- Claim scheduled accounts atomically so concurrent cron invocations do not
-- synchronize the same TikTok account twice.
create or replace function public.claim_due_tiktok_accounts(p_limit integer default 5)
returns table (account_id uuid, user_id uuid, lease_token uuid)
language plpgsql
security definer
set search_path = ''
as $$
begin
  return query
  update public.tiktok_accounts as a
     set sync_claimed_at = now(),
         sync_lease_token = gen_random_uuid(),
         next_sync_at = now() + interval '15 minutes'
   where a.id in (
     select q.id
       from public.tiktok_accounts q
      where q.auth_status = 'active'
        and q.next_sync_at <= now()
        and (q.sync_claimed_at is null or q.sync_claimed_at < now() - interval '10 minutes')
      order by q.next_sync_at
      for update skip locked
      limit greatest(1, least(coalesce(p_limit, 5), 20))
   )
  returning a.id, a.user_id, a.sync_lease_token;
end;
$$;
revoke execute on function public.claim_due_tiktok_accounts(integer)
  from public, anon, authenticated;
grant execute on function public.claim_due_tiktok_accounts(integer) to service_role;

-- The same per-account lease protects manual, targeted service and scheduled
-- syncs. This is important because TikTok may rotate refresh tokens.
create or replace function public.claim_tiktok_account_sync(p_account_id uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_lease uuid := gen_random_uuid();
begin
  update public.tiktok_accounts as a
     set sync_claimed_at = now(),
         sync_lease_token = v_lease
   where a.id = p_account_id
     and a.auth_status = 'active'
     and (a.sync_claimed_at is null or a.sync_claimed_at < now() - interval '10 minutes');
  if not found then
    return null;
  end if;
  return v_lease;
end;
$$;
revoke execute on function public.claim_tiktok_account_sync(uuid)
  from public, anon, authenticated;
grant execute on function public.claim_tiktok_account_sync(uuid) to service_role;

create or replace function public.claim_tiktok_account_oauth(
  p_account_id uuid,
  p_user_id uuid,
  p_expected_generation bigint
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_lease uuid := gen_random_uuid();
begin
  update public.tiktok_accounts as a
     set sync_claimed_at = now(),
         sync_lease_token = v_lease
   where a.id = p_account_id
     and a.user_id = p_user_id
     and a.token_generation = p_expected_generation
     and a.auth_status in ('active', 'expired', 'reauth_required', 'error')
     and (a.sync_claimed_at is null or a.sync_claimed_at < now() - interval '10 minutes');
  if not found then
    return null;
  end if;
  return v_lease;
end;
$$;
revoke execute on function public.claim_tiktok_account_oauth(uuid, uuid, bigint)
  from public, anon, authenticated;
grant execute on function public.claim_tiktok_account_oauth(uuid, uuid, bigint) to service_role;

create or replace function public.release_tiktok_account_sync(
  p_account_id uuid,
  p_lease_token uuid
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.tiktok_accounts as a
     set sync_claimed_at = null,
         sync_lease_token = null
   where a.id = p_account_id
     and a.sync_lease_token = p_lease_token;
  return found;
end;
$$;
revoke execute on function public.release_tiktok_account_sync(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.release_tiktok_account_sync(uuid, uuid) to service_role;

create or replace function public.begin_tiktok_disconnect(
  p_account_id uuid,
  p_user_id uuid
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_lease uuid := gen_random_uuid();
begin
  update public.tiktok_accounts as a
     set auth_status = 'revoking',
         sync_claimed_at = now(),
         sync_lease_token = v_lease,
         next_sync_at = 'infinity'::timestamptz
   where a.id = p_account_id
     and a.user_id = p_user_id
     and a.auth_status in ('active', 'expired', 'reauth_required', 'error', 'revoking', 'revoked_pending')
     and (a.sync_claimed_at is null or a.sync_claimed_at < now() - interval '10 minutes');
  if not found then
    return null;
  end if;
  return v_lease;
end;
$$;
revoke execute on function public.begin_tiktok_disconnect(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.begin_tiktok_disconnect(uuid, uuid) to service_role;

create or replace function public.verify_tiktok_api_fixture(
  p_fixture_id uuid,
  p_reviewer_id uuid
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.tiktok_api_fixtures as f
     set verified_at = now(),
         verified_by = p_reviewer_id
   where f.id = p_fixture_id
     and f.user_id = p_reviewer_id;
  return found;
end;
$$;
revoke execute on function public.verify_tiktok_api_fixture(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.verify_tiktok_api_fixture(uuid, uuid) to service_role;

create or replace function public.approve_tiktok_fixture_schema(
  p_account_id uuid,
  p_reviewer_id uuid
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_hashes text[];
  v_schema_fingerprints text[];
begin
  if not exists (
    select 1 from public.tiktok_accounts a
     where a.id = p_account_id and a.user_id = p_reviewer_id
  ) then
    return false;
  end if;
  if not exists (
    select 1 from public.tiktok_api_fixtures f
     where f.account_id = p_account_id
       and f.endpoint = '/v2/video/list/'
       and f.verified_at is not null
       and f.verified_by = p_reviewer_id
  ) or not exists (
    select 1 from public.tiktok_api_fixtures f
     where f.account_id = p_account_id
       and f.endpoint = '/v2/video/query/'
       and f.verified_at is not null
       and f.verified_by = p_reviewer_id
  ) then
    return false;
  end if;

  select array_agg(distinct f.response_sha256 order by f.response_sha256)
    into v_hashes
    from public.tiktok_api_fixtures f
   where f.account_id = p_account_id
     and f.verified_at is not null
     and f.verified_by = p_reviewer_id;

  select array_agg(distinct f.schema_fingerprint order by f.schema_fingerprint)
    into v_schema_fingerprints
    from public.tiktok_api_fixtures f
   where f.account_id = p_account_id
     and f.endpoint in ('/v2/video/list/', '/v2/video/query/')
     and f.verified_at is not null
     and f.verified_by = p_reviewer_id;

  update public.tiktok_accounts
     set schema_status = 'verified',
         schema_verified_at = now(),
         schema_verified_by = p_reviewer_id,
         verified_fixture_hashes = v_hashes,
         verified_schema_fingerprints = v_schema_fingerprints
   where id = p_account_id and user_id = p_reviewer_id;
  return found;
end;
$$;
revoke execute on function public.approve_tiktok_fixture_schema(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.approve_tiktok_fixture_schema(uuid, uuid) to service_role;

create or replace function public.purge_expired_tiktok_raw_items()
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_count bigint;
begin
  delete from public.tiktok_raw_video_items where expires_at <= now();
  get diagnostics v_count = row_count;
  delete from public.tiktok_oauth_states
   where expires_at <= now()
      or used_at < now() - interval '1 day';
  return v_count;
end;
$$;
revoke execute on function public.purge_expired_tiktok_raw_items()
  from public, anon, authenticated;
grant execute on function public.purge_expired_tiktok_raw_items() to service_role;

comment on table public.tiktok_api_fixtures is
  'Sanitized live TikTok API responses. Required evidence before normalized schema is finalized.';
comment on column public.tiktok_accounts.schema_status is
  'unverified until real video/list and video/query responses have been captured and reviewed';
