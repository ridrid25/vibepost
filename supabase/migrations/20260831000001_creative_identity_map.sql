-- POST-03: additive cross-system identity references inside the existing
-- VibePost memory. Metrics remain in their current platform-owned tables.

create extension if not exists pgcrypto with schema extensions;

alter table public.video_ideas
  add constraint video_ideas_id_user_unique unique (id, user_id);
alter table public.incoming_videos
  add constraint incoming_videos_id_user_unique unique (id, user_id);
alter table public.published_shorts
  add constraint published_shorts_id_user_unique unique (id, user_id);

alter table public.incoming_videos
  add constraint incoming_videos_idea_owner_fk
  foreign key (idea_id, user_id) references public.video_ideas (id, user_id);
alter table public.published_shorts
  add constraint published_shorts_idea_owner_fk
  foreign key (idea_id, user_id) references public.video_ideas (id, user_id);
alter table public.published_shorts
  add constraint published_shorts_video_owner_fk
  foreign key (video_id, user_id) references public.incoming_videos (id, user_id);
alter table public.youtube_publish_queue
  add constraint youtube_publish_queue_incoming_owner_fk
  foreign key (incoming_video_id, user_id)
  references public.incoming_videos (id, user_id);

create table public.creative_identity_map (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  creative_id text not null
    check (creative_id ~ '^creative-[0-9a-f]{64}$'),
  source_task_id text not null
    check (source_task_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
  source_revision_id text not null
    check (source_revision_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
  source_hash text not null check (source_hash ~ '^[0-9a-f]{64}$'),
  handoff_id text not null check (handoff_id ~ '^handoff-[0-9a-f]{64}$'),
  platform text not null check (platform in ('tiktok', 'youtube_shorts')),
  video_idea_id uuid,
  incoming_video_id uuid,
  tiktok_video_row_id uuid,
  youtube_short_row_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, handoff_id, platform),
  foreign key (video_idea_id, user_id)
    references public.video_ideas (id, user_id),
  foreign key (incoming_video_id, user_id)
    references public.incoming_videos (id, user_id),
  foreign key (tiktok_video_row_id, user_id)
    references public.videos (id, user_id),
  foreign key (youtube_short_row_id, user_id)
    references public.published_shorts (id, user_id),
  constraint creative_identity_platform_links_check check (
    (platform = 'tiktok' and youtube_short_row_id is null)
    or
    (platform = 'youtube_shorts' and tiktok_video_row_id is null)
  )
);

create unique index creative_identity_idea_platform_unique
  on public.creative_identity_map (user_id, platform, video_idea_id)
  where video_idea_id is not null;
create unique index creative_identity_incoming_platform_unique
  on public.creative_identity_map (user_id, platform, incoming_video_id)
  where incoming_video_id is not null;
create unique index creative_identity_tiktok_publication_unique
  on public.creative_identity_map (user_id, tiktok_video_row_id)
  where tiktok_video_row_id is not null;
create unique index creative_identity_youtube_publication_unique
  on public.creative_identity_map (user_id, youtube_short_row_id)
  where youtube_short_row_id is not null;
create index creative_identity_creative_lookup
  on public.creative_identity_map (user_id, creative_id, platform);

alter table public.creative_identity_map enable row level security;
create policy "creative_identity_owner_read" on public.creative_identity_map
  for select using ((select auth.uid()) = user_id);

revoke all on table public.creative_identity_map
  from public, anon, authenticated, service_role;
grant select on table public.creative_identity_map to authenticated, service_role;

create or replace function public.upsert_creative_identity_mapping(
  p_user_id uuid,
  p_creative_id text,
  p_source_task_id text,
  p_source_revision_id text,
  p_source_hash text,
  p_handoff_id text,
  p_platform text,
  p_video_idea_id uuid default null,
  p_incoming_video_id uuid default null,
  p_tiktok_video_row_id uuid default null,
  p_youtube_short_row_id uuid default null
)
returns public.creative_identity_map
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_current public.creative_identity_map;
  v_expected_creative_id text;
  v_incoming_idea_id uuid;
  v_short_video_id uuid;
  v_short_idea_id uuid;
begin
  if p_source_task_id !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
     or p_source_revision_id !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
     or p_source_hash !~ '^[0-9a-f]{64}$'
     or p_handoff_id !~ '^handoff-[0-9a-f]{64}$'
     or p_platform not in ('tiktok', 'youtube_shorts') then
    raise exception using errcode = 'P0001', message = 'creative_identity_invalid';
  end if;

  v_expected_creative_id := 'creative-' || encode(
    extensions.digest(
      convert_to(
        format(
          '{"domain":"content-factory:creative:v1","source_hash":"%s","source_revision_id":"%s","source_task_id":"%s"}',
          p_source_hash,
          p_source_revision_id,
          p_source_task_id
        ),
        'UTF8'
      ),
      'sha256'
    ),
    'hex'
  );
  if p_creative_id is distinct from v_expected_creative_id then
    raise exception using errcode = 'P0001', message = 'creative_identity_invalid';
  end if;
  if (p_platform = 'tiktok' and p_youtube_short_row_id is not null)
     or (p_platform = 'youtube_shorts' and p_tiktok_video_row_id is not null) then
    raise exception using errcode = 'P0001', message = 'creative_identity_conflict';
  end if;

  if p_youtube_short_row_id is not null then
    select s.video_id, s.idea_id into v_short_video_id, v_short_idea_id
      from public.published_shorts s
     where s.id = p_youtube_short_row_id and s.user_id = p_user_id
     for no key update;
    if not found
       or (p_incoming_video_id is not null and v_short_video_id is not null
           and p_incoming_video_id <> v_short_video_id)
       or (p_video_idea_id is not null and v_short_idea_id is not null
           and p_video_idea_id <> v_short_idea_id) then
      raise exception using errcode = 'P0001', message = 'creative_identity_conflict';
    end if;
    p_incoming_video_id := coalesce(p_incoming_video_id, v_short_video_id);
    p_video_idea_id := coalesce(p_video_idea_id, v_short_idea_id);
  end if;

  if p_incoming_video_id is not null then
    select i.idea_id into v_incoming_idea_id
      from public.incoming_videos i
     where i.id = p_incoming_video_id and i.user_id = p_user_id
     for no key update;
    if not found
       or (p_video_idea_id is not null and v_incoming_idea_id is not null
           and p_video_idea_id <> v_incoming_idea_id) then
      raise exception using errcode = 'P0001', message = 'creative_identity_conflict';
    end if;
    p_video_idea_id := coalesce(p_video_idea_id, v_incoming_idea_id);
  end if;

  if p_video_idea_id is not null then
    perform 1 from public.video_ideas i
     where i.id = p_video_idea_id and i.user_id = p_user_id
     for key share;
    if not found then
      raise exception using errcode = 'P0001', message = 'creative_identity_conflict';
    end if;
  end if;
  if p_tiktok_video_row_id is not null then
    perform 1 from public.videos v
     where v.id = p_tiktok_video_row_id and v.user_id = p_user_id
     for key share;
    if not found then
      raise exception using errcode = 'P0001', message = 'creative_identity_conflict';
    end if;
  end if;

  perform 1
    from public.creative_identity_map m
   where m.user_id = p_user_id and m.creative_id = p_creative_id
   for update;
  if exists (
    select 1
      from public.creative_identity_map m
     where m.user_id = p_user_id
       and m.creative_id = p_creative_id
       and (m.source_task_id, m.source_revision_id, m.source_hash)
           is distinct from
           (p_source_task_id, p_source_revision_id, p_source_hash)
  ) then
    raise exception using errcode = 'P0001', message = 'creative_identity_conflict';
  end if;

  insert into public.creative_identity_map (
    user_id, creative_id, source_task_id, source_revision_id, source_hash,
    handoff_id, platform, video_idea_id, incoming_video_id,
    tiktok_video_row_id, youtube_short_row_id
  ) values (
    p_user_id, p_creative_id, p_source_task_id, p_source_revision_id,
    p_source_hash, p_handoff_id, p_platform, p_video_idea_id,
    p_incoming_video_id, p_tiktok_video_row_id, p_youtube_short_row_id
  )
  on conflict (user_id, handoff_id, platform) do nothing;

  select m.*
    into v_current
    from public.creative_identity_map m
   where m.user_id = p_user_id
     and m.handoff_id = p_handoff_id
     and m.platform = p_platform
   for update;

  if v_current.creative_id is distinct from p_creative_id
     or v_current.source_task_id is distinct from p_source_task_id
     or v_current.source_revision_id is distinct from p_source_revision_id
     or v_current.source_hash is distinct from p_source_hash
     or (p_video_idea_id is not null and v_current.video_idea_id is not null
         and v_current.video_idea_id <> p_video_idea_id)
     or (p_incoming_video_id is not null and v_current.incoming_video_id is not null
         and v_current.incoming_video_id <> p_incoming_video_id)
     or (p_tiktok_video_row_id is not null and v_current.tiktok_video_row_id is not null
         and v_current.tiktok_video_row_id <> p_tiktok_video_row_id)
     or (p_youtube_short_row_id is not null and v_current.youtube_short_row_id is not null
         and v_current.youtube_short_row_id <> p_youtube_short_row_id) then
    raise exception using errcode = 'P0001', message = 'creative_identity_conflict';
  end if;

  update public.creative_identity_map m
     set video_idea_id = coalesce(m.video_idea_id, p_video_idea_id),
         incoming_video_id = coalesce(m.incoming_video_id, p_incoming_video_id),
         tiktok_video_row_id = coalesce(m.tiktok_video_row_id, p_tiktok_video_row_id),
         youtube_short_row_id = coalesce(m.youtube_short_row_id, p_youtube_short_row_id),
         updated_at = case
           when m.video_idea_id is distinct from coalesce(m.video_idea_id, p_video_idea_id)
             or m.incoming_video_id is distinct from coalesce(m.incoming_video_id, p_incoming_video_id)
             or m.tiktok_video_row_id is distinct from coalesce(m.tiktok_video_row_id, p_tiktok_video_row_id)
             or m.youtube_short_row_id is distinct from coalesce(m.youtube_short_row_id, p_youtube_short_row_id)
           then now() else m.updated_at end
   where m.id = v_current.id
  returning m.* into v_current;

  return v_current;
exception
  when unique_violation or foreign_key_violation or check_violation then
    raise exception using errcode = '23514', message = 'creative_identity_conflict';
end;
$$;

revoke execute on function public.upsert_creative_identity_mapping(
  uuid, text, text, text, text, text, text, uuid, uuid, uuid, uuid
) from public, anon, authenticated;
grant execute on function public.upsert_creative_identity_mapping(
  uuid, text, text, text, text, text, text, uuid, uuid, uuid, uuid
) to service_role;

create or replace function public.release_youtube_publication_lineage(p_queue_id uuid)
returns table (
  queue_id uuid,
  owner_id uuid,
  youtube_video_id text,
  title text,
  scheduled_at timestamptz,
  deduplicated boolean
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_queue public.youtube_publish_queue;
  v_short public.published_shorts;
  v_idea_id uuid;
  v_mapping public.creative_identity_map;
  v_inserted boolean := false;
  v_was_published boolean := false;
  v_mapping_found boolean := false;
  v_short_found boolean := false;
begin
  select q.* into v_queue
    from public.youtube_publish_queue q
   where q.id = p_queue_id
   for update;
  if not found or v_queue.status not in ('uploaded', 'published') then
    return;
  end if;
  if v_queue.youtube_video_id is null then
    raise exception using errcode = 'P0001', message = 'youtube_release_lineage_conflict';
  end if;
  if v_queue.status = 'uploaded' and v_queue.scheduled_at > now() then
    return;
  end if;
  v_was_published := v_queue.status = 'published';

  -- Shared lineage rows use one lock order in both POST-03 RPCs:
  -- published_short -> incoming_video -> creative_identity_map.
  select s.* into v_short
    from public.published_shorts s
   where s.youtube_id = v_queue.youtube_video_id
   for no key update;
  v_short_found := found;

  if v_queue.incoming_video_id is not null then
    select i.idea_id into v_idea_id
      from public.incoming_videos i
     where i.id = v_queue.incoming_video_id and i.user_id = v_queue.user_id
     for no key update;
    if not found then
      raise exception using errcode = 'P0001', message = 'youtube_release_lineage_conflict';
    end if;

    select m.* into v_mapping
      from public.creative_identity_map m
     where m.user_id = v_queue.user_id
       and m.platform = 'youtube_shorts'
       and m.incoming_video_id = v_queue.incoming_video_id
     for update;
    v_mapping_found := found;
    if v_mapping_found then
      if v_mapping.video_idea_id is not null and v_idea_id is not null
         and v_mapping.video_idea_id <> v_idea_id then
        raise exception using errcode = 'P0001', message = 'youtube_release_lineage_conflict';
      end if;
      v_idea_id := coalesce(v_idea_id, v_mapping.video_idea_id);
    end if;
  end if;

  if not v_short_found then
    insert into public.published_shorts (
      user_id, youtube_id, title, idea_id, video_id, published_at
    ) values (
      v_queue.user_id, v_queue.youtube_video_id, v_queue.title,
      v_idea_id, v_queue.incoming_video_id, v_queue.scheduled_at
    )
    on conflict (youtube_id) do nothing
    returning * into v_short;
    v_inserted := found;
  end if;

  if not v_inserted then
    if not v_short_found then
      select s.* into v_short
        from public.published_shorts s
       where s.youtube_id = v_queue.youtube_video_id
       for no key update;
    end if;
    if v_short.id is null
       or v_short.user_id <> v_queue.user_id
       or (v_queue.incoming_video_id is not null and v_short.video_id is not null
           and v_short.video_id <> v_queue.incoming_video_id)
       or (v_idea_id is not null and v_short.idea_id is not null
           and v_short.idea_id <> v_idea_id) then
      raise exception using errcode = 'P0001', message = 'youtube_release_lineage_conflict';
    end if;
    update public.published_shorts s
       set video_id = coalesce(s.video_id, v_queue.incoming_video_id),
           idea_id = coalesce(s.idea_id, v_idea_id)
     where s.id = v_short.id
    returning s.* into v_short;
  end if;

  if v_mapping_found then
      if v_mapping.youtube_short_row_id is not null
         and v_mapping.youtube_short_row_id <> v_short.id then
        raise exception using errcode = 'P0001', message = 'youtube_release_lineage_conflict';
      end if;
      update public.creative_identity_map m
         set video_idea_id = coalesce(m.video_idea_id, v_idea_id),
             youtube_short_row_id = coalesce(m.youtube_short_row_id, v_short.id),
             updated_at = case when (m.video_idea_id is null and v_idea_id is not null)
                                    or m.youtube_short_row_id is null
                               then now() else m.updated_at end
       where m.id = v_mapping.id;
  end if;

  if v_queue.status = 'uploaded' then
    update public.youtube_publish_queue q
       set status = 'published', updated_at = now()
     where q.id = v_queue.id;
  end if;

  return query select
    v_queue.id,
    v_queue.user_id,
    v_queue.youtube_video_id,
    v_queue.title,
    v_queue.scheduled_at,
    v_was_published;
exception
  when unique_violation or foreign_key_violation or check_violation then
    raise exception using errcode = '23514', message = 'youtube_release_lineage_conflict';
end;
$$;

revoke execute on function public.release_youtube_publication_lineage(uuid)
  from public, anon, authenticated;
grant execute on function public.release_youtube_publication_lineage(uuid)
  to service_role;

create or replace function public.resolve_creative_metric_lineage(
  p_user_id uuid,
  p_creative_id text,
  p_platform text default null
)
returns table (
  mapping_id uuid,
  handoff_id text,
  platform text,
  external_video_id text,
  metric_store text,
  metric_snapshot_count bigint,
  secondary_metric_count bigint
)
language sql
security definer
set search_path = ''
as $$
  select
    m.id,
    m.handoff_id,
    m.platform,
    case when m.platform = 'tiktok' then v.tiktok_video_id else s.youtube_id end,
    case when m.platform = 'tiktok'
         then 'video_metric_snapshots+studio_metrics'
         else 'published_shorts_stats' end,
    case when m.platform = 'tiktok'
         then (select count(*) from public.video_metric_snapshots vm
                where vm.user_id = m.user_id and vm.video_id = m.tiktok_video_row_id)
         else (select count(*) from public.published_shorts_stats ps
                where ps.short_id = m.youtube_short_row_id) end,
    case when m.platform = 'tiktok'
         then (select count(*) from public.studio_metrics sm
                where sm.user_id = m.user_id and sm.video_id = m.tiktok_video_row_id)
         else null::bigint end
  from public.creative_identity_map m
  left join public.videos v
    on v.id = m.tiktok_video_row_id and v.user_id = m.user_id
  left join public.published_shorts s
    on s.id = m.youtube_short_row_id and s.user_id = m.user_id
  where m.user_id = p_user_id
    and m.creative_id = p_creative_id
    and (p_platform is null or m.platform = p_platform)
  order by m.platform, m.handoff_id;
$$;

revoke execute on function public.resolve_creative_metric_lineage(uuid, text, text)
  from public, anon, authenticated;
grant execute on function public.resolve_creative_metric_lineage(uuid, text, text)
  to service_role;

comment on table public.creative_identity_map is
  'POST-03 identity references only; platform metrics and learning remain in existing VibePost stores.';
