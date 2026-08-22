-- Restore the incoming_videos columns that were added directly in production
-- while the video review workflow was being developed. Keeping this migration
-- idempotent lets a fresh project reach the schema expected by the deployed
-- Edge Functions without changing the already-correct production database.

alter table public.incoming_videos
  add column if not exists polished_at timestamptz,
  add column if not exists rework_note text,
  add column if not exists rework_at timestamptz,
  add column if not exists measure_avg numeric,
  add column if not exists measure_worst numeric,
  add column if not exists measure_cuts integer,
  add column if not exists rework_ack_at timestamptz,
  add column if not exists hook text,
  add column if not exists tag text,
  add column if not exists hook_options text[] default '{}',
  add column if not exists last_activity_at timestamptz;

alter table public.incoming_videos
  drop constraint if exists incoming_videos_status_check;
alter table public.incoming_videos
  add constraint incoming_videos_status_check
  check (status in ('new', 'scheduled', 'dismissed', 'rework'));

create index if not exists incoming_videos_activity_idx
  on public.incoming_videos (user_id, last_activity_at desc);

