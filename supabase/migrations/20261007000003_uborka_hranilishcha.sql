-- Ежедневная автоуборка хранилища post-photos по правилу заказчицы (29.09 и
-- 07.10.2026): файл отклонённого или уже вышедшего ролика живёт неделю, потом
-- удаляется. 07.10 разовой уборкой снято 545 файлов / 3,1 ГБ; эта функция не
-- даёт хранилищу накопиться снова.
--
-- Удаляет НЕ эта функция, а Edge Function uborka-hranilishcha через Storage API
-- (прямое удаление строк storage.objects запрещено и оставило бы файлы сиротами).
-- Здесь только список — тот же разбор, что прошёл поимённую проверку 07.10.
--
-- Никогда не трогаются: файлы моложе 14 дней; папка manual/ (её ручные загрузки,
-- ссылок в базе у них не бывает по устройству); candidates/; карточки new и
-- rework; посты, которые ещё не ушли; задел YouTube без youtube_video_id;
-- шаблоны, цепочки, повторы, музыка; идеи new/approved; карточки, которых
-- касались последние 7 дней.

create table if not exists public.uborka_hranilishcha_log (
  id bigserial primary key,
  ran_at timestamptz not null default now(),
  kandidatov int not null,
  udaleno int not null default 0,
  mb numeric not null default 0,
  propusk text,
  puti jsonb
);
alter table public.uborka_hranilishcha_log enable row level security;

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
    union all select storage_path, case when youtube_video_id is null then 'ютуб не выложен' else 'ютуб выложен' end, null from public.youtube_publish_queue
    union all select video_url, case when youtube_video_id is null then 'ютуб не выложен' else 'ютуб выложен' end, null from public.youtube_publish_queue
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
where o.created_at < now() - interval '14 days'
  and o.name not like '%manual/%'
  and o.name not like 'candidates/%'
  and coalesce(o.tronuto, '-infinity') < now() - interval '7 days'
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

-- Раз в сутки, 04:20 МСК (01:20 UTC).
select cron.unschedule(jobid) from cron.job where jobname = 'vibepost-uborka-hranilishcha';
select cron.schedule(
  'vibepost-uborka-hranilishcha',
  '20 1 * * *',
  $$select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name = 'vibepost_project_url') || '/functions/v1/uborka-hranilishcha',
    headers := jsonb_build_object('Content-Type','application/json','Authorization','Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'vibepost_service_key')),
    body := '{}'::jsonb, timeout_milliseconds := 55000)$$
);
