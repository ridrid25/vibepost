-- Ход работы: одна строка на одно дело, которое идёт прямо сейчас.
--
-- Зачем. Пока бригада пишет промт, окно разговора молчит по пятнадцать минут,
-- и Татьяна не может отличить работу от зависшего компьютера. Отсутствие
-- ответа — единственный признак поломки, который у неё есть, поэтому молчание
-- читается как поломка. Теперь у дела есть строка: этапы, текущий шаг и время
-- последнего движения. Её показывает и бот, и приложение.
--
-- Полосу двигает приёмник: он и так опрашивает базу каждые пять секунд,
-- а Claude в это время занят и обновлять ничего не может.

create table if not exists public.work_progress (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references auth.users(id) on delete cascade,
  title        text not null,                 -- «Промт ролика: комар»
  stages       text[] not null,               -- {сценарист,режиссёр,оператор,критик}
  step         int  not null default 0,       -- сколько этапов позади
  note         text,                          -- что именно делается сейчас
  tg_message_id bigint,                       -- сообщение в боте, которое правим
  started_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  done_at      timestamptz,                   -- null = идёт прямо сейчас
  outcome      text                           -- «готово» | «отменено» | текст ошибки
);

create index if not exists work_progress_open_idx
  on public.work_progress (user_id, started_at desc) where done_at is null;

alter table public.work_progress enable row level security;

drop policy if exists "свои строки хода работы" on public.work_progress;
create policy "свои строки хода работы" on public.work_progress
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- Приложение слушает изменения и двигает полосу без перезагрузки страницы.
alter publication supabase_realtime add table public.work_progress;

-- Realtime отдаёт обновления надёжно только при полной replica identity:
-- иначе в событии приходит один лишь первичный ключ, и проверка прав по
-- user_id для UPDATE и DELETE выполняется вслепую. Полоса в приложении
-- из-за этого может перестать двигаться на середине.
alter table public.work_progress replica identity full;
