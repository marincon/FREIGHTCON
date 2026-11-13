-- =====================================================================
-- FREIGHTCON update 2026-11-13s - package 3: roles and Chinese wall
-- * user groups (Staff, Clients, Insurers, custom), departments
-- * staff roles: admins (configuration, users, rates, zones, clauses), placing (requests,
--   quotations, clients, policies), claims (claims) - one or several per staff member
-- * company groups / companies can be disabled; company type (client, insurer, surveyor, agent)
-- * permission matrix per user group, company group or company (features and dashboards)
-- * insurers: own dashboard with the cases and claims placed with their market only
-- * clients: certificates (.fdf) after acceptance and direct certificates, if switched on
-- * zones can be switched off per configuration level (one-offs, client, policy)
-- Run after update_2026-11-13r.sql. Safe to run more than once.
-- =====================================================================

-- ---------- user groups, departments ----------
create table if not exists public.user_groups (
  id     bigserial primary key,
  code   text not null unique check (code ~ '^[a-z0-9_]{2,30}$'),
  name   text not null,
  kind   text not null default 'client' check (kind in ('staff','client','insurer')),
  active boolean not null default true,
  sort   int not null default 100,
  notes  text
);
insert into public.user_groups(code, name, kind, sort) values
  ('staff', 'Staff (MARINCON internal)', 'staff', 10), ('clients', 'Clients (forwarders, shippers, assureds)', 'client', 20), ('insurers', 'Insurers (underwriters, lead / co-insurers, claims leaders)', 'insurer', 30)
on conflict (code) do nothing;
create table if not exists public.departments (
  id          bigserial primary key,
  name        text not null,
  customer_id bigint references public.customers(id) on delete cascade,   -- null = available everywhere
  active      boolean not null default true,
  sort        int not null default 100
);
create unique index if not exists departments_uq on public.departments(coalesce(customer_id, 0), name);
insert into public.departments(name, sort) values ('General', 10), ('Ops (Operations)', 20), ('Admins', 30), ('Claims', 40), ('Invoicing', 50), ('Placing / Underwriting', 60), ('Management', 70)
on conflict do nothing;

alter table public.profiles add column if not exists user_group_id bigint references public.user_groups(id) on delete set null;
alter table public.profiles add column if not exists staff_roles text[] not null default '{}';
alter table public.profiles add column if not exists department_id bigint references public.departments(id) on delete set null;
alter table public.profiles add column if not exists insurer_id bigint references public.insurers(id) on delete set null;
do $$ begin
  alter table public.profiles add constraint profiles_staff_roles_chk check (staff_roles <@ array['admin','placing','claims']::text[]);
exception when duplicate_object then null; end $$;
-- today's staff keep full access
update public.profiles set staff_roles = array['admin','placing','claims'] where is_admin and staff_roles = '{}';
update public.profiles set user_group_id = (select id from public.user_groups where code = case when is_admin then 'staff' else 'clients' end) where user_group_id is null;

alter table public.client_groups add column if not exists active boolean not null default true;
alter table public.customers add column if not exists company_type text not null default 'client';
do $$ begin
  alter table public.customers add constraint customers_company_type_chk check (company_type in ('client','insurer','surveyor','agent'));
exception when duplicate_object then null; end $$;

-- defaults: new staff get all roles until an admin narrows them down; every user lands in a user group
create or replace function public.profiles_role_defaults() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.is_admin and coalesce(array_length(new.staff_roles, 1), 0) = 0 then new.staff_roles := array['admin','placing','claims']; end if;
  if not new.is_admin then new.staff_roles := '{}'; end if;
  if new.user_group_id is null or (tg_op = 'UPDATE' and new.is_admin is distinct from old.is_admin and new.user_group_id is not distinct from old.user_group_id) then
    new.user_group_id := (select id from public.user_groups where code = case when new.is_admin then 'staff' when new.insurer_id is not null then 'insurers' else 'clients' end);
  end if;
  return new;
end $$;
drop trigger if exists profiles_role_defaults on public.profiles;
create trigger profiles_role_defaults before insert or update on public.profiles for each row execute function public.profiles_role_defaults();

-- staff role check: admins may do everything
create or replace function public.has_role(p_role text) returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select is_admin and is_active and (staff_roles && array['admin', p_role]) from public.profiles where id = auth.uid()), false)
$$;
grant execute on function public.has_role(text) to authenticated;
create or replace function public.my_staff_roles() returns text[]
language sql stable security definer set search_path = public as $$
  select case when is_admin then staff_roles else '{}'::text[] end from public.profiles where id = auth.uid()
$$;
grant execute on function public.my_staff_roles() to authenticated;

-- staff roles and user group are staff-admin business
create or replace function public.profiles_roles_guard() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if current_user in ('postgres','service_role','supabase_admin') or auth.uid() is null then return new; end if;
  if (new.staff_roles is distinct from old.staff_roles or new.is_admin is distinct from old.is_admin or new.user_group_id is distinct from old.user_group_id or new.insurer_id is distinct from old.insurer_id)
     and not public.has_role('admin') then
    raise exception 'only staff admins can change roles and user groups';
  end if;
  return new;
end $$;
drop trigger if exists profiles_roles_guard on public.profiles;
create trigger profiles_roles_guard before update on public.profiles for each row execute function public.profiles_roles_guard();

-- ---------- write access by staff role (everyone on staff can read) ----------
do $$
declare t text; r text;
begin
  foreach t in array array['rate_tables','rate_cells','commodities','commodity_terms','countries','country_zones','scope_settings','zone_maps','war_areas','war_exclusions',
                           'clause_library','customer_clauses','policy_clauses','settings','user_groups','departments','role_dashboard_permissions','client_groups','insurers',
                           'customers','policies','offices','claims']
  loop
    if not exists (select 1 from information_schema.tables where table_schema = 'public' and table_name = t) then continue; end if;
    r := case when t in ('customers','policies','offices') then 'placing' when t = 'claims' then 'claims' else 'admin' end;
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists admin_all on public.%I', t);
    execute format('drop policy if exists staff_read on public.%I', t);
    execute format('drop policy if exists role_write on public.%I', t);
    execute format('create policy staff_read on public.%I for select to authenticated using (public.is_admin())', t);
    execute format('create policy role_write on public.%I for all to authenticated using (public.has_role(%L)) with check (public.has_role(%L))', t, r, r);
  end loop;
end $$;

-- ---------- permission matrix ----------
create table if not exists public.role_dashboard_permissions (
  id           bigserial primary key,
  subject_type text not null check (subject_type in ('user_group','company_group','company')),
  subject_id   bigint not null,
  feature      text not null check (feature ~ '^[a-z0-9_:]{2,40}$'),
  allowed      boolean not null,
  updated_at   timestamptz not null default now(),
  unique (subject_type, subject_id, feature)
);
alter table public.role_dashboard_permissions enable row level security;
drop policy if exists staff_read on public.role_dashboard_permissions;
create policy staff_read on public.role_dashboard_permissions for select to authenticated using (public.is_admin());
drop policy if exists role_write on public.role_dashboard_permissions;
create policy role_write on public.role_dashboard_permissions for all to authenticated using (public.has_role('admin')) with check (public.has_role('admin'));

-- features of the logged-in user: company -> company group -> user group -> default
create or replace function public.my_features() returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare p public.profiles; c public.customers; ug public.user_groups; f text; v boolean; out jsonb := '{}'::jsonb;
  defs jsonb := '{"new_request":true,"my_shipments":true,"bulk_upload":true,"claims":true,"policy_clauses":false,"zone_map":false,"rates":false,"fdf_certificate":true,"direct_certificate":true,"insurer_dashboard":true}';
begin
  select * into p from public.profiles where id = auth.uid();
  if not found then return null; end if;
  select * into c from public.customers where id = public.user_customer_id(p.id);
  select * into ug from public.user_groups where id = p.user_group_id;
  for f in select jsonb_object_keys(defs) loop
    select allowed into v from public.role_dashboard_permissions where subject_type = 'company' and subject_id = c.id and feature = f;
    if v is null then select allowed into v from public.role_dashboard_permissions where subject_type = 'company_group' and subject_id = c.group_id and feature = f; end if;
    if v is null then select allowed into v from public.role_dashboard_permissions where subject_type = 'user_group' and subject_id = ug.id and feature = f; end if;
    out := out || jsonb_build_object(f, coalesce(v, (defs->>f)::boolean));
  end loop;
  -- certificates only where staff switched them on for the client
  out := out || jsonb_build_object('fdf_certificate', coalesce((out->>'fdf_certificate')::boolean, false) and coalesce(c.fdf_certificate_enabled, false),
                                   'direct_certificate', coalesce((out->>'direct_certificate')::boolean, false) and coalesce(c.direct_certificate_enabled, false) and coalesce(c.fdf_certificate_enabled, false),
                                   'user_group', coalesce(ug.kind, case when p.is_admin then 'staff' else 'client' end),
                                   'insurer', p.insurer_id is not null and coalesce(ug.kind, '') = 'insurer');
  return out;
end $$;
grant execute on function public.my_features() to authenticated;

-- ---------- zones switched off per level ----------
alter table public.zone_maps add column if not exists disabled int[] not null default '{}';
create or replace function public.cz(p_iso text, p_st text, p_sid bigint) returns public.country_zones
language plpgsql stable security definer set search_path = public as $$
declare r public.country_zones; ds int[]; da int[];
begin
  select * into r from public.country_zones where iso2 = p_iso and scope_type = p_st and coalesce(scope_id, 0) = coalesce(p_sid, 0);
  if r.id is null then return r; end if;
  select disabled into ds from public.zone_maps where scope_type = p_st and coalesce(scope_id, 0) = coalesce(p_sid, 0) and mode = 'sea';
  select disabled into da from public.zone_maps where scope_type = p_st and coalesce(scope_id, 0) = coalesce(p_sid, 0) and mode = 'air';
  -- a switched-off zone counts as unassigned: no automatic rate
  if r.sea_zone = any(coalesce(ds, '{}')) then r.sea_zone := null; end if;
  if r.air_zone = any(coalesce(da, '{}')) then r.air_zone := null; end if;
  return r;
end $$;

-- ---------- client portal: policy clauses and zones (only if permitted) ----------
create or replace function public.my_clauses() returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare p public.profiles; c bigint; po bigint; lst text;
begin
  select * into p from public.profiles where id = auth.uid();
  if not found or not coalesce((public.my_features()->>'policy_clauses')::boolean, false) then return '[]'::jsonb; end if;
  c := public.user_customer_id(p.id);
  select policy_id into po from public.offices where id = p.office_id;
  if po is null then select id into po from public.policies where customer_id = c and active order by sort, id limit 1; end if;
  return coalesce((select jsonb_agg(jsonb_build_object('category', l.category, 'title', l.title, 'body', l.body) order by array_position(array['header','general','subject_matter','special_cargo','special','expenses','contingency','claims','administration','sanctions','pricing','disclaimer','subjectivity'], l.category), x.sort, l.sort)
    from (select clause_id, sort from public.policy_clauses where policy_id = po and enabled
          union all select clause_id, sort from public.customer_clauses where customer_id = c and enabled and not exists (select 1 from public.policy_clauses where policy_id = po)) x
    join public.clause_library l on l.id = x.clause_id where l.active and l.category <> 'pricing'), '[]'::jsonb);
end $$;
grant execute on function public.my_clauses() to authenticated;
create or replace function public.my_zones() returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare p public.profiles; c bigint; po bigint; st text; sid bigint;
begin
  select * into p from public.profiles where id = auth.uid();
  if not found or not coalesce((public.my_features()->>'zone_map')::boolean, false) then return '[]'::jsonb; end if;
  c := public.user_customer_id(p.id);
  select policy_id into po from public.offices where id = p.office_id;
  select z.st, z.sid into st, sid from public.zone_scope(po, c) z;
  return coalesce((select jsonb_agg(jsonb_build_object('iso2', z.iso2, 'name', k.name, 'sea', (public.cz(z.iso2, st, sid)).sea_zone, 'air', (public.cz(z.iso2, st, sid)).air_zone) order by k.name)
    from public.country_zones z join public.countries k on k.iso2 = z.iso2 where z.scope_type = st and coalesce(z.scope_id, 0) = coalesce(sid, 0) and z.compliance <> 'blocked'), '[]'::jsonb);
end $$;
grant execute on function public.my_zones() to authenticated;

-- ---------- certificates by the client ----------
-- p_indication: own case with an accepted quotation; or null = direct certificate (p_shipment is rated and stored now)
create or replace function public.client_issue_certificate(p_indication bigint, p_shipment jsonb, p_cert jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare me public.profiles; f jsonb := public.my_features(); r public.indications; res jsonb; n int; cno text; q public.quotations; d jsonb; v_st text; v_rs text[];
begin
  select * into me from public.profiles where id = auth.uid();
  if not found or not public.is_approved() then raise exception 'not authorised'; end if;
  if not coalesce((f->>'fdf_certificate')::boolean, false) then raise exception 'certificates are not enabled for your account'; end if;
  if p_indication is null then
    if not coalesce((f->>'direct_certificate')::boolean, false) then raise exception 'direct certificates are not enabled for your account'; end if;
    res := public.calc_indication(p_shipment);
    select * into r from public.indications where id = (res->>'id')::bigint;
    -- the real rating (clients with hidden premium only see "request" on their own row)
    select coalesce(ii.status, r.status), coalesce(ii.reasons, r.reasons) into v_st, v_rs from public.indications x left join public.indication_internal ii on ii.indication_id = x.id where x.id = r.id;
    if r.is_out_of_cover or v_st <> 'quoted' then
      raise exception 'This shipment cannot be certified directly: %. Please send it as a request.', coalesce(nullif(array_to_string(v_rs, '; '), ''), case when r.is_out_of_cover then 'outside your open cover' else 'no automatic rate' end);
    end if;
    if r.ref is null then r.ref := public.assign_ref(r.id); end if;
    update public.indications set is_direct_certificate = true, stage = 'bound', quote_requested_at = coalesce(quote_requested_at, now()) where id = r.id;
  else
    select * into r from public.indications where id = p_indication and user_id = me.id;
    if not found then raise exception 'not found'; end if;
    select * into q from public.quotations where indication_id = r.id and status = 'accepted' order by version desc limit 1;
    if q.id is null then raise exception 'accept the quotation first'; end if;
  end if;
  perform pg_advisory_xact_lock(4711);
  select coalesce(max(nullif(regexp_replace(number, '\D', '', 'g'), '')::int), 0) + 1 into n from public.certificates;
  cno := n::text;
  d := coalesce(p_cert, '{}'::jsonb) || jsonb_build_object('no', cno, 'issued_by_client', true);
  insert into public.certificates(indication_id, quotation_id, number, data, created_by) values (r.id, q.id, cno, d, me.id);
  perform public.emit('certificate_issued', jsonb_build_object('indication_id', r.id, 'ref', coalesce(r.ref, public.assign_ref(r.id)), 'number', cno, 'email', me.email, 'name', me.full_name,
    'company', r.company, 'direct', p_indication is null, 'sum_insured', r.sum_insured, 'currency', r.currency));
  return jsonb_build_object('number', cno, 'indication_id', r.id, 'ref', coalesce(r.ref, (select ref from public.indications where id = r.id)), 'sum_insured', r.sum_insured, 'currency', r.currency,
    'uplift_pct', r.uplift_pct, 'incoterm', r.incoterm, 'conveyance', r.conveyance, 'vessel', r.vessel, 'goods', r.goods_description,
    'from', concat_ws(', ', r.origin_place, (select name from public.countries where iso2 = r.origin_country)), 'to', concat_ws(', ', r.dest_place, (select name from public.countries where iso2 = r.dest_country)),
    'conditions', r.conditions, 'holder', coalesce((select cert_holder from public.customers where id = r.customer_id), r.insured_name, r.company),
    'pol_no', coalesce((select cert_open_policy from public.customers where id = r.customer_id), public.setting('certificate_form')->>'open_policy'),
    'claims', coalesce((select cert_claims_contact from public.customers where id = r.customer_id), public.setting('certificate_form')->>'claims_contact', 'www.vht-network.de'));
end $$;
grant execute on function public.client_issue_certificate(bigint, jsonb, jsonb) to authenticated;
-- clients see their own certificates
drop policy if exists own_read on public.certificates;
create policy own_read on public.certificates for select to authenticated using (public.owns_indication(indication_id));

-- ---------- insurers: their own cases and claims only ----------
create or replace function public.insurer_dashboard() returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare me public.profiles; ins public.insurers;
begin
  select * into me from public.profiles where id = auth.uid();
  if not found or me.insurer_id is null or not public.is_approved() or not coalesce((public.my_features()->>'insurer_dashboard')::boolean, false) then raise exception 'not authorised'; end if;
  select * into ins from public.insurers where id = me.insurer_id;
  return jsonb_build_object('insurer', ins.name,
    'cases', coalesce((select jsonb_agg(x order by x->>'date' desc) from (
        select jsonb_build_object('ref', i.ref, 'date', q.created_at, 'status', q.status, 'stage', i.stage, 'goods', i.goods_description, 'from', i.origin_country, 'to', i.dest_country,
               'conveyance', i.conveyance, 'sum_insured', i.sum_insured, 'currency', i.currency, 'net_to_insurer', qi.net_to_insurer, 'cover', i.cover,
               'certificates', (select count(*) from public.certificates c where c.indication_id = i.id)) x
          from public.quotation_internal qi join public.quotations q on q.id = qi.quotation_id join public.indications i on i.id = q.indication_id
         where qi.insurer_id = ins.id and q.status in ('open','accepted')) s), '[]'::jsonb),
    'claims', coalesce((select jsonb_agg(jsonb_build_object('ref', c.ref, 'status', c.status, 'loss_type', c.loss_type, 'incident_date', c.incident_date, 'case', i.ref,
               'amount', c.estimated_amount, 'currency', c.currency) order by c.created_at desc)
          from public.claims c join public.indications i on i.id = c.indication_id
         where exists (select 1 from public.quotation_internal qi join public.quotations q on q.id = qi.quotation_id where q.indication_id = i.id and qi.insurer_id = ins.id and q.status = 'accepted')), '[]'::jsonb));
end $$;
grant execute on function public.insurer_dashboard() to authenticated;

-- claims in all four currencies
alter table public.claims drop constraint if exists claims_currency_check;
alter table public.claims add constraint claims_currency_check check (currency in ('EUR','USD','GBP','SGD'));

-- ---------- serious-change counts (company group, company, user group, zone) ----------
create or replace function public.admin_impact(p_kind text, p_id bigint) returns jsonb
language sql stable security definer set search_path = public as $$
  select case when not public.is_admin() then null
    when p_kind = 'company_group' then jsonb_build_object('companies', (select count(*) from public.customers where group_id = p_id),
         'policies', (select count(*) from public.policies p join public.customers c on c.id = p.customer_id where c.group_id = p_id),
         'offices', (select count(*) from public.offices o join public.customers c on c.id = o.customer_id where c.group_id = p_id),
         'users', (select count(*) from public.profiles x where x.customer_id in (select id from public.customers where group_id = p_id)))
    when p_kind = 'company' then jsonb_build_object('policies', (select count(*) from public.policies where customer_id = p_id), 'offices', (select count(*) from public.offices where customer_id = p_id),
         'users', (select count(*) from public.profiles where customer_id = p_id), 'cases', (select count(*) from public.indications where customer_id = p_id))
    when p_kind = 'user_group' then jsonb_build_object('users', (select count(*) from public.profiles where user_group_id = p_id))
    when p_kind = 'department' then jsonb_build_object('users', (select count(*) from public.profiles where department_id = p_id)) end
$$;
grant execute on function public.admin_impact(text, bigint) to authenticated;

-- ---------- audited configuration functions: staff admins only ----------
create or replace function public.admin_set_zones(p_rows jsonb, p_reason text, p_scope_type text default 'one_off_general', p_scope_id bigint default null) returns int
language plpgsql security definer set search_path = public as $$
declare me public.profiles; c jsonb; z public.country_zones; v_sea int; v_air int; v_ch text[] := '{}'; v_name text;
begin
  if not public.has_role('admin') then raise exception 'only staff admins can change rates, zones and configurations'; end if;
  if length(trim(coalesce(p_reason, ''))) < 3 then raise exception 'reason required'; end if;
  if p_scope_type = 'one_off_general' then p_scope_id := null; end if;
  select * into me from public.profiles where id = auth.uid();
  perform set_config('fc.audited', '1', true);
  for c in select * from jsonb_array_elements(coalesce(p_rows, '[]'::jsonb)) loop
    select name into v_name from public.countries where iso2 = c->>'iso2';
    if v_name is null then raise exception 'unknown country %', c->>'iso2'; end if;
    z := public.cz(c->>'iso2', p_scope_type, p_scope_id);
    v_sea := nullif(c->>'sea_zone', '')::int; v_air := nullif(c->>'air_zone', '')::int;
    if z.id is null then
      insert into public.country_zones(scope_type, scope_id, iso2, sea_zone, air_zone) values (p_scope_type, p_scope_id, c->>'iso2', v_sea, v_air);
      v_ch := v_ch || (v_name || ': sea - -> ' || coalesce(v_sea::text, '-') || ', air - -> ' || coalesce(v_air::text, '-'));
    elsif v_sea is distinct from z.sea_zone or v_air is distinct from z.air_zone then
      update public.country_zones set sea_zone = v_sea, air_zone = v_air, updated_at = now() where id = z.id;
      v_ch := v_ch || (v_name || ': sea ' || coalesce(z.sea_zone::text, '-') || ' -> ' || coalesce(v_sea::text, '-') || ', air ' || coalesce(z.air_zone::text, '-') || ' -> ' || coalesce(v_air::text, '-'));
    end if;
    if p_scope_type = 'one_off_general' then update public.countries set sea_zone = v_sea, air_zone = v_air where iso2 = c->>'iso2'; end if;
  end loop;
  if array_length(v_ch, 1) is not null then
    insert into public.audit_log(user_id, user_name, entity, entity_id, summary, reason)
    values (auth.uid(), coalesce(me.full_name, me.email), 'zones', p_scope_type || coalesce(':' || p_scope_id, ''), array_to_string(v_ch, '; '), trim(p_reason));
  end if;
  return coalesce(array_length(v_ch, 1), 0);
end $$;

create or replace function public.admin_zone_count(p_mode text, p_action text, p_reason text, p_scope_type text default 'one_off_general', p_scope_id bigint default null) returns int
language plpgsql security definer set search_path = public as $$
declare me public.profiles; n int; v_list text;
begin
  if not public.has_role('admin') then raise exception 'only staff admins can change rates, zones and configurations'; end if;
  if p_mode not in ('sea','air') or p_action not in ('add','remove') then raise exception 'invalid'; end if;
  if length(trim(coalesce(p_reason, ''))) < 3 then raise exception 'reason required'; end if;
  if p_scope_type = 'one_off_general' then p_scope_id := null; end if;
  select * into me from public.profiles where id = auth.uid();
  perform set_config('fc.audited', '1', true);
  select max(zones) into n from public.rate_tables where mode = p_mode and scope_type = p_scope_type and coalesce(scope_id, 0) = coalesce(p_scope_id, 0);
  if n is null then raise exception 'no % schedules in this scope', p_mode; end if;
  if p_action = 'add' then
    update public.rate_tables set zones = n + 1, updated_at = now() where mode = p_mode and scope_type = p_scope_type and coalesce(scope_id, 0) = coalesce(p_scope_id, 0);
    insert into public.audit_log(user_id, user_name, entity, entity_id, summary, reason)
    values (auth.uid(), coalesce(me.full_name, me.email), 'zones', p_scope_type || coalesce(':' || p_scope_id, ''), initcap(p_mode) || ' zone ' || (n + 1) || ' added (rates empty = on request until filled in)', trim(p_reason));
    return n + 1;
  end if;
  if n <= 1 then raise exception 'at least one zone'; end if;
  select string_agg(c.name, ', ' order by c.name) into v_list from public.country_zones z join public.countries c on c.iso2 = z.iso2
   where z.scope_type = p_scope_type and coalesce(z.scope_id, 0) = coalesce(p_scope_id, 0) and (case p_mode when 'sea' then z.sea_zone else z.air_zone end) = n;
  if p_mode = 'sea' then update public.country_zones set sea_zone = null where scope_type = p_scope_type and coalesce(scope_id, 0) = coalesce(p_scope_id, 0) and sea_zone = n;
  else update public.country_zones set air_zone = null where scope_type = p_scope_type and coalesce(scope_id, 0) = coalesce(p_scope_id, 0) and air_zone = n; end if;
  delete from public.rate_cells c using public.rate_tables t where t.id = c.table_id and t.mode = p_mode and t.scope_type = p_scope_type and coalesce(t.scope_id, 0) = coalesce(p_scope_id, 0) and c.zone_b = n;
  update public.rate_tables set zones = n - 1, updated_at = now() where mode = p_mode and scope_type = p_scope_type and coalesce(scope_id, 0) = coalesce(p_scope_id, 0);
  insert into public.audit_log(user_id, user_name, entity, entity_id, summary, reason)
  values (auth.uid(), coalesce(me.full_name, me.email), 'zones', p_scope_type || coalesce(':' || p_scope_id, ''), initcap(p_mode) || ' zone ' || n || ' removed; now unassigned: ' || coalesce(v_list, 'no countries'), trim(p_reason));
  return n - 1;
end $$;

create or replace function public.admin_copy_config(p_parts_j jsonb, p_from_type text, p_from_id bigint, p_targets jsonb, p_items jsonb, p_reason text) returns int
language plpgsql security definer set search_path = public as $$
declare p_parts text[] := array(select jsonb_array_elements_text(p_parts_j)); me public.profiles; tg jsonb; tt text; ti bigint; n int := 0; t public.rate_tables; new_id text; sfx text; k text; v jsonb; x record; cid bigint; c public.clause_library;
  keys text[] := array['cover_factors','conveyance_factors','packing_factors','deck_loading_pct','theft_land_factor','contingency_factor','sea_war_permille','air_war_permille','land_strikes_permille','land_rates','land_min_premium','auto_limit','uplift_pct','extensions','land_groups'];
  it_s text[] := array(select jsonb_array_elements_text(coalesce(p_items->'schedules', 'null'::jsonb)) where jsonb_typeof(p_items->'schedules') = 'array');
  it_c text[] := array(select jsonb_array_elements_text(p_items->'cargo') where jsonb_typeof(p_items->'cargo') = 'array');
  it_z text[] := array(select jsonb_array_elements_text(p_items->'zones') where jsonb_typeof(p_items->'zones') = 'array');
  it_k bigint[] := array(select (jsonb_array_elements_text(p_items->'clauses'))::bigint where jsonb_typeof(p_items->'clauses') = 'array');
begin
  if not public.has_role('admin') then raise exception 'only staff admins can change rates, zones and configurations'; end if;
  if length(trim(coalesce(p_reason, ''))) < 3 then raise exception 'reason required'; end if;
  if p_from_type = 'one_off_general' then p_from_id := null; end if;
  select * into me from public.profiles where id = auth.uid();
  perform set_config('fc.audited', '1', true);
  for tg in select * from jsonb_array_elements(coalesce(p_targets, '[]'::jsonb)) loop
    tt := tg->>'type'; ti := case when tt = 'one_off_general' then null else (tg->>'id')::bigint end;
    if tt not in ('one_off_general','customer','policy') then raise exception 'invalid target'; end if;
    if tt = p_from_type and coalesce(ti, 0) = coalesce(p_from_id, 0) then continue; end if;
    sfx := case tt when 'customer' then '@c' || ti when 'policy' then '@p' || ti else '' end;

    if 'schedules' = any(p_parts) then
      for t in select * from public.rate_tables where scope_type = p_from_type and coalesce(scope_id, 0) = coalesce(p_from_id, 0)
                 and (array_length(it_s, 1) is null or kind = any(it_s)) loop
        new_id := t.kind || sfx;
        insert into public.rate_tables(id, name, mode, zones, war_included_permille, min_premium, deck_allowed, contingency_allowed, used_loading_pct, cars_loading_pct, household_flat_permille, notes, sort, kind, scope_type, scope_id)
        values (new_id, t.name, t.mode, t.zones, t.war_included_permille, t.min_premium, t.deck_allowed, t.contingency_allowed, t.used_loading_pct, t.cars_loading_pct, t.household_flat_permille, t.notes, t.sort, t.kind, tt, ti)
        on conflict (id) do update set name = excluded.name, zones = excluded.zones, war_included_permille = excluded.war_included_permille, min_premium = excluded.min_premium,
          deck_allowed = excluded.deck_allowed, contingency_allowed = excluded.contingency_allowed, used_loading_pct = excluded.used_loading_pct,
          cars_loading_pct = excluded.cars_loading_pct, household_flat_permille = excluded.household_flat_permille, updated_at = now();
        delete from public.rate_cells where table_id = new_id;
        insert into public.rate_cells(table_id, zone_a, zone_b, permille) select new_id, zone_a, zone_b, permille from public.rate_cells where table_id = t.id;
        n := n + 1;
      end loop;
    end if;

    if 'cargo' = any(p_parts) then
      for x in
        select cm.id as commodity_id, coalesce(ct.active, cm.active) active, coalesce(ct.on_request, cm.on_request) on_request, coalesce(ct.allowed_covers, cm.allowed_covers) allowed_covers,
               coalesce(ct.class_factor, cm.class_factor) class_factor, case when ct.id is null then cm.sea_table else ct.sea_table end sea_table,
               case when ct.id is null then cm.air_class else ct.air_class end air_class, case when ct.id is null then cm.oc_class else ct.oc_class end oc_class,
               case when ct.id is null then cm.loading_pct else ct.loading_pct end loading_pct, coalesce(ct.theft_attractive, cm.theft_attractive) theft_attractive,
               case when ct.id is null then cm.deductible else ct.deductible end deductible, case when ct.id is null then cm.conditions else ct.conditions end conditions,
               case when ct.id is null then cm.max_sum_insured else ct.max_sum_insured end max_sum_insured, coalesce(ct.ext_hssc, cm.ext_hssc) ext_hssc, coalesce(ct.ext_liw, cm.ext_liw) ext_liw
          from public.commodities cm
          left join public.commodity_terms ct on ct.commodity_id = cm.id and ct.scope_type = p_from_type and ct.scope_id = p_from_id
         where (array_length(it_c, 1) is null or cm.id = any(it_c))
           and (p_from_type = 'one_off_general' or ct.id is not null)
      loop
        if tt = 'one_off_general' then
          update public.commodities set active = x.active, on_request = x.on_request, allowed_covers = x.allowed_covers, class_factor = x.class_factor, sea_table = x.sea_table,
            air_class = x.air_class, oc_class = x.oc_class, loading_pct = x.loading_pct, theft_attractive = x.theft_attractive, deductible = x.deductible,
            conditions = x.conditions, max_sum_insured = x.max_sum_insured, ext_hssc = x.ext_hssc, ext_liw = x.ext_liw where id = x.commodity_id;
        else
          insert into public.commodity_terms(scope_type, scope_id, commodity_id, active, on_request, allowed_covers, class_factor, sea_table, air_class, oc_class, loading_pct, theft_attractive, deductible, conditions, max_sum_insured, ext_hssc, ext_liw)
          values (tt, ti, x.commodity_id, x.active, x.on_request, x.allowed_covers, x.class_factor, x.sea_table, x.air_class, x.oc_class, x.loading_pct, x.theft_attractive, x.deductible, x.conditions, x.max_sum_insured, x.ext_hssc, x.ext_liw)
          on conflict (scope_type, scope_id, commodity_id) do update set active = excluded.active, on_request = excluded.on_request, allowed_covers = excluded.allowed_covers,
            class_factor = excluded.class_factor, sea_table = excluded.sea_table, air_class = excluded.air_class, oc_class = excluded.oc_class, loading_pct = excluded.loading_pct,
            theft_attractive = excluded.theft_attractive, deductible = excluded.deductible, conditions = excluded.conditions, max_sum_insured = excluded.max_sum_insured,
            ext_hssc = excluded.ext_hssc, ext_liw = excluded.ext_liw, updated_at = now();
        end if;
        n := n + 1;
      end loop;
    end if;

    if 'zones' = any(p_parts) then
      for x in select * from public.country_zones where scope_type = p_from_type and coalesce(scope_id, 0) = coalesce(p_from_id, 0)
                 and (array_length(it_z, 1) is null or iso2 = any(it_z)) loop
        insert into public.country_zones(scope_type, scope_id, iso2, sea_zone, air_zone, compliance, note) values (tt, ti, x.iso2, x.sea_zone, x.air_zone, x.compliance, x.note)
        on conflict (scope_type, coalesce(scope_id, 0), iso2) do update set sea_zone = excluded.sea_zone, air_zone = excluded.air_zone, compliance = excluded.compliance, note = excluded.note, updated_at = now();
        if tt = 'one_off_general' then update public.countries set sea_zone = x.sea_zone, air_zone = x.air_zone, compliance = x.compliance where iso2 = x.iso2; end if;
        n := n + 1;
      end loop;
    end if;

    if 'factors' = any(p_parts) then
      foreach k in array keys loop
        v := case when p_from_type = 'one_off_general' then (select value from public.settings where key = k)
                  else (select value from public.scope_settings where scope_type = p_from_type and scope_id = p_from_id and key = k) end;
        if v is null then continue; end if;
        if tt = 'one_off_general' then update public.settings set value = v, updated_at = now() where key = k;
        else insert into public.scope_settings(scope_type, scope_id, key, value) values (tt, ti, k, v) on conflict (scope_type, scope_id, key) do update set value = excluded.value, updated_at = now(); end if;
        n := n + 1;
      end loop;
    end if;

    if 'map' = any(p_parts) then
      for x in select * from public.zone_maps where scope_type = p_from_type and coalesce(scope_id, 0) = coalesce(p_from_id, 0) loop
        insert into public.zone_maps(scope_type, scope_id, mode, colors, labels) values (tt, ti, x.mode, x.colors, x.labels)
        on conflict (scope_type, coalesce(scope_id, 0), mode) do update set colors = excluded.colors, labels = excluded.labels, updated_at = now();
        n := n + 1;
      end loop;
    end if;

    if 'war' = any(p_parts) then
      delete from public.war_exclusions where scope_type = tt and coalesce(scope_id, 0) = coalesce(ti, 0)
        and area_code in (select area_code from public.war_exclusions where scope_type = p_from_type and coalesce(scope_id, 0) = coalesce(p_from_id, 0));
      insert into public.war_exclusions(scope_type, scope_id, area_code, buyback_permille, ncb_pct, active, note)
      select tt, ti, area_code, buyback_permille, ncb_pct, active, note from public.war_exclusions where scope_type = p_from_type and coalesce(scope_id, 0) = coalesce(p_from_id, 0);
      get diagnostics cid = row_count; n := n + cid;
    end if;

    if 'clauses' = any(p_parts) then
      -- the source's own clauses become clauses of the target; the default ticks follow
      for c in select * from public.clause_library cl where (array_length(it_k, 1) is null or cl.id = any(it_k))
                 and ((cl.scope_type = p_from_type and coalesce(cl.scope_id, 0) = coalesce(p_from_id, 0)) or cl.scope_type = 'one_off_general') loop
        if c.scope_type <> 'one_off_general' and not (tt = c.scope_type and coalesce(ti, 0) = coalesce(c.scope_id, 0)) then
          insert into public.clause_library(category, title, body, maritime, default_spot, active, sort, scope_type, scope_id)
          values (c.category, c.title, c.body, c.maritime, tt = 'one_off_general' and c.default_spot, c.active, c.sort, tt, ti)
          on conflict (scope_type, coalesce(scope_id, 0), category, title) do update set body = excluded.body, maritime = excluded.maritime, updated_at = now()
          returning id into cid;
        else cid := c.id; end if;
        if p_from_type = 'customer' then v := to_jsonb(coalesce((select enabled from public.customer_clauses where customer_id = p_from_id and clause_id = c.id), false));
        elsif p_from_type = 'policy' then v := to_jsonb(coalesce((select enabled from public.policy_clauses where policy_id = p_from_id and clause_id = c.id), false));
        else v := to_jsonb(c.default_spot); end if;
        if array_length(it_k, 1) is not null then v := 'true'::jsonb; end if;   -- single clauses: copy = make it a default of the target
        if tt = 'customer' then insert into public.customer_clauses(customer_id, clause_id, enabled) values (ti, cid, (v)::text::boolean) on conflict (customer_id, clause_id) do update set enabled = excluded.enabled;
        elsif tt = 'policy' then insert into public.policy_clauses(policy_id, clause_id, enabled) values (ti, cid, (v)::text::boolean) on conflict (policy_id, clause_id) do update set enabled = excluded.enabled;
        else update public.clause_library set default_spot = (v)::text::boolean where id = cid; end if;
        n := n + 1;
      end loop;
    end if;
  end loop;
  insert into public.audit_log(user_id, user_name, entity, entity_id, summary, reason)
  values (auth.uid(), coalesce(me.full_name, me.email), 'copy', p_from_type || coalesce(':' || p_from_id, ''),
          'Copied ' || array_to_string(p_parts, ', ') || ' to ' || (select string_agg((t2->>'type') || coalesce(':' || (t2->>'id'), ''), ', ') from jsonb_array_elements(p_targets) t2) || ' (' || n || ' items)', trim(p_reason));
  return n;
end $$;

create or replace function public.admin_save_rate_table(p_table text, p_meta jsonb, p_cells jsonb, p_removed jsonb, p_reason text) returns int
language plpgsql security definer set search_path = public as $$
declare t public.rate_tables; me public.profiles; c jsonb; a int; b int; v_old numeric; v_new numeric; v_ch text[] := '{}'; n int := 0; k text;
begin
  if not public.has_role('admin') then raise exception 'only staff admins can change rates, zones and configurations'; end if;
  if length(trim(coalesce(p_reason, ''))) < 3 then raise exception 'reason required'; end if;
  select * into t from public.rate_tables where id = p_table for update;
  if not found then raise exception 'schedule not found'; end if;
  select * into me from public.profiles where id = auth.uid();
  perform set_config('fc.audited', '1', true);
  p_meta := coalesce(p_meta, '{}'::jsonb);
  foreach k in array array['min_premium','war_included_permille','used_loading_pct','cars_loading_pct','household_flat_permille'] loop
    if p_meta ? k and (p_meta->>k)::numeric is distinct from (to_jsonb(t)->>k)::numeric then
      v_ch := v_ch || (replace(k, '_', ' ') || ' ' || coalesce(trim_scale((to_jsonb(t)->>k)::numeric)::text, '-') || ' -> ' || coalesce(trim_scale((p_meta->>k)::numeric)::text, '-'));
    end if;
  end loop;
  foreach k in array array['deck_allowed','contingency_allowed'] loop
    if p_meta ? k and (p_meta->>k)::boolean is distinct from (to_jsonb(t)->>k)::boolean then
      v_ch := v_ch || (replace(k, '_', ' ') || ' -> ' || (p_meta->>k));
    end if;
  end loop;
  update public.rate_tables set
    min_premium             = case when p_meta ? 'min_premium' then coalesce((p_meta->>'min_premium')::numeric, 0) else min_premium end,
    war_included_permille   = case when p_meta ? 'war_included_permille' then coalesce((p_meta->>'war_included_permille')::numeric, 0) else war_included_permille end,
    deck_allowed            = case when p_meta ? 'deck_allowed' then (p_meta->>'deck_allowed')::boolean else deck_allowed end,
    contingency_allowed     = case when p_meta ? 'contingency_allowed' then (p_meta->>'contingency_allowed')::boolean else contingency_allowed end,
    used_loading_pct        = case when p_meta ? 'used_loading_pct' then (p_meta->>'used_loading_pct')::numeric else used_loading_pct end,
    cars_loading_pct        = case when p_meta ? 'cars_loading_pct' then (p_meta->>'cars_loading_pct')::numeric else cars_loading_pct end,
    household_flat_permille = case when p_meta ? 'household_flat_permille' then (p_meta->>'household_flat_permille')::numeric else household_flat_permille end,
    updated_at = now()
   where id = p_table;
  for c in select * from jsonb_array_elements(coalesce(p_cells, '[]'::jsonb)) loop
    a := least((c->>'a')::int, (c->>'b')::int); b := greatest((c->>'a')::int, (c->>'b')::int); v_new := (c->>'v')::numeric;
    if a < 1 or b > t.zones or v_new is null or v_new < 0 then raise exception 'invalid rate'; end if;
    select permille into v_old from public.rate_cells where table_id = p_table and zone_a = a and zone_b = b;
    if v_old is distinct from v_new then
      insert into public.rate_cells(table_id, zone_a, zone_b, permille) values (p_table, a, b, v_new)
        on conflict (table_id, zone_a, zone_b) do update set permille = excluded.permille;
      v_ch := v_ch || (a || '-' || b || ': ' || coalesce(trim_scale(v_old)::text, '-') || ' -> ' || trim_scale(v_new)); n := n + 1;
    end if;
  end loop;
  for c in select * from jsonb_array_elements(coalesce(p_removed, '[]'::jsonb)) loop
    a := least((c->>'a')::int, (c->>'b')::int); b := greatest((c->>'a')::int, (c->>'b')::int);
    delete from public.rate_cells where table_id = p_table and zone_a = a and zone_b = b returning permille into v_old;
    if found then v_ch := v_ch || (a || '-' || b || ': ' || trim_scale(v_old) || ' -> individually'); n := n + 1; end if;
  end loop;
  if array_length(v_ch, 1) is not null then
    insert into public.audit_log(user_id, user_name, entity, entity_id, summary, reason)
    values (auth.uid(), coalesce(me.full_name, me.email), 'schedule', t.name, array_to_string(v_ch, '; '), trim(p_reason));
  end if;
  return coalesce(array_length(v_ch, 1), 0);
end $$;

notify pgrst, 'reload schema';
