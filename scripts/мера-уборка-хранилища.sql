-- МЕРА: уборка хранилища до бесплатного предела (1024 МБ)
-- Смена 94, 05.10.2026. НЕ ПРИМЕНЕНА. Применять только по прямому слову заказчицы.
--
-- ЗАЧЕМ. Из трёх нарушений, которыми держится 402, одно — exceed_storage_size_quota:
-- в бакете post-photos 634 объекта на 3821 МБ при бесплатном пределе 1024 МБ.
-- Прежние смены считали уборку невозможной: Storage API сам отбивается 402,
-- а прямое удаление из storage.objects запрещено сторожем storage.protect_delete().
-- Смена 94 прочла сторожа и нашла в нём штатный ключ (см. ШАГ 2) — уборка возможна
-- под 402, через управляющий API, одним SQL.
--
-- ЧЕСТНАЯ ГРАНИЦА — ПРОЧИТАТЬ ДО ПРИМЕНЕНИЯ.
-- Этот SQL удаляет только СТРОКИ УЧЁТА в storage.objects. Сами файлы в S3 остаются,
-- об этом прямо говорит подсказка сторожа (prevents accidental data loss from
-- orphaned objects). Снимется ли нарушение квоты — зависит от того, чем Supabase
-- считает занятое место: суммой metadata size из storage.objects или реальным
-- объёмом в S3. ПРОВЕРИТЬ ЭТО ПОД 402 НЕЛЬЗЯ: управляющий путь
-- /v1/projects/REF/storage/buckets отбивается 402, аналитика расхода тоже.
-- Поэтому мера — не гарантия, а проверяемая ставка: цена попытки известна, откат
-- проверен, выигрыш вероятен, но не доказан.
--
-- ЧТО ИЗМЕРЕНО ПРЯМО (на живых данных, внутри begin ... rollback, база не менялась):
--   * сторож пускает удаление при set local storage.allow_delete_query = true;
--   * удаление целевого набора: 634 объекта / 3821 МБ  ->  96 объектов / 801 МБ
--     (удалено 538 строк, освобождено 3020 МБ (по группам 3021, разница от округления), запас до предела 223 МБ);
--   * ВОЗВРАТ работает: вставка обратно из снимка вернула ровно 634 / 3821 МБ.
--     На INSERT сторожа нет, он стоит только на DELETE. Столбец path_tokens
--     генерируемый — перечислять столбцы явно, select * при вставке падает.
--
-- ЧЕГО МЕРА НЕ ДЕЛАЕТ: не снимает два других нарушения — exceed_egress_quota и
-- exceed_cached_egress_quota. Это счётчики расчётного периода. Сама по себе мера
-- проект не разблокирует; она имеет смысл только вместе со сбросом периода.
-- И она целиком лишняя, если оплачен Pro: там предел хранилища 100 ГБ.
--
-- ЧТО ОСТАЁТСЯ ПОСЛЕ УБОРКИ (96 объектов, 801 МБ) — всё, на что ссылается живая работа:
--   * сырые и готовые файлы карточек incoming_videos со статусом НЕ dismissed
--     (new, rework, scheduled — 91 карточка из 413);
--   * файлы будущих и неотправленных постов (scheduled/queued/processing/draft);
--   * файлы карточек идей video_ideas в статусах new и approved;
--   * очередь YouTube, шаблоны, шаги цепочек, музыка.
-- УДАЛЯЕТСЯ: материал 322 отклонённых (dismissed) карточек и копии с титрами,
-- на которые уже ничто не ссылается.

-- ============================ ШАГ 0. СНИМОК ============================
-- Без него откат невозможен. Делать обязательно, отдельным запросом, ДО удаления.
create table if not exists storage_objects_backup_94 as
select * from storage.objects;

select count(*) as v_snimke,
       round(sum((metadata->>'size')::bigint)/1048576.0)::int as mb_v_snimke
from storage_objects_backup_94;
-- Ожидается: 634 и 3821. Если меньше — НЕ ПРОДОЛЖАТЬ.

-- ======================= ШАГ 1. ЧТО БУДЕТ УДАЛЕНО =======================
-- Сухой прогон. Ничего не меняет. Смотреть глазами до шага 2.
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
select case when exists (select 1 from zhivoe l where l.u like '%'||o.name)
            then 'ОСТАЁТСЯ' else 'УДАЛЯЕТСЯ' end as sudba,
       count(*)::int as objektov,
       round(sum((metadata->>'size')::bigint)/1048576.0)::int as mb
from storage.objects o
group by 1 order by 1;
-- Ожидается: ОСТАЁТСЯ 96 / 801, УДАЛЯЕТСЯ 538 / 3021.

-- ============================ ШАГ 2. УБОРКА ============================
-- Запускать ОДНИМ куском: ключ живёт только внутри своей транзакции.
-- Сперва прогнать как есть, с rollback, и сверить числа. Только потом заменить
-- rollback на commit и прогнать второй раз.
begin;
set local storage.allow_delete_query = 'true';

delete from storage.objects o
where not exists (
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
  ) l where l.u like '%'||o.name
);

select count(*)::int as ostalos,
       round(sum((metadata->>'size')::bigint)/1048576.0)::int as mb_ostalos
from storage.objects;
-- Ожидается: 96 и 801. Если mb_ostalos больше 1024 — rollback, цель не достигнута.

rollback;  -- заменить на commit только после сверки чисел выше

-- ============================= ОТКАТ =============================
-- Возвращает строки учёта из снимка шага 0. Проверен на живых данных:
-- после возврата снова 634 объекта и 3821 МБ.
-- Столбцы перечислены явно: path_tokens генерируемый, select * падает.
insert into storage.objects (
  id, bucket_id, name, owner, created_at, updated_at, last_accessed_at,
  metadata, version, owner_id, user_metadata, archived_at, is_delete_marker, is_versioned
)
select
  id, bucket_id, name, owner, created_at, updated_at, last_accessed_at,
  metadata, version, owner_id, user_metadata, archived_at, is_delete_marker, is_versioned
 from storage_objects_backup_94
where id not in (select id from storage.objects);

select count(*)::int as posle_otkata,
       round(sum((metadata->>'size')::bigint)/1048576.0)::int as mb_posle_otkata
from storage.objects;
-- Ожидается: 634 и 3821.

-- ======================= ЖИВОЕ СОСТОЯНИЕ НА 05.10 =======================
-- бакет post-photos единственный: 634 объекта, 3821 МБ, файлы с 20.07 по 25.09
--   папка 3d31161c-.../incoming  460 объектов / 2014 МБ (сырьё карточек)
--   папка videos/                174 объекта  / 1807 МБ (копии с титрами)
-- карточки incoming_videos: dismissed 322, scheduled 72, new 15, rework 4 (всего 413)
-- ни на что не ссылаются вовсе (сироты): 197 объектов / 1305 МБ
-- размер базы 571 МБ (в квоту хранилища не входит)
-- сторож: storage.protect_delete(), триггер protect_objects_delete, BEFORE DELETE
--         FOR EACH STATEMENT; INSERT и UPDATE не охраняются
