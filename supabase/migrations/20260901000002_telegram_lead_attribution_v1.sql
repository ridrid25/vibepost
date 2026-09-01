-- POST-12: exact Telegram publication identity and opaque attribution-token map.
-- Canonical bookings/outcomes remain source-owned by Meeting Assistant.

alter table public.posts
  add constraint posts_id_user_unique unique (id, user_id);

create table public.creative_telegram_publications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  creative_identity_map_id uuid not null,
  creative_id text not null check (creative_id ~ '^creative-[0-9a-f]{64}$'),
  telegram_post_id uuid not null,
  created_at timestamptz not null default now(),
  foreign key (creative_identity_map_id, user_id)
    references public.creative_identity_map (id, user_id),
  foreign key (telegram_post_id, user_id)
    references public.posts (id, user_id),
  unique (user_id, telegram_post_id),
  unique (id, user_id)
);

create index creative_telegram_publications_creative_lookup
  on public.creative_telegram_publications (user_id, creative_id);

create table public.telegram_attribution_tokens (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  publication_mapping_id uuid not null,
  token_digest text not null unique check (token_digest ~ '^[0-9a-f]{64}$'),
  token_version text not null check (token_version = 'cf1'),
  destination text not null check (destination = 'meeting_assistant'),
  status text not null default 'ACTIVE' check (status in ('ACTIVE', 'REVOKED')),
  created_at timestamptz not null default now(),
  revoked_at timestamptz,
  foreign key (publication_mapping_id, user_id)
    references public.creative_telegram_publications (id, user_id),
  constraint telegram_attribution_token_lifecycle check (
    (status = 'ACTIVE' and revoked_at is null)
    or (status = 'REVOKED' and revoked_at is not null)
  )
);

create unique index telegram_attribution_one_active_destination
  on public.telegram_attribution_tokens (user_id, publication_mapping_id, destination)
  where status = 'ACTIVE';
create index telegram_attribution_owner_lookup
  on public.telegram_attribution_tokens (user_id, created_at, id);

alter table public.creative_telegram_publications enable row level security;
alter table public.telegram_attribution_tokens enable row level security;

create policy "creative_telegram_publication_owner_read"
  on public.creative_telegram_publications for select
  using ((select auth.uid()) = user_id);
create policy "telegram_attribution_token_owner_read"
  on public.telegram_attribution_tokens for select
  using ((select auth.uid()) = user_id);

revoke all on table public.creative_telegram_publications
  from public, anon, authenticated, service_role;
revoke all on table public.telegram_attribution_tokens
  from public, anon, authenticated, service_role;
grant select on table public.creative_telegram_publications
  to authenticated, service_role;
grant select on table public.telegram_attribution_tokens
  to authenticated, service_role;

create or replace function public.block_telegram_publication_mutation()
returns trigger language plpgsql set search_path = '' as $$
begin
  raise exception using errcode = 'P0001', message = 'telegram_publication_mapping_immutable';
end;
$$;

create trigger creative_telegram_publications_immutable
before update or delete on public.creative_telegram_publications
for each row execute function public.block_telegram_publication_mutation();

create or replace function public.guard_telegram_token_mutation()
returns trigger language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' then
    raise exception using errcode = 'P0001', message = 'telegram_attribution_token_immutable';
  end if;
  if old.user_id is distinct from new.user_id
     or old.publication_mapping_id is distinct from new.publication_mapping_id
     or old.token_digest is distinct from new.token_digest
     or old.token_version is distinct from new.token_version
     or old.destination is distinct from new.destination
     or old.created_at is distinct from new.created_at
     or old.status <> 'ACTIVE' or new.status <> 'REVOKED'
     or old.revoked_at is not null or new.revoked_at is null then
    raise exception using errcode = 'P0001', message = 'telegram_attribution_token_immutable';
  end if;
  return new;
end;
$$;

create trigger telegram_attribution_tokens_guard
before update or delete on public.telegram_attribution_tokens
for each row execute function public.guard_telegram_token_mutation();

create or replace function public.bind_telegram_creative_publication(
  p_user_id uuid,
  p_creative_identity_map_id uuid,
  p_telegram_post_id uuid
)
returns public.creative_telegram_publications
language plpgsql security definer set search_path = '' as $$
declare
  v_creative_id text;
  v_current public.creative_telegram_publications;
begin
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtext(p_user_id::text || ':' || p_telegram_post_id::text)
  );
  perform 1 from public.posts p
   where p.id = p_telegram_post_id and p.user_id = p_user_id
   for key share;
  if not found then
    raise exception using errcode = 'P0001', message = 'telegram_publication_unknown';
  end if;
  select m.creative_id into v_creative_id
    from public.creative_identity_map m
   where m.id = p_creative_identity_map_id and m.user_id = p_user_id
   for key share;
  if not found then
    raise exception using errcode = 'P0001', message = 'telegram_publication_identity_unknown';
  end if;

  insert into public.creative_telegram_publications (
    user_id, creative_identity_map_id, creative_id, telegram_post_id
  ) values (
    p_user_id, p_creative_identity_map_id, v_creative_id, p_telegram_post_id
  ) on conflict (user_id, telegram_post_id) do nothing;

  select p.* into strict v_current
    from public.creative_telegram_publications p
   where p.user_id = p_user_id and p.telegram_post_id = p_telegram_post_id;
  if v_current.creative_identity_map_id <> p_creative_identity_map_id
     or v_current.creative_id <> v_creative_id then
    raise exception using errcode = 'P0001', message = 'telegram_publication_identity_conflict';
  end if;
  return v_current;
exception
  when unique_violation or foreign_key_violation or check_violation then
    raise exception using errcode = '23514', message = 'telegram_publication_identity_conflict';
end;
$$;

create or replace function public.register_telegram_attribution_token(
  p_user_id uuid,
  p_publication_mapping_id uuid,
  p_token_digest text,
  p_token_version text,
  p_destination text
)
returns table (token_id uuid, token_status text, registered_digest text, was_created boolean)
language plpgsql security definer set search_path = '' as $$
declare v_existing public.telegram_attribution_tokens;
begin
  if p_token_digest !~ '^[0-9a-f]{64}$'
     or p_token_version <> 'cf1'
     or p_destination <> 'meeting_assistant' then
    raise exception using errcode = 'P0001', message = 'telegram_attribution_token_invalid';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtext(p_user_id::text || ':' || p_publication_mapping_id::text || ':' || p_destination)
  );
  perform 1 from public.creative_telegram_publications p
   where p.id = p_publication_mapping_id and p.user_id = p_user_id
   for key share;
  if not found then
    raise exception using errcode = 'P0001', message = 'telegram_publication_identity_unknown';
  end if;
  select t.* into v_existing
    from public.telegram_attribution_tokens t
   where t.user_id = p_user_id
     and t.publication_mapping_id = p_publication_mapping_id
     and t.destination = p_destination
     and t.status = 'ACTIVE'
   for update;
  if found then
    return query select v_existing.id, v_existing.status, v_existing.token_digest, false;
    return;
  end if;
  begin
    insert into public.telegram_attribution_tokens (
      user_id, publication_mapping_id, token_digest, token_version, destination
    ) values (
      p_user_id, p_publication_mapping_id, p_token_digest, p_token_version, p_destination
    ) returning id, status, token_digest into token_id, token_status, registered_digest;
  exception when unique_violation then
    raise exception using errcode = '23505', message = 'telegram_attribution_digest_collision';
  end;
  was_created := true;
  return next;
end;
$$;

create or replace function public.revoke_telegram_attribution_token(
  p_user_id uuid,
  p_token_id uuid
)
returns boolean language plpgsql security definer set search_path = '' as $$
declare
  v_count integer;
  v_mapping_id uuid;
  v_destination text;
begin
  select t.publication_mapping_id, t.destination
    into v_mapping_id, v_destination
    from public.telegram_attribution_tokens t
   where t.id = p_token_id and t.user_id = p_user_id;
  if not found then return false; end if;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtext(p_user_id::text || ':' || v_mapping_id::text || ':' || v_destination)
  );
  update public.telegram_attribution_tokens
     set status = 'REVOKED', revoked_at = now()
   where id = p_token_id and user_id = p_user_id and status = 'ACTIVE';
  get diagnostics v_count = row_count;
  return v_count = 1;
end;
$$;

create or replace function public.resolve_active_telegram_attribution_token(
  p_token_digest text
)
returns table (
  token_id uuid,
  owner_id uuid,
  creative_id text,
  publication_id uuid,
  token_version text,
  destination text,
  token_status text
)
language sql stable security definer set search_path = '' as $$
  select t.id, t.user_id, p.creative_id, p.telegram_post_id,
         t.token_version, t.destination, t.status
    from public.telegram_attribution_tokens t
    join public.creative_telegram_publications p
      on p.id = t.publication_mapping_id and p.user_id = t.user_id
   where t.token_digest = p_token_digest and t.status = 'ACTIVE'
$$;

revoke execute on function public.bind_telegram_creative_publication(uuid, uuid, uuid)
  from public, anon, authenticated;
revoke execute on function public.register_telegram_attribution_token(uuid, uuid, text, text, text)
  from public, anon, authenticated;
revoke execute on function public.revoke_telegram_attribution_token(uuid, uuid)
  from public, anon, authenticated;
revoke execute on function public.resolve_active_telegram_attribution_token(text)
  from public, anon, authenticated;
grant execute on function public.bind_telegram_creative_publication(uuid, uuid, uuid)
  to service_role;
grant execute on function public.register_telegram_attribution_token(uuid, uuid, text, text, text)
  to service_role;
grant execute on function public.revoke_telegram_attribution_token(uuid, uuid)
  to service_role;
grant execute on function public.resolve_active_telegram_attribution_token(text)
  to service_role;

comment on table public.creative_telegram_publications is
  'POST-12 exact creative identity to existing Telegram posts.id mapping; not a duplicate publication store.';
comment on table public.telegram_attribution_tokens is
  'POST-12 owner-scoped opaque token digests only; raw cf1 payloads are never persisted.';
