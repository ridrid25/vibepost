-- МЕРА 2: уборка хранилища до бесплатного предела (1024 МБ).
-- Смена 97, 05.10.2026 08:05 МСК. НЕ ПРИМЕНЕНА. Только по прямому слову заказчицы.
-- Заменяет scripts/мера-уборка-хранилища.sql (мера 1, смена 94) - та НЕИСПРАВНА,
-- см. ниже. Применять надо эту, меру 1 не применять ни в каком виде.
--
-- ====== ЧТО БЫЛО НЕ ТАК С МЕРОЙ 1 (измерено, не предположено) ======
-- Мера 1 обещала в своей же шапке «остаются файлы будущих и неотправленных
-- постов». Сухой прогон меры 1 на живых данных 05.10 08:05 МСК показал обратное:
-- все 7 роликов её просроченных и сегодняшнего постов попали в «УДАЛЯЕТСЯ».
--
--   29.09  Горный козел - Не смотри вниз                УДАЛЯЕТСЯ
--   30.09  Морской слизень - Пищевая цепочка контента   УДАЛЯЕТСЯ
--   01.10  Гиена с чеком - Ваши деньги, наш банкет      УДАЛЯЕТСЯ
--   02.10  Мара и совы - Копай сам                      УДАЛЯЕТСЯ
--   03.10  Гиена - Звериные стратегии пустыни           УДАЛЯЕТСЯ
--   04.10  щитень с гирей - Гиря судьбы                 УДАЛЯЕТСЯ
--   05.10  Птица на свалке - Прибыль пахнет падалью     УДАЛЯЕТСЯ
--
-- ПРИЧИНА. Ссылки в базе несут хвост сброса кеша:
--   .../videos/<uuid>-titry.mp4?v=1789463445443
-- Список «оставить» сверялся шаблоном  u like PCT || o.name , где PCT - одиночный
-- процент без хвостового, то есть шаблон требует, чтобы ссылка КОНЧАЛАСЬ именем
-- файла. Ссылка кончается на ?v=<число>, совпадения нет никогда. Хвост есть у 44
-- живых ссылок из 183: 33 в incoming_videos.video_url и 11 в posts.video_url.
-- Всего мера 1 ошибочно приговаривала 33 объекта / 371 МБ нужного материала.
--
-- И ВТОРОЕ, важнее первого: после починки шаблона мера 1 ПЕРЕСТАЁТ ДОСТИГАТЬ
-- ЦЕЛИ - остаётся 129 объектов / 1171 МБ, то есть ВЫШЕ предела 1024. Её
-- обещанные «801 МБ и запас 223 МБ» достигались ровно за счёт удаления нужных
-- файлов. Поэтому недостаточно поправить шаблон: нужен законный доп. набор.
--
-- ====== ЧТО ДОБАВЛЕНО В МЕРУ 2 ======
-- 1. Хвост отрезается regexp_replace по подстроке от знака вопроса до конца.
-- 2. Удаляются файлы карточек, пост которых УЖЕ ОТПРАВЛЕН (status = sent и
--    tg_message_id не пуст). Telegram держит свою копию ролика у себя, по
--    file_id, и ничего из нашего хранилища для показа в канале ему больше не
--    нужно. Отправленных постов 211, у всех 211 tg_message_id заполнен.
--    Таких карточек 45, они держат 45 титровых копий (505 МБ) и 15 сырых (104 МБ).
--
-- ====== ЧТО ИЗМЕРЕНО ПРЯМО (05.10 08:05 МСК, только чтение) ======
--   мера 1 как есть      -> остаётся  96 /  801 МБ, но 7 её постов уничтожены
--   мера 1 с починкой    -> остаётся 129 / 1171 МБ - цель не достигнута
--   МЕРА 2               -> остаётся  69 /  562 МБ, запас до предела 462 МБ
--   контроль меры 2: все 12 роликов постов scheduled - ОСТАЁТСЯ, 0 удаляется
--
-- ====== ЧЕСТНЫЕ ГРАНИЦЫ (те же, что у меры 1) ======
-- * SQL удаляет строки учёта в storage.objects; файлы в S3 остаются. Считает ли
--   Supabase занятое место по storage.objects или по S3 - под 402 не выяснить:
--   путь /v1/projects/REF/storage/buckets отбивается 402. Это ставка, не гарантия.
-- * Мера снимает только одно нарушение из трёх (exceed_storage_size_quota).
--   Два егрессных - счётчики расчётного периода, уборкой не лечатся.
-- * При оплаченном Pro мера лишняя целиком: там предел хранилища 100 ГБ.
-- Запуск: управляющий API, POST /v1/projects/REF/database/query, по одному шагу.

-- ============== ШАГ 0. СНИМОК (обязательно) ==============
create table if not exists storage_objects_backup_97 as
select * from storage.objects;

select count(*)::int as v_snimke,
       round(sum((metadata->>'size')::bigint)/1048576.0)::int as mb_v_snimke
from storage_objects_backup_97;
-- Ожидается: 634 и 3821. Если меньше - НЕ ПРОДОЛЖАТЬ.

-- ========== ШАГ 1. СУХОЙ ПРОГОН (только чтение) ==========
with zhivoe as (
  select u from (
    select photo_url as u from posts where status in ('scheduled','queued','processing','draft')
    union all select video_url from posts where status in ('scheduled','queued','processing','draft')
    union all select video_url     from incoming_videos where status <> 'dismissed'
    union all select raw_video_url from incoming_videos where status <> 'dismissed'
    union all select video_url from video_ideas where status in ('new','approved')
    union all select storage_path from youtube_publish_queue
    union all select video_url    from youtube_publish_queue
    union all select photo_url from message_templates
    union all select video_url from message_templates
    union all select photo_url from chain_steps
    union all select video_url from chain_steps
    union all select storage_path from music_tracks
  ) z where u is not null
)
select case when exists (select 1 from zhivoe l
                 where regexp_replace(l.u, '[?].*', '') like '%'||o.name)
             and not exists (
                 select 1 from incoming_videos iv join posts p on p.source_video_id = iv.id
                 where p.status = 'sent' and p.tg_message_id is not null
                   and iv.status <> 'dismissed'
                   and (regexp_replace(iv.video_url,     '[?].*', '') like '%'||o.name
                     or regexp_replace(iv.raw_video_url, '[?].*', '') like '%'||o.name)
               ) then 'ОСТАЁТСЯ' else 'УДАЛЯЕТСЯ' end as sudba,
       count(*)::int as objektov,
       round(sum((o.metadata->>'size')::bigint)/1048576.0)::int as mb
from storage.objects o
group by 1 order by 1;
-- Ожидается: ОСТАЁТСЯ 69 / 562, УДАЛЯЕТСЯ 565 / 3259.

-- ==== ШАГ 1Б. КОНТРОЛЬ: ролики её будущих постов должны остаться ====
-- Это та самая проверка, которой не было у меры 1. Прогонять ОБЯЗАТЕЛЬНО.
-- Если вернулась хоть одна строка УДАЛЯЕТСЯ - НЕ ПРИМЕНЯТЬ.
with zhivoe as (
  select u from (
    select photo_url as u from posts where status in ('scheduled','queued','processing','draft')
    union all select video_url from posts where status in ('scheduled','queued','processing','draft')
    union all select video_url     from incoming_videos where status <> 'dismissed'
    union all select raw_video_url from incoming_videos where status <> 'dismissed'
    union all select video_url from video_ideas where status in ('new','approved')
    union all select storage_path from youtube_publish_queue
    union all select video_url    from youtube_publish_queue
    union all select photo_url from message_templates
    union all select video_url from message_templates
    union all select photo_url from chain_steps
    union all select video_url from chain_steps
    union all select storage_path from music_tracks
  ) z where u is not null
), b as (
  select regexp_replace(regexp_replace(p.video_url, '[?].*', ''), '^.*/', '') f
  from posts p where p.status = 'scheduled'
)
select case when exists (select 1 from zhivoe l
                 where regexp_replace(l.u, '[?].*', '') like '%'||o.name)
             and not exists (
                 select 1 from incoming_videos iv join posts p on p.source_video_id = iv.id
                 where p.status = 'sent' and p.tg_message_id is not null
                   and iv.status <> 'dismissed'
                   and (regexp_replace(iv.video_url,     '[?].*', '') like '%'||o.name
                     or regexp_replace(iv.raw_video_url, '[?].*', '') like '%'||o.name)
               ) then 'ОСТАЁТСЯ' else 'УДАЛЯЕТСЯ' end as sudba,
       count(*)::int as n
from b join storage.objects o on regexp_replace(o.name, '^.*/', '') = b.f
group by 1;
-- Ожидается РОВНО одна строка: ОСТАЁТСЯ 12.

-- ==================== ШАГ 2. УБОРКА ====================
-- Запускать ОДНИМ куском: ключ сторожа живёт только внутри своей транзакции.
-- Сперва прогнать как есть, с rollback, сверить числа. Потом заменить на commit.
begin;
set local storage.allow_delete_query = 'true';

delete from storage.objects o
where not (
  exists (
    select 1 from (
      select photo_url as u from posts where status in ('scheduled','queued','processing','draft')
      union all select video_url from posts where status in ('scheduled','queued','processing','draft')
      union all select video_url     from incoming_videos where status <> 'dismissed'
      union all select raw_video_url from incoming_videos where status <> 'dismissed'
      union all select video_url from video_ideas where status in ('new','approved')
      union all select storage_path from youtube_publish_queue
      union all select video_url    from youtube_publish_queue
      union all select photo_url from message_templates
      union all select video_url from message_templates
      union all select photo_url from chain_steps
      union all select video_url from chain_steps
      union all select storage_path from music_tracks
    ) l
    where l.u is not null
      and regexp_replace(l.u, '[?].*', '') like '%'||o.name
  )
  and not exists (
    select 1 from incoming_videos iv join posts p on p.source_video_id = iv.id
    where p.status = 'sent' and p.tg_message_id is not null
      and iv.status <> 'dismissed'
      and (regexp_replace(iv.video_url,     '[?].*', '') like '%'||o.name
        or regexp_replace(iv.raw_video_url, '[?].*', '') like '%'||o.name)
  )
);

select count(*)::int as ostalos,
       round(sum((metadata->>'size')::bigint)/1048576.0)::int as mb_ostalos
from storage.objects;
-- Ожидается: 69 и 562. Если mb_ostalos больше 1024 - rollback, цель не достигнута.

rollback;  -- заменить на commit только после сверки чисел выше

-- ======================== ОТКАТ ========================
-- Столбцы перечислены явно: path_tokens генерируемый, select * при вставке падает.
-- Сторож стоит только на DELETE, на INSERT его нет.
insert into storage.objects (
  id, bucket_id, name, owner, created_at, updated_at, last_accessed_at,
  metadata, version, owner_id, user_metadata, archived_at, is_delete_marker, is_versioned
)
select
  id, bucket_id, name, owner, created_at, updated_at, last_accessed_at,
  metadata, version, owner_id, user_metadata, archived_at, is_delete_marker, is_versioned
from storage_objects_backup_97
where id not in (select id from storage.objects);

select count(*)::int as posle_otkata,
       round(sum((metadata->>'size')::bigint)/1048576.0)::int as mb_posle_otkata
from storage.objects;
-- Ожидается: 634 и 3821.
-- После удачного отката снимок убрать: drop table storage_objects_backup_97;

-- ========== ЖИВОЕ СОСТОЯНИЕ НА 05.10 08:05 МСК ==========
-- бакет post-photos единственный: 634 объекта / 3821 МБ, файлы с 20.07 по 25.09
--   папка 3d31161c-.../incoming  460 объектов / 2014 МБ (сырьё карточек)
--   папка videos/                174 объекта  / 1807 МБ (копии с титрами)
-- карточки incoming_videos: dismissed 322, scheduled 72, new 15, rework 4 (413)
-- посты: отправлено 211 (все с tg_message_id), в расписании 12 (6 просрочены,
--        сегодняшний 09:30 МСК ещё впереди), размер их роликов 82,5 МБ
-- размер базы 571 МБ (в квоту хранилища не входит)
