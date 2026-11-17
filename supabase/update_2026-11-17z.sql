-- =====================================================================
-- FREIGHTCON by MARINCON - update 2026-11-17 z
--  1  clause deductible rules (percentage / fixed / as per policy default)
--  2  cover note import: storage bucket "cover-notes", policy_drafts,
--     policy_documents, admin_approve_policy_draft (one transaction)
--  3  claims management: staff-created claims linked to client / office /
--     policy / user / shipment, handler, financials, surveyor & GA,
--     document checklist, internal timeline, notifications (+ bell)
-- Run after update_2026-11-17y.sql. Safe to run more than once.
-- Edge functions: parse-cover-note, send-claim-notification (see README).
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1  deductible rule of a clause in a list (general, client group, client, subcategory)
-- ---------------------------------------------------------------------
create table if not exists public.clause_deductible_rules (
  id bigserial primary key,
  scope_type text not null check (scope_type in ('one_off_general','client_group','customer','policy')),
  scope_id bigint,
  clause_id bigint not null references public.clause_library(id) on delete cascade,
  mode text not null default 'policy_default' check (mode in ('policy_default','percentage','fixed')),
  pct numeric check (pct is null or (pct > 0 and pct <= 100)),
  amount numeric check (amount is null or amount >= 0),
  currency text check (currency is null or currency in ('EUR','USD','GBP','SGD')),
  min_amount numeric check (min_amount is null or min_amount >= 0),
  max_amount numeric check (max_amount is null or max_amount >= 0),
  basis text not null default 'sum_insured' check (basis in ('sum_insured','loss','each_package')),
  note text check (note is null or length(note) <= 300),
  updated_at timestamptz not null default now(),
  constraint clause_deductible_rules_minmax check (min_amount is null or max_amount is null or max_amount >= min_amount)
);
create unique index if not exists clause_deductible_rules_key on public.clause_deductible_rules(scope_type, coalesce(scope_id, 0), clause_id);
alter table public.clause_deductible_rules enable row level security;
drop policy if exists staff_read on public.clause_deductible_rules;
drop policy if exists role_write on public.clause_deductible_rules;
create policy staff_read on public.clause_deductible_rules for select to authenticated using (public.is_admin());
create policy role_write on public.clause_deductible_rules for all to authenticated using (public.has_role('placing')) with check (public.has_role('placing'));
drop trigger if exists clause_deductible_rules_no_dashes on public.clause_deductible_rules;
create trigger clause_deductible_rules_no_dashes before insert or update on public.clause_deductible_rules for each row execute function public.no_dashes();

-- ---------------------------------------------------------------------
-- 2  cover note import
-- ---------------------------------------------------------------------
do $$
begin
  if exists (select 1 from information_schema.tables where table_schema = 'storage' and table_name = 'buckets') then
    insert into storage.buckets(id, name, public, file_size_limit) values ('cover-notes', 'cover-notes', false, 26214400)
    on conflict (id) do update set file_size_limit = 26214400, public = false;
    execute 'drop policy if exists "cover notes staff" on storage.objects';
    execute $p$create policy "cover notes staff" on storage.objects for all to authenticated
             using (bucket_id = 'cover-notes' and public.has_role('placing')) with check (bucket_id = 'cover-notes' and public.has_role('placing'))$p$;
  end if;
end $$;

create table if not exists public.policy_drafts (
  id uuid primary key default gen_random_uuid(),
  client_id bigint references public.customers(id) on delete set null,
  target_mode text not null check (target_mode in ('new_client_and_policy','existing_client_new_policy')),
  source_file_path text,
  source_file_name text,
  source_mime_type text,
  raw_extracted_json jsonb,
  draft_payload_json jsonb,
  confidence_summary jsonb,
  status text not null default 'uploading' check (status in ('uploading','parsing','ready_for_review','approved','discarded','failed')),
  error text,
  policy_id bigint references public.policies(id) on delete set null,
  created_by uuid default auth.uid() references public.profiles(id) on delete set null,
  approved_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists policy_drafts_status on public.policy_drafts(status, created_at desc);
alter table public.policy_drafts enable row level security;
drop policy if exists staff_all on public.policy_drafts;
create policy staff_all on public.policy_drafts for all to authenticated using (public.has_role('placing')) with check (public.has_role('placing'));
drop trigger if exists policy_drafts_touch on public.policy_drafts;
create trigger policy_drafts_touch before update on public.policy_drafts for each row execute function public.touch_updated_at();

-- documents of a subcategory (the original cover note, later more)
create table if not exists public.policy_documents (
  id bigserial primary key,
  policy_id bigint not null references public.policies(id) on delete cascade,
  bucket text not null default 'cover-notes',
  path text not null,
  name text not null check (length(name) <= 200),
  mime text,
  size bigint,
  kind text not null default 'cover_note' check (kind in ('cover_note','wording','endorsement','other')),
  draft_id uuid references public.policy_drafts(id) on delete set null,
  uploaded_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now()
);
create index if not exists policy_documents_policy on public.policy_documents(policy_id);
alter table public.policy_documents enable row level security;
drop policy if exists staff_read on public.policy_documents;
drop policy if exists role_write on public.policy_documents;
create policy staff_read on public.policy_documents for select to authenticated using (public.is_admin());
create policy role_write on public.policy_documents for all to authenticated using (public.has_role('placing')) with check (public.has_role('placing'));

-- Approve & create: client (if new), subcategory, policy year, market security, clause list (active + standby),
-- new clauses (master library or own), deductibles, compliance / war, the cover note as document. One transaction.
create or replace function public.admin_approve_policy_draft(p_id uuid, p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  d public.policy_drafts; v_cust bigint; v_pol bigint; v_cur text; v_sum numeric := 0; x jsonb; v_cid bigint; v_i int := 0; v_ded bigint;
  v_start date; v_end date; v_name text; v_no text; v_sec jsonb := '[]'::jsonb; v_lib boolean := coalesce((p->>'save_new_to_library')::boolean, false);
  v_code text; v_notes text; num jsonb;
  f_num constant text := '^-?[0-9]+(\.[0-9]+)?$';
begin
  if not public.has_role('placing') then raise exception 'not authorised'; end if;
  select * into d from public.policy_drafts where id = p_id for update;
  if not found then raise exception 'draft not found'; end if;
  if d.status = 'approved' then raise exception 'this draft is already approved'; end if;
  if d.status = 'discarded' then raise exception 'this draft was discarded'; end if;

  -- validation
  v_cur := upper(coalesce(p#>>'{policy,base_currency}', ''));
  if v_cur not in ('EUR','USD','GBP','SGD') then raise exception 'choose the policy currency (EUR, USD, GBP or SGD)'; end if;
  v_no := nullif(trim(coalesce(p#>>'{policy,policy_number}', '')), '');
  v_name := nullif(trim(coalesce(p#>>'{policy,name}', '')), '');
  if v_no is null then raise exception 'the policy number is required'; end if;
  v_start := nullif(p#>>'{policy,inception_date}', '')::date; v_end := nullif(p#>>'{policy,expiry_date}', '')::date;
  if v_start is null or v_end is null then raise exception 'inception and expiry date are required'; end if;
  if v_end < v_start then raise exception 'the expiry date lies before the inception date'; end if;
  if jsonb_array_length(coalesce(p->'security', '[]'::jsonb)) = 0 then raise exception 'add at least one insurer'; end if;
  for x in select * from jsonb_array_elements(p->'security') loop
    if coalesce(trim(x->>'insurer_name'), '') = '' then raise exception 'every insurer row needs a name'; end if;
    v_sum := v_sum + coalesce(nullif(x->>'share_pct', '')::numeric, 0);
    v_sec := v_sec || jsonb_strip_nulls(jsonb_build_object('insurer', trim(x->>'insurer_name'), 'share', nullif(x->>'share_pct', '')::numeric,
              'lead', case when coalesce((x->>'is_lead')::boolean, false) then true end, 'broker', nullif(trim(coalesce(x->>'broker_intermediary', '')), ''),
              'brokerage_pct', nullif(x->>'brokerage_pct', '')::numeric));
  end loop;
  if abs(v_sum - 100) > 0.005 then raise exception 'the market security must total 100.00 %% (now %)', round(v_sum, 2); end if;

  -- client
  if d.target_mode = 'existing_client_new_policy' or coalesce(p#>>'{client,mode}', '') = 'existing' then
    v_cust := coalesce(nullif(p#>>'{client,client_id}', '')::bigint, d.client_id);
    if v_cust is null or not exists (select 1 from public.customers where id = v_cust) then raise exception 'choose the existing client'; end if;
    update public.customers set cover_type = 'open_cover' where id = v_cust and cover_type is distinct from 'open_cover';
  else
    if coalesce(trim(p#>>'{client,name}'), '') = '' then raise exception 'the client name is required'; end if;
    insert into public.customers(name, group_id, cover_type, currencies, country, company_type, active, notes)
    values (trim(p#>>'{client,name}'), nullif(p#>>'{client,group_id}', '')::bigint, 'open_cover', array[v_cur], nullif(upper(trim(coalesce(p#>>'{client,country}', ''))), ''),
            'client', true, 'Created from cover note ' || coalesce(d.source_file_name, ''))
    returning id into v_cust;
  end if;

  -- subcategory (policy)
  v_notes := concat_ws(E'\n',
    case when nullif(p#>>'{policy,valuation_basis}', '') is not null then 'Valuation: ' || (p#>>'{policy,valuation_basis}') end,
    case when nullif(p#>>'{policy,storage_limit}', '') is not null then 'Storage limit: ' || v_cur || ' ' || (p#>>'{policy,storage_limit}') end,
    case when nullif(p#>>'{policy,accumulation_clause_notes}', '') is not null then 'Accumulation: ' || (p#>>'{policy,accumulation_clause_notes}') end,
    'Imported from cover note ' || coalesce(d.source_file_name, '') || ' on ' || to_char(now() at time zone 'Europe/Berlin', 'DD.MM.YYYY'));
  insert into public.policies(customer_id, name, policy_no, policyholder, currency, currencies, min_premium, deductible,
                              limit_conveyance, limit_on_deck, limit_post, security, notes, cover_type, active, rating)
  values (v_cust, left(coalesce(v_name, v_no), 150), v_no, nullif(trim(coalesce(p#>>'{policy,policyholder_name}', '')), ''), v_cur, array[v_cur],
          nullif(p#>>'{policy,min_premium}', '')::numeric, nullif(p#>>'{policy,default_deductible}', '')::numeric,
          nullif(nullif(p#>>'{policy,conveyance_limit}', '')::numeric, 0), nullif(nullif(p#>>'{policy,on_deck_barge_limit}', '')::numeric, 0),
          nullif(nullif(p#>>'{policy,parcel_post_limit}', '')::numeric, 0), v_sec, v_notes, 'open_cover', true, 'schedule')
  returning id into v_pol;

  -- policy year (replaces the automatic first year of a new subcategory)
  delete from public.policy_years where policy_id = v_pol;
  insert into public.policy_years(policy_id, label, starts_on, ends_on, status)
  values (v_pol, case when extract(year from v_start) = extract(year from v_end) or v_end - v_start <= 366 and extract(month from v_start) = 1 then to_char(v_start, 'YYYY')
                      else to_char(v_start, 'YYYY') || '/' || to_char(v_end, 'YY') end, v_start, v_end, case when v_end < current_date then 'expired' else 'active' end);

  -- valuation uplift
  if nullif(p#>>'{policy,default_uplift_pct}', '') is not null then
    insert into public.scope_settings(scope_type, scope_id, key, value) values ('policy', v_pol, 'uplift_pct', to_jsonb((p#>>'{policy,default_uplift_pct}')::numeric))
    on conflict (scope_type, scope_id, key) do update set value = excluded.value, updated_at = now();
  end if;

  -- main deductible
  if nullif(p#>>'{policy,default_deductible}', '') is not null then
    insert into public.policy_deductibles(policy_id, deductible_type, label, deductible_text, sort_order)
    values (v_pol, 'main', 'Standard Policy Deductible', coalesce(nullif(trim(coalesce(p#>>'{policy,default_deductible_text}', '')), ''),
            v_cur || ' ' || to_char((p#>>'{policy,default_deductible}')::numeric, 'FM999,999,999,990.00') || ' each and every loss'), 10);
  end if;

  -- clauses: library matches and new ones (to the master library or as own clauses of the subcategory)
  for x in select * from jsonb_array_elements(coalesce(p->'clauses', '[]'::jsonb)) loop
    if not coalesce((x->>'include')::boolean, true) then continue; end if;
    v_cid := nullif(x->>'library_clause_id', '')::bigint;
    if v_cid is not null and not exists (select 1 from public.clause_library where id = v_cid) then v_cid := null; end if;
    if v_cid is null then
      if coalesce(trim(x->>'title'), '') = '' or coalesce(trim(x->>'wording'), '') = '' then continue; end if;
      insert into public.clause_library(category, title, body, active, scope_type, scope_id, oneoff_list, source, sort)
      values (case when exists (select 1 from public.clause_categories where key = x->>'category') then x->>'category' else 'special' end,
              left(trim(x->>'title'), 200), trim(x->>'wording'), true,
              case when v_lib then 'one_off_general' else 'policy' end, case when v_lib then null else v_pol end, false, 'cover_note', 1000 + v_i)
      returning id into v_cid;
    end if;
    v_i := v_i + 1;
    insert into public.policy_clauses(policy_id, clause_id, enabled, sort) values (v_pol, v_cid, coalesce(x->>'default_state', 'active') = 'active', v_i)
    on conflict do nothing;
    if nullif(trim(coalesce(x->>'deductible_override', '')), '') is not null then
      insert into public.policy_deductibles(policy_id, deductible_type, label, deductible_text, sort_order)
      values (v_pol, 'condition', left(coalesce(nullif(trim(x->>'title'), ''), 'Clause deductible'), 120), trim(x->>'deductible_override'), 100 + v_i)
      returning id into v_ded;
      insert into public.clause_deductible_links(policy_id, clause_id, deductible_id) values (v_pol, v_cid, v_ded) on conflict do nothing;
    end if;
  end loop;

  -- compliance and war & strikes
  if jsonb_array_length(coalesce(p#>'{compliance,excluded_goods}', '[]'::jsonb)) > 0 then
    insert into public.scope_settings(scope_type, scope_id, key, value) values ('policy', v_pol, 'excluded_goods', p#>'{compliance,excluded_goods}')
    on conflict (scope_type, scope_id, key) do update set value = excluded.value, updated_at = now(); end if;
  if jsonb_array_length(coalesce(p#>'{compliance,blocked_countries}', '[]'::jsonb)) > 0 then
    insert into public.scope_settings(scope_type, scope_id, key, value) values ('policy', v_pol, 'blocked_countries', p#>'{compliance,blocked_countries}')
    on conflict (scope_type, scope_id, key) do update set value = excluded.value, updated_at = now(); end if;
  if jsonb_array_length(coalesce(p#>'{compliance,compliance_countries}', '[]'::jsonb)) > 0 then
    insert into public.scope_settings(scope_type, scope_id, key, value) values ('policy', v_pol, 'compliance_countries', p#>'{compliance,compliance_countries}')
    on conflict (scope_type, scope_id, key) do update set value = excluded.value, updated_at = now(); end if;
  for x in select * from jsonb_array_elements(coalesce(p#>'{compliance,war_strikes_excluded_areas}', '[]'::jsonb)) loop
    select code into v_code from public.war_areas
     where lower(code) = lower(x#>>'{}') or lower(name) = lower(x#>>'{}') or lower(name) like '%' || lower(x#>>'{}') || '%' order by length(name) limit 1;
    if v_code is not null and not exists (select 1 from public.war_exclusions where scope_type = 'policy' and scope_id = v_pol and area_code = v_code) then
      insert into public.war_exclusions(scope_type, scope_id, policy_id, area_code, active, note) values ('policy', v_pol, v_pol, v_code, true, 'from cover note');
    end if;
  end loop;
  if jsonb_array_length(coalesce(p->'rate_schedules', '[]'::jsonb)) > 0 then
    insert into public.scope_settings(scope_type, scope_id, key, value) values ('policy', v_pol, 'imported_rate_rows', p->'rate_schedules')
    on conflict (scope_type, scope_id, key) do update set value = excluded.value, updated_at = now(); end if;

  -- the original cover note becomes a document of the subcategory
  if d.source_file_path is not null then
    insert into public.policy_documents(policy_id, bucket, path, name, mime, kind, draft_id, uploaded_by)
    values (v_pol, 'cover-notes', d.source_file_path, left(coalesce(d.source_file_name, 'cover note'), 200), d.source_mime_type, 'cover_note', d.id, auth.uid());
  end if;

  update public.policy_drafts set status = 'approved', approved_by = auth.uid(), client_id = v_cust, policy_id = v_pol, draft_payload_json = p where id = d.id;
  insert into public.audit_log(user_id, user_name, entity, entity_id, summary)
  select auth.uid(), coalesce(full_name, email), 'policies', v_pol::text, 'Subcategory created from cover note ' || coalesce(d.source_file_name, '') from public.profiles where id = auth.uid();
  return jsonb_build_object('customer_id', v_cust, 'policy_id', v_pol);
end $$;
grant execute on function public.admin_approve_policy_draft(uuid, jsonb) to authenticated;

-- ---------------------------------------------------------------------
-- 3  claims management
-- ---------------------------------------------------------------------
alter table public.claims alter column user_id drop not null;
alter table public.claims alter column loss_type set default 'other';
alter table public.claims drop constraint if exists claims_description_check;
alter table public.claims add constraint claims_description_check check (length(description) <= 4000);
alter table public.claims add column if not exists customer_id bigint references public.customers(id) on delete set null;
alter table public.claims add column if not exists office_id bigint references public.offices(id) on delete set null;
alter table public.claims add column if not exists policy_id bigint references public.policies(id) on delete set null;
alter table public.claims add column if not exists certificate_id bigint references public.certificates(id) on delete set null;
alter table public.claims add column if not exists notification_date date;
alter table public.claims add column if not exists voyage_from text check (voyage_from is null or length(voyage_from) <= 200);
alter table public.claims add column if not exists voyage_to text check (voyage_to is null or length(voyage_to) <= 200);
alter table public.claims add column if not exists conveyance_vessel text check (conveyance_vessel is null or length(conveyance_vessel) <= 200);
alter table public.claims add column if not exists cargo_description text check (cargo_description is null or length(cargo_description) <= 1000);
alter table public.claims add column if not exists peril_cause text;
alter table public.claims add column if not exists deductible_applied numeric check (deductible_applied is null or deductible_applied >= 0);
alter table public.claims add column if not exists sum_insured numeric;
alter table public.claims add column if not exists standalone boolean not null default false;
alter table public.claims add column if not exists created_by uuid references public.profiles(id) on delete set null;
alter table public.claims drop constraint if exists claims_peril_cause_check;
alter table public.claims add constraint claims_peril_cause_check check (peril_cause is null or peril_cause in
  ('water_damage','shortage_theft','handling_breakage','reefer_breakdown','general_average','collision_grounding','contamination','other'));
-- what the client reported, as peril
update public.claims set peril_cause = case loss_type when 'wet' then 'water_damage' when 'theft' then 'shortage_theft' when 'shortage' then 'shortage_theft'
  when 'damage' then 'handling_breakage' when 'temperature' then 'reefer_breakdown' when 'general_average' then 'general_average' else 'other' end where peril_cause is null;
update public.claims c set customer_id = coalesce(c.customer_id, i.customer_id, public.user_customer_id(c.user_id)), policy_id = coalesce(c.policy_id, i.policy_id), office_id = coalesce(c.office_id, i.office_id),
       cargo_description = coalesce(c.cargo_description, i.goods_description), sum_insured = coalesce(c.sum_insured, i.sum_insured), notification_date = coalesce(c.notification_date, (c.created_at at time zone 'Europe/Berlin')::date)
  from public.indications i where i.id = c.indication_id and (c.customer_id is null or c.cargo_description is null);
create index if not exists claims_customer_idx on public.claims(customer_id);
create index if not exists claims_policy_idx on public.claims(policy_id);

-- internal (never shown to the client): handler, reserve, recovery, surveyor & general average
alter table public.claim_internal add column if not exists assigned_handler_id uuid references public.profiles(id) on delete set null;
alter table public.claim_internal add column if not exists recovery_amount numeric check (recovery_amount is null or recovery_amount >= 0);
alter table public.claim_internal add column if not exists recovery_party text check (recovery_party is null or length(recovery_party) <= 200);
alter table public.claim_internal add column if not exists recovery_status text check (recovery_status is null or recovery_status in ('not_started','notice_sent','time_extension','claim_filed','recovered','abandoned'));
alter table public.claim_internal add column if not exists surveyor_details jsonb not null default '{}'::jsonb;
alter table public.claim_internal add column if not exists ga_details jsonb not null default '{}'::jsonb;

-- timeline: internal events (reserve, notes, notifications) stay internal
alter table public.claim_events add column if not exists internal boolean not null default false;
alter table public.claim_events add column if not exists event_type text not null default 'message';
alter table public.claim_events add column if not exists meta jsonb;
drop policy if exists own_claim_events on public.claim_events;
create policy own_claim_events on public.claim_events for select to authenticated
  using (not internal and exists (select 1 from public.claims c where c.id = claim_id and c.user_id = auth.uid()));

-- documents: checklist type; internal files stay internal
alter table public.claim_files alter column user_id drop not null;
alter table public.claim_files add column if not exists doc_type text not null default 'other';
alter table public.claim_files add column if not exists internal boolean not null default false;
alter table public.claim_files drop constraint if exists claim_files_doc_type_check;
alter table public.claim_files add constraint claim_files_doc_type_check check (doc_type in ('commercial_invoice','packing_list','bill_of_lading','delivery_receipt',
  'notice_of_protest','survey_report','subrogation_letter','photos','notice_of_claim','letter_of_protest','other'));
drop policy if exists own_claim_files on public.claim_files;
create policy own_claim_files on public.claim_files for select to authenticated using (user_id = auth.uid() and not internal);

-- the names used in the claims module
drop view if exists public.claim_documents;
create view public.claim_documents with (security_invoker = true) as
  select id, claim_id, doc_type, name, path, size, mime, uploaded_by, internal, created_at from public.claim_files;
drop view if exists public.claim_timeline_events;
create view public.claim_timeline_events with (security_invoker = true) as
  select id, claim_id, event_type, author_role, author_name, body, status, internal, meta, created_at from public.claim_events;
grant select on public.claim_documents, public.claim_timeline_events to authenticated;

-- the client's own claims: never internal events or files
create or replace function public.my_claims() returns jsonb
language sql stable security definer set search_path = public as $function$
  select coalesce(jsonb_agg(x order by (x->>'created_at') desc), '[]'::jsonb) from (
    select to_jsonb(c) || jsonb_build_object(
      'shipment', (select jsonb_build_object('ref', i.ref, 'goods', i.goods_description, 'origin', i.origin_country, 'dest', i.dest_country,
                     'origin_place', i.origin_place, 'dest_place', i.dest_place, 'conveyance', i.conveyance, 'sum_insured', i.sum_insured, 'currency', i.currency)
                     from public.indications i where i.id = c.indication_id),
      'policy_no', (select policy_no from public.policies where id = c.policy_id),
      'events', (select coalesce(jsonb_agg(to_jsonb(e) - 'meta' order by e.created_at), '[]'::jsonb) from public.claim_events e where e.claim_id = c.id and not e.internal),
      'files',  (select coalesce(jsonb_agg(jsonb_build_object('id', f.id, 'path', f.path, 'name', f.name, 'size', f.size, 'mime', f.mime, 'uploaded_by', f.uploaded_by, 'doc_type', f.doc_type, 'created_at', f.created_at) order by f.created_at), '[]'::jsonb)
                   from public.claim_files f where f.claim_id = c.id and not f.internal)) x
      from public.claims c where c.user_id = auth.uid()
  ) s
$function$;

-- in-app notifications (bell) + e-mail via the edge function send-claim-notification
create table if not exists public.notifications (
  id bigserial primary key,
  recipient_user_id uuid references public.profiles(id) on delete cascade,
  recipient_group text not null default 'client' check (recipient_group in ('client','staff','handler','insurer')),
  recipient_email text,
  type text not null check (type in ('claim_created','claim_updated','claim_doc_added','claim_settled')),
  title text not null check (length(title) <= 200),
  message text check (message is null or length(message) <= 2000),
  entity_type text not null default 'claim' check (entity_type in ('claim')),
  entity_id bigint,
  is_read boolean not null default false,
  email_dispatched boolean not null default false,
  email_error text,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now()
);
create index if not exists notifications_recipient on public.notifications(recipient_user_id, is_read, created_at desc);
alter table public.notifications enable row level security;
drop policy if exists own_read on public.notifications;
drop policy if exists staff_read on public.notifications;
create policy own_read on public.notifications for select to authenticated using (recipient_user_id = auth.uid());
create policy staff_read on public.notifications for select to authenticated using (public.is_admin());
drop trigger if exists notifications_no_dashes on public.notifications;
create trigger notifications_no_dashes before insert or update on public.notifications for each row execute function public.no_dashes();

create or replace function public.mark_notifications_read(p_ids bigint[] default null) returns integer
language plpgsql security definer set search_path = public as $$
declare n integer;
begin
  update public.notifications set is_read = true
   where recipient_user_id = auth.uid() and not is_read and (p_ids is null or id = any(p_ids));
  get diagnostics n = row_count; return n;
end $$;
grant execute on function public.mark_notifications_read(bigint[]) to authenticated;

-- one notification (client user, handler / claims staff, lead insurer)
create or replace function public.claim_notify(c public.claims, p_type text, p_targets jsonb, p_message text) returns bigint[]
language plpgsql security definer set search_path = public as $$
declare ids bigint[] := '{}'; v_id bigint; v_title text; ci public.claim_internal; po public.policies; v_lead text; v_email text; s record;
begin
  v_title := case p_type when 'claim_created' then 'Claim ' || c.ref || ' opened' when 'claim_settled' then 'Claim ' || c.ref || ' settled'
                         when 'claim_doc_added' then 'New document on claim ' || c.ref else 'Claim ' || c.ref || ' updated' end;
  select * into ci from public.claim_internal where claim_id = c.id;
  if coalesce((p_targets->>'client')::boolean, false) and c.user_id is not null then
    insert into public.notifications(recipient_user_id, recipient_group, recipient_email, type, title, message, entity_id, created_by)
    select c.user_id, 'client', email, p_type, v_title, p_message, c.id, auth.uid() from public.profiles where id = c.user_id returning id into v_id;
    ids := ids || v_id;
  end if;
  if coalesce((p_targets->>'handler')::boolean, false) then
    for s in select id, email from public.profiles
              where id = ci.assigned_handler_id or (ci.assigned_handler_id is null and is_admin and is_active and staff_roles && array['claims']) loop
      if s.id is distinct from auth.uid() or ci.assigned_handler_id is not null then
        insert into public.notifications(recipient_user_id, recipient_group, recipient_email, type, title, message, entity_id, created_by)
        values (s.id, 'handler', s.email, p_type, v_title, p_message, c.id, auth.uid()) returning id into v_id;
        ids := ids || v_id;
      end if;
    end loop;
  end if;
  if coalesce((p_targets->>'insurer')::boolean, false) then
    select * into po from public.policies where id = c.policy_id;
    select coalesce((select e->>'insurer' from jsonb_array_elements(coalesce(po.security, '[]'::jsonb)) e where (e->>'lead')::boolean limit 1),
                    (select e->>'insurer' from jsonb_array_elements(coalesce(po.security, '[]'::jsonb)) e limit 1)) into v_lead;
    select email into v_email from public.insurers where id = ci.insurer_id;
    if v_email is null and v_lead is not null then select email into v_email from public.insurers where lower(name) = lower(v_lead) limit 1; end if;
    if v_email is not null then
      insert into public.notifications(recipient_user_id, recipient_group, recipient_email, type, title, message, entity_id, created_by)
      values (null, 'insurer', v_email, p_type, v_title || coalesce(' - policy ' || po.policy_no, ''), p_message, c.id, auth.uid()) returning id into v_id;
      ids := ids || v_id;
    end if;
  end if;
  if array_length(ids, 1) > 0 then
    insert into public.claim_events(claim_id, author_role, author_name, body, internal, event_type, meta)
    values (c.id, 'system', null, 'Notification sent: ' || concat_ws(', ', case when (p_targets->>'client')::boolean and c.user_id is not null then 'client' end,
              case when (p_targets->>'handler')::boolean then 'claims handler' end, case when (p_targets->>'insurer')::boolean and v_email is not null then 'lead insurer' end),
            true, 'notification', jsonb_build_object('ids', to_jsonb(ids), 'type', p_type));
  end if;
  return ids;
end $$;
revoke execute on function public.claim_notify(public.claims, text, jsonb, text) from public, anon, authenticated;

-- staff: create a claim (linked to client, office, policy, user, shipment / certificate)
create or replace function public.admin_create_claim(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare c public.claims; me public.profiles; v_year text := to_char(now() at time zone 'Europe/Berlin', 'YYYY'); v_ref text; v_cust bigint; i public.indications; ids bigint[];
  v_user uuid := nullif(p->>'linked_user_id', '')::uuid; v_pol bigint := nullif(p->>'policy_id', '')::bigint; v_off bigint := nullif(p->>'office_id', '')::bigint;
begin
  if not public.has_role('claims') then raise exception 'not authorised'; end if;
  select * into me from public.profiles where id = auth.uid();
  v_cust := nullif(p->>'client_id', '')::bigint;
  if v_cust is null or not exists (select 1 from public.customers where id = v_cust) then raise exception 'choose the client'; end if;
  if v_pol is not null and not exists (select 1 from public.policies where id = v_pol and customer_id = v_cust) then raise exception 'the policy does not belong to the client'; end if;
  if v_off is not null and not exists (select 1 from public.offices where id = v_off and customer_id = v_cust) then raise exception 'the office does not belong to the client'; end if;
  if v_user is not null and public.user_customer_id(v_user) is distinct from v_cust then raise exception 'the user does not belong to the client'; end if;
  if nullif(p->>'indication_id', '') is not null then select * into i from public.indications where id = (p->>'indication_id')::bigint; end if;
  if nullif(p->>'casualty_date', '') is not null and (p->>'casualty_date')::date > current_date + 1 then raise exception 'the date of loss lies in the future'; end if;
  if upper(coalesce(p->>'currency', 'EUR')) not in ('EUR','USD','GBP','SGD') then raise exception 'invalid currency'; end if;
  v_ref := nullif(upper(trim(coalesce(p->>'claim_reference', ''))), '');
  if v_ref is null then v_ref := 'CLM-' || v_year || '-' || lpad(public.next_counter('clm-' || v_year)::text, 4, '0'); end if;
  if exists (select 1 from public.claims where ref = v_ref) then raise exception 'the claim reference % exists already', v_ref; end if;

  insert into public.claims(ref, user_id, customer_id, office_id, policy_id, indication_id, certificate_id, cover_note_id, cover_note_no, status, loss_type, peril_cause,
       incident_date, notification_date, discovered_date, place, voyage_from, voyage_to, conveyance_vessel, cargo_description, description, estimated_amount, currency,
       deductible_applied, sum_insured, standalone, contact_name, created_by)
  values (v_ref, coalesce(v_user, i.user_id), v_cust, coalesce(v_off, i.office_id), case when coalesce((p->>'standalone')::boolean, false) then null else coalesce(v_pol, i.policy_id) end,
       i.id, nullif(p->>'certificate_id', '')::bigint,
       (select id from public.cover_notes where indication_id = i.id order by issued_at desc limit 1), (select number from public.cover_notes where indication_id = i.id order by issued_at desc limit 1),
       'reported', case p->>'peril_cause' when 'water_damage' then 'wet' when 'shortage_theft' then 'theft' when 'handling_breakage' then 'damage' when 'reefer_breakdown' then 'temperature'
                     when 'general_average' then 'general_average' else 'other' end,
       coalesce(nullif(p->>'peril_cause', ''), 'other'), nullif(p->>'casualty_date', '')::date, coalesce(nullif(p->>'notification_date', '')::date, current_date), nullif(p->>'casualty_date', '')::date,
       nullif(trim(coalesce(p->>'place', '')), ''), nullif(trim(coalesce(p->>'voyage_from', '')), ''), nullif(trim(coalesce(p->>'voyage_to', '')), ''),
       nullif(trim(coalesce(p->>'conveyance_vessel', '')), ''), nullif(trim(coalesce(p->>'cargo_description', '')), ''),
       coalesce(nullif(trim(coalesce(p->>'description', '')), ''), 'Claim opened by MARINCON'),
       nullif(p->>'claimed_amount', '')::numeric, upper(coalesce(p->>'currency', 'EUR')), nullif(p->>'deductible_applied', '')::numeric,
       coalesce(nullif(p->>'sum_insured', '')::numeric, i.sum_insured), coalesce((p->>'standalone')::boolean, false),
       (select full_name from public.profiles where id = coalesce(v_user, i.user_id)), auth.uid())
  returning * into c;
  insert into public.claim_internal(claim_id, handler, assigned_handler_id, reserve, internal_note, updated_at)
  values (c.id, (select upper(left(coalesce(full_name, email), 20)) from public.profiles where id = nullif(p->>'assigned_handler_id', '')::uuid),
          nullif(p->>'assigned_handler_id', '')::uuid,
          coalesce(nullif(p->>'estimated_reserve', '')::numeric, greatest(0, coalesce(c.estimated_amount, 0) - coalesce(c.deductible_applied, 0))),
          nullif(trim(coalesce(p->>'internal_notes', '')), ''), now())
  on conflict (claim_id) do nothing;
  insert into public.claim_events(claim_id, author_role, author_name, body, status, internal, event_type)
  values (c.id, 'system', null, 'Claim opened by MARINCON (' || coalesce(me.full_name, me.email) || ')', 'reported', false, 'created');
  ids := public.claim_notify(c, 'claim_created', p->'notify', 'Claim ' || c.ref || coalesce(' under policy ' || (select policy_no from public.policies where id = c.policy_id), '') || ' has been opened. Status: FNOL received.');
  return to_jsonb(c) || jsonb_build_object('notification_ids', to_jsonb(coalesce(ids, '{}')));
end $$;
grant execute on function public.admin_create_claim(jsonb) to authenticated;

-- staff: save the claim workspace (status, financials, surveyor, GA, notes) with timeline + notifications
create or replace function public.admin_save_claim(p_claim_id bigint, p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare c public.claims; o public.claims; ci public.claim_internal; me public.profiles; ids bigint[] := '{}'; v_st text; v_msg text := nullif(trim(coalesce(p->>'message', '')), ''); v_type text;
  v_res numeric; v_ref text;
begin
  if not public.has_role('claims') then raise exception 'not authorised'; end if;
  select * into me from public.profiles where id = auth.uid();
  select * into o from public.claims where id = p_claim_id for update;
  if not found then raise exception 'claim not found'; end if;
  select * into ci from public.claim_internal where claim_id = o.id;
  v_st := coalesce(nullif(p->>'status', ''), o.status);
  if v_st = 'settled' and nullif(p->>'insurer_paid_amount', '') is null and o.settled_amount is null then raise exception 'enter the amount paid by insurers'; end if;
  v_ref := coalesce(nullif(upper(trim(coalesce(p->>'claim_reference', ''))), ''), o.ref);
  if v_ref <> o.ref and exists (select 1 from public.claims where ref = v_ref) then raise exception 'the claim reference % exists already', v_ref; end if;

  update public.claims set ref = v_ref, status = v_st,
    peril_cause = coalesce(nullif(p->>'peril_cause', ''), peril_cause),
    incident_date = case when p ? 'casualty_date' then nullif(p->>'casualty_date', '')::date else incident_date end,
    notification_date = case when p ? 'notification_date' then nullif(p->>'notification_date', '')::date else notification_date end,
    voyage_from = case when p ? 'voyage_from' then nullif(trim(p->>'voyage_from'), '') else voyage_from end,
    voyage_to = case when p ? 'voyage_to' then nullif(trim(p->>'voyage_to'), '') else voyage_to end,
    conveyance_vessel = case when p ? 'conveyance_vessel' then nullif(trim(p->>'conveyance_vessel'), '') else conveyance_vessel end,
    cargo_description = case when p ? 'cargo_description' then nullif(trim(p->>'cargo_description'), '') else cargo_description end,
    currency = coalesce(nullif(upper(p->>'currency'), ''), currency),
    estimated_amount = case when p ? 'claimed_amount' then nullif(p->>'claimed_amount', '')::numeric else estimated_amount end,
    deductible_applied = case when p ? 'deductible_applied' then nullif(p->>'deductible_applied', '')::numeric else deductible_applied end,
    settled_amount = case when p ? 'insurer_paid_amount' then nullif(p->>'insurer_paid_amount', '')::numeric else settled_amount end,
    insurer_claim_no = case when p ? 'insurer_claim_no' then nullif(trim(p->>'insurer_claim_no'), '') else insurer_claim_no end
  where id = o.id returning * into c;

  v_res := case when p ? 'estimated_reserve' then nullif(p->>'estimated_reserve', '')::numeric else ci.reserve end;
  insert into public.claim_internal(claim_id, handler, assigned_handler_id, reserve, insurer_id, surveyor, internal_note, recovery_amount, recovery_party, recovery_status, surveyor_details, ga_details, updated_at)
  values (c.id, (select upper(left(coalesce(full_name, email), 20)) from public.profiles where id = nullif(p->>'assigned_handler_id', '')::uuid), nullif(p->>'assigned_handler_id', '')::uuid,
          v_res, nullif(p->>'insurer_id', '')::bigint, nullif(trim(coalesce(p#>>'{surveyor_details,name}', '')), ''), nullif(trim(coalesce(p->>'internal_notes', '')), ''),
          nullif(p->>'recovery_amount', '')::numeric, nullif(trim(coalesce(p->>'recovery_party', '')), ''), nullif(p->>'recovery_status', ''),
          coalesce(p->'surveyor_details', '{}'::jsonb), coalesce(p->'ga_details', '{}'::jsonb), now())
  on conflict (claim_id) do update set
    assigned_handler_id = case when p ? 'assigned_handler_id' then excluded.assigned_handler_id else claim_internal.assigned_handler_id end,
    handler = case when p ? 'assigned_handler_id' then coalesce(excluded.handler, claim_internal.handler) else claim_internal.handler end,
    reserve = excluded.reserve,
    insurer_id = case when p ? 'insurer_id' then excluded.insurer_id else claim_internal.insurer_id end,
    surveyor = case when p ? 'surveyor_details' then excluded.surveyor else claim_internal.surveyor end,
    internal_note = case when p ? 'internal_notes' then excluded.internal_note else claim_internal.internal_note end,
    recovery_amount = case when p ? 'recovery_amount' then excluded.recovery_amount else claim_internal.recovery_amount end,
    recovery_party = case when p ? 'recovery_party' then excluded.recovery_party else claim_internal.recovery_party end,
    recovery_status = case when p ? 'recovery_status' then excluded.recovery_status else claim_internal.recovery_status end,
    surveyor_details = case when p ? 'surveyor_details' then excluded.surveyor_details else claim_internal.surveyor_details end,
    ga_details = case when p ? 'ga_details' then excluded.ga_details else claim_internal.ga_details end,
    updated_at = now();

  -- timeline
  if v_st <> o.status then
    insert into public.claim_events(claim_id, author_role, author_name, body, status, internal, event_type)
    values (c.id, 'staff', coalesce(me.full_name, 'MARINCON'), v_msg, v_st, false, 'status');
  elsif v_msg is not null then
    insert into public.claim_events(claim_id, author_role, author_name, body, internal, event_type) values (c.id, 'staff', coalesce(me.full_name, 'MARINCON'), v_msg, false, 'message');
  end if;
  if v_res is distinct from ci.reserve then
    insert into public.claim_events(claim_id, author_role, author_name, body, internal, event_type, meta)
    values (c.id, 'system', coalesce(me.full_name, null), 'Reserve ' || coalesce(to_char(ci.reserve, 'FM999,999,999,990.00'), '-') || ' > ' || coalesce(to_char(v_res, 'FM999,999,999,990.00'), '-') || ' ' || c.currency, true, 'reserve',
            jsonb_build_object('from', ci.reserve, 'to', v_res));
  end if;
  if c.settled_amount is distinct from o.settled_amount or c.deductible_applied is distinct from o.deductible_applied or c.estimated_amount is distinct from o.estimated_amount then
    insert into public.claim_events(claim_id, author_role, author_name, body, internal, event_type)
    values (c.id, 'system', coalesce(me.full_name, null), concat_ws(' · ', case when c.estimated_amount is distinct from o.estimated_amount then 'Claimed ' || coalesce(to_char(c.estimated_amount, 'FM999,999,999,990.00'), '-') end,
             case when c.deductible_applied is distinct from o.deductible_applied then 'Deductible ' || coalesce(to_char(c.deductible_applied, 'FM999,999,999,990.00'), '-') end,
             case when c.settled_amount is distinct from o.settled_amount then 'Paid by insurers ' || coalesce(to_char(c.settled_amount, 'FM999,999,999,990.00'), '-') end) || ' ' || c.currency, true, 'financials');
  end if;
  if nullif(trim(coalesce(p->>'note', '')), '') is not null then
    insert into public.claim_events(claim_id, author_role, author_name, body, internal, event_type) values (c.id, 'staff', coalesce(me.full_name, 'MARINCON'), trim(p->>'note'), true, 'note');
  end if;

  v_type := case when v_st = 'settled' and o.status <> 'settled' then 'claim_settled' else 'claim_updated' end;
  if coalesce((p#>>'{notify,client}')::boolean, false) or coalesce((p#>>'{notify,handler}')::boolean, false) or coalesce((p#>>'{notify,insurer}')::boolean, false) then
    ids := public.claim_notify(c, v_type, p->'notify', concat_ws(' ', 'Status: ' || initcap(replace(v_st, '_', ' ')) || '.', v_msg));
  end if;
  return to_jsonb(c) || jsonb_build_object('notification_ids', to_jsonb(coalesce(ids, '{}')));
end $$;
grant execute on function public.admin_save_claim(bigint, jsonb) to authenticated;

-- staff: a document on the claim (checklist type, internal or shared with the client)
create or replace function public.admin_add_claim_file(p_claim_id bigint, p_path text, p_name text, p_size bigint, p_mime text, p_doc_type text default 'other', p_internal boolean default false, p_notify boolean default false) returns jsonb
language plpgsql security definer set search_path = public as $$
declare c public.claims; f public.claim_files; me public.profiles; ids bigint[] := '{}';
begin
  if not public.has_role('claims') then raise exception 'not authorised'; end if;
  select * into c from public.claims where id = p_claim_id;
  if not found then raise exception 'claim not found'; end if;
  select * into me from public.profiles where id = auth.uid();
  insert into public.claim_files(claim_id, user_id, path, name, size, mime, uploaded_by, doc_type, internal)
  values (c.id, c.user_id, p_path, left(p_name, 200), p_size, p_mime, 'staff', coalesce(nullif(p_doc_type, ''), 'other'), coalesce(p_internal, false)) returning * into f;
  insert into public.claim_events(claim_id, author_role, author_name, body, internal, event_type, meta)
  values (c.id, 'system', coalesce(me.full_name, null), 'Document added: ' || f.name, f.internal, 'document', jsonb_build_object('file_id', f.id, 'doc_type', f.doc_type));
  if p_notify and not f.internal then ids := public.claim_notify(c, 'claim_doc_added', '{"client": true}'::jsonb, 'A new document was added to claim ' || c.ref || ': ' || f.name); end if;
  return to_jsonb(f) || jsonb_build_object('notification_ids', to_jsonb(coalesce(ids, '{}')));
end $$;
grant execute on function public.admin_add_claim_file(bigint, text, text, bigint, text, text, boolean, boolean) to authenticated;

-- storage: staff upload claim documents for claims without a client user into "internal/<claim>/"
do $$
begin
  if exists (select 1 from information_schema.tables where table_schema = 'storage' and table_name = 'buckets') then
    execute 'drop policy if exists "claims admin" on storage.objects';
    execute $p$create policy "claims admin" on storage.objects for all to authenticated
             using (bucket_id = 'claims' and public.is_admin()) with check (bucket_id = 'claims' and public.is_admin())$p$;
  end if;
end $$;
