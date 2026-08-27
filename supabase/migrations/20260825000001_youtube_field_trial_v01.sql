-- YouTube Shorts field-trial state for the existing Telegram owner workflow.
-- Existing rows remain TikTok/current-production controls. No new database or
-- publication provider is introduced.

alter table public.video_ideas
  add column if not exists target_platform text not null default 'tiktok',
  add column if not exists trend_signal text,
  add column if not exists reference_source_id text,
  add column if not exists reference_source_url text,
  add column if not exists reference_title text,
  add column if not exists reference_published_at timestamptz,
  add column if not exists reference_views bigint,
  add column if not exists reference_vph numeric,
  add column if not exists reference_snapshot_at timestamptz,
  add column if not exists reference_channel_baseline_views numeric,
  add column if not exists reference_outlier_ratio numeric,
  add column if not exists causal_pattern jsonb,
  add column if not exists payoff_class text,
  add column if not exists fidelity_constraints jsonb,
  add column if not exists generated_prompt_at timestamptz;

alter table public.profiles
  add column if not exists target_platform text not null default 'tiktok',
  add column if not exists active_video_idea_id uuid references public.video_ideas(id) on delete set null;

alter table public.claude_tasks
  add column if not exists idea_id uuid references public.video_ideas(id) on delete set null;

alter table public.incoming_videos
  add column if not exists target_platform text not null default 'tiktok',
  add column if not exists idea_id uuid references public.video_ideas(id) on delete set null,
  add column if not exists causal_pattern jsonb,
  add column if not exists causal_pattern_review text,
  add column if not exists owner_accepted_at timestamptz,
  add column if not exists published_at timestamptz,
  add column if not exists resulting_views_checkpoints jsonb not null default '[]'::jsonb;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'profiles_target_platform_check'
  ) then
    alter table public.profiles add constraint profiles_target_platform_check
      check (target_platform in ('tiktok', 'youtube_shorts'));
  end if;
  if not exists (
    select 1 from pg_constraint where conname = 'video_ideas_target_platform_check'
  ) then
    alter table public.video_ideas add constraint video_ideas_target_platform_check
      check (target_platform in ('tiktok', 'youtube_shorts'));
  end if;
  if not exists (
    select 1 from pg_constraint where conname = 'video_ideas_trend_signal_check'
  ) then
    alter table public.video_ideas add constraint video_ideas_trend_signal_check
      check (trend_signal is null or trend_signal = 'reference-driven');
  end if;
  if not exists (
    select 1 from pg_constraint where conname = 'video_ideas_causal_pattern_object_check'
  ) then
    alter table public.video_ideas add constraint video_ideas_causal_pattern_object_check
      check (causal_pattern is null or jsonb_typeof(causal_pattern) = 'object');
  end if;
  if not exists (
    select 1 from pg_constraint where conname = 'video_ideas_fidelity_constraints_array_check'
  ) then
    alter table public.video_ideas add constraint video_ideas_fidelity_constraints_array_check
      check (fidelity_constraints is null or jsonb_typeof(fidelity_constraints) = 'array');
  end if;
  if not exists (
    select 1 from pg_constraint where conname = 'incoming_videos_target_platform_check'
  ) then
    alter table public.incoming_videos add constraint incoming_videos_target_platform_check
      check (target_platform in ('tiktok', 'youtube_shorts'));
  end if;
  if not exists (
    select 1 from pg_constraint where conname = 'incoming_videos_causal_pattern_object_check'
  ) then
    alter table public.incoming_videos add constraint incoming_videos_causal_pattern_object_check
      check (causal_pattern is null or jsonb_typeof(causal_pattern) = 'object');
  end if;
  if not exists (
    select 1 from pg_constraint where conname = 'incoming_videos_causal_review_check'
  ) then
    alter table public.incoming_videos add constraint incoming_videos_causal_review_check
      check (causal_pattern_review is null or causal_pattern_review in ('YES', 'NO', 'UNCERTAIN'));
  end if;
  if not exists (
    select 1 from pg_constraint where conname = 'incoming_videos_view_checkpoints_array_check'
  ) then
    alter table public.incoming_videos add constraint incoming_videos_view_checkpoints_array_check
      check (jsonb_typeof(resulting_views_checkpoints) = 'array');
  end if;
end $$;

create index if not exists idx_video_ideas_platform_created
  on public.video_ideas(user_id, target_platform, created_at desc);
create index if not exists idx_video_ideas_reference_source
  on public.video_ideas(user_id, reference_source_id) where reference_source_id is not null;
create index if not exists idx_claude_tasks_idea_id
  on public.claude_tasks(idea_id) where idea_id is not null;
create index if not exists idx_incoming_videos_idea_id
  on public.incoming_videos(idea_id) where idea_id is not null;
create index if not exists idx_incoming_videos_platform_activity
  on public.incoming_videos(user_id, target_platform, last_activity_at desc);

comment on column public.profiles.target_platform is
  'Persistent owner-selected production target: current TikTok control or YouTube Shorts field trial.';
comment on column public.video_ideas.causal_pattern is
  'Trusted abstract Reference DNA causal pattern; never source shots, dialogue, character, branding, or creator identity.';
comment on column public.incoming_videos.causal_pattern_review is
  'Gemini advisory only. Owner remains the final acceptance authority.';
comment on column public.incoming_videos.owner_accepted_at is
  'Set only after explicit Telegram acceptance and title selection; kept in sync with ready=true.';
comment on column public.incoming_videos.resulting_views_checkpoints is
  'Observed public-result snapshots only; missing values remain absent and are never inferred.';
