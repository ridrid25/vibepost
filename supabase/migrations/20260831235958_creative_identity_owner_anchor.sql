-- POST-13A: narrow prerequisite for the POST-12 same-owner foreign key.
-- This is intentionally separate from the broader POST-05 migration.

alter table public.creative_identity_map
  add constraint creative_identity_map_post12_owner_unique
  unique (id, user_id);

comment on constraint creative_identity_map_post12_owner_unique
  on public.creative_identity_map is
  'POST-13A exact composite owner anchor required by Telegram attribution; no POST-05 learning migration implied.';
