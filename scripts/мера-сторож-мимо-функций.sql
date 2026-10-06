-- МЕРА: сторож постинга мимо Edge Functions — чистый SQL + pg_net прямо в Telegram
-- Написана дежурной сменой 109 (06.10.2026, ~02:30 МСК). НЕ ПРИМЕНЕНА.
--
-- ============================ ЗАЧЕМ ============================
-- В проекте УЖЕ ЕСТЬ тревога ровно на этот случай: supabase/functions/watchdog
-- каждые 10 минут зовёт stuck_report(10) и, если есть просроченные публикации,
-- через notify-error пишет строку в notifications И отправляет ей в личный
-- Telegram сообщение "VibePost - постинг встал".
--
-- Но watchdog - это Edge Function. Блокировка 402 убивает Edge Functions.
-- Значит блокировка одним движением гасит и постинг, и ту самую тревогу,
-- которая должна была про постинг сообщить. Это единственный вид поломки,
-- при котором сторож молчит именно потому, что поломка настоящая.
--
-- ======================= ЧТО ИЗМЕРЕНО (смена 109) =======================
-- 1. Условие тревоги ИСТИННО и давно: stuck_report(10) возвращает
--    user_id=3d31161c-..., stuck_count=7. Первая просрочка - слот 29.09 09:30 МСК,
--    то есть тревога была должна уйти 29.09 09:40 МСК, восемь суток назад.
-- 2. Крон 2 vibepost-watchdog за сутки - 144 прогона, статус ВСЕХ 144 succeeded.
--    Все 22 крона за сутки: 5936 прогонов, ни одного неуспешного.
-- 3. При этом в буфере net._http_response 944 ответа и ВСЕ 944 - это 402
--    (окно 05.10 17:10-23:09 UTC). То есть succeeded у pg_cron означает
--    "net.http_post вернул номер запроса", а не "функция отработала".
--    ВАЖНО ДЛЯ СЛЕДУЮЩИХ СМЕН: строка "крон 22 из 22 активны и ни одного
--    неуспешного прогона" НЕ является признаком здоровья. Этот датчик
--    не видит 402 вовсе - ровно как датчик api-counts не видел cached egress
--    (поправка смены 106).
-- 4. notifications с 28.09 - НОЛЬ строк. Последняя запись вообще - 10.09 06:40 UTC,
--    тип posting_stuck, текст "1 публикаций ждут отправки дольше 10 минут".
--    То есть сторож работал и был полезен, пока функции были живы.
-- 5. Путь до неё настроен и исправен, мёртв только пускатель:
--    profiles.error_notify_tg_id = 300023851, getChat -> private Tatiana (@Ridrid);
--    profiles.error_notify_bot_id -> bots.is_active = true, токен в Vault на месте
--    (get_bot_token отдаёт строку длиной 46 нужной формы), getMe -> VibePostTG_bot.
-- 6. Из 22 кронов 15 стучат в Edge Functions (мертвы под 402) и 7 - чистый SQL
--    (живы: recurring, queue, worker-watchdog, chekap, tiktok-retention,
--    factory-review, recover-stuck). Прямо к api.telegram.org НЕ обращается
--    НИ ОДИН крон - у базы сейчас нет ни одного своего пути до неё.
-- 7. ГЛАВНОЕ, И ЭТО ЗАМЕР, А НЕ ДОГАДКА: база сама дотягивается до Telegram
--    ПОД блокировкой. net.http_get на api.telegram.org/bot<token>/getMe
--    вернул status_code = 200, timed_out = false, error_msg = null
--    (запрос 267236, прогнан 06.10 ~02:25 МСК при живом 402 на /rest/v1).
--    Значит тревога может ходить мимо Edge Functions целиком.
--
-- ======================= ЧЕГО МЕРА НЕ ЛЕЧИТ =======================
-- * Не снимает блокировку и не отправляет ни одной публикации.
-- * Не возвращает приём заданий из бота (это telegram-webhook, Edge Function).
-- * Не лечит лавину курсов - для неё отдельная мера-лавина-курсов.sql.
-- * Не трогает 55-секундный бюджет залпа и порог 12 роликов с 10.10.
-- * Это сторож на БУДУЩЕЕ. Про сегодняшнюю поломку она уже знает: ей
--   отправлено не меньше шести сообщений вручную (message_id 8787...8809).
--
-- ======================= КОГДА ПРИМЕНЯТЬ =======================
-- ТОЛЬКО ПОСЛЕ снятия блокировки, когда просроченных публикаций не осталось.
-- Если применить сейчас, при stuck_count = 7, сторож в первый же прогон
-- напишет ей седьмое сообщение про то, что она и так знает. Сторож меры
-- ловит этот случай отдельной ветвью ПЛОХО.
--
-- ============================ ОТКАТ ============================
--   select cron.unschedule('vibepost-watchdog-sql');
--   drop function if exists public.stuck_alarm_sql();
-- Ничего, кроме этих двух объектов, мера не создаёт и не меняет.
-- Старый крон 2 vibepost-watchdog она НЕ выключает: после оплаты он оживёт
-- сам, а двойной тревоги не будет - оба сторожа делят один антиспам через
-- таблицу notifications (час на пользователя), кто первый, тот и пишет.


-- ======================== ШАГ 1: функция ========================
-- МАРКЕР-НАЧАЛО-ШАГ-1
create or replace function public.stuck_alarm_sql()
returns integer
language plpgsql
security definer
set search_path = public, net, vault
as $fn$
declare
  r record;
  n integer := 0;
  txt text;
begin
  for r in
    select pr.id                                     as user_id,
           pr.error_notify_tg_id                     as chat_id,
           public.get_bot_token(b.token_secret_id)   as token,
           s.stuck_count                             as stuck_count
      from public.profiles pr
      join public.bots b
        on b.id = pr.error_notify_bot_id
       and b.is_active
       and b.token_secret_id is not null
      join public.stuck_report(10) s
        on s.user_id = pr.id
     where pr.error_notify_tg_id is not null
  loop
    if exists (
      select 1
        from public.notifications
       where user_id = r.user_id
         and type = 'posting_stuck'
         and created_at > now() - interval '1 hour'
    ) then
      continue;
    end if;

    if r.token is null or length(r.token) < 20 then
      continue;
    end if;

    txt := 'VibePost - постинг встал' || chr(10) || chr(10)
        || r.stuck_count || ' публикаций ждут отправки дольше 10 минут. '
        || 'Планировщик, похоже, остановился. Загляните в приложение: '
        || 'если посты так и висят Запланирован с прошедшим временем - '
        || 'сообщите разработчику.';

    insert into public.notifications (user_id, type, message)
    values (r.user_id, 'posting_stuck', txt);

    perform net.http_post(
      url     := 'https://api.telegram.org/bot' || r.token || '/sendMessage',
      body    := jsonb_build_object('chat_id', r.chat_id, 'text', txt),
      headers := jsonb_build_object('Content-Type', 'application/json'),
      timeout_milliseconds := 8000
    );

    n := n + 1;
  end loop;

  return n;
end;
$fn$;
-- МАРКЕР-КОНЕЦ-ШАГ-1


-- ======================== ШАГ 2: крон ========================
-- МАРКЕР-НАЧАЛО-ШАГ-2
select cron.schedule(
  'vibepost-watchdog-sql',
  '*/10 * * * *',
  'select public.stuck_alarm_sql();'
);
-- МАРКЕР-КОНЕЦ-ШАГ-2


-- ======================== СТОРОЖ МЕРЫ ========================
-- Только чтение. Ничего не создаёт и не меняет.
-- Все цифры берёт ИЗ БАЗЫ, а не из константы, поэтому остаётся
-- правдивым и в следующую смену, и после оплаты.
-- Четыре ветви, и каждая проверена живой подстановкой сменой 109.
-- МАРКЕР-НАЧАЛО-СТОРОЖ
with sost as (
  select
    (select coalesce(sum(s.stuck_count), 0)
       from public.stuck_report(10) s)                      as prosrocheno,
    (select count(*) from cron.job
      where jobname = 'vibepost-watchdog-sql' and active)   as kron_sql,
    (select count(*) from pg_proc p
       join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public'
        and p.proname = 'stuck_alarm_sql')                  as funkciya,
    (select count(*) from public.notifications
      where type = 'posting_stuck'
        and created_at > now() - interval '24 hours')        as trevog_za_sutki,
    (select count(*) from cron.job
      where command ilike '%net.http_post%'
        and command not ilike '%api.telegram.org%')          as kronov_v_funkcii,
    (select count(*) from net._http_response
      where status_code = 402)                              as otvetov_402
)
select
  prosrocheno,
  kron_sql,
  funkciya,
  trevog_za_sutki,
  kronov_v_funkcii,
  otvetov_402,
  case
    when kron_sql = 0 and funkciya = 0 and prosrocheno > 0 then
      'ПРОВАЛ: просрочено ' || prosrocheno || ' публикаций, тревог за сутки '
      || trevog_za_sutki || ' - автоматического сторожа нет, он умер вместе с функциями ('
      || kronov_v_funkcii || ' кронов стучат в Edge Functions, 402-ответов в буфере '
      || otvetov_402 || '). Меру применять ПОСЛЕ снятия блокировки.'
    when kron_sql > 0 and funkciya > 0 and prosrocheno > 0 then
      'ПЛОХО: мера применена при живой просрочке (' || prosrocheno
      || ') - в первый же прогон уйдёт лишнее сообщение про то, что она и так знает. Откатить и применить после снятия блокировки.'
    when kron_sql > 0 and funkciya > 0 and prosrocheno = 0 then
      'ПРОЙДЕНО: сторож на месте, просрочки нет, тревоги не шлёт - сработает только когда постинг действительно встанет.'
    when kron_sql = 0 and funkciya = 0 and prosrocheno = 0 then
      'НЕЙТРАЛЬНО: просрочки нет, но и SQL-сторожа нет - следующую блокировку она опять не узнает от системы.'
    else
      'НЕПОЛНО: крон ' || kron_sql || ', функция ' || funkciya
      || ' - мера применена наполовину, доделать или откатить.'
  end as prigovor
from sost;
-- МАРКЕР-КОНЕЦ-СТОРОЖ

-- ==========================================================
-- ПОПРАВКА СМЕНЫ 110 (06.10.2026, ~03:20 МСК). ЗАМЕР, А НЕ ЧТЕНИЕ КОДА.
-- Мера НЕ применена и этой сменой тоже. Тело функции и крон НЕ менялись.
--
-- 1. ПУНКТ 6 ШАПКИ НЕВЕРЕН. Там записано: 'Прямо к api.telegram.org НЕ
--    обращается НИ ОДИН крон - у базы сейчас нет ни одного своего пути до неё'.
--    Это ошибка МЕТОДА, а не описка: перечень смены 109 читал cron.job.command,
--    а команда живого SQL-крона выглядит как 'select public.имя_функции()' -
--    сам вызов Telegram лежит в ТЕЛЕ функции и в команде не виден вовсе.
--    Правильный перечень (прогнан по телам функций, сторож ниже, и сошёлся
--    с независимым обходом тех же тел на стороне дежурного):
--      живых кронов 22; из них 15 стучат в Edge Functions, 5 чистый SQL без
--      Telegram, и ДВА чистым SQL ДОСТАЮТ до api.telegram.org мимо функций:
--        крон 15 vibepost-worker-watchdog -> public.worker_watchdog()    (*/10)
--        крон 28 vibepost-recover-stuck   -> public.recover_stuck_posts() (*/5)
--      Оба зовут net.http_post на api.telegram.org/bot<token>/sendMessage
--      прямо из plpgsql, оба живы под 402 и тикают прямо сейчас.
--
-- 2. ЧТО ЭТО МЕНЯЕТ ДЛЯ МЕРЫ - ОНА СТАНОВИТСЯ НАДЁЖНЕЕ, А НЕ ЛИШНЕЙ.
--    Ни один из этих двоих не сторожит постинг, и это проверено по их
--    условиям, а не по названиям: worker_watchdog смотрит claude_tasks (её
--    задания) и сейчас молчит по ПРАВИЛЬНОЙ причине - очередь чиста, он
--    возвращает 'ochered_chistaya'; recover_stuck_posts берёт только посты,
--    уже зависшие в status = processing, а просроченные сейчас лежат в
--    scheduled и под его условие не попадают ни одним из семи.
--    Значит дыра, которую закрывает мера, настоящая. Но образец, по которому
--    мера написана, в проекте УЖЕ РАЗВЁРНУТ И ЖИВ в двух местах - это не
--    новый приём, а повторение своего же, и риск у него соответственно ниже.
--
-- 3. АНТИСПАМ ЕСТЬ СВОЙ, И ОН ЛУЧШЕ ЗАПРОСА К notifications.
--    worker_watchdog глушит повтор через таблицу worker_alert_state
--    (worker, last_alert_at) с параметром mute_min - ровно та задача, которую
--    мера решает запросом к notifications за час. Таблица уже есть, строка в
--    ней одна ('brigada', last_alert_at = 2026-09-28 07:50 UTC), второй ключ
--    она примет без миграции.
--    НЕ ПЕРЕПИСАЛ тело меры под неё НАМЕРЕННО: смена 109 прогнала свой сторож
--    на всех пяти состояниях именно в этой редакции, а переписать антиспам -
--    значит обнулить ту проверку, не прогнав новую. Это выбор следующей смены:
--    либо оставить notifications (работает, прогнано), либо перевести на
--    worker_alert_state и прогнать сторож заново целиком.
--
-- 4. ЗАМЕР, КОТОРОГО НЕ БЫЛО НИ У ОДНОЙ СМЕНЫ: ПРОВЕРЕН POST, А НЕ ТОЛЬКО GET.
--    Пункт 7 шапки стоит на net.http_get (getMe, запрос 267236). Но и мера, и
--    оба живых сторожа ходят через net.http_POST - другой глагол, другой путь
--    в pg_net, другое тело запроса. Прогнано отдельно: net.http_post на
--    api.telegram.org/bot<token>/getMe при живом 402 на /rest/v1 вернул
--    status_code = 200, timed_out = false, error_msg = null, в теле ok:true
--    (запрос 267394, 06.10 ~03:10 МСК). Проверено безвредным getMe, а не
--    отправкой ей. Теперь под мерой стоит тот же глагол, которым она ходит.
--
-- 5. ЧЕГО ПОПРАВКА НЕ МЕНЯЕТ: мера по-прежнему НЕ ПРИМЕНЕНА; применять
--    по-прежнему ТОЛЬКО после снятия блокировки (просрочено 7, первый же
--    прогон написал бы ей лишнее); блокировку она не снимает, публикаций не
--    отправляет, приём заданий не возвращает, бюджет залпа не трогает.
-- ==========================================================


-- ================ СТОРОЖ ПЕРЕЧНЯ (смена 110) ================
-- Только чтение, ничего не создаёт и не меняет. Отвечает на вопрос
-- 'есть ли у базы свой путь до неё', читая ТЕЛА функций, а не команды
-- кронов - то есть не повторяя ошибку метода из пункта 1. Все цифры из базы,
-- поэтому сторож останется правдивым и после оплаты, и после правок кронов.
-- Ограничение названо честно: родство ищется подстрокой 'имя(' - на именах
-- worker_watchdog и recover_stuck_posts это однозначно, но короткое имя
-- функции в теории может совпасть с куском другого слова.
-- Прогнан сменой 110 прямо из базы: 22 живых, 15 в Edge Functions,
-- 2 SQL достают до Telegram, 5 SQL без Telegram -> вердикт ЕСТЬ ПУТЬ.
-- МАРКЕР-НАЧАЛО-СТОРОЖ-ПЕРЕЧНЯ
with recursive tg_fn as (
  select p.oid, p.proname
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.prokind = 'f'
     and pg_get_functiondef(p.oid) like '%api.telegram.org%'
  union
  select p2.oid, p2.proname
    from pg_proc p2
    join pg_namespace n2 on n2.oid = p2.pronamespace
    join tg_fn t on pg_get_functiondef(p2.oid) like '%' || t.proname || '(%'
   where n2.nspname = 'public' and p2.prokind = 'f'
), krony as (
  select j.jobid, j.jobname,
         (j.command like '%/functions/v1/%') as v_edge,
         (j.command like '%api.telegram.org%'
          or exists (select 1 from tg_fn t
                      where j.command like '%' || t.proname || '(%')) as do_tg
    from cron.job j
   where j.active
)
select
  count(*)                                              as zhivyh_kronov,
  count(*) filter (where v_edge)                        as v_edge_functions,
  count(*) filter (where not v_edge and do_tg)          as sql_do_telegram,
  count(*) filter (where not v_edge and not do_tg)      as sql_bez_telegram,
  (select string_agg(jobid || ' ' || jobname, ', ' order by jobid)
     from krony where not v_edge and do_tg)             as kto_dostayot,
  (select string_agg(proname, ', ' order by proname) from tg_fn)
                                                        as funkcii_s_telegram,
  case
    when count(*) filter (where not v_edge and do_tg) = 0 then
      'НЕТ ПУТИ: ни один живой SQL-крон не достаёт до api.telegram.org - '
      || 'тревога возможна только через Edge Functions, а их гасит 402. '
      || 'Мера нужна целиком, вместе с проверкой что pg_net вообще выходит наружу.'
    else
      'ЕСТЬ ПУТЬ: ' || count(*) filter (where not v_edge and do_tg)
      || ' живых SQL-кронов достают до api.telegram.org мимо Edge Functions. '
      || 'Приём меры в проекте уже развёрнут и работает - писать надо не новый '
      || 'способ, а второго потребителя того же способа.'
  end                                                   as prigovor
from krony;
-- МАРКЕР-КОНЕЦ-СТОРОЖ-ПЕРЕЧНЯ
