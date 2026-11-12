-- =====================================================================
-- FREIGHTCON update 2026-10-20d: agricultural products quotable
-- Run once in Supabase → SQL Editor after update_2026-10-20c.sql. Safe to re-run.
-- Loadings and covers are a starting point — adjust in Internal → Rates → Cargo types.
-- =====================================================================

-- bagged / containerised agricultural goods: approved new goods schedule + 50 % for moisture, sweat, mould, pests
insert into public.commodities(id, name, description, sea_table, air_class, loading_pct, allowed_covers, on_request, conditions, sort)
values ('agri_bagged', 'Agricultural products (bagged / in containers)',
        'Coffee, cocoa, rice, beans, seeds, nuts, spices in bags, cartons or big bags',
        'sea_new', 'new', 50, array['icc_a','icc_b','icc_c'], false,
        'Excluding loss or damage caused by inherent vice, natural loss in weight or volume, insufficient drying, mould or infestation already present at loading. Containers to be clean, dry and odour-free; claims subject to survey. Shortage: deductible 0.5 % of the sum insured.',
        98)
on conflict (id) do update set name = excluded.name, description = excluded.description, sea_table = excluded.sea_table,
  air_class = excluded.air_class, loading_pct = excluded.loading_pct, allowed_covers = excluded.allowed_covers,
  on_request = excluded.on_request, conditions = excluded.conditions;

-- bulk agricultural goods: approved new goods schedule, ICC (B) or (C) only, shortage deductible
update public.commodities
   set name = 'Agricultural bulk (grain, oilseeds, fertiliser)',
       description = 'Grain, oilseeds, meal, sugar, fertiliser shipped in bulk',
       sea_table = 'sea_new', air_class = null, loading_pct = 0,
       allowed_covers = array['icc_b','icc_c'], on_request = false, sort = 100,
       conditions = 'Institute Cargo Clauses (B) or (C) only. Shortage and natural loss: deductible 0.5 % of the sum insured, ascertained by draft survey or shore scale at loading and discharge. Excluding heating, sweating and contamination unless caused by an insured peril.'
 where id = 'agri_bulk';
