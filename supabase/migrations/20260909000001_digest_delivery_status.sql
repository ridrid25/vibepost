-- Дайджест «Коротко за день»: статус по факту доставки, а не по факту нажатия.
--
-- Было: digest-button ставил news_digests.status='posted' сразу после того, как
-- пост встал в очередь. Дошёл он до канала или нет — в таблице не отражалось,
-- проверить доставку было нечем.
--
-- Стало: у дайджеста есть id сообщения в Telegram, текст ошибки и связь с постом,
-- через который он публикуется. Пока пост ждёт своего часа — статус 'queued'.
-- Реальный итог отправки переносит в дайджест триггер, а не догадка.

alter table news_digests
  add column if not exists tg_message_id bigint,
  add column if not exists last_error    text,
  add column if not exists post_id       uuid references posts(id) on delete set null;

-- Триггер ищет дайджест по post_id — без индекса это seq scan на каждый пост.
create index if not exists news_digests_post_id_idx
  on news_digests (post_id) where post_id is not null;

-- 'queued' — решение принято, пост в очереди; 'failed' — Telegram не принял.
alter table news_digests drop constraint if exists news_digests_status_check;
alter table news_digests add constraint news_digests_status_check
  check (status = any (array['draft','queued','posted','skipped','failed']));

-- Планировщик пишет итог отправки в posts. Отсюда он и переезжает в дайджест:
-- 'posted' появляется только вместе с настоящим message_id из ответа Telegram.
create or replace function sync_digest_from_post()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.status = 'sent' then
    update news_digests
       set status = 'posted', tg_message_id = new.tg_message_id, last_error = null
     where post_id = new.id and status <> 'posted';
  elsif new.status = 'failed' then
    -- 'posted' не перетираем: пост могли переотправить руками уже после успеха.
    update news_digests
       set status = 'failed', last_error = new.error
     where post_id = new.id and status <> 'posted';
  end if;
  return new;
end;
$$;

-- Срабатывает только на смене статуса поста: на остальные посты не влияет —
-- у них post_id ни с одним дайджестом не совпадает, и update не делается.
drop trigger if exists posts_sync_digest on posts;
create trigger posts_sync_digest
  after update on posts
  for each row
  when (new.status is distinct from old.status)
  execute function sync_digest_from_post();
