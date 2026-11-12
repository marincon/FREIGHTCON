-- =====================================================================
-- FREIGHTCON update 2026-11-12m — open covers (stage 2): risk rules
-- * country check in five categories (Internal → Rates → Countries & zones):
--   red = blocked / do not quote under the open cover, amber = compliance /
--   local licensing, yellow = hold covered (refer before attachment), ok;
--   screened for origin, destination, every transit country and the
--   domicile of the assured (else the office)
-- * war & strikes lifted / excluded areas (seas and coasts; Saudi Arabia
--   and the UAE split by coast via their ports), per client group (blanket)
--   or per policy; rate is NOT reduced; optional buy-back loading less
--   no-claims bonus gives a second rate "with war & strikes re-included"
-- * Red Sea: by port, by littoral country, by transit, or by routing via
--   Suez (asked in the form; "not sure" assumes Suez on Europe ↔ Asia lanes)
-- * transit countries, freight costs (sum insured = (invoice + freight)
--   × (1 + uplift)), country of the assured, UAE Free Trade Zone, optional
--   shipment details (equipment, pieces, weight, HS code, vessel year built,
--   storage, co-assureds / loss payees)
-- * internal referral alerts: used goods (exception report, JC2008/023),
--   on deck / unpacked / heavy lift (MWS), vessel over 20 years (CL354),
--   storage over 30 / 60 days, excluded cargo, UAE mainland
-- Run after update_2026-11-12l.sql. Safe to run more than once.
-- =====================================================================

alter table public.countries add column if not exists compliance text not null default 'ok';
alter table public.countries drop constraint if exists countries_compliance_check;
alter table public.countries add constraint countries_compliance_check check (compliance in ('ok','blocked','local','hold'));

alter table public.offices add column if not exists ftz boolean;   -- UAE: registered in a Free Trade Zone (null = unknown)

alter table public.indications add column if not exists transit_countries text[] not null default '{}';
alter table public.indications add column if not exists insured_country   text;
alter table public.indications add column if not exists ftz               boolean;
alter table public.indications add column if not exists freight_value     numeric(14,2) check (freight_value >= 0);
alter table public.indications add column if not exists red_sea           text not null default 'auto' check (red_sea in ('auto','yes','no'));
alter table public.indications add column if not exists details           jsonb not null default '{}'::jsonb;
alter table public.indications add column if not exists war_excluded      text[] not null default '{}';   -- names only, shown to the client

alter table public.indication_internal add column if not exists alerts jsonb not null default '[]'::jsonb;
alter table public.indication_internal add column if not exists war    jsonb;

create table if not exists public.war_areas (
  code      text primary key check (code ~ '^[a-z0-9_]{2,40}$'),
  name      text not null,
  kind      text not null check (kind in ('sea','coast')),
  country   text,                               -- coast: the country it belongs to
  countries text[] not null default '{}',       -- sea: littoral countries (a port there touches the sea)
  ports     text[] not null default '{}',       -- port / place names that identify the coast or sea
  note      text,
  sort      int not null default 100
);
create table if not exists public.war_exclusions (
  id               bigserial primary key,
  group_id         bigint references public.client_groups(id) on delete cascade,
  policy_id        bigint references public.policies(id) on delete cascade,
  area_code        text not null references public.war_areas(code) on delete cascade,
  buyback_permille numeric(8,4) check (buyback_permille >= 0),  -- gross loading to re-include war & strikes (null = no terms)
  ncb_pct          numeric(5,2) not null default 0 check (ncb_pct >= 0 and ncb_pct <= 100),  -- upfront no-claims bonus on the loading
  active           boolean not null default true,
  note             text,
  updated_at       timestamptz not null default now(),
  check ((group_id is null) <> (policy_id is null))
);
alter table public.war_areas      enable row level security;
alter table public.war_exclusions enable row level security;
drop policy if exists admin_all on public.war_areas;
create policy admin_all on public.war_areas for all to authenticated using (public.is_admin()) with check (public.is_admin());
drop policy if exists admin_all on public.war_exclusions;
create policy admin_all on public.war_exclusions for all to authenticated using (public.is_admin()) with check (public.is_admin());

insert into public.war_areas(code, name, kind, country, countries, ports, note, sort) values
  ('red_sea', 'Red Sea', 'sea', null, array['SD','ER','DJ','YE','JO'],
     array['Jeddah','Yanbu','Jizan','Jazan','King Abdullah','Rabigh','Duba','Neom','Aqaba','Port Sudan','Suakin','Massawa','Assab','Djibouti','Hodeidah','Sokhna','Safaga','Suez','Eilat','Berbera'],
     'Incl. Gulf of Aden and Bab-el-Mandeb. Touched by ports, littoral countries, transit or routing via Suez.', 10),
  ('sa_west', 'Saudi Arabia — West Coast (Red Sea)', 'coast', 'SA', '{}', array['Jeddah','Yanbu','Jizan','Jazan','King Abdullah','Rabigh','Duba','Neom','Riyadh dry port west'], null, 20),
  ('sa_east', 'Saudi Arabia — East Coast (Arabian / Persian Gulf)', 'coast', 'SA', '{}', array['Dammam','Jubail','Ras Tanura','Ras al Khair','Ras Al-Khair','Khobar','Dhahran','Riyadh'], null, 21),
  ('ae_gulf', 'UAE — Persian Gulf', 'coast', 'AE', '{}', array['Jebel Ali','Dubai','Abu Dhabi','Khalifa','Mina Zayed','Sharjah','Ajman','Ruwais','Hamriyah','Umm al Quwain','Ras al Khaimah','Saqr'], null, 30),
  ('ae_oman', 'UAE — Gulf of Oman (Fujairah)', 'coast', 'AE', '{}', array['Fujairah','Khor Fakkan','Kalba','Dibba'], null, 31)
on conflict (code) do nothing;

-- country check: lists of the specification (editable in Internal → Rates → Countries & zones)
update public.countries set compliance = 'blocked'
 where compliance = 'ok' and iso2 in ('CO','DZ','CI','NG','CD','RW','BI','SD','SS','ET','ER','DJ','SO','LB','IQ','YE','AF','MM','KP','RU','UA','BY','IR','IL','PS','LK');
update public.countries set compliance = 'local'
 where compliance = 'ok' and iso2 in ('US','CA','MX','BR','SA','MY','AE','AR','EG','TR','IN','SG','ID','PH');

-- Bertling: war & strikes lifted for these areas (blanket for the group, no buy-back terms yet)
insert into public.war_exclusions(group_id, area_code)
select g.id, a.code from public.client_groups g cross join public.war_areas a
 where g.name = 'Bertling'
   and not exists (select 1 from public.war_exclusions x where x.group_id = g.id and x.area_code = a.code);
update public.offices set ftz = null where country = 'AE' and ftz is null;

create or replace function public.calc_indication(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  prof public.profiles; com public.commodities; o_c public.countries; d_c public.countries; o_r public.regions; d_r public.regions;
  tb public.rate_tables; grp public.client_groups; pol public.policies; ofc public.offices;
  v_conv     text := p->>'conveyance';
  v_cover    text := coalesce(p->>'cover', 'icc_a');
  v_cur      text := upper(coalesce(p->>'currency', 'EUR'));
  v_inv      numeric := nullif(p->>'invoice_value', '')::numeric;
  v_uplift   numeric := coalesce(nullif(p->>'uplift_pct', '')::numeric, (public.setting('uplift_pct'))::text::numeric, 10);
  v_war      boolean := coalesce((p->>'war_strikes')::boolean, true);
  v_deck     boolean := coalesce((p->>'on_deck')::boolean, false);
  v_interest boolean := coalesce((p->>'interest_only')::boolean, false);
  v_dep      date := nullif(p->>'departure_date', '')::date;
  v_incoterm text := nullif(upper(trim(coalesce(p->>'incoterm', ''))), '');
  v_party    text := nullif(lower(trim(coalesce(p->>'insured_party', ''))), '');
  v_vessel   text := nullif(trim(coalesce(p->>'vessel', '')), '');
  v_hssc     boolean := coalesce((p->>'ext_hssc')::boolean, false);
  v_liw      boolean := coalesce((p->>'ext_liw')::boolean, false);
  v_office   bigint := nullif(p->>'office_id', '')::bigint;
  v_transit  text[] := '{}';
  v_ins_cc   text := nullif(upper(trim(coalesce(p->>'insured_country', ''))), '');
  v_ftz      boolean := case when p->>'ftz' in ('true','false') then (p->>'ftz')::boolean end;
  v_freight  numeric := coalesce(nullif(p->>'freight_value', '')::numeric, 0);
  v_red      text := coalesce(nullif(p->>'red_sea', ''), 'auto');
  v_details  jsonb := case when jsonb_typeof(p->'details') = 'object' then p->'details' else '{}'::jsonb end;
  v_alerts   jsonb := '[]'::jsonb; v_war_x jsonb := '[]'::jsonb; v_war_names text[] := '{}'; v_bb_pm numeric := 0; v_bb_all boolean := true;
  v_rate_incl numeric; v_net_incl numeric; v_dom_cc text; v_comp text; v_cc text; v_role text; v_wa record; v_touch boolean; v_hit boolean; v_place text;
  v_year int; v_pieces numeric; v_kg numeric; v_store text;
  v_ext_pm   numeric := 0; v_hssc_pm numeric := 0; v_liw_pm numeric := 0;
  v_pack     text := coalesce(nullif(trim(coalesce(p->>'packaging', '')), ''), '');
  v_mode     text; v_table text; zo int; zd int; v_band text; v_ocls text;
  v_base numeric; v_cell numeric; v_sched boolean := false; v_hide boolean := false; v_ug bigint;
  f_class numeric; f_cover numeric; f_conv numeric; f_pack numeric; f_deck numeric := 1; f_theft numeric := 1; f_load numeric := 1; f_int numeric := 1;
  v_cargo_pm numeric; v_war_pm numeric := 0; v_crisis numeric := 0; v_total_pm numeric;
  v_si numeric; v_rate numeric; v_gross numeric; v_disc numeric; v_net numeric; v_min numeric; v_limit numeric; v_ded_amt numeric;
  v_min_hit boolean := false; v_status text := 'quoted'; v_reasons text[] := '{}'; v_notes text[] := '{}'; v_cond text; v_detail jsonb; v_ded text;
  r public.indications;
begin
  select * into prof from public.profiles where id = auth.uid();
  if not found or not prof.approved or prof.rejected then raise exception 'not authorised'; end if;
  if coalesce((public.setting('maintenance'))::text::boolean, false) and not prof.is_admin then raise exception 'maintenance'; end if;

  -- ---- who is asking: office → policy → group ----
  v_ug := public.user_group_id(prof.id);
  if v_office is null then v_office := prof.office_id; end if;
  if v_office is not null then
    select * into ofc from public.offices where id = v_office and active;
    if not found then raise exception 'invalid office'; end if;
    select * into pol from public.policies where id = ofc.policy_id;
    select * into grp from public.client_groups where id = pol.group_id;
    if not prof.is_admin and grp.id is distinct from v_ug then raise exception 'invalid office'; end if;
  else
    select * into grp from public.client_groups where id = v_ug;
    if grp.kind = 'open_cover' then raise exception 'office required'; end if;
  end if;
  v_sched := pol.id is not null and pol.rating = 'schedule';
  v_hide  := grp.id is not null and not grp.show_premium and not prof.is_admin;

  if v_conv not in ('sea_container','sea_breakbulk','air','air_charter','road','rail') then raise exception 'invalid conveyance'; end if;
  if v_cover not in ('icc_a','icc_b','icc_c') then raise exception 'invalid cover'; end if;
  if pol.id is not null then
    if v_cur <> pol.currency then raise exception 'currency must be %', pol.currency; end if;
  elsif v_cur not in ('EUR','USD') then raise exception 'invalid currency'; end if;
  if v_inv is null or v_inv <= 0 or v_inv > 1000000000 then raise exception 'invalid invoice value'; end if;
  if v_uplift < 0 or v_uplift > 30 then raise exception 'invalid uplift'; end if;
  if length(trim(coalesce(p->>'goods_description', ''))) < 2 then raise exception 'goods description required'; end if;
  if v_incoterm is not null and v_incoterm not in ('EXW','FCA','FAS','FOB','CFR','CIF','CPT','CIP','DAP','DPU','DDP') then raise exception 'invalid incoterm'; end if;
  if v_party is not null and v_party not in ('seller','buyer') then raise exception 'invalid party'; end if;
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

  select * into com from public.commodities where id = p->>'commodity_id' and active;
  if not found then raise exception 'invalid commodity'; end if;
  if not com.ext_hssc then v_hssc := false; end if;
  if not com.ext_liw  then v_liw  := false; end if;
  select * into o_c from public.countries where iso2 = upper(p->>'origin_country'); if not found then raise exception 'invalid origin country'; end if;
  select * into d_c from public.countries where iso2 = upper(p->>'dest_country');   if not found then raise exception 'invalid destination country'; end if;
  select * into o_r from public.regions where id = o_c.region_id;
  select * into d_r from public.regions where id = d_c.region_id;

  v_si   := round((v_inv + v_freight) * (1 + v_uplift / 100), 2);
  v_mode := case when v_conv in ('air','air_charter') then 'air' when v_conv in ('road','rail') then 'land' else 'sea' end;
  -- under an open cover war & strikes are part of the sea schedule rates and cannot be deselected
  if v_sched and v_mode = 'sea' then v_war := true; end if;

  v_cond := com.conditions;
  v_cond := regexp_replace(coalesce(v_cond, ''), '\s*Institute Cargo Clauses \([ABC]\)( or \([ABC]\))? only\.', '', 'gi');
  v_cond := regexp_replace(v_cond, 'Excluding heating, sweating, spontaneous combustion, contamination and loss in weight unless caused by an insured peril or covered by an extension\.', 'Excluding contamination unless caused by an insured peril.', 'gi');
  v_cond := nullif(trim(v_cond), '');
  if v_hssc then v_cond := concat_ws(' ', v_cond, coalesce(public.setting('extensions')#>>'{hssc,clause}', 'Extended to cover heating, sweating and spontaneous combustion.'));
  elsif com.ext_hssc then v_cond := concat_ws(' ', v_cond, 'Excluding heating, sweating and spontaneous combustion unless caused by an insured peril.'); end if;
  if v_liw  then v_cond := concat_ws(' ', v_cond, coalesce(public.setting('extensions')#>>'{liw,clause}', 'Extended to cover loss in weight / difference in weight (shortage), subject to a deductible of 0.5 % of the sum insured.'));
  elsif com.ext_liw then v_cond := concat_ws(' ', v_cond, 'Excluding loss in weight / difference in weight (shortage) unless caused by an insured peril.'); end if;

  if pol.id is not null then
    v_ded_amt := coalesce(prof.deductible_override, ofc.deductible, pol.deductible);
    v_ded := case when v_ded_amt is null then coalesce(com.deductible, (public.setting('deductible_text'))#>>'{}')
                  else pol.currency || ' ' || to_char(v_ded_amt, 'FM999,999,990.00') || ' each and every loss' end;
  else
    v_ded := coalesce(com.deductible, (public.setting('deductible_text'))#>>'{}');
  end if;
  if v_liw then v_ded := concat_ws('; ', v_ded, 'loss / difference in weight: ' || coalesce(public.setting('extensions')#>>'{liw,deductible}', '0.5 % of the sum insured')); end if;

  if o_c.sanctioned or d_c.sanctioned or coalesce(o_r.sanctioned, false) or coalesce(d_r.sanctioned, false) then
    v_status := 'sanctioned';
    v_reasons := array['Origin or destination is subject to sanctions — compliance review required'];

  elsif v_sched then
    -- =========== open cover: rates straight from the policy schedules ===========
    v_ocls := com.oc_class;
    if v_mode = 'sea' then
      v_table := case v_ocls when 'new' then 'sea_new' when 'used' then 'sea_used' when 'cars_new' then 'sea_newcars'
                             when 'cars_used' then 'sea_usedcars' when 'household' then 'sea_household' end;
      zo := o_c.sea_zone; zd := d_c.sea_zone;
    elsif v_mode = 'air' then
      v_table := case when v_ocls is null then null when v_conv = 'air' then 'air_freight' else 'air_charter' end;
      zo := o_c.air_zone; zd := d_c.air_zone;
    end if;
    if v_table is not null then select * into tb from public.rate_tables where id = v_table; end if;

    if not pol.active then v_reasons := array_append(v_reasons, 'Your open cover is not active — we quote this individually'::text); end if;
    if v_mode = 'land' then
      v_reasons := array_append(v_reasons, 'Road / rail transport on its own is quoted individually'::text);
      v_notes := array_append(v_notes, 'Simple road transport — must ask insurers for rate / terms before quoting'::text);
      if 'SA' in (o_c.iso2, d_c.iso2) then v_notes := array_append(v_notes, 'Road transport in Saudi Arabia only after request / underwriter approval'::text); end if;
    end if;
    if com.on_request then v_reasons := array_append(v_reasons, 'This type of cargo is quoted individually'::text);
    elsif v_mode <> 'land' and v_ocls is null then v_reasons := array_append(v_reasons, 'This cargo is not part of the open cover schedules — quoted individually'::text);
      v_notes := array_append(v_notes, 'Cargo type has no open cover class (Rates → Cargo types)'::text);
    elsif v_mode <> 'land' and tb.id is null then v_reasons := array_append(v_reasons, 'No schedule for this cargo and conveyance — quoted individually'::text); end if;
    if not (v_cover = any(com.allowed_covers)) or v_cover = 'icc_b' or (v_cover = 'icc_c' and v_mode <> 'sea') then
      v_reasons := array_append(v_reasons, 'The chosen cover is quoted individually under the open cover'::text); end if;
    if zo is null and v_mode <> 'land' then v_reasons := array_append(v_reasons, ('Shipments from ' || o_c.name || ' are checked with underwriters individually')::text); end if;
    if zd is null and v_mode <> 'land' then v_reasons := array_append(v_reasons, ('Shipments to ' || d_c.name || ' are checked with underwriters individually')::text); end if;
    -- local licensing is an internal amber alert under an open cover (country check below), not a stop
    if o_c.on_request or coalesce(o_r.on_request, false) then v_reasons := array_append(v_reasons, ('Shipments from ' || o_c.name || ' are quoted individually')::text); end if;
    if d_c.on_request or coalesce(d_r.on_request, false) then v_reasons := array_append(v_reasons, ('Shipments to ' || d_c.name || ' are quoted individually')::text); end if;
    if v_deck and (tb.id is null or not tb.deck_allowed) then v_reasons := array_append(v_reasons, 'On-deck shipment of this cargo is quoted individually'::text); end if;
    if v_interest and (tb.id is null or not tb.contingency_allowed) then v_reasons := array_append(v_reasons, 'Seller''s / buyer''s interest cover for this cargo is quoted individually'::text); end if;
    if v_mode = 'air' and v_ocls = 'household' and public.policy_rule(pol.rules, array[v_table, 'household_permille']) is null then v_reasons := array_append(v_reasons, 'Household goods by this conveyance are quoted individually'::text); end if;
    if v_mode = 'air' and v_ocls = 'cars_used' then v_reasons := array_append(v_reasons, 'Used vehicles by air are quoted individually'::text); end if;
    v_limit := case when v_deck then coalesce(pol.limit_on_deck, pol.limit_conveyance) else pol.limit_conveyance end;
    if v_limit is not null and v_si > v_limit then
      v_reasons := array_append(v_reasons, 'Sum insured above the limit of your open cover — quoted individually'::text);
      v_notes := array_append(v_notes, ('Over policy limit: ' || pol.currency || ' ' || to_char(v_limit, 'FM999,999,999,990') || (case when v_deck then ' on deck / barge' else ' any one conveyance' end))::text);
    end if;
    if v_dep is not null and v_dep < current_date then v_reasons := array_append(v_reasons, 'Departure date lies in the past — cover cannot be backdated automatically'::text); end if;

    if array_length(v_reasons, 1) is null then
      if v_mode = 'air' and v_ocls = 'household' then
        v_base := public.policy_rule(pol.rules, array[v_table, 'household_permille']); v_cell := v_base;
      else
        select permille into v_cell from public.rate_cells where table_id = tb.id and zone_a = least(zo, zd) and zone_b = greatest(zo, zd);
        if v_cell is null then v_reasons := array_append(v_reasons, 'No rate for this route in the open cover — quoted individually'::text);
        else v_base := v_cell; end if;   -- war & strikes inside the sea rates stay in (never deducted)
      end if;
    end if;

    if array_length(v_reasons, 1) is not null then
      v_status := 'on_request';
    else
      -- schedule rules of the policy: ICC (C) and seller's / buyer's interest as a share of the schedule rate, loadings on top
      f_cover := case when v_cover = 'icc_c' then public.policy_rule(pol.rules, array['icc_c_pct']) / 100 else 1 end;
      if v_deck then f_deck := 1 + public.policy_rule(pol.rules, array['deck_loading_pct']) / 100; end if;
      if v_mode = 'air' and v_ocls = 'used' then f_load := 1 + coalesce(public.policy_rule(pol.rules, array[v_table, 'used_pct']), 0) / 100; end if;
      if v_mode = 'air' and v_ocls = 'cars_new' then f_load := 1 + coalesce(public.policy_rule(pol.rules, array[v_table, 'cars_pct']), 0) / 100; end if;
      if v_interest then f_int := public.policy_rule(pol.rules, array['interest_pct']) / 100; end if;
      v_cargo_pm := v_base * f_cover * f_deck * f_load;
      if v_mode = 'air' and v_war then v_war_pm := public.policy_rule(pol.rules, array['air_war_permille']); end if;
      if v_war then v_crisis := greatest(o_c.crisis_permille, d_c.crisis_permille); end if;
      if v_hssc then v_hssc_pm := coalesce((public.setting('extensions')#>>'{hssc,permille}')::numeric, 0.15); end if;
      if v_liw  then v_liw_pm  := coalesce((public.setting('extensions')#>>'{liw,permille}')::numeric, 0.75); end if;
      v_ext_pm := v_hssc_pm + v_liw_pm;
      v_total_pm := (v_cargo_pm + v_ext_pm + v_war_pm + v_crisis) * f_int;
      v_rate  := round(v_total_pm / 10, 4);
      v_gross := round(v_si * v_rate / 100, 2);
      v_disc  := coalesce(prof.client_discount_pct, 0);
      v_net   := round(v_gross * (1 - v_disc / 100), 2);
      v_min   := coalesce(prof.min_premium_override, ofc.min_premium, pol.min_premium, 0);
      if v_net < v_min then v_net := v_min; v_min_hit := true; end if;
      v_detail := jsonb_build_object(
        'scheme', 'open_cover', 'policy_no', pol.policy_no, 'policy', pol.name, 'office', ofc.name,
        'mode', v_mode, 'table', tb.id, 'table_name', tb.name, 'zone_from', zo, 'zone_to', zd,
        'schedule_permille', v_cell, 'base_permille', round(v_base, 4), 'war_included_permille', case when v_mode = 'sea' then tb.war_included_permille else 0 end,
        'f_cover', f_cover, 'f_deck', f_deck, 'f_loading', f_load, 'f_interest', f_int,
        'factor', round(f_cover * f_deck * f_load, 4), 'cargo_permille', round(v_cargo_pm, 4),
        'war_permille', v_war_pm, 'crisis_permille', v_crisis, 'hssc_permille', v_hssc_pm, 'liw_permille', v_liw_pm,
        'rate_permille', round(v_total_pm, 4), 'min_premium', v_min, 'deductible', v_ded_amt, 'currency', pol.currency);
    end if;

  else
    -- =========== standard FREIGHTCON rating (spot clients) ===========
    if v_mode = 'sea' then
      v_table := com.sea_table; zo := o_c.sea_zone; zd := d_c.sea_zone;
    elsif v_mode = 'air' then
      v_table := case when com.air_class is null then null when v_conv = 'air' then 'air_freight' else 'air_charter' end; zo := o_c.air_zone; zd := d_c.air_zone;
    else
      zo := o_c.sea_zone; zd := d_c.sea_zone;
      v_band := case when o_c.iso2 = d_c.iso2 then 'domestic' when zo = zd then 'regional' else 'long_haul' end;
    end if;
    if v_table is not null then select * into tb from public.rate_tables where id = v_table; end if;

    if com.on_request then v_reasons := array_append(v_reasons, 'This type of cargo is quoted individually'::text);
    elsif v_mode <> 'land' and tb.id is null then v_reasons := array_append(v_reasons, 'This cargo is quoted individually for the chosen conveyance'::text); end if;
    if not (v_cover = any(com.allowed_covers)) then v_reasons := array_append(v_reasons, 'The chosen cover is not available automatically for this cargo'::text); end if;
    if zo is null then v_reasons := array_append(v_reasons, ('Shipments from ' || o_c.name || ' are checked with underwriters individually')::text); end if;
    if zd is null then v_reasons := array_append(v_reasons, ('Shipments to ' || d_c.name || ' are checked with underwriters individually')::text); end if;
    if o_c.local_insurance then v_reasons := array_append(v_reasons, ('Local insurance rules apply in ' || o_c.name || ' — we check this individually')::text); end if;
    if d_c.local_insurance then v_reasons := array_append(v_reasons, ('Local insurance rules apply in ' || d_c.name || ' — we check this individually')::text); end if;
    if o_c.on_request or coalesce(o_r.on_request, false) then v_reasons := array_append(v_reasons, ('Shipments from ' || o_c.name || ' are quoted individually')::text); end if;
    if d_c.on_request or coalesce(d_r.on_request, false) then v_reasons := array_append(v_reasons, ('Shipments to ' || d_c.name || ' are quoted individually')::text); end if;
    if v_deck and (tb.id is null or not tb.deck_allowed or com.id in ('vehicles_new','vehicles_used','household','reefer','pharma','electronics')) then
      v_reasons := array_append(v_reasons, 'On-deck shipment of this cargo is quoted individually'::text); end if;
    if v_mode = 'land' and o_c.iso2 <> d_c.iso2 and zo is not null and zd is not null and zo <> zd
       and not exists (select 1 from jsonb_each(coalesce(public.setting('land_groups'), '{}'::jsonb)) g
                        where g.value @> to_jsonb(zo) and g.value @> to_jsonb(zd)) then
      v_reasons := array_append(v_reasons, ('No road / rail connection between ' || o_c.name || ' and ' || d_c.name || ' in our tariff — please choose sea or air, or request a quotation')::text); end if;
    v_limit := coalesce(com.max_sum_insured, (public.setting('auto_limit')->>v_cur)::numeric);
    if (public.setting('auto_limit')->>v_cur)::numeric is not null then v_limit := least(v_limit, (public.setting('auto_limit')->>v_cur)::numeric); end if;
    if v_limit is not null and v_si > v_limit then v_reasons := array_append(v_reasons, 'Sum insured above the automatic limit for this cargo'::text); end if;
    if v_dep is not null and v_dep < current_date then v_reasons := array_append(v_reasons, 'Departure date lies in the past — cover cannot be backdated automatically'::text); end if;

    if array_length(v_reasons, 1) is null then
      if v_mode = 'land' then
        v_base := coalesce((public.setting('land_rates')->>v_band)::numeric, 1);
      else
        select permille into v_cell from public.rate_cells where table_id = tb.id and zone_a = least(zo, zd) and zone_b = greatest(zo, zd);
        if v_cell is null then v_reasons := array_append(v_reasons, 'No rate for this route — quoted individually'::text);
        else v_base := greatest(v_cell - coalesce(tb.war_included_permille, 0), 0); end if;
      end if;
    end if;

    if array_length(v_reasons, 1) is not null then
      v_status := 'on_request';
    else
      f_class := com.class_factor;
      f_cover := coalesce((public.setting('cover_factors')->>v_cover)::numeric, 1);
      f_conv  := coalesce((public.setting('conveyance_factors')->>v_conv)::numeric, 1);
      f_pack  := coalesce((public.setting('packing_factors')->>v_pack)::numeric, (public.setting('packing_factors')->>'Other')::numeric, 1);
      if v_deck then f_deck := 1 + coalesce((public.setting('deck_loading_pct'))::text::numeric, 50) / 100; end if;
      if v_mode = 'land' and com.theft_attractive then f_theft := coalesce((public.setting('theft_land_factor'))::text::numeric, 1.5); end if;
      f_load := 1 + coalesce(com.loading_pct, 0) / 100;
      if v_interest then f_int := coalesce((public.setting('contingency_factor'))::text::numeric, 0.4); end if;

      v_cargo_pm := v_base * f_class * f_cover * f_conv * f_pack * f_deck * f_theft * f_load;
      if v_war then
        v_war_pm := case v_mode when 'sea'  then coalesce((public.setting('sea_war_permille'))::text::numeric, 0.5)
                                when 'air'  then coalesce((public.setting('air_war_permille'))::text::numeric, 0.5)
                                else coalesce((public.setting('land_strikes_permille'))::text::numeric, 0.1) end;
        if v_mode <> 'land' then v_crisis := greatest(o_c.crisis_permille, d_c.crisis_permille); end if;
      end if;
      if v_hssc then v_hssc_pm := coalesce((public.setting('extensions')#>>'{hssc,permille}')::numeric, 0.15); end if;
      if v_liw  then v_liw_pm  := coalesce((public.setting('extensions')#>>'{liw,permille}')::numeric, 0.75); end if;
      v_ext_pm := v_hssc_pm + v_liw_pm;
      v_total_pm := (v_cargo_pm + v_ext_pm + v_war_pm + v_crisis) * f_int;
      v_rate  := round(v_total_pm / 10, 4);
      v_gross := round(v_si * v_rate / 100, 2);
      v_disc  := coalesce(prof.client_discount_pct, 0);
      v_net   := round(v_gross * (1 - v_disc / 100), 2);
      v_min   := case when v_mode = 'land' then coalesce((public.setting('land_min_premium'))::text::numeric, 75) else coalesce(tb.min_premium, 100) end;
      if prof.min_premium_override is not null then v_min := prof.min_premium_override; end if;
      if v_net < v_min then v_net := v_min; v_min_hit := true; end if;
      v_detail := jsonb_build_object(
        'scheme', 'standard',
        'mode', v_mode, 'table', tb.id, 'table_name', coalesce(tb.name, 'Land · ' || replace(v_band, '_', '-')), 'band', v_band,
        'zone_from', zo, 'zone_to', zd, 'schedule_permille', v_cell, 'base_permille', round(v_base, 4),
        'f_class', f_class, 'f_cover', f_cover, 'f_conveyance', f_conv, 'f_packing', f_pack, 'f_deck', f_deck, 'f_theft', f_theft, 'f_loading', f_load, 'f_interest', f_int,
        'factor', round(f_class * f_cover * f_conv * f_pack * f_deck * f_theft * f_load, 4),
        'cargo_permille', round(v_cargo_pm, 4), 'war_permille', v_war_pm, 'crisis_permille', v_crisis, 'hssc_permille', v_hssc_pm, 'liw_permille', v_liw_pm,
        'rate_permille', round(v_total_pm, 4), 'min_premium', v_min);
    end if;
  end if;

  -- ================= compliance, war & strikes areas, referral alerts (internal) =================
  -- domicile of the insured interest: the assured named on the shipment, else the office
  v_dom_cc := coalesce(v_ins_cc, ofc.country);
  for v_role, v_cc in
      select 'origin', o_c.iso2 union all select 'destination', d_c.iso2
      union all select 'transit', t from unnest(v_transit) t
      union all select 'assured', v_dom_cc where v_dom_cc is not null
  loop
    select compliance into v_comp from public.countries where iso2 = v_cc;
    if v_comp = 'blocked' then
      v_alerts := v_alerts || jsonb_build_object('level', 'red', 'text', 'Blocked / prohibited: ' || (select name from public.countries where iso2 = v_cc) || ' (' || v_role || ') — do not quote under the open cover');
      if not (('A route or party in this shipment is checked individually')::text = any(v_reasons)) then
        v_reasons := array_append(v_reasons, 'A route or party in this shipment is checked individually'::text); end if;
    elsif v_comp = 'local' and not (v_cc = 'AE') then
      v_alerts := v_alerts || jsonb_build_object('level', 'amber', 'text', 'Compliance / local licensing: ' || (select name from public.countries where iso2 = v_cc) || ' (' || v_role || ') — check admitted / local insurers');
    elsif v_comp = 'hold' then
      v_alerts := v_alerts || jsonb_build_object('level', 'yellow', 'text', 'Hold covered: ' || (select name from public.countries where iso2 = v_cc) || ' (' || v_role || ') — refer to underwriters prior to attachment');
      if not (('A route or party in this shipment is checked individually')::text = any(v_reasons)) then
        v_reasons := array_append(v_reasons, 'A route or party in this shipment is checked individually'::text); end if;
    end if;
  end loop;
  -- UAE: German / EU open covers only for interests registered in a Free Trade Zone
  if v_dom_cc = 'AE' then
    if v_ins_cc is null then v_ftz := ofc.ftz; end if;
    if not coalesce(v_ftz, false) then
      v_alerts := v_alerts || jsonb_build_object('level', 'amber', 'text', 'UAE interest ' || case when v_ftz is null then 'with unknown Free Trade Zone status' else 'on the mainland (no FTZ)' end || ' — place with local UAE insurers');
      if pol.id is not null then v_reasons := array_append(v_reasons, 'UAE interests are checked individually'::text); end if;
    end if;
  end if;
  -- war & strikes lifted / excluded areas of the policy or the client group (sea transit)
  if v_mode = 'sea' and (pol.id is not null or grp.id is not null) then
    for v_wa in
      select distinct on (a.code) a.*, x.buyback_permille, x.ncb_pct
        from public.war_exclusions x join public.war_areas a on a.code = x.area_code
       where x.active and ((pol.id is not null and x.policy_id = pol.id) or (grp.id is not null and x.group_id = grp.id))
       order by a.code, x.policy_id nulls last
    loop
      v_touch := false;
      if v_wa.kind = 'coast' then
        -- a country with two coasts: the port decides; no or unknown port → both coasts count
        foreach v_role in array array['o','d'] loop
          v_cc := case v_role when 'o' then o_c.iso2 else d_c.iso2 end;
          v_place := lower(coalesce(case v_role when 'o' then p->>'origin_place' else p->>'dest_place' end, ''));
          if v_cc = v_wa.country then
            v_hit := v_place <> '' and exists (select 1 from unnest(v_wa.ports) pt where v_place like '%' || lower(pt) || '%');
            if v_hit then v_touch := true;
            elsif not exists (select 1 from public.war_areas b, unnest(b.ports) pt where b.country = v_cc and b.code <> v_wa.code and v_place <> '' and v_place like '%' || lower(pt) || '%') then
              v_touch := true;
              if not (v_alerts @> jsonb_build_array(jsonb_build_object('level', 'orange', 'text', 'Port in ' || (select name from public.countries where iso2 = v_cc) || ' not stated or not known — both coasts assumed'))) then
                v_alerts := v_alerts || jsonb_build_object('level', 'orange', 'text', 'Port in ' || (select name from public.countries where iso2 = v_cc) || ' not stated or not known — both coasts assumed'); end if;
            end if;
          end if;
        end loop;
        if v_wa.country = any(v_transit) then v_touch := true; end if;
      else
        -- a sea: ports or countries on it, transit through it, or the routing via Suez
        if o_c.iso2 = any(v_wa.countries) or d_c.iso2 = any(v_wa.countries) or v_transit && v_wa.countries then v_touch := true; end if;
        if exists (select 1 from unnest(v_wa.ports) pt where lower(coalesce(p->>'origin_place', '') || ' | ' || coalesce(p->>'dest_place', '')) like '%' || lower(pt) || '%') then v_touch := true; end if;
        if v_wa.code = 'red_sea' then
          if v_red = 'yes' then v_touch := true;
          elsif v_red = 'auto' and ((o_c.sea_zone = any(array[5,6,11,12]) and d_c.sea_zone = any(array[9,10,14,15,16,17,18,19]))
                                 or (d_c.sea_zone = any(array[5,6,11,12]) and o_c.sea_zone = any(array[9,10,14,15,16,17,18,19]))) then
            v_touch := true;
            v_alerts := v_alerts || jsonb_build_object('level', 'orange', 'text', 'Routing not stated — Suez / Red Sea assumed for this trade lane');
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
                    case when v_bb_all then ' — buy-back +' || trim_scale(round(v_bb_pm, 4)) || ' ‰ net' else ' — no buy-back terms set' end);
    end if;
  end if;
  -- referral triggers
  v_year := nullif(regexp_replace(coalesce(v_details->>'vessel_year', ''), '\D', '', 'g'), '')::int;
  v_pieces := nullif(regexp_replace(coalesce(v_details->>'pieces', ''), '[^0-9.]', '', 'g'), '')::numeric;
  v_kg := nullif(regexp_replace(coalesce(v_details->>'weight_kg', ''), '[^0-9.]', '', 'g'), '')::numeric;
  v_store := v_details->>'storage';
  if com.oc_class in ('used','cars_used') or com.id in ('machinery_used','vehicles_used') then
    v_alerts := v_alerts || jsonb_build_object('level', 'yellow', 'text', 'Used goods — pre-shipment exception report required; JC2008/023 (used machinery)'); end if;
  if v_deck or v_pack ilike 'unpacked%' or (v_kg is not null and v_kg / greatest(coalesce(v_pieces, 1), 1) >= 25000) then
    v_alerts := v_alerts || jsonb_build_object('level', 'yellow', 'text', 'On deck / unpacked / heavy lift — marine warranty survey (MWS) may be required'); end if;
  if v_year is not null and v_year > 1900 and extract(year from current_date)::int - v_year > 20 then
    v_alerts := v_alerts || jsonb_build_object('level', 'yellow', 'text', 'Vessel built ' || v_year || ' (over 20 years) — Institute Classification Clause CL354, additional premium'); end if;
  if v_store in ('30','60') then
    v_alerts := v_alerts || jsonb_build_object('level', 'yellow', 'text', 'Storage before / after transit ' || case v_store when '30' then 'over 30 days' else 'over 60 days' end || ' — refer to underwriters'); end if;
  if com.on_request then v_alerts := v_alerts || jsonb_build_object('level', 'yellow', 'text', 'Cargo type is on the excluded / refer list'); end if;
  if v_status = 'quoted' and array_length(v_reasons, 1) is not null then
    v_status := 'on_request';
  end if;
  if v_status = 'quoted' and array_length(v_war_names, 1) is not null and v_bb_all then
    -- the same shipment with war & strikes bought back for the excluded areas
    v_rate_incl := round((v_total_pm + v_bb_pm * f_int) / 10, 4);
    v_net_incl := greatest(round(round(v_si * v_rate_incl / 100, 2) * (1 - coalesce(v_disc, 0) / 100), 2), coalesce(v_min, 0));
  end if;
  if v_detail is not null then
    v_detail := v_detail || jsonb_build_object('war_excluded', v_war_x, 'rate_pct_incl_buyback', v_rate_incl, 'premium_incl_buyback', v_net_incl, 'freight', v_freight);
  end if;

  insert into public.indications(user_id, company, commodity_id, goods_description, packaging, conveyance,
      origin_country, origin_place, dest_country, dest_place, departure_date, invoice_value, currency,
      uplift_pct, sum_insured, cover, war_strikes, status, rate_pct, premium_gross, discount_pct, premium,
      min_applied, reasons, conditions, vessel, incoterm, insured_party, on_deck, interest_only, calc_detail,
      insured_name, insured_address, customer_ref, source, ext_hssc, ext_liw, office_id, policy_id, intake, quote_requested_at,
      transit_countries, insured_country, ftz, freight_value, red_sea, details, war_excluded)
  values (prof.id, coalesce(ofc.name, prof.company), com.id, left(trim(p->>'goods_description'), 300), left(nullif(v_pack, ''), 100), v_conv,
      o_c.iso2, left(nullif(trim(p->>'origin_place'), ''), 100), d_c.iso2, left(nullif(trim(p->>'dest_place'), ''), 100), v_dep, v_inv, v_cur,
      v_uplift, v_si, v_cover, v_war,
      case when v_hide then 'on_request' else v_status end,
      case when v_status = 'quoted' and not v_hide then v_rate end, case when v_status = 'quoted' and not v_hide then v_gross end,
      case when v_status = 'quoted' and not v_hide then coalesce(v_disc, 0) else 0 end, case when v_status = 'quoted' and not v_hide then v_net end,
      v_min_hit and not v_hide, case when v_hide then '{}'::text[] else v_reasons end, v_cond, left(v_vessel, 100), v_incoterm, v_party, v_deck, v_interest,
      case when prof.is_admin then v_detail end,
      left(nullif(trim(coalesce(p->>'insured_name', '')), ''), 150), left(nullif(trim(coalesce(p->>'insured_address', '')), ''), 250),
      left(nullif(trim(coalesce(p->>'customer_ref', '')), ''), 60), case when p->>'source' = 'upload' then 'upload' else 'form' end, v_hssc, v_liw,
      ofc.id, pol.id, v_hide, case when v_hide then now() end,
      v_transit, v_ins_cc, v_ftz, nullif(v_freight, 0), v_red, v_details, v_war_names)
  returning * into r;

  insert into public.indication_internal(indication_id, status, rate_pct, premium_gross, premium, min_applied, reasons, notes, calc_detail, alerts, war)
  values (r.id, v_status, case when v_status = 'quoted' then v_rate end, case when v_status = 'quoted' then v_gross end,
          case when v_status = 'quoted' then v_net end, v_min_hit, v_reasons, v_notes, v_detail, v_alerts,
          jsonb_build_object('areas', v_war_x, 'rate_pct_incl', v_rate_incl, 'premium_incl', v_net_incl));

  if v_hide then
    -- intake: the request goes straight to the brokers, the client gets a confirmation without figures
    r.ref := public.ensure_ref(r.id);
    perform public.emit('quote_request', jsonb_build_object('indication_id', r.id, 'ref', r.ref, 'email', prof.email,
      'name', prof.full_name, 'company', coalesce(ofc.name, prof.company), 'goods', r.goods_description, 'conveyance', r.conveyance,
      'origin', r.origin_country, 'origin_place', r.origin_place, 'dest', r.dest_country, 'dest_place', r.dest_place,
      'vessel', r.vessel, 'incoterm', r.incoterm, 'insured_party', r.insured_party, 'sum_insured', r.sum_insured, 'currency', r.currency,
      'status', v_status, 'premium', case when v_status = 'quoted' then v_net end, 'comment', null,
      'policy', pol.policy_no, 'office', ofc.name));
    return to_jsonb(r) || jsonb_build_object('origin_name', o_c.name, 'dest_name', d_c.name, 'commodity_name', com.name, 'intake', true);
  end if;

  return to_jsonb(r) || jsonb_build_object('origin_name', o_c.name, 'dest_name', d_c.name, 'commodity_name', com.name,
                                           'deductible_text', to_jsonb(v_ded))
         || case when prof.is_admin then jsonb_build_object('calc_detail', v_detail, 'notes', to_jsonb(v_notes), 'alerts', v_alerts) else '{}'::jsonb end;
end $$;
grant execute on function public.calc_indication(jsonb) to authenticated;

create or replace function public.my_history(p_limit int default 200) returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(to_jsonb(s) order by s.created_at desc), '[]'::jsonb) from (
    select i.id, i.ref, i.created_at, i.goods_description, i.commodity_id, i.conveyance, i.origin_country, i.origin_place,
           i.dest_country, i.dest_place, i.departure_date, i.invoice_value, i.currency, i.uplift_pct, i.sum_insured, i.cover,
           i.war_strikes, i.status, i.rate_pct, i.premium_gross, i.discount_pct, i.premium, i.min_applied, i.reasons, i.conditions,
           i.packaging, i.vessel, i.incoterm, i.insured_party, i.on_deck, i.interest_only, i.insured_name, i.insured_address,
           i.customer_ref, i.source, i.ext_hssc, i.ext_liw, i.pdf_downloaded_at, i.quote_requested_at, i.customer_comment,
           i.office_id, i.intake, i.transit_countries, i.insured_country, i.ftz, i.freight_value, i.red_sea, i.details, i.war_excluded
      from public.indications i
     where i.user_id = auth.uid() and not i.hidden_by_user
     order by i.created_at desc limit least(greatest(p_limit, 1), 500)
  ) s
$$;
grant execute on function public.my_history(int) to authenticated;

notify pgrst, 'reload schema';
