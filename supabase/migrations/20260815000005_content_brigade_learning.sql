-- Persistent Content Brigade v2 learning memory.
--
-- TikTok Display API counts remain in video_metric_snapshots (source=api).
-- TikTok Studio-only values are stored separately and are never inferred.

create table public.content_hypotheses (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  statement text not null check (btrim(statement) <> ''),
  changed_variable text not null check (btrim(changed_variable) <> ''),
  expected_effect text not null check (btrim(expected_effect) <> ''),
  rationale text,
  evidence jsonb not null default '[]'::jsonb check (jsonb_typeof(evidence) = 'array'),
  status text not null default 'HYPOTHESIS'
    check (status in ('HYPOTHESIS', 'SUPPORTED', 'CONFIRMED', 'REJECTED')),
  confidence text not null default 'LOW'
    check (confidence in ('LOW', 'MEDIUM', 'HIGH')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, user_id)
);
alter table public.content_hypotheses enable row level security;
create policy "content_hypotheses_owner_all" on public.content_hypotheses
  for all using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);
create trigger trg_content_hypotheses_updated_at
  before update on public.content_hypotheses
  for each row execute function public.set_updated_at();

create table public.experiments (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  hypothesis_id uuid,
  hypothesis text not null check (btrim(hypothesis) <> ''),
  changed_variable text not null check (btrim(changed_variable) <> ''),
  constants jsonb not null default '{}'::jsonb check (jsonb_typeof(constants) = 'object'),
  success_metrics jsonb not null default '{}'::jsonb check (jsonb_typeof(success_metrics) = 'object'),
  control_video_id uuid,
  result text check (result is null or result in ('PASS', 'FAIL', 'INCONCLUSIVE')),
  confidence text not null default 'LOW'
    check (confidence in ('LOW', 'MEDIUM', 'HIGH')),
  lessons text,
  status text not null default 'OPEN'
    check (status in ('OPEN', 'AWAITING_DATA', 'ANALYZED', 'CLOSED')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, user_id),
  foreign key (hypothesis_id, user_id)
    references public.content_hypotheses (id, user_id),
  foreign key (control_video_id, user_id)
    references public.videos (id, user_id)
);
alter table public.experiments enable row level security;
create policy "experiments_owner_all" on public.experiments
  for all using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);
create trigger trg_experiments_updated_at
  before update on public.experiments
  for each row execute function public.set_updated_at();

alter table public.videos
  add column topic text,
  add column content_format text,
  add column hook_type text,
  add column experiment_id uuid,
  add column hypothesis_id uuid,
  add column character_id text,
  add column visual_style_id text,
  add column pacing_profile text,
  add column punch_type text,
  add column loop_type text,
  add column camera_profile text,
  add column prompt_framework_version text,
  add foreign key (experiment_id, user_id)
    references public.experiments (id, user_id),
  add foreign key (hypothesis_id, user_id)
    references public.content_hypotheses (id, user_id);

create table public.studio_metrics (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  video_id uuid not null,
  average_watch_time_seconds numeric
    check (average_watch_time_seconds is null or average_watch_time_seconds >= 0),
  average_retention_percent numeric
    check (average_retention_percent is null or average_retention_percent between 0 and 100),
  full_watch_percent numeric
    check (full_watch_percent is null or full_watch_percent between 0 and 100),
  traffic_for_you_percent numeric
    check (traffic_for_you_percent is null or traffic_for_you_percent between 0 and 100),
  traffic_profile_percent numeric
    check (traffic_profile_percent is null or traffic_profile_percent between 0 and 100),
  traffic_search_percent numeric
    check (traffic_search_percent is null or traffic_search_percent between 0 and 100),
  traffic_following_percent numeric
    check (traffic_following_percent is null or traffic_following_percent between 0 and 100),
  saves bigint check (saves is null or saves >= 0),
  retention_drop_second numeric
    check (retention_drop_second is null or retention_drop_second >= 0),
  source text not null default 'manual_tiktok_studio'
    check (source = 'manual_tiktok_studio'),
  captured_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (video_id),
  unique (id, user_id),
  foreign key (video_id, user_id)
    references public.videos (id, user_id) on delete cascade
);
alter table public.studio_metrics enable row level security;
create policy "studio_metrics_owner_all" on public.studio_metrics
  for all using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);
create trigger trg_studio_metrics_updated_at
  before update on public.studio_metrics
  for each row execute function public.set_updated_at();

create table public.content_analysis_results (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  video_id uuid not null,
  experiment_id uuid,
  checkpoint text not null check (checkpoint in ('1h', '6h', '24h', '72h', '7d', 'manual')),
  conclusion text not null check (conclusion in ('PASS', 'FAIL', 'INCONCLUSIVE')),
  evidence jsonb not null default '[]'::jsonb check (jsonb_typeof(evidence) = 'array'),
  metrics jsonb not null default '{}'::jsonb check (jsonb_typeof(metrics) = 'object'),
  metric_sources jsonb not null default '{}'::jsonb check (jsonb_typeof(metric_sources) = 'object'),
  confidence text not null check (confidence in ('LOW', 'MEDIUM', 'HIGH')),
  sample_size jsonb not null default '{}'::jsonb check (jsonb_typeof(sample_size) = 'object'),
  limitations jsonb not null default '[]'::jsonb check (jsonb_typeof(limitations) = 'array'),
  expected jsonb not null default '{}'::jsonb check (jsonb_typeof(expected) = 'object'),
  actual jsonb not null default '{}'::jsonb check (jsonb_typeof(actual) = 'object'),
  created_at timestamptz not null default now(),
  unique (video_id, checkpoint, experiment_id),
  unique (id, user_id),
  foreign key (video_id, user_id)
    references public.videos (id, user_id) on delete cascade,
  foreign key (experiment_id, user_id)
    references public.experiments (id, user_id)
);
alter table public.content_analysis_results enable row level security;
create policy "content_analysis_results_owner_all" on public.content_analysis_results
  for all using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

create table public.content_lessons (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  lesson text not null check (btrim(lesson) <> ''),
  category text not null
    check (category in ('CONFIRMED_LESSON', 'WINNING_PATTERN', 'FAILED_PATTERN', 'HYPOTHESIS')),
  evidence jsonb not null default '[]'::jsonb check (jsonb_typeof(evidence) = 'array'),
  videos_used uuid[] not null default '{}',
  sample_size jsonb not null default '{}'::jsonb check (jsonb_typeof(sample_size) = 'object'),
  confidence text not null default 'LOW'
    check (confidence in ('LOW', 'MEDIUM', 'HIGH')),
  status text not null default 'HYPOTHESIS'
    check (status in ('HYPOTHESIS', 'SUPPORTED', 'CONFIRMED', 'REJECTED')),
  applicable_topics text[] not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, user_id)
);
alter table public.content_lessons enable row level security;
create policy "content_lessons_owner_all" on public.content_lessons
  for all using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);
create trigger trg_content_lessons_updated_at
  before update on public.content_lessons
  for each row execute function public.set_updated_at();

create table public.prompt_framework_versions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  version_label text not null check (btrim(version_label) <> ''),
  structure jsonb not null check (jsonb_typeof(structure) = 'object'),
  status text not null default 'EXPERIMENTAL'
    check (status in ('EXPERIMENTAL', 'SUPPORTED', 'STANDARD', 'UNDER_REVIEW', 'REJECTED')),
  is_current boolean not null default false,
  evidence jsonb not null default '[]'::jsonb check (jsonb_typeof(evidence) = 'array'),
  confidence text not null default 'LOW'
    check (confidence in ('LOW', 'MEDIUM', 'HIGH')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, version_label),
  unique (id, user_id)
);
create unique index prompt_framework_one_current_per_user
  on public.prompt_framework_versions (user_id) where is_current;
alter table public.prompt_framework_versions enable row level security;
create policy "prompt_framework_versions_owner_all" on public.prompt_framework_versions
  for all using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);
create trigger trg_prompt_framework_versions_updated_at
  before update on public.prompt_framework_versions
  for each row execute function public.set_updated_at();

create table public.prompt_framework_rules (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  framework_id uuid not null,
  old_rule text,
  new_rule text not null check (btrim(new_rule) <> ''),
  evidence jsonb not null default '[]'::jsonb check (jsonb_typeof(evidence) = 'array'),
  expected_effect text not null check (btrim(expected_effect) <> ''),
  confidence text not null default 'LOW'
    check (confidence in ('LOW', 'MEDIUM', 'HIGH')),
  status text not null default 'EXPERIMENTAL'
    check (status in ('EXPERIMENTAL', 'SUPPORTED', 'STANDARD', 'UNDER_REVIEW', 'REJECTED')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (framework_id, user_id)
    references public.prompt_framework_versions (id, user_id) on delete cascade
);
alter table public.prompt_framework_rules enable row level security;
create policy "prompt_framework_rules_owner_all" on public.prompt_framework_rules
  for all using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);
create trigger trg_prompt_framework_rules_updated_at
  before update on public.prompt_framework_rules
  for each row execute function public.set_updated_at();

create table public.video_prompt_records (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  video_id uuid not null,
  prompt_version text not null check (btrim(prompt_version) <> ''),
  prompt_structure jsonb not null check (jsonb_typeof(prompt_structure) = 'object'),
  prompt_patterns jsonb not null default '[]'::jsonb check (jsonb_typeof(prompt_patterns) = 'array'),
  experiment_variable text,
  technical_valid boolean,
  created_at timestamptz not null default now(),
  unique (video_id),
  unique (id, user_id),
  foreign key (video_id, user_id)
    references public.videos (id, user_id) on delete cascade
);
alter table public.video_prompt_records enable row level security;
create policy "video_prompt_records_owner_all" on public.video_prompt_records
  for all using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

create index idx_studio_metrics_user_captured
  on public.studio_metrics (user_id, captured_at desc);
create index idx_experiments_user_status
  on public.experiments (user_id, status, created_at desc);
create index idx_content_lessons_user_status
  on public.content_lessons (user_id, status, created_at desc);
create index idx_analysis_video_created
  on public.content_analysis_results (video_id, created_at desc);

comment on table public.studio_metrics is
  'Manual TikTok Studio values only. Missing values stay NULL and are never inferred from Display API counts.';
comment on table public.content_lessons is
  'Persistent account-specific learning memory. One result cannot be promoted directly to CONFIRMED.';
comment on table public.prompt_framework_versions is
  'Versioned production-prompt framework; only evidence-backed versions may become STANDARD.';
