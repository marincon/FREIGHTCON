-- =====================================================================
-- FREIGHTCON by MARINCON - update 2026-11-17 y
--  1  templates: Quotation templates join Templates & Matrices; every template
--     type (quotation, e-mail, insurer, certificate, cover note) gets the level
--     "Client group" (policy -> client -> client group -> general)
--  2  quotations / cases remember the quotation template they were built from
--  3  policy <-> office applicability (policy_offices)
--  4  "External invoice value required" on client group, client, policy and user
--     (most specific wins, default mandatory); rate-only indications without value
--  5  client requests "on behalf of" another office / policy of the own company
--  6  policy limits: FX table, limit check with conveyance / on deck / post limits,
--     limit_exceeded flag on cases and quotations
--  7  policy deductibles (main / condition-specific) and clause <-> deductible links
-- Run after update_2026-11-16x.sql. Safe to run more than once.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1  template levels: client group everywhere
-- ---------------------------------------------------------------------
alter table public.text_templates drop constraint if exists text_templates_scope_type_check;
alter table public.text_templates add constraint text_templates_scope_type_check check (scope_type in ('one_off_general','client_group','customer','policy'));
alter table public.text_formatting drop constraint if exists text_formatting_scope_type_check;
alter table public.text_formatting add constraint text_formatting_scope_type_check check (scope_type in ('one_off_general','client_group','customer','policy'));
alter table public.document_templates drop constraint if exists document_templates_scope_type_check;
alter table public.document_templates add constraint document_templates_scope_type_check check (scope_type in ('one_off_general','client_group','customer','policy'));

-- the quotation templates (parent structure of a quotation) as their own view
drop view if exists public.quotation_templates;
create view public.quotation_templates with (security_invoker = true) as
  select id, scope_type, scope_id, name, body, active, updated_by, updated_at
    from public.text_templates where kind = 'quotation';
grant select on public.quotation_templates to authenticated;

-- deleting a client group removes its templates
create or replace function public.group_templates_cleanup() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  delete from public.text_templates     where scope_type = 'client_group' and scope_id = old.id;
  delete from public.text_formatting    where scope_type = 'client_group' and scope_id = old.id;
  delete from public.document_templates where scope_type = 'client_group' and scope_id = old.id;
  return old;
end $$;
drop trigger if exists client_groups_templates_cleanup on public.client_groups;
create trigger client_groups_templates_cleanup after delete on public.client_groups for each row execute function public.group_templates_cleanup();

-- ---------------------------------------------------------------------
-- 2  quotation template of a quotation / case
-- ---------------------------------------------------------------------
alter table public.quotations  add column if not exists quotation_template_id bigint references public.text_templates(id) on delete set null;
alter table public.indications add column if not exists quotation_template_id bigint references public.text_templates(id) on delete set null;

create or replace function public.quotations_template_link() returns trigger
language plpgsql security definer set search_path = public as $$
declare t bigint;
begin
  if new.data ? 'templateId' then
    t := nullif(new.data->>'templateId', '')::bigint;
    if t is not null and not exists (select 1 from public.text_templates where id = t and kind = 'quotation') then t := null; end if;
    new.quotation_template_id := t;
  end if;
  return new;
end $$;
drop trigger if exists quotations_template_link on public.quotations;
create trigger quotations_template_link before insert or update of data on public.quotations for each row execute function public.quotations_template_link();

create or replace function public.quotations_template_case() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.quotation_template_id is not null then
    update public.indications set quotation_template_id = new.quotation_template_id
     where id = new.indication_id and quotation_template_id is distinct from new.quotation_template_id;
  end if;
  return null;
end $$;
drop trigger if exists quotations_template_case on public.quotations;
create trigger quotations_template_case after insert or update of quotation_template_id on public.quotations for each row execute function public.quotations_template_case();

-- ---------------------------------------------------------------------
-- 3  policy <-> office applicability
-- ---------------------------------------------------------------------
create table if not exists public.policy_offices (
  policy_id bigint not null references public.policies(id) on delete cascade,
  office_id bigint not null references public.offices(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (policy_id, office_id)
);
create index if not exists policy_offices_office on public.policy_offices(office_id);
insert into public.policy_offices(policy_id, office_id)
  select policy_id, id from public.offices where policy_id is not null
  on conflict do nothing;
alter table public.policy_offices enable row level security;
drop policy if exists staff_read on public.policy_offices;
drop policy if exists role_write on public.policy_offices;
create policy staff_read on public.policy_offices for select to authenticated using (public.is_admin());
create policy role_write on public.policy_offices for all to authenticated using (public.has_role('placing')) with check (public.has_role('placing'));

-- the primary subcategory of an office always applies to it
create or replace function public.offices_policy_link() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.policy_id is not null then
    insert into public.policy_offices(policy_id, office_id) values (new.policy_id, new.id) on conflict do nothing;
  end if;
  return null;
end $$;
drop trigger if exists offices_policy_link on public.offices;
create trigger offices_policy_link after insert or update of policy_id on public.offices for each row execute function public.offices_policy_link();

-- an office without any mapping is open to every subcategory of its client
create or replace function public.policy_applies_to_office(p_pol bigint, p_ofc bigint) returns boolean
language sql stable security definer set search_path = public as $$
  select p_pol is null or p_ofc is null
      or not exists (select 1 from public.policy_offices where office_id = p_ofc)
      or exists (select 1 from public.policy_offices where office_id = p_ofc and policy_id = p_pol)
$$;
grant execute on function public.policy_applies_to_office(bigint, bigint) to authenticated;

-- ---------------------------------------------------------------------
-- 4  external invoice value required (group -> client -> policy -> user)
-- ---------------------------------------------------------------------
alter table public.client_groups add column if not exists external_invoice_value_mode text not null default 'mandatory';
alter table public.customers     add column if not exists external_invoice_value_mode text not null default 'inherit';
alter table public.policies      add column if not exists external_invoice_value_mode text not null default 'inherit';
alter table public.profiles      add column if not exists external_invoice_value_mode text not null default 'inherit';
alter table public.client_groups drop constraint if exists client_groups_ivm_check;
alter table public.client_groups add constraint client_groups_ivm_check check (external_invoice_value_mode in ('mandatory','optional'));
alter table public.customers drop constraint if exists customers_ivm_check;
alter table public.customers add constraint customers_ivm_check check (external_invoice_value_mode in ('inherit','mandatory','optional'));
alter table public.policies drop constraint if exists policies_ivm_check;
alter table public.policies add constraint policies_ivm_check check (external_invoice_value_mode in ('inherit','mandatory','optional'));
alter table public.profiles drop constraint if exists profiles_ivm_check;
alter table public.profiles add constraint profiles_ivm_check check (external_invoice_value_mode in ('inherit','mandatory','optional'));

-- client groups can carry the rate / premium display too (policy -> client -> client group -> configuration)
alter table public.client_groups add column if not exists quote_display_mode text;
alter table public.client_groups drop constraint if exists client_groups_display_mode_check;
alter table public.client_groups add constraint client_groups_display_mode_check check (quote_display_mode is null or quote_display_mode in ('rate_only','premium_only','both'));

-- internal: the resolved mode for a user (and the policy the request is declared under)
create or replace function public.invoice_value_mode_of(p_user uuid, p_policy bigint default null) returns text
language plpgsql stable security definer set search_path = public as $$
declare pr public.profiles; po public.policies; cu public.customers; gr public.client_groups; v_pol bigint := p_policy;
begin
  select * into pr from public.profiles where id = p_user;
  if v_pol is null and pr.office_id is not null then select policy_id into v_pol from public.offices where id = pr.office_id; end if;
  if v_pol is not null then select * into po from public.policies where id = v_pol; end if;
  select * into cu from public.customers where id = coalesce(po.customer_id, public.user_customer_id(p_user));
  select * into gr from public.client_groups where id = coalesce(cu.group_id, pr.group_id);
  return coalesce(nullif(pr.external_invoice_value_mode, 'inherit'), nullif(po.external_invoice_value_mode, 'inherit'),
                  nullif(cu.external_invoice_value_mode, 'inherit'), gr.external_invoice_value_mode, 'mandatory');
end $$;
revoke execute on function public.invoice_value_mode_of(uuid, bigint) from public, anon, authenticated;

-- callable: a client for itself, staff for anybody
create or replace function public.resolve_invoice_value_requirement(p_user uuid default null, p_policy bigint default null) returns text
language plpgsql stable security definer set search_path = public as $$
declare v_user uuid := coalesce(p_user, auth.uid());
begin
  if auth.uid() is null then raise exception 'not authorised'; end if;
  if v_user <> auth.uid() and not public.is_admin() then raise exception 'not authorised'; end if;
  if p_policy is not null and not public.is_admin()
     and not exists (select 1 from public.policies where id = p_policy and customer_id = public.user_customer_id(v_user)) then
    raise exception 'not authorised';
  end if;
  return public.invoice_value_mode_of(v_user, p_policy);
end $$;
grant execute on function public.resolve_invoice_value_requirement(uuid, bigint) to authenticated;

-- cases without an invoice value (rate-only indications / requests "or about")
alter table public.indications alter column invoice_value drop not null;
alter table public.indications drop constraint if exists indications_invoice_value_check;
alter table public.indications add constraint indications_invoice_value_check check (invoice_value is null or invoice_value > 0);

-- ---------------------------------------------------------------------
-- 6a FX table (units per 1 EUR) and conversion
-- ---------------------------------------------------------------------
insert into public.settings(key, value)
  select 'fx_rates', '{"EUR": 1, "USD": 1.08, "GBP": 0.85, "SGD": 1.45}'::jsonb
   where not exists (select 1 from public.settings where key = 'fx_rates');

create or replace function public.fx_convert(p_amount numeric, p_from text, p_to text) returns numeric
language plpgsql stable security definer set search_path = public as $$
declare fx jsonb := coalesce(public.setting('fx_rates'), '{}'::jsonb); a numeric; b numeric;
begin
  if p_amount is null then return null; end if;
  if p_from is null or p_to is null or upper(p_from) = upper(p_to) then return p_amount; end if;
  a := nullif(fx->>upper(p_from), '')::numeric; b := nullif(fx->>upper(p_to), '')::numeric;
  if a is null or b is null or a <= 0 or b <= 0 then return p_amount; end if;
  return round(p_amount / a * b, 2);
end $$;
grant execute on function public.fx_convert(numeric, text, text) to authenticated;

-- ---------------------------------------------------------------------
-- 6b policy limit check
-- ---------------------------------------------------------------------
create or replace function public.policy_limit_check(p_pol bigint, p_sum numeric, p_cur text, p_deck boolean, p_post boolean) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare po public.policies; v_type text; v_limit numeric; v_conv numeric;
begin
  if p_pol is null or p_sum is null or p_sum <= 0 then return null; end if;
  select * into po from public.policies where id = p_pol;
  if not found then return null; end if;
  if coalesce(p_deck, false) then v_type := 'on_deck_barge'; v_limit := coalesce(po.limit_on_deck, po.limit_conveyance);
  elsif coalesce(p_post, false) then v_type := 'parcel_post'; v_limit := coalesce(po.limit_post, po.limit_conveyance);
  else v_type := 'conveyance'; v_limit := po.limit_conveyance; end if;
  if v_limit is null then return null; end if;
  v_conv := public.fx_convert(p_sum, p_cur, po.currency);
  return jsonb_build_object('exceeded', v_conv > v_limit, 'limit_type', v_type, 'limit', v_limit, 'policy_currency', po.currency,
                            'policy_id', po.id, 'policy_no', po.policy_no, 'sum_insured', p_sum, 'currency', upper(p_cur), 'sum_in_policy_currency', v_conv);
end $$;
grant execute on function public.policy_limit_check(bigint, numeric, text, boolean, boolean) to authenticated;

alter table public.indications add column if not exists limit_exceeded boolean not null default false;
alter table public.indications add column if not exists limit_exceeded_details jsonb;
alter table public.quotations  add column if not exists limit_exceeded boolean not null default false;
alter table public.quotations  add column if not exists limit_exceeded_details jsonb;

create or replace function public.indications_limit() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_pol bigint; x jsonb;
begin
  v_pol := case when coalesce(new.is_standalone_one_off, false) then null
                else coalesce(new.policy_id, new.declared_policy_id, (select policy_id from public.offices where id = new.office_id)) end;
  x := public.policy_limit_check(v_pol, new.sum_insured, new.currency, new.on_deck, coalesce((new.details->>'post_courier')::boolean, false));
  new.limit_exceeded := coalesce((x->>'exceeded')::boolean, false);
  new.limit_exceeded_details := case when new.limit_exceeded then x end;
  return new;
end $$;
drop trigger if exists indications_limit on public.indications;
create trigger indications_limit before insert or update of sum_insured, currency, on_deck, details, policy_id, declared_policy_id, office_id, is_standalone_one_off
  on public.indications for each row execute function public.indications_limit();

create or replace function public.quotations_limit() returns trigger
language plpgsql security definer set search_path = public as $$
declare r public.indications; v_pol bigint; x jsonb;
begin
  select * into r from public.indications where id = new.indication_id;
  v_pol := case when coalesce(r.is_standalone_one_off, false) then null
                else coalesce(r.policy_id, r.declared_policy_id, (select policy_id from public.offices where id = r.office_id)) end;
  x := public.policy_limit_check(v_pol, coalesce(nullif(new.data->>'sumInsured', '')::numeric, r.sum_insured), coalesce(new.data->>'currency', r.currency),
                                 r.on_deck, coalesce((r.details->>'post_courier')::boolean, false));
  new.limit_exceeded := coalesce((x->>'exceeded')::boolean, false);
  new.limit_exceeded_details := case when new.limit_exceeded then x end;
  return new;
end $$;
drop trigger if exists quotations_limit on public.quotations;
create trigger quotations_limit before insert or update of data on public.quotations for each row execute function public.quotations_limit();

-- existing cases and quotations (the "last updated" time of a case stays as it is)
alter table public.indications disable trigger indications_touch;
update public.indications set sum_insured = sum_insured where policy_id is not null or declared_policy_id is not null or office_id is not null;
alter table public.indications enable trigger indications_touch;
update public.quotations set data = data;

-- ---------------------------------------------------------------------
-- 4b / 6c rate_core: rate-only without invoice value; limits in the policy currency incl. parcel post
-- ---------------------------------------------------------------------
do $$
declare d text; o text; n text;
begin
  d := pg_get_functiondef('public.rate_core(jsonb, uuid, bigint, bigint, bigint)'::regprocedure);
  if position('v_noval' in d) = 0 then
    o := 'v_si numeric; v_rate numeric;';
    if position(o in d) = 0 then raise exception 'rate_core: declaration not found'; end if;
    d := replace(d, o, 'v_noval boolean := false; v_si numeric; v_rate numeric;');
    o := 'if v_inv is null or v_inv <= 0 or v_inv > 1000000000 then raise exception ''invalid invoice value''; end if;';
    if position(o in d) = 0 then raise exception 'rate_core: invoice check not found'; end if;
    n := 'if v_inv is null or v_inv <= 0 then
    -- rate-only: staff asking for a rate, or a client whose invoice value is optional
    if v_inv is null and ((public.is_admin() and coalesce((p->>''rate_only'')::boolean, false))
       or (p_prof is not null and public.invoice_value_mode_of(p_prof, p_pol) = ''optional'')) then v_inv := 0; v_noval := true;
    else raise exception ''invalid invoice value''; end if;
  end if;
  if v_inv > 1000000000 then raise exception ''invalid invoice value''; end if;';
    d := replace(d, o, n);
    o := '''n'', jsonb_build_object(''conveyance'', v_conv, ''cover'', v_cover, ''currency'', v_cur, ''invoice_value'', v_inv,';
    if position(o in d) = 0 then raise exception 'rate_core: output not found'; end if;
    d := replace(d, o, '''rate_only'', v_noval, ''n'', jsonb_build_object(''conveyance'', v_conv, ''cover'', v_cover, ''currency'', v_cur, ''invoice_value'', case when v_noval then null else v_inv end, ''value_stated'', not v_noval,');
    o := '''status'', v_status, ''reasons'', to_jsonb(v_reasons), ''notes'', to_jsonb(v_notes),';
    if position(o in d) = 0 then raise exception 'rate_core: notes not found'; end if;
    d := replace(d, o, '''status'', v_status, ''reasons'', to_jsonb(v_reasons), ''notes'', to_jsonb(case when v_noval then array_append(v_notes, ''Invoice value not stated - rate-only indication''::text) else v_notes end),');
  end if;
  if position('limit_post' in d) = 0 then
    o := 'v_limit := case when v_deck then coalesce(pol.limit_on_deck, pol.limit_conveyance) else pol.limit_conveyance end;';
    if position(o in d) = 0 then raise exception 'rate_core: limit not found'; end if;
    d := replace(d, o, 'v_limit := case when v_deck then coalesce(pol.limit_on_deck, pol.limit_conveyance) when coalesce((v_details->>''post_courier'')::boolean, false) then coalesce(pol.limit_post, pol.limit_conveyance) else pol.limit_conveyance end;');
    o := 'if v_limit is not null and v_si > v_limit then
      v_reasons := array_append(v_reasons, ''Sum insured above the limit of your open cover';
    if position(o in d) = 0 then raise exception 'rate_core: limit check not found'; end if;
    d := replace(d, o, 'if v_limit is not null and public.fx_convert(v_si, v_cur, pol.currency) > v_limit then
      v_reasons := array_append(v_reasons, ''Sum insured above the limit of your open cover');
    o := '(case when v_deck then '' on deck / barge'' else '' any one conveyance'' end)';
    if position(o in d) > 0 then
      d := replace(d, o, '(case when v_deck then '' on deck / barge'' when coalesce((v_details->>''post_courier'')::boolean, false) then '' parcel post / mail'' else '' any one conveyance'' end)');
    end if;
  end if;
  execute d;
end $$;

-- ---------------------------------------------------------------------
-- 5  client requests on behalf of another office / policy of the own company
-- ---------------------------------------------------------------------
alter table public.indications add column if not exists requested_policy_id bigint references public.policies(id) on delete set null;
alter table public.indications add column if not exists requested_office_id bigint references public.offices(id) on delete set null;
alter table public.indications add column if not exists is_on_behalf_of boolean not null default false;

create or replace function public.calc_indication(p jsonb)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare prof public.profiles; ofc public.offices; pol public.policies; cust public.customers; grp public.client_groups;
  v_cust bigint; v_office bigint := nullif(p->>'office_id', '')::bigint; v_type text; v_hide boolean; r1 jsonb; r2 jsonb; r public.indications;
  v_on boolean := coalesce((p->>'on_behalf')::boolean, false); v_req_pol bigint := nullif(p->>'policy_id', '')::bigint; v_sa boolean;
begin
  select * into prof from public.profiles where id = auth.uid();
  if not found or not prof.approved or prof.rejected or not prof.is_active then raise exception 'not authorised'; end if;
  if coalesce((public.setting('maintenance'))::text::boolean, false) and not prof.is_admin then raise exception 'maintenance'; end if;
  v_sa := v_on and coalesce((p->>'standalone')::boolean, false);

  v_cust := public.user_customer_id(prof.id);
  if v_office is null and not v_on then v_office := prof.office_id; end if;
  if v_office is not null then
    select * into ofc from public.offices where id = v_office and active;
    if not found then raise exception 'invalid office'; end if;
    if not prof.is_admin and ofc.customer_id is distinct from v_cust then raise exception 'invalid office'; end if;
    v_cust := ofc.customer_id;
  end if;
  select * into cust from public.customers where id = v_cust;
  select * into grp from public.client_groups where id = coalesce(cust.group_id, prof.group_id);
  v_type := coalesce(prof.cover_type, cust.cover_type, 'one_off');
  if v_type in ('open_cover','policy') and not v_sa then
    if v_on and v_req_pol is not null then
      -- another subcategory of the own company only (never one of another client)
      select * into pol from public.policies where id = v_req_pol and active and customer_id = cust.id;
      if not found then raise exception 'invalid policy'; end if;
      if ofc.id is not null and not public.policy_applies_to_office(pol.id, ofc.id) then raise exception 'the office is not covered by the selected policy'; end if;
    else
      if ofc.id is null and not v_on and exists (select 1 from public.offices where customer_id = cust.id and active) then raise exception 'office required'; end if;
      if ofc.policy_id is not null then select * into pol from public.policies where id = ofc.policy_id;
      else select * into pol from public.policies where customer_id = cust.id and active order by sort, id limit 1; end if;
    end if;
  end if;
  -- staff decide: policy -> client -> client group (clients can never switch this)
  v_hide := cust.id is not null and not coalesce(pol.show_premium, cust.show_premium, grp.show_premium, true) and not prof.is_admin;

  if not v_sa and (pol.id is not null or (cust.id is not null and v_type <> 'one_off')) then
    -- under the policy, or under the client configuration when the client has no policy
    r1 := public.rate_core(p, prof.id, ofc.id, pol.id, cust.id);
    if (r1->>'out_of_cover')::boolean then r2 := public.rate_core(p, prof.id, ofc.id, null, null); end if;
  else
    r1 := public.rate_core(p, prof.id, ofc.id, null, null);
  end if;
  r := public.store_indication(p, r1, r2, prof.id, coalesce(ofc.name, cust.name, prof.company), ofc.id, pol.id, cust.id, v_hide,
                               case when p->>'source' = 'upload' then 'upload' else 'form' end, prof.is_admin);
  if v_on then
    update public.indications set is_on_behalf_of = true, requested_policy_id = case when v_sa then null else coalesce(v_req_pol, pol.id) end,
           requested_office_id = ofc.id, is_standalone_one_off = v_sa
     where id = r.id returning * into r;
  end if;
  if v_hide then
    r.ref := public.assign_ref(r.id);
    perform public.emit('quote_request', jsonb_build_object('indication_id', r.id, 'ref', r.ref, 'email', prof.email,
      'name', prof.full_name, 'company', r.company, 'goods', r.goods_description, 'conveyance', r.conveyance,
      'origin', r.origin_country, 'origin_place', r.origin_place, 'dest', r.dest_country, 'dest_place', r.dest_place,
      'vessel', r.vessel, 'incoterm', r.incoterm, 'insured_party', r.insured_party, 'sum_insured', r.sum_insured, 'currency', r.currency,
      'status', coalesce(r2, r1)->>'status', 'premium', (coalesce(r2, r1)->>'net')::numeric,
      'comment', concat_ws('; ', case when r.is_out_of_cover then 'OUT OF COVER' end, case when r.limit_exceeded then 'POLICY LIMIT EXCEEDED' end, case when r.is_on_behalf_of then 'ON BEHALF OF ' || coalesce(ofc.name, 'another policy') end),
      'policy', pol.policy_no, 'office', ofc.name));
    return to_jsonb(r) || jsonb_build_object('origin_name', r1#>>'{n,origin_name}', 'dest_name', r1#>>'{n,dest_name}', 'commodity_name', r1#>>'{n,commodity_name}', 'intake', true);
  end if;
  return to_jsonb(r) || jsonb_build_object('origin_name', r1#>>'{n,origin_name}', 'dest_name', r1#>>'{n,dest_name}', 'commodity_name', r1#>>'{n,commodity_name}',
                                           'deductible_text', r1->'deductible', 'rate_only', coalesce((r1->>'rate_only')::boolean, false))
         || case when prof.is_admin then jsonb_build_object('calc_detail', coalesce(r2, r1)->'detail', 'notes', r1->'notes', 'alerts', coalesce(r2, r1)->'alerts') else '{}'::jsonb end;
end $function$;

-- the client's own organisation: offices, subcategories with limits, applicability, invoice value rule
create or replace function public.my_org()
 returns jsonb
 language plpgsql
 stable security definer
 set search_path to 'public'
as $function$
declare p public.profiles; c public.customers; g public.client_groups; o public.offices; po public.policies; v_type text; v_pol bigint;
begin
  select * into p from public.profiles where id = auth.uid();
  if not found then return null; end if;
  select * into c from public.customers where id = public.user_customer_id(p.id);
  select * into g from public.client_groups where id = coalesce(c.group_id, public.user_group_id(p.id));
  v_type := coalesce(p.cover_type, c.cover_type, 'one_off');
  if p.office_id is not null then select * into o from public.offices where id = p.office_id; select * into po from public.policies where id = o.policy_id; end if;
  v_pol := coalesce(po.id, case when v_type in ('open_cover','policy') then (select id from public.policies where customer_id = c.id and active order by sort, id limit 1) end);
  return jsonb_build_object(
    'cover_type', v_type,
    'customer', case when c.id is null then null else jsonb_build_object('id', c.id, 'name', c.name) end,
    'group', case when g.id is null and c.id is null then null else jsonb_build_object('id', g.id, 'name', coalesce(c.name, g.name),
               'kind', case when v_type in ('open_cover','policy') then 'open_cover' else 'spot' end,
               'show_premium', coalesce(c.show_premium, g.show_premium, true)) end,
    'currencies', to_jsonb(public.allowed_currencies(null, null, c.id)),
    'assigned_policy_id', v_pol,
    'assigned_office_id', o.id,
    'invoice_value_mode', public.invoice_value_mode_of(p.id, v_pol),
    'office', case when o.id is null then null else jsonb_build_object('id', o.id, 'name', o.name, 'location', o.location, 'country', o.country, 'policy_id', o.policy_id,
                'policy', po.name, 'policy_no', po.policy_no, 'currency', po.currency, 'currencies', to_jsonb(public.allowed_currencies(o.id, o.policy_id, c.id))) end,
    'offices', case when c.id is null or v_type = 'one_off' then '[]'::jsonb else coalesce((
        select jsonb_agg(jsonb_build_object('id', x.id, 'name', x.name, 'location', x.location, 'country', x.country, 'kind', x.kind, 'policy_id', x.policy_id,
                                            'policy_ids', coalesce((select jsonb_agg(m.policy_id) from public.policy_offices m where m.office_id = x.id), '[]'::jsonb),
                                            'policy', coalesce(y.name, c.name), 'policy_no', y.policy_no, 'currency', coalesce(y.currency, (public.allowed_currencies(x.id, x.policy_id, c.id))[1]),
                                            'currencies', to_jsonb(public.allowed_currencies(x.id, x.policy_id, c.id)))
                         order by y.sort nulls last, y.id, case x.kind when 'office' then 0 when 'warehouse' then 1 else 2 end, x.sort, x.name)
          from public.offices x left join public.policies y on y.id = x.policy_id
         where x.customer_id = c.id and x.active and (y.id is null or y.active)), '[]'::jsonb) end,
    'policies', case when c.id is null or v_type = 'one_off' then '[]'::jsonb else coalesce((
        select jsonb_agg(jsonb_build_object('id', y.id, 'name', y.name, 'policy_no', y.policy_no, 'currency', y.currency,
                                            'currencies', to_jsonb(public.allowed_currencies(null, y.id, c.id)),
                                            'limit_conveyance', y.limit_conveyance, 'limit_on_deck', y.limit_on_deck, 'limit_post', y.limit_post,
                                            'invoice_value_mode', public.invoice_value_mode_of(p.id, y.id)) order by y.sort, y.id)
          from public.policies y where y.customer_id = c.id and y.active), '[]'::jsonb) end,
    'standalone_allowed', true);
end $function$;

-- FX rates for the client screens (limit warnings in the policy currency)
create or replace function public.public_settings()
 returns jsonb
 language sql
 stable security definer
 set search_path to 'public'
as $function$
  select jsonb_build_object(
    'maintenance',     coalesce(public.setting('maintenance'), 'false'::jsonb),
    'terms_version',   public.setting('terms_version'),
    'uplift_pct',      public.setting('uplift_pct'),
    'deductible_text', public.setting('deductible_text'),
    'brand_name',      public.setting('brand_name'),
    'company_legal',   public.setting('company_legal'),
    'party_roles',     public.setting('party_roles'),
    'fx_rates',        public.setting('fx_rates'),
    'extensions',      jsonb_build_object(
        'hssc', jsonb_build_object('label', public.setting('extensions')#>'{hssc,label}'),
        'liw',  jsonb_build_object('label', public.setting('extensions')#>'{liw,label}', 'deductible', public.setting('extensions')#>'{liw,deductible}')))
$function$;

-- ---------------------------------------------------------------------
-- 7  policy deductibles and clause links
-- ---------------------------------------------------------------------
create table if not exists public.policy_deductibles (
  id bigserial primary key,
  policy_id bigint not null references public.policies(id) on delete cascade,
  deductible_type text not null default 'main' check (deductible_type in ('main','condition')),
  label text not null check (length(trim(label)) between 1 and 120),
  deductible_text text not null check (length(trim(deductible_text)) between 1 and 1000),
  applicable_office_ids bigint[] not null default '{}',
  sort_order integer not null default 100,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists policy_deductibles_policy on public.policy_deductibles(policy_id, sort_order);
alter table public.policy_deductibles enable row level security;
drop policy if exists staff_read on public.policy_deductibles;
drop policy if exists role_write on public.policy_deductibles;
create policy staff_read on public.policy_deductibles for select to authenticated using (public.is_admin());
create policy role_write on public.policy_deductibles for all to authenticated using (public.has_role('placing')) with check (public.has_role('placing'));
drop trigger if exists policy_deductibles_no_dashes on public.policy_deductibles;
create trigger policy_deductibles_no_dashes before insert or update on public.policy_deductibles for each row execute function public.no_dashes();

create table if not exists public.clause_deductible_links (
  id bigserial primary key,
  policy_id bigint not null references public.policies(id) on delete cascade,
  clause_id bigint not null references public.clause_library(id) on delete cascade,
  deductible_id bigint not null references public.policy_deductibles(id) on delete cascade,
  created_at timestamptz not null default now(),
  unique (clause_id, deductible_id)
);
create index if not exists clause_deductible_links_policy on public.clause_deductible_links(policy_id);
alter table public.clause_deductible_links enable row level security;
drop policy if exists staff_read on public.clause_deductible_links;
drop policy if exists role_write on public.clause_deductible_links;
create policy staff_read on public.clause_deductible_links for select to authenticated using (public.is_admin());
create policy role_write on public.clause_deductible_links for all to authenticated using (public.has_role('placing')) with check (public.has_role('placing'));

-- a link always carries the policy of its deductible
create or replace function public.clause_deductible_policy() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  select policy_id into new.policy_id from public.policy_deductibles where id = new.deductible_id;
  if new.policy_id is null then raise exception 'unknown deductible'; end if;
  return new;
end $$;
drop trigger if exists clause_deductible_policy on public.clause_deductible_links;
create trigger clause_deductible_policy before insert or update on public.clause_deductible_links for each row execute function public.clause_deductible_policy();

-- the existing policy and office deductibles become the main deductibles of each policy
insert into public.policy_deductibles(policy_id, deductible_type, label, deductible_text, sort_order)
  select po.id, 'main', 'Standard Policy Deductible', po.currency || ' ' || to_char(po.deductible, 'FM999,999,999,990.00') || ' each and every loss', 10
    from public.policies po
   where po.deductible is not null and not exists (select 1 from public.policy_deductibles d where d.policy_id = po.id);
insert into public.policy_deductibles(policy_id, deductible_type, label, deductible_text, applicable_office_ids, sort_order)
  select o.policy_id, 'main', left('Deductible ' || o.name, 120), po.currency || ' ' || to_char(o.deductible, 'FM999,999,999,990.00') || ' each and every loss', array[o.id], 20
    from public.offices o join public.policies po on po.id = o.policy_id
   where o.deductible is not null and o.deductible is distinct from po.deductible
     and not exists (select 1 from public.policy_deductibles d where d.policy_id = o.policy_id and o.id = any(d.applicable_office_ids));

-- what a quotation offers: the main deductibles (office specific ones replace the general ones)
-- plus the deductibles of the ticked clauses; the others separately
create or replace function public.get_applicable_quote_deductibles(p_policy bigint, p_office bigint default null, p_clause_ids bigint[] default '{}') returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare v_office_main boolean;
begin
  if not public.is_admin() then raise exception 'not authorised'; end if;
  if p_policy is null then return jsonb_build_object('main', '[]'::jsonb, 'selected', '[]'::jsonb, 'unselected', '[]'::jsonb); end if;
  v_office_main := p_office is not null and exists (select 1 from public.policy_deductibles where policy_id = p_policy and active and deductible_type = 'main' and p_office = any(applicable_office_ids));
  return jsonb_build_object(
    'main', coalesce((select jsonb_agg(to_jsonb(d) order by d.sort_order, d.id) from public.policy_deductibles d
       where d.policy_id = p_policy and d.active and d.deductible_type = 'main'
         and (case when v_office_main then p_office = any(d.applicable_office_ids) else cardinality(d.applicable_office_ids) = 0 end)), '[]'::jsonb),
    'selected', coalesce((select jsonb_agg(to_jsonb(d) || jsonb_build_object('clause_ids', x.cids) order by d.sort_order, d.id)
       from public.policy_deductibles d join (select l.deductible_id, jsonb_agg(l.clause_id) cids from public.clause_deductible_links l
                                               where l.policy_id = p_policy and l.clause_id = any(coalesce(p_clause_ids, '{}')) group by l.deductible_id) x on x.deductible_id = d.id
      where d.active and (cardinality(d.applicable_office_ids) = 0 or p_office is null or p_office = any(d.applicable_office_ids))), '[]'::jsonb),
    'unselected', coalesce((select jsonb_agg(to_jsonb(d) || jsonb_build_object('clause_ids', x.cids) order by d.sort_order, d.id)
       from public.policy_deductibles d join (select l.deductible_id, jsonb_agg(l.clause_id) cids from public.clause_deductible_links l
                                               where l.policy_id = p_policy group by l.deductible_id) x on x.deductible_id = d.id
      where d.active and d.deductible_type = 'condition'
        and not exists (select 1 from public.clause_deductible_links l2 where l2.deductible_id = d.id and l2.clause_id = any(coalesce(p_clause_ids, '{}')))), '[]'::jsonb));
end $$;
grant execute on function public.get_applicable_quote_deductibles(bigint, bigint, bigint[]) to authenticated;
