-- Тест дайджеста по новостям: всё внутри DO, в конце RAISE EXCEPTION с итогом —
-- транзакция откатывается целиком, ни строки в базе, ни поста в канале.
-- Запуск: через управляющий API (database/query); итог — в тексте ошибки.
do $$
declare
  uid uuid := (select user_id from news_config limit 1);
  лог text := '';
  д uuid; п uuid; r record; n int; m int; x text;
  день date := date '2026-10-20';
  t timestamptz;
  текст6 text := E'Коротко за день\n\n• Новость один про ставки.\n• Новость два про вклады.\n• Новость три про цены.\n• Новость четыре про налоги.\n• Новость пять про пенсии.\n• Новость шесть про тарифы.\n• Седьмая лишняя.';
  провалов int := 0;
begin
  -- ===== G. режим single: одобрение по новостям запрещено =====
  update news_config set digest_mode = 'single' where user_id = uid;
  insert into news_digests (user_id, text) values (uid, текст6) returning id into д;
  begin
    perform digest_approve_items(д, digest_slot_utc(день, '08:46'));
    лог := лог || E'\nG ПРОВАЛ: single пропустил'; провалов := провалов + 1;
  exception when others then лог := лог || E'\nG ок: single отказал';
  end;

  -- ===== A. раннее одобрение, обложки к 09:00, боевой режим =====
  update news_config set digest_mode = 'items' where user_id = uid;
  perform digest_approve_items(д, digest_slot_utc(день, '08:46'));
  perform digest_approve_items(д, digest_slot_utc(день, '08:47'));   -- повторное нажатие
  select count(*) into n from news_digest_items where digest_id = д;
  select count(*) into m from news_digest_publications where digest_id = д;
  лог := лог || format(E'\nA одобрение дважды: новостей %s, публикаций %s (ждём 6/6, седьмая отброшена)', n, m);
  if n <> 6 or m <> 6 then провалов := провалов + 1; end if;

  for r in select id from news_digest_publications where digest_id = д loop
    x := digest_cover_ready(r.id, 'cov-' || r.id, 'content-factory/digest/' || д || '/' || r.id || '.mp4', 'sha', digest_slot_utc(день, '09:00'));
  end loop;
  select id into п from news_digest_publications where digest_id = д and item_order = 1;
  x := digest_cover_ready(п, 'cov-' || п, 'content-factory/digest/x.mp4', 'sha', digest_slot_utc(день, '09:01'));
  лог := лог || E'\nA повтор той же обложки: ' || x;
  x := digest_cover_ready(п, 'чужая', '/etc/passwd', 'sha', digest_slot_utc(день, '09:01'));
  лог := лог || E'\nA путь вне папки: ' || x;

  perform * from digest_dispatch(digest_slot_utc(день, '09:29'));
  select count(*) into n from posts where label like 'DIGEST:' || д || ':%';
  лог := лог || format(E'\nA 09:29 постов %s (ждём 0)', n); if n <> 0 then провалов := провалов + 1; end if;

  perform * from digest_dispatch(digest_slot_utc(день, '09:30'));
  perform * from digest_dispatch(digest_slot_utc(день, '09:30'));      -- повторный тик
  select count(*) into n from posts where label like 'DIGEST:' || д || ':%';
  лог := лог || format(E'\nA 09:30 дважды: постов %s (ждём 1)', n); if n <> 1 then провалов := провалов + 1; end if;

  x := digest_cover_ready(п, 'новая-после-поста', 'content-factory/digest/y.mp4', 'sha', digest_slot_utc(день, '09:31'));
  лог := лог || E'\nA подмена обложки после поста: ' || x;

  update posts set status = 'sent', tg_message_id = 9001, sent_at = digest_slot_utc(день, '09:30') + interval '5 seconds'
   where label = 'DIGEST:' || д || ':1';
  perform * from digest_dispatch(digest_slot_utc(день, '10:30'));
  select count(*) into n from posts where label = 'DIGEST:' || д || ':2';
  лог := лог || format(E'\nA 10:30:00 вторая (ждём 0 — час от факта 09:30:05): %s', n);
  if n <> 0 then провалов := провалов + 1; end if;
  perform * from digest_dispatch(digest_slot_utc(день, '10:30') + interval '6 seconds');
  select count(*) into n from posts where label = 'DIGEST:' || д || ':2';
  select status into x from news_digest_publications where digest_id = д and item_order = 1;
  лог := лог || format(E'\nA 10:30:06 вторая: %s (ждём 1); первая в статусе %s (ждём sent)', n, x);
  if n <> 1 or x <> 'sent' then провалов := провалов + 1; end if;

  perform * from digest_dispatch(digest_slot_utc(день, '14:59'));
  select count(*) into n from posts where label = 'DIGEST:' || д || ':4';
  if n <> 0 then провалов := провалов + 1; end if;
  perform * from digest_dispatch(digest_slot_utc(день, '15:00'));
  select count(*) into n from posts where label = 'DIGEST:' || д || ':4';
  лог := лог || format(E'\nA дневная 15:00: %s (ждём 1)', n); if n <> 1 then провалов := провалов + 1; end if;

  -- ===== B. позднее одобрение 12:10, обложки 12:20 =====
  insert into news_digests (user_id, text) values (uid, текст6) returning id into д;
  perform digest_approve_items(д, digest_slot_utc(день, '12:10'));
  for r in select id from news_digest_publications where digest_id = д loop
    perform digest_cover_ready(r.id, 'c' || r.id, 'content-factory/digest/b.mp4', 's', digest_slot_utc(день, '12:20'));
  end loop;
  perform * from digest_dispatch(digest_slot_utc(день, '12:20'));
  select count(*) into n from posts where label = 'DIGEST:' || д || ':1';
  лог := лог || format(E'\nB позднее: первая в 12:20 по готовности обложки: %s (ждём 1)', n);
  if n <> 1 then провалов := провалов + 1; end if;
  update posts set status = 'sent', tg_message_id = 9101, sent_at = digest_slot_utc(день, '12:20') + interval '30 seconds'
   where label = 'DIGEST:' || д || ':1';
  perform * from digest_dispatch(digest_slot_utc(день, '13:20') + interval '31 seconds');
  select count(*) into n from posts where label = 'DIGEST:' || д || ':2';
  лог := лог || format(E'\nB вторая через час от факта (13:20:31): %s (ждём 1)', n);
  if n <> 1 then провалов := провалов + 1; end if;

  -- ===== C. очень позднее: пересечение с дневной сеткой =====
  insert into news_digests (user_id, text) values (uid, текст6) returning id into д;
  perform digest_approve_items(д, digest_slot_utc(день, '13:40'));
  for r in select id from news_digest_publications where digest_id = д loop
    perform digest_cover_ready(r.id, 'c' || r.id, 'content-factory/digest/c.mp4', 's', digest_slot_utc(день, '13:45'));
  end loop;
  perform * from digest_dispatch(digest_slot_utc(день, '13:45'));
  update posts set status = 'sent', tg_message_id = 9201, sent_at = digest_slot_utc(день, '13:45') where label = 'DIGEST:' || д || ':1';
  perform * from digest_dispatch(digest_slot_utc(день, '14:46'));
  select status into x from news_digest_publications where digest_id = д and item_order = 2;
  select count(*) into n from posts where label = 'DIGEST:' || д || ':2';
  лог := лог || format(E'\nC вторая утренняя ушла бы на 14:45 — статус %s, постов %s (ждём blocked_overlap/0)', x, n);
  if x <> 'blocked_overlap' or n <> 0 then провалов := провалов + 1; end if;

  -- ===== D. обложка опаздывает =====
  insert into news_digests (user_id, text) values (uid, текст6) returning id into д;
  perform digest_approve_items(д, digest_slot_utc(день, '08:40'));
  select count(*) into n from digest_dispatch(digest_slot_utc(день, '09:46')) z where z.action = 'cover_late';
  select count(*) into m from digest_dispatch(digest_slot_utc(день, '09:50')) z where z.action = 'cover_late';
  select count(*) into x from posts where label like 'DIGEST:' || д || ':%';
  лог := лог || format(E'\nD нет обложки: тревога первый раз %s, второй %s (ждём ≥1 и 0); текст без обложки не ушёл', n, m);
  if n < 1 or m <> 0 then провалов := провалов + 1; end if;

  -- ===== E. сухой прогон: постов не бывает =====
  update news_config set digest_mode = 'items_dry' where user_id = uid;
  insert into news_digests (user_id, text) values (uid, текст6) returning id into д;
  perform digest_approve_items(д, digest_slot_utc(день, '08:46'));
  for r in select id from news_digest_publications where digest_id = д loop
    perform digest_cover_ready(r.id, 'c' || r.id, 'content-factory/digest/e.mp4', 's', digest_slot_utc(день, '09:00'));
  end loop;
  perform * from digest_dispatch(digest_slot_utc(день, '18:00'));
  select count(*) into n from posts where label like 'DIGEST:' || д || ':%';
  select count(*) into m from news_digest_publications where digest_id = д and status = 'dry_planned';
  лог := лог || format(E'\nE сухой прогон: постов %s (ждём 0), спланировано %s', n, m);
  if n <> 0 then провалов := провалов + 1; end if;

  -- ===== F. длинная подпись =====
  update news_config set digest_mode = 'items' where user_id = uid;
  insert into news_digests (user_id, text) values (uid, E'Коротко\n\n• ' || repeat('я', 1100)) returning id into д;
  perform digest_approve_items(д, digest_slot_utc(день, '08:46'));
  select status into x from news_digest_publications where digest_id = д;
  лог := лог || E'\nF подпись 1100 знаков: ' || x || ' (ждём blocked_long_caption, текст не режется)';
  if x <> 'blocked_long_caption' then провалов := провалов + 1; end if;

  raise exception 'ИТОГ ТЕСТА: провалов %; %', провалов, лог;
end $$;
