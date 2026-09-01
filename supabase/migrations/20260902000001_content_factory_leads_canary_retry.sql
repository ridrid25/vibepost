-- POST-13D: one fresh isolated mobile canary retry.
-- POST-13C history is read-only and is never transitioned by this migration.

create table public.telegram_canary_retry_audit_manifest (
  singleton_key text primary key check (singleton_key = 'POST13D_AUDIT'),
  schema_version text not null check (schema_version = 'POST13D_SCHEMA_V1'),
  expected_schema_hash text not null check (expected_schema_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default now()
);

create table public.telegram_attribution_canary_retry_runs (
  canary_run_id uuid primary key,
  stage_key text not null unique check (stage_key = 'POST13D'),
  user_id uuid not null references auth.users (id) on delete restrict,
  bot_username text not null check (bot_username = 'ContentFactoryLeads_bot'),
  chat_id uuid not null references public.chats (id) on delete restrict,
  bot_id uuid not null references public.bots (id) on delete restrict,
  telegram_chat_id text not null,
  telegram_post_id uuid not null,
  creative_identity_map_id uuid not null,
  publication_mapping_id uuid not null,
  token_id uuid not null unique,
  token_digest text not null unique check (token_digest ~ '^[0-9a-f]{64}$'),
  destination text not null check (destination = 'content_factory_leads_canary'),
  bot_credential_digest text not null check (bot_credential_digest ~ '^[0-9a-f]{64}$'),
  webhook_secret_digest text not null check (webhook_secret_digest ~ '^[0-9a-f]{64}$'),
  webhook_config_hash text not null check (webhook_config_hash ~ '^[0-9a-f]{64}$'),
  sentinel_hash text not null check (sentinel_hash ~ '^[0-9a-f]{64}$'),
  cta_hash text not null check (cta_hash ~ '^[0-9a-f]{64}$'),
  state text not null check (state in (
    'PREPARING', 'ACTIVE', 'COMPLETED', 'ROLLBACK_REQUIRED', 'ROLLED_BACK'
  )),
  delivery_attempts integer not null default 0 check (delivery_attempts between 0 and 1),
  delivery_lease_id uuid,
  delivery_lease_expires_at timestamptz,
  delivery_attempted_at timestamptz,
  tg_message_id bigint check (tg_message_id is null or tg_message_id > 0),
  activated_at timestamptz,
  cta_removal_proof_hash text
    check (cta_removal_proof_hash is null or cta_removal_proof_hash ~ '^[0-9a-f]{64}$'),
  cta_removed_at timestamptz,
  rollback_reason text check (rollback_reason is null or rollback_reason in (
    'DELIVERY_REJECTED', 'DELIVERY_AMBIGUOUS', 'FINALIZE_FAILED',
    'COMPENSATION_UNCERTAIN', 'OWNER_ROLLBACK', 'SECURITY_GATE_FAILED'
  )),
  resolution_hash text
    check (resolution_hash is null or resolution_hash ~ '^[0-9a-f]{64}$'),
  terminal_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (telegram_post_id, user_id)
    references public.posts (id, user_id),
  foreign key (creative_identity_map_id, user_id)
    references public.creative_identity_map (id, user_id),
  foreign key (publication_mapping_id, user_id)
    references public.creative_telegram_publications (id, user_id),
  foreign key (token_id)
    references public.telegram_attribution_tokens (id),
  constraint telegram_canary_retry_run_shape check (
    (state = 'PREPARING'
      and tg_message_id is null and activated_at is null
      and cta_removal_proof_hash is null and cta_removed_at is null
      and rollback_reason is null and resolution_hash is null and terminal_at is null
      and (
        (delivery_attempts = 0 and delivery_lease_id is null
          and delivery_lease_expires_at is null and delivery_attempted_at is null)
        or
        (delivery_attempts = 1 and delivery_lease_id is not null
          and delivery_lease_expires_at is not null and delivery_attempted_at is not null)
      ))
    or
    (state = 'ACTIVE'
      and delivery_attempts = 1 and delivery_lease_id is not null
      and delivery_lease_expires_at is not null and delivery_attempted_at is not null
      and tg_message_id is not null
      and activated_at is not null and cta_removal_proof_hash is null
      and cta_removed_at is null and rollback_reason is null
      and resolution_hash is null and terminal_at is null)
    or
    (state = 'COMPLETED'
      and delivery_attempts = 1 and tg_message_id is not null
      and delivery_lease_id is not null and delivery_lease_expires_at is not null
      and delivery_attempted_at is not null
      and activated_at is not null and cta_removal_proof_hash is not null
      and cta_removed_at is not null and rollback_reason is null
      and resolution_hash is not null and terminal_at is not null)
    or
    (state = 'ROLLBACK_REQUIRED'
      and rollback_reason is not null and resolution_hash is null and terminal_at is null)
    or
    (state = 'ROLLED_BACK'
      and rollback_reason is not null and resolution_hash is null and terminal_at is not null)
  )
);

create table public.telegram_canary_retry_events (
  id uuid primary key default gen_random_uuid(),
  canary_run_id uuid not null
    references public.telegram_attribution_canary_retry_runs (canary_run_id) on delete restrict,
  user_id uuid not null references auth.users (id) on delete restrict,
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
  unique (canary_run_id, subject_id, event_type),
  constraint telegram_canary_retry_event_semantics check (
    (event_type = 'BOT_START' and attribution_quality = 'DIRECT_LINK')
    or
    (event_type = 'CANARY_LEAD_CREATED' and attribution_quality = 'DETERMINISTIC_CANARY')
  ),
  constraint telegram_canary_retry_event_provenance check (
    provenance = jsonb_build_object(
      'policy_version', 'POST13D_ISOLATED_CANARY_RETRY_V1',
      'source_system', 'content_factory_leads_canary_retry',
      'test_only', true
    )
  )
);

create index telegram_canary_retry_event_owner_time
  on public.telegram_canary_retry_events (user_id, occurred_at, id);

alter table public.telegram_canary_retry_audit_manifest enable row level security;
alter table public.telegram_attribution_canary_retry_runs enable row level security;
alter table public.telegram_canary_retry_events enable row level security;

create policy "telegram_canary_retry_run_owner_read"
  on public.telegram_attribution_canary_retry_runs for select
  using ((select auth.uid()) = user_id);
create policy "telegram_canary_retry_event_owner_read"
  on public.telegram_canary_retry_events for select
  using ((select auth.uid()) = user_id);

revoke all on table public.telegram_canary_retry_audit_manifest
  from public, anon, authenticated, service_role;
revoke all on table public.telegram_attribution_canary_retry_runs
  from public, anon, authenticated, service_role;
revoke all on table public.telegram_canary_retry_events
  from public, anon, authenticated, service_role;
grant select on table public.telegram_canary_retry_audit_manifest to service_role;
grant select on table public.telegram_attribution_canary_retry_runs
  to authenticated, service_role;
grant select on table public.telegram_canary_retry_events
  to authenticated, service_role;

create or replace function public.block_telegram_canary_retry_mutation()
returns trigger language plpgsql set search_path = '' as $$
begin
  raise exception using errcode = 'P0001', message = 'telegram_canary_retry_immutable';
end;
$$;

create trigger telegram_canary_retry_audit_manifest_immutable
before update or delete on public.telegram_canary_retry_audit_manifest
for each row execute function public.block_telegram_canary_retry_mutation();

create trigger telegram_canary_retry_events_immutable
before update or delete on public.telegram_canary_retry_events
for each row execute function public.block_telegram_canary_retry_mutation();

create or replace function public.guard_telegram_canary_retry_run_mutation()
returns trigger language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' then
    raise exception using errcode = 'P0001', message = 'telegram_canary_retry_run_immutable';
  end if;
  if old.canary_run_id is distinct from new.canary_run_id
     or old.stage_key is distinct from new.stage_key
     or old.user_id is distinct from new.user_id
     or old.bot_username is distinct from new.bot_username
     or old.chat_id is distinct from new.chat_id
     or old.bot_id is distinct from new.bot_id
     or old.telegram_chat_id is distinct from new.telegram_chat_id
     or old.telegram_post_id is distinct from new.telegram_post_id
     or old.creative_identity_map_id is distinct from new.creative_identity_map_id
     or old.publication_mapping_id is distinct from new.publication_mapping_id
     or old.token_id is distinct from new.token_id
     or old.token_digest is distinct from new.token_digest
     or old.destination is distinct from new.destination
     or old.bot_credential_digest is distinct from new.bot_credential_digest
     or old.webhook_secret_digest is distinct from new.webhook_secret_digest
     or old.webhook_config_hash is distinct from new.webhook_config_hash
     or old.sentinel_hash is distinct from new.sentinel_hash
     or old.cta_hash is distinct from new.cta_hash
     or old.created_at is distinct from new.created_at then
    raise exception using errcode = 'P0001', message = 'telegram_canary_retry_run_immutable';
  end if;
  if old.state = 'PREPARING' and new.state = 'PREPARING' then
    if old.delivery_attempts <> 0 or new.delivery_attempts <> 1
       or old.delivery_lease_id is not null or new.delivery_lease_id is null
       or old.delivery_lease_expires_at is not null
       or new.delivery_lease_expires_at is null
       or old.delivery_attempted_at is not null or new.delivery_attempted_at is null
       or old.tg_message_id is distinct from new.tg_message_id
       or old.activated_at is distinct from new.activated_at
       or old.cta_removal_proof_hash is distinct from new.cta_removal_proof_hash
       or old.cta_removed_at is distinct from new.cta_removed_at
       or old.rollback_reason is distinct from new.rollback_reason
       or old.resolution_hash is distinct from new.resolution_hash
       or old.terminal_at is distinct from new.terminal_at then
      raise exception using errcode = 'P0001', message = 'telegram_canary_retry_claim_invalid';
    end if;
    return new;
  end if;
  if not (
    (old.state = 'PREPARING' and new.state in ('ACTIVE', 'ROLLBACK_REQUIRED', 'ROLLED_BACK'))
    or (old.state = 'ACTIVE' and new.state in ('COMPLETED', 'ROLLBACK_REQUIRED', 'ROLLED_BACK'))
    or (old.state = 'ROLLBACK_REQUIRED' and new.state = 'ROLLED_BACK')
  ) then
    raise exception using errcode = 'P0001', message = 'telegram_canary_retry_transition_invalid';
  end if;
  if old.delivery_attempts is distinct from new.delivery_attempts
     or old.delivery_lease_id is distinct from new.delivery_lease_id
     or old.delivery_lease_expires_at is distinct from new.delivery_lease_expires_at
     or old.delivery_attempted_at is distinct from new.delivery_attempted_at
     or (old.tg_message_id is not null and old.tg_message_id is distinct from new.tg_message_id)
     or (old.activated_at is not null and old.activated_at is distinct from new.activated_at) then
    raise exception using errcode = 'P0001', message = 'telegram_canary_retry_delivery_immutable';
  end if;
  if old.state = 'ACTIVE' and new.state = 'COMPLETED' then
    if old.resolution_hash is not null or new.resolution_hash is null then
      raise exception using errcode = 'P0001', message = 'telegram_canary_retry_resolution_invalid';
    end if;
  elsif old.resolution_hash is distinct from new.resolution_hash then
    raise exception using errcode = 'P0001', message = 'telegram_canary_retry_resolution_immutable';
  end if;
  return new;
end;
$$;

create trigger telegram_canary_retry_runs_guard
before update or delete on public.telegram_attribution_canary_retry_runs
for each row execute function public.guard_telegram_canary_retry_run_mutation();

create or replace function public.prepare_content_factory_leads_canary_retry(
  p_user_id uuid,
  p_canary_run_id uuid,
  p_creative_id text,
  p_source_task_id text,
  p_source_revision_id text,
  p_source_hash text,
  p_handoff_id text,
  p_token_digest text,
  p_cta_hash text,
  p_publication_text text
)
returns public.telegram_attribution_canary_retry_runs
language plpgsql security definer set search_path = '' as $$
declare
  v_scope public.telegram_canary_scope_freeze;
  v_runtime public.telegram_canary_runtime_state;
  v_chat public.chats;
  v_identity public.creative_identity_map;
  v_publication public.creative_telegram_publications;
  v_post_id uuid;
  v_token_id uuid;
  v_run public.telegram_attribution_canary_retry_runs;
  v_sentinel_count bigint;
  v_sentinel_hash text;
  v_sentinels_match boolean;
begin
  if p_creative_id !~ '^creative-[0-9a-f]{64}$'
     or p_token_digest !~ '^[0-9a-f]{64}$'
     or p_cta_hash !~ '^[0-9a-f]{64}$'
     or p_publication_text <> '🧪 POST-13D — изолированная тестовая публикация. Кнопка создаёт только тестовый лид; Booking, Calendar, payment и revenue не создаются.' then
    raise exception using errcode = 'P0001', message = 'post13d_prepare_input_invalid';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('POST13D_RUN'));
  if exists (select 1 from public.telegram_attribution_canary_retry_runs) then
    raise exception using errcode = 'P0001', message = 'post13d_run_already_exists';
  end if;
  select * into v_scope from public.telegram_canary_scope_freeze
   where singleton_key = 'POST13C' and user_id = p_user_id
   for key share;
  if not found then
    raise exception using errcode = 'P0001', message = 'post13d_scope_unavailable';
  end if;
  select * into v_runtime from public.telegram_canary_runtime_state
   where singleton_key = 'POST13C'
     and state = 'DEACTIVATING'
     and bot_username = 'ContentFactoryLeads_bot'
     and webhook_secret_digest is not null
     and webhook_config_hash is not null
   for key share;
  if not found then
    raise exception using errcode = 'P0001', message = 'post13d_webhook_transport_unavailable';
  end if;
  perform 1
    from public.telegram_attribution_canary_runs r
    join public.telegram_attribution_tokens t on t.id = r.token_id
   where r.singleton_key = 'POST13C' and r.state = 'ROLLED_BACK'
     and t.status = 'REVOKED' and t.destination = 'content_factory_leads_canary';
  if not found then
    raise exception using errcode = 'P0001', message = 'post13c_history_not_terminal';
  end if;
  if exists (
    select 1 from public.telegram_attribution_tokens
     where destination = 'content_factory_leads_canary' and status = 'ACTIVE'
  ) then
    raise exception using errcode = 'P0001', message = 'post13c_stale_active_token';
  end if;
  select sentinel_count, current_hash, matches
    into v_sentinel_count, v_sentinel_hash, v_sentinels_match
    from public.snapshot_content_factory_leads_canary_sentinels();
  if v_sentinel_count <> 2 or not coalesce(v_sentinels_match, false)
     or v_sentinel_hash <> v_scope.sentinel_hash then
    raise exception using errcode = 'P0001', message = 'post13d_main_sentinel_mismatch';
  end if;
  select c.* into v_chat from public.chats c
   where c.id = v_scope.test_chat_id and c.user_id = p_user_id
     and c.telegram_chat_id = v_scope.test_telegram_chat_id
     and c.type = 'channel' and c.id <> v_scope.forbidden_main_chat_id
   for key share;
  if not found then
    raise exception using errcode = 'P0001', message = 'post13d_test_channel_invalid';
  end if;
  insert into public.posts (
    user_id, bot_id, chat_id, format, text, inline_buttons,
    is_silent, disable_link_preview, scheduled_at, status
  ) values (
    p_user_id, v_chat.bot_id, v_chat.id, 'text', p_publication_text, null,
    false, true, now(), 'processing'
  ) returning id into v_post_id;
  select * into v_identity from public.upsert_telegram_creative_identity_mapping(
    p_user_id, p_creative_id, p_source_task_id, p_source_revision_id,
    p_source_hash, p_handoff_id
  );
  if v_identity.platform <> 'telegram' then
    raise exception using errcode = 'P0001', message = 'post13d_identity_not_telegram';
  end if;
  select * into v_publication from public.bind_telegram_creative_publication(
    p_user_id, v_identity.id, v_post_id
  );
  begin
    insert into public.telegram_attribution_tokens (
      user_id, publication_mapping_id, token_digest, token_version, destination
    ) values (
      p_user_id, v_publication.id, p_token_digest, 'cf1',
      'content_factory_leads_canary'
    ) returning id into v_token_id;
  exception when unique_violation then
    raise exception using errcode = '23505', message = 'post13d_token_collision';
  end;
  insert into public.telegram_attribution_canary_retry_runs (
    canary_run_id, stage_key, user_id, bot_username, chat_id, bot_id,
    telegram_chat_id, telegram_post_id, creative_identity_map_id,
    publication_mapping_id, token_id, token_digest, destination,
    bot_credential_digest, webhook_secret_digest, webhook_config_hash,
    sentinel_hash, cta_hash, state
  ) values (
    p_canary_run_id, 'POST13D', p_user_id, 'ContentFactoryLeads_bot',
    v_chat.id, v_chat.bot_id, v_chat.telegram_chat_id, v_post_id,
    v_identity.id, v_publication.id, v_token_id, p_token_digest,
    'content_factory_leads_canary', v_runtime.bot_credential_digest,
    v_runtime.webhook_secret_digest, v_runtime.webhook_config_hash,
    v_scope.sentinel_hash, p_cta_hash, 'PREPARING'
  ) returning * into v_run;
  return v_run;
end;
$$;

create or replace function public.claim_content_factory_leads_canary_retry_delivery(
  p_user_id uuid,
  p_canary_run_id uuid,
  p_delivery_lease_id uuid,
  p_delivery_lease_expires_at timestamptz
)
returns boolean language plpgsql security definer set search_path = '' as $$
declare v_count integer;
begin
  if p_delivery_lease_expires_at is null
     or p_delivery_lease_expires_at <= now()
     or p_delivery_lease_expires_at > now() + interval '3 minutes' then
    return false;
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('POST13D_RUN'));
  update public.telegram_attribution_canary_retry_runs
     set delivery_attempts = 1,
         delivery_lease_id = p_delivery_lease_id,
         delivery_lease_expires_at = p_delivery_lease_expires_at,
         delivery_attempted_at = now(),
         updated_at = now()
   where canary_run_id = p_canary_run_id and user_id = p_user_id
     and stage_key = 'POST13D' and state = 'PREPARING'
     and delivery_attempts = 0;
  get diagnostics v_count = row_count;
  return v_count = 1;
end;
$$;

create or replace function public.finalize_content_factory_leads_canary_retry_delivery(
  p_user_id uuid,
  p_canary_run_id uuid,
  p_delivery_lease_id uuid,
  p_tg_message_id bigint
)
returns boolean language plpgsql security definer set search_path = '' as $$
declare
  v_run public.telegram_attribution_canary_retry_runs;
  v_count integer;
  v_sentinel_count bigint;
  v_sentinels_match boolean;
begin
  if p_tg_message_id <= 0 then return false; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('POST13D_RUN'));
  select * into v_run from public.telegram_attribution_canary_retry_runs
   where canary_run_id = p_canary_run_id and user_id = p_user_id
     and state = 'PREPARING' and delivery_attempts = 1
     and delivery_lease_id = p_delivery_lease_id
     and delivery_lease_expires_at >= now()
   for update;
  if not found then return false; end if;
  select sentinel_count, matches into v_sentinel_count, v_sentinels_match
    from public.snapshot_content_factory_leads_canary_sentinels();
  if v_sentinel_count <> 2 or not coalesce(v_sentinels_match, false) then
    return false;
  end if;
  update public.posts
     set status = 'sent', tg_message_id = p_tg_message_id,
         sent_at = now(), error = null
   where id = v_run.telegram_post_id and user_id = v_run.user_id
     and chat_id = v_run.chat_id and bot_id = v_run.bot_id
     and status = 'processing' and tg_message_id is null;
  get diagnostics v_count = row_count;
  if v_count <> 1 then return false; end if;
  update public.telegram_attribution_canary_retry_runs
     set state = 'ACTIVE', tg_message_id = p_tg_message_id,
         activated_at = now(), updated_at = now()
   where canary_run_id = p_canary_run_id and state = 'PREPARING';
  get diagnostics v_count = row_count;
  return v_count = 1;
end;
$$;

create or replace function public.recover_content_factory_leads_canary_retry_delivery(
  p_user_id uuid
)
returns boolean language plpgsql security definer set search_path = '' as $$
declare
  v_run public.telegram_attribution_canary_retry_runs;
  v_count integer;
begin
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('POST13D_RUN'));
  select * into v_run
    from public.telegram_attribution_canary_retry_runs
   where user_id = p_user_id and stage_key = 'POST13D'
     and state = 'PREPARING' and delivery_attempts = 1
     and delivery_lease_expires_at < now()
   for update;
  if not found then return false; end if;

  update public.telegram_attribution_tokens
     set status = 'REVOKED', revoked_at = coalesce(revoked_at, now())
   where id = v_run.token_id and user_id = v_run.user_id
     and token_digest = v_run.token_digest
     and destination = 'content_factory_leads_canary' and status = 'ACTIVE';
  get diagnostics v_count = row_count;
  if v_count <> 1 then
    raise exception using errcode = 'P0001', message = 'post13d_recovery_token_mismatch';
  end if;

  update public.posts
     set status = 'failed', error = 'POST13D_DELIVERY_AMBIGUOUS'
   where id = v_run.telegram_post_id and user_id = v_run.user_id
     and status = 'processing' and tg_message_id is null;
  get diagnostics v_count = row_count;
  if v_count <> 1 then
    raise exception using errcode = 'P0001', message = 'post13d_recovery_post_mismatch';
  end if;

  update public.telegram_attribution_canary_retry_runs
     set state = 'ROLLBACK_REQUIRED', rollback_reason = 'DELIVERY_AMBIGUOUS',
         updated_at = now()
   where canary_run_id = v_run.canary_run_id and state = 'PREPARING'
     and delivery_attempts = 1 and delivery_lease_id = v_run.delivery_lease_id;
  get diagnostics v_count = row_count;
  if v_count <> 1 then
    raise exception using errcode = 'P0001', message = 'post13d_recovery_run_mismatch';
  end if;
  return true;
end;
$$;

create or replace function public.rollback_content_factory_leads_canary_retry(
  p_user_id uuid,
  p_canary_run_id uuid,
  p_reason text,
  p_proven boolean,
  p_compensation_proof_hash text default null
)
returns boolean language plpgsql security definer set search_path = '' as $$
declare v_run public.telegram_attribution_canary_retry_runs; v_count integer;
begin
  if p_reason not in (
    'DELIVERY_REJECTED', 'DELIVERY_AMBIGUOUS', 'FINALIZE_FAILED',
    'COMPENSATION_UNCERTAIN', 'OWNER_ROLLBACK', 'SECURITY_GATE_FAILED'
  ) or (p_compensation_proof_hash is not null
        and p_compensation_proof_hash !~ '^[0-9a-f]{64}$') then
    return false;
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('POST13D_RUN'));
  select * into v_run from public.telegram_attribution_canary_retry_runs
   where canary_run_id = p_canary_run_id and user_id = p_user_id
     and state in ('PREPARING', 'ACTIVE', 'ROLLBACK_REQUIRED')
   for update;
  if not found then return false; end if;
  update public.telegram_attribution_tokens
     set status = 'REVOKED', revoked_at = coalesce(revoked_at, now())
   where id = v_run.token_id and user_id = v_run.user_id
     and token_digest = v_run.token_digest
     and destination = 'content_factory_leads_canary' and status = 'ACTIVE';
  update public.posts
     set status = 'failed', error = 'POST13D_ROLLBACK'
   where id = v_run.telegram_post_id and user_id = v_run.user_id
     and status in ('processing', 'sent');
  if v_run.state = 'ROLLBACK_REQUIRED' and not p_proven then return true; end if;
  update public.telegram_attribution_canary_retry_runs
     set state = case when p_proven then 'ROLLED_BACK' else 'ROLLBACK_REQUIRED' end,
         rollback_reason = p_reason,
         cta_removal_proof_hash = coalesce(
           p_compensation_proof_hash, cta_removal_proof_hash
         ),
         cta_removed_at = case when p_compensation_proof_hash is not null
                               then coalesce(cta_removed_at, now()) else cta_removed_at end,
         terminal_at = case when p_proven then now() else null end,
         updated_at = now()
   where canary_run_id = p_canary_run_id;
  get diagnostics v_count = row_count;
  return v_count = 1;
end;
$$;

create or replace function public.record_content_factory_leads_retry_bot_start(
  p_token_digest text,
  p_subject_id text,
  p_source_event_id text
)
returns text language plpgsql security definer set search_path = '' as $$
declare v_run public.telegram_attribution_canary_retry_runs;
begin
  if p_token_digest !~ '^[0-9a-f]{64}$'
     or p_subject_id !~ '^subject_[0-9a-f]{64}$'
     or p_source_event_id !~ '^update_[0-9a-f]{64}$' then return 'REJECTED'; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('POST13D_RUN'));
  select r.* into v_run
    from public.telegram_attribution_canary_retry_runs r
    join public.telegram_attribution_tokens t on t.id = r.token_id
   where r.stage_key = 'POST13D' and r.state = 'ACTIVE'
     and t.user_id = r.user_id and t.publication_mapping_id = r.publication_mapping_id
     and t.token_digest = p_token_digest and t.token_digest = r.token_digest
     and t.token_version = 'cf1' and t.destination = r.destination
     and t.status = 'ACTIVE';
  if not found then return 'REJECTED'; end if;
  if exists (
    select 1 from public.telegram_canary_retry_events
     where source_event_id = p_source_event_id
        or (canary_run_id = v_run.canary_run_id and subject_id = p_subject_id
            and event_type = 'BOT_START')
  ) then return 'DUPLICATE'; end if;
  begin
    insert into public.telegram_canary_retry_events (
      canary_run_id, user_id, token_id, token_digest, event_type,
      subject_id, source_event_id, occurred_at, attribution_quality, provenance
    ) values (
      v_run.canary_run_id, v_run.user_id, v_run.token_id, v_run.token_digest,
      'BOT_START', p_subject_id, p_source_event_id, now(), 'DIRECT_LINK',
      jsonb_build_object(
        'policy_version', 'POST13D_ISOLATED_CANARY_RETRY_V1',
        'source_system', 'content_factory_leads_canary_retry', 'test_only', true
      )
    );
  exception when unique_violation then
    return 'DUPLICATE';
  end;
  return 'RECORDED';
end;
$$;

create or replace function public.record_content_factory_leads_retry_canary_lead(
  p_canary_run_id uuid,
  p_subject_id text,
  p_source_event_id text
)
returns text language plpgsql security definer set search_path = '' as $$
declare v_start public.telegram_canary_retry_events; v_run public.telegram_attribution_canary_retry_runs;
begin
  if p_subject_id !~ '^subject_[0-9a-f]{64}$'
     or p_source_event_id !~ '^update_[0-9a-f]{64}$' then return 'REJECTED'; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('POST13D_RUN'));
  select r.* into v_run
    from public.telegram_attribution_canary_retry_runs r
    join public.telegram_attribution_tokens t on t.id = r.token_id
   where r.canary_run_id = p_canary_run_id and r.stage_key = 'POST13D'
     and r.state = 'ACTIVE' and t.id = r.token_id and t.user_id = r.user_id
     and t.token_digest = r.token_digest and t.destination = r.destination
     and t.status = 'ACTIVE';
  if not found then return 'REJECTED'; end if;
  select e.* into v_start from public.telegram_canary_retry_events e
   where e.canary_run_id = v_run.canary_run_id and e.subject_id = p_subject_id
     and e.event_type = 'BOT_START';
  if not found then return 'REJECTED'; end if;
  if exists (
    select 1 from public.telegram_canary_retry_events
     where source_event_id = p_source_event_id
        or (canary_run_id = v_run.canary_run_id and subject_id = p_subject_id
            and event_type = 'CANARY_LEAD_CREATED')
  ) then return 'DUPLICATE'; end if;
  begin
    insert into public.telegram_canary_retry_events (
      canary_run_id, user_id, token_id, token_digest, event_type,
      subject_id, source_event_id, occurred_at, attribution_quality, provenance
    ) values (
      v_run.canary_run_id, v_run.user_id, v_run.token_id, v_run.token_digest,
      'CANARY_LEAD_CREATED', p_subject_id, p_source_event_id, now(),
      'DETERMINISTIC_CANARY',
      jsonb_build_object(
        'policy_version', 'POST13D_ISOLATED_CANARY_RETRY_V1',
        'source_system', 'content_factory_leads_canary_retry', 'test_only', true
      )
    );
  exception when unique_violation then
    return 'DUPLICATE';
  end;
  return 'RECORDED';
end;
$$;

create or replace function public.resolve_content_factory_leads_canary_retry_evidence(
  p_user_id uuid
)
returns table (
  canary_run_id uuid, creative_id text, publication_id uuid,
  token_id uuid, token_digest text, event_id uuid, event_type text,
  subject_id text, occurred_at timestamptz, attribution_quality text, provenance jsonb
)
language sql stable security definer set search_path = '' as $$
  select r.canary_run_id, p.creative_id, r.telegram_post_id,
         r.token_id, r.token_digest, e.id, e.event_type,
         e.subject_id, e.occurred_at, e.attribution_quality, e.provenance
    from public.telegram_attribution_canary_retry_runs r
    join public.creative_telegram_publications p
      on p.id = r.publication_mapping_id and p.user_id = r.user_id
    join public.telegram_canary_retry_events e
      on e.canary_run_id = r.canary_run_id and e.user_id = r.user_id
   where r.user_id = p_user_id and r.stage_key = 'POST13D'
   order by e.occurred_at, e.id
$$;

create or replace function public.complete_content_factory_leads_canary_retry(
  p_user_id uuid,
  p_canary_run_id uuid,
  p_cta_removal_proof_hash text
)
returns boolean language plpgsql security definer set search_path = '' as $$
declare
  v_run public.telegram_attribution_canary_retry_runs;
  v_count integer;
  v_subject_count bigint;
  v_start_count bigint;
  v_lead_count bigint;
  v_order_ok boolean;
  v_sentinel_count bigint;
  v_sentinels_match boolean;
  v_resolution_hash text;
begin
  if p_cta_removal_proof_hash !~ '^[0-9a-f]{64}$' then return false; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('POST13D_RUN'));
  select * into v_run from public.telegram_attribution_canary_retry_runs
   where canary_run_id = p_canary_run_id and user_id = p_user_id
     and stage_key = 'POST13D' and state = 'ACTIVE'
   for update;
  if not found then return false; end if;
  select count(distinct subject_id),
         count(*) filter (where event_type = 'BOT_START'),
         count(*) filter (where event_type = 'CANARY_LEAD_CREATED'),
         min(occurred_at) filter (where event_type = 'BOT_START')
           <= min(occurred_at) filter (where event_type = 'CANARY_LEAD_CREATED')
    into v_subject_count, v_start_count, v_lead_count, v_order_ok
    from public.telegram_canary_retry_events
   where canary_run_id = p_canary_run_id;
  if v_subject_count <> 1 or v_start_count <> 1 or v_lead_count <> 1
     or not coalesce(v_order_ok, false) then return false; end if;
  select sentinel_count, matches into v_sentinel_count, v_sentinels_match
    from public.snapshot_content_factory_leads_canary_sentinels();
  if v_sentinel_count <> 2 or not coalesce(v_sentinels_match, false) then
    return false;
  end if;
  select encode(extensions.digest(convert_to(
           v_run.canary_run_id::text || ':' || p.creative_id || ':' ||
           v_run.publication_mapping_id::text || ':' || v_run.telegram_post_id::text || ':' ||
           v_run.token_id::text || ':' || v_run.token_digest || ':' ||
           string_agg(
             e.id::text || ':' || e.event_type || ':' || e.subject_id || ':' ||
             to_char(e.occurred_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') || ':' ||
             e.attribution_quality || ':' || e.provenance::text,
             '|' order by e.occurred_at, e.id
           ),
           'UTF8'), 'sha256'), 'hex')
    into v_resolution_hash
    from public.creative_telegram_publications p
    join public.telegram_canary_retry_events e
      on e.canary_run_id = v_run.canary_run_id and e.user_id = v_run.user_id
   where p.id = v_run.publication_mapping_id and p.user_id = v_run.user_id
     and p.telegram_post_id = v_run.telegram_post_id
     and p.creative_identity_map_id = v_run.creative_identity_map_id
   group by p.creative_id;
  if v_resolution_hash is null or v_resolution_hash !~ '^[0-9a-f]{64}$' then
    return false;
  end if;
  update public.telegram_attribution_tokens
     set status = 'REVOKED', revoked_at = now()
   where id = v_run.token_id and user_id = v_run.user_id
     and token_digest = v_run.token_digest and status = 'ACTIVE'
     and destination = 'content_factory_leads_canary';
  get diagnostics v_count = row_count;
  if v_count <> 1 then return false; end if;
  update public.telegram_attribution_canary_retry_runs
     set state = 'COMPLETED',
         resolution_hash = v_resolution_hash,
         cta_removal_proof_hash = p_cta_removal_proof_hash,
         cta_removed_at = now(), terminal_at = now(), updated_at = now()
   where canary_run_id = p_canary_run_id and state = 'ACTIVE';
  get diagnostics v_count = row_count;
  return v_count = 1;
end;
$$;

create or replace function public.run_content_factory_leads_canary_retry_negative_check()
returns boolean language plpgsql security definer set search_path = '' as $$
declare
  v_before bigint;
  v_after bigint;
  v_status text;
  v_unknown_digest text;
  v_subject text;
  v_source text;
begin
  select count(*) into v_before from public.telegram_canary_retry_events;
  v_unknown_digest := encode(extensions.digest(convert_to(
    'unknown:' || gen_random_uuid()::text, 'UTF8'), 'sha256'), 'hex');
  v_subject := 'subject_' || encode(extensions.digest(convert_to(
    'negative-subject', 'UTF8'), 'sha256'), 'hex');
  v_source := 'update_' || encode(extensions.digest(convert_to(
    'negative:' || gen_random_uuid()::text, 'UTF8'), 'sha256'), 'hex');
  v_status := public.record_content_factory_leads_retry_bot_start(
    v_unknown_digest, v_subject, v_source
  );
  select count(*) into v_after from public.telegram_canary_retry_events;
  return v_status = 'REJECTED' and v_before = v_after;
end;
$$;

create or replace function public.compute_content_factory_leads_canary_retry_schema_hash()
returns text language sql stable security definer set search_path = '' as $$
  select encode(extensions.digest(convert_to(coalesce(string_agg(item, E'\n' order by item), ''), 'UTF8'), 'sha256'), 'hex')
  from (
    select 'COLUMN:' || c.table_name || '.' || c.ordinal_position || ':' || c.column_name || ':' ||
           c.udt_schema || '.' || c.udt_name || ':' || c.is_nullable || ':' ||
           coalesce(c.column_default, '') || ':' || c.is_identity || ':' || c.is_generated as item
      from information_schema.columns c
     where c.table_schema = 'public' and c.table_name in (
       'telegram_canary_retry_audit_manifest',
       'telegram_attribution_canary_retry_runs', 'telegram_canary_retry_events'
     )
    union all
    select 'CONSTRAINT:' || c.relname || ':' || k.conname || ':' ||
           pg_catalog.pg_get_constraintdef(k.oid, true)
      from pg_catalog.pg_constraint k
      join pg_catalog.pg_class c on c.oid = k.conrelid
      join pg_catalog.pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relname in (
       'telegram_canary_retry_audit_manifest',
       'telegram_attribution_canary_retry_runs', 'telegram_canary_retry_events'
     )
    union all
    select 'INDEX:' || c.relname || ':' || i.relname || ':' || pg_catalog.pg_get_indexdef(i.oid)
      from pg_catalog.pg_index x
      join pg_catalog.pg_class c on c.oid = x.indrelid
      join pg_catalog.pg_class i on i.oid = x.indexrelid
      join pg_catalog.pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relname in (
       'telegram_canary_retry_audit_manifest',
       'telegram_attribution_canary_retry_runs', 'telegram_canary_retry_events'
     )
    union all
    select 'TRIGGER:' || c.relname || ':' || t.tgname || ':' || pg_catalog.pg_get_triggerdef(t.oid, true)
      from pg_catalog.pg_trigger t
      join pg_catalog.pg_class c on c.oid = t.tgrelid
      join pg_catalog.pg_namespace n on n.oid = c.relnamespace
     where not t.tgisinternal and n.nspname = 'public' and c.relname in (
       'telegram_canary_retry_audit_manifest',
       'telegram_attribution_canary_retry_runs', 'telegram_canary_retry_events'
     )
    union all
    select 'POLICY:' || p.tablename || ':' || p.policyname || ':' || p.roles::text || ':' ||
           p.cmd || ':' || coalesce(p.qual, '') || ':' || coalesce(p.with_check, '')
      from pg_catalog.pg_policies p
     where p.schemaname = 'public' and p.tablename in (
       'telegram_canary_retry_audit_manifest',
       'telegram_attribution_canary_retry_runs', 'telegram_canary_retry_events'
     )
    union all
    select 'FUNCTION:' || p.proname || '(' || pg_catalog.pg_get_function_identity_arguments(p.oid) || '):' ||
           pg_catalog.pg_get_functiondef(p.oid) || ':' || coalesce(p.proacl::text, '') || ':' ||
           p.prosecdef::text || ':' || coalesce(p.proconfig::text, '')
      from pg_catalog.pg_proc p
      join pg_catalog.pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname in (
       'block_telegram_canary_retry_mutation', 'guard_telegram_canary_retry_run_mutation',
       'prepare_content_factory_leads_canary_retry',
       'claim_content_factory_leads_canary_retry_delivery',
       'finalize_content_factory_leads_canary_retry_delivery',
       'recover_content_factory_leads_canary_retry_delivery',
       'rollback_content_factory_leads_canary_retry',
       'record_content_factory_leads_retry_bot_start',
       'record_content_factory_leads_retry_canary_lead',
       'resolve_content_factory_leads_canary_retry_evidence',
       'complete_content_factory_leads_canary_retry',
       'run_content_factory_leads_canary_retry_negative_check',
       'compute_content_factory_leads_canary_retry_schema_hash',
       'audit_content_factory_leads_canary_retry'
     )
  ) accepted_boundary
$$;

create or replace function public.audit_content_factory_leads_canary_retry(p_phase text)
returns table (check_name text, passed boolean, row_count bigint, state_hash text, audit_version text)
language plpgsql stable security definer set search_path = '' as $$
begin
  if p_phase not in ('PRE_OWNER', 'ACTIVE_COMPLETE', 'COMPLETED', 'ROLLED_BACK') then
    raise exception using errcode = 'P0001', message = 'post13d_audit_phase_invalid';
  end if;
  return query
  with facts as (
    select
      (select count(*) from public.telegram_attribution_canary_retry_runs) as run_count,
      (select coalesce(max(state), 'NONE') from public.telegram_attribution_canary_retry_runs) as run_state,
      (select count(*) from public.telegram_attribution_canary_retry_runs r
        join public.telegram_attribution_tokens t on t.id = r.token_id) as token_count,
      (select count(*) from public.telegram_attribution_canary_retry_runs r
        join public.telegram_attribution_tokens t on t.id = r.token_id where t.status = 'ACTIVE') as active_token_count,
      (select count(*) from public.telegram_attribution_canary_retry_runs r
        join public.telegram_attribution_tokens t on t.id = r.token_id where t.status = 'REVOKED') as revoked_token_count,
      (select count(*) from public.telegram_attribution_canary_retry_runs r
        join public.posts p on p.id = r.telegram_post_id and p.user_id = r.user_id) as post_count,
      (select count(*) from public.telegram_attribution_canary_retry_runs r
        join public.creative_identity_map m on m.id = r.creative_identity_map_id and m.user_id = r.user_id
        where m.platform = 'telegram') as telegram_identity_count,
      (select count(*) from public.telegram_canary_retry_events where event_type = 'BOT_START') as start_count,
      (select count(*) from public.telegram_canary_retry_events where event_type = 'CANARY_LEAD_CREATED') as lead_count,
      (select count(*) from public.telegram_attribution_canary_retry_runs
        where resolution_hash is not null) as resolution_hash_count,
      (select count(*) from (
        select canary_run_id, subject_id, event_type, count(*)
          from public.telegram_canary_retry_events
         group by canary_run_id, subject_id, event_type having count(*) > 1
      ) d) as duplicate_count,
      (select count(*) from public.telegram_attribution_canary_retry_runs r
        left join public.telegram_attribution_tokens t on t.id = r.token_id
        left join public.creative_telegram_publications p on p.id = r.publication_mapping_id
        left join public.posts x on x.id = r.telegram_post_id
        left join public.telegram_canary_scope_freeze s on s.singleton_key = 'POST13C'
       where t.id is null or p.id is null or x.id is null or s.singleton_key is null
          or t.user_id <> r.user_id or p.user_id <> r.user_id or x.user_id <> r.user_id
          or t.publication_mapping_id <> r.publication_mapping_id
          or p.telegram_post_id <> r.telegram_post_id or p.creative_identity_map_id <> r.creative_identity_map_id
          or t.token_digest <> r.token_digest or t.destination <> r.destination
          or r.chat_id <> s.test_chat_id or r.telegram_chat_id <> s.test_telegram_chat_id
          or r.chat_id = s.forbidden_main_chat_id
          or r.telegram_post_id in (s.sentinel_post_a, s.sentinel_post_b))
      + (select count(*) from public.telegram_canary_retry_events e
          left join public.telegram_attribution_canary_retry_runs r on r.canary_run_id = e.canary_run_id
         where r.canary_run_id is null or e.user_id <> r.user_id
            or e.token_id <> r.token_id or e.token_digest <> r.token_digest) as relation_mismatch_count,
      (select count(*) from public.telegram_attribution_canary_runs r
        join public.telegram_attribution_tokens t on t.id = r.token_id
       where r.singleton_key = 'POST13C' and r.state = 'ROLLED_BACK'
         and t.status = 'REVOKED') as post13c_terminal_count,
      (select count(*) from public.telegram_canary_runtime_state
       where singleton_key = 'POST13C' and state = 'DEACTIVATING') as post13c_nonactive_runtime_count,
      (select count(*) from public.telegram_canary_attribution_events) as post13c_event_count,
      (select count(*) from public.posts p
        join public.telegram_attribution_canary_retry_runs r on r.telegram_post_id = p.id
       where coalesce(p.text, '') ~ 'cf1_[A-Za-z0-9_-]{43}'
          or coalesce(p.inline_buttons::text, '') ~ 'cf1_[A-Za-z0-9_-]{43}') as raw_cf1_count,
      (select count(*) from information_schema.columns
       where table_schema = 'public' and table_name = 'telegram_canary_retry_events'
         and column_name in ('telegram_user_id', 'telegram_chat_id', 'username', 'first_name', 'last_name', 'email', 'phone')) as pii_column_count,
      (select count(*) from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public' and c.relname in (
         'telegram_canary_retry_audit_manifest', 'telegram_attribution_canary_retry_runs',
         'telegram_canary_retry_events') and c.relrowsecurity) as rls_count,
      (select count(*) from pg_catalog.pg_policies p where p.schemaname = 'public'
       and p.tablename in ('telegram_attribution_canary_retry_runs', 'telegram_canary_retry_events')) as policy_count,
      (select count(*) from (values
        ('anon', 'telegram_canary_retry_audit_manifest'), ('authenticated', 'telegram_canary_retry_audit_manifest'), ('service_role', 'telegram_canary_retry_audit_manifest'),
        ('anon', 'telegram_attribution_canary_retry_runs'), ('authenticated', 'telegram_attribution_canary_retry_runs'), ('service_role', 'telegram_attribution_canary_retry_runs'),
        ('anon', 'telegram_canary_retry_events'), ('authenticated', 'telegram_canary_retry_events'), ('service_role', 'telegram_canary_retry_events')
      ) as a(role_name, table_name)
       where pg_catalog.has_table_privilege(a.role_name, 'public.' || a.table_name, 'INSERT')
          or pg_catalog.has_table_privilege(a.role_name, 'public.' || a.table_name, 'UPDATE')
          or pg_catalog.has_table_privilege(a.role_name, 'public.' || a.table_name, 'DELETE')) as acl_violation_count,
      (select count(*) from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and p.prosecdef
         and (p.proname like '%content_factory_leads_canary_retry%'
              or p.proname like '%content_factory_leads_retry%')
         and (pg_catalog.has_function_privilege('anon', p.oid, 'EXECUTE')
              or pg_catalog.has_function_privilege('authenticated', p.oid, 'EXECUTE')
              or not pg_catalog.has_function_privilege('service_role', p.oid, 'EXECUTE'))) as function_acl_violation_count,
      (select encode(extensions.digest(convert_to(coalesce(string_agg(
        canary_run_id::text || ':' || state || ':' || token_id::text || ':' ||
        delivery_attempts::text || ':' || coalesce(tg_message_id::text, '') || ':' ||
        coalesce(resolution_hash, ''),
        '|' order by canary_run_id), ''), 'UTF8'), 'sha256'), 'hex')
       from public.telegram_attribution_canary_retry_runs) as run_hash,
      (select encode(extensions.digest(convert_to(coalesce(string_agg(
        event_type || ':' || subject_id || ':' || source_event_id,
        '|' order by event_type, subject_id, source_event_id), ''), 'UTF8'), 'sha256'), 'hex')
       from public.telegram_canary_retry_events) as event_hash
  ), schema_state as (
    select public.compute_content_factory_leads_canary_retry_schema_hash() as schema_hash,
           max(expected_schema_hash) as expected_schema_hash,
           max(schema_version) as schema_version
      from public.telegram_canary_retry_audit_manifest
     where singleton_key = 'POST13D_AUDIT'
  ), sentinels as (
    select coalesce(max(sentinel_count), 0)::bigint as sentinel_count,
           coalesce(bool_and(matches), false) as matches
      from public.snapshot_content_factory_leads_canary_sentinels()
  ), x as (
    select f.*, s.sentinel_count, s.matches as sentinels_match,
           q.schema_hash, q.expected_schema_hash, q.schema_version,
           encode(extensions.digest(convert_to(
             p_phase || ':' || f.run_state || ':' || f.run_count::text || ':' ||
             f.start_count::text || ':' || f.lead_count::text || ':' ||
             f.resolution_hash_count::text,
             'UTF8'), 'sha256'), 'hex') as phase_hash
      from facts f cross join sentinels s cross join schema_state q
  )
  select 'POST13C_HISTORY', post13c_terminal_count = 1
         and post13c_nonactive_runtime_count = 1 and post13c_event_count = 0,
         post13c_terminal_count, phase_hash, 'POST13D_AUDIT_V1' from x
  union all
  select 'MAIN_SENTINELS', sentinel_count = 2 and sentinels_match,
         sentinel_count, phase_hash, 'POST13D_AUDIT_V1' from x
  union all
  select 'RUN_PHASE', run_count = 1 and (
           (p_phase in ('PRE_OWNER', 'ACTIVE_COMPLETE') and run_state = 'ACTIVE')
           or (p_phase = 'COMPLETED' and run_state = 'COMPLETED')
           or (p_phase = 'ROLLED_BACK' and run_state = 'ROLLED_BACK')),
         run_count, run_hash, 'POST13D_AUDIT_V1' from x
  union all
  select 'TOKEN_PHASE', token_count = 1 and (
           (p_phase in ('PRE_OWNER', 'ACTIVE_COMPLETE') and active_token_count = 1)
           or (p_phase in ('COMPLETED', 'ROLLED_BACK') and revoked_token_count = 1)),
         token_count, run_hash, 'POST13D_AUDIT_V1' from x
  union all
  select 'PUBLICATION_IDENTITY', post_count = 1 and telegram_identity_count = 1,
         post_count, run_hash, 'POST13D_AUDIT_V1' from x
  union all
  select 'BOT_START_PHASE', (
           (p_phase = 'PRE_OWNER' and start_count = 0)
           or (p_phase in ('ACTIVE_COMPLETE', 'COMPLETED') and start_count = 1)
           or (p_phase = 'ROLLED_BACK' and start_count <= 1)),
         start_count, event_hash, 'POST13D_AUDIT_V1' from x
  union all
  select 'CANARY_LEAD_PHASE', (
           (p_phase = 'PRE_OWNER' and lead_count = 0)
           or (p_phase in ('ACTIVE_COMPLETE', 'COMPLETED') and lead_count = 1)
           or (p_phase = 'ROLLED_BACK' and lead_count <= 1)),
         lead_count, event_hash, 'POST13D_AUDIT_V1' from x
  union all
  select 'RESOLUTION_SEALED', (
           (p_phase = 'COMPLETED' and resolution_hash_count = 1)
           or (p_phase <> 'COMPLETED' and resolution_hash_count = 0)),
         resolution_hash_count, run_hash, 'POST13D_AUDIT_V1' from x
  union all
  select 'DUPLICATES', duplicate_count = 0, duplicate_count, event_hash, 'POST13D_AUDIT_V1' from x
  union all
  select 'RELATION_INTEGRITY', relation_mismatch_count = 0, relation_mismatch_count, phase_hash, 'POST13D_AUDIT_V1' from x
  union all
  select 'RAW_CF1_AT_REST', raw_cf1_count = 0, raw_cf1_count, phase_hash, 'POST13D_AUDIT_V1' from x
  union all
  select 'PII_COLUMNS', pii_column_count = 0, pii_column_count, schema_hash, 'POST13D_AUDIT_V1' from x
  union all
  select 'RLS_ENABLED', rls_count = 3, rls_count, schema_hash, 'POST13D_AUDIT_V1' from x
  union all
  select 'OWNER_READ_POLICIES', policy_count = 2, policy_count, schema_hash, 'POST13D_AUDIT_V1' from x
  union all
  select 'WRITE_ACL_VIOLATIONS', acl_violation_count = 0, acl_violation_count, schema_hash, 'POST13D_AUDIT_V1' from x
  union all
  select 'FUNCTION_ACL_VIOLATIONS', function_acl_violation_count = 0, function_acl_violation_count, schema_hash, 'POST13D_AUDIT_V1' from x
  union all
  select 'SCHEMA_HASH', schema_version = 'POST13D_SCHEMA_V1'
         and schema_hash = expected_schema_hash,
         case when schema_hash = expected_schema_hash then 0 else 1 end,
         schema_hash, 'POST13D_AUDIT_V1' from x;
end;
$$;

revoke execute on function public.block_telegram_canary_retry_mutation()
  from public, anon, authenticated;
revoke execute on function public.guard_telegram_canary_retry_run_mutation()
  from public, anon, authenticated;
revoke execute on function public.prepare_content_factory_leads_canary_retry(uuid, uuid, text, text, text, text, text, text, text, text)
  from public, anon, authenticated;
revoke execute on function public.claim_content_factory_leads_canary_retry_delivery(uuid, uuid, uuid, timestamptz)
  from public, anon, authenticated;
revoke execute on function public.finalize_content_factory_leads_canary_retry_delivery(uuid, uuid, uuid, bigint)
  from public, anon, authenticated;
revoke execute on function public.recover_content_factory_leads_canary_retry_delivery(uuid)
  from public, anon, authenticated;
revoke execute on function public.rollback_content_factory_leads_canary_retry(uuid, uuid, text, boolean, text)
  from public, anon, authenticated;
revoke execute on function public.record_content_factory_leads_retry_bot_start(text, text, text)
  from public, anon, authenticated;
revoke execute on function public.record_content_factory_leads_retry_canary_lead(uuid, text, text)
  from public, anon, authenticated;
revoke execute on function public.resolve_content_factory_leads_canary_retry_evidence(uuid)
  from public, anon, authenticated;
revoke execute on function public.complete_content_factory_leads_canary_retry(uuid, uuid, text)
  from public, anon, authenticated;
revoke execute on function public.run_content_factory_leads_canary_retry_negative_check()
  from public, anon, authenticated;
revoke execute on function public.compute_content_factory_leads_canary_retry_schema_hash()
  from public, anon, authenticated;
revoke execute on function public.audit_content_factory_leads_canary_retry(text)
  from public, anon, authenticated;

grant execute on function public.prepare_content_factory_leads_canary_retry(uuid, uuid, text, text, text, text, text, text, text, text)
  to service_role;
grant execute on function public.claim_content_factory_leads_canary_retry_delivery(uuid, uuid, uuid, timestamptz)
  to service_role;
grant execute on function public.finalize_content_factory_leads_canary_retry_delivery(uuid, uuid, uuid, bigint)
  to service_role;
grant execute on function public.recover_content_factory_leads_canary_retry_delivery(uuid)
  to service_role;
grant execute on function public.rollback_content_factory_leads_canary_retry(uuid, uuid, text, boolean, text)
  to service_role;
grant execute on function public.record_content_factory_leads_retry_bot_start(text, text, text)
  to service_role;
grant execute on function public.record_content_factory_leads_retry_canary_lead(uuid, text, text)
  to service_role;
grant execute on function public.resolve_content_factory_leads_canary_retry_evidence(uuid)
  to service_role;
grant execute on function public.complete_content_factory_leads_canary_retry(uuid, uuid, text)
  to service_role;
grant execute on function public.run_content_factory_leads_canary_retry_negative_check()
  to service_role;
grant execute on function public.compute_content_factory_leads_canary_retry_schema_hash()
  to service_role;
grant execute on function public.audit_content_factory_leads_canary_retry(text)
  to service_role;

insert into public.telegram_canary_retry_audit_manifest (
  singleton_key, schema_version, expected_schema_hash
) values (
  'POST13D_AUDIT', 'POST13D_SCHEMA_V1',
  public.compute_content_factory_leads_canary_retry_schema_hash()
);

comment on table public.telegram_attribution_canary_retry_runs is
  'POST-13D independent single-run lifecycle; POST-13C rows are read-only prerequisites.';
comment on table public.telegram_canary_retry_events is
  'POST-13D append-only PII-free test evidence; CANARY_LEAD_CREATED is not Booking or revenue.';
