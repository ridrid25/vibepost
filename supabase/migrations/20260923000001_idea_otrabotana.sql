-- Отметка «по этому листку ролик готов».
--
-- Зачем. 23.09.2026 заказчица: «у меня во Входящих есть кнопочка „Готово“,
-- я её нажимала с тем учётом, что он понимает — ролик уже готов. Зачем же
-- тогда я эту кнопочку нажимаю?» Кнопка ставила отметку на карточке ролика,
-- а поиск идей её не читал: при разборе присланного файла завод перебирал
-- 60 листков подряд, включая августовские и уже отработанные, и по слову
-- «рыба» не находил «Сельдь» среди этого вороха.
--
-- Что отмечаем. Отработан РАЗОВЫЙ ЛИСТОК (зверь + хук + реплика), а не тема.
-- Тему никто не запрещает и запрещать не будет: генератор идей читает свою
-- историю отдельно и ограничивает только зверей. Эта отметка живёт лишь для
-- поиска «чей это присланный ролик» — чтобы список был коротким и свежим.

alter table public.video_ideas
  add column if not exists otrabotana_at timestamptz;

comment on column public.video_ideas.otrabotana_at is
  'Когда по этому листку ролик признан готовым (кнопка «Готово» во Входящих). '
  'Сужает поиск идеи при разборе присланного файла. Тему НЕ запрещает.';

create index if not exists video_ideas_otrabotana_idx
  on public.video_ideas (user_id, otrabotana_at)
  where otrabotana_at is null;

-- Кнопка «Готово» ставит ready на карточке ролика. Отсюда переносим отметку
-- на листок. Триггер, а не код функции: кнопку могут нажать из приложения,
-- из бота и из скрипта — отметка должна появляться в любом случае.
create or replace function public.otmetit_otrabotannuyu_ideyu()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.ready is true and new.idea_id is not null then
    update public.video_ideas
       set otrabotana_at = coalesce(otrabotana_at, now())
     where id = new.idea_id
       and user_id = new.user_id;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_otmetit_otrabotannuyu_ideyu on public.incoming_videos;
create trigger trg_otmetit_otrabotannuyu_ideyu
  after insert or update of ready, idea_id on public.incoming_videos
  for each row
  when (new.ready is true and new.idea_id is not null)
  execute function public.otmetit_otrabotannuyu_ideyu();

-- Разовый перенос: карточки, где «Готово» уже нажато.
update public.video_ideas и
   set otrabotana_at = к.otmecheno
  from (
    select idea_id, min(coalesce(polished_at, last_activity_at, created_at)) as otmecheno
      from public.incoming_videos
     where ready is true and idea_id is not null
     group by idea_id
  ) к
 where и.id = к.idea_id
   and и.otrabotana_at is null;
