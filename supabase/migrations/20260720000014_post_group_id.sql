-- Связка постов, публикуемых вместе (например, «фото + опрос»):
-- обе строки получают общий group_id, фронтенд показывает их одной карточкой.
alter table public.posts
  add column group_id uuid;

create index idx_posts_group_id on public.posts (group_id) where group_id is not null;
