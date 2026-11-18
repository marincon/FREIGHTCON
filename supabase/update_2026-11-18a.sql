-- =====================================================================================================
-- FREIGHTCON update 2026-11-18a
--   1  IOC terminology audit for clause and template data (ISO country codes and ISO dates stay)
--   2  invitation (referral) discounts removed completely
--   3  colleague invitations by registered client users (company locked, office chosen, policy automatic)
--   4  claims lifecycle: new statuses, close and delete (soft / hard)
--   5  archive flags on cases, quotations, certificates, cover notes and claims; test cases restorable
--   6  default startup view, preferences, GDPR consent (profiles + audit log)
--   7  German IPT reduced to the core rule (on / auto / off)
--   8  quotation validity defaults, acceptance / decline / revision workflow (client and staff on behalf)
--   9  reminders with "archive until reminder", internal notes, client reminders (templates, rules, log)
--  10  notification categories, staff routing, e-mail dispatch through the outbox
--  12  numbering & initials framework (numbering_matrices, entity_initials)
-- Run after update_2026-11-17z.sql. Idempotent: can be run again.
-- =====================================================================================================

-- small helper: patch a function body in place (skips when the marker is there already)
create or replace function public._fc_patch(p_sig text, p_old text, p_new text, p_marker text) returns void
language plpgsql as $$
declare d text;
begin
  d := pg_get_functiondef(p_sig::regprocedure);
  if p_marker is not null and position(p_marker in d) > 0 then return; end if;
  if position(p_old in d) = 0 then raise exception '%: pattern not found: %', p_sig, left(p_old, 80); end if;
  execute replace(d, p_old, p_new);
end $$;

-- =====================================================================================================
-- 1  IOC terminology (Institute Cargo Clauses). Only clause / standard wording is changed.
-- =====================================================================================================
do $$
declare r record;
begin
  for r in select c.table_name, c.column_name from information_schema.columns c
              join information_schema.tables t on t.table_schema = c.table_schema and t.table_name = c.table_name and t.table_type = 'BASE TABLE'
            where c.table_schema = 'public' and c.data_type = 'text'
              and c.table_name in ('clause_library','master_clauses_library','text_templates','document_templates','policy_clauses','customer_clauses','clause_categories')
  loop
    execute format('update public.%I set %I = regexp_replace(%I, %L, %L, %L) where %I ~ %L',
      r.table_name, r.column_name, r.column_name,
      '\mISO(\s+(Cargo\s+)?(Clause|Clauses|Standard|Standards|Terms|Wording|Conditions))', 'IOC\1', 'g',
      r.column_name, '\mISO\s+(Cargo\s+)?(Clause|Clauses|Standard|Standards|Terms|Wording|Conditions)');
  end loop;
end $$;

-- =====================================================================================================
-- 2  remove invitation (referral) discounts
-- =====================================================================================================
create or replace function public.profiles_guard() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() and current_user not in ('postgres','service_role','supabase_admin') then
    if new.is_admin is distinct from old.is_admin or new.approved is distinct from old.approved
       or new.rejected is distinct from old.rejected
       or new.discount_mode is distinct from old.discount_mode or new.special_discount_pct is distinct from old.special_discount_pct
       or new.requested_company_name is distinct from old.requested_company_name
       or new.email is distinct from old.email or new.company is distinct from old.company
       or new.group_id is distinct from old.group_id or new.office_id is distinct from old.office_id
       or new.customer_id is distinct from old.customer_id or new.cover_type is distinct from old.cover_type
       or new.is_active is distinct from old.is_active or new.deleted_at is distinct from old.deleted_at
       or new.min_premium_override is distinct from old.min_premium_override
       or new.deductible_override is distinct from old.deductible_override
       or new.staff_roles is distinct from old.staff_roles then
      raise exception 'not allowed';
    end if;
  end if;
  return new;
end $$;

create or replace function public.admin_overview(p_days integer default 30) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare since timestamptz := now() - make_interval(days => greatest(p_days, 1));
begin
  if not public.is_admin() then raise exception 'not authorised'; end if;
  return jsonb_build_object(
    'indications', (select count(*) from public.indications where created_at >= since and not is_test),
    'requests',    (select count(*) from public.indications where quote_requested_at >= since and not is_test),
    'quoted',      (select count(*) from public.quotations where created_at >= since),
    'accepted',    (select count(*) from public.quotations where responded_at >= since and status = 'accepted'),
    'bound',       (select count(*) from public.cover_notes where issued_at >= since),
    'open_requests',(select count(*) from public.indications i where quote_requested_at is not null and stage in ('request','working_on_it')
                       and not is_test and not coalesce(is_archived, false)
                       and not exists (select 1 from public.quotations q where q.indication_id = i.id and q.status <> 'superseded')),
    'pending_users',(select count(*) from public.profiles where not approved and not rejected),
    'open_feedback',(select count(*) from public.feedback where not done),
    'premium_bound', (select coalesce(jsonb_object_agg(cur, total), '{}'::jsonb) from (
        select q.data->>'currency' cur, sum((q.data->>'total')::numeric) total
          from public.cover_notes c join public.quotations q on q.id = c.quotation_id
         where c.issued_at >= since group by 1) s),
    'by_day', (select coalesce(jsonb_agg(jsonb_build_object('d', d, 'n', n, 'r', r) order by d), '[]'::jsonb) from (
        select date_trunc('day', created_at)::date d, count(*) n, count(quote_requested_at) r
          from public.indications where created_at >= since and not is_test group by 1) s),
    'top_routes', (select coalesce(jsonb_agg(jsonb_build_object('route', route, 'n', n)), '[]'::jsonb) from (
        select origin_country || ' to ' || dest_country route, count(*) n from public.indications
         where created_at >= since and not is_test group by 1 order by 2 desc limit 6) s));
end $$;

-- the archive columns are needed by admin_overview above
alter table public.indications add column if not exists is_archived boolean not null default false;

do $$
declare r record;
begin
  for r in select p.oid::regprocedure sig from pg_proc p
            where p.pronamespace = 'public'::regnamespace and p.proname in ('admin_decide_referral','my_referrals','my_referral_code','gen_referral_code')
  loop execute 'drop function if exists ' || r.sig || ' cascade'; end loop;
end $$;
drop table if exists public.referrals cascade;
delete from public.settings where key in ('referral_discount_pct','referral_discount');

-- =====================================================================================================
-- 6 (part)  profile columns used below
-- =====================================================================================================
alter table public.profiles add column if not exists default_startup_view text;
alter table public.profiles add column if not exists gdpr_consent jsonb;
alter table public.profiles add column if not exists preferences jsonb not null default '{}'::jsonb;
alter table public.profiles add column if not exists department_label text;
alter table public.profiles add column if not exists invited_by uuid references public.profiles(id) on delete set null;
do $$ begin
  alter table public.profiles add constraint profiles_startup_chk check (default_startup_view is null or default_startup_view ~ '^[a-z_]{2,20}(:[a-z_]{2,20})?$');
exception when duplicate_object then null; end $$;
alter table public.user_groups add column if not exists default_startup_view text;

-- registration trigger without invitation codes
create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
declare m jsonb := coalesce(new.raw_user_meta_data, '{}'::jsonb);
begin
  insert into public.profiles(id, email, full_name, first_name, last_name, company, address_line, postcode, city, country, phone)
  values (new.id, lower(new.email),
          left(coalesce(nullif(trim(m->>'full_name'), ''), nullif(trim(concat_ws(' ', nullif(trim(m->>'first_name'), ''), nullif(trim(m->>'last_name'), ''))), '')), 100),
          left(nullif(trim(m->>'first_name'), ''), 60),
          left(nullif(trim(m->>'last_name'), ''), 60),
          left(nullif(trim(m->>'company'), ''), 150),
          left(nullif(trim(m->>'address_line'), ''), 150),
          left(nullif(trim(m->>'postcode'), ''), 20),
          left(nullif(trim(m->>'city'), ''), 80),
          left(nullif(trim(m->>'country'), ''), 80),
          left(nullif(trim(m->>'phone'), ''), 40))
  on conflict (id) do nothing;
  -- colleague invitations and staff-created users are announced by their own flows
  if coalesce(m->>'invited_by', '') = '' and coalesce(m->>'created_by_staff', '') = '' then
    perform public.emit('new_registration', jsonb_build_object(
      'email', lower(new.email), 'name', coalesce(nullif(m->>'full_name', ''), concat_ws(' ', m->>'first_name', m->>'last_name')), 'company', m->>'company', 'country', m->>'country',
      'address', concat_ws(', ', nullif(m->>'address_line', ''), nullif(concat_ws(' ', m->>'postcode', m->>'city'), ''), nullif(m->>'country', ''))));
    begin
      perform public.notify_staff('user_registered', 'New registration: ' || coalesce(nullif(m->>'company', ''), lower(new.email)),
        concat_ws(', ', nullif(m->>'full_name', ''), lower(new.email)), 'user', null, array['admin','placing'], 'customers');
    exception when undefined_function then null; end;
  end if;
  return new;
end $$;

alter table public.profiles drop column if exists referral_code;
alter table public.profiles drop column if exists referred_by;
alter table public.profiles drop column if exists client_discount_pct;

-- =====================================================================================================
-- 10  notifications: categories, more entity types, staff routing, e-mail through the outbox
-- =====================================================================================================
alter table public.notifications drop constraint if exists notifications_type_check;
alter table public.notifications drop constraint if exists notifications_entity_type_check;
alter table public.notifications drop constraint if exists notifications_recipient_group_check;
alter table public.notifications alter column entity_type drop not null;
alter table public.notifications alter column entity_id drop not null;
alter table public.notifications add column if not exists category text;
alter table public.notifications add column if not exists link text;
do $$ begin
  alter table public.notifications add constraint notifications_type_chk check (type ~ '^[a-z_]{3,40}$');
exception when duplicate_object then null; end $$;
do $$ begin
  alter table public.notifications add constraint notifications_entity_chk check (entity_type is null or entity_type in ('claim','case','quotation','certificate','cover_note','user','reminder','note','policy_year'));
exception when duplicate_object then null; end $$;
do $$ begin
  alter table public.notifications add constraint notifications_group_chk check (recipient_group in ('client','staff','handler','insurer'));
exception when duplicate_object then null; end $$;
do $$ begin
  alter table public.notifications add constraint notifications_category_chk check (category is null or category in ('cases','quotes','claims','team','reminders','deadlines','system'));
exception when duplicate_object then null; end $$;
update public.notifications set category = 'claims' where category is null and type like 'claim%';

create or replace function public.notifications_category() returns trigger
language plpgsql as $$
begin
  if new.category is null then
    new.category := case
      when new.type like 'claim%' then 'claims'
      when new.type like 'quote%' or new.type like 'quotation%' then 'quotes'
      when new.type like 'case%' or new.type like 'request%' then 'cases'
      when new.type like 'colleague%' or new.type like 'user%' then 'team'
      when new.type like 'reminder%' or new.type like 'note%' then 'reminders'
      when new.type like 'deadline%' or new.type like '%expir%' then 'deadlines'
      else 'system' end;
  end if;
  return new;
end $$;
drop trigger if exists notifications_category on public.notifications;
create trigger notifications_category before insert on public.notifications for each row execute function public.notifications_category();

-- routing of a user: preferences.notify.<category> = platform | email | both | off (default: platform; e-mail on for reminders)
create or replace function public.notify_channel(p_user uuid, p_category text) returns text
language sql stable security definer set search_path = public as $$
  select coalesce(nullif(p.preferences->'notify'->>p_category, ''), case when p_category = 'reminders' then 'both' else 'platform' end)
    from public.profiles p where p.id = p_user
$$;

-- one notification to one user; p_channel overrides the user's routing (platform | email | both)
create or replace function public.notify_user(p_user uuid, p_group text, p_type text, p_title text, p_message text,
  p_entity_type text default null, p_entity_id bigint default null, p_channel text default null, p_link text default null, p_category text default null)
returns bigint
language plpgsql security definer set search_path = public as $$
declare v_id bigint; v_ch text; v_cat text; v_email text;
begin
  if p_user is null then return null; end if;
  v_cat := coalesce(p_category, case
      when p_type like 'claim%' then 'claims' when p_type like 'quote%' then 'quotes' when p_type like 'case%' then 'cases'
      when p_type like 'colleague%' or p_type like 'user%' then 'team' when p_type like 'reminder%' or p_type like 'note%' then 'reminders'
      when p_type like 'deadline%' then 'deadlines' else 'system' end);
  v_ch := coalesce(p_channel, public.notify_channel(p_user, v_cat), 'platform');
  if v_ch = 'off' then return null; end if;
  select email into v_email from public.profiles where id = p_user and deleted_at is null;
  if not found then return null; end if;
  insert into public.notifications(recipient_user_id, recipient_group, recipient_email, type, category, title, message, entity_type, entity_id, link, created_by, is_read)
  values (p_user, coalesce(p_group, 'staff'), case when v_ch in ('email','both') then v_email end, p_type, v_cat, left(p_title, 200), left(p_message, 2000),
          p_entity_type, p_entity_id, p_link, auth.uid(), v_ch = 'email')
  returning id into v_id;
  if v_ch in ('email','both') and v_email is not null then
    perform public.emit('notification_email', jsonb_build_object('notification_id', v_id));
  end if;
  return v_id;
end $$;
revoke execute on function public.notify_user(uuid, text, text, text, text, text, bigint, text, text, text) from public, anon, authenticated;

-- the staff group (optionally only some roles); the acting user is skipped
create or replace function public.notify_staff(p_type text, p_title text, p_message text, p_entity_type text default null, p_entity_id bigint default null,
  p_roles text[] default array['admin','placing','claims'], p_link text default null)
returns bigint[]
language plpgsql security definer set search_path = public as $$
declare ids bigint[] := '{}'; v_id bigint; s record;
begin
  for s in select id from public.profiles
            where is_admin and coalesce(is_active, true) and deleted_at is null
              and (coalesce(cardinality(staff_roles), 0) = 0 or staff_roles && (p_roles || array['admin']))
              and id is distinct from auth.uid()
  loop
    v_id := public.notify_user(s.id, 'staff', p_type, p_title, p_message, p_entity_type, p_entity_id, null, p_link);
    if v_id is not null then ids := ids || v_id; end if;
  end loop;
  return ids;
end $$;
revoke execute on function public.notify_staff(text, text, text, text, bigint, text[], text) from public, anon, authenticated;

-- mark read: own notifications (staff may also mark any staff group item they see)
create or replace function public.mark_notifications_read(p_ids bigint[] default null) returns integer
language plpgsql security definer set search_path = public as $$
declare n integer;
begin
  update public.notifications set is_read = true
   where recipient_user_id = auth.uid() and not is_read and (p_ids is null or id = any(p_ids));
  get diagnostics n = row_count; return n;
end $$;
grant execute on function public.mark_notifications_read(bigint[]) to authenticated;

-- staff: unread counters per category (bell)
create or replace function public.my_notification_counts() returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_object_agg(category, n), '{}'::jsonb) from (
    select coalesce(category, 'system') category, count(*) n from public.notifications
     where recipient_user_id = auth.uid() and not is_read group by 1) s
$$;
grant execute on function public.my_notification_counts() to authenticated;

-- =====================================================================================================
-- 5  archive flags, test flags, restore of test cases
-- =====================================================================================================
alter table public.indications add column if not exists archived_at timestamptz;
alter table public.indications add column if not exists archived_by uuid;
alter table public.indications add column if not exists awaiting_client_since timestamptz;
alter table public.indications add column if not exists awaiting_client_reason text;
do $$ begin
  alter table public.indications add constraint indications_awaiting_chk check (awaiting_client_reason is null or awaiting_client_reason in ('reply','comment','missing_data','missing_documents'));
exception when duplicate_object then null; end $$;
do $$
declare t text;
begin
  foreach t in array array['quotations','certificates','cover_notes','claims'] loop
    execute format('alter table public.%I add column if not exists is_archived boolean not null default false', t);
    execute format('alter table public.%I add column if not exists archived_at timestamptz', t);
    execute format('alter table public.%I add column if not exists archived_by uuid', t);
    execute format('alter table public.%I add column if not exists is_test boolean not null default false', t);
  end loop;
end $$;
create index if not exists indications_archived on public.indications(is_archived) where is_archived;

-- test flag of a case is carried to its documents
create or replace function public.indications_test_sync() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.is_test is distinct from old.is_test then
    update public.quotations set is_test = new.is_test where indication_id = new.id;
    update public.certificates set is_test = new.is_test where indication_id = new.id;
    update public.cover_notes set is_test = new.is_test where indication_id = new.id;
    update public.claims set is_test = new.is_test where indication_id = new.id;
  end if;
  return new;
end $$;
drop trigger if exists indications_test_sync on public.indications;
create trigger indications_test_sync after update of is_test on public.indications for each row execute function public.indications_test_sync();
update public.quotations q set is_test = true from public.indications i where i.id = q.indication_id and i.is_test and not q.is_test;
update public.certificates q set is_test = true from public.indications i where i.id = q.indication_id and i.is_test and not q.is_test;
update public.cover_notes q set is_test = true from public.indications i where i.id = q.indication_id and i.is_test and not q.is_test;

-- table of an archivable module
create or replace function public.fc_entity_table(p_entity text) returns text
language sql immutable as $$
  select case p_entity when 'case' then 'indications' when 'quotation' then 'quotations' when 'certificate' then 'certificates'
                       when 'cover_note' then 'cover_notes' when 'claim' then 'claims' end
$$;

-- internal: archive / unarchive without role check (used by reminders)
create or replace function public.fc_set_archived(p_entity text, p_id bigint, p_archived boolean, p_by uuid) returns void
language plpgsql security definer set search_path = public as $$
declare t text := public.fc_entity_table(p_entity);
begin
  if t is null then raise exception 'unknown module %', p_entity; end if;
  execute format('update public.%I set is_archived = $1, archived_at = case when $1 then now() end, archived_by = case when $1 then $2 end where id = $3', t)
    using p_archived, p_by, p_id;
end $$;
revoke execute on function public.fc_set_archived(text, bigint, boolean, uuid) from public, anon, authenticated;

create or replace function public.admin_set_archived(p_entity text, p_ids bigint[], p_archived boolean) returns integer
language plpgsql security definer set search_path = public as $$
declare v bigint; n integer := 0;
begin
  if not (case when p_entity = 'claim' then public.has_role('claims') else public.has_role('placing') end) then raise exception 'not authorised'; end if;
  if public.fc_entity_table(p_entity) is null then raise exception 'unknown module %', p_entity; end if;
  foreach v in array coalesce(p_ids, '{}'::bigint[]) loop
    perform public.fc_set_archived(p_entity, v, p_archived, auth.uid()); n := n + 1;
  end loop;
  insert into public.audit_log(user_id, user_name, entity, entity_id, summary)
  select auth.uid(), (select coalesce(full_name, email) from public.profiles where id = auth.uid()), p_entity, array_to_string(p_ids, ','),
         case when p_archived then 'Archived ' else 'Restored to the main tab ' end || n || ' record(s)'
   where n > 0;
  return n;
end $$;
grant execute on function public.admin_set_archived(text, bigint[], boolean) to authenticated;

-- test case back to a normal case (is_test = false, is_archived = false)
create or replace function public.admin_restore_test_case(p_ids bigint[]) returns integer
language plpgsql security definer set search_path = public as $$
declare n integer;
begin
  if not public.has_role('placing') then raise exception 'not authorised'; end if;
  update public.indications set is_test = false, is_archived = false, archived_at = null, archived_by = null where id = any(p_ids);
  get diagnostics n = row_count;
  update public.quotations set is_archived = false where indication_id = any(p_ids);
  insert into public.audit_log(user_id, user_name, entity, entity_id, summary)
  values (auth.uid(), (select coalesce(full_name, email) from public.profiles where id = auth.uid()), 'case', array_to_string(p_ids, ','), 'Restored ' || n || ' test case(s) to normal cases');
  return n;
end $$;
grant execute on function public.admin_restore_test_case(bigint[]) to authenticated;

-- staff: mark a case as awaiting the client (reply, comment, missing data / documents)
create or replace function public.admin_set_awaiting_client(p_ids bigint[], p_reason text) returns integer
language plpgsql security definer set search_path = public as $$
declare n integer;
begin
  if not public.has_role('placing') then raise exception 'not authorised'; end if;
  if p_reason is not null and p_reason not in ('reply','comment','missing_data','missing_documents') then raise exception 'invalid reason'; end if;
  update public.indications set awaiting_client_since = case when p_reason is null then null else now() end, awaiting_client_reason = p_reason where id = any(p_ids);
  get diagnostics n = row_count; return n;
end $$;
grant execute on function public.admin_set_awaiting_client(bigint[], text) to authenticated;

-- =====================================================================================================
-- 4  claims lifecycle
-- =====================================================================================================
alter table public.claims drop constraint if exists claims_status_check;
update public.claims set status = case status
  when 'reported' then 'new_claim' when 'in_review' then 'under_review' when 'documents_requested' then 'survey_ordered'
  when 'surveyor_appointed' then 'survey_ordered' when 'with_insurer' then 'submitted_to_insurer' when 'settled' then 'paid_settled'
  when 'rejected' then 'repudiated_declined' else status end
 where status in ('reported','in_review','documents_requested','surveyor_appointed','with_insurer','settled','rejected');
update public.claim_events set status = case status
  when 'reported' then 'new_claim' when 'in_review' then 'under_review' when 'documents_requested' then 'survey_ordered'
  when 'surveyor_appointed' then 'survey_ordered' when 'with_insurer' then 'submitted_to_insurer' when 'settled' then 'paid_settled'
  when 'rejected' then 'repudiated_declined' else status end
 where status in ('reported','in_review','documents_requested','surveyor_appointed','with_insurer','settled','rejected');
alter table public.claims alter column status set default 'new_claim';
do $$ begin
  alter table public.claims add constraint claims_status_chk check (status in ('new_claim','under_review','survey_ordered','submitted_to_insurer','offer_settlement','paid_settled','repudiated_declined','closed'));
exception when duplicate_object then null; end $$;
alter table public.claims add column if not exists closed_at timestamptz;
alter table public.claims add column if not exists closed_by uuid;
alter table public.claims add column if not exists closure_reason text;
alter table public.claims add column if not exists deleted_at timestamptz;
alter table public.claims add column if not exists deleted_by uuid;
alter table public.claims add column if not exists delete_reason text;
alter table public.claims add column if not exists survey_date date;
alter table public.claims add column if not exists follow_up_date date;
alter table public.claims add column if not exists docs_requested_at timestamptz;
alter table public.claims add column if not exists docs_requested_items text;
do $$ begin
  alter table public.claims add constraint claims_closure_chk check (closure_reason is null or length(closure_reason) <= 500);
exception when duplicate_object then null; end $$;

-- old status names inside the claim functions
select public._fc_patch('public.report_claim(jsonb)', '''reported''', '''new_claim''', '''new_claim''');
select public._fc_patch('public.admin_create_claim(jsonb)', '''reported''', '''new_claim''', '''new_claim''');
do $$
declare r record;
begin
  -- admin_update_claim may have another signature in older installations: patch every overload
  for r in select oid::regprocedure::text sig from pg_proc where proname = 'admin_update_claim' and pronamespace = 'public'::regnamespace loop
    perform public._fc_patch(r.sig,
      '(''reported'',''in_review'',''documents_requested'',''surveyor_appointed'',''with_insurer'',''settled'',''rejected'',''closed'')',
      '(''new_claim'',''under_review'',''survey_ordered'',''submitted_to_insurer'',''offer_settlement'',''paid_settled'',''repudiated_declined'',''closed'')', '''new_claim''');
  end loop;
end $$;
select public._fc_patch('public.admin_save_claim(bigint, jsonb)', '''settled''', '''paid_settled''', '''paid_settled''');

-- client list: deleted claims are gone for the client
create or replace function public.my_claims() returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(x order by (x->>'created_at') desc), '[]'::jsonb) from (
    select (to_jsonb(c) - 'deleted_by' - 'delete_reason' - 'archived_by' - 'closed_by') || jsonb_build_object(
      'shipment', (select jsonb_build_object('ref', i.ref, 'goods', i.goods_description, 'origin', i.origin_country, 'dest', i.dest_country,
                     'origin_place', i.origin_place, 'dest_place', i.dest_place, 'conveyance', i.conveyance, 'sum_insured', i.sum_insured, 'currency', i.currency)
                     from public.indications i where i.id = c.indication_id),
      'policy_no', (select policy_no from public.policies where id = c.policy_id),
      'events', (select coalesce(jsonb_agg(to_jsonb(e) - 'meta' order by e.created_at), '[]'::jsonb) from public.claim_events e where e.claim_id = c.id and not e.internal),
      'files',  (select coalesce(jsonb_agg(jsonb_build_object('id', f.id, 'path', f.path, 'name', f.name, 'size', f.size, 'mime', f.mime, 'uploaded_by', f.uploaded_by, 'doc_type', f.doc_type, 'created_at', f.created_at) order by f.created_at), '[]'::jsonb)
                   from public.claim_files f where f.claim_id = c.id and not f.internal)) x
      from public.claims c where c.user_id = auth.uid() and c.deleted_at is null
  ) s
$$;

-- client-reported claims reach the claims staff in the bell
create or replace function public.claims_staff_alert() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.created_by is null and not new.is_test then
    perform public.notify_staff('claim_reported', 'New claim ' || new.ref || ' reported by the client',
      left(coalesce(new.description, ''), 300), 'claim', new.id, array['claims'], 'claims');
  end if;
  return new;
end $$;
drop trigger if exists claims_staff_alert on public.claims;
create trigger claims_staff_alert after insert on public.claims for each row execute function public.claims_staff_alert();

create or replace function public.admin_close_claim(p_id bigint, p_reason text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare c public.claims; me public.profiles;
begin
  if not public.has_role('claims') then raise exception 'not authorised'; end if;
  if length(trim(coalesce(p_reason, ''))) < 3 then raise exception 'please give a closure reason'; end if;
  select * into me from public.profiles where id = auth.uid();
  update public.claims set status = 'closed', closed_at = now(), closed_by = auth.uid(), closure_reason = left(trim(p_reason), 500), updated_at = now()
   where id = p_id and deleted_at is null returning * into c;
  if not found then raise exception 'claim not found'; end if;
  insert into public.claim_events(claim_id, author_role, author_name, body, status, internal, event_type, meta)
  values (c.id, 'staff', coalesce(me.full_name, me.email), 'Claim closed: ' || c.closure_reason, 'closed', false, 'status', jsonb_build_object('closed_at', c.closed_at));
  return jsonb_build_object('id', c.id, 'closed_at', c.closed_at);
end $$;
grant execute on function public.admin_close_claim(bigint, text) to authenticated;

create or replace function public.admin_delete_claim(p_id bigint, p_hard boolean, p_reason text) returns text
language plpgsql security definer set search_path = public as $$
declare c public.claims; me public.profiles;
begin
  if not public.has_role('claims') then raise exception 'not authorised'; end if;
  select * into me from public.profiles where id = auth.uid();
  select * into c from public.claims where id = p_id;
  if not found then raise exception 'claim not found'; end if;
  if coalesce(p_hard, false) then
    if not public.has_role('admin') then raise exception 'only staff admins can delete claims for good'; end if;
    delete from public.notifications where entity_type = 'claim' and entity_id = c.id;
    delete from public.reminders where entity_type = 'claim' and entity_id = c.id;
    delete from public.internal_notes where entity_type = 'claim' and entity_id = c.id;
    delete from public.claims where id = c.id;
    insert into public.audit_log(user_id, user_name, entity, entity_id, summary, reason)
    values (auth.uid(), coalesce(me.full_name, me.email), 'claim', c.id::text, 'Claim ' || c.ref || ' deleted for good', p_reason);
    return 'deleted';
  end if;
  update public.claims set deleted_at = now(), deleted_by = auth.uid(), delete_reason = left(nullif(trim(p_reason), ''), 500) where id = c.id;
  insert into public.audit_log(user_id, user_name, entity, entity_id, summary, reason)
  values (auth.uid(), coalesce(me.full_name, me.email), 'claim', c.id::text, 'Claim ' || c.ref || ' deleted (soft, restorable)', p_reason);
  return 'soft_deleted';
end $$;
grant execute on function public.admin_delete_claim(bigint, boolean, text) to authenticated;

create or replace function public.admin_restore_claim(p_id bigint) returns boolean
language plpgsql security definer set search_path = public as $$
begin
  if not public.has_role('claims') then raise exception 'not authorised'; end if;
  update public.claims set deleted_at = null, deleted_by = null, delete_reason = null where id = p_id;
  return found;
end $$;
grant execute on function public.admin_restore_claim(bigint) to authenticated;

-- staff: survey / follow-up dates and the list of documents asked from the client
create or replace function public.admin_claim_dates(p_id bigint, p jsonb) returns boolean
language plpgsql security definer set search_path = public as $$
begin
  if not public.has_role('claims') then raise exception 'not authorised'; end if;
  update public.claims set
    survey_date = case when p ? 'survey_date' then nullif(p->>'survey_date', '')::date else survey_date end,
    follow_up_date = case when p ? 'follow_up_date' then nullif(p->>'follow_up_date', '')::date else follow_up_date end,
    docs_requested_items = case when p ? 'docs_requested_items' then nullif(trim(p->>'docs_requested_items'), '') else docs_requested_items end,
    docs_requested_at = case when p ? 'docs_requested_items' then case when nullif(trim(p->>'docs_requested_items'), '') is null then null else coalesce(docs_requested_at, now()) end else docs_requested_at end
   where id = p_id;
  return found;
end $$;
grant execute on function public.admin_claim_dates(bigint, jsonb) to authenticated;

-- =====================================================================================================
-- 7  German IPT: one rule only. Auto = German route (from or to Germany) or German policyholder / assured.
-- =====================================================================================================
update public.german_ipt_settings set rule_holder_de = true, rule_assured_de = true, rule_domestic = true, rule_from_de = true, rule_to_de = true, combine = 'any', default_rate = 19
 where id = 1;
create or replace function public.ipt_eval(p_mode text, p_from text, p_to text, p_holder text, p_assured text) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare s public.german_ipt_settings; m text; why text[] := '{}'; r text; v_rate numeric;
begin
  select * into s from public.german_ipt_settings where id = 1;
  v_rate := coalesce(s.default_rate, 19);
  r := rtrim(rtrim(v_rate::text, '0'), '.');
  m := coalesce(p_mode, s.default_mode, 'auto');
  if m = 'off' then return jsonb_build_object('applied', false, 'rate', v_rate, 'mode', m, 'reason', 'German IPT turned off'); end if;
  if m = 'on' then return jsonb_build_object('applied', true, 'rate', v_rate, 'mode', m, 'reason', 'German IPT ' || r || '% applied: on by default'); end if;
  p_from := upper(coalesce(p_from, '')); p_to := upper(coalesce(p_to, '')); p_holder := upper(coalesce(p_holder, '')); p_assured := upper(coalesce(p_assured, ''));
  if p_from = 'DE' and p_to = 'DE' then why := why || 'Domestic German transport'::text;
  elsif p_from = 'DE' then why := why || 'Route from Germany'::text;
  elsif p_to = 'DE' then why := why || 'Route to Germany'::text; end if;
  if p_holder = 'DE' then why := why || 'German Policyholder'::text; end if;
  if p_assured = 'DE' and p_holder <> 'DE' then why := why || 'German Assured'::text; end if;
  return jsonb_build_object('applied', cardinality(why) > 0, 'rate', v_rate, 'mode', m,
    'reason', case when cardinality(why) > 0 then 'German IPT ' || r || '% applied: ' || array_to_string(why, ' & ')
                   else 'No German IPT: no German route, policyholder or assured' end);
end $$;

-- =====================================================================================================
-- 8  quotation validity and response workflow
-- =====================================================================================================
alter table public.customers add column if not exists quote_validity_days integer;
alter table public.policies add column if not exists quote_validity_days integer;
alter table public.customers add column if not exists allow_colleague_invites boolean not null default true;
do $$ begin
  alter table public.customers add constraint customers_qvd_chk check (quote_validity_days is null or quote_validity_days between 1 and 365);
exception when duplicate_object then null; end $$;
do $$ begin
  alter table public.policies add constraint policies_qvd_chk check (quote_validity_days is null or quote_validity_days between 1 and 365);
exception when duplicate_object then null; end $$;
insert into public.settings(key, value) values ('quote_validity_days', '3'::jsonb) on conflict (key) do nothing;
insert into public.settings(key, value) values ('quote_expiry_warn_hours', '48'::jsonb) on conflict (key) do nothing;
insert into public.settings(key, value) values ('startup_defaults', '{"staff":"admin:requests","client":"new","insurer":"insurer"}'::jsonb) on conflict (key) do nothing;
insert into public.settings(key, value) values ('gdpr', jsonb_build_object(
  'controller', 'MARINCON GmbH & Co. KG, Hamburg, Germany',
  'contact', 'Data protection: please use the contact details in the imprint.',
  'retention', 'Account data: for the duration of the account. Quotations, certificates, cover notes, claims and invoices: 10 years (German commercial and tax law). Log-in and audit records: 3 years. Cookie consent records: 3 years.',
  'version', '2026-11-18')) on conflict (key) do nothing;

alter table public.quotations add column if not exists number text;
alter table public.quotations add column if not exists order_ref text;
alter table public.quotations add column if not exists accepted_at timestamptz;
alter table public.quotations add column if not exists accepted_by uuid;
alter table public.quotations add column if not exists accepted_on_behalf boolean not null default false;
alter table public.quotations add column if not exists recorded_by uuid;
alter table public.quotations add column if not exists declined_at timestamptz;
alter table public.quotations add column if not exists revision_requested_at timestamptz;
alter table public.quotations add column if not exists revision_comment text;
alter table public.quotations add column if not exists expiry_notified_at timestamptz;
alter table public.quotations drop constraint if exists quotations_status_check;
do $$ begin
  alter table public.quotations add constraint quotations_status_chk check (status in ('open','accepted','declined','withdrawn','superseded','revision_requested'));
exception when duplicate_object then null; end $$;
do $$ begin
  alter table public.quotations add constraint quotations_order_ref_chk check (order_ref is null or length(order_ref) <= 120);
exception when duplicate_object then null; end $$;
update public.quotations set accepted_at = coalesce(accepted_at, responded_at) where status = 'accepted' and accepted_at is null;

-- default validity of a case: policy, then client, then the configuration
create or replace function public.quote_validity_days_for(p_indication bigint) returns integer
language sql stable security definer set search_path = public as $$
  select coalesce(po.quote_validity_days, cu.quote_validity_days, nullif((select value::text from public.settings where key = 'quote_validity_days'), 'null')::integer, 3)
    from public.indications i
    left join public.policies po on po.id = i.policy_id and not coalesce(i.is_standalone_one_off, false)
    left join public.customers cu on cu.id = coalesce(i.customer_id, po.customer_id)
   where i.id = p_indication
$$;
grant execute on function public.quote_validity_days_for(bigint) to authenticated;

-- the core of a response; p_on_behalf = staff recorded it
create or replace function public.quote_response_core(q public.quotations, p_action text, p_note text, p_order_ref text, p_on_behalf boolean) returns text
language plpgsql security definer set search_path = public as $$
declare i public.indications; p public.profiles; me public.profiles; v_note text := left(nullif(trim(coalesce(p_note, '')), ''), 1000);
begin
  if p_action not in ('accept','decline','revision') then raise exception 'invalid action'; end if;
  if p_action = 'revision' and v_note is null then raise exception 'please tell us what should be revised'; end if;
  select * into me from public.profiles where id = auth.uid();
  if p_action = 'accept' then
    update public.quotations set status = 'accepted', response_note = v_note, responded_at = now(), accepted_at = now(), accepted_by = auth.uid(),
           order_ref = left(nullif(trim(coalesce(p_order_ref, '')), ''), 120), accepted_on_behalf = p_on_behalf, recorded_by = case when p_on_behalf then auth.uid() end
     where id = q.id;
    update public.indications set stage = 'certificate', closure_reason = null where id = q.indication_id returning * into i;
  elsif p_action = 'decline' then
    update public.quotations set status = 'declined', response_note = v_note, responded_at = now(), declined_at = now(), recorded_by = case when p_on_behalf then auth.uid() end
     where id = q.id;
    update public.indications set stage = 'closed', closure_reason = 'not_taken_up' where id = q.indication_id returning * into i;
  else
    update public.quotations set status = 'revision_requested', response_note = v_note, revision_comment = v_note, responded_at = now(), revision_requested_at = now(),
           recorded_by = case when p_on_behalf then auth.uid() end
     where id = q.id;
    update public.indications set stage = 'working_on_it' where id = q.indication_id returning * into i;
  end if;
  select * into p from public.profiles where id = i.user_id;
  perform public.emit('quotation_response', jsonb_build_object('quotation_id', q.id, 'indication_id', i.id, 'ref', i.ref,
    'accepted', p_action = 'accept', 'action', p_action, 'on_behalf', p_on_behalf, 'note', v_note, 'order_ref', p_order_ref,
    'email', p.email, 'name', p.full_name, 'company', p.company, 'total', q.data->'total', 'currency', q.data->>'currency'));
  perform public.notify_staff(case p_action when 'accept' then 'quote_accepted' when 'decline' then 'quote_declined' else 'quote_revision' end,
    'Quotation ' || coalesce(i.ref, '#' || i.id) || case p_action when 'accept' then ' accepted' when 'decline' then ' declined' else ': revision requested' end
      || case when p_on_behalf then ' (recorded by ' || coalesce(me.full_name, me.email) || ')' else ' by ' || coalesce(p.company, p.email, 'the client') end,
    concat_ws(' | ', case when nullif(trim(coalesce(p_order_ref, '')), '') is not null then 'Order ref. ' || trim(p_order_ref) end, v_note),
    'case', i.id, array['placing'], 'requests');
  return case p_action when 'accept' then 'accepted' when 'decline' then 'declined' else 'revision_requested' end;
end $$;
revoke execute on function public.quote_response_core(public.quotations, text, text, text, boolean) from public, anon, authenticated;

create or replace function public.respond_to_quotation_v2(p_quotation_id bigint, p_action text, p_note text default null, p_order_ref text default null) returns text
language plpgsql security definer set search_path = public as $$
declare q public.quotations;
begin
  select q2.* into q from public.quotations q2 join public.indications i2 on i2.id = q2.indication_id
   where q2.id = p_quotation_id and i2.user_id = auth.uid() and q2.send_status = 'sent' for update of q2;
  if not found then raise exception 'not found'; end if;
  if q.status <> 'open' then raise exception 'quotation is no longer open'; end if;
  if q.valid_until < now() and p_action = 'accept' then raise exception 'quotation has expired'; end if;
  return public.quote_response_core(q, p_action, p_note, p_order_ref, false);
end $$;
grant execute on function public.respond_to_quotation_v2(bigint, text, text, text) to authenticated;

create or replace function public.respond_to_quotation(p_quotation_id bigint, p_accept boolean, p_note text) returns text
language sql security definer set search_path = public as $$
  select public.respond_to_quotation_v2(p_quotation_id, case when p_accept then 'accept' else 'decline' end, p_note, null)
$$;

create or replace function public.admin_record_quote_response(p_quotation_id bigint, p_action text, p_note text default null, p_order_ref text default null) returns text
language plpgsql security definer set search_path = public as $$
declare q public.quotations;
begin
  if not public.has_role('placing') then raise exception 'not authorised'; end if;
  select * into q from public.quotations where id = p_quotation_id for update;
  if not found then raise exception 'not found'; end if;
  if q.status not in ('open','revision_requested') then raise exception 'quotation is no longer open'; end if;
  return public.quote_response_core(q, p_action, p_note, p_order_ref, true);
end $$;
grant execute on function public.admin_record_quote_response(bigint, text, text, text) to authenticated;

create or replace function public.my_quotations() returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(x order by x->>'created_at' desc), '[]'::jsonb) from (
    select jsonb_build_object(
      'id', q.id, 'indication_id', i.id, 'ref', i.ref, 'version', q.version, 'number', q.number,
      'data', public.quote_redact(q.data, coalesce(q.display_mode, q.data->>'displayMode', public.display_mode_for(i.id))),
      'display_mode', coalesce(q.display_mode, q.data->>'displayMode', public.display_mode_for(i.id)),
      'valid_until', q.valid_until,
      'status', case when q.status = 'open' and q.valid_until < now() then 'expired' else q.status end,
      'response_note', q.response_note, 'responded_at', q.responded_at, 'created_at', coalesce(q.sent_at, q.created_at), 'seen_at', q.seen_at,
      'order_ref', q.order_ref, 'accepted_at', q.accepted_at, 'accepted_on_behalf', q.accepted_on_behalf, 'revision_comment', q.revision_comment,
      'cover_note', (select jsonb_build_object('id', c.id, 'number', c.number, 'issued_at', c.issued_at, 'data', c.data)
                       from public.cover_notes c where c.indication_id = i.id order by c.issued_at desc limit 1)) x
      from public.quotations q join public.indications i on i.id = q.indication_id
     where i.user_id = auth.uid() and q.status <> 'superseded' and q.send_status = 'sent'
  ) s
$$;

-- staff bell: new requests from clients
create or replace function public.indications_staff_alert() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.quote_requested_at is not null and old.quote_requested_at is null and not new.is_test then
    perform public.notify_staff('case_request', 'New request ' || coalesce(new.ref, '#' || new.id) || coalesce(' from ' || nullif(new.company, ''), ''),
      concat_ws(' | ', new.origin_country || ' to ' || new.dest_country, left(new.goods_description, 120), nullif(left(coalesce(new.customer_comment, ''), 300), '')),
      'case', new.id, array['placing'], 'requests');
  end if;
  return new;
end $$;
drop trigger if exists indications_staff_alert on public.indications;
create trigger indications_staff_alert after update of quote_requested_at on public.indications for each row execute function public.indications_staff_alert();

-- =====================================================================================================
-- 9  reminders, internal notes, client reminders
-- =====================================================================================================
create table if not exists public.reminders (
  id bigint generated by default as identity primary key,
  entity_type text not null check (entity_type in ('case','quotation','certificate','cover_note','claim')),
  entity_id bigint not null,
  remind_at timestamptz not null,
  priority text not null default 'normal' check (priority in ('low','normal','high','urgent')),
  title text not null check (length(title) between 1 and 200),
  note text check (note is null or length(note) <= 2000),
  assignees uuid[] not null default '{}',
  channel text not null default 'platform' check (channel in ('platform','email','both')),
  unarchive_on_trigger boolean not null default false,
  status text not null default 'scheduled' check (status in ('scheduled','due','done','cancelled')),
  fired_at timestamptz, done_at timestamptz, done_by uuid,
  created_by uuid default auth.uid(), created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create index if not exists reminders_due on public.reminders(status, remind_at);
create index if not exists reminders_entity on public.reminders(entity_type, entity_id);
alter table public.reminders enable row level security;
drop policy if exists staff_read on public.reminders;
drop policy if exists staff_write on public.reminders;
create policy staff_read on public.reminders for select to authenticated using (public.is_admin());
create policy staff_write on public.reminders for all to authenticated using (public.is_admin()) with check (public.is_admin());
drop trigger if exists reminders_no_dashes on public.reminders;
create trigger reminders_no_dashes before insert or update on public.reminders for each row execute function public.no_dashes();

create table if not exists public.internal_notes (
  id bigint generated by default as identity primary key,
  entity_type text check (entity_type is null or entity_type in ('case','quotation','certificate','cover_note','claim')),
  entity_id bigint,
  title text not null check (length(title) between 1 and 200),
  body text check (body is null or length(body) <= 4000),
  due_at timestamptz,
  priority text not null default 'normal' check (priority in ('low','normal','high','urgent')),
  assignees uuid[] not null default '{}',
  channel text not null default 'platform' check (channel in ('platform','email','both')),
  status text not null default 'open' check (status in ('open','done')),
  notified_at timestamptz, done_at timestamptz,
  created_by uuid default auth.uid(), created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  check ((entity_type is null) = (entity_id is null))
);
create index if not exists internal_notes_entity on public.internal_notes(entity_type, entity_id);
alter table public.internal_notes enable row level security;
drop policy if exists staff_read on public.internal_notes;
drop policy if exists staff_write on public.internal_notes;
create policy staff_read on public.internal_notes for select to authenticated using (public.is_admin());
create policy staff_write on public.internal_notes for all to authenticated using (public.is_admin()) with check (public.is_admin());
drop trigger if exists internal_notes_no_dashes on public.internal_notes;
create trigger internal_notes_no_dashes before insert or update on public.internal_notes for each row execute function public.no_dashes();

create table if not exists public.client_reminder_templates (
  id bigint generated by default as identity primary key,
  kind text not null check (kind in ('quote_pending','request_open','missing_docs','custom')),
  name text not null check (length(name) between 1 and 120),
  subject text not null check (length(subject) between 1 and 200),
  body text not null check (length(body) between 1 and 4000),
  active boolean not null default true,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
alter table public.client_reminder_templates enable row level security;
drop policy if exists staff_read on public.client_reminder_templates;
drop policy if exists role_write on public.client_reminder_templates;
create policy staff_read on public.client_reminder_templates for select to authenticated using (public.is_admin());
create policy role_write on public.client_reminder_templates for all to authenticated using (public.has_role('placing') or public.has_role('claims')) with check (public.has_role('placing') or public.has_role('claims'));
drop trigger if exists client_reminder_templates_no_dashes on public.client_reminder_templates;
create trigger client_reminder_templates_no_dashes before insert or update on public.client_reminder_templates for each row execute function public.no_dashes();
insert into public.client_reminder_templates(kind, name, subject, body)
select * from (values
  ('quote_pending', 'Quotation waiting for acceptance', 'Your quotation {{ref}} is waiting for you',
   'Dear {{name}},' || chr(10) || chr(10) || 'your quotation {{ref}} is still open and valid until {{valid_until}}. If the terms suit you, you can accept it online in a few seconds, or ask us for a revision.' || chr(10) || chr(10) || 'Kind regards' || chr(10) || 'MARINCON'),
  ('request_open', 'Request waiting for your reply', 'We need your reply on {{ref}}',
   'Dear {{name}},' || chr(10) || chr(10) || 'we are working on your request {{ref}} and need a short reply or comment from you before we can continue.' || chr(10) || '{{items}}' || chr(10) || chr(10) || 'Kind regards' || chr(10) || 'MARINCON'),
  ('missing_docs', 'Missing documents or data', 'Documents missing for {{ref}}',
   'Dear {{name}},' || chr(10) || chr(10) || 'to continue with {{ref}} we still need the following documents or details:' || chr(10) || '{{items}}' || chr(10) || chr(10) || 'You can upload them directly in the portal.' || chr(10) || chr(10) || 'Kind regards' || chr(10) || 'MARINCON')
) v(kind, name, subject, body)
where not exists (select 1 from public.client_reminder_templates t where t.kind = v.kind);

create table if not exists public.client_reminder_rules (
  id bigint generated by default as identity primary key,
  kind text not null unique check (kind in ('quote_pending','request_open','missing_docs')),
  active boolean not null default false,
  template_id bigint references public.client_reminder_templates(id) on delete set null,
  after_days integer not null default 2 check (after_days between 0 and 90),
  repeat_days integer not null default 3 check (repeat_days between 1 and 90),
  max_sends integer not null default 2 check (max_sends between 1 and 10),
  channel text not null default 'both' check (channel in ('platform','email','both')),
  updated_at timestamptz not null default now()
);
alter table public.client_reminder_rules enable row level security;
drop policy if exists staff_read on public.client_reminder_rules;
drop policy if exists role_write on public.client_reminder_rules;
create policy staff_read on public.client_reminder_rules for select to authenticated using (public.is_admin());
create policy role_write on public.client_reminder_rules for all to authenticated using (public.has_role('placing') or public.has_role('claims')) with check (public.has_role('placing') or public.has_role('claims'));
insert into public.client_reminder_rules(kind, template_id)
select k, (select id from public.client_reminder_templates t where t.kind = k order by id limit 1) from unnest(array['quote_pending','request_open','missing_docs']) k
on conflict (kind) do nothing;

create table if not exists public.client_reminder_log (
  id bigint generated by default as identity primary key,
  entity_type text not null check (entity_type in ('case','quotation','claim')),
  entity_id bigint not null,
  user_id uuid,
  kind text not null,
  template_id bigint, rule_id bigint,
  channel text not null check (channel in ('platform','email','both')),
  subject text, body text,
  auto boolean not null default false,
  notification_id bigint,
  sent_by uuid, sent_at timestamptz not null default now()
);
create index if not exists client_reminder_log_entity on public.client_reminder_log(entity_type, entity_id, sent_at desc);
alter table public.client_reminder_log enable row level security;
drop policy if exists staff_read on public.client_reminder_log;
create policy staff_read on public.client_reminder_log for select to authenticated using (public.is_admin());

-- who is the client of a record, and its reference
create or replace function public.fc_entity_client(p_entity text, p_id bigint, out user_id uuid, out ref text, out category text)
language plpgsql stable security definer set search_path = public as $$
begin
  if p_entity = 'case' then select i.user_id, i.ref, 'cases' into user_id, ref, category from public.indications i where i.id = p_id;
  elsif p_entity = 'quotation' then select i.user_id, coalesce(q.number, i.ref || ' v' || q.version), 'quotes' into user_id, ref, category from public.quotations q join public.indications i on i.id = q.indication_id where q.id = p_id;
  elsif p_entity = 'claim' then select c.user_id, c.ref, 'claims' into user_id, ref, category from public.claims c where c.id = p_id;
  elsif p_entity = 'certificate' then select i.user_id, c.number, 'cases' into user_id, ref, category from public.certificates c join public.indications i on i.id = c.indication_id where c.id = p_id;
  elsif p_entity = 'cover_note' then select i.user_id, c.number, 'cases' into user_id, ref, category from public.cover_notes c join public.indications i on i.id = c.indication_id where c.id = p_id;
  end if;
end $$;
revoke execute on function public.fc_entity_client(text, bigint) from public, anon, authenticated;

-- send one reminder to the client of a record (platform message and / or e-mail)
create or replace function public.client_reminder_core(p_entity text, p_id bigint, p_kind text, p_template_id bigint, p_subject text, p_body text,
  p_channel text, p_items text, p_auto boolean, p_rule_id bigint) returns bigint
language plpgsql security definer set search_path = public as $$
declare cl record; t public.client_reminder_templates; p public.profiles; v_sub text; v_body text; v_valid text; v_nid bigint; v_log bigint; v_link text;
begin
  select * into cl from public.fc_entity_client(p_entity, p_id);
  if cl.user_id is null then raise exception 'this record has no client user to remind'; end if;
  select * into p from public.profiles where id = cl.user_id and deleted_at is null;
  if not found then raise exception 'the client user no longer exists'; end if;
  if p_template_id is not null then select * into t from public.client_reminder_templates where id = p_template_id; end if;
  if p_entity = 'quotation' then select to_char(valid_until at time zone 'Europe/Berlin', 'DD.MM.YYYY HH24:MI') into v_valid from public.quotations where id = p_id; end if;
  v_sub := coalesce(nullif(trim(coalesce(p_subject, '')), ''), t.subject, 'Reminder: ' || coalesce(cl.ref, ''));
  v_body := coalesce(nullif(trim(coalesce(p_body, '')), ''), t.body, '');
  v_sub := replace(replace(replace(replace(replace(v_sub, '{{ref}}', coalesce(cl.ref, '')), '{{name}}', coalesce(p.full_name, '')), '{{company}}', coalesce(p.company, '')), '{{valid_until}}', coalesce(v_valid, '')), '{{items}}', coalesce(p_items, ''));
  v_body := replace(replace(replace(replace(replace(v_body, '{{ref}}', coalesce(cl.ref, '')), '{{name}}', coalesce(p.full_name, '')), '{{company}}', coalesce(p.company, '')), '{{valid_until}}', coalesce(v_valid, '')), '{{items}}', coalesce(p_items, ''));
  v_link := case cl.category when 'claims' then 'claims' else 'quotes' end;
  v_nid := public.notify_user(cl.user_id, 'client', case p_kind when 'quote_pending' then 'quote_reminder' when 'missing_docs' then case when p_entity = 'claim' then 'claim_docs_reminder' else 'case_docs_reminder' end else 'case_reminder' end,
             v_sub, v_body, p_entity, p_id, coalesce(p_channel, 'both'), v_link, cl.category);
  insert into public.client_reminder_log(entity_type, entity_id, user_id, kind, template_id, rule_id, channel, subject, body, auto, notification_id, sent_by)
  values (p_entity, p_id, cl.user_id, coalesce(p_kind, 'custom'), p_template_id, p_rule_id, coalesce(p_channel, 'both'), v_sub, v_body, p_auto, v_nid, case when p_auto then null else auth.uid() end)
  returning id into v_log;
  return v_log;
end $$;
revoke execute on function public.client_reminder_core(text, bigint, text, bigint, text, text, text, text, boolean, bigint) from public, anon, authenticated;

create or replace function public.admin_send_client_reminder(p_entity text, p_id bigint, p_kind text, p_template_id bigint, p_subject text, p_body text, p_channel text, p_items text default null)
returns bigint
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'not authorised'; end if;
  if p_entity not in ('case','quotation','claim') then raise exception 'client reminders exist for cases, quotations and claims'; end if;
  if p_channel not in ('platform','email','both') then raise exception 'invalid channel'; end if;
  return public.client_reminder_core(p_entity, p_id, coalesce(p_kind, 'custom'), p_template_id, p_subject, p_body, p_channel, p_items, false, null);
end $$;
grant execute on function public.admin_send_client_reminder(text, bigint, text, bigint, text, text, text, text) to authenticated;

-- automated client reminders (called by process_due_reminders)
create or replace function public.run_client_reminder_rules() returns integer
language plpgsql security definer set search_path = public as $$
declare r public.client_reminder_rules; x record; n integer := 0;
begin
  for r in select * from public.client_reminder_rules where active loop
    if r.kind = 'quote_pending' then
      for x in select q.id from public.quotations q join public.indications i on i.id = q.indication_id
                where q.status = 'open' and q.send_status = 'sent' and q.valid_until > now() and not q.is_test and not q.is_archived and i.user_id is not null
                  and coalesce(q.sent_at, q.created_at) <= now() - make_interval(days => r.after_days)
                  and (select count(*) from public.client_reminder_log l where l.entity_type = 'quotation' and l.entity_id = q.id and l.kind = 'quote_pending') < r.max_sends
                  and not exists (select 1 from public.client_reminder_log l where l.entity_type = 'quotation' and l.entity_id = q.id and l.kind = 'quote_pending' and l.sent_at > now() - make_interval(days => r.repeat_days))
      loop perform public.client_reminder_core('quotation', x.id, 'quote_pending', r.template_id, null, null, r.channel, null, true, r.id); n := n + 1; end loop;
    elsif r.kind = 'request_open' then
      for x in select i.id, i.awaiting_client_reason from public.indications i
                where i.awaiting_client_since is not null and coalesce(i.awaiting_client_reason, 'reply') in ('reply','comment') and i.stage in ('request','working_on_it','quotation')
                  and not i.is_test and not i.is_archived and i.user_id is not null
                  and i.awaiting_client_since <= now() - make_interval(days => r.after_days)
                  and (select count(*) from public.client_reminder_log l where l.entity_type = 'case' and l.entity_id = i.id and l.kind = 'request_open' and l.sent_at >= i.awaiting_client_since) < r.max_sends
                  and not exists (select 1 from public.client_reminder_log l where l.entity_type = 'case' and l.entity_id = i.id and l.kind = 'request_open' and l.sent_at > now() - make_interval(days => r.repeat_days))
      loop perform public.client_reminder_core('case', x.id, 'request_open', r.template_id, null, null, r.channel, null, true, r.id); n := n + 1; end loop;
    elsif r.kind = 'missing_docs' then
      for x in select i.id from public.indications i
                where i.awaiting_client_since is not null and i.awaiting_client_reason in ('missing_data','missing_documents') and i.stage in ('request','working_on_it','quotation','certificate')
                  and not i.is_test and not i.is_archived and i.user_id is not null
                  and i.awaiting_client_since <= now() - make_interval(days => r.after_days)
                  and (select count(*) from public.client_reminder_log l where l.entity_type = 'case' and l.entity_id = i.id and l.kind = 'missing_docs' and l.sent_at >= i.awaiting_client_since) < r.max_sends
                  and not exists (select 1 from public.client_reminder_log l where l.entity_type = 'case' and l.entity_id = i.id and l.kind = 'missing_docs' and l.sent_at > now() - make_interval(days => r.repeat_days))
      loop perform public.client_reminder_core('case', x.id, 'missing_docs', r.template_id, null, null, r.channel, null, true, r.id); n := n + 1; end loop;
      for x in select c.id, c.docs_requested_items from public.claims c
                where c.docs_requested_at is not null and c.status not in ('paid_settled','repudiated_declined','closed') and c.deleted_at is null and not c.is_archived and c.user_id is not null
                  and c.docs_requested_at <= now() - make_interval(days => r.after_days)
                  and (select count(*) from public.client_reminder_log l where l.entity_type = 'claim' and l.entity_id = c.id and l.kind = 'missing_docs' and l.sent_at >= c.docs_requested_at) < r.max_sends
                  and not exists (select 1 from public.client_reminder_log l where l.entity_type = 'claim' and l.entity_id = c.id and l.kind = 'missing_docs' and l.sent_at > now() - make_interval(days => r.repeat_days))
      loop perform public.client_reminder_core('claim', x.id, 'missing_docs', r.template_id, null, null, r.channel, x.docs_requested_items, true, r.id); n := n + 1; end loop;
    end if;
  end loop;
  return n;
end $$;
revoke execute on function public.run_client_reminder_rules() from public, anon, authenticated;

-- staff: set a reminder (optionally archive the record until it is due)
create or replace function public.admin_set_reminder(p jsonb) returns bigint
language plpgsql security definer set search_path = public as $$
declare v_id bigint; v_ent text := p->>'entity_type'; v_eid bigint := nullif(p->>'entity_id', '')::bigint; v_at timestamptz := nullif(p->>'remind_at', '')::timestamptz;
  v_arch boolean := coalesce((p->>'archive_until')::boolean, false); v_ass uuid[];
begin
  if not public.is_admin() then raise exception 'not authorised'; end if;
  if public.fc_entity_table(v_ent) is null or v_eid is null then raise exception 'choose the record'; end if;
  if v_at is null then raise exception 'choose the date and time of the reminder'; end if;
  if length(trim(coalesce(p->>'title', ''))) < 1 then raise exception 'please give the reminder a title'; end if;
  select coalesce(array_agg(x::uuid), '{}') into v_ass from jsonb_array_elements_text(coalesce(p->'assignees', '[]'::jsonb)) x;
  if cardinality(v_ass) = 0 then v_ass := array[auth.uid()]; end if;
  insert into public.reminders(entity_type, entity_id, remind_at, priority, title, note, assignees, channel, unarchive_on_trigger)
  values (v_ent, v_eid, v_at, coalesce(nullif(p->>'priority', ''), 'normal'), left(trim(p->>'title'), 200), left(nullif(trim(coalesce(p->>'note', '')), ''), 2000),
          v_ass, coalesce(nullif(p->>'channel', ''), 'platform'), v_arch)
  returning id into v_id;
  if v_arch then perform public.fc_set_archived(v_ent, v_eid, true, auth.uid()); end if;
  return v_id;
end $$;
grant execute on function public.admin_set_reminder(jsonb) to authenticated;

create or replace function public.admin_reminder_status(p_id bigint, p_status text) returns boolean
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'not authorised'; end if;
  if p_status not in ('done','cancelled','scheduled') then raise exception 'invalid status'; end if;
  update public.reminders set status = p_status, done_at = case when p_status = 'done' then now() end, done_by = case when p_status = 'done' then auth.uid() end, updated_at = now()
   where id = p_id;
  return found;
end $$;
grant execute on function public.admin_reminder_status(bigint, text) to authenticated;

-- the scheduler: due reminders (auto-unarchive + alerts), due notes, quotation deadlines, client reminder rules.
-- Called by pg_cron every 5 minutes (when available) and by every staff page load.
create or replace function public.process_due_reminders() returns jsonb
language plpgsql security definer set search_path = public as $$
declare r public.reminders; nt public.internal_notes; q record; u uuid; nf integer := 0; nn integer := 0; nq integer := 0; nc integer := 0; v_ref text; v_hours integer;
begin
  if auth.uid() is not null and not public.is_admin() then raise exception 'not authorised'; end if;
  for r in select * from public.reminders where status = 'scheduled' and remind_at <= now() order by remind_at for update skip locked loop
    update public.reminders set status = 'due', fired_at = now(), updated_at = now() where id = r.id;
    if r.unarchive_on_trigger then perform public.fc_set_archived(r.entity_type, r.entity_id, false, null); end if;
    select ref into v_ref from public.fc_entity_client(r.entity_type, r.entity_id);
    foreach u in array (case when cardinality(r.assignees) > 0 then r.assignees else array[r.created_by] end) loop
      perform public.notify_user(u, 'staff', 'reminder_due', 'Reminder due: ' || r.title || coalesce(' (' || v_ref || ')', ''),
        concat_ws(' | ', initcap(r.priority) || ' priority', r.note, case when r.unarchive_on_trigger then 'Brought back to the main tab' end),
        r.entity_type, r.entity_id, r.channel, null, 'reminders');
    end loop;
    nf := nf + 1;
  end loop;
  for nt in select * from public.internal_notes where status = 'open' and due_at is not null and due_at <= now() and notified_at is null for update skip locked loop
    update public.internal_notes set notified_at = now() where id = nt.id;
    foreach u in array (case when cardinality(nt.assignees) > 0 then nt.assignees else array[nt.created_by] end) loop
      perform public.notify_user(u, 'staff', 'note_due', 'Note due: ' || nt.title, left(coalesce(nt.body, ''), 500), nt.entity_type, nt.entity_id, nt.channel, case when nt.entity_type is null then 'calendar' end, 'reminders');
    end loop;
    nn := nn + 1;
  end loop;
  v_hours := coalesce(nullif((select value::text from public.settings where key = 'quote_expiry_warn_hours'), 'null')::integer, 48);
  for q in select q2.id, q2.valid_until, i.id ind, i.ref from public.quotations q2 join public.indications i on i.id = q2.indication_id
            where q2.status = 'open' and q2.send_status = 'sent' and q2.expiry_notified_at is null and not q2.is_test
              and q2.valid_until > now() and q2.valid_until <= now() + make_interval(hours => v_hours)
            for update of q2 skip locked loop
    update public.quotations set expiry_notified_at = now() where id = q.id;
    perform public.notify_staff('deadline_quote', 'Quotation ' || coalesce(q.ref, '#' || q.ind) || ' expires ' || to_char(q.valid_until at time zone 'Europe/Berlin', 'DD.MM.YYYY HH24:MI'),
      'No answer from the client yet.', 'case', q.ind, array['placing'], 'requests');
    nq := nq + 1;
  end loop;
  nc := public.run_client_reminder_rules();
  return jsonb_build_object('reminders', nf, 'notes', nn, 'deadlines', nq, 'client_reminders', nc, 'at', now());
end $$;
grant execute on function public.process_due_reminders() to authenticated;

-- schedule it on the server when pg_cron is installed (Supabase: Database > Extensions > pg_cron)
do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    begin
      perform cron.unschedule('freightcon-reminders');
    exception when others then null; end;
    perform cron.schedule('freightcon-reminders', '*/5 * * * *', 'select public.process_due_reminders()');
  end if;
end $$;

-- =====================================================================================================
-- 3  colleague invitations
-- =====================================================================================================
create table if not exists public.colleague_invites (
  id bigint generated by default as identity primary key,
  inviter_id uuid not null references public.profiles(id) on delete cascade,
  invitee_id uuid references public.profiles(id) on delete set null,
  email text not null, full_name text not null, department text,
  customer_id bigint not null, office_id bigint, office_mode text not null check (office_mode in ('same','different')),
  policy_id bigint,
  created_at timestamptz not null default now()
);
alter table public.colleague_invites enable row level security;
drop policy if exists staff_read on public.colleague_invites;
drop policy if exists own_read on public.colleague_invites;
create policy staff_read on public.colleague_invites for select to authenticated using (public.is_admin());
create policy own_read on public.colleague_invites for select to authenticated using (inviter_id = auth.uid());

-- the company and the offices a client user may invite into (never the policy)
create or replace function public.my_colleague_context() returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare p public.profiles; v_cust bigint; cu public.customers; o public.offices;
begin
  select * into p from public.profiles where id = auth.uid();
  if not found or p.is_admin then return jsonb_build_object('can_invite', false, 'reason', 'Staff users are created by a staff admin.'); end if;
  v_cust := public.user_customer_id(p.id);
  select * into cu from public.customers where id = v_cust;
  if not p.approved or p.rejected or not coalesce(p.is_active, true) or p.deleted_at is not null or cu.id is null then
    return jsonb_build_object('can_invite', false, 'reason', 'Your registration must be completed and linked to your company first.');
  end if;
  if not cu.allow_colleague_invites then return jsonb_build_object('can_invite', false, 'reason', 'Colleague invitations are switched off for your company. Please contact us.'); end if;
  select * into o from public.offices where id = p.office_id;
  return jsonb_build_object('can_invite', true,
    'company', jsonb_build_object('id', cu.id, 'name', cu.name),
    'own_office', case when o.id is not null then jsonb_build_object('id', o.id, 'name', o.name, 'location', o.location) end,
    'offices', (select coalesce(jsonb_agg(jsonb_build_object('id', x.id, 'name', x.name, 'location', x.location) order by x.sort, x.name), '[]'::jsonb)
                  from public.offices x where x.customer_id = cu.id and x.active),
    'departments', (select coalesce(jsonb_agg(d.name order by d.sort, d.name), '[]'::jsonb) from public.departments d where d.customer_id = cu.id and d.active),
    'invited', (select coalesce(jsonb_agg(jsonb_build_object('name', ci.full_name, 'email', ci.email, 'office', (select name from public.offices where id = ci.office_id), 'at', ci.created_at) order by ci.created_at desc), '[]'::jsonb)
                  from public.colleague_invites ci where ci.inviter_id = p.id));
end $$;
grant execute on function public.my_colleague_context() to authenticated;

-- validates an invitation for the calling user and resolves company, office and policy (server side)
create or replace function public.colleague_invite_prepare(p_mode text, p_office_id bigint) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare p public.profiles; v_cust bigint; cu public.customers; o public.offices; v_pol bigint;
begin
  select * into p from public.profiles where id = auth.uid();
  if not found or p.is_admin or not p.approved or p.rejected or not coalesce(p.is_active, true) or p.deleted_at is not null then raise exception 'not allowed to invite colleagues'; end if;
  v_cust := public.user_customer_id(p.id);
  select * into cu from public.customers where id = v_cust and active;
  if cu.id is null then raise exception 'your account is not linked to a company yet'; end if;
  if not cu.allow_colleague_invites then raise exception 'colleague invitations are switched off for your company'; end if;
  if p_mode = 'same' then
    select * into o from public.offices where id = p.office_id;
  elsif p_mode = 'different' then
    select * into o from public.offices where id = p_office_id and customer_id = cu.id and active;
    if o.id is null then raise exception 'choose one of your company''s active offices'; end if;
  else raise exception 'invalid office choice'; end if;
  if o.id is not null and o.customer_id is distinct from cu.id then raise exception 'office outside your company'; end if;
  -- policy: the office's own policy, else a policy covering the office, else the company's only active policy
  v_pol := o.policy_id;
  if v_pol is null and o.id is not null then select po.policy_id into v_pol from public.policy_offices po join public.policies x on x.id = po.policy_id and x.active where po.office_id = o.id order by po.policy_id limit 1; end if;
  if v_pol is null then select case when count(*) = 1 then min(id) end into v_pol from public.policies where customer_id = cu.id and active; end if;
  return jsonb_build_object('customer_id', cu.id, 'customer_name', cu.name, 'group_id', cu.group_id, 'office_id', o.id, 'office_name', o.name,
    'policy_id', v_pol, 'cover_type', cu.cover_type, 'inviter_id', p.id, 'inviter_name', coalesce(p.full_name, p.email), 'inviter_email', p.email);
end $$;
grant execute on function public.colleague_invite_prepare(text, bigint) to authenticated;

-- service role only (edge function): stores the invitation, links the new profile, alerts the staff group
create or replace function public.colleague_invite_finalize(p_inviter uuid, p_user uuid, p_email text, p_name text, p_department text, p_mode text, p_ctx jsonb)
returns bigint
language plpgsql security definer set search_path = public as $$
declare v_id bigint; v_dep bigint; v_first text; v_last text;
begin
  select id into v_dep from public.departments where customer_id = (p_ctx->>'customer_id')::bigint and lower(name) = lower(trim(coalesce(p_department, ''))) limit 1;
  v_first := split_part(trim(p_name), ' ', 1); v_last := nullif(trim(substr(trim(p_name), length(v_first) + 1)), '');
  update public.profiles set full_name = left(trim(p_name), 100), first_name = left(v_first, 60), last_name = left(v_last, 60),
         company = p_ctx->>'customer_name', customer_id = (p_ctx->>'customer_id')::bigint, office_id = nullif(p_ctx->>'office_id', '')::bigint,
         group_id = nullif(p_ctx->>'group_id', '')::bigint, approved = true, rejected = false, is_active = true, approved_at = now(),
         department_id = v_dep, department_label = case when v_dep is null then left(nullif(trim(coalesce(p_department, '')), ''), 120) end,
         invited_by = p_inviter, discount_mode = 'default_client'
   where id = p_user;
  insert into public.colleague_invites(inviter_id, invitee_id, email, full_name, department, customer_id, office_id, office_mode, policy_id)
  values (p_inviter, p_user, lower(p_email), left(trim(p_name), 150), left(nullif(trim(coalesce(p_department, '')), ''), 120), (p_ctx->>'customer_id')::bigint,
          nullif(p_ctx->>'office_id', '')::bigint, p_mode, nullif(p_ctx->>'policy_id', '')::bigint)
  returning id into v_id;
  perform public.notify_staff('colleague_invited',
    'New colleague invited by ' || coalesce(p_ctx->>'inviter_name', '') || ' at ' || coalesce(p_ctx->>'customer_name', '') || ' - ' || coalesce(p_ctx->>'office_name', 'no office'),
    concat_ws(' | ', trim(p_name), lower(p_email), nullif(trim(coalesce(p_department, '')), '')), 'user', null, array['admin','placing'], 'customers');
  perform public.emit('colleague_invited', jsonb_build_object('inviter', p_ctx->>'inviter_name', 'inviter_email', p_ctx->>'inviter_email', 'company', p_ctx->>'customer_name',
    'office', p_ctx->>'office_name', 'name', p_name, 'email', lower(p_email), 'department', p_department));
  insert into public.audit_log(user_id, user_name, entity, entity_id, summary)
  values (p_inviter, p_ctx->>'inviter_name', 'user', p_user::text, 'Colleague invited: ' || trim(p_name) || ' <' || lower(p_email) || '> at ' || coalesce(p_ctx->>'customer_name', '') || ' - ' || coalesce(p_ctx->>'office_name', 'no office'));
  return v_id;
end $$;
revoke execute on function public.colleague_invite_finalize(uuid, uuid, text, text, text, text, jsonb) from public, anon, authenticated;
do $$ begin
  execute 'grant execute on function public.colleague_invite_finalize(uuid, uuid, text, text, text, text, jsonb) to service_role';
exception when undefined_object then null; end $$;

-- =====================================================================================================
-- 6  startup view, preferences, GDPR consent
-- =====================================================================================================
create table if not exists public.gdpr_consent_log (
  id bigint generated by default as identity primary key,
  user_id uuid references public.profiles(id) on delete set null,
  consent jsonb not null,
  user_agent text,
  created_at timestamptz not null default now()
);
alter table public.gdpr_consent_log enable row level security;
drop policy if exists staff_read on public.gdpr_consent_log;
drop policy if exists own_read on public.gdpr_consent_log;
create policy staff_read on public.gdpr_consent_log for select to authenticated using (public.has_role('admin'));
create policy own_read on public.gdpr_consent_log for select to authenticated using (user_id = auth.uid());

create or replace function public.save_my_consent(p jsonb, p_user_agent text default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v jsonb;
begin
  if auth.uid() is null then raise exception 'not signed in'; end if;
  v := jsonb_build_object('necessary', true, 'functional', coalesce((p->>'functional')::boolean, false), 'analytics', coalesce((p->>'analytics')::boolean, false),
                          'choice', coalesce(p->>'choice', 'custom'), 'version', coalesce(p->>'version', (select value->>'version' from public.settings where key = 'gdpr')), 'at', now());
  update public.profiles set gdpr_consent = v where id = auth.uid();
  insert into public.gdpr_consent_log(user_id, consent, user_agent) values (auth.uid(), v, left(p_user_agent, 300));
  return v;
end $$;
grant execute on function public.save_my_consent(jsonb, text) to authenticated;

create or replace function public.update_my_preferences(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare cur jsonb; v jsonb := '{}'::jsonb; k text;
begin
  select preferences into cur from public.profiles where id = auth.uid();
  if not found then raise exception 'not signed in'; end if;
  -- whitelisted keys only
  foreach k in array array['currency','language','date_format','notify','calendar','desk','office_id','initials','compact'] loop
    if p ? k then v := v || jsonb_build_object(k, p->k); end if;
  end loop;
  if v ? 'initials' and not coalesce(v->>'initials', '') ~ '^[A-Za-z]{0,6}$' then raise exception 'initials: up to 6 letters'; end if;
  update public.profiles set preferences = coalesce(cur, '{}'::jsonb) || v where id = auth.uid() returning preferences into cur;
  return cur;
end $$;
grant execute on function public.update_my_preferences(jsonb) to authenticated;

create or replace function public.set_my_startup_view(p_view text) returns text
language plpgsql security definer set search_path = public as $$
begin
  if p_view is not null and p_view !~ '^[a-z_]{2,20}(:[a-z_]{2,20})?$' then raise exception 'invalid view'; end if;
  update public.profiles set default_startup_view = p_view where id = auth.uid();
  return p_view;
end $$;
grant execute on function public.set_my_startup_view(text) to authenticated;

-- the startup view of the calling user: own choice, then the user group, then the configuration default per role
create or replace function public.my_startup_view() returns text
language sql stable security definer set search_path = public as $$
  select coalesce(p.default_startup_view, ug.default_startup_view,
           (select value->>(case when p.is_admin then 'staff' when p.insurer_id is not null then 'insurer' else 'client' end) from public.settings where key = 'startup_defaults'),
           case when p.is_admin then 'admin:requests' else 'new' end)
    from public.profiles p left join public.user_groups ug on ug.id = p.user_group_id where p.id = auth.uid()
$$;
grant execute on function public.my_startup_view() to authenticated;

-- personal data export (JSON / CSV in the browser): profile, consent, records
create or replace function public.export_my_data() returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'exported_at', now(),
    'controller', (select value->>'controller' from public.settings where key = 'gdpr'),
    'profile', (select jsonb_build_object('name', full_name, 'first_name', first_name, 'last_name', last_name, 'company', company, 'email', email,
                       'address', concat_ws(', ', address_line, nullif(concat_ws(' ', postcode, city), ''), country), 'country', country,
                       'phone', phone, 'registered_at', created_at, 'last_login_at', last_login_at, 'terms_version', terms_version,
                       'default_startup_view', default_startup_view, 'preferences', preferences, 'gdpr_consent', gdpr_consent,
                       'deletion_requested_at', deletion_requested_at) from public.profiles where id = auth.uid()),
    'consent_history', (select coalesce(jsonb_agg(jsonb_build_object('at', created_at, 'consent', consent) order by created_at), '[]'::jsonb) from public.gdpr_consent_log where user_id = auth.uid()),
    'indications', public.my_history(500),
    'quotations', public.my_quotations(),
    'claims', public.my_claims(),
    'notifications', (select coalesce(jsonb_agg(jsonb_build_object('at', created_at, 'title', title, 'message', message, 'read', is_read) order by created_at desc), '[]'::jsonb)
                        from public.notifications where recipient_user_id = auth.uid()),
    'invoices', (select coalesce(jsonb_agg(jsonb_build_object('number', number, 'amount', amount, 'currency', currency,
                        'due_date', due_date, 'paid_at', paid_at, 'created_at', created_at)), '[]'::jsonb)
                   from public.invoices where user_id = auth.uid()))
$$;

-- erasure requests alert the staff admins too
create or replace function public.request_account_deletion() returns boolean
language plpgsql security definer set search_path = public as $$
declare p public.profiles;
begin
  update public.profiles set deletion_requested_at = now() where id = auth.uid() returning * into p;
  if not found then return false; end if;
  perform public.emit('deletion_request', jsonb_build_object('user_id', p.id, 'email', p.email, 'name', p.full_name, 'company', p.company));
  perform public.notify_staff('user_erasure_request', 'Data erasure requested: ' || coalesce(p.full_name, p.email), coalesce(p.company, '') || ' ' || p.email, 'user', null, array['admin'], 'settings');
  return true;
end $$;

-- staff admins: consent statistics and open erasure requests
create or replace function public.admin_gdpr_overview() returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.has_role('admin') then raise exception 'not authorised'; end if;
  return jsonb_build_object(
    'users', (select count(*) from public.profiles where deleted_at is null),
    'with_consent', (select count(*) from public.profiles where deleted_at is null and gdpr_consent is not null),
    'analytics_on', (select count(*) from public.profiles where deleted_at is null and coalesce((gdpr_consent->>'analytics')::boolean, false)),
    'functional_on', (select count(*) from public.profiles where deleted_at is null and coalesce((gdpr_consent->>'functional')::boolean, false)),
    'erasure_requests', (select coalesce(jsonb_agg(jsonb_build_object('id', id, 'name', full_name, 'email', email, 'company', company, 'at', deletion_requested_at) order by deletion_requested_at), '[]'::jsonb)
                           from public.profiles where deletion_requested_at is not null and deleted_at is null),
    'recent', (select coalesce(jsonb_agg(x order by (x->>'at') desc), '[]'::jsonb) from (
                 select jsonb_build_object('at', l.created_at, 'user', coalesce(p.full_name, p.email), 'consent', l.consent) x
                   from public.gdpr_consent_log l left join public.profiles p on p.id = l.user_id order by l.created_at desc limit 50) s));
end $$;
grant execute on function public.admin_gdpr_overview() to authenticated;

-- =====================================================================================================
-- 12  numbering & initials framework
-- =====================================================================================================
create table if not exists public.entity_initials (
  entity_type text not null check (entity_type in ('customer','policy','office')),
  entity_id bigint not null,
  initials text not null check (initials ~ '^[A-Z0-9]{1,8}$'),
  updated_at timestamptz not null default now(),
  primary key (entity_type, entity_id)
);
alter table public.entity_initials enable row level security;
drop policy if exists staff_read on public.entity_initials;
drop policy if exists role_write on public.entity_initials;
create policy staff_read on public.entity_initials for select to authenticated using (public.is_admin());
create policy role_write on public.entity_initials for all to authenticated using (public.has_role('placing')) with check (public.has_role('placing'));

create table if not exists public.numbering_matrices (
  id bigint generated by default as identity primary key,
  name text not null check (length(name) between 1 and 120),
  doc_type text not null check (doc_type in ('certificate','cover_note','case','quotation','claim')),
  scope_type text not null default 'global' check (scope_type in ('global','customer','policy','policy_year','office')),
  scope_id bigint,
  pattern text not null check (length(pattern) between 1 and 120),
  start_number integer not null default 1 check (start_number >= 0),
  current_number integer,
  reset_interval text not null default 'never' check (reset_interval in ('never','yearly','monthly')),
  period_key text,
  allow_manual boolean not null default true,
  active boolean not null default true,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  check ((scope_type = 'global') = (scope_id is null))
);
create unique index if not exists numbering_matrices_scope on public.numbering_matrices(doc_type, scope_type, coalesce(scope_id, 0)) where active;
alter table public.numbering_matrices enable row level security;
drop policy if exists staff_read on public.numbering_matrices;
drop policy if exists role_write on public.numbering_matrices;
create policy staff_read on public.numbering_matrices for select to authenticated using (public.is_admin());
create policy role_write on public.numbering_matrices for all to authenticated using (public.has_role('placing')) with check (public.has_role('placing'));
drop trigger if exists numbering_matrices_no_dashes on public.numbering_matrices;
create trigger numbering_matrices_no_dashes before insert or update on public.numbering_matrices for each row execute function public.no_dashes();
alter table public.certificates drop constraint if exists certificates_numbering_mode_check;
do $$ begin
  alter table public.certificates add constraint certificates_numbering_mode_chk check (numbering_mode in ('legacy','matrix','manual','framework'));
exception when duplicate_object then null; end $$;

-- initials of a customer / policy / office: stored code, else the first letters of the name
create or replace function public.fc_initials(p_type text, p_id bigint) returns text
language plpgsql stable security definer set search_path = public as $$
declare v text; n text;
begin
  if p_id is null then return ''; end if;
  select initials into v from public.entity_initials where entity_type = p_type and entity_id = p_id;
  if v is not null then return v; end if;
  if p_type = 'customer' then select name into n from public.customers where id = p_id;
  elsif p_type = 'policy' then select coalesce(name, policy_no) into n from public.policies where id = p_id;
  elsif p_type = 'office' then select name into n from public.offices where id = p_id; end if;
  return upper(left(regexp_replace(coalesce(n, ''), '[^A-Za-z0-9]', '', 'g'), 3));
end $$;

-- the context of a document: customer, policy, policy year, office
create or replace function public.numbering_ctx(p_indication bigint, p_customer bigint default null, p_policy bigint default null, p_office bigint default null) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare i public.indications; v_pol bigint; v_off bigint; v_cust bigint; v_year bigint; v_date date;
begin
  if p_indication is not null then select * into i from public.indications where id = p_indication; end if;
  v_pol := coalesce(p_policy, case when coalesce(i.is_standalone_one_off, false) then null else i.policy_id end);
  v_off := coalesce(p_office, i.office_id);
  v_cust := coalesce(p_customer, i.customer_id, (select customer_id from public.policies where id = v_pol), (select customer_id from public.offices where id = v_off));
  v_date := coalesce(i.departure_date, current_date);
  if v_pol is not null then
    select id into v_year from public.policy_years where policy_id = v_pol and v_date >= starts_on and v_date <= coalesce(extended_to, ends_on) order by starts_on desc limit 1;
  end if;
  return jsonb_build_object('customer_id', v_cust, 'policy_id', v_pol, 'policy_year_id', v_year, 'office_id', v_off);
end $$;

-- most specific active matrix: office, policy year, policy, customer, global
create or replace function public.numbering_find(p_doc text, p_ctx jsonb, p_global boolean default true) returns public.numbering_matrices
language sql stable security definer set search_path = public as $$
  select m.* from public.numbering_matrices m
   where m.active and m.doc_type = p_doc and (
         (m.scope_type = 'office' and m.scope_id = nullif(p_ctx->>'office_id', '')::bigint)
      or (m.scope_type = 'policy_year' and m.scope_id = nullif(p_ctx->>'policy_year_id', '')::bigint)
      or (m.scope_type = 'policy' and m.scope_id = nullif(p_ctx->>'policy_id', '')::bigint)
      or (m.scope_type = 'customer' and m.scope_id = nullif(p_ctx->>'customer_id', '')::bigint)
      or (p_global and m.scope_type = 'global'))
   order by case m.scope_type when 'office' then 1 when 'policy_year' then 2 when 'policy' then 3 when 'customer' then 4 else 5 end
   limit 1
$$;

create or replace function public.numbering_render(p_pattern text, p_seq integer, p_ctx jsonb, p_at timestamptz default now()) returns text
language plpgsql stable security definer set search_path = public as $$
declare v text := p_pattern; m text[]; t timestamptz := p_at at time zone 'Europe/Berlin';
begin
  v := replace(v, '{{office_initials}}', public.fc_initials('office', nullif(p_ctx->>'office_id', '')::bigint));
  v := replace(v, '{{client_initials}}', public.fc_initials('customer', nullif(p_ctx->>'customer_id', '')::bigint));
  v := replace(v, '{{policy_initials}}', public.fc_initials('policy', nullif(p_ctx->>'policy_id', '')::bigint));
  v := replace(v, '{{policy_no}}', coalesce((select policy_no from public.policies where id = nullif(p_ctx->>'policy_id', '')::bigint), ''));
  v := replace(v, '{{yyyy}}', to_char(t, 'YYYY'));
  v := replace(v, '{{yy}}', to_char(t, 'YY'));
  v := replace(v, '{{mm}}', to_char(t, 'MM'));
  loop
    m := regexp_match(v, '\{\{seq:(\d{1,2})\}\}');
    exit when m is null;
    v := regexp_replace(v, '\{\{seq:\d{1,2}\}\}', lpad(p_seq::text, greatest(m[1]::integer, length(p_seq::text)), '0'));
  end loop;
  if position('{{seq}}' in v) > 0 then v := replace(v, '{{seq}}', p_seq::text);
  elsif p_pattern !~ '\{\{seq' then v := v || lpad(p_seq::text, 4, '0'); end if;
  return v;
end $$;

create or replace function public.numbering_is_taken(p_doc text, p_number text) returns boolean
language plpgsql stable security definer set search_path = public as $$
begin
  return case p_doc
    when 'certificate' then exists (select 1 from public.certificates where number = p_number)
    when 'cover_note' then exists (select 1 from public.cover_notes where number = p_number)
    when 'case' then exists (select 1 from public.indications where ref = p_number)
    when 'quotation' then exists (select 1 from public.quotations where number = p_number)
    when 'claim' then exists (select 1 from public.claims where ref = p_number)
    else false end;
end $$;

create or replace function public.numbering_period(p_reset text) returns text
language sql stable as $$
  select case p_reset when 'yearly' then to_char(now() at time zone 'Europe/Berlin', 'YYYY') when 'monthly' then to_char(now() at time zone 'Europe/Berlin', 'YYYY-MM') else 'all' end
$$;

-- next number of a matrix without taking it
create or replace function public.numbering_next(m public.numbering_matrices, p_ctx jsonb) returns text
language plpgsql stable security definer set search_path = public as $$
declare n integer; v text;
begin
  n := case when m.period_key is distinct from public.numbering_period(m.reset_interval) or m.current_number is null then m.start_number
            else greatest(m.current_number + 1, m.start_number) end;
  loop v := public.numbering_render(m.pattern, n, p_ctx); exit when not public.numbering_is_taken(m.doc_type, v); n := n + 1; end loop;
  return v;
end $$;

-- take the next number (locks the matrix)
create or replace function public.numbering_take(p_doc text, p_ctx jsonb, p_global boolean default true, out number text, out matrix_id bigint)
language plpgsql security definer set search_path = public as $$
declare m public.numbering_matrices; n integer; per text;
begin
  m := public.numbering_find(p_doc, p_ctx, p_global);
  if m.id is null then return; end if;
  select * into m from public.numbering_matrices where id = m.id for update;
  per := public.numbering_period(m.reset_interval);
  n := case when m.period_key is distinct from per or m.current_number is null then m.start_number else greatest(m.current_number + 1, m.start_number) end;
  loop number := public.numbering_render(m.pattern, n, p_ctx); exit when not public.numbering_is_taken(p_doc, number); n := n + 1; end loop;
  update public.numbering_matrices set current_number = n, period_key = per, updated_at = now() where id = m.id;
  matrix_id := m.id;
end $$;
revoke execute on function public.numbering_take(text, jsonb, boolean) from public, anon, authenticated;

-- staff: preview the next number of a document type for a case (certificate: incl. the policy-year matrices)
create or replace function public.admin_numbering_preview(p_doc text, p_indication bigint) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare ctx jsonb; m public.numbering_matrices; legacy jsonb; v_year text := to_char(now() at time zone 'Europe/Berlin', 'YYYY');
begin
  if not public.is_admin() then raise exception 'not authorised'; end if;
  ctx := public.numbering_ctx(p_indication);
  if p_doc = 'certificate' then
    legacy := public.admin_cert_number_preview(p_indication);
    if coalesce((legacy->>'blocked')::boolean, false) then return legacy; end if;
    m := public.numbering_find('certificate', ctx, legacy->>'mode' = 'legacy');
    if m.id is not null and (legacy->>'mode' = 'legacy' or m.scope_type = 'office') then
      return jsonb_build_object('mode', 'framework', 'number', public.numbering_next(m, ctx), 'matrix', m.name, 'allow_manual', m.allow_manual, 'policy_year_id', legacy->'policy_year_id');
    end if;
    return legacy;
  end if;
  m := public.numbering_find(p_doc, ctx, true);
  if m.id is not null then return jsonb_build_object('mode', 'framework', 'number', public.numbering_next(m, ctx), 'matrix', m.name, 'allow_manual', m.allow_manual); end if;
  if p_doc = 'cover_note' then
    return jsonb_build_object('mode', 'legacy', 'allow_manual', true,
      'number', 'FRCN-CN-' || v_year || '-' || lpad((coalesce((select n from public.ref_counters where scope = 'cn-' || v_year), 0) + 1)::text, 4, '0'));
  end if;
  return jsonb_build_object('mode', 'legacy', 'allow_manual', true, 'number', null);
end $$;
grant execute on function public.admin_numbering_preview(text, bigint) to authenticated;

-- staff: test a pattern
create or replace function public.admin_numbering_sample(p_pattern text, p_seq integer, p_ctx jsonb) returns text
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'not authorised'; end if;
  return public.numbering_render(p_pattern, coalesce(p_seq, 1), coalesce(p_ctx, '{}'::jsonb));
end $$;
grant execute on function public.admin_numbering_sample(text, integer, jsonb) to authenticated;

create or replace function public.admin_number_taken(p_doc text, p_number text) returns boolean
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'not authorised'; end if;
  return public.numbering_is_taken(p_doc, trim(p_number));
end $$;
grant execute on function public.admin_number_taken(text, text) to authenticated;

-- certificates: a framework matrix replaces the plain counter (and an office matrix also the policy-year matrix)
create or replace function public.certificates_framework_no() returns trigger
language plpgsql security definer set search_path = public as $$
declare ctx jsonb; t record; m public.numbering_matrices;
begin
  if coalesce(new.numbering_mode, 'legacy') not in ('legacy','matrix') then return new; end if;
  new.numbering_mode := coalesce(new.numbering_mode, 'legacy');
  ctx := public.numbering_ctx(new.indication_id);
  m := public.numbering_find('certificate', ctx, new.numbering_mode = 'legacy');
  if m.id is null or (new.numbering_mode = 'matrix' and m.scope_type <> 'office') then return new; end if;
  select * into t from public.numbering_take('certificate', ctx, new.numbering_mode = 'legacy');
  if t.number is null then return new; end if;
  new.number := t.number; new.numbering_mode := 'framework'; new.matrix_id := null;
  new.data := coalesce(new.data, '{}'::jsonb) || jsonb_build_object('no', t.number);
  return new;
end $$;
drop trigger if exists certificates_framework_no on public.certificates;
create trigger certificates_framework_no before insert on public.certificates for each row execute function public.certificates_framework_no();

-- cover notes: framework number for the automatic numbers
create or replace function public.cover_notes_framework_no() returns trigger
language plpgsql security definer set search_path = public as $$
declare ctx jsonb; t record;
begin
  if new.number !~ '^FRCN-CN-\d{4}-\d{4,}$' then return new; end if;
  ctx := public.numbering_ctx(new.indication_id);
  select * into t from public.numbering_take('cover_note', ctx, true);
  if t.number is null then return new; end if;
  new.number := t.number; new.data := coalesce(new.data, '{}'::jsonb) || jsonb_build_object('number', t.number);
  return new;
end $$;
drop trigger if exists cover_notes_framework_no on public.cover_notes;
create trigger cover_notes_framework_no before insert on public.cover_notes for each row execute function public.cover_notes_framework_no();

-- cover notes: custom number (duplicates refused); the number actually stored is returned
drop function if exists public.admin_issue_cover_note(bigint, bigint, jsonb);
create or replace function public.admin_issue_cover_note(p_indication_id bigint, p_quotation_id bigint, p_data jsonb, p_number text default null)
returns text
language plpgsql security definer set search_path = public as $$
declare v_no text; v_id bigint; i public.indications; p public.profiles; v_year text := to_char(now() at time zone 'Europe/Berlin', 'YYYY'); m public.numbering_matrices;
begin
  if not public.is_admin() then raise exception 'not authorised'; end if;
  select * into i from public.indications where id = p_indication_id;
  if not found then raise exception 'not found'; end if;
  perform pg_advisory_xact_lock(4712);
  if nullif(trim(coalesce(p_number, '')), '') is not null then
    m := public.numbering_find('cover_note', public.numbering_ctx(i.id), true);
    if m.id is not null and not m.allow_manual then raise exception 'Manual cover note numbers are switched off for the matrix "%".', m.name; end if;
    v_no := trim(p_number);
    if exists (select 1 from public.cover_notes where number = v_no) then raise exception 'Cover note no. % is already used.', v_no; end if;
  else
    v_no := 'FRCN-CN-' || v_year || '-' || lpad(public.next_counter('cn-' || v_year)::text, 4, '0');
  end if;
  insert into public.cover_notes(indication_id, quotation_id, number, data, created_by)
  values (i.id, p_quotation_id, v_no, coalesce(p_data, '{}'::jsonb) || jsonb_build_object('number', v_no), auth.uid())
  returning id, number into v_id, v_no;
  update public.indications set stage = 'bound' where id = i.id;
  select * into p from public.profiles where id = i.user_id;
  perform public.emit('cover_note_issued', jsonb_build_object('indication_id', i.id, 'ref', i.ref, 'number', v_no,
    'email', p.email, 'name', p.full_name, 'company', p.company));
  return v_no;
end $$;
grant execute on function public.admin_issue_cover_note(bigint, bigint, jsonb, text) to authenticated;

-- claims: framework number instead of the automatic references
create or replace function public.claims_framework_no() returns trigger
language plpgsql security definer set search_path = public as $$
declare t record;
begin
  if new.ref !~ '^(FRCN-CL|CLM)-\d{4}-\d{4,}$' then return new; end if;
  select * into t from public.numbering_take('claim', public.numbering_ctx(new.indication_id, new.customer_id, new.policy_id, new.office_id), true);
  if t.number is not null then new.ref := t.number; end if;
  return new;
end $$;
drop trigger if exists claims_framework_no on public.claims;
create trigger claims_framework_no before insert on public.claims for each row execute function public.claims_framework_no();

-- cases: framework reference when the automatic one is assigned
create or replace function public.indications_framework_ref() returns trigger
language plpgsql security definer set search_path = public as $$
declare t record;
begin
  if new.ref is null or new.ref !~ '^FRCN-\d{4}-\d{4,}$' or (tg_op = 'UPDATE' and old.ref is not null) then return new; end if;
  select * into t from public.numbering_take('case', public.numbering_ctx(null, new.customer_id, case when coalesce(new.is_standalone_one_off, false) then null else new.policy_id end, new.office_id), true);
  if t.number is not null then new.ref := t.number; end if;
  return new;
end $$;
drop trigger if exists indications_framework_ref on public.indications;
create trigger indications_framework_ref before insert or update of ref on public.indications for each row execute function public.indications_framework_ref();

-- quotations: own number when a quotation matrix exists
create or replace function public.quotations_framework_no() returns trigger
language plpgsql security definer set search_path = public as $$
declare t record;
begin
  if new.number is not null then return new; end if;
  select * into t from public.numbering_take('quotation', public.numbering_ctx(new.indication_id), true);
  new.number := t.number;
  return new;
end $$;
drop trigger if exists quotations_framework_no on public.quotations;
create trigger quotations_framework_no before insert on public.quotations for each row execute function public.quotations_framework_no();

-- public settings for the client portal: GDPR texts
create or replace function public.public_gdpr() returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce((select value from public.settings where key = 'gdpr'), '{}'::jsonb)
$$;
grant execute on function public.public_gdpr() to anon, authenticated;

drop function if exists public._fc_patch(text, text, text, text);
