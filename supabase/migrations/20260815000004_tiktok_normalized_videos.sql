-- Canonical TikTok videos and append-only API metric snapshots.
--
-- This schema is based only on the fields observed in the live VibePost
-- /v2/video/query/ response on 2026-08-15. TikTok Studio-only retention,
-- completion, traffic and saves are deliberately absent from this API path.

-- Preserve endpoint provenance even when video/list and video/query return an
-- identical object in the same sync run.
alter table public.tiktok_raw_video_items
  drop constraint if exists tiktok_raw_video_items_sync_run_id_payload_sha256_key;
alter table public.tiktok_raw_video_items
  add constraint tiktok_raw_video_items_sync_endpoint_payload_key
  unique (sync_run_id, endpoint, payload_sha256);

-- A fingerprint is meaningful only for the endpoint whose response produced
-- it. The legacy flat array remains for audit/backward compatibility.
alter table public.tiktok_accounts
  add column verified_endpoint_fingerprints jsonb;

create table public.videos (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  tiktok_account_id uuid not null,
  tiktok_video_id text not null,
  published_at timestamptz,
  title text,
  description text,
  caption text,
  duration_seconds integer check (duration_seconds is null or duration_seconds >= 0),
  width integer check (width is null or width >= 0),
  height integer check (height is null or height >= 0),
  share_url text,
  embed_link text,
  cover_image_url text,
  last_synced_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tiktok_account_id, tiktok_video_id),
  unique (id, user_id),
  foreign key (tiktok_account_id, user_id)
    references public.tiktok_accounts (id, user_id) on delete cascade
);

create index idx_videos_user_published
  on public.videos (user_id, published_at desc);
alter table public.videos enable row level security;
create policy "videos_owner_read" on public.videos
  for select using ((select auth.uid()) = user_id);
create trigger trg_videos_updated_at
  before update on public.videos
  for each row execute function public.set_updated_at();

create table public.video_metric_snapshots (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  tiktok_account_id uuid not null,
  video_id uuid not null,
  sync_run_id uuid not null,
  collected_at timestamptz not null,
  age_hours numeric,
  views bigint check (views is null or views >= 0),
  likes bigint check (likes is null or likes >= 0),
  comments bigint check (comments is null or comments >= 0),
  shares bigint check (shares is null or shares >= 0),
  source text not null default 'api' check (source = 'api'),
  created_at timestamptz not null default now(),
  unique (video_id, sync_run_id),
  foreign key (tiktok_account_id, user_id)
    references public.tiktok_accounts (id, user_id) on delete cascade,
  foreign key (video_id, user_id)
    references public.videos (id, user_id) on delete cascade,
  foreign key (sync_run_id, user_id)
    references public.tiktok_sync_runs (id, user_id) on delete cascade
);

create index idx_video_metric_snapshots_video_time
  on public.video_metric_snapshots (video_id, collected_at desc);
create index idx_video_metric_snapshots_account_time
  on public.video_metric_snapshots (tiktok_account_id, collected_at desc);
alter table public.video_metric_snapshots enable row level security;
create policy "video_metric_snapshots_owner_read" on public.video_metric_snapshots
  for select using ((select auth.uid()) = user_id);

-- The Edge Function sends one normalized video/query batch. The function
-- rechecks both account verification and the exact response fingerprint so a
-- newly changed provider schema cannot enter canonical analytics tables.
create or replace function public.ingest_tiktok_video_snapshots(
  p_account_id uuid,
  p_sync_run_id uuid,
  p_endpoint text,
  p_schema_fingerprint text,
  p_collected_at timestamptz,
  p_items jsonb
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid;
  v_item jsonb;
  v_video_id uuid;
  v_published_at timestamptz;
  v_inserted integer := 0;
  v_rows integer;
begin
  if p_endpoint <> '/v2/video/query/' then
    raise exception 'Only verified TikTok video/query responses can be normalized';
  end if;
  if p_items is null or jsonb_typeof(p_items) <> 'array' then
    raise exception 'TikTok normalized payload must be an array';
  end if;

  select a.user_id
    into v_user_id
    from public.tiktok_accounts a
     where a.id = p_account_id
     and a.schema_status = 'verified'
     and coalesce(a.verified_endpoint_fingerprints->p_endpoint, '[]'::jsonb)
       ? p_schema_fingerprint;
  if v_user_id is null then
    raise exception 'TikTok schema is not verified for normalized writes';
  end if;

  if not exists (
    select 1
      from public.tiktok_sync_runs r
     where r.id = p_sync_run_id
       and r.account_id = p_account_id
       and r.user_id = v_user_id
       and r.status = 'running'
  ) then
    raise exception 'TikTok sync run is not active for this account';
  end if;

  for v_item in select value from jsonb_array_elements(p_items)
  loop
    if jsonb_typeof(v_item) <> 'object'
       or nullif(btrim(v_item->>'tiktok_video_id'), '') is null then
      raise exception 'TikTok normalized video id is missing';
    end if;

    v_published_at := case
      when nullif(v_item->>'published_at', '') is null then null
      else (v_item->>'published_at')::timestamptz
    end;

    insert into public.videos as current_video (
      user_id, tiktok_account_id, tiktok_video_id, published_at, title,
      description, caption, duration_seconds, width, height, share_url,
      embed_link, cover_image_url, last_synced_at
    ) values (
      v_user_id,
      p_account_id,
      v_item->>'tiktok_video_id',
      v_published_at,
      nullif(v_item->>'title', ''),
      nullif(v_item->>'description', ''),
      coalesce(nullif(v_item->>'description', ''), nullif(v_item->>'title', '')),
      case when coalesce(v_item->>'duration_seconds', '') ~ '^\d+$'
        then (v_item->>'duration_seconds')::integer else null end,
      case when coalesce(v_item->>'width', '') ~ '^\d+$'
        then (v_item->>'width')::integer else null end,
      case when coalesce(v_item->>'height', '') ~ '^\d+$'
        then (v_item->>'height')::integer else null end,
      nullif(v_item->>'share_url', ''),
      nullif(v_item->>'embed_link', ''),
      nullif(v_item->>'cover_image_url', ''),
      p_collected_at
    )
    on conflict (tiktok_account_id, tiktok_video_id) do update set
      published_at = coalesce(excluded.published_at, current_video.published_at),
      title = coalesce(excluded.title, current_video.title),
      description = coalesce(excluded.description, current_video.description),
      caption = coalesce(excluded.caption, current_video.caption),
      duration_seconds = coalesce(excluded.duration_seconds, current_video.duration_seconds),
      width = coalesce(excluded.width, current_video.width),
      height = coalesce(excluded.height, current_video.height),
      share_url = coalesce(excluded.share_url, current_video.share_url),
      embed_link = coalesce(excluded.embed_link, current_video.embed_link),
      cover_image_url = coalesce(excluded.cover_image_url, current_video.cover_image_url),
      last_synced_at = excluded.last_synced_at
    returning id, published_at into v_video_id, v_published_at;

    insert into public.video_metric_snapshots (
      user_id, tiktok_account_id, video_id, sync_run_id, collected_at,
      age_hours, views, likes, comments, shares, source
    ) values (
      v_user_id,
      p_account_id,
      v_video_id,
      p_sync_run_id,
      p_collected_at,
      case when v_published_at is null then null
        else extract(epoch from (p_collected_at - v_published_at)) / 3600 end,
      case when coalesce(v_item->>'views', '') ~ '^\d+$'
        then (v_item->>'views')::bigint else null end,
      case when coalesce(v_item->>'likes', '') ~ '^\d+$'
        then (v_item->>'likes')::bigint else null end,
      case when coalesce(v_item->>'comments', '') ~ '^\d+$'
        then (v_item->>'comments')::bigint else null end,
      case when coalesce(v_item->>'shares', '') ~ '^\d+$'
        then (v_item->>'shares')::bigint else null end,
      'api'
    )
    on conflict (video_id, sync_run_id) do nothing;
    get diagnostics v_rows = row_count;
    v_inserted := v_inserted + v_rows;
  end loop;

  return v_inserted;
end;
$$;

revoke execute on function public.ingest_tiktok_video_snapshots(
  uuid, uuid, text, text, timestamptz, jsonb
) from public, anon, authenticated;
grant execute on function public.ingest_tiktok_video_snapshots(
  uuid, uuid, text, text, timestamptz, jsonb
) to service_role;

-- Replace the foundation approval routine with endpoint-scoped evidence.
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
  v_endpoint_fingerprints jsonb;
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

  select coalesce(jsonb_object_agg(grouped.endpoint, grouped.fingerprints), '{}'::jsonb)
    into v_endpoint_fingerprints
    from (
      select f.endpoint,
             to_jsonb(array_agg(distinct f.schema_fingerprint order by f.schema_fingerprint))
               as fingerprints
        from public.tiktok_api_fixtures f
       where f.account_id = p_account_id
         and f.endpoint in ('/v2/video/list/', '/v2/video/query/')
         and f.verified_at is not null
         and f.verified_by = p_reviewer_id
       group by f.endpoint
    ) as grouped;

  update public.tiktok_accounts
     set schema_status = 'verified',
         schema_verified_at = now(),
         schema_verified_by = p_reviewer_id,
         verified_fixture_hashes = v_hashes,
         verified_schema_fingerprints = v_schema_fingerprints,
         verified_endpoint_fingerprints = v_endpoint_fingerprints
   where id = p_account_id and user_id = p_reviewer_id;
  return found;
end;
$$;

revoke execute on function public.approve_tiktok_fixture_schema(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.approve_tiktok_fixture_schema(uuid, uuid) to service_role;

comment on table public.video_metric_snapshots is
  'Append-only TikTok API counts. Saves and TikTok Studio retention/traffic are stored separately when manually supplied.';
