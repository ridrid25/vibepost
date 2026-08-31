-- POST-09: canonical creative parent/mutation lineage and read-only attribution.
-- Existing experiments, analyses and lessons remain authoritative.

alter table public.creative_identity_map
  add constraint creative_identity_map_id_user_creative_unique
  unique (id, user_id, creative_id);

create table public.creative_mutations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  child_identity_map_id uuid not null,
  child_creative_id text not null check (child_creative_id ~ '^creative-[0-9a-f]{64}$'),
  parent_identity_map_id uuid,
  parent_creative_id text check (parent_creative_id is null or parent_creative_id ~ '^creative-[0-9a-f]{64}$'),
  mutation_kind text not null check (mutation_kind in (
    'NEW_CONCEPT','CONTROLLED_MUTATION','MARKET_INSPIRED_TEST',
    'OWNER_REQUESTED_VARIATION','REWORK'
  )),
  changed_variable text check (changed_variable is null or (
    char_length(changed_variable) between 1 and 200 and
    changed_variable = btrim(changed_variable, ' ') and
    changed_variable !~ '[[:cntrl:]]'
  )),
  mutation_reason text check (mutation_reason is null or (
    char_length(mutation_reason) between 1 and 200 and
    mutation_reason = btrim(mutation_reason, ' ') and
    mutation_reason !~ '[[:cntrl:]]'
  )),
  source_hypothesis_id uuid,
  prior_evidence_experiment_id uuid,
  created_at timestamptz not null default now(),
  unique (user_id, child_creative_id),
  unique (id, user_id),
  foreign key (child_identity_map_id, user_id, child_creative_id)
    references public.creative_identity_map (id, user_id, creative_id),
  foreign key (parent_identity_map_id, user_id, parent_creative_id)
    references public.creative_identity_map (id, user_id, creative_id),
  foreign key (source_hypothesis_id, user_id)
    references public.content_hypotheses (id, user_id),
  foreign key (prior_evidence_experiment_id, user_id)
    references public.experiments (id, user_id),
  constraint creative_mutations_parent_pair_check check (
    (parent_identity_map_id is null) = (parent_creative_id is null)
  ),
  constraint creative_mutations_self_parent_check check (
    parent_creative_id is null or parent_creative_id <> child_creative_id
  ),
  constraint creative_mutations_kind_contract_check check (
    (mutation_kind = 'NEW_CONCEPT' and parent_creative_id is null
      and changed_variable is null)
    or (mutation_kind = 'CONTROLLED_MUTATION' and parent_creative_id is not null
      and changed_variable is not null and source_hypothesis_id is not null)
    or (mutation_kind = 'MARKET_INSPIRED_TEST')
    or (mutation_kind in ('OWNER_REQUESTED_VARIATION','REWORK')
      and parent_creative_id is not null)
  )
);

create index creative_mutations_parent_lookup
  on public.creative_mutations (user_id, parent_creative_id, created_at, id)
  where parent_creative_id is not null;

alter table public.creative_mutations enable row level security;
create policy "creative_mutations_owner_read" on public.creative_mutations
  for select using ((select auth.uid()) = user_id);
revoke all on table public.creative_mutations
  from public, anon, authenticated, service_role;
grant select on table public.creative_mutations to authenticated, service_role;

alter table public.experiments
  add column creative_mutation_id uuid,
  add column lineage_material_schema text,
  add column lineage_parent_material_vector jsonb,
  add column lineage_child_material_vector jsonb,
  add column lineage_constants_snapshot jsonb,
  add column lineage_material_diff jsonb,
  add column lineage_contract_hash text;

alter table public.experiments
  add constraint experiments_creative_mutation_owner_fk
    foreign key (creative_mutation_id, user_id)
    references public.creative_mutations (id, user_id),
  add constraint experiments_control_identity_creative_owner_fk
    foreign key (control_identity_map_id, user_id, control_creative_id)
    references public.creative_identity_map (id, user_id, creative_id),
  add constraint experiments_variant_identity_creative_owner_fk
    foreign key (variant_identity_map_id, user_id, variant_creative_id)
    references public.creative_identity_map (id, user_id, creative_id),
  add constraint experiments_lineage_schema_check
    check (lineage_material_schema is null or lineage_material_schema in ('tiktok_v1','youtube_v1')),
  add constraint experiments_lineage_hash_check
    check (lineage_contract_hash is null or lineage_contract_hash ~ '^[0-9a-f]{64}$'),
  add constraint experiments_lineage_complete_check check (
    (creative_mutation_id is null and lineage_material_schema is null
      and lineage_parent_material_vector is null and lineage_child_material_vector is null
      and lineage_constants_snapshot is null and lineage_material_diff is null
      and lineage_contract_hash is null)
    or
    (creative_mutation_id is not null and lineage_material_schema is not null
      and jsonb_typeof(lineage_parent_material_vector) = 'object'
      and jsonb_typeof(lineage_child_material_vector) = 'object'
      and jsonb_typeof(lineage_constants_snapshot) = 'object'
      and jsonb_typeof(lineage_material_diff) = 'object'
      and lineage_contract_hash is not null)
  );

create or replace function public.creative_material_fields(p_schema text)
returns text[] language sql immutable strict set search_path = '' as $$
  select case p_schema
    when 'tiktok_v1' then array[
      'topic','content_format','duration_bin','character_id','visual_style_id',
      'hook_type','pacing_profile','punch_type','loop_type','camera_profile',
      'prompt_framework_version'
    ]::text[]
    when 'youtube_v1' then array[
      'causal_pattern_class','payoff_class','prompt_framework_version',
      'fidelity_constraints_hash'
    ]::text[]
    else null::text[] end
$$;

create or replace function public.creative_material_value_valid(p_value text)
returns boolean language sql immutable set search_path = '' as $$
  select p_value is not null and char_length(p_value) between 1 and 200
    and p_value = normalize(p_value, NFC)
    and p_value = btrim(p_value, ' ')
    and p_value !~ '[[:cntrl:]]'
$$;

create or replace function public.creative_material_vector_valid(p_schema text, p_vector jsonb)
returns boolean language sql immutable set search_path = '' as $$
  select public.creative_material_fields(p_schema) is not null
    and jsonb_typeof(p_vector) = 'object'
    and (select array_agg(k order by k) from jsonb_object_keys(p_vector) k) =
      (select array_agg(k order by k) from unnest(public.creative_material_fields(p_schema)) k)
    and not exists (
      select 1 from unnest(public.creative_material_fields(p_schema)) k
      where jsonb_typeof(p_vector->k) <> 'string'
        or not public.creative_material_value_valid(p_vector->>k)
    )
$$;

create or replace function public.creative_rfc3339_timestamp_valid(p_value text)
returns boolean language plpgsql immutable set search_path = '' as $$
begin
  if p_value is null or p_value !~
      '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$'
    then return false; end if;
  perform p_value::timestamptz;
  return true;
exception when invalid_datetime_format or datetime_field_overflow then return false;
end; $$;

create or replace function public.creative_material_diff(
  p_schema text, p_parent jsonb, p_child jsonb
) returns jsonb language plpgsql immutable set search_path = '' as $$
declare v_fields text[]; v_result jsonb;
begin
  if not public.creative_material_vector_valid(p_schema,p_parent)
      or not public.creative_material_vector_valid(p_schema,p_child)
    then raise exception 'MUTATION_CONTRACT_VIOLATION'; end if;
  v_fields := public.creative_material_fields(p_schema);
  with compared as (
    select key, ordinality,
      p_parent->>key as parent_value, p_child->>key as child_value
    from unnest(v_fields) with ordinality f(key,ordinality)
  )
  select jsonb_build_object(
    'schema_version',1,
    'changed_material_variables',coalesce(jsonb_agg(to_jsonb(key) order by ordinality)
      filter(where parent_value <> 'UNKNOWN' and child_value <> 'UNKNOWN'
        and parent_value <> child_value),'[]'::jsonb),
    'unchanged_material_variables',coalesce(jsonb_agg(to_jsonb(key) order by ordinality)
      filter(where parent_value <> 'UNKNOWN' and child_value <> 'UNKNOWN'
        and parent_value = child_value),'[]'::jsonb),
    'unknown_comparisons',coalesce(jsonb_agg(to_jsonb(key) order by ordinality)
      filter(where parent_value = 'UNKNOWN' or child_value = 'UNKNOWN'),'[]'::jsonb),
    'limitations',case when bool_or(parent_value = 'UNKNOWN' or child_value = 'UNKNOWN')
      then '["unknown_material_comparisons"]'::jsonb else '[]'::jsonb end
  ) into v_result from compared;
  return v_result;
end; $$;

create or replace function public.creative_constants_snapshot(
  p_schema text, p_parent jsonb, p_changed_variable text
) returns jsonb language sql immutable set search_path = '' as $$
  select coalesce(jsonb_object_agg(key,p_parent->key order by key),'{}'::jsonb)
  from unnest(public.creative_material_fields(p_schema)) key
  where key <> p_changed_variable
$$;

create or replace function public.guard_creative_mutation_immutable()
returns trigger language plpgsql set search_path = '' as $$
begin
  raise exception 'MUTATION_HISTORY_IMMUTABLE';
end; $$;
create trigger creative_mutations_immutable
  before update or delete on public.creative_mutations
  for each row execute function public.guard_creative_mutation_immutable();

create or replace function public.guard_experiment_lineage_proof()
returns trigger language plpgsql set search_path = '' as $$
declare v_marker text;
begin
  if tg_op='INSERT' then
    if new.creative_mutation_id is not null or new.lineage_material_schema is not null
        or new.lineage_parent_material_vector is not null or new.lineage_child_material_vector is not null
        or new.lineage_constants_snapshot is not null or new.lineage_material_diff is not null
        or new.lineage_contract_hash is not null
      then raise exception 'MUTATION_LINEAGE_SERVICE_ONLY'; end if;
    return new;
  end if;
  if row(new.creative_mutation_id,new.lineage_material_schema,
      new.lineage_parent_material_vector,new.lineage_child_material_vector,
      new.lineage_constants_snapshot,new.lineage_material_diff,new.lineage_contract_hash)
    is not distinct from
    row(old.creative_mutation_id,old.lineage_material_schema,
      old.lineage_parent_material_vector,old.lineage_child_material_vector,
      old.lineage_constants_snapshot,old.lineage_material_diff,old.lineage_contract_hash)
    then
      if old.creative_mutation_id is not null and row(
          old.user_id,old.hypothesis_id,old.hypothesis,old.changed_variable,old.constants,
          old.success_metrics,old.control_video_id,old.platform,old.control_youtube_short_id,
          old.variant_youtube_short_id,old.control_identity_map_id,old.variant_identity_map_id,
          old.control_creative_id,old.variant_creative_id,old.control_material_vector,
          old.variant_material_vector,old.metric_source
        ) is distinct from row(
          new.user_id,new.hypothesis_id,new.hypothesis,new.changed_variable,new.constants,
          new.success_metrics,new.control_video_id,new.platform,new.control_youtube_short_id,
          new.variant_youtube_short_id,new.control_identity_map_id,new.variant_identity_map_id,
          new.control_creative_id,new.variant_creative_id,new.control_material_vector,
          new.variant_material_vector,new.metric_source
        ) then raise exception 'MUTATION_HISTORY_IMMUTABLE'; end if;
      return new;
    end if;
  if old.creative_mutation_id is not null then raise exception 'MUTATION_HISTORY_IMMUTABLE'; end if;
  if new.creative_mutation_id is null or new.lineage_material_schema is null
      or new.lineage_parent_material_vector is null or new.lineage_child_material_vector is null
      or new.lineage_constants_snapshot is null or new.lineage_material_diff is null
      or new.lineage_contract_hash is null then raise exception 'MUTATION_CONTRACT_VIOLATION'; end if;
  v_marker := current_setting('app.post09_lineage_contract_hash',true);
  if auth.role() <> 'service_role' or v_marker is distinct from new.lineage_contract_hash
    then raise exception 'MUTATION_LINEAGE_SERVICE_ONLY'; end if;
  perform 1 from public.creative_mutations m
    where m.id=new.creative_mutation_id and m.user_id=new.user_id;
  if not found then raise exception 'MUTATION_CONTRACT_VIOLATION'; end if;
  return new;
end; $$;
create trigger experiments_lineage_proof_guard
  before insert or update on public.experiments
  for each row execute function public.guard_experiment_lineage_proof();

revoke update on public.experiments from authenticated;
grant update (hypothesis_id,hypothesis,changed_variable,constants,success_metrics,
  control_video_id,result,confidence,lessons,status,updated_at,platform,
  control_youtube_short_id,variant_youtube_short_id,control_identity_map_id,
  variant_identity_map_id,control_creative_id,variant_creative_id,
  control_material_vector,variant_material_vector,metric_source)
  on public.experiments to authenticated;

create or replace function public.register_creative_mutation(
  p_user_id uuid, p_child_identity_map_id uuid, p_child_creative_id text,
  p_parent_identity_map_id uuid, p_parent_creative_id text,
  p_mutation_kind text, p_changed_variable text, p_mutation_reason text,
  p_source_hypothesis_id uuid, p_prior_evidence_experiment_id uuid default null
) returns public.creative_mutations
language plpgsql security definer set search_path = '' as $$
declare v_existing public.creative_mutations; v_row public.creative_mutations;
  v_cycle boolean; v_depth integer;
begin
  perform pg_advisory_xact_lock(hashtextextended(p_user_id::text,904));
  if p_child_creative_id !~ '^creative-[0-9a-f]{64}$'
      or p_mutation_kind not in ('NEW_CONCEPT','CONTROLLED_MUTATION','MARKET_INSPIRED_TEST',
        'OWNER_REQUESTED_VARIATION','REWORK')
      or p_child_creative_id is not distinct from p_parent_creative_id
      or (p_parent_identity_map_id is null) <> (p_parent_creative_id is null)
      or (p_mutation_kind='NEW_CONCEPT' and
        (p_parent_creative_id is not null or p_changed_variable is not null))
      or (p_mutation_kind='CONTROLLED_MUTATION' and
        (p_parent_creative_id is null or p_changed_variable is null or p_source_hypothesis_id is null
          or p_changed_variable not in ('topic','content_format','duration_bin','character_id',
            'visual_style_id','hook_type','pacing_profile','punch_type','loop_type',
            'camera_profile','prompt_framework_version','causal_pattern_class','payoff_class',
            'fidelity_constraints_hash')))
      or (p_mutation_kind in ('OWNER_REQUESTED_VARIATION','REWORK')
        and p_parent_creative_id is null)
    then raise exception 'MUTATION_CONTRACT_VIOLATION'; end if;
  perform 1 from public.creative_identity_map m where m.id=p_child_identity_map_id
    and m.user_id=p_user_id and m.creative_id=p_child_creative_id for key share;
  if not found then raise exception 'MUTATION_CONTRACT_VIOLATION'; end if;
  if p_parent_creative_id is not null then
    perform 1 from public.creative_identity_map m where m.id=p_parent_identity_map_id
      and m.user_id=p_user_id and m.creative_id=p_parent_creative_id for key share;
    if not found then raise exception 'MUTATION_CONTRACT_VIOLATION'; end if;
  end if;
  if p_source_hypothesis_id is not null then
    perform 1 from public.content_hypotheses h where h.id=p_source_hypothesis_id
      and h.user_id=p_user_id for key share;
    if not found then raise exception 'MUTATION_CONTRACT_VIOLATION'; end if;
  end if;
  if p_prior_evidence_experiment_id is not null then
    perform 1 from public.experiments e where e.id=p_prior_evidence_experiment_id
      and e.user_id=p_user_id for key share;
    if not found then raise exception 'MUTATION_CONTRACT_VIOLATION'; end if;
  end if;
  select * into v_existing from public.creative_mutations m
    where m.user_id=p_user_id and m.child_creative_id=p_child_creative_id for update;
  if found then
    if row(v_existing.parent_creative_id,v_existing.mutation_kind,v_existing.changed_variable,
        v_existing.mutation_reason,v_existing.source_hypothesis_id,
        v_existing.prior_evidence_experiment_id)
      is distinct from row(p_parent_creative_id,p_mutation_kind,p_changed_variable,p_mutation_reason,
        p_source_hypothesis_id,p_prior_evidence_experiment_id)
      then raise exception 'MUTATION_REPLAY_CONFLICT'; end if;
    return v_existing;
  end if;
  if p_parent_creative_id is not null then
    with recursive ancestors(creative_id,path,depth) as (
      select p_parent_creative_id,array[p_parent_creative_id]::text[],1
      union all
      select m.parent_creative_id,a.path||m.parent_creative_id,a.depth+1
      from ancestors a join public.creative_mutations m
        on m.user_id=p_user_id and m.child_creative_id=a.creative_id
      where m.parent_creative_id is not null and a.depth<128
        and not m.parent_creative_id=any(a.path)
    ) select bool_or(creative_id=p_child_creative_id),max(depth)
      into v_cycle,v_depth from ancestors;
    if coalesce(v_cycle,false) or coalesce(v_depth,0)>=128
      then raise exception 'MUTATION_CONTRACT_VIOLATION'; end if;
  end if;
  insert into public.creative_mutations (
    user_id,child_identity_map_id,child_creative_id,parent_identity_map_id,
    parent_creative_id,mutation_kind,changed_variable,mutation_reason,
    source_hypothesis_id,prior_evidence_experiment_id
  ) values (
    p_user_id,p_child_identity_map_id,p_child_creative_id,p_parent_identity_map_id,
    p_parent_creative_id,p_mutation_kind,p_changed_variable,p_mutation_reason,
    p_source_hypothesis_id,p_prior_evidence_experiment_id
  ) returning * into v_row;
  return v_row;
end; $$;

create or replace function public.bind_experiment_creative_mutation(
  p_user_id uuid, p_experiment_id uuid, p_mutation_id uuid
) returns public.experiments
language plpgsql security definer set search_path = '' as $$
declare v_e public.experiments; v_m public.creative_mutations; v_h public.content_hypotheses;
  v_control public.videos; v_variant public.videos; v_variant_count integer; v_variant_id uuid;
  v_control_map public.creative_identity_map; v_variant_map public.creative_identity_map;
  v_schema text; v_parent jsonb; v_child jsonb; v_diff jsonb; v_constants jsonb;
  v_hash text; v_contract jsonb;
begin
  perform pg_advisory_xact_lock(hashtextextended(p_user_id::text,904));
  select * into v_e from public.experiments e
    where e.id=p_experiment_id and e.user_id=p_user_id for update;
  select * into v_m from public.creative_mutations m
    where m.id=p_mutation_id and m.user_id=p_user_id for key share;
  if v_e.id is null or v_m.id is null or v_m.parent_creative_id is null
      or v_m.changed_variable is null or v_e.changed_variable<>v_m.changed_variable
      or v_e.hypothesis_id is distinct from v_m.source_hypothesis_id
      or v_m.prior_evidence_experiment_id is not distinct from v_e.id
    then raise exception 'MUTATION_CONTRACT_VIOLATION'; end if;
  select * into v_h from public.content_hypotheses h
    where h.id=v_m.source_hypothesis_id and h.user_id=p_user_id for key share;
  if v_h.id is null or v_e.hypothesis is distinct from v_h.statement
      or v_e.changed_variable is distinct from v_h.changed_variable
      or v_e.constants is distinct from v_h.constants
    then raise exception 'MUTATION_CONTRACT_VIOLATION'; end if;
  if v_e.creative_mutation_id is not null then
    if v_e.creative_mutation_id<>v_m.id then raise exception 'MUTATION_REPLAY_CONFLICT'; end if;
    return v_e;
  end if;
  if v_e.platform='tiktok' then
    v_schema := 'tiktok_v1';
    select * into v_control from public.videos v where v.id=v_e.control_video_id
      and v.user_id=p_user_id for key share;
    select count(*),(array_agg(v.id order by v.id))[1] into v_variant_count,v_variant_id from public.videos v
      where v.experiment_id=v_e.id and v.user_id=p_user_id;
    if v_control.id is null or v_variant_count<>1 then raise exception 'MUTATION_CONTRACT_VIOLATION'; end if;
    select * into v_variant from public.videos v where v.id=v_variant_id and v.user_id=p_user_id for key share;
    select * into v_control_map from public.creative_identity_map m
      where m.user_id=p_user_id and m.tiktok_video_row_id=v_control.id;
    select * into v_variant_map from public.creative_identity_map m
      where m.user_id=p_user_id and m.tiktok_video_row_id=v_variant.id;
    if v_control_map.creative_id is distinct from v_m.parent_creative_id
        or v_variant_map.creative_id is distinct from v_m.child_creative_id
      then raise exception 'MUTATION_CONTRACT_VIOLATION'; end if;
    v_parent:=jsonb_build_object(
      'topic',coalesce(v_control.topic,'UNKNOWN'),
      'content_format',coalesce(v_control.content_format,'UNKNOWN'),
      'duration_bin',case when v_control.duration_seconds is null then 'UNKNOWN'
        else ((v_control.duration_seconds/5)*5)::text||'-'||(((v_control.duration_seconds/5)*5)+4)::text end,
      'character_id',coalesce(v_control.character_id,'UNKNOWN'),
      'visual_style_id',coalesce(v_control.visual_style_id,'UNKNOWN'),
      'hook_type',coalesce(v_control.hook_type,'UNKNOWN'),
      'pacing_profile',coalesce(v_control.pacing_profile,'UNKNOWN'),
      'punch_type',coalesce(v_control.punch_type,'UNKNOWN'),
      'loop_type',coalesce(v_control.loop_type,'UNKNOWN'),
      'camera_profile',coalesce(v_control.camera_profile,'UNKNOWN'),
      'prompt_framework_version',coalesce(v_control.prompt_framework_version,'UNKNOWN'));
    v_child:=jsonb_build_object(
      'topic',coalesce(v_variant.topic,'UNKNOWN'),
      'content_format',coalesce(v_variant.content_format,'UNKNOWN'),
      'duration_bin',case when v_variant.duration_seconds is null then 'UNKNOWN'
        else ((v_variant.duration_seconds/5)*5)::text||'-'||(((v_variant.duration_seconds/5)*5)+4)::text end,
      'character_id',coalesce(v_variant.character_id,'UNKNOWN'),
      'visual_style_id',coalesce(v_variant.visual_style_id,'UNKNOWN'),
      'hook_type',coalesce(v_variant.hook_type,'UNKNOWN'),
      'pacing_profile',coalesce(v_variant.pacing_profile,'UNKNOWN'),
      'punch_type',coalesce(v_variant.punch_type,'UNKNOWN'),
      'loop_type',coalesce(v_variant.loop_type,'UNKNOWN'),
      'camera_profile',coalesce(v_variant.camera_profile,'UNKNOWN'),
      'prompt_framework_version',coalesce(v_variant.prompt_framework_version,'UNKNOWN'));
  elsif v_e.platform='youtube_shorts' then
    v_schema := 'youtube_v1'; v_parent:=v_e.control_material_vector; v_child:=v_e.variant_material_vector;
    if v_e.control_creative_id is distinct from v_m.parent_creative_id
        or v_e.variant_creative_id is distinct from v_m.child_creative_id
      then raise exception 'MUTATION_CONTRACT_VIOLATION'; end if;
  else raise exception 'MUTATION_CONTRACT_VIOLATION'; end if;
  if not public.creative_material_vector_valid(v_schema,v_parent)
      or not public.creative_material_vector_valid(v_schema,v_child)
      or not v_m.changed_variable=any(public.creative_material_fields(v_schema))
    then raise exception 'MUTATION_CONTRACT_VIOLATION'; end if;
  v_diff:=public.creative_material_diff(v_schema,v_parent,v_child);
  v_constants:=public.creative_constants_snapshot(v_schema,v_parent,v_m.changed_variable);
  if jsonb_array_length(v_diff->'changed_material_variables')<>1
      or v_diff->'changed_material_variables'->>0<>v_m.changed_variable
      or jsonb_array_length(v_diff->'unknown_comparisons')<>0
      or v_e.constants<>v_constants then raise exception 'MUTATION_CONTRACT_VIOLATION'; end if;
  v_contract:=jsonb_build_object('material_schema',v_schema,
    'parent_material_vector',v_parent,'child_material_vector',v_child,
    'constants_snapshot',v_constants,'material_diff',v_diff);
  v_hash:=encode(extensions.digest(convert_to(public.canonical_jsonb_text(v_contract),'UTF8'),'sha256'),'hex');
  perform set_config('app.post09_lineage_contract_hash',v_hash,true);
  update public.experiments set creative_mutation_id=v_m.id,lineage_material_schema=v_schema,
    lineage_parent_material_vector=v_parent,lineage_child_material_vector=v_child,
    lineage_constants_snapshot=v_constants,lineage_material_diff=v_diff,
    lineage_contract_hash=v_hash where id=v_e.id and user_id=p_user_id returning * into v_e;
  return v_e;
end; $$;

create or replace function public.creative_lineage_owner_allowed(p_user_id uuid)
returns boolean language sql stable security invoker set search_path = '' as $$
  select auth.role()='service_role' or auth.uid()=p_user_id
$$;

create or replace function public.get_creative_parent(p_user_id uuid,p_creative_id text)
returns setof public.creative_mutations language sql stable security definer set search_path = '' as $$
  select m.* from public.creative_mutations m
  where public.creative_lineage_owner_allowed(p_user_id) and m.user_id=p_user_id
    and m.child_creative_id=p_creative_id and m.parent_creative_id is not null
$$;
create or replace function public.get_creative_children(p_user_id uuid,p_creative_id text)
returns setof public.creative_mutations language sql stable security definer set search_path = '' as $$
  select m.* from public.creative_mutations m
  where public.creative_lineage_owner_allowed(p_user_id) and m.user_id=p_user_id
    and m.parent_creative_id=p_creative_id order by m.created_at,m.id
$$;
create or replace function public.get_creative_ancestors(p_user_id uuid,p_creative_id text)
returns table(creative_id text,generation_distance integer)
language sql stable security definer set search_path = '' as $$
  with recursive a(creative_id,distance,path) as (
    select m.parent_creative_id,1,array[p_creative_id,m.parent_creative_id]::text[]
    from public.creative_mutations m where m.user_id=p_user_id
      and m.child_creative_id=p_creative_id and m.parent_creative_id is not null
    union all
    select m.parent_creative_id,a.distance+1,a.path||m.parent_creative_id
    from a join public.creative_mutations m on m.user_id=p_user_id
      and m.child_creative_id=a.creative_id
    where m.parent_creative_id is not null and a.distance<128
      and not m.parent_creative_id=any(a.path)
  ) select a.creative_id,a.distance from a
  where public.creative_lineage_owner_allowed(p_user_id) order by a.distance
$$;
create or replace function public.get_creative_descendants(p_user_id uuid,p_creative_id text)
returns table(creative_id text,generation_distance integer)
language sql stable security definer set search_path = '' as $$
  with recursive d(creative_id,distance,path) as (
    select m.child_creative_id,1,array[p_creative_id,m.child_creative_id]::text[]
    from public.creative_mutations m where m.user_id=p_user_id and m.parent_creative_id=p_creative_id
    union all
    select m.child_creative_id,d.distance+1,d.path||m.child_creative_id
    from d join public.creative_mutations m on m.user_id=p_user_id
      and m.parent_creative_id=d.creative_id
    where d.distance<128 and not m.child_creative_id=any(d.path)
  ) select d.creative_id,d.distance from d
  where public.creative_lineage_owner_allowed(p_user_id) order by d.distance,d.creative_id
$$;
create or replace function public.get_creative_lineage_chain(p_user_id uuid,p_creative_id text)
returns table(creative_id text,generation_depth integer,lineage_status text)
language sql stable security definer set search_path = '' as $$
  with nodes as (
    select p_creative_id creative_id,0 distance
    union all select a.creative_id,a.generation_distance
      from public.get_creative_ancestors(p_user_id,p_creative_id) a
  ) select n.creative_id,max(n.distance)::integer,
    case when m.id is null then 'LEGACY_UNLINKED'
      when m.parent_creative_id is null and m.mutation_kind='NEW_CONCEPT' then 'ROOT'
      when exists(select 1 from public.experiments e where e.user_id=p_user_id
        and e.creative_mutation_id=m.id) then 'VERIFIED' else 'DECLARED_UNVERIFIED' end
  from nodes n left join public.creative_mutations m on m.user_id=p_user_id
    and m.child_creative_id=n.creative_id
  where public.creative_lineage_owner_allowed(p_user_id)
  group by n.creative_id,m.id,m.parent_creative_id,m.mutation_kind
  order by max(n.distance) desc
$$;

create or replace function public.resolve_creative_mutation_attribution(
  p_user_id uuid,p_experiment_id uuid
) returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_e public.experiments; v_m public.creative_mutations; v_a public.content_analysis_results;
  v_control numeric; v_variant numeric; v_relative jsonb; v_metric text; v_valid boolean:=false;
  v_limitations jsonb:='[]'::jsonb;
begin
  if not public.creative_lineage_owner_allowed(p_user_id) then return null; end if;
  select * into v_e from public.experiments e where e.id=p_experiment_id and e.user_id=p_user_id;
  if v_e.id is null or v_e.creative_mutation_id is null then
    return jsonb_build_object('experiment_id',p_experiment_id,'lineage_status','LEGACY_UNLINKED');
  end if;
  select * into v_m from public.creative_mutations m
    where m.id=v_e.creative_mutation_id and m.user_id=p_user_id;
  select * into v_a from public.content_analysis_results a
    where a.user_id=p_user_id and a.experiment_id=v_e.id and a.platform=v_e.platform
      and a.checkpoint=v_e.success_metrics->>'checkpoint'
    order by a.created_at desc,a.id desc limit 1;
  v_metric:=v_e.success_metrics->>'primary_metric';
  if v_a.id is null then v_limitations:='["analysis_checkpoint_or_platform_mismatch"]'::jsonb;
  elsif v_e.platform='tiktok' and v_a.metrics->>'primary_metric'=v_metric
      and jsonb_typeof(v_a.metrics->'control_rate')='number'
      and jsonb_typeof(v_a.metrics->'variant_rate')='number'
      and v_a.metric_sources->>v_metric in ('api','manual_tiktok_studio') then
    v_control:=(v_a.metrics->>'control_rate')::numeric;
    v_variant:=(v_a.metrics->>'variant_rate')::numeric;
    v_valid:=v_control between 0 and 1 and v_variant between 0 and 1;
  elsif v_e.platform='youtube_shorts'
      and jsonb_typeof(v_a.actual->'control_rate')='number'
      and jsonb_typeof(v_a.actual->'variant_rate')='number'
      and v_a.metric_sources->>'store'='published_shorts_stats'
      and jsonb_typeof(v_a.metric_sources->'control_snapshot')='object'
      and jsonb_typeof(v_a.metric_sources->'variant_snapshot')='object'
      and (select count(*) from jsonb_object_keys(v_a.metric_sources->'control_snapshot'))=2
      and (select count(*) from jsonb_object_keys(v_a.metric_sources->'variant_snapshot'))=2
      and v_a.metric_sources->'control_snapshot'->>'short_id'
        ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      and v_a.metric_sources->'variant_snapshot'->>'short_id'
        ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      and public.creative_rfc3339_timestamp_valid(
        v_a.metric_sources->'control_snapshot'->>'polled_at')
      and public.creative_rfc3339_timestamp_valid(
        v_a.metric_sources->'variant_snapshot'->>'polled_at') then
    v_control:=(v_a.actual->>'control_rate')::numeric;
    v_variant:=(v_a.actual->>'variant_rate')::numeric;
    v_valid:=v_control between 0 and 1 and v_variant between 0 and 1;
  else v_limitations:='["unsupported_metric_provenance"]'::jsonb; end if;
  if not v_valid then
    v_control:=null;v_variant:=null;
    if v_limitations='[]'::jsonb then v_limitations:='["unsupported_metric_provenance"]'::jsonb; end if;
  end if;
  v_relative:=case when not v_valid then jsonb_build_object('absolute_delta','UNKNOWN','relative_delta_pct','UNKNOWN')
    when v_control=0 then jsonb_build_object('absolute_delta',v_variant-v_control,'relative_delta_pct','UNKNOWN')
    else jsonb_build_object('absolute_delta',v_variant-v_control,
      'relative_delta_pct',((v_variant-v_control)/v_control)*100) end;
  return jsonb_build_object('parent_creative_id',v_m.parent_creative_id,
    'child_creative_id',v_m.child_creative_id,'experiment_id',v_e.id,
    'changed_variable',v_m.changed_variable,'constants',v_e.lineage_constants_snapshot,
    'platform',v_e.platform,'control_metrics',case when v_valid then jsonb_build_object(v_metric,v_control) else to_jsonb('UNKNOWN'::text) end,
    'variant_metrics',case when v_valid then jsonb_build_object(v_metric,v_variant) else to_jsonb('UNKNOWN'::text) end,
    'metric_delta',v_relative,'verdict',coalesce(v_a.conclusion,v_e.result,'UNKNOWN'),
    'confidence',coalesce(v_a.confidence,v_e.confidence,'LOW'),
    'limitations',v_limitations||coalesce(v_a.limitations,'[]'::jsonb));
end; $$;

create or replace function public.resolve_lesson_mutation_lineage(p_user_id uuid,p_lesson_id uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  with experiment_ids as (
    select distinct (ev->>'experiment_id')::uuid experiment_id
    from public.content_lessons l cross join lateral jsonb_array_elements(l.evidence) ev
    where l.id=p_lesson_id and l.user_id=p_user_id
      and ev->>'experiment_id' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    union
    select p.experiment_id from public.content_lesson_youtube_publications p
    where p.lesson_id=p_lesson_id and p.user_id=p_user_id
  )
  select case when not public.creative_lineage_owner_allowed(p_user_id) then null else
    coalesce(jsonb_agg(distinct jsonb_build_object('lesson_id',p_lesson_id,'experiment_id',e.id,
      'mutation_id',m.id,'parent_creative_id',m.parent_creative_id,
      'child_creative_id',m.child_creative_id,'changed_variable',m.changed_variable))
      filter(where m.id is not null),'[]'::jsonb) end
  from experiment_ids ids join public.experiments e on e.id=ids.experiment_id and e.user_id=p_user_id
  left join public.creative_mutations m on m.id=e.creative_mutation_id and m.user_id=p_user_id
$$;

create or replace function public.resolve_creative_lesson_lineage(p_user_id uuid,p_creative_id text)
returns jsonb language sql stable security definer set search_path = '' as $$
  with mutation_experiments as (
    select m.id mutation_id,e.id experiment_id
    from public.creative_mutations m join public.experiments e
      on e.user_id=p_user_id and e.creative_mutation_id=m.id
    where m.user_id=p_user_id and p_creative_id in (m.parent_creative_id,m.child_creative_id)
  ), lesson_links as (
    select distinct l.id lesson_id,(ev->>'experiment_id')::uuid experiment_id
    from public.content_lessons l cross join lateral jsonb_array_elements(l.evidence) ev
    where l.user_id=p_user_id
      and ev->>'experiment_id' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    union
    select p.lesson_id,p.experiment_id from public.content_lesson_youtube_publications p
    where p.user_id=p_user_id
  )
  select case when not public.creative_lineage_owner_allowed(p_user_id) then null else
    coalesce(jsonb_agg(distinct jsonb_build_object('creative_id',p_creative_id,
      'mutation_id',me.mutation_id,'experiment_id',me.experiment_id,'lesson_id',ll.lesson_id))
      filter(where ll.lesson_id is not null),'[]'::jsonb) end
  from mutation_experiments me left join lesson_links ll on ll.experiment_id=me.experiment_id
$$;

revoke execute on function public.register_creative_mutation(uuid,uuid,text,uuid,text,text,text,text,uuid,uuid)
  from public,anon,authenticated;
grant execute on function public.register_creative_mutation(uuid,uuid,text,uuid,text,text,text,text,uuid,uuid)
  to service_role;
revoke execute on function public.bind_experiment_creative_mutation(uuid,uuid,uuid)
  from public,anon,authenticated;
grant execute on function public.bind_experiment_creative_mutation(uuid,uuid,uuid)
  to service_role;

revoke execute on function public.get_creative_parent(uuid,text),
  public.get_creative_children(uuid,text),public.get_creative_ancestors(uuid,text),
  public.get_creative_descendants(uuid,text),public.get_creative_lineage_chain(uuid,text),
  public.resolve_creative_mutation_attribution(uuid,uuid),
  public.resolve_lesson_mutation_lineage(uuid,uuid),
  public.resolve_creative_lesson_lineage(uuid,text)
  from public,anon;
grant execute on function public.get_creative_parent(uuid,text),
  public.get_creative_children(uuid,text),public.get_creative_ancestors(uuid,text),
  public.get_creative_descendants(uuid,text),public.get_creative_lineage_chain(uuid,text),
  public.resolve_creative_mutation_attribution(uuid,uuid),
  public.resolve_lesson_mutation_lineage(uuid,uuid),
  public.resolve_creative_lesson_lineage(uuid,text)
  to authenticated,service_role;

comment on table public.creative_mutations is
  'POST-09 immutable canonical creative parent relation; market and owner preference IDs are never parents.';
comment on column public.experiments.creative_mutation_id is
  'Optional immutable binding to a proven platform-specific one-variable mutation; NULL is LEGACY_UNLINKED.';
