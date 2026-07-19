-- user_id заполняется автоматически из текущего логина (auth.uid()),
-- если фронтенд не передал его явно. Убирает целый класс ошибок
-- «new row violates row-level security policy» при insert без user_id.
alter table public.bots               alter column user_id set default auth.uid();
alter table public.chats              alter column user_id set default auth.uid();
alter table public.message_templates  alter column user_id set default auth.uid();
alter table public.posts              alter column user_id set default auth.uid();
alter table public.message_chains     alter column user_id set default auth.uid();
alter table public.active_chains      alter column user_id set default auth.uid();
alter table public.notifications      alter column user_id set default auth.uid();
