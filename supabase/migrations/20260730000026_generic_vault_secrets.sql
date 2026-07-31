-- Универсальные функции для хранения секретов в Vault (по имени).
-- Нужны, чтобы класть в хранилище крупные значения (например, JSON служебного
-- аккаунта Google) не прогоняя их через чат и не храня в таблицах открытым текстом.
create or replace function public.store_secret(p_name text, p_value text)
returns text language plpgsql security definer set search_path = '' as $$
declare v uuid;
begin
  select id into v from vault.secrets where name = p_name;
  if v is null then
    perform vault.create_secret(p_value, p_name, 'VibePost: ' || p_name);
  else
    perform vault.update_secret(v, p_value);
  end if;
  return 'ok';
end; $$;
revoke execute on function public.store_secret(text, text) from public, anon, authenticated;
grant execute on function public.store_secret(text, text) to service_role;

create or replace function public.get_secret(p_name text)
returns text language sql security definer set search_path = '' as $$
  select decrypted_secret from vault.decrypted_secrets where name = p_name;
$$;
revoke execute on function public.get_secret(text) from public, anon, authenticated;
grant execute on function public.get_secret(text) to service_role;
