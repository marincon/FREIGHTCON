-- =====================================================================
-- FREIGHTCON update 2026-11-16v (website version 2026-11-16a)
-- The colleague's "20261116_freightcon_update.sql":
--  1  cover types: only one_off and open_cover ("policy" becomes open_cover)
--  2  subcategories: the former policies, reachable as client_subcategories
--  3  certificates per client: can_issue_certificates + certificate_mode (platform_pdf / fdf_export)
--  4  document templates (certificate / cover note) per configuration, client and subcategory, with matrices
--  5  rating: client group as a configuration level, zone codes / names / colours, zone CRUD,
--     clear_rating_setup(), Excel / CSV import, views rating_zones and rate_schedules
-- Run after update_2026-11-13u.sql. Safe to run more than once.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1  cover types
-- ---------------------------------------------------------------------
alter table public.customers drop constraint if exists customers_cover_type_check;
alter table public.policies  drop constraint if exists policies_cover_type_check;
alter table public.profiles  drop constraint if exists profiles_cover_type_check;
update public.customers set cover_type = 'open_cover' where cover_type = 'policy';
update public.policies  set cover_type = 'open_cover' where cover_type = 'policy';
update public.profiles  set cover_type = 'open_cover' where cover_type = 'policy';
alter table public.customers add constraint customers_cover_type_check check (cover_type in ('one_off','open_cover'));
alter table public.policies  add constraint policies_cover_type_check  check (cover_type = 'open_cover');
alter table public.profiles  add constraint profiles_cover_type_check  check (cover_type is null or cover_type in ('one_off','open_cover'));

-- ---------------------------------------------------------------------
-- 2  subcategories (same rows as the policies table; existing links, numbers and policy years stay)
-- ---------------------------------------------------------------------
drop view if exists public.client_subcategories;
create view public.client_subcategories with (security_invoker = true) as
  select p.*, p.customer_id as client_id,
         p.name || case when coalesce(p.policy_no, '') <> '' then ' (' || p.policy_no || ')' else '' end as subcategory_label
    from public.policies p;
grant select on public.client_subcategories to authenticated;

-- ---------------------------------------------------------------------
-- 4  document templates (before the client columns that point to them)
-- ---------------------------------------------------------------------
create table if not exists public.document_templates (
  id          bigserial primary key,
  scope_type  text not null check (scope_type in ('one_off_general','customer','policy')),
  scope_id    bigint,
  doc_type    text not null check (doc_type in ('certificate','cover_note')),
  name        text not null default 'Template' check (length(trim(name)) between 1 and 120),
  body        text not null default '',           -- HTML with {{tokens}} and [[matrix:ID]] placeholders
  settings    jsonb not null default '{}'::jsonb, -- font_family, font_size_pt, orientation, border, show_header, client_logo_url
  matrices    jsonb not null default '[]'::jsonb, -- [{id, title, header_bg, border_color, rows:[[cell, ...], ...]}], first row = header
  active      boolean not null default true,
  updated_by  uuid,
  updated_at  timestamptz not null default now(),
  check ((scope_type = 'one_off_general' and scope_id is null) or (scope_type <> 'one_off_general' and scope_id is not null))
);
create unique index if not exists document_templates_uq on public.document_templates(scope_type, coalesce(scope_id, 0), doc_type);

insert into public.document_templates(scope_type, scope_id, doc_type, name, body, settings, matrices)
select 'one_off_general', null, v.t, v.n, v.b, v.s::jsonb, v.m::jsonb from (values
 ('certificate', 'Certificate of insurance',
  '<h4>CERTIFICATE OF INSURANCE No. {{certificate_no}}</h4><p>This is to certify that insurance has been effected under Open Policy No. <b>{{open_policy_no}}</b> on behalf of <b>{{policy_holder}}</b> on the goods described below, subject to the terms and conditions of the policy.</p>[[matrix:m1]]<p><b>Description of goods:</b><br>{{description_of_goods}}</p><p><b>Conditions:</b> {{condition_code}}</p>{{clauses_block}}<p class="box"><b>Additional agreements:</b> {{additional_agreements}}</p><p>In the event of loss or damage, please contact the survey agent: {{survey_agent_url}}</p><p>Date of issue: {{date_of_issue}}</p>',
  '{"font_family":"Calibri","font_size_pt":10,"orientation":"portrait","border":"thin","show_header":true,"client_logo_url":""}',
  '[{"id":"m1","title":"Schedule of insured values & deductibles","header_bg":"#1F3F8F","border_color":"#1F3F8F","rows":[["Order / ref.","Conveyance","Voyage from","Voyage to"],["{{order_ref}}","{{conveyance}}","{{voyage_from}}","{{voyage_to}}"],["Sum insured","Valuation","Uplift","Deductible"],["{{currency}} {{sum_insured}}","{{valuation_basis}}","{{uplift_pct}} %","{{deductible}}"]]}]'),
 ('cover_note', 'Cover note',
  '<h4>COVER NOTE {{certificate_no}}</h4><p>We confirm that we have placed insurance as follows on behalf of <b>{{policy_holder}}</b>:</p>[[matrix:m1]]<p><b>Goods:</b> {{description_of_goods}}</p>{{clauses_block}}<p class="box">{{additional_agreements}}</p><p>Hamburg, {{date_of_issue}}</p>',
  '{"font_family":"Calibri","font_size_pt":10,"orientation":"portrait","border":"double","show_header":true,"client_logo_url":""}',
  '[{"id":"m1","title":"Security & premium summary","header_bg":"#1F3F8F","border_color":"#1F3F8F","rows":[["Reference","Voyage","Sum insured","Deductible"],["{{order_ref}}","{{voyage_from}} - {{voyage_to}}","{{currency}} {{sum_insured}}","{{deductible}}"]]}]')
) v(t, n, b, s, m)
where not exists (select 1 from public.document_templates d where d.scope_type = 'one_off_general' and d.doc_type = v.t);

-- ---------------------------------------------------------------------
-- 3  certificates per client (and per subcategory if needed)
-- ---------------------------------------------------------------------
alter table public.customers add column if not exists can_issue_certificates boolean not null default false;
alter table public.customers add column if not exists certificate_mode text not null default 'platform_pdf';
alter table public.customers add column if not exists certificate_template_id bigint references public.document_templates(id) on delete set null;
alter table public.customers add column if not exists cover_note_template_id  bigint references public.document_templates(id) on delete set null;
alter table public.customers drop constraint if exists customers_certificate_mode_check;
alter table public.customers add constraint customers_certificate_mode_check check (certificate_mode in ('platform_pdf','fdf_export'));
alter table public.policies add column if not exists can_issue_certificates boolean;          -- null = as the client
alter table public.policies add column if not exists certificate_mode text;
alter table public.policies drop constraint if exists policies_certificate_mode_check;
alter table public.policies add constraint policies_certificate_mode_check check (certificate_mode is null or certificate_mode in ('platform_pdf','fdf_export'));
-- clients that already issue certificates (Bertling) keep their .fdf workflow
do $$ begin
  if not exists (select 1 from public.settings where key = 'seed_certificate_mode_v') then
    update public.customers set can_issue_certificates = true, certificate_mode = 'fdf_export' where fdf_certificate_enabled or name ilike '%bertling%';
    insert into public.settings(key, value, note) values ('seed_certificate_mode_v', 'true', 'internal: certificate flags taken over once');
  end if;
end $$;
-- the older flag follows the new one
create or replace function public.customers_cert_sync() returns trigger
language plpgsql as $$
begin
  new.fdf_certificate_enabled := new.can_issue_certificates;
  if not new.can_issue_certificates then new.direct_certificate_enabled := false; end if;
  return new;
end $$;
drop trigger if exists customers_cert_sync on public.customers;
create trigger customers_cert_sync before insert or update on public.customers for each row execute function public.customers_cert_sync();
update public.customers set can_issue_certificates = can_issue_certificates;

-- the client's subcategory: office -> first active one
create or replace function public.user_policy_id(p_uid uuid) returns bigint
language sql stable security definer set search_path = public as $$
  select coalesce((select o.policy_id from public.profiles p join public.offices o on o.id = p.office_id where p.id = p_uid),
                  (select id from public.policies where customer_id = public.user_customer_id(p_uid) and active order by sort, id limit 1))
$$;
revoke execute on function public.user_policy_id(uuid) from public, anon, authenticated;

create or replace function public.my_features() returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare p public.profiles; c public.customers; po public.policies; ug public.user_groups; f text; v boolean; out jsonb := '{}'::jsonb; can boolean; mode text;
  defs jsonb := '{"new_request":true,"my_shipments":true,"bulk_upload":true,"claims":true,"policy_clauses":false,"zone_map":false,"rates":false,"fdf_certificate":true,"direct_certificate":true,"insurer_dashboard":true}';
begin
  select * into p from public.profiles where id = auth.uid();
  if not found then return null; end if;
  select * into c from public.customers where id = public.user_customer_id(p.id);
  select * into po from public.policies where id = public.user_policy_id(p.id);
  select * into ug from public.user_groups where id = p.user_group_id;
  for f in select jsonb_object_keys(defs) loop
    select allowed into v from public.role_dashboard_permissions where subject_type = 'company' and subject_id = c.id and feature = f;
    if v is null then select allowed into v from public.role_dashboard_permissions where subject_type = 'company_group' and subject_id = c.group_id and feature = f; end if;
    if v is null then select allowed into v from public.role_dashboard_permissions where subject_type = 'user_group' and subject_id = ug.id and feature = f; end if;
    out := out || jsonb_build_object(f, coalesce(v, (defs->>f)::boolean));
  end loop;
  -- certificates only where staff switched them on (subcategory overrides the client)
  can := coalesce(po.can_issue_certificates, c.can_issue_certificates, false);
  mode := coalesce(po.certificate_mode, c.certificate_mode, 'platform_pdf');
  out := out || jsonb_build_object('fdf_certificate', coalesce((out->>'fdf_certificate')::boolean, false) and can,
                                   'can_issue_certificates', coalesce((out->>'fdf_certificate')::boolean, false) and can,
                                   'certificate_mode', mode,
                                   'direct_certificate', coalesce((out->>'direct_certificate')::boolean, false) and coalesce(c.direct_certificate_enabled, false) and can,
                                   'user_group', coalesce(ug.kind, case when p.is_admin then 'staff' else 'client' end),
                                   'insurer', p.insurer_id is not null and coalesce(ug.kind, '') = 'insurer');
  return out;
end $$;
grant execute on function public.my_features() to authenticated;

-- the template a document uses: subcategory -> client -> configuration
create or replace function public.document_template_for(p_doc text, p_cust bigint, p_pol bigint) returns public.document_templates
language plpgsql stable security definer set search_path = public as $$
declare t public.document_templates; cu public.customers;
begin
  if p_pol is not null then select * into t from public.document_templates where scope_type = 'policy' and scope_id = p_pol and doc_type = p_doc and active; end if;
  if t.id is null and p_cust is not null then
    select * into cu from public.customers where id = p_cust;
    if p_doc = 'certificate' and cu.certificate_template_id is not null then select * into t from public.document_templates where id = cu.certificate_template_id and active; end if;
    if p_doc = 'cover_note' and cu.cover_note_template_id is not null then select * into t from public.document_templates where id = cu.cover_note_template_id and active; end if;
    if t.id is null then select * into t from public.document_templates where scope_type = 'customer' and scope_id = p_cust and doc_type = p_doc and active; end if;
  end if;
  if t.id is null then select * into t from public.document_templates where scope_type = 'one_off_general' and doc_type = p_doc and active; end if;
  return t;
end $$;
revoke execute on function public.document_template_for(text, bigint, bigint) from public, anon, authenticated;
-- the client portal: its own template (for platform certificates)
create or replace function public.my_document_template(p_doc text) returns jsonb
language sql stable security definer set search_path = public as $$
  select to_jsonb(t) - 'updated_by' from public.document_template_for(p_doc, public.user_customer_id(auth.uid()), public.user_policy_id(auth.uid())) t where t.id is not null
$$;
grant execute on function public.my_document_template(text) to authenticated;

-- ---------------------------------------------------------------------
-- 5  rating: client group as a level, zones with code / name / colour, CRUD, clear, import
-- ---------------------------------------------------------------------
-- scope_type 'client_group' everywhere a configuration lives
do $$
declare r record; d text;
begin
  for r in select c.conrelid::regclass::text tbl, c.conname, pg_get_constraintdef(c.oid) def
             from pg_constraint c join pg_class k on k.oid = c.conrelid join pg_namespace n on n.oid = k.relnamespace
            where n.nspname = 'public' and c.contype = 'c'
              and k.relname in ('country_zones','zone_maps','rate_tables','commodity_terms','scope_settings','war_exclusions','war_areas')
              and pg_get_constraintdef(c.oid) like '%scope_type%' and pg_get_constraintdef(c.oid) like '%''policy''::text%'
              and pg_get_constraintdef(c.oid) not like '%client_group%'
  loop
    d := replace(r.def, '''policy''::text]', '''policy''::text, ''client_group''::text]');
    execute format('alter table %s drop constraint %I', r.tbl, r.conname);
    execute format('alter table %s add constraint %I %s', r.tbl, r.conname, d);
  end loop;
end $$;
-- rate_tables may have no scope check yet: make sure the scope stays one of the four
alter table public.rate_tables drop constraint if exists rate_tables_scope_v;
alter table public.rate_tables add constraint rate_tables_scope_v check (scope_type in ('one_off_general','customer','policy','client_group'));

-- zone codes and the number of zones per scope and mode (zones exist before any schedule)
alter table public.zone_maps add column if not exists codes jsonb not null default '{}'::jsonb;   -- {"1":"Z1", ...}
alter table public.zone_maps add column if not exists zones int;
alter table public.zone_maps add column if not exists disabled int[];

-- resolution: subcategory -> client -> client group (one-offs: the general pool)
create or replace function public.rt_pick(p_kind text, p_pol bigint, p_cust bigint) returns public.rate_tables
language plpgsql stable security definer set search_path = public as $$
declare t public.rate_tables; g bigint;
begin
  if p_pol is null and p_cust is null then
    select * into t from public.rate_tables where kind = p_kind and scope_type = 'one_off_general';
    return t;
  end if;
  if p_pol is not null then select * into t from public.rate_tables where kind = p_kind and scope_type = 'policy' and scope_id = p_pol; end if;
  if t.id is null and p_cust is not null then select * into t from public.rate_tables where kind = p_kind and scope_type = 'customer' and scope_id = p_cust; end if;
  if t.id is null and p_cust is not null then
    select group_id into g from public.customers where id = p_cust;
    if g is not null then select * into t from public.rate_tables where kind = p_kind and scope_type = 'client_group' and scope_id = g; end if;
  end if;
  return t;
end $$;
create or replace function public.zone_scope(p_pol bigint, p_cust bigint, out st text, out sid bigint)
language plpgsql stable security definer set search_path = public as $$
declare g bigint;
begin
  if p_pol is null and p_cust is null then st := 'one_off_general'; sid := null; return; end if;
  if p_pol is not null and exists (select 1 from public.country_zones where scope_type = 'policy' and scope_id = p_pol) then st := 'policy'; sid := p_pol; return; end if;
  if p_cust is not null and exists (select 1 from public.country_zones where scope_type = 'customer' and scope_id = p_cust) then st := 'customer'; sid := p_cust; return; end if;
  if p_cust is not null then
    select group_id into g from public.customers where id = p_cust;
    if g is not null and exists (select 1 from public.country_zones where scope_type = 'client_group' and scope_id = g) then st := 'client_group'; sid := g; return; end if;
  end if;
  st := null; sid := null;
end $$;
create or replace function public.sset(p_key text, p_pol bigint, p_cust bigint) returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce(
    (select value from public.scope_settings where scope_type = 'policy' and scope_id = p_pol and key = p_key),
    (select value from public.scope_settings where scope_type = 'customer' and scope_id = p_cust and key = p_key),
    (select s.value from public.scope_settings s join public.customers c on c.group_id = s.scope_id where s.scope_type = 'client_group' and c.id = p_cust and s.key = p_key),
    (select value from public.settings where key = p_key))
$$;
-- cargo terms: the client group joins the chain (patched in place, the rest of the function stays)
do $$
declare d text;
begin
  select pg_get_functiondef('public.cargo_pick(text, bigint, bigint)'::regprocedure) into d;
  if position('client_group' in d) = 0 then
    d := replace(d, $x$  if t.id is null then
    c.active := true;$x$, $x$  if t.id is null and p_cust is not null then select ct.* into t from public.commodity_terms ct join public.customers cu on cu.group_id = ct.scope_id where ct.scope_type = 'client_group' and cu.id = p_cust and ct.commodity_id = p_com; end if;
  if t.id is null then
    c.active := true;$x$);
    execute d;
  end if;
end $$;
-- copying configurations: client groups are a valid source and target
do $$
declare d text;
begin
  select pg_get_functiondef('public.admin_copy_config(jsonb, text, bigint, jsonb, jsonb, text)'::regprocedure) into d;
  if position('client_group' in d) = 0 then
    d := replace(d, $x$if tt not in ('one_off_general','customer','policy') then$x$, $x$if tt not in ('one_off_general','customer','policy','client_group') then$x$);
    d := replace(d, $x$sfx := case tt when 'customer' then '@c' || ti when 'policy' then '@p' || ti else '' end;$x$, $x$sfx := case tt when 'customer' then '@c' || ti when 'policy' then '@p' || ti when 'client_group' then '@g' || ti else '' end;$x$);
    execute d;
  end if;
end $$;
-- deleting a client group removes its configuration
create or replace function public.scope_cleanup() returns trigger
language plpgsql security definer set search_path = public as $$
declare st text := case tg_table_name when 'customers' then 'customer' when 'client_groups' then 'client_group' else 'policy' end;
begin
  perform set_config('fc.audited', '1', true);
  delete from public.rate_tables    where scope_type = st and scope_id = old.id;   -- rate_cells cascade
  delete from public.commodity_terms where scope_type = st and scope_id = old.id;
  delete from public.country_zones  where scope_type = st and scope_id = old.id;
  delete from public.scope_settings where scope_type = st and scope_id = old.id;
  delete from public.zone_maps      where scope_type = st and scope_id = old.id;
  delete from public.war_exclusions where scope_type = st and scope_id = old.id;
  if st <> 'client_group' then delete from public.clause_library where scope_type = st and scope_id = old.id; end if;
  if st <> 'client_group' then delete from public.document_templates where scope_type = st and scope_id = old.id; end if;
  return old;
end $$;
drop trigger if exists client_groups_scope_cleanup on public.client_groups;
create trigger client_groups_scope_cleanup after delete on public.client_groups for each row execute function public.scope_cleanup();

-- helpers for the zone functions
create or replace function public.scope_label(p_st text, p_sid bigint) returns text
language sql stable security definer set search_path = public as $$
  select case p_st when 'one_off_general' then 'General one-off pool'
    when 'customer' then (select name from public.customers where id = p_sid)
    when 'policy' then 'Subcategory ' || (select name || coalesce(' (' || nullif(policy_no, '') || ')', '') from public.policies where id = p_sid)
    when 'client_group' then 'Client group ' || (select name from public.client_groups where id = p_sid) end
$$;
create or replace function public.zone_total(p_st text, p_sid bigint, p_mode text) returns int
language sql stable security definer set search_path = public as $$
  select greatest(coalesce((select max(zones) from public.rate_tables where mode = p_mode and scope_type = p_st and coalesce(scope_id, 0) = coalesce(p_sid, 0)), 0),
                  coalesce((select zones from public.zone_maps where mode = p_mode and scope_type = p_st and coalesce(scope_id, 0) = coalesce(p_sid, 0)), 0),
                  coalesce((select max(case p_mode when 'sea' then sea_zone else air_zone end) from public.country_zones where scope_type = p_st and coalesce(scope_id, 0) = coalesce(p_sid, 0)), 0))
$$;
create or replace function public.zone_map_row(p_st text, p_sid bigint, p_mode text) returns public.zone_maps
language plpgsql security definer set search_path = public as $$
declare z public.zone_maps;
begin
  select * into z from public.zone_maps where scope_type = p_st and coalesce(scope_id, 0) = coalesce(p_sid, 0) and mode = p_mode;
  if z.id is null then insert into public.zone_maps(scope_type, scope_id, mode) values (p_st, case when p_st = 'one_off_general' then null else p_sid end, p_mode) returning * into z; end if;
  return z;
end $$;
revoke execute on function public.zone_map_row(text, bigint, text) from public, anon, authenticated;
-- the zone number behind a code (zones without a stored code are Z1, Z2, ...)
create or replace function public.zone_by_code(p_st text, p_sid bigint, p_mode text, p_code text) returns int
language sql stable security definer set search_path = public as $$
  select g.z from generate_series(1, public.zone_total(p_st, p_sid, p_mode)) g(z)
    left join public.zone_maps m on m.scope_type = p_st and coalesce(m.scope_id, 0) = coalesce(p_sid, 0) and m.mode = p_mode
   where upper(coalesce(m.codes->>(g.z::text), 'Z' || g.z)) = upper(trim(p_code)) order by g.z limit 1
$$;

-- add or edit a zone: code, name, colour and its countries (p_zone null = new zone at the end)
create or replace function public.admin_zone_upsert(p_scope_type text, p_scope_id bigint, p_mode text, p_zone int, p_code text, p_name text, p_color text, p_countries text[], p_reason text) returns int
language plpgsql security definer set search_path = public as $$
declare me public.profiles; n int; z int; zm public.zone_maps; iso text; bad text; moved int := 0; freed int := 0;
begin
  if not public.has_role('admin') then raise exception 'only staff admins can change rates, zones and configurations'; end if;
  if p_mode not in ('sea','air') then raise exception 'invalid mode'; end if;
  if length(trim(coalesce(p_reason, ''))) < 3 then raise exception 'reason required'; end if;
  if p_scope_type = 'one_off_general' then p_scope_id := null; end if;
  p_code := upper(trim(coalesce(p_code, '')));
  if p_code !~ '^[A-Z0-9_./]{1,12}$' then raise exception 'Zone code: 1 to 12 letters or digits, e.g. Z1'; end if;
  if coalesce(p_color, '') !~ '^#[0-9a-fA-F]{6}$' then p_color := null; end if;
  select string_agg(x, ', ') into bad from unnest(coalesce(p_countries, '{}')) x where not exists (select 1 from public.countries where iso2 = upper(x));
  if bad is not null then raise exception 'Unknown country codes: %', bad; end if;
  select * into me from public.profiles where id = auth.uid();
  perform set_config('fc.audited', '1', true);
  n := public.zone_total(p_scope_type, p_scope_id, p_mode);
  zm := public.zone_map_row(p_scope_type, p_scope_id, p_mode);
  z := public.zone_by_code(p_scope_type, p_scope_id, p_mode, p_code);
  if z is not null and z <> coalesce(p_zone, -1) then raise exception 'The zone code % is already used in this scope.', p_code; end if;
  if p_zone is null then
    z := n + 1;
    update public.rate_tables set zones = z, updated_at = now() where mode = p_mode and scope_type = p_scope_type and coalesce(scope_id, 0) = coalesce(p_scope_id, 0);
  else
    if p_zone < 1 or p_zone > n then raise exception 'zone not found'; end if;
    z := p_zone;
  end if;
  update public.zone_maps set zones = greatest(coalesce(zones, 0), z, n), codes = codes || jsonb_build_object(z::text, p_code),
         labels = labels || jsonb_build_object(z::text, coalesce(nullif(trim(p_name), ''), p_code)),
         colors = case when p_color is null then colors else colors || jsonb_build_object(z::text, p_color) end, updated_at = now()
   where id = zm.id;
  -- countries: the listed ones move into the zone, the others of the zone become unassigned
  if p_countries is not null then
    if p_mode = 'sea' then
      update public.country_zones set sea_zone = null, updated_at = now() where scope_type = p_scope_type and coalesce(scope_id, 0) = coalesce(p_scope_id, 0) and sea_zone = z and not (iso2 = any(array(select upper(x) from unnest(p_countries) x)));
    else
      update public.country_zones set air_zone = null, updated_at = now() where scope_type = p_scope_type and coalesce(scope_id, 0) = coalesce(p_scope_id, 0) and air_zone = z and not (iso2 = any(array(select upper(x) from unnest(p_countries) x)));
    end if;
    get diagnostics freed = row_count;
    foreach iso in array array(select distinct upper(x) from unnest(p_countries) x) loop
      insert into public.country_zones(scope_type, scope_id, iso2, sea_zone, air_zone)
      values (p_scope_type, p_scope_id, iso, case when p_mode = 'sea' then z end, case when p_mode = 'air' then z end)
      on conflict (scope_type, coalesce(scope_id, 0), iso2) do update set sea_zone = case when p_mode = 'sea' then z else public.country_zones.sea_zone end,
                                                                         air_zone = case when p_mode = 'air' then z else public.country_zones.air_zone end, updated_at = now();
      moved := moved + 1;
      if p_scope_type = 'one_off_general' then
        if p_mode = 'sea' then update public.countries set sea_zone = z where iso2 = iso; else update public.countries set air_zone = z where iso2 = iso; end if;
      end if;
    end loop;
  end if;
  insert into public.audit_log(user_id, user_name, entity, entity_id, summary, reason)
  values (auth.uid(), coalesce(me.full_name, me.email), 'zones', p_scope_type || coalesce(':' || p_scope_id, ''),
          initcap(p_mode) || ' zone ' || p_code || case when p_zone is null then ' added' else ' changed' end || ' (' || coalesce(nullif(trim(p_name), ''), p_code) || '): ' || moved || ' countries' || case when freed > 0 then ', ' || freed || ' now unassigned' else '' end, trim(p_reason));
  return z;
end $$;
grant execute on function public.admin_zone_upsert(text, bigint, text, int, text, text, text, text[], text) to authenticated;

-- remove any zone: its countries become unassigned, its row / column leaves every schedule; higher zones move up
create or replace function public.admin_zone_remove(p_scope_type text, p_scope_id bigint, p_mode text, p_zone int, p_reason text) returns int
language plpgsql security definer set search_path = public as $$
declare me public.profiles; n int; zm public.zone_maps; v_list text; k int; nc jsonb := '{}'; nl jsonb := '{}'; nk jsonb := '{}'; code text;
begin
  if not public.has_role('admin') then raise exception 'only staff admins can change rates, zones and configurations'; end if;
  if p_mode not in ('sea','air') then raise exception 'invalid mode'; end if;
  if length(trim(coalesce(p_reason, ''))) < 3 then raise exception 'reason required'; end if;
  if p_scope_type = 'one_off_general' then p_scope_id := null; end if;
  select * into me from public.profiles where id = auth.uid();
  perform set_config('fc.audited', '1', true);
  n := public.zone_total(p_scope_type, p_scope_id, p_mode);
  if p_zone < 1 or p_zone > n then raise exception 'zone not found'; end if;
  zm := public.zone_map_row(p_scope_type, p_scope_id, p_mode);
  code := coalesce(zm.codes->>p_zone::text, 'Z' || p_zone);
  select string_agg(c.name, ', ' order by c.name) into v_list from public.country_zones z join public.countries c on c.iso2 = z.iso2
   where z.scope_type = p_scope_type and coalesce(z.scope_id, 0) = coalesce(p_scope_id, 0) and (case p_mode when 'sea' then z.sea_zone else z.air_zone end) = p_zone;
  if p_mode = 'sea' then
    update public.country_zones set sea_zone = case when sea_zone = p_zone then null else sea_zone - 1 end, updated_at = now()
     where scope_type = p_scope_type and coalesce(scope_id, 0) = coalesce(p_scope_id, 0) and sea_zone >= p_zone;
    if p_scope_type = 'one_off_general' then update public.countries set sea_zone = case when sea_zone = p_zone then null else sea_zone - 1 end where sea_zone >= p_zone; end if;
  else
    update public.country_zones set air_zone = case when air_zone = p_zone then null else air_zone - 1 end, updated_at = now()
     where scope_type = p_scope_type and coalesce(scope_id, 0) = coalesce(p_scope_id, 0) and air_zone >= p_zone;
    if p_scope_type = 'one_off_general' then update public.countries set air_zone = case when air_zone = p_zone then null else air_zone - 1 end where air_zone >= p_zone; end if;
  end if;
  -- matrix: drop the row / column, renumber the rest
  delete from public.rate_cells c using public.rate_tables t where t.id = c.table_id and t.mode = p_mode and t.scope_type = p_scope_type and coalesce(t.scope_id, 0) = coalesce(p_scope_id, 0)
     and (c.zone_a = p_zone or c.zone_b = p_zone);
  update public.rate_cells c set zone_a = c.zone_a - case when c.zone_a > p_zone then 1 else 0 end, zone_b = c.zone_b - 1
    from public.rate_tables t where t.id = c.table_id and t.mode = p_mode and t.scope_type = p_scope_type and coalesce(t.scope_id, 0) = coalesce(p_scope_id, 0) and c.zone_b > p_zone;
  update public.rate_tables set zones = greatest(zones - 1, 0), updated_at = now() where mode = p_mode and scope_type = p_scope_type and coalesce(scope_id, 0) = coalesce(p_scope_id, 0);
  -- codes, names, colours: renumber
  for k in 1..n loop
    continue when k = p_zone;
    if zm.codes ? k::text then nk := nk || jsonb_build_object((case when k > p_zone then k - 1 else k end)::text, zm.codes->k::text); end if;
    if zm.labels ? k::text then nl := nl || jsonb_build_object((case when k > p_zone then k - 1 else k end)::text, zm.labels->k::text); end if;
    if zm.colors ? k::text then nc := nc || jsonb_build_object((case when k > p_zone then k - 1 else k end)::text, zm.colors->k::text); end if;
  end loop;
  update public.zone_maps set codes = nk, labels = nl, colors = nc, zones = n - 1,
         disabled = array(select case when d > p_zone then d - 1 else d end from unnest(coalesce(disabled, '{}')) d where d <> p_zone), updated_at = now()
   where id = zm.id;
  insert into public.audit_log(user_id, user_name, entity, entity_id, summary, reason)
  values (auth.uid(), coalesce(me.full_name, me.email), 'zones', p_scope_type || coalesce(':' || p_scope_id, ''),
          initcap(p_mode) || ' zone ' || code || ' removed; now unassigned: ' || coalesce(v_list, 'no countries'), trim(p_reason));
  return n - 1;
end $$;
grant execute on function public.admin_zone_remove(text, bigint, text, int, text) to authenticated;

-- an empty schedule of a kind in a scope (name and settings like the general pool's schedule of that kind)
create or replace function public.admin_ensure_schedule(p_scope_type text, p_scope_id bigint, p_kind text) returns text
language plpgsql security definer set search_path = public as $$
declare g public.rate_tables; t public.rate_tables; sfx text; nid text;
begin
  if not public.has_role('admin') then raise exception 'only staff admins can change rates, zones and configurations'; end if;
  if p_scope_type = 'one_off_general' then p_scope_id := null; end if;
  select * into t from public.rate_tables where kind = p_kind and scope_type = p_scope_type and coalesce(scope_id, 0) = coalesce(p_scope_id, 0);
  if t.id is not null then return t.id; end if;
  select * into g from public.rate_tables where kind = p_kind order by (scope_type = 'one_off_general') desc limit 1;
  if g.id is null then raise exception 'unknown schedule kind %', p_kind; end if;
  perform set_config('fc.audited', '1', true);
  sfx := case p_scope_type when 'customer' then '@c' || p_scope_id when 'policy' then '@p' || p_scope_id when 'client_group' then '@g' || p_scope_id else '' end;
  nid := p_kind || sfx;
  insert into public.rate_tables(id, name, mode, zones, war_included_permille, min_premium, deck_allowed, contingency_allowed, used_loading_pct, cars_loading_pct, household_flat_permille, notes, sort, kind, scope_type, scope_id)
  values (nid, g.name, g.mode, public.zone_total(p_scope_type, p_scope_id, g.mode), g.war_included_permille, g.min_premium, g.deck_allowed, g.contingency_allowed, g.used_loading_pct, g.cars_loading_pct, g.household_flat_permille, g.notes, g.sort, p_kind, p_scope_type, p_scope_id);
  return nid;
end $$;
grant execute on function public.admin_ensure_schedule(text, bigint, text) to authenticated;

-- clear the rating set-up of a subcategory / client / client group: zones, country assignments, schedules and rates
create or replace function public.clear_rating_setup(p_scope_type text, p_scope_id bigint) returns jsonb
language plpgsql security definer set search_path = public as $$
declare me public.profiles; a int; b int; c int; d int; lbl text;
begin
  if not public.has_role('admin') then raise exception 'only staff admins can change rates, zones and configurations'; end if;
  if p_scope_type not in ('customer','policy','client_group') or p_scope_id is null then raise exception 'Choose a subcategory, client or client group (the general one-off pool is never cleared).'; end if;
  lbl := public.scope_label(p_scope_type, p_scope_id);
  if lbl is null then raise exception 'scope not found'; end if;
  select * into me from public.profiles where id = auth.uid();
  perform set_config('fc.audited', '1', true);
  select count(*) into a from public.rate_cells x join public.rate_tables t on t.id = x.table_id where t.scope_type = p_scope_type and t.scope_id = p_scope_id;
  delete from public.rate_tables where scope_type = p_scope_type and scope_id = p_scope_id;    get diagnostics b = row_count;
  delete from public.country_zones where scope_type = p_scope_type and scope_id = p_scope_id;  get diagnostics c = row_count;
  delete from public.zone_maps where scope_type = p_scope_type and scope_id = p_scope_id;      get diagnostics d = row_count;
  insert into public.audit_log(user_id, user_name, entity, entity_id, summary, reason)
  values (auth.uid(), coalesce(me.full_name, me.email), 'rating_setup', p_scope_type || ':' || p_scope_id,
          'Rating set-up of ' || lbl || ' cleared: ' || b || ' schedule(s), ' || a || ' rate(s), ' || c || ' country assignment(s), ' || d || ' zone map(s)', 'Clear setup configuration');
  return jsonb_build_object('schedules', b, 'rates', a, 'countries', c, 'maps', d, 'scope', lbl);
end $$;
grant execute on function public.clear_rating_setup(text, bigint) to authenticated;

-- Excel / CSV import: zones (code, name, colour, countries) and one rate matrix, overwrite or merge
-- p_zones: [{code, name, color, countries:[...]}]; p_cells: [{from, to, rate}] with zone codes, rate null = refer (X)
create or replace function public.admin_import_rating(p_scope_type text, p_scope_id bigint, p_mode text, p_kind text, p_zones jsonb, p_cells jsonb, p_overwrite boolean, p_reason text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare me public.profiles; zm public.zone_maps; z jsonb; c jsonb; tid text; za int; zb int; v numeric; n_z int := 0; n_r int := 0; n_x int := 0; n_conf int := 0; seen jsonb := '{}'; k text;
begin
  if not public.has_role('admin') then raise exception 'only staff admins can change rates, zones and configurations'; end if;
  if p_mode not in ('sea','air') then raise exception 'invalid mode'; end if;
  if length(trim(coalesce(p_reason, ''))) < 3 then raise exception 'reason required'; end if;
  if p_scope_type = 'one_off_general' then p_scope_id := null; end if;
  select * into me from public.profiles where id = auth.uid();
  perform set_config('fc.audited', '1', true);
  if p_overwrite then
    delete from public.rate_cells x using public.rate_tables t where t.id = x.table_id and t.mode = p_mode and t.scope_type = p_scope_type and coalesce(t.scope_id, 0) = coalesce(p_scope_id, 0);
    update public.rate_tables set zones = 0 where mode = p_mode and scope_type = p_scope_type and coalesce(scope_id, 0) = coalesce(p_scope_id, 0);
    if p_mode = 'sea' then update public.country_zones set sea_zone = null where scope_type = p_scope_type and coalesce(scope_id, 0) = coalesce(p_scope_id, 0);
    else update public.country_zones set air_zone = null where scope_type = p_scope_type and coalesce(scope_id, 0) = coalesce(p_scope_id, 0); end if;
    delete from public.zone_maps where scope_type = p_scope_type and coalesce(scope_id, 0) = coalesce(p_scope_id, 0) and mode = p_mode;
  end if;
  -- zones: existing code = edit, new code = added at the end
  for z in select * from jsonb_array_elements(coalesce(p_zones, '[]'::jsonb)) loop
    zm := public.zone_map_row(p_scope_type, p_scope_id, p_mode);
    za := public.zone_by_code(p_scope_type, p_scope_id, p_mode, z->>'code');
    perform public.admin_zone_upsert(p_scope_type, p_scope_id, p_mode, za, z->>'code', z->>'name', z->>'color',
      case when jsonb_typeof(z->'countries') = 'array' and jsonb_array_length(z->'countries') > 0 then array(select jsonb_array_elements_text(z->'countries')) else null end, p_reason);
    n_z := n_z + 1;
  end loop;
  -- the matrix (valid both ways: from/to and to/from are the same cell)
  if jsonb_array_length(coalesce(p_cells, '[]'::jsonb)) > 0 then
    tid := public.admin_ensure_schedule(p_scope_type, p_scope_id, p_kind);
    update public.rate_tables set zones = public.zone_total(p_scope_type, p_scope_id, p_mode) where id = tid;
    zm := public.zone_map_row(p_scope_type, p_scope_id, p_mode);
    for c in select * from jsonb_array_elements(p_cells) loop
      za := public.zone_by_code(p_scope_type, p_scope_id, p_mode, c->>'from');
      zb := public.zone_by_code(p_scope_type, p_scope_id, p_mode, c->>'to');
      if za is null or zb is null then raise exception 'Rate_Matrix uses the zone code % which is not in the Zones sheet or the scope.', coalesce(case when za is null then c->>'from' end, c->>'to'); end if;
      k := least(za, zb) || '-' || greatest(za, zb);
      v := case when jsonb_typeof(c->'rate') = 'number' then (c->>'rate')::numeric else null end;
      if seen ? k and (seen->>k) is distinct from v::text then n_conf := n_conf + 1; v := greatest(v, (seen->>k)::numeric); end if;
      seen := seen || jsonb_build_object(k, v);
      if v is null then
        delete from public.rate_cells where table_id = tid and zone_a = least(za, zb) and zone_b = greatest(za, zb); n_x := n_x + 1;
      else
        if v < 0 then raise exception 'negative rate for % / %', c->>'from', c->>'to'; end if;
        insert into public.rate_cells(table_id, zone_a, zone_b, permille) values (tid, least(za, zb), greatest(za, zb), v)
        on conflict (table_id, zone_a, zone_b) do update set permille = excluded.permille;
        n_r := n_r + 1;
      end if;
    end loop;
  end if;
  insert into public.audit_log(user_id, user_name, entity, entity_id, summary, reason)
  values (auth.uid(), coalesce(me.full_name, me.email), 'rating_import', p_scope_type || coalesce(':' || p_scope_id, ''),
          'Excel import (' || case when p_overwrite then 'overwrite' else 'merge' end || ', ' || p_mode || coalesce(', ' || tid, '') || '): ' || n_z || ' zone(s), ' || n_r || ' rate(s), ' || n_x || ' referral(s)', trim(p_reason));
  return jsonb_build_object('zones', n_z, 'rates', n_r, 'refer', n_x, 'conflicts', n_conf, 'schedule', tid);
end $$;
grant execute on function public.admin_import_rating(text, bigint, text, text, jsonb, jsonb, boolean, text) to authenticated;

-- read-only views with the names of the colleague's data model
drop view if exists public.rating_zones;
create view public.rating_zones with (security_invoker = true) as
  select m.scope_type, m.scope_id, m.mode, g.z as zone_no, coalesce(m.codes->>g.z::text, 'Z' || g.z) as zone_code,
         coalesce(m.labels->>g.z::text, 'Zone ' || g.z) as zone_name, m.colors->>g.z::text as color_hex,
         array(select cz.iso2 from public.country_zones cz where cz.scope_type = m.scope_type and coalesce(cz.scope_id, 0) = coalesce(m.scope_id, 0)
                and (case m.mode when 'sea' then cz.sea_zone else cz.air_zone end) = g.z order by cz.iso2) as countries
    from public.zone_maps m, generate_series(1, public.zone_total(m.scope_type, m.scope_id, m.mode)) g(z);
grant select on public.rating_zones to authenticated;
drop view if exists public.rate_schedules;
create view public.rate_schedules with (security_invoker = true) as
  select t.id as schedule_id, t.scope_type, t.scope_id, t.kind, t.name, t.mode, t.zones, t.min_premium,
         c.zone_a as from_zone, c.zone_b as to_zone, c.permille as rate_permille
    from public.rate_tables t left join public.rate_cells c on c.table_id = t.id;
grant select on public.rate_schedules to authenticated;

-- ---------------------------------------------------------------------
-- access
-- ---------------------------------------------------------------------
alter table public.document_templates enable row level security;
drop policy if exists staff_read on public.document_templates;
drop policy if exists role_write on public.document_templates;
create policy staff_read on public.document_templates for select to authenticated using (public.is_admin());
create policy role_write on public.document_templates for all to authenticated using (public.has_role('admin')) with check (public.has_role('admin'));
drop trigger if exists document_templates_no_dashes on public.document_templates;
create trigger document_templates_no_dashes before insert or update on public.document_templates for each row execute function public.no_dashes();
-- staff with the placing role may switch certificates for a client (customers are written by placing)

notify pgrst, 'reload schema';
