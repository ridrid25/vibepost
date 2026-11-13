-- Тема идей — отдельный переключатель (заказчица 13.11.2026).
--
-- «Давай сделаем серию про работу, но генератор настрой как отдельный
-- переключатель на другую тему. Давай оставим и нашу старую тему и новую и
-- может начнем эксперименты по поиску новых тем.»
--
--   dengi  — прежняя тема: личные финансы. Генератор работает как раньше.
--   rabota — работа: сотрудник и начальник, коллеги, кадровик, клиент, смена.
--   poisk  — эксперимент: каждая идея партии — своя новая бытовая тема.
--
-- В идее тема запоминается, чтобы через 10 роликов сравнить просмотры по темам.

alter table public.profiles
  add column if not exists tema text not null default 'dengi';

alter table public.profiles
  drop constraint if exists profiles_tema_check;
alter table public.profiles
  add constraint profiles_tema_check check (tema in ('dengi', 'rabota', 'poisk'));

alter table public.video_ideas
  add column if not exists tema text;

comment on column public.profiles.tema is
  'Тема идей: dengi (прежняя), rabota (работа), poisk (поиск новых тем). Кнопка «🗂 Тема» в боте.';
comment on column public.video_ideas.tema is
  'Тема, под которой придумана идея (profiles.tema на момент генерации). Пусто — до 13.11.2026, то есть dengi.';
