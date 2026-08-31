-- POST-07: bounded TikTok MARKET_REFERENCE ingest. This is not an own-performance
-- collector, experiment store, lesson store, or production prompt integration.

create table public.market_references (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  platform text not null default 'tiktok' check (platform = 'tiktok'),
  source_kind text not null default 'OWNER_SUBMITTED' check (source_kind = 'OWNER_SUBMITTED'),
  external_reference_id text not null check (external_reference_id ~ '^[1-9][0-9]{4,31}$'),
  canonical_url text not null,
  creator_name text,
  creator_handle text,
  owner_disposition text check (owner_disposition in
    ('TAKE','SKIP','INTERESTING_MECHANIC','NOT_MY_STYLE')),
  status text not null default 'RESOLVED' check (status = 'RESOLVED'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id,user_id),
  unique (user_id,platform,external_reference_id),
  check (canonical_url = 'https://www.tiktok.com/@'||creator_handle||'/video/'||external_reference_id),
  check (creator_handle is not null and creator_handle ~ '^[a-z0-9_][a-z0-9_.]{0,22}[a-z0-9_]$'
    and creator_handle not like '%..%' and creator_handle not like '.%' and creator_handle not like '%.'),
  check (creator_name is null or (length(creator_name) between 1 and 256))
);

create table public.market_reference_evidence (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  market_reference_id uuid not null,
  evidence_kind text not null check (evidence_kind in ('FACT_OBSERVATION','DNA_INFERENCE')),
  schema_version integer not null check (schema_version = 1),
  payload jsonb not null check (jsonb_typeof(payload) = 'object'),
  source_locator text not null,
  observed_at timestamptz not null,
  analysis_identity text not null check (analysis_identity in ('TIKTOK_OEMBED_V1','HUMAN_REVIEW')),
  confidence text not null check (confidence in ('LOW','MEDIUM','HIGH')),
  limitations jsonb not null default '[]'::jsonb check (jsonb_typeof(limitations) = 'array'),
  payload_hash text not null check (payload_hash ~ '^[0-9a-f]{64}$'),
  evidence_version integer not null check (evidence_version between 1 and 32767),
  supersedes_evidence_id uuid,
  created_at timestamptz not null default now(),
  unique (id,user_id,market_reference_id),
  foreign key (market_reference_id,user_id)
    references public.market_references(id,user_id) on delete cascade,
  foreign key (supersedes_evidence_id,user_id,market_reference_id)
    references public.market_reference_evidence(id,user_id,market_reference_id),
  unique (user_id,market_reference_id,evidence_kind,schema_version,payload_hash),
  check ((evidence_kind='FACT_OBSERVATION' and analysis_identity='TIKTOK_OEMBED_V1'
      and evidence_version=1 and supersedes_evidence_id is null and confidence='HIGH')
    or (evidence_kind='DNA_INFERENCE' and analysis_identity='HUMAN_REVIEW')),
  check (payload::text !~* '"(html|thumbnail_url|thumbnail_width|thumbnail_height|script|dialogue|exact_caption|soundtrack|creator_likeness|logos|branded_assets)"[[:space:]]*:')
);

create unique index market_reference_one_fact_v1
  on public.market_reference_evidence(user_id,market_reference_id,evidence_kind,schema_version)
  where evidence_kind='FACT_OBSERVATION';
create unique index market_reference_dna_version_unique
  on public.market_reference_evidence(user_id,market_reference_id,evidence_version)
  where evidence_kind='DNA_INFERENCE';
create index market_reference_owner_recent
  on public.market_references(user_id,created_at desc);

alter table public.market_references enable row level security;
alter table public.market_reference_evidence enable row level security;

create policy "market_references_owner_read" on public.market_references
  for select to authenticated using (auth.uid()=user_id);
create policy "market_reference_evidence_owner_read" on public.market_reference_evidence
  for select to authenticated using (auth.uid()=user_id);

revoke all on public.market_references from public,anon,authenticated,service_role;
revoke all on public.market_reference_evidence from public,anon,authenticated,service_role;
grant select on public.market_references to authenticated,service_role;
grant select on public.market_reference_evidence to authenticated,service_role;

create or replace function public.guard_market_reference_identity()
returns trigger language plpgsql set search_path='' as $$
begin
  if new.user_id<>old.user_id or new.platform<>old.platform or new.source_kind<>old.source_kind
    or new.external_reference_id<>old.external_reference_id or new.canonical_url<>old.canonical_url
    or new.creator_handle<>old.creator_handle or new.creator_name is distinct from old.creator_name
    or new.status<>old.status or new.created_at<>old.created_at then
    raise exception 'market_reference_identity_immutable';
  end if;
  new.updated_at:=now();
  return new;
end; $$;

create trigger trg_market_reference_identity before update on public.market_references
  for each row execute function public.guard_market_reference_identity();

create or replace function public.guard_market_reference_evidence_append_only()
returns trigger language plpgsql set search_path='' as $$
begin
  raise exception 'market_reference_evidence_append_only';
end; $$;

create trigger trg_market_reference_evidence_append_only
  before update or delete on public.market_reference_evidence
  for each row execute function public.guard_market_reference_evidence_append_only();

create or replace function public.market_fact_hash_material(p_payload jsonb)
returns jsonb language sql immutable strict set search_path='' as $$
  select jsonb_build_object(
    'kind','FACT_OBSERVATION','schema_version',p_payload->'schema_version',
    'source_type',p_payload->'source_type','resolver',p_payload->'resolver',
    'external_reference_id',p_payload->'external_reference_id','facts',
    coalesce((select jsonb_object_agg(e.key,e.value-'observed_at')
      from jsonb_each(p_payload->'facts') e),'{}'::jsonb)
  )
$$;

create or replace function public.jsonb_has_exact_keys(p_value jsonb,p_keys text[])
returns boolean language sql immutable set search_path='' as $$
  select coalesce(jsonb_typeof(p_value)='object' and
    coalesce((select array_agg(k order by k) from jsonb_object_keys(p_value) as x(k)),array[]::text[])
    = (select array_agg(k order by k) from unnest(p_keys) as x(k)),false)
$$;

create or replace function public.market_fact_payload_valid(
  p_payload jsonb,p_external_id text,p_canonical_url text,p_creator_name text,
  p_creator_handle text,p_observed_at timestamptz
) returns boolean language plpgsql immutable set search_path='' as $$
declare v_name text; v_envelope jsonb; v_expected_status text;
begin
  if public.jsonb_has_exact_keys(p_payload,
      array['external_reference_id','facts','resolver','schema_version','source_type'])
      is not true
    or jsonb_typeof(p_payload->'schema_version') is distinct from 'number'
    or p_payload->>'schema_version' is distinct from '1'
    or p_payload->>'source_type' is distinct from 'MARKET_REFERENCE'
    or p_payload->>'resolver' is distinct from 'TIKTOK_OEMBED'
    or p_payload->>'external_reference_id' is distinct from p_external_id
    or public.jsonb_has_exact_keys(p_payload->'facts',array[
      'external_reference_id','canonical_url','title','creator_name','creator_handle','author_url',
      'provider_name','provider_url','published_at','views','likes','comments','shares','saves',
      'follower_baseline','velocity','outlier_ratio','retention','completion','watch_time','traffic_source'])
      is not true
  then return false; end if;
  foreach v_name in array array[
    'external_reference_id','canonical_url','title','creator_name','creator_handle','author_url',
    'provider_name','provider_url','published_at','views','likes','comments','shares','saves',
    'follower_baseline','velocity','outlier_ratio','retention','completion','watch_time','traffic_source'] loop
    v_envelope:=p_payload->'facts'->v_name;
    if public.jsonb_has_exact_keys(v_envelope,
        array['observed_at','source_kind','source_locator','status','value'])
        is not true
      or jsonb_typeof(v_envelope->'status') is distinct from 'string'
      or jsonb_typeof(v_envelope->'source_kind') is distinct from 'string'
      or jsonb_typeof(v_envelope->'source_locator') is distinct from 'string'
      or jsonb_typeof(v_envelope->'observed_at') is distinct from 'string'
      or v_envelope->>'source_kind' is distinct from 'TIKTOK_OEMBED'
      or v_envelope->>'source_locator' is distinct from p_canonical_url
      or (v_envelope->>'observed_at')::timestamptz is distinct from p_observed_at
    then return false; end if;
    v_expected_status:=case
      when v_name in ('retention','completion','watch_time','traffic_source') then 'UNSUPPORTED'
      when v_name in ('published_at','views','likes','comments','shares','saves','follower_baseline','velocity','outlier_ratio') then 'UNKNOWN'
      when v_name='title' and v_envelope->'value'='null'::jsonb then 'UNKNOWN'
      else 'OBSERVED' end;
    if v_envelope->>'status' is distinct from v_expected_status then return false; end if;
    if v_expected_status in ('UNKNOWN','UNSUPPORTED') and
      v_envelope->'value' is distinct from 'null'::jsonb then return false; end if;
    if v_expected_status='OBSERVED' and jsonb_typeof(v_envelope->'value') is distinct from 'string'
      then return false; end if;
  end loop;
  if p_payload->'facts'->'external_reference_id'->>'value' is distinct from p_external_id
    or p_payload->'facts'->'canonical_url'->>'value' is distinct from p_canonical_url
    or p_payload->'facts'->'provider_name'->>'value' is distinct from 'TikTok'
    or p_payload->'facts'->'provider_url'->>'value' is distinct from 'https://www.tiktok.com'
    or p_payload->'facts'->'creator_name'->>'value' is distinct from p_creator_name
    or p_payload->'facts'->'creator_handle'->>'value' is distinct from p_creator_handle
    or p_payload->'facts'->'author_url'->>'value' is distinct from ('https://www.tiktok.com/@'||p_creator_handle)
    or jsonb_typeof(p_payload->'facts'->'creator_name'->'value') is distinct from 'string'
    or length(p_payload->'facts'->'creator_name'->>'value') not between 1 and 256
    or jsonb_typeof(p_payload->'facts'->'creator_handle'->'value') is distinct from 'string'
    or jsonb_typeof(p_payload->'facts'->'author_url'->'value') is distinct from 'string'
    or (p_payload->'facts'->'title'->'value' is distinct from 'null'::jsonb and
      (jsonb_typeof(p_payload->'facts'->'title'->'value') is distinct from 'string'
       or length(p_payload->'facts'->'title'->>'value')>4000))
    or coalesce(p_payload->'facts'->'title'->>'value','') ~* '<[^>]*>|javascript:'
    or (p_payload->'facts'->'creator_name'->>'value') ~* '<[^>]*>|javascript:'
  then return false; end if;
  return true;
exception when others then return false;
end; $$;

create or replace function public.market_dna_payload_valid(p_payload jsonb,p_reference_id uuid)
returns boolean language plpgsql immutable set search_path='' as $$
declare v_name text; v_field jsonb; v_total integer:=0; v_lim jsonb;
begin
  if public.jsonb_has_exact_keys(p_payload,array[
      'analysis_method','analyzed_at','confidence','evidence_version','fact_evidence_ids','fields',
      'limitations','market_reference_id','reviewer_status','schema_version','supersedes_evidence_id'])
      is not true
    or jsonb_typeof(p_payload->'schema_version') is distinct from 'number'
    or jsonb_typeof(p_payload->'market_reference_id') is distinct from 'string'
    or jsonb_typeof(p_payload->'analysis_method') is distinct from 'string'
    or jsonb_typeof(p_payload->'analyzed_at') is distinct from 'string'
    or jsonb_typeof(p_payload->'confidence') is distinct from 'string'
    or jsonb_typeof(p_payload->'reviewer_status') is distinct from 'string'
    or jsonb_typeof(p_payload->'evidence_version') is distinct from 'number'
    or p_payload->>'schema_version' is distinct from '1'
    or p_payload->>'market_reference_id' is distinct from p_reference_id::text
    or p_payload->>'analysis_method' is distinct from 'HUMAN_REVIEW'
    or coalesce(p_payload->>'confidence','') not in ('LOW','MEDIUM','HIGH')
    or coalesce(p_payload->>'reviewer_status','') not in ('DRAFT','ACCEPTED','REJECTED')
    or coalesce((p_payload->>'evidence_version')::integer,0) not between 1 and 32767
    or (p_payload->>'analyzed_at')::timestamptz is null
    or jsonb_typeof(p_payload->'fact_evidence_ids') is distinct from 'array'
    or jsonb_array_length(p_payload->'fact_evidence_ids') not between 1 and 10
    or jsonb_typeof(p_payload->'limitations') is distinct from 'array'
    or jsonb_array_length(p_payload->'limitations')>10
    or public.jsonb_has_exact_keys(p_payload->'fields',array[
      'hook_type','first_frame_mechanic','opening_action','visual_pattern','content_format','setup',
      'conflict','viewer_prediction','violation','escalation','payoff','loop_mechanic','pacing_profile',
      'caption_style','character_role','camera_pattern','sound_role','CTA','reusable_formula',
      'critical_fidelity_constraints']) is not true
  then return false; end if;
  if exists(select 1 from jsonb_array_elements(p_payload->'fact_evidence_ids') x(value)
      where jsonb_typeof(value) is distinct from 'string'
      or (value#>>'{}') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$')
    then return false; end if;
  for v_lim in select value from jsonb_array_elements(p_payload->'limitations') loop
    if jsonb_typeof(v_lim) is distinct from 'string' or
      length(v_lim#>>'{}') not between 1 and 200 then return false; end if;
  end loop;
  foreach v_name in array array[
    'hook_type','first_frame_mechanic','opening_action','visual_pattern','content_format','setup',
    'conflict','viewer_prediction','violation','escalation','payoff','loop_mechanic','pacing_profile',
    'caption_style','character_role','camera_pattern','sound_role','CTA','reusable_formula',
    'critical_fidelity_constraints'] loop
    v_field:=p_payload->'fields'->v_name;
    if public.jsonb_has_exact_keys(v_field,array['status','value']) is not true
      or jsonb_typeof(v_field->'status') is distinct from 'string'
      or coalesce(v_field->>'status','') not in ('INFERENCE','UNKNOWN') then return false; end if;
    if v_field->>'status'='UNKNOWN' then
      if v_field->'value' is distinct from 'null'::jsonb then return false; end if;
    elsif jsonb_typeof(v_field->'value') is distinct from 'string'
      or length(v_field->>'value') not between 1 and 500 then
      return false;
    else v_total:=v_total+length(v_field->>'value'); end if;
  end loop;
  return v_total between 1 and 4000;
exception when others then return false;
end; $$;

create or replace function public.persist_tiktok_market_observations(
  p_user_id uuid,p_observations jsonb
) returns jsonb language plpgsql security definer set search_path='' as $$
declare
  v_item jsonb; v_reference public.market_references; v_evidence public.market_reference_evidence;
  v_result jsonb:='[]'::jsonb; v_hash text; v_existing public.market_reference_evidence;
begin
  if p_user_id is null or jsonb_typeof(p_observations)<>'array'
    or jsonb_array_length(p_observations) not between 1 and 5 then
    raise exception 'market_observation_batch_invalid';
  end if;
  for v_item in select value from jsonb_array_elements(p_observations) loop
    if (select array_agg(key order by key) from jsonb_object_keys(v_item) as x(key))
      <> array['canonical_url','creator_handle','creator_name','external_reference_id','observed_at','payload','source_kind']
      or v_item->>'source_kind'<>'OWNER_SUBMITTED'
      or coalesce(v_item->>'external_reference_id','') !~ '^[1-9][0-9]{4,31}$'
      or not public.market_fact_payload_valid(v_item->'payload',v_item->>'external_reference_id',
        v_item->>'canonical_url',v_item->>'creator_name',v_item->>'creator_handle',
        (v_item->>'observed_at')::timestamptz) then
      raise exception 'market_observation_schema_invalid';
    end if;
    perform pg_advisory_xact_lock(hashtextextended(p_user_id::text||':'||v_item->>'external_reference_id',0));
    v_hash:=encode(extensions.digest(convert_to(public.canonical_jsonb_text(
      public.market_fact_hash_material(v_item->'payload')),'UTF8'),'sha256'),'hex');
    insert into public.market_references(user_id,external_reference_id,canonical_url,creator_name,creator_handle)
      values(p_user_id,v_item->>'external_reference_id',v_item->>'canonical_url',
        nullif(v_item->>'creator_name',''),v_item->>'creator_handle')
      on conflict(user_id,platform,external_reference_id) do nothing;
    select * into strict v_reference from public.market_references r where r.user_id=p_user_id
      and r.platform='tiktok' and r.external_reference_id=v_item->>'external_reference_id' for update;
    if v_reference.canonical_url<>v_item->>'canonical_url'
      or v_reference.creator_handle<>v_item->>'creator_handle'
      or v_reference.creator_name is distinct from nullif(v_item->>'creator_name','') then
      raise exception 'market_reference_identity_conflict';
    end if;
    select * into v_existing from public.market_reference_evidence e where e.user_id=p_user_id
      and e.market_reference_id=v_reference.id and e.evidence_kind='FACT_OBSERVATION'
      and e.schema_version=1;
    if found then
      if v_existing.payload_hash<>v_hash then raise exception 'market_fact_replay_conflict'; end if;
      v_evidence:=v_existing;
    else
      insert into public.market_reference_evidence(user_id,market_reference_id,evidence_kind,
        schema_version,payload,source_locator,observed_at,analysis_identity,confidence,limitations,
        payload_hash,evidence_version)
      values(p_user_id,v_reference.id,'FACT_OBSERVATION',1,v_item->'payload',
        v_item->>'canonical_url',(v_item->>'observed_at')::timestamptz,'TIKTOK_OEMBED_V1',
        'HIGH','["oEmbed is identity/metadata only; public performance metrics are UNKNOWN."]',v_hash,1)
      returning * into v_evidence;
    end if;
    v_result:=v_result||jsonb_build_array(jsonb_build_object(
      'market_reference_id',v_reference.id,'fact_evidence_id',v_evidence.id,
      'external_reference_id',v_reference.external_reference_id,'canonical_url',v_reference.canonical_url,
      'creator_name',v_reference.creator_name,'creator_handle',v_reference.creator_handle,
      'owner_disposition',v_reference.owner_disposition));
  end loop;
  return v_result;
end; $$;

create or replace function public.set_tiktok_market_disposition(
  p_user_id uuid,p_market_reference_id uuid,p_disposition text
) returns public.market_references language plpgsql security definer set search_path='' as $$
declare v_row public.market_references;
begin
  if p_disposition not in ('TAKE','SKIP','INTERESTING_MECHANIC','NOT_MY_STYLE') then
    raise exception 'market_disposition_invalid';
  end if;
  update public.market_references set owner_disposition=p_disposition
    where id=p_market_reference_id and user_id=p_user_id returning * into v_row;
  if not found then raise exception 'market_reference_not_found'; end if;
  return v_row;
end; $$;

create or replace function public.append_tiktok_market_dna(
  p_user_id uuid,p_market_reference_id uuid,p_payload jsonb
) returns public.market_reference_evidence language plpgsql security definer set search_path='' as $$
declare
  v_ref public.market_references; v_row public.market_reference_evidence;
  v_prior public.market_reference_evidence; v_hash text; v_content_hash text;
  v_fact_ids uuid[]; v_version integer;
begin
  select * into v_ref from public.market_references where id=p_market_reference_id
    and user_id=p_user_id for update;
  if not found or v_ref.owner_disposition not in ('TAKE','INTERESTING_MECHANIC') then
    raise exception 'market_dna_ineligible';
  end if;
  if not public.market_dna_payload_valid(p_payload,p_market_reference_id) then
    raise exception 'market_dna_schema_invalid';
  end if;
  select array_agg(value::uuid order by value) into v_fact_ids
    from jsonb_array_elements_text(p_payload->'fact_evidence_ids');
  if v_fact_ids is null or (select count(*) from public.market_reference_evidence e
      where e.user_id=p_user_id and e.market_reference_id=p_market_reference_id
      and e.evidence_kind='FACT_OBSERVATION' and e.id=any(v_fact_ids))<>cardinality(v_fact_ids) then
    raise exception 'market_dna_fact_invalid';
  end if;
  v_version:=(p_payload->>'evidence_version')::integer;
  v_content_hash:=encode(extensions.digest(convert_to(public.canonical_jsonb_text(jsonb_build_object(
    'kind','DNA_INFERENCE','schema_version',p_payload->'schema_version',
    'market_reference_id',p_payload->'market_reference_id',
    'fact_evidence_ids',p_payload->'fact_evidence_ids','fields',p_payload->'fields')),'UTF8'),'sha256'),'hex');
  v_hash:=encode(extensions.digest(convert_to(public.canonical_jsonb_text(jsonb_build_object(
    'content_hash',v_content_hash,'analyzed_at',p_payload->'analyzed_at',
    'confidence',p_payload->'confidence','limitations',p_payload->'limitations',
    'reviewer_status',p_payload->'reviewer_status','evidence_version',p_payload->'evidence_version',
    'supersedes_evidence_id',p_payload->'supersedes_evidence_id')),'UTF8'),'sha256'),'hex');
  select * into v_row from public.market_reference_evidence e where e.user_id=p_user_id
    and e.market_reference_id=p_market_reference_id and e.evidence_kind='DNA_INFERENCE'
    and e.payload_hash=v_hash;
  if found then return v_row; end if;
  if exists(select 1 from public.market_reference_evidence e where e.user_id=p_user_id
      and e.market_reference_id=p_market_reference_id and e.evidence_kind='DNA_INFERENCE'
      and e.evidence_version=v_version) then raise exception 'market_dna_version_conflict'; end if;
  if v_version=1 then
    if p_payload->>'supersedes_evidence_id' is not null then raise exception 'market_dna_version_invalid'; end if;
  else
    select * into v_prior from public.market_reference_evidence e where e.id=(p_payload->>'supersedes_evidence_id')::uuid
      and e.user_id=p_user_id and e.market_reference_id=p_market_reference_id
      and e.evidence_kind='DNA_INFERENCE' and e.evidence_version=v_version-1
      and e.payload->>'reviewer_status'='DRAFT' for share;
    if not found or p_payload->>'reviewer_status'='DRAFT'
      or public.canonical_jsonb_text(v_prior.payload->'fact_evidence_ids')<>
        public.canonical_jsonb_text(p_payload->'fact_evidence_ids')
      or public.canonical_jsonb_text(v_prior.payload->'fields')<>
        public.canonical_jsonb_text(p_payload->'fields') then
      raise exception 'market_dna_version_invalid';
    end if;
  end if;
  insert into public.market_reference_evidence(user_id,market_reference_id,evidence_kind,schema_version,
    payload,source_locator,observed_at,analysis_identity,confidence,limitations,payload_hash,
    evidence_version,supersedes_evidence_id)
  values(p_user_id,p_market_reference_id,'DNA_INFERENCE',1,p_payload,v_ref.canonical_url,
    (p_payload->>'analyzed_at')::timestamptz,'HUMAN_REVIEW',p_payload->>'confidence',
    p_payload->'limitations',v_hash,v_version,(p_payload->>'supersedes_evidence_id')::uuid)
  returning * into v_row;
  return v_row;
end; $$;

revoke all on function public.persist_tiktok_market_observations(uuid,jsonb) from public,anon,authenticated;
revoke all on function public.set_tiktok_market_disposition(uuid,uuid,text) from public,anon,authenticated;
revoke all on function public.append_tiktok_market_dna(uuid,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.persist_tiktok_market_observations(uuid,jsonb) to service_role;
grant execute on function public.set_tiktok_market_disposition(uuid,uuid,text) to service_role;
grant execute on function public.append_tiktok_market_dna(uuid,uuid,jsonb) to service_role;

comment on table public.market_references is
  'POST-07 owner-submitted TikTok market references; never own-performance verdicts or lessons.';
comment on table public.market_reference_evidence is
  'POST-07 append-only FACT_OBSERVATION and HUMAN_REVIEW DNA_INFERENCE evidence.';
