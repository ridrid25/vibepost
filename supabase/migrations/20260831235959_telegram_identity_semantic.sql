-- POST-13A: truthful Telegram creative identity without pretending that a
-- Telegram-only publication is TikTok or YouTube content.

alter table public.creative_identity_map
  drop constraint creative_identity_map_platform_check,
  drop constraint creative_identity_platform_links_check;

alter table public.creative_identity_map
  add constraint creative_identity_map_platform_check
    check (platform in ('tiktok', 'youtube_shorts', 'telegram')),
  add constraint creative_identity_platform_links_check check (
    (platform = 'tiktok' and youtube_short_row_id is null)
    or
    (platform = 'youtube_shorts' and tiktok_video_row_id is null)
    or
    (platform = 'telegram' and tiktok_video_row_id is null
      and youtube_short_row_id is null)
  );

create or replace function public.upsert_telegram_creative_identity_mapping(
  p_user_id uuid,
  p_creative_id text,
  p_source_task_id text,
  p_source_revision_id text,
  p_source_hash text,
  p_handoff_id text
)
returns public.creative_identity_map
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_current public.creative_identity_map;
  v_expected_creative_id text;
begin
  if p_source_task_id !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
     or p_source_revision_id !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
     or p_source_hash !~ '^[0-9a-f]{64}$'
     or p_handoff_id !~ '^handoff-[0-9a-f]{64}$' then
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
    handoff_id, platform
  ) values (
    p_user_id, p_creative_id, p_source_task_id, p_source_revision_id,
    p_source_hash, p_handoff_id, 'telegram'
  )
  on conflict (user_id, handoff_id, platform) do nothing;

  select m.*
    into strict v_current
    from public.creative_identity_map m
   where m.user_id = p_user_id
     and m.handoff_id = p_handoff_id
     and m.platform = 'telegram'
   for update;

  if v_current.creative_id is distinct from p_creative_id
     or v_current.source_task_id is distinct from p_source_task_id
     or v_current.source_revision_id is distinct from p_source_revision_id
     or v_current.source_hash is distinct from p_source_hash
     or v_current.video_idea_id is not null
     or v_current.incoming_video_id is not null
     or v_current.tiktok_video_row_id is not null
     or v_current.youtube_short_row_id is not null then
    raise exception using errcode = 'P0001', message = 'creative_identity_conflict';
  end if;

  return v_current;
exception
  when unique_violation or foreign_key_violation or check_violation then
    raise exception using errcode = '23514', message = 'creative_identity_conflict';
end;
$$;

revoke execute on function public.upsert_telegram_creative_identity_mapping(
  uuid, text, text, text, text, text
) from public, anon, authenticated;
grant execute on function public.upsert_telegram_creative_identity_mapping(
  uuid, text, text, text, text, text
) to service_role;

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
    case
      when m.platform = 'tiktok' then v.tiktok_video_id
      when m.platform = 'youtube_shorts' then s.youtube_id
      else null
    end,
    case
      when m.platform = 'tiktok' then 'video_metric_snapshots+studio_metrics'
      when m.platform = 'youtube_shorts' then 'published_shorts_stats'
      else 'UNSUPPORTED'
    end,
    case
      when m.platform = 'tiktok' then
        (select count(*) from public.video_metric_snapshots vm
          where vm.user_id = m.user_id and vm.video_id = m.tiktok_video_row_id)
      when m.platform = 'youtube_shorts' then
        (select count(*) from public.published_shorts_stats ps
          where ps.short_id = m.youtube_short_row_id)
      else null::bigint
    end,
    case
      when m.platform = 'tiktok' then
        (select count(*) from public.studio_metrics sm
          where sm.user_id = m.user_id and sm.video_id = m.tiktok_video_row_id)
      else null::bigint
    end
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

comment on function public.upsert_telegram_creative_identity_mapping(
  uuid, text, text, text, text, text
) is 'POST-13A truthful Telegram identity anchor; media metrics are unsupported and remain null.';
