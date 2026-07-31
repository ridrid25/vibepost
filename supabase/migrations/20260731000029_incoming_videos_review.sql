-- Разбор присланного ролика и выбор подписи.
-- review — что бот увидел в ролике (формат, речь, соответствие задумке);
-- caption_options — варианты подписи, из которых Татьяна выбирает кнопкой;
-- ready — подпись выбрана, ролик согласован.
alter table public.incoming_videos
  add column review text,
  add column caption_options jsonb,
  add column ready boolean not null default false;
