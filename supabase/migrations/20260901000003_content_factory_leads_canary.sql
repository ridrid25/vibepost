-- POST-13C: isolated @ContentFactoryLeads_bot canary.
-- This is test-only business evidence. It does not touch Meeting bookings,
-- content lessons, experiments, payment or revenue state.

alter table public.telegram_attribution_tokens
  drop constraint telegram_attribution_tokens_destination_check;

alter table public.telegram_attribution_tokens
  add constraint telegram_attribution_tokens_destination_check
  check (destination in ('meeting_assistant', 'content_factory_leads_canary'));

create table public.telegram_canary_scope_freeze (
  singleton_key text primary key check (singleton_key = 'POST13C'),
  user_id uuid not null references auth.users (id) on delete restrict,
  test_chat_id uuid not null references public.chats (id) on delete restrict,
  test_telegram_chat_id text not null,
  forbidden_main_chat_id uuid not null references public.chats (id) on delete restrict,
  forbidden_main_telegram_chat_id text not null,
  sentinel_post_a uuid not null,
  sentinel_post_b uuid not null,
  sentinel_hash text not null check (sentinel_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default now(),
  foreign key (sentinel_post_a, user_id) references public.posts (id, user_id),
  foreign key (sentinel_post_b, user_id) references public.posts (id, user_id),
  constraint telegram_canary_scope_distinct check (
    test_chat_id <> forbidden_main_chat_id
    and test_telegram_chat_id <> forbidden_main_telegram_chat_id
    and sentinel_post_a <> sentinel_post_b
  )
);

create table public.telegram_canary_audit_manifest (
  singleton_key text primary key check (singleton_key = 'POST13C_AUDIT'),
  schema_version text not null check (schema_version = 'POST13C_SCHEMA_V1'),
  expected_schema_hash text not null check (expected_schema_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default now()
);

create table public.telegram_canary_runtime_state (
  singleton_key text primary key check (singleton_key = 'POST13C'),
  bot_username text not null check (bot_username = 'ContentFactoryLeads_bot'),
  state text not null check (state in (
    'AUTHORIZED', 'PENDING', 'ACTIVE', 'ROLLBACK_REQUIRED',
    'DEACTIVATING', 'ROLLED_BACK'
  )),
  activation_authorization_digest text
    check (activation_authorization_digest is null or activation_authorization_digest ~ '^[0-9a-f]{64}$'),
  bot_credential_digest text not null check (bot_credential_digest ~ '^[0-9a-f]{64}$'),
  authorization_expires_at timestamptz,
  activation_attempts integer not null default 0 check (activation_attempts between 0 and 1),
  activation_lease_id uuid,
  activation_lease_expires_at timestamptz,
  webhook_secret_digest text check (webhook_secret_digest is null or webhook_secret_digest ~ '^[0-9a-f]{64}$'),
  webhook_config_hash text check (webhook_config_hash is null or webhook_config_hash ~ '^[0-9a-f]{64}$'),
  activated_at timestamptz,
  terminal_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint telegram_canary_runtime_shape check (
    (state = 'AUTHORIZED'
      and activation_authorization_digest is not null
      and authorization_expires_at is not null
      and activation_attempts = 0
      and activation_lease_id is null
      and activation_lease_expires_at is null
      and webhook_secret_digest is null
      and webhook_config_hash is null
      and activated_at is null
      and terminal_at is null)
    or (state = 'PENDING'
      and activation_authorization_digest is null
      and authorization_expires_at is null
      and activation_attempts = 1
      and activation_lease_id is not null
      and activation_lease_expires_at is not null
      and webhook_secret_digest is null
      and webhook_config_hash is null
      and activated_at is null
      and terminal_at is null)
    or (state = 'ACTIVE'
      and activation_authorization_digest is null
      and authorization_expires_at is null
      and activation_attempts = 1
      and activation_lease_id is null
      and activation_lease_expires_at is null
      and webhook_secret_digest is not null
      and webhook_config_hash is not null
      and activated_at is not null
      and terminal_at is null)
    or (state in ('ROLLBACK_REQUIRED', 'DEACTIVATING')
      and activation_authorization_digest is null
      and authorization_expires_at is null
      and activation_attempts = 1
      and terminal_at is null)
    or (state = 'ROLLED_BACK'
      and activation_authorization_digest is null
      and authorization_expires_at is null
      and activation_attempts = 1
      and terminal_at is not null)
  )
);

create table public.telegram_attribution_canary_runs (
  singleton_key text primary key check (singleton_key = 'POST13C'),
  user_id uuid not null references auth.users (id) on delete restrict,
  chat_id uuid not null references public.chats (id) on delete restrict,
  bot_id uuid not null references public.bots (id) on delete restrict,
  telegram_chat_id text not null,
  telegram_post_id uuid not null,
  tg_message_id bigint not null,
  creative_identity_map_id uuid not null,
  publication_mapping_id uuid not null,
  token_id uuid not null unique,
  token_digest text not null unique check (token_digest ~ '^[0-9a-f]{64}$'),
  destination text not null check (destination = 'content_factory_leads_canary'),
  state text not null check (state in ('TOKEN_ISSUED', 'ACTIVE', 'ROLLBACK_REQUIRED', 'ROLLED_BACK')),
  cta_hash text check (cta_hash is null or cta_hash ~ '^[0-9a-f]{64}$'),
  activated_at timestamptz,
  rollback_reason text check (rollback_reason is null or rollback_reason in (
    'CTA_WRITE_FAILED', 'CTA_COMPENSATION_UNCERTAIN', 'OWNER_ROLLBACK',
    'ACTIVATION_FAILED', 'SECURITY_GATE_FAILED'
  )),
  rolled_back_at timestamptz,
  created_at timestamptz not null default now(),
  foreign key (telegram_post_id, user_id)
    references public.posts (id, user_id),
  foreign key (creative_identity_map_id, user_id)
    references public.creative_identity_map (id, user_id),
  foreign key (publication_mapping_id, user_id)
    references public.creative_telegram_publications (id, user_id),
  foreign key (token_id)
    references public.telegram_attribution_tokens (id),
  constraint telegram_attribution_canary_run_shape check (
    (state = 'TOKEN_ISSUED' and cta_hash is null and activated_at is null
      and rollback_reason is null and rolled_back_at is null)
    or (state = 'ACTIVE' and cta_hash is not null and activated_at is not null
      and rollback_reason is null and rolled_back_at is null)
    or (state = 'ROLLBACK_REQUIRED' and rollback_reason is not null and rolled_back_at is null)
    or (state = 'ROLLED_BACK' and rollback_reason is not null and rolled_back_at is not null)
  )
);

create table public.telegram_canary_attribution_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete restrict,
  canary_run_key text not null references public.telegram_attribution_canary_runs (singleton_key) on delete restrict,
  token_id uuid not null references public.telegram_attribution_tokens (id) on delete restrict,
  token_digest text not null check (token_digest ~ '^[0-9a-f]{64}$'),
  event_type text not null check (event_type in ('BOT_START', 'CANARY_LEAD_CREATED')),
  subject_id text not null check (subject_id ~ '^subject_[0-9a-f]{64}$'),
  source_event_id text not null unique check (source_event_id ~ '^update_[0-9a-f]{64}$'),
  occurred_at timestamptz not null,
  status text not null default 'RECORDED' check (status = 'RECORDED'),
  attribution_quality text not null check (attribution_quality in ('DIRECT_LINK', 'DETERMINISTIC_CANARY')),
  provenance jsonb not null,
  created_at timestamptz not null default now(),
  unique (canary_run_key, subject_id, event_type),
  constraint telegram_canary_event_semantics check (
    (event_type = 'BOT_START' and attribution_quality = 'DIRECT_LINK')
    or (event_type = 'CANARY_LEAD_CREATED' and attribution_quality = 'DETERMINISTIC_CANARY')
  ),
  constraint telegram_canary_event_provenance check (
    provenance = jsonb_build_object(
      'policy_version', 'POST13C_ISOLATED_CANARY_V1',
      'source_system', 'content_factory_leads_canary',
      'test_only', true
    )
  )
);

create index telegram_canary_event_owner_time
  on public.telegram_canary_attribution_events (user_id, occurred_at, id);

alter table public.telegram_canary_scope_freeze enable row level security;
alter table public.telegram_canary_audit_manifest enable row level security;
alter table public.telegram_canary_runtime_state enable row level security;
alter table public.telegram_attribution_canary_runs enable row level security;
alter table public.telegram_canary_attribution_events enable row level security;

create policy "telegram_canary_scope_owner_read"
  on public.telegram_canary_scope_freeze for select
  using ((select auth.uid()) = user_id);
create policy "telegram_attribution_canary_run_owner_read"
  on public.telegram_attribution_canary_runs for select
  using ((select auth.uid()) = user_id);
create policy "telegram_canary_event_owner_read"
  on public.telegram_canary_attribution_events for select
  using ((select auth.uid()) = user_id);

revoke all on table public.telegram_canary_scope_freeze
  from public, anon, authenticated, service_role;
revoke all on table public.telegram_canary_audit_manifest
  from public, anon, authenticated, service_role;
revoke all on table public.telegram_canary_runtime_state
  from public, anon, authenticated, service_role;
revoke all on table public.telegram_attribution_canary_runs
  from public, anon, authenticated, service_role;
revoke all on table public.telegram_canary_attribution_events
  from public, anon, authenticated, service_role;
grant select on table public.telegram_canary_scope_freeze to authenticated, service_role;
grant select on table public.telegram_canary_audit_manifest to service_role;
grant select on table public.telegram_canary_runtime_state to service_role;
grant select on table public.telegram_attribution_canary_runs to authenticated, service_role;
grant select on table public.telegram_canary_attribution_events to authenticated, service_role;

create or replace function public.block_telegram_canary_event_mutation()
returns trigger language plpgsql set search_path = '' as $$
begin
  raise exception using errcode = 'P0001', message = 'telegram_canary_event_immutable';
end;
$$;

create trigger telegram_canary_scope_freeze_immutable
before update or delete on public.telegram_canary_scope_freeze
for each row execute function public.block_telegram_canary_event_mutation();

create trigger telegram_canary_audit_manifest_immutable
before update or delete on public.telegram_canary_audit_manifest
for each row execute function public.block_telegram_canary_event_mutation();

create trigger telegram_canary_attribution_events_immutable
before update or delete on public.telegram_canary_attribution_events
for each row execute function public.block_telegram_canary_event_mutation();

create or replace function public.guard_telegram_attribution_canary_run_mutation()
returns trigger language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' then
    raise exception using errcode = 'P0001', message = 'telegram_canary_run_immutable';
  end if;
  if old.singleton_key is distinct from new.singleton_key
     or old.user_id is distinct from new.user_id
     or old.chat_id is distinct from new.chat_id
     or old.bot_id is distinct from new.bot_id
     or old.telegram_chat_id is distinct from new.telegram_chat_id
     or old.telegram_post_id is distinct from new.telegram_post_id
     or old.tg_message_id is distinct from new.tg_message_id
     or old.creative_identity_map_id is distinct from new.creative_identity_map_id
     or old.publication_mapping_id is distinct from new.publication_mapping_id
     or old.token_id is distinct from new.token_id
     or old.token_digest is distinct from new.token_digest
     or old.destination is distinct from new.destination
     or old.created_at is distinct from new.created_at then
    raise exception using errcode = 'P0001', message = 'telegram_canary_run_immutable';
  end if;
  if not (
    (old.state = 'TOKEN_ISSUED' and new.state in ('ACTIVE', 'ROLLBACK_REQUIRED', 'ROLLED_BACK'))
    or (old.state = 'ACTIVE' and new.state in ('ROLLBACK_REQUIRED', 'ROLLED_BACK'))
    or (old.state = 'ROLLBACK_REQUIRED' and new.state = 'ROLLED_BACK')
  ) then
    raise exception using errcode = 'P0001', message = 'telegram_canary_run_transition_invalid';
  end if;
  return new;
end;
$$;

create trigger telegram_attribution_canary_runs_guard
before update or delete on public.telegram_attribution_canary_runs
for each row execute function public.guard_telegram_attribution_canary_run_mutation();

create or replace function public.freeze_content_factory_leads_canary_scope(
  p_user_id uuid,
  p_test_chat_id uuid,
  p_test_telegram_chat_id text,
  p_forbidden_main_chat_id uuid,
  p_forbidden_main_telegram_chat_id text,
  p_sentinel_post_a uuid,
  p_sentinel_post_b uuid
)
returns public.telegram_canary_scope_freeze
language plpgsql security definer set search_path = '' as $$
declare v_hash text; v_count bigint; v_scope public.telegram_canary_scope_freeze;
begin
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('POST13C_RUNTIME'));
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('POST13C_RUN'));
  if exists (select 1 from public.telegram_canary_scope_freeze) then
    raise exception using errcode = 'P0001', message = 'canary_scope_already_frozen';
  end if;
  if p_test_chat_id = p_forbidden_main_chat_id
     or p_test_telegram_chat_id = p_forbidden_main_telegram_chat_id
     or p_sentinel_post_a = p_sentinel_post_b then
    raise exception using errcode = 'P0001', message = 'canary_scope_not_separated';
  end if;
  perform 1 from public.chats c where c.id = p_test_chat_id and c.user_id = p_user_id
    and c.telegram_chat_id = p_test_telegram_chat_id and c.type = 'channel';
  if not found then raise exception using errcode = 'P0001', message = 'canary_test_channel_invalid'; end if;
  perform 1 from public.chats c where c.id = p_forbidden_main_chat_id and c.user_id = p_user_id
    and c.telegram_chat_id = p_forbidden_main_telegram_chat_id and c.type = 'channel';
  if not found then raise exception using errcode = 'P0001', message = 'canary_main_channel_invalid'; end if;
  select count(*), encode(extensions.digest(convert_to(coalesce(string_agg(
    p.id::text || ':' || p.chat_id::text || ':' || p.status || ':' ||
    coalesce(p.tg_message_id::text, '') || ':' || coalesce(p.text, '') || ':' ||
    coalesce(p.inline_buttons::text, ''), '|' order by p.id), ''), 'UTF8'), 'sha256'), 'hex')
    into v_count, v_hash
    from public.posts p
   where p.user_id = p_user_id and p.chat_id = p_forbidden_main_chat_id
     and p.id in (p_sentinel_post_a, p_sentinel_post_b)
     and p.status = 'sent' and p.tg_message_id is not null;
  if v_count <> 2 then raise exception using errcode = 'P0001', message = 'canary_sentinels_invalid'; end if;
  insert into public.telegram_canary_scope_freeze (
    singleton_key, user_id, test_chat_id, test_telegram_chat_id,
    forbidden_main_chat_id, forbidden_main_telegram_chat_id,
    sentinel_post_a, sentinel_post_b, sentinel_hash
  ) values (
    'POST13C', p_user_id, p_test_chat_id, p_test_telegram_chat_id,
    p_forbidden_main_chat_id, p_forbidden_main_telegram_chat_id,
    p_sentinel_post_a, p_sentinel_post_b, v_hash
  ) returning * into v_scope;
  return v_scope;
end;
$$;

create or replace function public.snapshot_content_factory_leads_canary_sentinels()
returns table (sentinel_count bigint, current_hash text, frozen_hash text, matches boolean)
language sql stable security definer set search_path = '' as $$
  with scope as (select * from public.telegram_canary_scope_freeze where singleton_key = 'POST13C'),
  current_state as (
    select count(*) as sentinel_count,
      encode(extensions.digest(convert_to(coalesce(string_agg(
        p.id::text || ':' || p.chat_id::text || ':' || p.status || ':' ||
        coalesce(p.tg_message_id::text, '') || ':' || coalesce(p.text, '') || ':' ||
        coalesce(p.inline_buttons::text, ''), '|' order by p.id), ''), 'UTF8'), 'sha256'), 'hex') as current_hash
      from public.posts p join scope s on p.user_id = s.user_id
     where p.chat_id = s.forbidden_main_chat_id
       and p.id in (s.sentinel_post_a, s.sentinel_post_b)
       and p.status = 'sent' and p.tg_message_id is not null
  )
  select c.sentinel_count, c.current_hash, s.sentinel_hash,
         c.sentinel_count = 2 and c.current_hash = s.sentinel_hash
    from current_state c cross join scope s
$$;

create or replace function public.authorize_content_factory_leads_canary(
  p_credential_digest text,
  p_expires_at timestamptz
)
returns boolean language plpgsql security definer set search_path = '' as $$
begin
  if p_credential_digest !~ '^[0-9a-f]{64}$'
     or p_expires_at <= now()
     or p_expires_at > now() + interval '15 minutes' then
    raise exception using errcode = 'P0001', message = 'canary_activation_authorization_invalid';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('POST13C_RUNTIME'));
  perform 1 from public.telegram_canary_scope_freeze where singleton_key = 'POST13C';
  if not found then
    raise exception using errcode = 'P0001', message = 'canary_scope_not_frozen';
  end if;
  if exists (select 1 from public.telegram_canary_runtime_state) then
    raise exception using errcode = 'P0001', message = 'canary_activation_already_authorized';
  end if;
  insert into public.telegram_canary_runtime_state (
    singleton_key, bot_username, state,
    activation_authorization_digest, bot_credential_digest,
    authorization_expires_at
  ) values (
    'POST13C', 'ContentFactoryLeads_bot', 'AUTHORIZED',
    p_credential_digest, p_credential_digest, p_expires_at
  );
  return true;
end;
$$;

create or replace function public.claim_content_factory_leads_canary_activation(
  p_credential_digest text,
  p_lease_id uuid,
  p_lease_expires_at timestamptz
)
returns boolean language plpgsql security definer set search_path = '' as $$
declare v_count integer;
begin
  if p_credential_digest !~ '^[0-9a-f]{64}$'
     or p_lease_expires_at <= now()
     or p_lease_expires_at > now() + interval '3 minutes' then
    return false;
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('POST13C_RUNTIME'));
  update public.telegram_canary_runtime_state
     set state = 'PENDING',
         activation_authorization_digest = null,
         authorization_expires_at = null,
         activation_attempts = 1,
         activation_lease_id = p_lease_id,
         activation_lease_expires_at = p_lease_expires_at,
         updated_at = now()
   where singleton_key = 'POST13C'
     and state = 'AUTHORIZED'
     and activation_attempts = 0
     and authorization_expires_at > now()
     and activation_authorization_digest = p_credential_digest;
  get diagnostics v_count = row_count;
  return v_count = 1;
end;
$$;

create or replace function public.complete_content_factory_leads_canary_activation(
  p_lease_id uuid,
  p_webhook_secret_digest text,
  p_webhook_config_hash text
)
returns boolean language plpgsql security definer set search_path = '' as $$
declare v_count integer;
begin
  if p_webhook_secret_digest !~ '^[0-9a-f]{64}$'
     or p_webhook_config_hash !~ '^[0-9a-f]{64}$' then return false; end if;
  update public.telegram_canary_runtime_state
     set state = 'ACTIVE', webhook_secret_digest = p_webhook_secret_digest,
         webhook_config_hash = p_webhook_config_hash, activated_at = now(),
         activation_lease_id = null, activation_lease_expires_at = null,
         updated_at = now()
   where singleton_key = 'POST13C' and state = 'PENDING'
     and activation_lease_id = p_lease_id
     and activation_lease_expires_at >= now();
  get diagnostics v_count = row_count;
  return v_count = 1;
end;
$$;

create or replace function public.mark_content_factory_leads_canary_rollback_required(
  p_lease_id uuid,
  p_credential_digest text
)
returns boolean language plpgsql security definer set search_path = '' as $$
declare v_count integer;
begin
  if p_credential_digest !~ '^[0-9a-f]{64}$' then return false; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('POST13C_RUNTIME'));
  update public.telegram_canary_runtime_state
     set state = 'ROLLBACK_REQUIRED', activation_lease_id = null,
         activation_lease_expires_at = null,
         activation_authorization_digest = null,
         authorization_expires_at = null,
         activation_attempts = 1,
         updated_at = now()
   where singleton_key = 'POST13C'
     and bot_credential_digest = p_credential_digest
     and (
       state = 'AUTHORIZED'
       or
       (state = 'PENDING' and activation_lease_id = p_lease_id)
       or state = 'ACTIVE'
     );
  get diagnostics v_count = row_count;
  return v_count = 1;
end;
$$;

create or replace function public.begin_content_factory_leads_canary_deactivation()
returns boolean language plpgsql security definer set search_path = '' as $$
declare v_count integer;
begin
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('POST13C_RUNTIME'));
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('POST13C_RUN'));
  update public.telegram_canary_runtime_state
     set state = 'DEACTIVATING', activation_authorization_digest = null,
         authorization_expires_at = null, activation_lease_id = null,
         activation_lease_expires_at = null, updated_at = now()
   where singleton_key = 'POST13C'
     and state in ('PENDING', 'ACTIVE', 'ROLLBACK_REQUIRED');
  get diagnostics v_count = row_count;
  return v_count = 1;
end;
$$;

create or replace function public.complete_content_factory_leads_canary_deactivation(
  p_credential_digest text
)
returns boolean language plpgsql security definer set search_path = '' as $$
declare v_count integer;
begin
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('POST13C_RUNTIME'));
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('POST13C_RUN'));
  update public.telegram_canary_runtime_state
     set state = 'ROLLED_BACK', activation_authorization_digest = null,
         authorization_expires_at = null, activation_lease_id = null,
         activation_lease_expires_at = null, webhook_secret_digest = null,
         webhook_config_hash = null, activation_attempts = 1,
         terminal_at = now(), updated_at = now()
   where singleton_key = 'POST13C'
     and state in ('AUTHORIZED', 'PENDING', 'ACTIVE', 'ROLLBACK_REQUIRED', 'DEACTIVATING')
     and bot_credential_digest = p_credential_digest;
  get diagnostics v_count = row_count;
  return v_count = 1;
end;
$$;

create or replace function public.prepare_content_factory_leads_canary_run(
  p_user_id uuid,
  p_creative_identity_map_id uuid,
  p_telegram_post_id uuid,
  p_token_digest text
)
returns public.telegram_attribution_canary_runs
language plpgsql security definer set search_path = '' as $$
declare
  v_post public.posts;
  v_chat public.chats;
  v_scope public.telegram_canary_scope_freeze;
  v_publication public.creative_telegram_publications;
  v_token_id uuid;
  v_run public.telegram_attribution_canary_runs;
begin
  if p_token_digest !~ '^[0-9a-f]{64}$' then
    raise exception using errcode = 'P0001', message = 'canary_run_input_invalid';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('POST13C_RUNTIME'));
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('POST13C_RUN'));
  perform 1 from public.telegram_canary_runtime_state
   where singleton_key = 'POST13C' and state = 'ACTIVE'
   for update;
  if not found then
    raise exception using errcode = 'P0001', message = 'canary_runtime_not_active';
  end if;
  select * into v_scope from public.telegram_canary_scope_freeze
   where singleton_key = 'POST13C' and user_id = p_user_id
   for key share;
  if not found then
    raise exception using errcode = 'P0001', message = 'canary_scope_not_frozen';
  end if;
  if exists (select 1 from public.telegram_attribution_canary_runs) then
    raise exception using errcode = 'P0001', message = 'canary_run_already_exists';
  end if;
  select p.* into v_post from public.posts p
   where p.id = p_telegram_post_id and p.user_id = p_user_id
   for key share;
  if not found or v_post.chat_id <> v_scope.test_chat_id or v_post.status <> 'sent'
     or v_post.tg_message_id is null or v_post.format = 'poll'
     or v_post.inline_buttons is not null
     or v_post.chat_id = v_scope.forbidden_main_chat_id
     or v_post.id in (v_scope.sentinel_post_a, v_scope.sentinel_post_b) then
    raise exception using errcode = 'P0001', message = 'canary_post_not_eligible';
  end if;
  select c.* into v_chat from public.chats c
   where c.id = v_post.chat_id and c.user_id = p_user_id
     and c.bot_id = v_post.bot_id and c.type = 'channel'
     and c.telegram_chat_id = v_scope.test_telegram_chat_id
   for key share;
  if not found then
    raise exception using errcode = 'P0001', message = 'canary_test_channel_mismatch';
  end if;
  select * into v_publication from public.bind_telegram_creative_publication(
    p_user_id, p_creative_identity_map_id, p_telegram_post_id
  );
  begin
    insert into public.telegram_attribution_tokens (
      user_id, publication_mapping_id, token_digest, token_version, destination
    ) values (
      p_user_id, v_publication.id, p_token_digest, 'cf1', 'content_factory_leads_canary'
    ) returning id into v_token_id;
  exception when unique_violation then
    raise exception using errcode = '23505', message = 'canary_token_already_exists';
  end;
  insert into public.telegram_attribution_canary_runs (
    singleton_key, user_id, chat_id, bot_id, telegram_chat_id,
    telegram_post_id, tg_message_id, creative_identity_map_id,
    publication_mapping_id, token_id, token_digest, destination, state
  ) values (
    'POST13C', p_user_id, v_chat.id, v_post.bot_id, v_chat.telegram_chat_id,
    v_post.id, v_post.tg_message_id, p_creative_identity_map_id,
    v_publication.id, v_token_id, p_token_digest,
    'content_factory_leads_canary', 'TOKEN_ISSUED'
  ) returning * into v_run;
  return v_run;
end;
$$;

create or replace function public.mark_content_factory_leads_canary_cta_active(
  p_cta_hash text
)
returns boolean language plpgsql security definer set search_path = '' as $$
declare v_count integer;
begin
  if p_cta_hash !~ '^[0-9a-f]{64}$' then return false; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('POST13C_RUNTIME'));
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('POST13C_RUN'));
  update public.telegram_attribution_canary_runs
     set state = 'ACTIVE', cta_hash = p_cta_hash, activated_at = now()
   where singleton_key = 'POST13C' and state = 'TOKEN_ISSUED'
     and exists (
       select 1 from public.telegram_canary_runtime_state s
        where s.singleton_key = 'POST13C' and s.state = 'ACTIVE'
     )
     and exists (
       select 1 from public.telegram_attribution_tokens t
        where t.id = telegram_attribution_canary_runs.token_id
          and t.user_id = telegram_attribution_canary_runs.user_id
          and t.publication_mapping_id = telegram_attribution_canary_runs.publication_mapping_id
          and t.token_digest = telegram_attribution_canary_runs.token_digest
          and t.token_version = 'cf1'
          and t.destination = 'content_factory_leads_canary'
          and t.status = 'ACTIVE'
     );
  get diagnostics v_count = row_count;
  return v_count = 1;
end;
$$;

create or replace function public.ensure_content_factory_leads_canary_token_revoked()
returns boolean language plpgsql security definer set search_path = '' as $$
declare v_run public.telegram_attribution_canary_runs; v_status text;
begin
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('POST13C_RUNTIME'));
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('POST13C_RUN'));
  select * into v_run from public.telegram_attribution_canary_runs
   where singleton_key = 'POST13C' for update;
  if not found then return false; end if;
  update public.telegram_attribution_tokens
     set status = 'REVOKED', revoked_at = coalesce(revoked_at, now())
   where id = v_run.token_id and user_id = v_run.user_id
     and publication_mapping_id = v_run.publication_mapping_id
     and token_digest = v_run.token_digest and token_version = 'cf1'
     and destination = 'content_factory_leads_canary' and status = 'ACTIVE';
  select status into v_status from public.telegram_attribution_tokens
   where id = v_run.token_id and user_id = v_run.user_id
     and publication_mapping_id = v_run.publication_mapping_id
     and token_digest = v_run.token_digest and token_version = 'cf1'
     and destination = 'content_factory_leads_canary';
  return v_status = 'REVOKED';
end;
$$;

create or replace function public.mark_content_factory_leads_canary_run_rollback(
  p_reason text,
  p_uncertain boolean default false
)
returns boolean language plpgsql security definer set search_path = '' as $$
declare v_count integer;
begin
  if p_reason not in ('CTA_WRITE_FAILED', 'CTA_COMPENSATION_UNCERTAIN', 'OWNER_ROLLBACK',
                      'ACTIVATION_FAILED', 'SECURITY_GATE_FAILED') then return false; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('POST13C_RUNTIME'));
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('POST13C_RUN'));
  update public.telegram_attribution_canary_runs
     set state = case when p_uncertain then 'ROLLBACK_REQUIRED' else 'ROLLED_BACK' end,
         rollback_reason = p_reason,
         rolled_back_at = case when p_uncertain then null else now() end
   where singleton_key = 'POST13C'
     and state in ('TOKEN_ISSUED', 'ACTIVE', 'ROLLBACK_REQUIRED')
     and (
       p_uncertain or exists (
         select 1 from public.telegram_attribution_tokens t
          where t.id = telegram_attribution_canary_runs.token_id
            and t.user_id = telegram_attribution_canary_runs.user_id
            and t.token_digest = telegram_attribution_canary_runs.token_digest
            and t.destination = 'content_factory_leads_canary'
            and t.status = 'REVOKED'
       )
     );
  get diagnostics v_count = row_count;
  return v_count = 1;
end;
$$;

create or replace function public.record_content_factory_leads_bot_start(
  p_token_digest text,
  p_subject_id text,
  p_source_event_id text
)
returns boolean language plpgsql security definer set search_path = '' as $$
declare v_run public.telegram_attribution_canary_runs; v_count integer;
begin
  if p_token_digest !~ '^[0-9a-f]{64}$' or p_subject_id !~ '^subject_[0-9a-f]{64}$'
     or p_source_event_id !~ '^update_[0-9a-f]{64}$' then return false; end if;
  select r.* into v_run
    from public.telegram_attribution_canary_runs r
    join public.telegram_attribution_tokens t on t.id = r.token_id
    join public.telegram_canary_runtime_state s on s.singleton_key = r.singleton_key
   where r.singleton_key = 'POST13C' and r.state = 'ACTIVE'
     and t.status = 'ACTIVE' and t.destination = 'content_factory_leads_canary'
     and t.token_digest = p_token_digest and s.state = 'ACTIVE';
  if not found then return false; end if;
  insert into public.telegram_canary_attribution_events (
    user_id, canary_run_key, token_id, token_digest, event_type,
    subject_id, source_event_id, occurred_at, attribution_quality, provenance
  ) values (
    v_run.user_id, 'POST13C', v_run.token_id, v_run.token_digest, 'BOT_START',
    p_subject_id, p_source_event_id, now(), 'DIRECT_LINK',
    jsonb_build_object('policy_version', 'POST13C_ISOLATED_CANARY_V1',
                       'source_system', 'content_factory_leads_canary', 'test_only', true)
  ) on conflict do nothing;
  get diagnostics v_count = row_count;
  return v_count = 1 or exists (
    select 1 from public.telegram_canary_attribution_events e
     where e.canary_run_key = 'POST13C' and e.subject_id = p_subject_id
       and e.event_type = 'BOT_START'
  );
end;
$$;

create or replace function public.record_content_factory_leads_canary_lead(
  p_subject_id text,
  p_source_event_id text
)
returns boolean language plpgsql security definer set search_path = '' as $$
declare v_start public.telegram_canary_attribution_events; v_count integer;
begin
  if p_subject_id !~ '^subject_[0-9a-f]{64}$'
     or p_source_event_id !~ '^update_[0-9a-f]{64}$' then return false; end if;
  select e.* into v_start
    from public.telegram_canary_attribution_events e
    join public.telegram_attribution_canary_runs r on r.singleton_key = e.canary_run_key
    join public.telegram_attribution_tokens t on t.id = r.token_id
    join public.telegram_canary_runtime_state s on s.singleton_key = r.singleton_key
   where e.canary_run_key = 'POST13C' and e.subject_id = p_subject_id
     and e.event_type = 'BOT_START' and r.state = 'ACTIVE'
     and t.status = 'ACTIVE' and t.destination = 'content_factory_leads_canary'
     and s.state = 'ACTIVE';
  if not found then return false; end if;
  insert into public.telegram_canary_attribution_events (
    user_id, canary_run_key, token_id, token_digest, event_type,
    subject_id, source_event_id, occurred_at, attribution_quality, provenance
  ) values (
    v_start.user_id, 'POST13C', v_start.token_id, v_start.token_digest,
    'CANARY_LEAD_CREATED', p_subject_id, p_source_event_id, now(),
    'DETERMINISTIC_CANARY',
    jsonb_build_object('policy_version', 'POST13C_ISOLATED_CANARY_V1',
                       'source_system', 'content_factory_leads_canary', 'test_only', true)
  ) on conflict do nothing;
  get diagnostics v_count = row_count;
  return v_count = 1 or exists (
    select 1 from public.telegram_canary_attribution_events e
     where e.canary_run_key = 'POST13C' and e.subject_id = p_subject_id
       and e.event_type = 'CANARY_LEAD_CREATED'
  );
end;
$$;

create or replace function public.resolve_content_factory_leads_canary_evidence(
  p_user_id uuid
)
returns table (
  creative_id text, publication_id uuid, token_id uuid, token_digest text,
  event_id uuid, event_type text, subject_id text, occurred_at timestamptz,
  attribution_quality text, provenance jsonb
)
language sql stable security definer set search_path = '' as $$
  select p.creative_id, r.telegram_post_id, r.token_id, r.token_digest,
         e.id, e.event_type, e.subject_id, e.occurred_at,
         e.attribution_quality, e.provenance
    from public.telegram_attribution_canary_runs r
    join public.creative_telegram_publications p
      on p.id = r.publication_mapping_id and p.user_id = r.user_id
    join public.telegram_canary_attribution_events e
      on e.canary_run_key = r.singleton_key and e.user_id = r.user_id
   where r.user_id = p_user_id
   order by e.occurred_at, e.id
$$;

create or replace function public.compute_content_factory_leads_canary_schema_hash()
returns text language sql stable security definer set search_path = '' as $$
  select encode(extensions.digest(convert_to(coalesce(string_agg(definition, '|' order by definition), ''), 'UTF8'), 'sha256'), 'hex')
    from (
      select 'TABLE:' || c.relname || ':' || c.relrowsecurity::text || ':' ||
             c.relforcerowsecurity::text || ':' || coalesce(c.relacl::text, '') as definition
        from pg_catalog.pg_class c
        join pg_catalog.pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public' and c.relname in (
         'creative_telegram_publications', 'telegram_attribution_tokens',
         'telegram_canary_scope_freeze', 'telegram_canary_audit_manifest',
         'telegram_canary_runtime_state', 'telegram_attribution_canary_runs',
         'telegram_canary_attribution_events'
       )
      union all
      select 'COLUMN:' || c.table_name || ':' || c.ordinal_position::text || ':' ||
             c.column_name || ':' || c.udt_schema || '.' || c.udt_name || ':' ||
             c.is_nullable || ':' || coalesce(c.column_default, '') || ':' ||
             c.is_identity || ':' || c.is_generated || ':' || coalesce(c.generation_expression, '')
        from information_schema.columns c
       where c.table_schema = 'public' and c.table_name in (
         'creative_telegram_publications', 'telegram_attribution_tokens',
         'telegram_canary_scope_freeze', 'telegram_canary_audit_manifest',
         'telegram_canary_runtime_state', 'telegram_attribution_canary_runs',
         'telegram_canary_attribution_events'
       )
      union all
      select 'CONSTRAINT:' || c.relname || ':' || k.conname || ':' ||
             pg_catalog.pg_get_constraintdef(k.oid, true)
        from pg_catalog.pg_constraint k
        join pg_catalog.pg_class c on c.oid = k.conrelid
        join pg_catalog.pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public' and c.relname in (
         'creative_telegram_publications', 'telegram_attribution_tokens',
         'telegram_canary_scope_freeze', 'telegram_canary_audit_manifest',
         'telegram_canary_runtime_state', 'telegram_attribution_canary_runs',
         'telegram_canary_attribution_events'
       )
      union all
      select 'INDEX:' || c.relname || ':' || i.relname || ':' || pg_catalog.pg_get_indexdef(i.oid)
        from pg_catalog.pg_index x
        join pg_catalog.pg_class c on c.oid = x.indrelid
        join pg_catalog.pg_class i on i.oid = x.indexrelid
        join pg_catalog.pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public' and c.relname in (
         'creative_telegram_publications', 'telegram_attribution_tokens',
         'telegram_canary_scope_freeze', 'telegram_canary_audit_manifest',
         'telegram_canary_runtime_state', 'telegram_attribution_canary_runs',
         'telegram_canary_attribution_events'
       )
      union all
      select 'TRIGGER:' || c.relname || ':' || t.tgname || ':' || pg_catalog.pg_get_triggerdef(t.oid, true)
        from pg_catalog.pg_trigger t
        join pg_catalog.pg_class c on c.oid = t.tgrelid
        join pg_catalog.pg_namespace n on n.oid = c.relnamespace
       where not t.tgisinternal and n.nspname = 'public' and c.relname in (
         'creative_telegram_publications', 'telegram_attribution_tokens',
         'telegram_canary_scope_freeze', 'telegram_canary_audit_manifest',
         'telegram_canary_runtime_state', 'telegram_attribution_canary_runs',
         'telegram_canary_attribution_events'
       )
      union all
      select 'POLICY:' || p.tablename || ':' || p.policyname || ':' || p.permissive || ':' ||
             p.roles::text || ':' || p.cmd || ':' || coalesce(p.qual, '') || ':' || coalesce(p.with_check, '')
        from pg_catalog.pg_policies p
       where p.schemaname = 'public' and p.tablename in (
         'creative_telegram_publications', 'telegram_attribution_tokens',
         'telegram_canary_scope_freeze', 'telegram_canary_audit_manifest',
         'telegram_canary_runtime_state', 'telegram_attribution_canary_runs',
         'telegram_canary_attribution_events'
       )
      union all
      select 'FUNCTION:' || p.proname || '(' || pg_catalog.pg_get_function_identity_arguments(p.oid) || '):' ||
             pg_catalog.pg_get_functiondef(p.oid) || ':' || coalesce(p.proacl::text, '') || ':' ||
             p.prosecdef::text || ':' || coalesce(p.proconfig::text, '')
        from pg_catalog.pg_proc p
        join pg_catalog.pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and p.proname in (
         'bind_telegram_creative_publication', 'guard_telegram_token_mutation',
         'block_telegram_canary_event_mutation', 'guard_telegram_attribution_canary_run_mutation',
         'freeze_content_factory_leads_canary_scope', 'snapshot_content_factory_leads_canary_sentinels',
         'authorize_content_factory_leads_canary', 'claim_content_factory_leads_canary_activation',
         'complete_content_factory_leads_canary_activation',
         'mark_content_factory_leads_canary_rollback_required',
         'begin_content_factory_leads_canary_deactivation',
         'complete_content_factory_leads_canary_deactivation',
         'prepare_content_factory_leads_canary_run',
         'mark_content_factory_leads_canary_cta_active',
         'ensure_content_factory_leads_canary_token_revoked',
         'mark_content_factory_leads_canary_run_rollback',
         'record_content_factory_leads_bot_start',
         'record_content_factory_leads_canary_lead',
         'resolve_content_factory_leads_canary_evidence',
         'compute_content_factory_leads_canary_schema_hash',
         'audit_content_factory_leads_canary'
       )
    ) accepted_boundary
$$;

create or replace function public.audit_content_factory_leads_canary(p_phase text)
returns table (check_name text, passed boolean, row_count bigint, state_hash text, audit_version text)
language plpgsql stable security definer set search_path = '' as $$
begin
  if p_phase not in ('PREACTIVATION', 'ACTIVE_COMPLETE', 'ROLLED_BACK') then
    raise exception using errcode = 'P0001', message = 'canary_audit_phase_invalid';
  end if;
  return query
  with state_facts as (
    select
      (select count(*) from public.telegram_canary_scope_freeze) as scope_count,
      (select count(*) from public.telegram_canary_runtime_state) as runtime_count,
      (select coalesce(max(state), 'NONE') from public.telegram_canary_runtime_state) as runtime_state,
      (select count(*) from public.telegram_attribution_canary_runs) as run_count,
      (select coalesce(max(state), 'NONE') from public.telegram_attribution_canary_runs) as run_state,
      (select count(*) from public.telegram_attribution_tokens where destination = 'content_factory_leads_canary') as token_count,
      (select count(*) from public.telegram_attribution_tokens where destination = 'content_factory_leads_canary' and status = 'ACTIVE') as active_token_count,
      (select count(*) from public.telegram_attribution_tokens where destination = 'content_factory_leads_canary' and status = 'REVOKED') as revoked_token_count,
      (select count(*) from public.telegram_canary_attribution_events where event_type = 'BOT_START') as start_count,
      (select count(*) from public.telegram_canary_attribution_events where event_type = 'CANARY_LEAD_CREATED') as lead_count,
      (select count(*) from (
        select canary_run_key, subject_id, event_type, count(*)
          from public.telegram_canary_attribution_events
         group by canary_run_key, subject_id, event_type having count(*) > 1
      ) d) as duplicate_count,
      (select count(*)
         from public.telegram_attribution_canary_runs r
         left join public.telegram_attribution_tokens t on t.id = r.token_id
         left join public.creative_telegram_publications p on p.id = r.publication_mapping_id
         left join public.telegram_canary_scope_freeze s on s.singleton_key = r.singleton_key
        where t.id is null or p.id is null or s.singleton_key is null
           or t.user_id <> r.user_id or p.user_id <> r.user_id or s.user_id <> r.user_id
           or t.publication_mapping_id <> r.publication_mapping_id
           or t.token_digest <> r.token_digest or t.token_version <> 'cf1'
           or t.destination <> 'content_factory_leads_canary'
           or r.chat_id <> s.test_chat_id or r.telegram_chat_id <> s.test_telegram_chat_id
           or r.chat_id = s.forbidden_main_chat_id
           or r.telegram_post_id in (s.sentinel_post_a, s.sentinel_post_b))
      + (select count(*)
           from public.telegram_canary_attribution_events e
           left join public.telegram_attribution_canary_runs r on r.singleton_key = e.canary_run_key
          where r.singleton_key is null or e.user_id <> r.user_id
             or e.token_id <> r.token_id or e.token_digest <> r.token_digest) as relation_mismatch_count,
      (select count(*) from pg_catalog.pg_class c
         join pg_catalog.pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relname in (
          'telegram_canary_scope_freeze', 'telegram_canary_audit_manifest',
          'telegram_canary_runtime_state',
          'telegram_attribution_canary_runs', 'telegram_canary_attribution_events'
        ) and c.relrowsecurity) as rls_count,
      (select count(*) from pg_catalog.pg_policies p
        where p.schemaname = 'public' and p.tablename in (
          'telegram_canary_scope_freeze', 'telegram_attribution_canary_runs',
          'telegram_canary_attribution_events'
        )) as policy_count,
      (select count(*) from (values
        ('anon', 'creative_telegram_publications'), ('authenticated', 'creative_telegram_publications'), ('service_role', 'creative_telegram_publications'),
        ('anon', 'telegram_attribution_tokens'), ('authenticated', 'telegram_attribution_tokens'), ('service_role', 'telegram_attribution_tokens'),
        ('anon', 'telegram_canary_scope_freeze'), ('authenticated', 'telegram_canary_scope_freeze'), ('service_role', 'telegram_canary_scope_freeze'),
        ('anon', 'telegram_canary_audit_manifest'), ('authenticated', 'telegram_canary_audit_manifest'), ('service_role', 'telegram_canary_audit_manifest'),
        ('anon', 'telegram_canary_runtime_state'), ('authenticated', 'telegram_canary_runtime_state'), ('service_role', 'telegram_canary_runtime_state'),
        ('anon', 'telegram_attribution_canary_runs'), ('authenticated', 'telegram_attribution_canary_runs'), ('service_role', 'telegram_attribution_canary_runs'),
        ('anon', 'telegram_canary_attribution_events'), ('authenticated', 'telegram_canary_attribution_events'), ('service_role', 'telegram_canary_attribution_events')
      ) as a(role_name, table_name)
       where pg_catalog.has_table_privilege(a.role_name, 'public.' || a.table_name, 'INSERT')
          or pg_catalog.has_table_privilege(a.role_name, 'public.' || a.table_name, 'UPDATE')
          or pg_catalog.has_table_privilege(a.role_name, 'public.' || a.table_name, 'DELETE')) as acl_violation_count,
      (select count(*) from pg_catalog.pg_proc p
         join pg_catalog.pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.prosecdef
          and (p.proname like '%content_factory_leads_canary%'
               or p.proname = 'record_content_factory_leads_bot_start')
          and (pg_catalog.has_function_privilege('anon', p.oid, 'EXECUTE')
               or pg_catalog.has_function_privilege('authenticated', p.oid, 'EXECUTE')
               or not pg_catalog.has_function_privilege('service_role', p.oid, 'EXECUTE'))) as function_acl_violation_count,
      (select encode(extensions.digest(convert_to(coalesce(string_agg(
        singleton_key || ':' || state || ':' || token_id::text || ':' || coalesce(cta_hash, ''),
        '|' order by singleton_key), ''), 'UTF8'), 'sha256'), 'hex')
        from public.telegram_attribution_canary_runs) as run_hash,
      (select encode(extensions.digest(convert_to(coalesce(string_agg(
        event_type || ':' || subject_id || ':' || source_event_id,
        '|' order by event_type, subject_id, source_event_id), ''), 'UTF8'), 'sha256'), 'hex')
        from public.telegram_canary_attribution_events) as event_hash
  ), schema_state as (
    select public.compute_content_factory_leads_canary_schema_hash() as schema_hash,
           max(m.expected_schema_hash) as expected_schema_hash,
           max(m.schema_version) as schema_version
      from public.telegram_canary_audit_manifest m
     where m.singleton_key = 'POST13C_AUDIT'
  ), sentinel_state as (
    select coalesce(max(sentinel_count), 0)::bigint as sentinel_count,
           coalesce(bool_and(matches), false) as matches
      from public.snapshot_content_factory_leads_canary_sentinels()
  ), facts as (
    select f.*, s.sentinel_count, s.matches as sentinels_match,
      x.schema_hash, x.expected_schema_hash, x.schema_version,
      encode(extensions.digest(convert_to(
        p_phase || ':' || f.runtime_state || ':' || f.run_state || ':' ||
        f.run_count::text || ':' || f.token_count::text || ':' ||
        f.start_count::text || ':' || f.lead_count::text,
        'UTF8'), 'sha256'), 'hex') as phase_hash
      from state_facts f cross join sentinel_state s cross join schema_state x
  )
  select 'SCOPE_FREEZE', scope_count = 1 and sentinel_count = 2 and sentinels_match,
         scope_count, phase_hash, 'POST13C_AUDIT_V2' from facts
  union all
  select 'RUNTIME_PHASE', runtime_count = 1 and (
           (p_phase in ('PREACTIVATION', 'ACTIVE_COMPLETE') and runtime_state = 'ACTIVE')
           or (p_phase = 'ROLLED_BACK' and runtime_state = 'ROLLED_BACK')
         ), runtime_count, phase_hash, 'POST13C_AUDIT_V2' from facts
  union all
  select 'CANARY_RUN_PHASE', (
           (p_phase = 'PREACTIVATION' and run_count = 0)
           or (p_phase = 'ACTIVE_COMPLETE' and run_count = 1 and run_state = 'ACTIVE')
           or (p_phase = 'ROLLED_BACK' and run_count <= 1 and (run_count = 0 or run_state = 'ROLLED_BACK'))
         ), run_count, run_hash, 'POST13C_AUDIT_V2' from facts
  union all
  select 'CANARY_TOKEN_PHASE', token_count <= 1 and (
           (p_phase = 'PREACTIVATION' and token_count = 0)
           or (p_phase = 'ACTIVE_COMPLETE' and active_token_count = 1 and revoked_token_count = 0)
           or (p_phase = 'ROLLED_BACK' and active_token_count = 0)
         ), token_count, run_hash, 'POST13C_AUDIT_V2' from facts
  union all
  select 'BOT_START_PHASE', (
           (p_phase = 'PREACTIVATION' and start_count = 0)
           or (p_phase = 'ACTIVE_COMPLETE' and start_count = 1)
           or (p_phase = 'ROLLED_BACK' and start_count <= 1)
         ), start_count, event_hash, 'POST13C_AUDIT_V2' from facts
  union all
  select 'CANARY_LEAD_PHASE', (
           (p_phase = 'PREACTIVATION' and lead_count = 0)
           or (p_phase = 'ACTIVE_COMPLETE' and lead_count = 1)
           or (p_phase = 'ROLLED_BACK' and lead_count <= 1)
         ), lead_count, event_hash, 'POST13C_AUDIT_V2' from facts
  union all
  select 'DUPLICATE_EVENTS', duplicate_count = 0, duplicate_count, event_hash, 'POST13C_AUDIT_V2' from facts
  union all
  select 'RELATION_INTEGRITY', relation_mismatch_count = 0, relation_mismatch_count, phase_hash, 'POST13C_AUDIT_V2' from facts
  union all
  select 'RLS_ENABLED', rls_count = 5, rls_count, schema_hash, 'POST13C_AUDIT_V2' from facts
  union all
  select 'OWNER_READ_POLICIES', policy_count = 3, policy_count, schema_hash, 'POST13C_AUDIT_V2' from facts
  union all
  select 'WRITE_ACL_VIOLATIONS', acl_violation_count = 0, acl_violation_count, schema_hash, 'POST13C_AUDIT_V2' from facts
  union all
  select 'FUNCTION_ACL_VIOLATIONS', function_acl_violation_count = 0, function_acl_violation_count, schema_hash, 'POST13C_AUDIT_V2' from facts
  union all
  select 'SCHEMA_HASH', schema_version = 'POST13C_SCHEMA_V1'
           and schema_hash = expected_schema_hash,
         case when schema_hash = expected_schema_hash then 0 else 1 end,
         schema_hash, 'POST13C_AUDIT_V2' from facts;
end;
$$;

revoke execute on function public.authorize_content_factory_leads_canary(text, timestamptz)
  from public, anon, authenticated;
revoke execute on function public.claim_content_factory_leads_canary_activation(text, uuid, timestamptz)
  from public, anon, authenticated;
revoke execute on function public.complete_content_factory_leads_canary_activation(uuid, text, text)
  from public, anon, authenticated;
revoke execute on function public.mark_content_factory_leads_canary_rollback_required(uuid, text)
  from public, anon, authenticated;
revoke execute on function public.begin_content_factory_leads_canary_deactivation()
  from public, anon, authenticated;
revoke execute on function public.complete_content_factory_leads_canary_deactivation(text)
  from public, anon, authenticated;
revoke execute on function public.freeze_content_factory_leads_canary_scope(uuid, uuid, text, uuid, text, uuid, uuid)
  from public, anon, authenticated;
revoke execute on function public.snapshot_content_factory_leads_canary_sentinels()
  from public, anon, authenticated;
revoke execute on function public.prepare_content_factory_leads_canary_run(uuid, uuid, uuid, text)
  from public, anon, authenticated;
revoke execute on function public.mark_content_factory_leads_canary_cta_active(text)
  from public, anon, authenticated;
revoke execute on function public.mark_content_factory_leads_canary_run_rollback(text, boolean)
  from public, anon, authenticated;
revoke execute on function public.ensure_content_factory_leads_canary_token_revoked()
  from public, anon, authenticated;
revoke execute on function public.record_content_factory_leads_bot_start(text, text, text)
  from public, anon, authenticated;
revoke execute on function public.record_content_factory_leads_canary_lead(text, text)
  from public, anon, authenticated;
revoke execute on function public.resolve_content_factory_leads_canary_evidence(uuid)
  from public, anon, authenticated;
revoke execute on function public.compute_content_factory_leads_canary_schema_hash()
  from public, anon, authenticated;
revoke execute on function public.audit_content_factory_leads_canary(text)
  from public, anon, authenticated;

grant execute on function public.authorize_content_factory_leads_canary(text, timestamptz) to service_role;
grant execute on function public.claim_content_factory_leads_canary_activation(text, uuid, timestamptz) to service_role;
grant execute on function public.complete_content_factory_leads_canary_activation(uuid, text, text) to service_role;
grant execute on function public.mark_content_factory_leads_canary_rollback_required(uuid, text) to service_role;
grant execute on function public.begin_content_factory_leads_canary_deactivation() to service_role;
grant execute on function public.complete_content_factory_leads_canary_deactivation(text) to service_role;
grant execute on function public.freeze_content_factory_leads_canary_scope(uuid, uuid, text, uuid, text, uuid, uuid) to service_role;
grant execute on function public.snapshot_content_factory_leads_canary_sentinels() to service_role;
grant execute on function public.prepare_content_factory_leads_canary_run(uuid, uuid, uuid, text) to service_role;
grant execute on function public.mark_content_factory_leads_canary_cta_active(text) to service_role;
grant execute on function public.mark_content_factory_leads_canary_run_rollback(text, boolean) to service_role;
grant execute on function public.ensure_content_factory_leads_canary_token_revoked() to service_role;
grant execute on function public.record_content_factory_leads_bot_start(text, text, text) to service_role;
grant execute on function public.record_content_factory_leads_canary_lead(text, text) to service_role;
grant execute on function public.resolve_content_factory_leads_canary_evidence(uuid) to service_role;
grant execute on function public.compute_content_factory_leads_canary_schema_hash() to service_role;
grant execute on function public.audit_content_factory_leads_canary(text) to service_role;

insert into public.telegram_canary_audit_manifest (
  singleton_key, schema_version, expected_schema_hash
) values (
  'POST13C_AUDIT', 'POST13C_SCHEMA_V1',
  public.compute_content_factory_leads_canary_schema_hash()
);

comment on table public.telegram_attribution_canary_runs is
  'POST-13C immutable singleton for one isolated test-channel post and one cf1 token.';
comment on table public.telegram_canary_attribution_events is
  'POST-13C append-only PII-free test evidence; CANARY_LEAD_CREATED is not a real Booking or revenue event.';
