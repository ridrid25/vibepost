-- Сырые снимки ТикТока: синхронизация каждые 15 минут пишет полный снимок по
-- каждому ролику, хранились 14 дней — 37 тыс. снимков по 71 ролику, 194 МБ.
-- Аналитика читает только последний снимок ролика. Решение заказчицы 07.10.2026:
-- держать 3 дня. Последний снимок каждого ролика не удаляется никогда — иначе
-- остановка сбора дольше трёх дней обнулила бы её аналитику ТикТока.
alter table public.tiktok_raw_video_items
  alter column expires_at set default (now() + interval '3 days');

update public.tiktok_raw_video_items
   set expires_at = captured_at + interval '3 days'
 where expires_at > captured_at + interval '3 days';

create or replace function public.purge_expired_tiktok_raw_items()
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_count bigint;
begin
  delete from public.tiktok_raw_video_items r
   where r.expires_at <= now()
     and exists (
       select 1 from public.tiktok_raw_video_items n
        where n.external_video_id is not distinct from r.external_video_id
          and n.account_id = r.account_id
          and n.endpoint = r.endpoint
          and n.captured_at > r.captured_at
     );
  get diagnostics v_count = row_count;
  delete from public.tiktok_oauth_states
   where expires_at <= now()
      or used_at < now() - interval '1 day';
  return v_count;
end;
$$;
revoke execute on function public.purge_expired_tiktok_raw_items()
  from public, anon, authenticated;
grant execute on function public.purge_expired_tiktok_raw_items() to service_role;
