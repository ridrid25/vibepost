-- Быстрая полоса описаний (заказчица 01.11.2026: «Почему так долго работает
-- описание?» — задание ждало 5,5 мин, пока дежурный вёл бригаду по промту).
-- Отдельный дежурный берёт ТОЛЬКО задания «Придумай описания», тот же захват
-- FOR UPDATE SKIP LOCKED, что и claim_task: двойного взятия нет.
create or replace function public.claim_description_task(p_worker text)
returns public.claude_tasks
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_task public.claude_tasks;
begin
  select * into v_task
    from public.claude_tasks
   where status = 'new'
     and text like 'Придумай описания%'
   order by created_at
   limit 1
   for update skip locked;

  if not found then
    return null;
  end if;

  update public.claude_tasks
     set status = 'processing', claimed_at = now(), claimed_by = p_worker
   where id = v_task.id
   returning * into v_task;

  return v_task;
end;
$$;

revoke all on function public.claim_description_task(text) from public, anon, authenticated;
