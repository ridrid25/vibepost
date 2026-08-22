-- Restrict system-owned learning memory writes to the service layer.
-- Authenticated users retain read access; manual Studio input remains writable.

drop policy if exists "content_hypotheses_owner_all" on public.content_hypotheses;
create policy "content_hypotheses_owner_read" on public.content_hypotheses
  for select using ((select auth.uid()) = user_id);

drop policy if exists "experiments_owner_all" on public.experiments;
create policy "experiments_owner_read" on public.experiments
  for select using ((select auth.uid()) = user_id);

drop policy if exists "content_analysis_results_owner_all" on public.content_analysis_results;
create policy "content_analysis_results_owner_read" on public.content_analysis_results
  for select using ((select auth.uid()) = user_id);

drop policy if exists "content_lessons_owner_all" on public.content_lessons;
create policy "content_lessons_owner_read" on public.content_lessons
  for select using ((select auth.uid()) = user_id);

drop policy if exists "prompt_framework_versions_owner_all" on public.prompt_framework_versions;
create policy "prompt_framework_versions_owner_read" on public.prompt_framework_versions
  for select using ((select auth.uid()) = user_id);

drop policy if exists "prompt_framework_rules_owner_all" on public.prompt_framework_rules;
create policy "prompt_framework_rules_owner_read" on public.prompt_framework_rules
  for select using ((select auth.uid()) = user_id);

drop policy if exists "video_prompt_records_owner_all" on public.video_prompt_records;
create policy "video_prompt_records_owner_read" on public.video_prompt_records
  for select using ((select auth.uid()) = user_id);

-- PostgreSQL unique constraints treat NULL values as distinct. Close that gap
-- for analyses that are deliberately not linked to an experiment.
create unique index content_analysis_one_uncontrolled_checkpoint
  on public.content_analysis_results (video_id, checkpoint)
  where experiment_id is null;

-- Tenant-safe evidence links. The legacy uuid[] remains as a compact denormalized
-- read field, while this table is the referentially enforced source of truth.
create table public.content_lesson_videos (
  lesson_id uuid not null,
  video_id uuid not null,
  user_id uuid not null references auth.users (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (lesson_id, video_id),
  foreign key (lesson_id, user_id)
    references public.content_lessons (id, user_id) on delete cascade,
  foreign key (video_id, user_id)
    references public.videos (id, user_id) on delete cascade
);
alter table public.content_lesson_videos enable row level security;
create policy "content_lesson_videos_owner_read" on public.content_lesson_videos
  for select using ((select auth.uid()) = user_id);

comment on table public.content_lesson_videos is
  'Tenant-safe video evidence links for Content Brigade Lessons; writes are service-only.';
