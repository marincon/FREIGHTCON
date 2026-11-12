-- =====================================================================
-- FREIGHTCON update 2026-10-20h
-- Optional cover extensions per cargo type:
--   HSSC     heating, sweating & spontaneous combustion   + 0.15 ‰ (0.015 %)
--   LiW/DiW  loss in weight / difference in weight        + 0.75 ‰ (0.075 %), deductible 0.5 % of SI
-- Offered only where the cargo type allows it (Internal → Rates → Cargo types).
-- The surcharge is added flat to the rate (not multiplied by class or cover
-- factors); the seller's / buyer's interest factor applies to it as well.
-- Run once after update g.
-- =====================================================================

alter table public.commodities add column if not exists ext_hssc boolean not null default false;
alter table public.commodities add column if not exists ext_liw  boolean not null default false;
alter table public.indications add column if not exists ext_hssc boolean not null default false;
alter table public.indications add column if not exists ext_liw  boolean not null default false;

update public.commodities set ext_hssc = true, ext_liw = true where id in ('agri_bulk', 'agri_bagged');
-- without the extension shortage / natural loss is not covered, so the 0.5 % deductible belongs to the extension
update public.commodities set deductible = 'EUR / USD 500 each and every loss' where id = 'agri_bagged' and deductible like 'Shortage:%';
update public.commodities set deductible = 'EUR / USD 1,000 each and every loss' where id = 'agri_bulk' and deductible like 'Shortage and natural loss%';
update public.commodities set conditions = replace(conditions, 'Excluding heating, sweating and contamination unless caused by an insured peril.',
  'Excluding heating, sweating, spontaneous combustion, contamination and loss in weight unless caused by an insured peril or covered by an extension.')
 where id = 'agri_bulk';

insert into public.settings(key, value, note) values
  ('extensions', '{"hssc":{"label":"Heating, sweating & spontaneous combustion (HSSC)","permille":0.15,"clause":"Extended to cover heating, sweating and spontaneous combustion."},"liw":{"label":"Loss / difference in weight (LiW / DiW)","permille":0.75,"deductible":"0.5 % of the sum insured","clause":"Extended to cover loss in weight / difference in weight (shortage), subject to a deductible of 0.5 % of the sum insured."}}',
   'Optional cover extensions: surcharge in per mille of the sum insured, clause text and deductible')
on conflict (key) do nothing;

drop function if exists public.list_commodities();
create or replace function public.list_commodities() returns table(id text, name text, description text, group_name text, allowed_covers text[],
  conveyances text[], on_request boolean, deck_allowed boolean, deductible text, ext_hssc boolean, ext_liw boolean)
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
         c.deductible, c.ext_hssc, c.ext_liw
    from public.commodities c
    left join public.rate_tables t on t.id = c.sea_table
   where c.active and public.is_approved()
   order by c.sort, c.name
$$;
grant execute on function public.list_commodities() to authenticated;

-- customers see the extension labels and the LiW deductible, not the surcharges
create or replace function public.public_settings() returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'maintenance',     coalesce(public.setting('maintenance'), 'false'::jsonb),
    'terms_version',   public.setting('terms_version'),
    'uplift_pct',      public.setting('uplift_pct'),
    'deductible_text', public.setting('deductible_text'),
    'brand_name',      public.setting('brand_name'),
    'company_legal',   public.setting('company_legal'),
    'extensions',      jsonb_build_object(
        'hssc', jsonb_build_object('label', public.setting('extensions')#>'{hssc,label}'),
        'liw',  jsonb_build_object('label', public.setting('extensions')#>'{liw,label}', 'deductible', public.setting('extensions')#>'{liw,deductible}')))
$$;

-- ---------- the calculation (as update g, plus extensions) ----------
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
  v_hssc     boolean := coalesce((p->>'ext_hssc')::boolean, false);
  v_liw      boolean := coalesce((p->>'ext_liw')::boolean, false);
  v_ext_pm   numeric := 0; v_hssc_pm numeric := 0; v_liw_pm numeric := 0;
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
  if not com.ext_hssc then v_hssc := false; end if;
  if not com.ext_liw  then v_liw  := false; end if;
  select * into o_c from public.countries where iso2 = upper(p->>'origin_country'); if not found then raise exception 'invalid origin country'; end if;
  select * into d_c from public.countries where iso2 = upper(p->>'dest_country');   if not found then raise exception 'invalid destination country'; end if;
  select * into o_r from public.regions where id = o_c.region_id;
  select * into d_r from public.regions where id = d_c.region_id;

  v_si   := round(v_inv * (1 + v_uplift / 100), 2);
  v_cond := com.conditions;
  if v_hssc then v_cond := concat_ws(' ', v_cond, coalesce(public.setting('extensions')#>>'{hssc,clause}', 'Extended to cover heating, sweating and spontaneous combustion.')); end if;
  if v_liw  then v_cond := concat_ws(' ', v_cond, coalesce(public.setting('extensions')#>>'{liw,clause}', 'Extended to cover loss in weight / difference in weight (shortage), subject to a deductible of 0.5 % of the sum insured.')); end if;
  v_ded  := coalesce(com.deductible, (public.setting('deductible_text'))#>>'{}');
  if v_liw then v_ded := concat_ws('; ', v_ded, 'loss / difference in weight: ' || coalesce(public.setting('extensions')#>>'{liw,deductible}', '0.5 % of the sum insured')); end if;
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
      -- optional extensions: flat per-mille surcharges on the sum insured, not multiplied by class or cover factors
      if v_hssc then v_hssc_pm := coalesce((public.setting('extensions')#>>'{hssc,permille}')::numeric, 0.15); end if;
      if v_liw  then v_liw_pm  := coalesce((public.setting('extensions')#>>'{liw,permille}')::numeric, 0.75); end if;
      v_ext_pm := v_hssc_pm + v_liw_pm;
      v_total_pm := (v_cargo_pm + v_ext_pm + v_war_pm + v_crisis) * f_int;
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
        'cargo_permille', round(v_cargo_pm, 4), 'war_permille', v_war_pm, 'crisis_permille', v_crisis, 'hssc_permille', v_hssc_pm, 'liw_permille', v_liw_pm, 'rate_permille', round(v_total_pm, 4));
    end if;
  end if;

  insert into public.indications(user_id, company, commodity_id, goods_description, packaging, conveyance,
      origin_country, origin_place, dest_country, dest_place, departure_date, invoice_value, currency,
      uplift_pct, sum_insured, cover, war_strikes, status, rate_pct, premium_gross, discount_pct, premium,
      min_applied, reasons, conditions, vessel, incoterm, insured_party, on_deck, interest_only, calc_detail,
      insured_name, insured_address, customer_ref, source, ext_hssc, ext_liw)
  values (prof.id, prof.company, com.id, left(trim(p->>'goods_description'), 300), left(nullif(v_pack, ''), 100), v_conv,
      o_c.iso2, left(nullif(trim(p->>'origin_place'), ''), 100), d_c.iso2, left(nullif(trim(p->>'dest_place'), ''), 100), v_dep, v_inv, v_cur,
      v_uplift, v_si, v_cover, v_war, v_status,
      case when v_status = 'quoted' then v_rate end, case when v_status = 'quoted' then v_gross end,
      case when v_status = 'quoted' then coalesce(v_disc, 0) else 0 end, case when v_status = 'quoted' then v_net end,
      v_min_hit, v_reasons, v_cond, left(v_vessel, 100), v_incoterm, v_party, v_deck, v_interest, v_detail,
      left(nullif(trim(coalesce(p->>'insured_name', '')), ''), 150), left(nullif(trim(coalesce(p->>'insured_address', '')), ''), 250),
      left(nullif(trim(coalesce(p->>'customer_ref', '')), ''), 60), case when p->>'source' = 'upload' then 'upload' else 'form' end, v_hssc, v_liw)
  returning * into r;

  return to_jsonb(r) || jsonb_build_object('origin_name', o_c.name, 'dest_name', d_c.name, 'commodity_name', com.name,
                                           'deductible_text', to_jsonb(v_ded));
end $$;
grant execute on function public.calc_indication(jsonb) to authenticated;

-- history: include the extension flags so "Open" / "Recalculate" restores them
create or replace function public.my_history(p_limit int default 200) returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(to_jsonb(s) order by s.created_at desc), '[]'::jsonb) from (
    select i.id, i.ref, i.created_at, i.goods_description, i.commodity_id, i.conveyance, i.origin_country, i.origin_place,
           i.dest_country, i.dest_place, i.departure_date, i.invoice_value, i.currency, i.uplift_pct, i.sum_insured, i.cover,
           i.war_strikes, i.status, i.rate_pct, i.premium_gross, i.discount_pct, i.premium, i.min_applied, i.reasons, i.conditions,
           i.packaging, i.vessel, i.incoterm, i.insured_party, i.on_deck, i.interest_only, i.insured_name, i.insured_address,
           i.customer_ref, i.source, i.ext_hssc, i.ext_liw, i.pdf_downloaded_at, i.quote_requested_at, i.customer_comment
      from public.indications i
     where i.user_id = auth.uid() and not i.hidden_by_user
     order by i.created_at desc limit least(greatest(p_limit, 1), 500)
  ) s
$$;
grant execute on function public.my_history(int) to authenticated;

notify pgrst, 'reload schema';
