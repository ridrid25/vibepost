-- Stable delivery IDs prevent duplicate VibePost drafts after a lost HTTP
-- response or a generator retry.
alter table public.incoming_videos
  add column if not exists delivery_id text;

create unique index if not exists uq_incoming_videos_owner_delivery
  on public.incoming_videos (user_id, delivery_id)
  where delivery_id is not null;
