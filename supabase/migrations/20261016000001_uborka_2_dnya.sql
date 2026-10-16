-- Уборка хранилища: два дня вместо недели (решение заказчицы 16.10.2026:
-- «убирать будем каждые два дня — сегодня, завтра я подумала, и убирай»).
-- Файл отклонённого или вышедшего ролика живёт 2 дня после последнего касания.
-- Очередь YouTube охраняет файл только 2 дня после своей даты: автозаливка
-- выключена с 07.09, она выкладывает сама с телефона, а строки очереди никто не
-- помечает выложенными — 28 файлов (305 МБ) охранялись вечно и почти довели
-- хранилище до лимита (925 из 1024 МБ 16.10). Остальная защита прежняя:
-- карточки new и rework, неотправленные посты, manual/, шаблоны, музыка.
create or replace function public.spisok_uborki_hranilishcha()
returns table (name text, sz bigint, kat text)
language sql
stable
security definer
set search_path = ''
as $$
with refs as (
  select regexp_replace(u, '[?].*', '') u, why, tronuto from (
    select video_url u, 'пост '||status why, null::timestamptz tronuto from public.posts
    union all select photo_url, 'пост '||status, null from public.posts
    union all select video_url, 'карточка '||status, last_activity_at from public.incoming_videos
    union all select raw_video_url, 'карточка '||status, last_activity_at from public.incoming_videos
    union all select video_url, 'идея '||status, null from public.video_ideas
    union all select storage_path, case when youtube_video_id is null and coalesce(youtube_publish_at, scheduled_at, created_at) > now() - interval '2 days' then 'ютуб не выложен' else 'ютуб выложен' end, null from public.youtube_publish_queue
    union all select video_url, case when youtube_video_id is null and coalesce(youtube_publish_at, scheduled_at, created_at) > now() - interval '2 days' then 'ютуб не выложен' else 'ютуб выложен' end, null from public.youtube_publish_queue
    union all select music_storage_path, 'музыка', null from public.youtube_publish_queue
    union all select video_url, 'шаблон', null from public.message_templates
    union all select photo_url, 'шаблон', null from public.message_templates
    union all select video_url, 'шаблон', null from public.chain_steps
    union all select photo_url, 'шаблон', null from public.chain_steps
    union all select video_url, 'шаблон', null from public.recurring_posts
    union all select photo_url, 'шаблон', null from public.recurring_posts
    union all select storage_path, 'музыка', null from public.music_tracks
    union all select storage_path, 'музыка', null from public.music_candidates
  ) r where u is not null
), o as (
  select ob.name, (ob.metadata->>'size')::bigint sz, ob.created_at,
    (select array_agg(distinct r.why) from refs r where r.u like '%'||ob.name) whys,
    (select max(r.tronuto) from refs r where r.u like '%'||ob.name) tronuto
  from storage.objects ob
  where ob.bucket_id = 'post-photos'
)
select o.name, o.sz,
  case when o.whys is null then 'ни на что не ссылается'
       when 'карточка dismissed' = any(o.whys) then 'отклонённая карточка'
       else 'уже вышел' end
from o
where o.created_at < now() - interval '2 days'
  and o.name not like '%manual/%'
  and o.name not like 'candidates/%'
  and coalesce(o.tronuto, '-infinity') < now() - interval '2 days'
  and not coalesce(o.whys && array['карточка new','карточка rework','ютуб не выложен','шаблон','музыка',
                                   'идея new','идея approved',
                                   'пост scheduled','пост queued','пост processing','пост draft','пост failed'], false)
  and not (
    'карточка scheduled' = any(coalesce(o.whys, '{}'))
    and not exists (
      select 1 from public.posts p join public.incoming_videos iv on p.source_video_id = iv.id
       where p.status = 'sent' and p.tg_message_id is not null
         and (regexp_replace(iv.video_url, '[?].*', '') like '%'||o.name
           or regexp_replace(iv.raw_video_url, '[?].*', '') like '%'||o.name))
  );
$$;
revoke execute on function public.spisok_uborki_hranilishcha() from public, anon, authenticated;
grant execute on function public.spisok_uborki_hranilishcha() to service_role;
