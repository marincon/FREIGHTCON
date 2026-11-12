-- =====================================================================
-- FREIGHTCON update 2026-10-20e: own cargo rating model
-- Run once in Supabase → SQL Editor after update_2026-10-20c.sql (and d). Safe to re-run;
-- re-running resets the cargo catalogue factors to the values below.
--
-- Rating model (all rates in per mille of the sum insured):
--
--   cargo ‰ = route base rate (by mode, war excluded)
--             × cargo class factor × cover factor × conveyance factor × packing factor
--             × on-deck loading × theft loading (land legs of theft-attractive goods)
--             × (1 + extra loading %)
--   war ‰   = war & strikes per mode (sea/air) or strikes only (land) + country crisis surcharge
--   total ‰ = (cargo ‰ + war ‰) × interest factor (seller's/buyer's interest only)
--   premium = sum insured × total ‰, less client discount, at least the minimum premium
--
-- Route base rates
--   sea         zone-to-zone matrix (19 zones), schedule rates minus the war share they contain
--   air freight zone-to-zone matrix (12 zones)
--   air charter zone-to-zone matrix (12 zones)
--   road / rail by route band: domestic · regional (same sea zone) · long-haul (different zones)
-- =====================================================================

-- ---------- cargo catalogue: underwriting attributes ----------
alter table public.commodities add column if not exists class_factor     numeric(6,3) not null default 1 check (class_factor > 0);
alter table public.commodities add column if not exists theft_attractive boolean not null default false;
alter table public.commodities add column if not exists temp_controlled  boolean not null default false;
alter table public.commodities add column if not exists deductible       text;
alter table public.commodities add column if not exists max_sum_insured  numeric(14,2);   -- in EUR/USD; above → on request
alter table public.commodities add column if not exists group_name       text;

-- ---------- rating settings ----------
insert into public.settings(key, value, note) values
  ('conveyance_factors', '{"sea_container":1.0,"sea_breakbulk":1.15,"air":1.0,"air_charter":1.0,"road":1.0,"rail":1.0}',
     'Factor on the cargo rate per conveyance (breakbulk/RoRo handling risk)'),
  ('packing_factors', '{"":1.0,"Cartons on pallets":1.0,"Wooden crates / cases":1.0,"Loose in container":1.1,"Bags / big bags":1.1,"Drums / IBCs":1.1,"Bulk":1.0,"Unpacked, lashed":1.25,"Other":1.1}',
     'Factor on the cargo rate per packaging chosen in the form'),
  ('land_rates', '{"domestic":0.5,"regional":0.8,"long_haul":2.0}',
     'Road / rail base rate in per mille: same country · same sea zone · different zones (e.g. China–Europe rail)'),
  ('sea_war_permille',  '0.5', 'War & strikes on sea transit, per mille (not affected by cargo class or cover)'),
  ('land_strikes_permille', '0.1', 'Strikes, riots & civil commotion on road / rail, per mille'),
  ('theft_land_factor', '1.5', 'Loading on the cargo rate of theft-attractive goods on road / rail'),
  ('land_min_premium',  '75',  'Minimum premium for road / rail shipments'),
  ('land_groups', '{"europe_asia":[5,6,10,11,12,13,14,15],"africa":[6,7,8,9],"americas":[1,2,3,4]}',
     'Sea zones connected by land: road / rail between zones of the same group (long-haul band)')
on conflict (key) do nothing;
update public.settings set value = '0.5' where key = 'air_war_permille' and value is null;

-- sea and air schedules: base rate of general cargo (class factor 1.0)
update public.rate_tables set name = 'Sea · base rates (general cargo)', notes = 'Route base rate for class factor 1.0. Rates include war & strikes of 0.5 ‰ (deducted and charged separately). Incl. pre- and on-carriage.' where id = 'sea_new';
update public.rate_tables set name = 'Air freight · base rates', used_loading_pct = null, cars_loading_pct = null, household_flat_permille = null,
  notes = 'Route base rate for class factor 1.0, excl. war & strikes. On-carriage from destination airport included.' where id = 'air_freight';
update public.rate_tables set name = 'Air charter · base rates', used_loading_pct = null, cars_loading_pct = null, household_flat_permille = null,
  notes = 'Route base rate for class factor 1.0, excl. war & strikes and transhipments.' where id = 'air_charter';
update public.rate_tables set name = name || ' (reference only)', notes = 'Bertling reference schedule — not used by the calculation. Its rates are about ' ||
  case id when 'sea_used' then '1.30' when 'sea_newcars' then '1.20' when 'sea_usedcars' then '1.56' when 'sea_household' then '2.00' end || ' × the base rates.'
 where id in ('sea_used','sea_newcars','sea_usedcars','sea_household') and name not like '%(reference only)';

-- ---------- the cargo catalogue ----------
-- id, group, name, description, class factor, covers, by air, theft-attr., temp-ctrl., deductible, max SI, on request, conditions
create temporary table _cat (id text, grp text, name text, description text, f numeric, covers text[], air boolean, ta boolean, temp boolean,
                             ded text, max_si numeric, onreq boolean, cond text, sort int) on commit drop;
insert into _cat values
 ('general',        'General & industrial', 'General cargo (packed)', 'Packed goods not listed elsewhere', 1.0, array['icc_a','icc_b','icc_c'], true, false, false, null, null, false, null, 10),
 ('machinery_new',  'General & industrial', 'Machinery & equipment (new)', 'New machines, tools, industrial equipment, properly packed', 1.0, array['icc_a','icc_b','icc_c'], true, false, false, null, null, false,
   'Excluding mechanical and electrical derangement unless caused by an insured peril. Cost of repair limited to parts and labour; no cover for loss of use.', 20),
 ('spare_parts',    'General & industrial', 'Spare parts & components', 'Automotive and industrial parts, packed', 1.0, array['icc_a','icc_b','icc_c'], true, false, false, null, null, false, null, 25),
 ('machinery_used', 'General & industrial', 'Machinery & equipment (used)', 'Second-hand machines, tools and parts', 1.3, array['icc_a','icc_b','icc_c'], true, false, false,
   'EUR / USD 1,000 each and every loss', null, false,
   'Used goods: excluding pre-existing damage, rust, oxidation, scratching, denting and mechanical or electrical derangement unless caused by an insured peril. Pre-shipment survey may be required above 250,000.', 30),
 ('steel',          'General & industrial', 'Steel & metal products', 'Coils, bars, pipes, profiles, sheets', 0.8, array['icc_a','icc_b','icc_c'], true, false, false,
   'EUR / USD 1,000 each and every loss', null, false,
   'Excluding rust, oxidation and discolouration unless caused by an insured peril; wet damage covered only if caused by sea water. Pre-shipment survey report (Lloyd''s Agent or equivalent) for unpacked steel.', 40),
 ('textiles',       'Consumer goods', 'Textiles, garments & footwear', 'Clothing, shoes, fabrics in cartons', 1.2, array['icc_a','icc_b','icc_c'], true, true, false, null, null, false,
   'Containers to be sealed. Theft: cover only for theft of entire packages.', 50),
 ('electronics',    'Consumer goods', 'Electronics & IT', 'Consumer electronics, phones, computers, components', 2.0, array['icc_a','icc_b','icc_c'], true, true, false,
   'EUR / USD 1,000 each and every loss; theft 10 % of loss, min. 1,000', 1000000, false,
   'Theft-attractive goods: containers sealed with high-security seals; road legs only with secured parking and no unattended stops; non-delivery of entire packages covered only if reported within 30 days. Excluding electrical and mechanical derangement unless caused by external damage.', 60),
 ('food_dry',       'Food & agriculture', 'Foodstuffs (non-perishable)', 'Dry, canned and packed food and beverages', 1.3, array['icc_a','icc_b','icc_c'], true, false, false,
   'EUR / USD 500 each and every loss', null, false,
   'Excluding inherent vice, natural loss in weight and expiry of shelf life. Food-grade, clean and odour-free containers required. Rejection by import authorities not covered.', 70),
 ('agri_bagged',    'Food & agriculture', 'Agricultural products (bagged / in containers)', 'Coffee, cocoa, rice, beans, seeds, nuts, spices in bags, cartons or big bags', 1.5, array['icc_a','icc_b','icc_c'], true, false, false,
   'Shortage: 0.5 % of the sum insured; other losses EUR / USD 500', null, false,
   'Excluding inherent vice, natural loss in weight or volume, insufficient drying, mould or infestation present at loading. Containers clean, dry and odour-free; claims subject to survey.', 80),
 ('agri_bulk',      'Food & agriculture', 'Agricultural bulk (grain, oilseeds, fertiliser)', 'Grain, oilseeds, meal, sugar, fertiliser shipped in bulk', 1.0, array['icc_b','icc_c'], false, false, false,
   'Shortage and natural loss: 0.5 % of the sum insured', null, false,
   'Institute Cargo Clauses (B) or (C) only. Quantity by draft survey or shore scale at loading and discharge. Excluding heating, sweating and contamination unless caused by an insured peril. Vessel subject to the Institute Classification Clause.', 90),
 ('reefer',         'Food & agriculture', 'Refrigerated & frozen goods', 'Fruit, meat, fish, dairy and other temperature-controlled cargo', 2.0, array['icc_a'], true, false, true,
   'EUR / USD 2,500 each and every loss', 500000, false,
   'Institute Frozen / Chilled Food Clauses (A) incl. 24 hours refrigerating machinery breakdown. Temperature records required; pre-cooled cargo; excluding deterioration from delay or improper pre-cooling.', 100),
 ('chemicals',      'Chemicals & energy', 'Chemicals & plastics (non-hazardous)', 'Plastics granulate, resins, non-dangerous chemicals in bags, drums, IBCs or flexitanks', 1.25, array['icc_a','icc_b','icc_c'], true, false, false,
   'EUR / USD 1,000 each and every loss; liquids: leakage and shortage 0.5 % of the sum insured', null, false,
   'Excluding contamination unless caused by an insured peril, inherent vice and loss of specification. Liquids in new or reconditioned drums/IBCs only; flexitanks subject to approval of the manufacturer.', 110),
 ('dangerous',      'Chemicals & energy', 'Dangerous goods (IMDG / ADR / IATA)', 'Classified hazardous cargo, classes 2–6, 8 and 9', 1.75, array['icc_a','icc_b','icc_c'], true, false, false,
   'EUR / USD 2,500 each and every loss', 500000, false,
   'Classes 1 (explosives) and 7 (radioactive) excluded. Goods to be classified, packed, labelled and declared according to IMDG / ADR / IATA DGR; warranted no breach of dangerous goods regulations.', 120),
 ('pharma',         'Chemicals & energy', 'Pharmaceuticals & medical', 'Medicines, vaccines and medical devices', 2.5, array['icc_a'], true, true, true,
   'EUR / USD 2,500 each and every loss', 1000000, false,
   'Temperature-controlled shipments: data loggers required; temperature deviation covered only if caused by an insured peril or refrigerating machinery breakdown of at least 24 hours. Theft-attractive goods conditions apply.', 130),
 ('vehicles_new',   'Vehicles & personal effects', 'Vehicles (new)', 'Cars, trucks, motorcycles, agricultural and construction machines — new', 1.2, array['icc_a','icc_c'], true, true, false,
   'EUR / USD 500 each and every loss', null, false,
   'RoRo or container only. Excluding scratching, denting and chipping below EUR / USD 250 per unit, loss of loose accessories and mechanical derangement unless caused by an insured peril.', 140),
 ('vehicles_used',  'Vehicles & personal effects', 'Vehicles (used)', 'Used cars, lorries, mobile construction machines', 1.56, array['icc_a','icc_c'], false, true, false,
   'EUR / USD 1,000 each and every loss', null, false,
   'RoRo or container only. Excluding pre-existing damage, rust, scratches, denting and mechanical or electrical derangement unless caused by an insured peril. Condition report at loading required.', 150),
 ('household',      'Vehicles & personal effects', 'Household goods & personal effects', 'Removals, personal belongings — no artwork or antiques', 2.0, array['icc_a','icc_c'], true, false, false,
   'EUR / USD 250 each and every loss', 250000, false,
   'Professionally packed removals only; valued inventory required. Fragile items (glass, china, marble) max. 15 % of the sum insured; excluding mechanical derangement of appliances and wear and tear.', 160),
 ('project',        'Specialist cargo', 'Project & heavy-lift cargo', 'Out-of-gauge, heavy lift, project shipments', 2.0, array['icc_a','icc_b','icc_c'], false, false, false, null, null, true,
   'Marine warranty survey, lifting plans and stowage approval required.', 170),
 ('valuables',      'Specialist cargo', 'Art, jewellery & valuables', null, 3.0, array['icc_a'], false, true, false, null, null, true, null, 180),
 ('livestock',      'Specialist cargo', 'Live animals', null, 3.0, array['icc_a'], false, false, false, null, null, true, null, 190);

insert into public.commodities(id, name, description, sea_table, air_class, class_factor, allowed_covers, theft_attractive, temp_controlled,
                               deductible, max_sum_insured, on_request, conditions, group_name, sort, loading_pct, active)
select id, name, description, case when onreq then null else 'sea_new' end, case when air and not onreq then 'new' end, f, covers, ta, temp,
       ded, max_si, onreq, cond, grp, sort, 0, true
  from _cat
on conflict (id) do update set name = excluded.name, description = excluded.description, sea_table = excluded.sea_table,
  air_class = excluded.air_class, class_factor = excluded.class_factor, allowed_covers = excluded.allowed_covers,
  theft_attractive = excluded.theft_attractive, temp_controlled = excluded.temp_controlled, deductible = excluded.deductible,
  max_sum_insured = excluded.max_sum_insured, on_request = excluded.on_request, conditions = excluded.conditions,
  group_name = excluded.group_name, sort = excluded.sort, loading_pct = 0, active = true;

-- ---------- cargo list for the form (no rates) ----------
drop function if exists public.list_commodities();
create or replace function public.list_commodities() returns table(id text, name text, description text, group_name text, allowed_covers text[],
  conveyances text[], on_request boolean, deck_allowed boolean, deductible text)
language sql stable security definer set search_path = public as $$
  select c.id, c.name, c.description, c.group_name, c.allowed_covers,
         case when c.on_request then array['sea_container','sea_breakbulk','air','air_charter','road','rail']
              else array_remove(array[
                case when c.sea_table is not null then 'sea_container' end,
                case when c.sea_table is not null then 'sea_breakbulk' end,
                case when c.air_class is not null then 'air' end,
                case when c.air_class is not null then 'air_charter' end,
                'road', 'rail'], null) end,
         c.on_request,
         coalesce(t.deck_allowed, false) and c.id not in ('vehicles_new','vehicles_used','household','reefer','pharma','electronics'),
         c.deductible
    from public.commodities c
    left join public.rate_tables t on t.id = c.sea_table
   where c.active and public.is_approved()
   order by c.sort, c.name
$$;
grant execute on function public.list_commodities() to authenticated;

-- ---------- the calculation ----------
create or replace function public.calc_indication(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  prof public.profiles; com public.commodities; o_c public.countries; d_c public.countries; o_r public.regions; d_r public.regions;
  tb public.rate_tables;
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
  v_pack     text := coalesce(nullif(trim(coalesce(p->>'packaging', '')), ''), '');
  v_mode     text; v_table text; zo int; zd int; v_band text;
  v_base numeric; v_cell numeric;
  f_class numeric; f_cover numeric; f_conv numeric; f_pack numeric; f_deck numeric := 1; f_theft numeric := 1; f_load numeric; f_int numeric := 1;
  v_cargo_pm numeric; v_war_pm numeric := 0; v_crisis numeric := 0; v_total_pm numeric;
  v_si numeric; v_rate numeric; v_gross numeric; v_disc numeric; v_net numeric; v_min numeric; v_limit numeric;
  v_min_hit boolean := false; v_status text := 'quoted'; v_reasons text[] := '{}'; v_cond text; v_detail jsonb; v_ded text;
  r public.indications;
begin
  select * into prof from public.profiles where id = auth.uid();
  if not found or not prof.approved or prof.rejected then raise exception 'not authorised'; end if;
  if coalesce((public.setting('maintenance'))::text::boolean, false) and not prof.is_admin then raise exception 'maintenance'; end if;

  if v_conv not in ('sea_container','sea_breakbulk','air','air_charter','road','rail') then raise exception 'invalid conveyance'; end if;
  if v_cover not in ('icc_a','icc_b','icc_c') then raise exception 'invalid cover'; end if;
  if v_cur not in ('EUR','USD') then raise exception 'invalid currency'; end if;
  if v_inv is null or v_inv <= 0 or v_inv > 1000000000 then raise exception 'invalid invoice value'; end if;
  if v_uplift < 0 or v_uplift > 30 then raise exception 'invalid uplift'; end if;
  if length(trim(coalesce(p->>'goods_description', ''))) < 2 then raise exception 'goods description required'; end if;
  if v_incoterm is not null and v_incoterm not in ('EXW','FCA','FAS','FOB','CFR','CIF','CPT','CIP','DAP','DPU','DDP') then raise exception 'invalid incoterm'; end if;
  if v_party is not null and v_party not in ('seller','buyer') then raise exception 'invalid party'; end if;
  if v_conv not in ('sea_container','sea_breakbulk') then v_vessel := null; end if;
  if v_conv <> 'sea_breakbulk' then v_deck := false; end if;

  select * into com from public.commodities where id = p->>'commodity_id' and active;
  if not found then raise exception 'invalid commodity'; end if;
  select * into o_c from public.countries where iso2 = upper(p->>'origin_country'); if not found then raise exception 'invalid origin country'; end if;
  select * into d_c from public.countries where iso2 = upper(p->>'dest_country');   if not found then raise exception 'invalid destination country'; end if;
  select * into o_r from public.regions where id = o_c.region_id;
  select * into d_r from public.regions where id = d_c.region_id;

  v_si   := round(v_inv * (1 + v_uplift / 100), 2);
  v_cond := com.conditions;
  v_ded  := coalesce(com.deductible, (public.setting('deductible_text'))#>>'{}');
  v_mode := case when v_conv in ('air','air_charter') then 'air' when v_conv in ('road','rail') then 'land' else 'sea' end;

  if o_c.sanctioned or d_c.sanctioned or coalesce(o_r.sanctioned, false) or coalesce(d_r.sanctioned, false) then
    v_status := 'sanctioned';
    v_reasons := array['Origin or destination is subject to sanctions — compliance review required'];
  else
    -- ---- route base rate ----
    if v_mode = 'sea' then
      v_table := com.sea_table; zo := o_c.sea_zone; zd := d_c.sea_zone;
    elsif v_mode = 'air' then
      v_table := case when com.air_class is null then null when v_conv = 'air' then 'air_freight' else 'air_charter' end; zo := o_c.air_zone; zd := d_c.air_zone;
    else
      zo := o_c.sea_zone; zd := d_c.sea_zone;
      v_band := case when o_c.iso2 = d_c.iso2 then 'domestic' when zo = zd then 'regional' else 'long_haul' end;
    end if;
    if v_table is not null then select * into tb from public.rate_tables where id = v_table; end if;

    -- ---- referral triggers ----
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
    -- road / rail only between zones that are connected by land (setting land_groups)
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
      v_total_pm := (v_cargo_pm + v_war_pm + v_crisis) * f_int;
      v_rate  := round(v_total_pm / 10, 4);                     -- per mille → %
      v_gross := round(v_si * v_rate / 100, 2);
      v_disc  := coalesce(prof.client_discount_pct, 0);
      v_net   := round(v_gross * (1 - v_disc / 100), 2);
      v_min   := case when v_mode = 'land' then coalesce((public.setting('land_min_premium'))::text::numeric, 75) else coalesce(tb.min_premium, 100) end;
      if v_net < v_min then v_net := v_min; v_min_hit := true; end if;
      v_detail := jsonb_build_object(
        'mode', v_mode, 'table', tb.id, 'table_name', coalesce(tb.name, 'Land · ' || replace(v_band, '_', '-')), 'band', v_band,
        'zone_from', zo, 'zone_to', zd, 'schedule_permille', v_cell, 'base_permille', round(v_base, 4),
        'f_class', f_class, 'f_cover', f_cover, 'f_conveyance', f_conv, 'f_packing', f_pack, 'f_deck', f_deck, 'f_theft', f_theft, 'f_loading', f_load, 'f_interest', f_int,
        'factor', round(f_class * f_cover * f_conv * f_pack * f_deck * f_theft * f_load, 4),
        'cargo_permille', round(v_cargo_pm, 4), 'war_permille', v_war_pm, 'crisis_permille', v_crisis, 'rate_permille', round(v_total_pm, 4));
    end if;
  end if;

  insert into public.indications(user_id, company, commodity_id, goods_description, packaging, conveyance,
      origin_country, origin_place, dest_country, dest_place, departure_date, invoice_value, currency,
      uplift_pct, sum_insured, cover, war_strikes, status, rate_pct, premium_gross, discount_pct, premium,
      min_applied, reasons, conditions, vessel, incoterm, insured_party, on_deck, interest_only, calc_detail)
  values (prof.id, prof.company, com.id, left(trim(p->>'goods_description'), 300), left(nullif(v_pack, ''), 100), v_conv,
      o_c.iso2, left(nullif(trim(p->>'origin_place'), ''), 100), d_c.iso2, left(nullif(trim(p->>'dest_place'), ''), 100), v_dep, v_inv, v_cur,
      v_uplift, v_si, v_cover, v_war, v_status,
      case when v_status = 'quoted' then v_rate end, case when v_status = 'quoted' then v_gross end,
      case when v_status = 'quoted' then coalesce(v_disc, 0) else 0 end, case when v_status = 'quoted' then v_net end,
      v_min_hit, v_reasons, v_cond, left(v_vessel, 100), v_incoterm, v_party, v_deck, v_interest, v_detail)
  returning * into r;

  return to_jsonb(r) || jsonb_build_object('origin_name', o_c.name, 'dest_name', d_c.name, 'commodity_name', com.name,
                                           'deductible_text', to_jsonb(v_ded));
end $$;
grant execute on function public.calc_indication(jsonb) to authenticated;

-- API-Schema-Cache neu laden, damit die neuen Spalten sofort sichtbar sind
notify pgrst, 'reload schema';
