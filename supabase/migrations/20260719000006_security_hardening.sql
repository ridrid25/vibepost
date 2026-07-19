-- Устранение предупреждений Supabase Security Advisor после первичной схемы.

-- 1. pg_net должен жить в схеме extensions, а не public
drop extension if exists pg_net;
create extension pg_net with schema extensions;

-- 2. Служебные функции нельзя вызывать через REST API:
-- триггеры продолжают работать, а прямой вызов пользователями запрещаем.
revoke execute on function public.handle_new_user() from public, anon, authenticated;
revoke execute on function public.set_updated_at() from public, anon, authenticated;

-- 3. Публичный bucket и так отдаёт файлы по прямой ссылке —
-- широкая select-политика позволяла ещё и ЛИСТИНГ всех файлов через API.
-- Оставляем листинг только владельцу своей папки.
drop policy "post_photos_public_read" on storage.objects;

create policy "post_photos_owner_select" on storage.objects
  for select to authenticated
  using (
    bucket_id = 'post-photos'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );
