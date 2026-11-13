-- =====================================================================
-- FREIGHTCON update 2026-11-13q - package 1
-- * discounts on the client (customer) basis; users: default as per client / off / special
-- * staff-controlled switches per client: .fdf certificates, direct certificate issuance
-- * certificate header data per client (holder, open policy no., claims contact)
-- * client / assured role (seller, buyer, forwarder, on behalf of ..., other)
-- * standalone one-offs for established clients (linked to the client, rated from the general pool)
-- * direct certificates (case created retroactively)
-- * document attachments on requests (storage bucket request-documents)
-- * no em / en dashes: existing texts cleaned, new texts cleaned by trigger
-- Run after update_2026-11-12p.sql. Safe to run more than once.
-- =====================================================================

-- ---------- clients: discount, certificate switches, certificate header ----------
alter table public.customers add column if not exists discount_pct numeric(5,2) not null default 0;
alter table public.customers add column if not exists discount_notes text;
alter table public.customers add column if not exists fdf_certificate_enabled boolean not null default false;
alter table public.customers add column if not exists direct_certificate_enabled boolean not null default false;
alter table public.customers add column if not exists cert_holder text;
alter table public.customers add column if not exists cert_open_policy text;
alter table public.customers add column if not exists cert_claims_contact text;
do $$ begin
  alter table public.customers add constraint customers_discount_chk check (discount_pct >= 0 and discount_pct < 100);
exception when duplicate_object then null; end $$;
-- clients whose policies issue certificates today keep doing so
update public.customers c set fdf_certificate_enabled = true, direct_certificate_enabled = true
 where exists (select 1 from public.policies p where p.customer_id = c.id and p.certificate)
   and not c.fdf_certificate_enabled;

-- offices belong to the client; deleting a policy keeps them (policy-less operation)
alter table public.offices drop constraint if exists offices_policy_id_fkey;
alter table public.offices add constraint offices_policy_id_fkey foreign key (policy_id) references public.policies(id) on delete set null;

-- ---------- users: discount mode ----------
alter table public.profiles add column if not exists discount_mode text not null default 'default_client';
alter table public.profiles add column if not exists special_discount_pct numeric(5,2);
alter table public.profiles add column if not exists requested_company_name text;
do $$ begin
  alter table public.profiles add constraint profiles_discount_mode_chk check (discount_mode in ('default_client','off','special'));
exception when duplicate_object then null; end $$;
-- a discount that was set on a user so far becomes that user's special discount
update public.profiles set discount_mode = 'special', special_discount_pct = client_discount_pct
 where client_discount_pct > 0 and discount_mode = 'default_client' and special_discount_pct is null;
update public.profiles set requested_company_name = company where requested_company_name is null and company is not null;

-- the company typed at self-registration is kept as typed (staff attach or create the client on approval)
create or replace function public.profiles_requested_company() returns trigger
language plpgsql as $$
begin
  if new.requested_company_name is null then new.requested_company_name := new.company; end if;
  return new;
end $$;
drop trigger if exists profiles_requested_company on public.profiles;
create trigger profiles_requested_company before insert on public.profiles for each row execute function public.profiles_requested_company();

-- discount of a user: off -> 0, special -> own value, else the client's discount
create or replace function public.eff_discount(p_user uuid) returns numeric
language sql stable security definer set search_path = public as $$
  select coalesce((
    select case pr.discount_mode when 'off' then 0
             when 'special' then coalesce(pr.special_discount_pct, 0)
             else coalesce((select c.discount_pct from public.customers c where c.id = public.user_customer_id(pr.id)), 0) end
      from public.profiles pr where pr.id = p_user), 0)
$$;
grant execute on function public.eff_discount(uuid) to authenticated;

-- referrals now grant a special discount
create or replace function public.admin_decide_referral(p_id bigint, p_approve boolean) returns boolean
language plpgsql security definer set search_path = public as $$
declare r public.referrals; v_pct numeric := coalesce((public.setting('referral_discount_pct'))::text::numeric, 5);
begin
  if not public.is_admin() then raise exception 'not authorised'; end if;
  update public.referrals set status = case when p_approve then 'approved' else 'rejected' end, decided_at = now()
   where id = p_id and status = 'pending' returning * into r;
  if not found then return false; end if;
  if p_approve then
    update public.profiles set discount_mode = 'special', special_discount_pct = greatest(coalesce(special_discount_pct, 0), public.eff_discount(id), v_pct),
           client_discount_pct = greatest(client_discount_pct, v_pct)
     where id = r.referrer_id;
  end if;
  return true;
end $$;

create or replace function public.profiles_guard() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() and current_user not in ('postgres','service_role','supabase_admin') then
    if new.is_admin is distinct from old.is_admin or new.approved is distinct from old.approved
       or new.rejected is distinct from old.rejected or new.client_discount_pct is distinct from old.client_discount_pct
       or new.discount_mode is distinct from old.discount_mode or new.special_discount_pct is distinct from old.special_discount_pct
       or new.requested_company_name is distinct from old.requested_company_name
       or new.email is distinct from old.email or new.company is distinct from old.company
       or new.referral_code is distinct from old.referral_code
       or new.group_id is distinct from old.group_id or new.office_id is distinct from old.office_id
       or new.customer_id is distinct from old.customer_id or new.cover_type is distinct from old.cover_type
       or new.is_active is distinct from old.is_active or new.deleted_at is distinct from old.deleted_at
       or new.min_premium_override is distinct from old.min_premium_override
       or new.deductible_override is distinct from old.deductible_override then
      raise exception 'not allowed';
    end if;
  end if;
  return new;
end $$;

-- ---------- client / assured role ----------
insert into public.settings(key, value, note) values ('party_roles', '[
  {"code":"seller","label":"Client is the Seller (Exporter)"},
  {"code":"buyer","label":"Client is the Buyer (Importer)"},
  {"code":"forwarder","label":"Client is the Freight Forwarder"},
  {"code":"obo_seller","label":"Acting on behalf of Seller"},
  {"code":"obo_buyer","label":"Acting on behalf of Buyer"},
  {"code":"obo_owner","label":"Acting on behalf of Cargo Owner / Third Party"},
  {"code":"planner","label":"Shipping Planner / Logistics Coordinator"},
  {"code":"cargo_owner","label":"Cargo Owner"},
  {"code":"charterer","label":"Charterer / Vessel Operator"},
  {"code":"epc","label":"Project Contractor / EPC"},
  {"code":"other","label":"Other (specify role)"}]', 'Client / assured role options (code, label); staff can add more')
on conflict (key) do nothing;
create or replace function public.party_ok(p_code text) returns boolean
language sql stable security definer set search_path = public as $$
  select p_code ~ '^[a-z0-9_]{2,30}$'
     and (p_code in ('seller','buyer','other') or exists (select 1 from jsonb_array_elements(coalesce(public.setting('party_roles'), '[]'::jsonb)) e where e->>'code' = p_code))
$$;
create or replace function public.public_settings() returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'maintenance',     coalesce(public.setting('maintenance'), 'false'::jsonb),
    'terms_version',   public.setting('terms_version'),
    'uplift_pct',      public.setting('uplift_pct'),
    'deductible_text', public.setting('deductible_text'),
    'brand_name',      public.setting('brand_name'),
    'company_legal',   public.setting('company_legal'),
    'party_roles',     public.setting('party_roles'),
    'extensions',      jsonb_build_object(
        'hssc', jsonb_build_object('label', public.setting('extensions')#>'{hssc,label}'),
        'liw',  jsonb_build_object('label', public.setting('extensions')#>'{liw,label}', 'deductible', public.setting('extensions')#>'{liw,deductible}')))
$$;
alter table public.indications drop constraint if exists indications_party_chk;
alter table public.indications add constraint indications_party_chk check (insured_party is null or insured_party ~ '^[a-z0-9_]{2,30}$');
alter table public.indications add column if not exists party_role_other text;

-- ---------- standalone one-offs and direct certificates ----------
alter table public.indications add column if not exists is_standalone_one_off boolean not null default false;
alter table public.indications add column if not exists is_direct_certificate boolean not null default false;

-- rating core: user discount (client / off / special) and the wider role list
create or replace function public.rate_core(p jsonb, p_prof uuid, p_ofc bigint, p_pol bigint, p_cust bigint) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  prof public.profiles; com public.commodities; o_c public.countries; d_c public.countries; o_r public.regions; d_r public.regions;
  tb public.rate_tables; pol public.policies; ofc public.offices; zs record; zo_row public.country_zones; zd_row public.country_zones;
  v_conv     text := p->>'conveyance';
  v_cover    text := coalesce(p->>'cover', 'icc_a');
  v_cur      text := upper(coalesce(p->>'currency', 'EUR'));
  v_inv      numeric := nullif(p->>'invoice_value', '')::numeric;
  v_uplift   numeric;
  v_war      boolean := coalesce((p->>'war_strikes')::boolean, true);
  v_deck     boolean := coalesce((p->>'on_deck')::boolean, false);
  v_interest boolean := coalesce((p->>'interest_only')::boolean, false);
  v_dep      date := nullif(p->>'departure_date', '')::date;
  v_incoterm text := nullif(upper(trim(coalesce(p->>'incoterm', ''))), '');
  v_party    text := nullif(lower(trim(coalesce(p->>'insured_party', ''))), '');
  v_vessel   text := nullif(trim(coalesce(p->>'vessel', '')), '');
  v_hssc     boolean := coalesce((p->>'ext_hssc')::boolean, false);
  v_liw      boolean := coalesce((p->>'ext_liw')::boolean, false);
  v_transit  text[] := '{}';
  v_ins_cc   text := nullif(upper(trim(coalesce(p->>'insured_country', ''))), '');
  v_ftz      boolean := case when p->>'ftz' in ('true','false') then (p->>'ftz')::boolean end;
  v_freight  numeric := coalesce(nullif(p->>'freight_value', '')::numeric, 0);
  v_red      text := coalesce(nullif(p->>'red_sea', ''), 'auto');
  v_details  jsonb := case when jsonb_typeof(p->'details') = 'object' then p->'details' else '{}'::jsonb end;
  v_pack     text := coalesce(nullif(trim(coalesce(p->>'packaging', '')), ''), '');
  v_one_off  boolean;
  v_alerts   jsonb := '[]'::jsonb; v_war_x jsonb := '[]'::jsonb; v_war_names text[] := '{}'; v_bb_pm numeric := 0; v_bb_all boolean := true;
  v_rate_incl numeric; v_net_incl numeric; v_dom_cc text; v_comp text; v_cc text; v_role text; v_wa record; v_touch boolean; v_hit boolean; v_place text;
  v_year int; v_pieces numeric; v_kg numeric; v_store text; v_allowed text[];
  v_ext_pm   numeric := 0; v_hssc_pm numeric := 0; v_liw_pm numeric := 0;
  v_mode text; v_kind text; zo int; zd int; v_band text; v_ocls text;
  v_base numeric; v_cell numeric; v_sched boolean := false;
  f_class numeric; f_cover numeric; f_conv numeric; f_pack numeric; f_deck numeric := 1; f_theft numeric := 1; f_load numeric := 1; f_int numeric := 1;
  v_cargo_pm numeric; v_war_pm numeric := 0; v_crisis numeric := 0; v_total_pm numeric;
  v_si numeric; v_rate numeric; v_gross numeric; v_disc numeric; v_net numeric; v_min numeric; v_limit numeric; v_ded_amt numeric;
  v_min_hit boolean := false; v_status text := 'quoted'; v_reasons text[] := '{}'; v_notes text[] := '{}'; v_cond text; v_detail jsonb; v_ded text;
  c_blocked constant text := 'A route or party in this shipment is outside the cover - checked individually';
  c_hold    constant text := 'Referred to underwriters before cover attaches';
begin
  select * into prof from public.profiles where id = p_prof;
  if p_ofc is not null then select * into ofc from public.offices where id = p_ofc; end if;
  if p_pol is not null then select * into pol from public.policies where id = p_pol; p_cust := coalesce(p_cust, pol.customer_id); end if;
  v_one_off := pol.id is null;
  if v_one_off then p_cust := null; end if;      -- one-offs: general pool only, never a customer's terms
  v_sched := pol.id is not null and pol.rating = 'schedule';
  v_uplift := coalesce(nullif(p->>'uplift_pct', '')::numeric, (public.sset('uplift_pct', p_pol, p_cust))::text::numeric, 10);

  if v_conv not in ('sea_container','sea_breakbulk','air','air_charter','road','rail') then raise exception 'invalid conveyance'; end if;
  if v_cover not in ('icc_a','icc_b','icc_c') then raise exception 'invalid cover'; end if;
  v_allowed := public.allowed_currencies(ofc.id, pol.id, coalesce(pol.customer_id, ofc.customer_id, prof.customer_id));
  if not (v_cur = any(v_allowed)) then raise exception 'currency must be one of %', array_to_string(v_allowed, ', '); end if;
  if v_inv is null or v_inv <= 0 or v_inv > 1000000000 then raise exception 'invalid invoice value'; end if;
  if v_uplift < 0 or v_uplift > 30 then raise exception 'invalid uplift'; end if;
  if length(trim(coalesce(p->>'goods_description', ''))) < 2 then raise exception 'goods description required'; end if;
  if v_incoterm is not null and v_incoterm not in ('EXW','FCA','FAS','FOB','CFR','CIF','CPT','CIP','DAP','DPU','DDP') then raise exception 'invalid incoterm'; end if;
  if v_party is not null and not public.party_ok(v_party) then raise exception 'invalid party'; end if;
  if v_conv not in ('sea_container','sea_breakbulk') then v_vessel := null; end if;
  if v_conv <> 'sea_breakbulk' then v_deck := false; end if;
  if v_freight < 0 or v_freight > 1000000000 then raise exception 'invalid freight'; end if;
  if v_red not in ('auto','yes','no') then raise exception 'invalid routing'; end if;
  if jsonb_typeof(p->'transit_countries') = 'array' then
    select coalesce(array_agg(distinct upper(x)), '{}') into v_transit from jsonb_array_elements_text(p->'transit_countries') x where trim(x) <> '';
  end if;
  if array_length(v_transit, 1) > 8 then raise exception 'too many transit countries'; end if;
  if exists (select 1 from unnest(v_transit) t where not exists (select 1 from public.countries c where c.iso2 = t)) then raise exception 'invalid transit country'; end if;
  if v_ins_cc is not null and not exists (select 1 from public.countries where iso2 = v_ins_cc) then raise exception 'invalid insured country'; end if;
  if length(v_details::text) > 4000 then raise exception 'details too long'; end if;

  com := public.cargo_pick(p->>'commodity_id', p_pol, p_cust);
  if com.id is null or not com.active then raise exception 'invalid commodity'; end if;
  if not com.ext_hssc then v_hssc := false; end if;
  if not com.ext_liw  then v_liw  := false; end if;
  select * into o_c from public.countries where iso2 = upper(p->>'origin_country'); if not found then raise exception 'invalid origin country'; end if;
  select * into d_c from public.countries where iso2 = upper(p->>'dest_country');   if not found then raise exception 'invalid destination country'; end if;
  select * into o_r from public.regions where id = o_c.region_id;
  select * into d_r from public.regions where id = d_c.region_id;
  zs := public.zone_scope(p_pol, p_cust);
  if zs.st is not null then zo_row := public.cz(o_c.iso2, zs.st, zs.sid); zd_row := public.cz(d_c.iso2, zs.st, zs.sid); end if;

  v_si   := round((v_inv + v_freight) * (1 + v_uplift / 100), 2);
  v_mode := case when v_conv in ('air','air_charter') then 'air' when v_conv in ('road','rail') then 'land' else 'sea' end;
  if v_sched and v_mode = 'sea' then v_war := true; end if;   -- war & strikes are part of the sea schedule rates

  v_cond := com.conditions;
  v_cond := regexp_replace(coalesce(v_cond, ''), '\s*Institute Cargo Clauses \([ABC]\)( or \([ABC]\))? only\.', '', 'gi');
  v_cond := regexp_replace(v_cond, 'Excluding heating, sweating, spontaneous combustion, contamination and loss in weight unless caused by an insured peril or covered by an extension\.', 'Excluding contamination unless caused by an insured peril.', 'gi');
  v_cond := nullif(trim(v_cond), '');
  if v_hssc then v_cond := concat_ws(' ', v_cond, coalesce(public.sset('extensions', p_pol, p_cust)#>>'{hssc,clause}', 'Extended to cover heating, sweating and spontaneous combustion.'));
  elsif com.ext_hssc then v_cond := concat_ws(' ', v_cond, 'Excluding heating, sweating and spontaneous combustion unless caused by an insured peril.'); end if;
  if v_liw  then v_cond := concat_ws(' ', v_cond, coalesce(public.sset('extensions', p_pol, p_cust)#>>'{liw,clause}', 'Extended to cover loss in weight / difference in weight (shortage), subject to a deductible of 0.5 % of the sum insured.'));
  elsif com.ext_liw then v_cond := concat_ws(' ', v_cond, 'Excluding loss in weight / difference in weight (shortage) unless caused by an insured peril.'); end if;

  if pol.id is not null then
    v_ded_amt := coalesce(prof.deductible_override, ofc.deductible, pol.deductible);
    v_ded := case when v_ded_amt is null then coalesce(com.deductible, (public.setting('deductible_text'))#>>'{}')
                  else pol.currency || ' ' || to_char(v_ded_amt, 'FM999,999,990.00') || ' each and every loss' end;
  else
    v_ded := coalesce(com.deductible, (public.setting('deductible_text'))#>>'{}');
  end if;
  if v_liw then v_ded := concat_ws('; ', v_ded, 'loss / difference in weight: ' || coalesce(public.sset('extensions', p_pol, p_cust)#>>'{liw,deductible}', '0.5 % of the sum insured')); end if;

  if o_c.sanctioned or d_c.sanctioned or coalesce(o_r.sanctioned, false) or coalesce(d_r.sanctioned, false) then
    v_status := 'sanctioned';
    v_reasons := array['Origin or destination is subject to sanctions - compliance review required'];

  elsif v_sched then
    -- =========== open cover / policy: rates straight from the schedules of this customer / policy ===========
    v_ocls := com.oc_class;
    if v_mode = 'sea' then
      v_kind := case v_ocls when 'new' then 'sea_new' when 'used' then 'sea_used' when 'cars_new' then 'sea_newcars' when 'cars_used' then 'sea_usedcars' when 'household' then 'sea_household' end;
      zo := zo_row.sea_zone; zd := zd_row.sea_zone;
    elsif v_mode = 'air' then
      v_kind := case when v_ocls is null then null when v_conv = 'air' then 'air_freight' else 'air_charter' end;
      zo := zo_row.air_zone; zd := zd_row.air_zone;
    end if;
    if v_kind is not null then tb := public.rt_pick(v_kind, p_pol, p_cust); end if;

    if not pol.active then v_reasons := array_append(v_reasons, 'Your cover is not active - we quote this individually'::text); end if;
    if v_mode = 'land' then
      v_reasons := array_append(v_reasons, 'Road / rail transport on its own is quoted individually'::text);
      v_notes := array_append(v_notes, 'Simple road transport - must ask insurers for rate / terms before quoting'::text);
      if 'SA' in (o_c.iso2, d_c.iso2) then v_notes := array_append(v_notes, 'Road transport in Saudi Arabia only after request / underwriter approval'::text); end if;
    end if;
    if com.on_request then v_reasons := array_append(v_reasons, 'This type of cargo is quoted individually'::text);
    elsif v_mode <> 'land' and v_ocls is null then v_reasons := array_append(v_reasons, 'This cargo is not part of the open cover schedules - quoted individually'::text);
      v_notes := array_append(v_notes, 'Cargo type has no open cover class (Rates → Cargo types of this customer / policy)'::text);
    elsif v_mode <> 'land' and tb.id is null then v_reasons := array_append(v_reasons, 'No schedule for this cargo and conveyance - quoted individually'::text); end if;
    if not (v_cover = any(com.allowed_covers)) or v_cover = 'icc_b' or (v_cover = 'icc_c' and v_mode <> 'sea') then
      v_reasons := array_append(v_reasons, 'The chosen cover is quoted individually under the open cover'::text); end if;
    if zs.st is null and v_mode <> 'land' then v_reasons := array_append(v_reasons, 'No zones set up for this cover - quoted individually'::text);
    else
      if zo is null and v_mode <> 'land' then v_reasons := array_append(v_reasons, ('Shipments from ' || o_c.name || ' are checked with underwriters individually')::text); end if;
      if zd is null and v_mode <> 'land' then v_reasons := array_append(v_reasons, ('Shipments to ' || d_c.name || ' are checked with underwriters individually')::text); end if;
    end if;
    if o_c.on_request or coalesce(o_r.on_request, false) then v_reasons := array_append(v_reasons, ('Shipments from ' || o_c.name || ' are quoted individually')::text); end if;
    if d_c.on_request or coalesce(d_r.on_request, false) then v_reasons := array_append(v_reasons, ('Shipments to ' || d_c.name || ' are quoted individually')::text); end if;
    if v_deck and (tb.id is null or not tb.deck_allowed) then v_reasons := array_append(v_reasons, 'On-deck shipment of this cargo is quoted individually'::text); end if;
    if v_interest and (tb.id is null or not tb.contingency_allowed) then v_reasons := array_append(v_reasons, 'Seller''s / buyer''s interest cover for this cargo is quoted individually'::text); end if;
    if v_mode = 'air' and v_ocls = 'household' and public.policy_rule(pol.rules, array[v_kind, 'household_permille']) is null then v_reasons := array_append(v_reasons, 'Household goods by this conveyance are quoted individually'::text); end if;
    if v_mode = 'air' and v_ocls = 'cars_used' then v_reasons := array_append(v_reasons, 'Used vehicles by air are quoted individually'::text); end if;
    v_limit := case when v_deck then coalesce(pol.limit_on_deck, pol.limit_conveyance) else pol.limit_conveyance end;
    if v_limit is not null and v_si > v_limit then
      v_reasons := array_append(v_reasons, 'Sum insured above the limit of your open cover - quoted individually'::text);
      v_notes := array_append(v_notes, ('Over policy limit: ' || pol.currency || ' ' || to_char(v_limit, 'FM999,999,999,990') || (case when v_deck then ' on deck / barge' else ' any one conveyance' end))::text);
    end if;
    if v_dep is not null and v_dep < current_date then v_reasons := array_append(v_reasons, 'Departure date / ETA of loading lies in the past - cover cannot be backdated automatically'::text); end if;

    if array_length(v_reasons, 1) is null then
      if v_mode = 'air' and v_ocls = 'household' then
        v_base := public.policy_rule(pol.rules, array[v_kind, 'household_permille']); v_cell := v_base;
      else
        select permille into v_cell from public.rate_cells where table_id = tb.id and zone_a = least(zo, zd) and zone_b = greatest(zo, zd);
        if v_cell is null then v_reasons := array_append(v_reasons, 'No rate for this route in the open cover - quoted individually'::text);
        else v_base := v_cell; end if;
      end if;
    end if;

    if array_length(v_reasons, 1) is not null then
      v_status := 'on_request';
    else
      f_cover := case when v_cover = 'icc_c' then public.policy_rule(pol.rules, array['icc_c_pct']) / 100 else 1 end;
      if v_deck then f_deck := 1 + public.policy_rule(pol.rules, array['deck_loading_pct']) / 100; end if;
      if v_mode = 'air' and v_ocls = 'used' then f_load := 1 + coalesce(public.policy_rule(pol.rules, array[v_kind, 'used_pct']), 0) / 100; end if;
      if v_mode = 'air' and v_ocls = 'cars_new' then f_load := 1 + coalesce(public.policy_rule(pol.rules, array[v_kind, 'cars_pct']), 0) / 100; end if;
      if v_interest then f_int := public.policy_rule(pol.rules, array['interest_pct']) / 100; end if;
      v_cargo_pm := v_base * f_cover * f_deck * f_load;
      if v_mode = 'air' and v_war then v_war_pm := public.policy_rule(pol.rules, array['air_war_permille']); end if;
      if v_war then v_crisis := greatest(o_c.crisis_permille, d_c.crisis_permille); end if;
      if v_hssc then v_hssc_pm := coalesce((public.sset('extensions', p_pol, p_cust)#>>'{hssc,permille}')::numeric, 0.15); end if;
      if v_liw  then v_liw_pm  := coalesce((public.sset('extensions', p_pol, p_cust)#>>'{liw,permille}')::numeric, 0.75); end if;
      v_ext_pm := v_hssc_pm + v_liw_pm;
      v_total_pm := (v_cargo_pm + v_ext_pm + v_war_pm + v_crisis) * f_int;
      v_rate  := round(v_total_pm / 10, 4);
      v_gross := round(v_si * v_rate / 100, 2);
      v_disc  := public.eff_discount(prof.id);
      v_net   := round(v_gross * (1 - v_disc / 100), 2);
      v_min   := coalesce(prof.min_premium_override, ofc.min_premium, pol.min_premium, 0);
      if v_net < v_min then v_net := v_min; v_min_hit := true; end if;
      v_detail := jsonb_build_object(
        'scheme', 'open_cover', 'policy_no', pol.policy_no, 'policy', pol.name, 'office', ofc.name, 'scope', tb.scope_type,
        'mode', v_mode, 'table', tb.id, 'table_name', tb.name, 'zone_from', zo, 'zone_to', zd,
        'schedule_permille', v_cell, 'base_permille', round(v_base, 4), 'war_included_permille', case when v_mode = 'sea' then tb.war_included_permille else 0 end,
        'f_cover', f_cover, 'f_deck', f_deck, 'f_loading', f_load, 'f_interest', f_int,
        'factor', round(f_cover * f_deck * f_load, 4), 'cargo_permille', round(v_cargo_pm, 4),
        'war_permille', v_war_pm, 'crisis_permille', v_crisis, 'hssc_permille', v_hssc_pm, 'liw_permille', v_liw_pm,
        'rate_permille', round(v_total_pm, 4), 'min_premium', v_min, 'deductible', v_ded_amt, 'currency', v_cur);
    end if;

  else
    -- =========== standard FREIGHTCON rating (one-off pool, or a policy rated the standard way) ===========
    if v_mode = 'sea' then
      v_kind := com.sea_table; zo := zo_row.sea_zone; zd := zd_row.sea_zone;
    elsif v_mode = 'air' then
      v_kind := case when com.air_class is null then null when v_conv = 'air' then 'air_freight' else 'air_charter' end; zo := zo_row.air_zone; zd := zd_row.air_zone;
    else
      zo := zo_row.sea_zone; zd := zd_row.sea_zone;
      v_band := case when o_c.iso2 = d_c.iso2 then 'domestic' when zo = zd then 'regional' else 'long_haul' end;
    end if;
    if v_kind is not null then tb := public.rt_pick(v_kind, p_pol, p_cust); end if;

    if com.on_request then v_reasons := array_append(v_reasons, 'This type of cargo is quoted individually'::text);
    elsif v_mode <> 'land' and tb.id is null then v_reasons := array_append(v_reasons, 'This cargo is quoted individually for the chosen conveyance'::text); end if;
    if not (v_cover = any(com.allowed_covers)) then v_reasons := array_append(v_reasons, 'The chosen cover is not available automatically for this cargo'::text); end if;
    if zs.st is null then v_reasons := array_append(v_reasons, 'No zones set up - quoted individually'::text);
    else
      if zo is null then v_reasons := array_append(v_reasons, ('Shipments from ' || o_c.name || ' are checked with underwriters individually')::text); end if;
      if zd is null then v_reasons := array_append(v_reasons, ('Shipments to ' || d_c.name || ' are checked with underwriters individually')::text); end if;
    end if;
    if o_c.local_insurance then v_reasons := array_append(v_reasons, ('Local insurance rules apply in ' || o_c.name || ' - we check this individually')::text); end if;
    if d_c.local_insurance then v_reasons := array_append(v_reasons, ('Local insurance rules apply in ' || d_c.name || ' - we check this individually')::text); end if;
    if o_c.on_request or coalesce(o_r.on_request, false) then v_reasons := array_append(v_reasons, ('Shipments from ' || o_c.name || ' are quoted individually')::text); end if;
    if d_c.on_request or coalesce(d_r.on_request, false) then v_reasons := array_append(v_reasons, ('Shipments to ' || d_c.name || ' are quoted individually')::text); end if;
    if v_deck and (tb.id is null or not tb.deck_allowed or com.id in ('vehicles_new','vehicles_used','household','reefer','pharma','electronics')) then
      v_reasons := array_append(v_reasons, 'On-deck shipment of this cargo is quoted individually'::text); end if;
    if v_mode = 'land' and o_c.iso2 <> d_c.iso2 and zo is not null and zd is not null and zo <> zd
       and not exists (select 1 from jsonb_each(coalesce(public.sset('land_groups', p_pol, p_cust), '{}'::jsonb)) g
                        where g.value @> to_jsonb(zo) and g.value @> to_jsonb(zd)) then
      v_reasons := array_append(v_reasons, ('No road / rail connection between ' || o_c.name || ' and ' || d_c.name || ' in our tariff - please choose sea or air, or request a quotation')::text); end if;
    v_limit := coalesce(com.max_sum_insured, (public.sset('auto_limit', p_pol, p_cust)->>v_cur)::numeric);
    if (public.sset('auto_limit', p_pol, p_cust)->>v_cur)::numeric is not null then v_limit := least(v_limit, (public.sset('auto_limit', p_pol, p_cust)->>v_cur)::numeric); end if;
    if pol.id is not null and pol.limit_conveyance is not null then v_limit := least(coalesce(v_limit, pol.limit_conveyance), pol.limit_conveyance); end if;
    if v_limit is not null and v_si > v_limit then v_reasons := array_append(v_reasons, 'Sum insured above the automatic limit for this cargo'::text); end if;
    if v_dep is not null and v_dep < current_date then v_reasons := array_append(v_reasons, 'Departure date / ETA of loading lies in the past - cover cannot be backdated automatically'::text); end if;

    if array_length(v_reasons, 1) is null then
      if v_mode = 'land' then
        v_base := coalesce((public.sset('land_rates', p_pol, p_cust)->>v_band)::numeric, 1);
      else
        select permille into v_cell from public.rate_cells where table_id = tb.id and zone_a = least(zo, zd) and zone_b = greatest(zo, zd);
        if v_cell is null then v_reasons := array_append(v_reasons, 'No rate for this route - quoted individually'::text);
        else v_base := greatest(v_cell - coalesce(tb.war_included_permille, 0), 0); end if;
      end if;
    end if;

    if array_length(v_reasons, 1) is not null then
      v_status := 'on_request';
    else
      f_class := com.class_factor;
      f_cover := coalesce((public.sset('cover_factors', p_pol, p_cust)->>v_cover)::numeric, 1);
      f_conv  := coalesce((public.sset('conveyance_factors', p_pol, p_cust)->>v_conv)::numeric, 1);
      f_pack  := coalesce((public.sset('packing_factors', p_pol, p_cust)->>v_pack)::numeric, (public.sset('packing_factors', p_pol, p_cust)->>'Other')::numeric, 1);
      if v_deck then f_deck := 1 + coalesce((public.sset('deck_loading_pct', p_pol, p_cust))::text::numeric, 50) / 100; end if;
      if v_mode = 'land' and com.theft_attractive then f_theft := coalesce((public.sset('theft_land_factor', p_pol, p_cust))::text::numeric, 1.5); end if;
      f_load := 1 + coalesce(com.loading_pct, 0) / 100;
      if v_interest then f_int := coalesce((public.sset('contingency_factor', p_pol, p_cust))::text::numeric, 0.4); end if;
      v_cargo_pm := v_base * f_class * f_cover * f_conv * f_pack * f_deck * f_theft * f_load;
      if v_war then
        v_war_pm := case v_mode when 'sea'  then coalesce((public.sset('sea_war_permille', p_pol, p_cust))::text::numeric, 0.5)
                                when 'air'  then coalesce((public.sset('air_war_permille', p_pol, p_cust))::text::numeric, 0.5)
                                else coalesce((public.sset('land_strikes_permille', p_pol, p_cust))::text::numeric, 0.1) end;
        if v_mode <> 'land' then v_crisis := greatest(o_c.crisis_permille, d_c.crisis_permille); end if;
      end if;
      if v_hssc then v_hssc_pm := coalesce((public.sset('extensions', p_pol, p_cust)#>>'{hssc,permille}')::numeric, 0.15); end if;
      if v_liw  then v_liw_pm  := coalesce((public.sset('extensions', p_pol, p_cust)#>>'{liw,permille}')::numeric, 0.75); end if;
      v_ext_pm := v_hssc_pm + v_liw_pm;
      v_total_pm := (v_cargo_pm + v_ext_pm + v_war_pm + v_crisis) * f_int;
      v_rate  := round(v_total_pm / 10, 4);
      v_gross := round(v_si * v_rate / 100, 2);
      v_disc  := public.eff_discount(prof.id);
      v_net   := round(v_gross * (1 - v_disc / 100), 2);
      v_min   := case when v_mode = 'land' then coalesce((public.sset('land_min_premium', p_pol, p_cust))::text::numeric, 75) else coalesce(tb.min_premium, 100) end;
      if pol.id is not null then v_min := coalesce(ofc.min_premium, pol.min_premium, v_min); end if;
      if prof.min_premium_override is not null then v_min := prof.min_premium_override; end if;
      if v_net < v_min then v_net := v_min; v_min_hit := true; end if;
      v_detail := jsonb_build_object(
        'scheme', 'standard', 'pool', case when v_one_off then 'one_off_general' else coalesce(tb.scope_type, 'customer') end,
        'mode', v_mode, 'table', tb.id, 'table_name', coalesce(tb.name, 'Land · ' || replace(v_band, '_', '-')), 'band', v_band,
        'zone_from', zo, 'zone_to', zd, 'schedule_permille', v_cell, 'base_permille', round(v_base, 4),
        'f_class', f_class, 'f_cover', f_cover, 'f_conveyance', f_conv, 'f_packing', f_pack, 'f_deck', f_deck, 'f_theft', f_theft, 'f_loading', f_load, 'f_interest', f_int,
        'factor', round(f_class * f_cover * f_conv * f_pack * f_deck * f_theft * f_load, 4),
        'cargo_permille', round(v_cargo_pm, 4), 'war_permille', v_war_pm, 'crisis_permille', v_crisis, 'hssc_permille', v_hssc_pm, 'liw_permille', v_liw_pm,
        'rate_permille', round(v_total_pm, 4), 'min_premium', v_min, 'currency', v_cur);
    end if;
  end if;

  -- ================= country check, war & strikes areas, referral alerts =================
  v_dom_cc := coalesce(v_ins_cc, ofc.country);
  for v_role, v_cc in
      select 'origin', o_c.iso2 union all select 'destination', d_c.iso2
      union all select 'transit', t from unnest(v_transit) t
      union all select 'assured', v_dom_cc where v_dom_cc is not null
  loop
    v_comp := coalesce((public.cz(v_cc, zs.st, zs.sid)).compliance, (public.cz(v_cc, 'one_off_general', null)).compliance, 'ok');
    if v_comp = 'blocked' then
      v_alerts := v_alerts || jsonb_build_object('level', 'red', 'text', 'Blocked / prohibited: ' || (select name from public.countries where iso2 = v_cc) || ' (' || v_role || ')' || case when pol.id is not null then ' - do not quote under the open cover' else '' end);
      if not (c_blocked = any(v_reasons)) then v_reasons := array_append(v_reasons, c_blocked); end if;
    elsif v_comp = 'local' and not (v_cc = 'AE') then
      v_alerts := v_alerts || jsonb_build_object('level', 'amber', 'text', 'Compliance / local licensing: ' || (select name from public.countries where iso2 = v_cc) || ' (' || v_role || ') - check admitted / local insurers');
    elsif v_comp = 'hold' then
      v_alerts := v_alerts || jsonb_build_object('level', 'yellow', 'text', 'Hold covered: ' || (select name from public.countries where iso2 = v_cc) || ' (' || v_role || ') - refer to underwriters prior to attachment');
      if not (c_hold = any(v_reasons)) then v_reasons := array_append(v_reasons, c_hold); end if;
    end if;
  end loop;
  if v_dom_cc = 'AE' then
    if v_ins_cc is null then v_ftz := ofc.ftz; end if;
    if not coalesce(v_ftz, false) then
      v_alerts := v_alerts || jsonb_build_object('level', 'amber', 'text', 'UAE interest ' || case when v_ftz is null then 'with unknown Free Trade Zone status' else 'on the mainland (no FTZ)' end || ' - place with local UAE insurers');
      if pol.id is not null then v_reasons := array_append(v_reasons, 'UAE interests are checked individually'::text); end if;
    end if;
  end if;
  if v_mode = 'sea' then
    for v_wa in
      select distinct on (a.code) a.*, x.buyback_permille, x.ncb_pct
        from public.war_exclusions x join public.war_areas a on a.code = x.area_code
       where x.active and (
             (v_one_off and x.scope_type = 'one_off_general')
          or (not v_one_off and ((x.scope_type = 'policy' and x.scope_id = p_pol) or (x.scope_type = 'customer' and x.scope_id = p_cust))))
       order by a.code, case x.scope_type when 'policy' then 0 when 'customer' then 1 else 2 end
    loop
      v_touch := false;
      if v_wa.kind = 'coast' then
        foreach v_role in array array['o','d'] loop
          v_cc := case v_role when 'o' then o_c.iso2 else d_c.iso2 end;
          v_place := lower(coalesce(case v_role when 'o' then p->>'origin_place' else p->>'dest_place' end, ''));
          if v_cc = v_wa.country then
            v_hit := v_place <> '' and exists (select 1 from unnest(v_wa.ports) pt where v_place like '%' || lower(pt) || '%');
            if v_hit then v_touch := true;
            elsif not exists (select 1 from public.war_areas b, unnest(b.ports) pt where b.country = v_cc and b.code <> v_wa.code and v_place <> '' and v_place like '%' || lower(pt) || '%') then
              v_touch := true;
              if not (v_alerts @> jsonb_build_array(jsonb_build_object('level', 'orange', 'text', 'Port in ' || (select name from public.countries where iso2 = v_cc) || ' not stated or not known - both coasts assumed'))) then
                v_alerts := v_alerts || jsonb_build_object('level', 'orange', 'text', 'Port in ' || (select name from public.countries where iso2 = v_cc) || ' not stated or not known - both coasts assumed'); end if;
            end if;
          end if;
        end loop;
        if v_wa.country = any(v_transit) then v_touch := true; end if;
      else
        if o_c.iso2 = any(v_wa.countries) or d_c.iso2 = any(v_wa.countries) or v_transit && v_wa.countries then v_touch := true; end if;
        if exists (select 1 from unnest(v_wa.ports) pt where lower(coalesce(p->>'origin_place', '') || ' | ' || coalesce(p->>'dest_place', '')) like '%' || lower(pt) || '%') then v_touch := true; end if;
        if v_wa.code = 'red_sea' then
          if v_red = 'yes' then v_touch := true;
          elsif v_red = 'auto' and ((public.suez_side(o_c.iso2) = 'w' and public.suez_side(d_c.iso2) = 'e') or (public.suez_side(o_c.iso2) = 'e' and public.suez_side(d_c.iso2) = 'w')) then
            v_touch := true;
            v_alerts := v_alerts || jsonb_build_object('level', 'orange', 'text', 'Routing not stated - Suez / Red Sea assumed for this trade lane');
          end if;
        end if;
      end if;
      if v_touch then
        v_war_names := array_append(v_war_names, v_wa.name);
        v_war_x := v_war_x || jsonb_build_object('code', v_wa.code, 'name', v_wa.name, 'buyback_permille', v_wa.buyback_permille, 'ncb_pct', v_wa.ncb_pct,
                     'net_permille', case when v_wa.buyback_permille is null then null else round(v_wa.buyback_permille * (1 - coalesce(v_wa.ncb_pct, 0) / 100), 4) end);
        if v_wa.buyback_permille is null then v_bb_all := false; else v_bb_pm := v_bb_pm + v_wa.buyback_permille * (1 - coalesce(v_wa.ncb_pct, 0) / 100); end if;
      end if;
    end loop;
    if array_length(v_war_names, 1) is not null then
      v_alerts := v_alerts || jsonb_build_object('level', 'orange', 'text', 'War & strikes excluded: ' || array_to_string(v_war_names, ', ') ||
                    case when v_bb_all then ' - buy-back +' || trim_scale(round(v_bb_pm, 4)) || ' ‰ net' else ' - no buy-back terms set' end);
    end if;
  end if;
  v_year := nullif(regexp_replace(coalesce(v_details->>'vessel_year', ''), '\D', '', 'g'), '')::int;
  v_pieces := nullif(regexp_replace(coalesce(v_details->>'pieces', ''), '[^0-9.]', '', 'g'), '')::numeric;
  v_kg := nullif(regexp_replace(coalesce(v_details->>'weight_kg', ''), '[^0-9.]', '', 'g'), '')::numeric;
  v_store := v_details->>'storage';
  if com.oc_class in ('used','cars_used') or com.id in ('machinery_used','vehicles_used') then
    v_alerts := v_alerts || jsonb_build_object('level', 'yellow', 'text', 'Used goods - pre-shipment exception report required; JC2008/023 (used machinery)'); end if;
  if v_deck or v_pack ilike 'unpacked%' or (v_kg is not null and v_kg / greatest(coalesce(v_pieces, 1), 1) >= 25000) then
    v_alerts := v_alerts || jsonb_build_object('level', 'yellow', 'text', 'On deck / unpacked / heavy lift - marine warranty survey (MWS) may be required'); end if;
  if v_year is not null and v_year > 1900 and extract(year from current_date)::int - v_year > 20 then
    v_alerts := v_alerts || jsonb_build_object('level', 'yellow', 'text', 'Vessel built ' || v_year || ' (over 20 years) - Institute Classification Clause CL354, additional premium'); end if;
  if v_store in ('30','60') then
    v_alerts := v_alerts || jsonb_build_object('level', 'yellow', 'text', 'Storage before / after transit ' || case v_store when '30' then 'over 30 days' else 'over 60 days' end || ' - refer to underwriters'); end if;
  if com.on_request then v_alerts := v_alerts || jsonb_build_object('level', 'yellow', 'text', 'Cargo type is on the excluded / refer list' || case when com.description = 'not configured for this customer / policy' then ' (not configured for this customer / policy)' else '' end); end if;
  if v_status = 'quoted' and array_length(v_reasons, 1) is not null then v_status := 'on_request'; end if;
  if v_status = 'quoted' and array_length(v_war_names, 1) is not null and v_bb_all then
    v_rate_incl := round((v_total_pm + v_bb_pm * f_int) / 10, 4);
    v_net_incl := greatest(round(round(v_si * v_rate_incl / 100, 2) * (1 - coalesce(v_disc, 0) / 100), 2), coalesce(v_min, 0));
  end if;
  if v_detail is not null then
    v_detail := v_detail || jsonb_build_object('war_excluded', v_war_x, 'rate_pct_incl_buyback', v_rate_incl, 'premium_incl_buyback', v_net_incl, 'freight', v_freight);
  end if;

  return jsonb_build_object(
    'status', v_status, 'reasons', to_jsonb(v_reasons), 'notes', to_jsonb(v_notes), 'alerts', v_alerts,
    -- out of cover: a policy context with a breach of the cover (not a past date, not a referral)
    'out_of_cover', (pol.id is not null or p_cust is not null) and exists (select 1 from unnest(v_reasons) x where x not like 'Departure date%' and x <> c_hold),
    'ooc_reasons', to_jsonb(array(select x from unnest(v_reasons) x where x not like 'Departure date%' and x <> c_hold)),
    'rate', case when v_status = 'quoted' then v_rate end, 'gross', case when v_status = 'quoted' then v_gross end,
    'disc', case when v_status = 'quoted' then coalesce(v_disc, 0) else 0 end, 'net', case when v_status = 'quoted' then v_net end,
    'min', v_min, 'min_hit', v_min_hit, 'detail', v_detail, 'conditions', v_cond, 'deductible', v_ded,
    'war', jsonb_build_object('areas', v_war_x, 'rate_pct_incl', v_rate_incl, 'premium_incl', v_net_incl), 'war_names', to_jsonb(v_war_names),
    'allowed_currencies', to_jsonb(v_allowed),
    'n', jsonb_build_object('conveyance', v_conv, 'cover', v_cover, 'currency', v_cur, 'invoice_value', v_inv, 'uplift_pct', v_uplift, 'war_strikes', v_war,
      'on_deck', v_deck, 'interest_only', v_interest, 'departure_date', v_dep, 'incoterm', v_incoterm, 'insured_party', v_party, 'vessel', v_vessel,
      'ext_hssc', v_hssc, 'ext_liw', v_liw, 'transit_countries', to_jsonb(v_transit), 'insured_country', v_ins_cc, 'ftz', v_ftz, 'freight_value', v_freight,
      'red_sea', v_red, 'details', v_details, 'packaging', v_pack, 'sum_insured', v_si, 'commodity_id', com.id, 'commodity_name', com.name,
      'origin_country', o_c.iso2, 'dest_country', d_c.iso2, 'origin_name', o_c.name, 'dest_name', d_c.name));
end $$;

-- indicative premium visibility can also be set on a policy (staff only)
alter table public.policies add column if not exists show_premium boolean;

-- client request: policy -> client configuration (policy-less) -> general pool; visibility policy -> client -> group
create or replace function public.calc_indication(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare prof public.profiles; ofc public.offices; pol public.policies; cust public.customers; grp public.client_groups;
  v_cust bigint; v_office bigint := nullif(p->>'office_id', '')::bigint; v_type text; v_hide boolean; r1 jsonb; r2 jsonb; r public.indications;
begin
  select * into prof from public.profiles where id = auth.uid();
  if not found or not prof.approved or prof.rejected or not prof.is_active then raise exception 'not authorised'; end if;
  if coalesce((public.setting('maintenance'))::text::boolean, false) and not prof.is_admin then raise exception 'maintenance'; end if;

  v_cust := public.user_customer_id(prof.id);
  if v_office is null then v_office := prof.office_id; end if;
  if v_office is not null then
    select * into ofc from public.offices where id = v_office and active;
    if not found then raise exception 'invalid office'; end if;
    if not prof.is_admin and ofc.customer_id is distinct from v_cust then raise exception 'invalid office'; end if;
    v_cust := ofc.customer_id;
  end if;
  select * into cust from public.customers where id = v_cust;
  select * into grp from public.client_groups where id = coalesce(cust.group_id, prof.group_id);
  v_type := coalesce(prof.cover_type, cust.cover_type, 'one_off');
  if v_type in ('open_cover','policy') then
    if ofc.id is null and exists (select 1 from public.offices where customer_id = cust.id and active) then raise exception 'office required'; end if;
    if ofc.policy_id is not null then select * into pol from public.policies where id = ofc.policy_id;
    else select * into pol from public.policies where customer_id = cust.id and active order by sort, id limit 1; end if;
  end if;
  -- staff decide: policy -> client -> client group (clients can never switch this)
  v_hide := cust.id is not null and not coalesce(pol.show_premium, cust.show_premium, grp.show_premium, true) and not prof.is_admin;

  if pol.id is not null or (cust.id is not null and v_type <> 'one_off') then
    -- under the policy, or under the client configuration when the client has no policy
    r1 := public.rate_core(p, prof.id, ofc.id, pol.id, cust.id);
    if (r1->>'out_of_cover')::boolean then r2 := public.rate_core(p, prof.id, ofc.id, null, null); end if;
  else
    r1 := public.rate_core(p, prof.id, ofc.id, null, null);
  end if;
  r := public.store_indication(p, r1, r2, prof.id, coalesce(ofc.name, cust.name, prof.company), ofc.id, pol.id, cust.id, v_hide,
                               case when p->>'source' = 'upload' then 'upload' else 'form' end, prof.is_admin);
  if v_hide then
    r.ref := public.assign_ref(r.id);
    perform public.emit('quote_request', jsonb_build_object('indication_id', r.id, 'ref', r.ref, 'email', prof.email,
      'name', prof.full_name, 'company', r.company, 'goods', r.goods_description, 'conveyance', r.conveyance,
      'origin', r.origin_country, 'origin_place', r.origin_place, 'dest', r.dest_country, 'dest_place', r.dest_place,
      'vessel', r.vessel, 'incoterm', r.incoterm, 'insured_party', r.insured_party, 'sum_insured', r.sum_insured, 'currency', r.currency,
      'status', coalesce(r2, r1)->>'status', 'premium', (coalesce(r2, r1)->>'net')::numeric, 'comment', case when r.is_out_of_cover then 'OUT OF COVER' end,
      'policy', pol.policy_no, 'office', ofc.name));
    return to_jsonb(r) || jsonb_build_object('origin_name', r1#>>'{n,origin_name}', 'dest_name', r1#>>'{n,dest_name}', 'commodity_name', r1#>>'{n,commodity_name}', 'intake', true);
  end if;
  return to_jsonb(r) || jsonb_build_object('origin_name', r1#>>'{n,origin_name}', 'dest_name', r1#>>'{n,dest_name}', 'commodity_name', r1#>>'{n,commodity_name}',
                                           'deductible_text', r1->'deductible')
         || case when prof.is_admin then jsonb_build_object('calc_detail', coalesce(r2, r1)->'detail', 'notes', r1->'notes', 'alerts', coalesce(r2, r1)->'alerts') else '{}'::jsonb end;
end $$;
grant execute on function public.calc_indication(jsonb) to authenticated;

-- staff indication; p_standalone: linked to the client, rated from the general one-off pool;
-- p_direct: case for a certificate issued directly (stored as bound)
drop function if exists public.admin_indicate(jsonb, bigint, bigint, bigint, boolean, boolean, uuid);
create or replace function public.admin_indicate(p jsonb, p_customer bigint, p_office bigint, p_policy bigint, p_one_off boolean, p_save boolean, p_user uuid default null,
                                                 p_standalone boolean default false, p_direct boolean default false) returns jsonb
language plpgsql security definer set search_path = public as $$
declare ofc public.offices; pol public.policies; cust public.customers; r1 jsonb; r2 jsonb; r public.indications; v_company text; v_one boolean := coalesce(p_one_off, false) or coalesce(p_standalone, false);
begin
  if not public.is_admin() then raise exception 'not authorised'; end if;
  if p_office is not null then select * into ofc from public.offices where id = p_office; end if;
  if not v_one then
    select * into pol from public.policies where id = coalesce(p_policy, ofc.policy_id);
    select * into cust from public.customers where id = coalesce(p_customer, pol.customer_id, ofc.customer_id);
    if pol.id is null and cust.id is not null then select * into pol from public.policies where customer_id = cust.id and active order by sort, id limit 1; end if;
  else
    select * into cust from public.customers where id = coalesce(p_customer, ofc.customer_id);
  end if;
  if not v_one and (pol.id is not null or (cust.id is not null and cust.cover_type <> 'one_off')) then
    -- policy, or a client without a policy (client-only configuration)
    r1 := public.rate_core(p, p_user, ofc.id, pol.id, cust.id);
    if (r1->>'out_of_cover')::boolean then r2 := public.rate_core(p, p_user, ofc.id, null, null); end if;
  else
    r1 := public.rate_core(p, p_user, ofc.id, null, null);
  end if;
  if coalesce(p_save, false) then
    v_company := coalesce(nullif(trim(p->>'company'), ''), ofc.name, cust.name, (select company from public.profiles where id = p_user), 'Staff indication');
    r := public.store_indication(p, r1, r2, coalesce(p_user, auth.uid()), v_company, ofc.id, case when v_one then null else pol.id end, cust.id, false, 'staff', true);
    r.ref := public.assign_ref(r.id);
    update public.indications set is_standalone_one_off = coalesce(p_standalone, false),
           is_direct_certificate = coalesce(p_direct, false),
           stage = case when coalesce(p_direct, false) then 'bound' else stage end,
           party_role_other = nullif(left(trim(coalesce(p->>'party_role_other', '')), 100), '')
     where id = r.id;
  end if;
  return jsonb_build_object('result', r1, 'one_off', r2, 'standalone', coalesce(p_standalone, false),
                            'policy', case when pol.id is null or v_one then null else jsonb_build_object('id', pol.id, 'name', pol.name, 'policy_no', pol.policy_no, 'currency', pol.currency) end,
                            'customer', case when cust.id is null then null else jsonb_build_object('id', cust.id, 'name', cust.name) end,
                            'saved', case when r.id is null then null else jsonb_build_object('id', r.id, 'ref', r.ref) end);
end $$;
grant execute on function public.admin_indicate(jsonb, bigint, bigint, bigint, boolean, boolean, uuid, boolean, boolean) to authenticated;

-- clients: role text "other" is kept with their own requests too
create or replace function public.indications_party_other() returns trigger
language plpgsql as $$
begin
  if new.insured_party = 'other' and new.party_role_other is null and new.details ? 'party_role_other' then
    new.party_role_other := nullif(left(trim(new.details->>'party_role_other'), 100), '');
  end if;
  return new;
end $$;
drop trigger if exists indications_party_other on public.indications;
create trigger indications_party_other before insert on public.indications for each row execute function public.indications_party_other();

-- ---------- document attachments on requests ----------
create table if not exists public.request_attachments (
  id            bigserial primary key,
  indication_id bigint not null references public.indications(id) on delete cascade,
  path          text not null,
  name          text not null,
  size          bigint,
  mime          text,
  kind          text,
  uploaded_by   uuid,
  created_at    timestamptz not null default now()
);
create index if not exists request_attachments_ind on public.request_attachments(indication_id);
alter table public.request_attachments enable row level security;
create or replace function public.owns_indication(p_id bigint) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.indications where id = p_id and user_id = auth.uid())
$$;
grant execute on function public.owns_indication(bigint) to authenticated;
drop policy if exists admin_all on public.request_attachments;
create policy admin_all on public.request_attachments for all to authenticated using (public.is_admin()) with check (public.is_admin());
drop policy if exists own_read on public.request_attachments;
create policy own_read on public.request_attachments for select to authenticated using (public.owns_indication(indication_id));
drop policy if exists own_insert on public.request_attachments;
create policy own_insert on public.request_attachments for insert to authenticated
  with check (public.is_approved() and public.owns_indication(indication_id) and uploaded_by = auth.uid() and path like auth.uid()::text || '/%');
drop policy if exists own_delete on public.request_attachments;
create policy own_delete on public.request_attachments for delete to authenticated using (uploaded_by = auth.uid() and public.owns_indication(indication_id));

do $$
begin
  if exists (select 1 from information_schema.tables where table_schema = 'storage' and table_name = 'buckets') then
    insert into storage.buckets(id, name, public, file_size_limit) values ('request-documents', 'request-documents', false, 26214400)
      on conflict (id) do nothing;
    execute 'drop policy if exists "reqdocs admin" on storage.objects';
    execute $p$create policy "reqdocs admin" on storage.objects for all to authenticated
             using (bucket_id = 'request-documents' and public.is_admin()) with check (bucket_id = 'request-documents' and public.is_admin())$p$;
    execute 'drop policy if exists "reqdocs own write" on storage.objects';
    execute $p$create policy "reqdocs own write" on storage.objects for insert to authenticated
             with check (bucket_id = 'request-documents' and public.is_approved() and (storage.foldername(name))[1] = auth.uid()::text)$p$;
    execute 'drop policy if exists "reqdocs own read" on storage.objects';
    execute $p$create policy "reqdocs own read" on storage.objects for select to authenticated
             using (bucket_id = 'request-documents' and (storage.foldername(name))[1] = auth.uid()::text)$p$;
    execute 'drop policy if exists "reqdocs own delete" on storage.objects';
    execute $p$create policy "reqdocs own delete" on storage.objects for delete to authenticated
             using (bucket_id = 'request-documents' and (storage.foldername(name))[1] = auth.uid()::text)$p$;
  end if;
end $$;

-- ---------- no em / en dashes ----------
create or replace function public.no_dashes() returns trigger
language plpgsql as $$
declare t text := to_jsonb(new)::text;
begin
  if position(U&'\2014' in t) > 0 or position(U&'\2013' in t) > 0 then
    new := jsonb_populate_record(new, replace(replace(t, U&'\2014', '-'), U&'\2013', '-')::jsonb);
  end if;
  return new;
end $$;
do $$
declare t text;
begin
  foreach t in array array['clause_library','commodities','commodity_terms','countries','country_zones','war_areas','war_exclusions','customers','policies','offices',
                           'client_groups','quotations','indications','settings','zone_maps','policy_clauses','customer_clauses','certificates','request_attachments']
  loop
    if exists (select 1 from information_schema.tables where table_schema = 'public' and table_name = t) then
      execute format('drop trigger if exists %I on public.%I', t || '_no_dashes', t);
      execute format('create trigger %I before insert or update on public.%I for each row execute function public.no_dashes()', t || '_no_dashes', t);
    end if;
  end loop;
end $$;
-- clean the configuration that exists today (the trigger does the work)
do $$
declare t text; c text;
begin
  perform set_config('fc.audited', '1', true);
  foreach t in array array['clause_library','commodities','commodity_terms','countries','country_zones','war_areas','war_exclusions','customers','policies','offices','client_groups','settings','zone_maps']
  loop
    select column_name into c from information_schema.columns where table_schema = 'public' and table_name = t order by ordinal_position limit 1;
    if c is not null then
      execute format($q$update public.%I x set %I = %I where to_jsonb(x)::text ~ '[%s%s]'$q$, t, c, c, U&'\2014', U&'\2013');
    end if;
  end loop;
end $$;

notify pgrst, 'reload schema';
