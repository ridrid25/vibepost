-- Спасение постов и шагов цепочек, зависших в статусе processing.
--
-- Причина найдена в логах 10.09.2026: в 06:30:02 UTC PostgREST вернул 504 на
-- PATCH /rest/v1/posts?id=eq.4a99bf2a… (в ту же секунду 504 получили ещё два
-- независимых запроса — был кратковременный затык шлюза). Планировщик результат
-- этого UPDATE не проверял, поэтому пост навсегда остался в processing:
-- без статуса, без ошибки и без уведомления. Сообщение при этом ушло в канал.
--
-- Отсюда два разных случая, и лечить их надо по-разному:
--   1) сообщение УШЛО (в post_analytics есть квитанция с tg_message_id) —
--      чиним только статус, повторно НЕ отправляем;
--   2) сообщение не ушло (квитанции нет) — возвращаем в очередь на повтор,
--      а после max_retries попыток помечаем failed и уведомляем владельца.

-- Отметка о захвате: без неё сторож не отличает «взяли минуту назад и сейчас
-- отправляем» от «взяли и бросили». Считать давность по scheduled_at нельзя:
-- пост из старой очереди захватывается уже просроченным, и сторож немедленно
-- отправил бы его повторно.
alter table posts              add column if not exists claimed_at timestamptz;
alter table active_chain_steps add column if not exists claimed_at timestamptz;

create or replace function public.claim_due_posts(p_limit integer default 25)
returns setof posts
language sql
security definer
set search_path to ''
as $fn$
  with due as (
    select id from public.posts
    where status = 'scheduled' and scheduled_at <= now()
    order by scheduled_at, format, created_at
    limit p_limit
    for update skip locked
  )
  update public.posts p
  set status = 'processing', claimed_at = now()
  from due
  where p.id = due.id
  returning p.*;
$fn$;

create or replace function public.claim_due_chain_steps(p_limit integer default 25)
returns table(id uuid, active_chain_id uuid, user_id uuid, bot_id uuid, chat_id uuid,
              retry_count integer, format text, text text, photo_url text, video_url text,
              video_autoplay boolean, poll_question text, poll_options jsonb,
              poll_anonymous boolean, inline_buttons jsonb, is_silent boolean,
              disable_link_preview boolean)
language sql
security definer
set search_path to ''
as $fn$
  with due as (
    select acs.id
    from public.active_chain_steps acs
    join public.active_chains ac on ac.id = acs.active_chain_id
    where acs.status = 'scheduled'
      and acs.scheduled_at <= now()
      and ac.status = 'running'
    order by acs.scheduled_at
    limit p_limit
    for update of acs skip locked
  ),
  claimed as (
    update public.active_chain_steps s
    set status = 'processing', claimed_at = now()
    from due
    where s.id = due.id
    returning s.id, s.active_chain_id, s.step_id, s.retry_count
  )
  select
    c.id,
    c.active_chain_id,
    ac.user_id,
    ac.bot_id,
    ac.chat_id,
    c.retry_count,
    case when cs.template_id is not null then t.format else cs.format end,
    case when cs.template_id is not null then t.text else cs.text end,
    case when cs.template_id is not null then t.photo_url else cs.photo_url end,
    case when cs.template_id is not null then t.video_url else cs.video_url end,
    case when cs.template_id is not null then t.video_autoplay else cs.video_autoplay end,
    case when cs.template_id is not null then t.poll_question else cs.poll_question end,
    case when cs.template_id is not null then t.poll_options else cs.poll_options end,
    case when cs.template_id is not null then t.poll_anonymous else cs.poll_anonymous end,
    case when cs.template_id is not null then t.inline_buttons else cs.inline_buttons end,
    case when cs.template_id is not null then t.is_silent else cs.is_silent end,
    case when cs.template_id is not null then t.disable_link_preview else cs.disable_link_preview end
  from claimed c
  join public.active_chains ac on ac.id = c.active_chain_id
  join public.chain_steps cs on cs.id = c.step_id
  left join public.message_templates t on t.id = cs.template_id;
$fn$;

create or replace function public.recover_stuck_posts(
  stale_min   int default 5,
  max_retries int default 3
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_cut timestamptz := now() - make_interval(mins => stale_min);
  v_healed_posts int := 0; v_requeued_posts int := 0; v_failed_posts int := 0;
  v_healed_steps int := 0; v_requeued_steps int := 0; v_failed_steps int := 0;
  v_chat text; v_bot uuid; v_token text; v_msg text;
begin
  ---------------------------------------------------------------- посты
  -- 1a. Доставлено, но статус не записался → лечим по квитанции
  with fixed as (
    update posts p
       set status        = 'sent',
           tg_message_id = coalesce(p.tg_message_id, pa.tg_message_id),
           sent_at       = coalesce(p.sent_at, pa.updated_at),
           error         = null
      from post_analytics pa
     where pa.post_id = p.id
       and p.status = 'processing'
       and coalesce(p.claimed_at, p.scheduled_at) < v_cut
    returning p.id
  ) select count(*) into v_healed_posts from fixed;

  -- 1b. Не доставлено, попытки ещё есть → обратно в очередь
  with requeued as (
    update posts p
       set status      = 'scheduled',
           retry_count = coalesce(p.retry_count, 0) + 1,
           error       = 'Отправка оборвалась на полпути — повтор сторожем'
     where p.status = 'processing'
       and coalesce(p.claimed_at, p.scheduled_at) < v_cut
       and coalesce(p.retry_count, 0) + 1 < max_retries
       and not exists (select 1 from post_analytics pa where pa.post_id = p.id)
    returning p.id
  ) select count(*) into v_requeued_posts from requeued;

  -- 1c. Попытки исчерпаны → failed + запись в уведомления
  with dead as (
    update posts p
       set status = 'failed',
           error  = 'Отправка оборвалась на полпути, попытки исчерпаны'
     where p.status = 'processing'
       and coalesce(p.claimed_at, p.scheduled_at) < v_cut
       and coalesce(p.retry_count, 0) + 1 >= max_retries
       and not exists (select 1 from post_analytics pa where pa.post_id = p.id)
    returning p.id, p.user_id
  ),
  noted as (
    insert into notifications (user_id, type, message)
    select d.user_id, 'post_failed',
           'Пост завис на отправке и не ушёл в канал. Попытки исчерпаны — откройте его и отправьте заново.'
      from dead d
    returning 1
  ) select count(*) into v_failed_posts from noted;

  ------------------------------------------------------- шаги цепочек
  with fixed as (
    update active_chain_steps s
       set status        = 'sent',
           tg_message_id = coalesce(s.tg_message_id, pa.tg_message_id),
           sent_at       = coalesce(s.sent_at, pa.updated_at),
           error         = null
      from post_analytics pa
     where pa.active_chain_step_id = s.id
       and s.status = 'processing'
       and coalesce(s.claimed_at, s.scheduled_at) < v_cut
    returning s.id
  ) select count(*) into v_healed_steps from fixed;

  with requeued as (
    update active_chain_steps s
       set status      = 'scheduled',
           retry_count = coalesce(s.retry_count, 0) + 1,
           error       = 'Отправка оборвалась на полпути — повтор сторожем'
     where s.status = 'processing'
       and coalesce(s.claimed_at, s.scheduled_at) < v_cut
       and coalesce(s.retry_count, 0) + 1 < max_retries
       and not exists (select 1 from post_analytics pa where pa.active_chain_step_id = s.id)
    returning s.id
  ) select count(*) into v_requeued_steps from requeued;

  with dead as (
    update active_chain_steps s
       set status = 'failed',
           error  = 'Отправка оборвалась на полпути, попытки исчерпаны'
     where s.status = 'processing'
       and coalesce(s.claimed_at, s.scheduled_at) < v_cut
       and coalesce(s.retry_count, 0) + 1 >= max_retries
       and not exists (select 1 from post_analytics pa where pa.active_chain_step_id = s.id)
    returning s.id, s.active_chain_id
  ),
  noted as (
    insert into notifications (user_id, type, message)
    select ac.user_id, 'chain_failed',
           'Шаг цепочки «' || coalesce(ch.name, 'без имени')
             || '» завис на отправке и не ушёл. Попытки исчерпаны.'
      from dead d
      join active_chains ac on ac.id = d.active_chain_id
      left join message_chains ch on ch.id = ac.chain_id
    returning 1
  ) select count(*) into v_failed_steps from noted;

  ------------------------------------------------------------ сигнал
  -- Про молчаливые потери владелец должен узнать сразу, а не через неделю.
  if v_failed_posts + v_failed_steps > 0 then
    select p.error_notify_tg_id, p.error_notify_bot_id into v_chat, v_bot
      from profiles p where p.error_notify_tg_id is not null limit 1;

    if v_chat is not null then
      select v.decrypted_secret into v_token
        from bots b join vault.decrypted_secrets v on v.id = b.token_secret_id
       where b.id = v_bot;

      if v_token is not null then
        v_msg := '🔴 Отправка оборвалась на полпути.' || chr(10) || chr(10)
              || 'Не ушло и больше не повторится: '
              || (v_failed_posts + v_failed_steps) || '.' || chr(10)
              || 'Откройте VibePost и отправьте заново.';
        perform net.http_post(
          url     := 'https://api.telegram.org/bot' || v_token || '/sendMessage',
          headers := jsonb_build_object('Content-Type', 'application/json'),
          body    := jsonb_build_object('chat_id', v_chat, 'text', v_msg)
        );
      end if;
    end if;
  end if;

  return jsonb_build_object(
    'posts', jsonb_build_object('healed', v_healed_posts,
                                'requeued', v_requeued_posts,
                                'failed', v_failed_posts),
    'steps', jsonb_build_object('healed', v_healed_steps,
                                'requeued', v_requeued_steps,
                                'failed', v_failed_steps)
  );
end;
$$;

revoke all on function public.recover_stuck_posts(int, int) from public, anon, authenticated;

-- Сторож ходит раз в пять минут: реже — и просроченный пост ждёт слишком долго,
-- чаще — незачем, планировщик и так дёргается каждую минуту.
select cron.schedule('vibepost-recover-stuck', '*/5 * * * *',
                     $cron$ select public.recover_stuck_posts(); $cron$);
