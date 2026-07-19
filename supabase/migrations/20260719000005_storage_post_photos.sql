-- Bucket для фото постов. Публичное чтение обязательно:
-- Telegram скачивает фото по прямой ссылке при sendPhoto.
-- Загрузка/изменение — только в свою папку (имя папки = uid пользователя).
insert into storage.buckets (id, name, public)
values ('post-photos', 'post-photos', true)
on conflict (id) do nothing;

create policy "post_photos_public_read" on storage.objects
  for select using (bucket_id = 'post-photos');

create policy "post_photos_owner_insert" on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'post-photos'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );

create policy "post_photos_owner_update" on storage.objects
  for update to authenticated
  using (
    bucket_id = 'post-photos'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );

create policy "post_photos_owner_delete" on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'post-photos'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );
