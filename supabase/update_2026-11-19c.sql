-- =====================================================================================================
-- FREIGHTCON update 2026-11-19c: rate units % and per mille
--   * Every schedule (rate matrix) has a rate_unit: 'percent' or 'per_mille'. It is the unit in which brokers
--     see, enter, import and export the rates of that schedule. The rating engine keeps one internal basis
--     (rate_cells.permille), so the unit never changes a calculated premium.
--   * Hierarchy as the rating itself: one-off pool (cover type) -> client group -> client -> subcategory (policy).
--   * Existing schedules (e.g. the Bertling schedules) stay 'per_mille'; new schedules default to 'percent'.
--   * Quotations, certificates and cover notes always show and calculate rates in %. A per mille override in the
--     quotation editor is written to the audit log.
-- Run after update_2026-11-18b.sql. Idempotent.
-- =====================================================================================================

do $$
begin
  if not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'rate_tables' and column_name = 'rate_unit') then
    alter table public.rate_tables add column rate_unit text not null default 'percent';
    -- the established schedules were set up in per mille: they keep it
    update public.rate_tables set rate_unit = 'per_mille';
  end if;
end $$;
alter table public.rate_tables drop constraint if exists rate_tables_rate_unit_chk;
alter table public.rate_tables add constraint rate_tables_rate_unit_chk check (rate_unit in ('percent','per_mille'));

-- display helpers (SQL side): value in per mille -> value in the unit, and back
create or replace function public.rate_from_permille(p_permille numeric, p_unit text) returns numeric
language sql immutable as $$ select case when p_permille is null then null when p_unit = 'percent' then p_permille / 10 else p_permille end $$;
create or replace function public.rate_to_permille(p_value numeric, p_unit text) returns numeric
language sql immutable as $$ select case when p_value is null then null when p_unit = 'percent' then p_value * 10 else p_value end $$;
-- documents: any rate to percent (per mille divided by 10)
create or replace function public.rate_to_percent(p_value numeric, p_unit text) returns numeric
language sql immutable as $$ select case when p_value is null then null when p_unit = 'per_mille' then p_value / 10 else p_value end $$;

-- saving a schedule: the unit is part of the settings (and of the change log); full definition, no text patching
CREATE OR REPLACE FUNCTION public.admin_save_rate_table(p_table text, p_meta jsonb, p_cells jsonb, p_removed jsonb, p_reason text)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
  if p_meta ? 'rate_unit' and p_meta->>'rate_unit' not in ('percent','per_mille') then raise exception 'invalid rate unit'; end if;
  if p_meta ? 'rate_unit' and p_meta->>'rate_unit' is distinct from t.rate_unit then
    v_ch := v_ch || ('rate unit ' || case t.rate_unit when 'percent' then '%' else 'per mille' end || ' -> ' || case p_meta->>'rate_unit' when 'percent' then '%' else 'per mille' end);
  end if;
  update public.rate_tables set
    rate_unit               = case when p_meta ? 'rate_unit' then p_meta->>'rate_unit' else rate_unit end,
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
end $function$;

-- copying schedules to another client / subcategory keeps their unit; full definition, no text patching
CREATE OR REPLACE FUNCTION public.admin_copy_config(p_parts_j jsonb, p_from_type text, p_from_id bigint, p_targets jsonb, p_items jsonb, p_reason text)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
    if tt not in ('one_off_general','customer','policy','client_group') then raise exception 'invalid target'; end if;
    if tt = p_from_type and coalesce(ti, 0) = coalesce(p_from_id, 0) then continue; end if;
    sfx := case tt when 'customer' then '@c' || ti when 'policy' then '@p' || ti when 'client_group' then '@g' || ti else '' end;

    if 'schedules' = any(p_parts) then
      for t in select * from public.rate_tables where scope_type = p_from_type and coalesce(scope_id, 0) = coalesce(p_from_id, 0)
                 and (array_length(it_s, 1) is null or kind = any(it_s)) loop
        new_id := t.kind || sfx;
        insert into public.rate_tables(id, name, mode, zones, war_included_permille, min_premium, deck_allowed, contingency_allowed, used_loading_pct, cars_loading_pct, household_flat_permille, notes, sort, kind, scope_type, scope_id, rate_unit)
        values (new_id, t.name, t.mode, t.zones, t.war_included_permille, t.min_premium, t.deck_allowed, t.contingency_allowed, t.used_loading_pct, t.cars_loading_pct, t.household_flat_permille, t.notes, t.sort, t.kind, tt, ti, t.rate_unit)
        on conflict (id) do update set name = excluded.name, zones = excluded.zones, war_included_permille = excluded.war_included_permille, min_premium = excluded.min_premium,
          deck_allowed = excluded.deck_allowed, contingency_allowed = excluded.contingency_allowed, used_loading_pct = excluded.used_loading_pct,
          cars_loading_pct = excluded.cars_loading_pct, household_flat_permille = excluded.household_flat_permille, rate_unit = excluded.rate_unit, updated_at = now();
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
end $function$;

-- import: the unit of the file becomes the unit of the schedule (the rates arrive in per mille)
create or replace function public.admin_set_rate_unit(p_scope_type text, p_scope_id bigint, p_kind text, p_unit text, p_reason text) returns int
language plpgsql security definer set search_path = public as $$
declare me public.profiles; n int;
begin
  if not public.has_role('admin') then raise exception 'only staff admins can change rates, zones and configurations'; end if;
  if p_unit not in ('percent','per_mille') then raise exception 'invalid rate unit'; end if;
  select * into me from public.profiles where id = auth.uid();
  perform set_config('fc.audited', '1', true);
  update public.rate_tables set rate_unit = p_unit, updated_at = now()
   where kind = p_kind and scope_type = p_scope_type and coalesce(scope_id, 0) = coalesce(p_scope_id, 0) and rate_unit <> p_unit;
  get diagnostics n = row_count;
  if n > 0 then
    insert into public.audit_log(user_id, user_name, entity, entity_id, summary, reason)
    values (auth.uid(), coalesce(me.full_name, me.email), 'schedule', p_kind, 'rate unit -> ' || case p_unit when 'percent' then '%' else 'per mille' end, coalesce(nullif(trim(p_reason), ''), 'import'));
  end if;
  return n;
end $$;
grant execute on function public.admin_set_rate_unit(text, bigint, text, text, text) to authenticated;

-- quotation editor: unlocking the per mille unit is logged at once ...
create or replace function public.admin_log_rate_unit_override(p_indication bigint, p_unit text, p_note text default null) returns boolean
language plpgsql security definer set search_path = public as $$
declare me public.profiles; i public.indications;
begin
  if not public.is_admin() then raise exception 'not authorised'; end if;
  if p_unit not in ('percent','per_mille') then raise exception 'invalid rate unit'; end if;
  select * into me from public.profiles where id = auth.uid();
  select * into i from public.indications where id = p_indication;
  insert into public.audit_log(user_id, user_name, entity, entity_id, summary, reason)
  values (auth.uid(), coalesce(me.full_name, me.email), 'quotation', coalesce(i.ref, '#' || p_indication),
          'Quotation rate unit unlocked: ' || case p_unit when 'per_mille' then 'per mille (decimal basis x10, premium = sum insured x rate / 1000)' else '%' end
          || '. Documents stay in %.', left(nullif(trim(coalesce(p_note, '')), ''), 300));
  return true;
end $$;
grant execute on function public.admin_log_rate_unit_override(bigint, text, text) to authenticated;

-- ... and every saved quotation that was worked in per mille is logged with its version
create or replace function public.quotations_rate_unit_audit() returns trigger
language plpgsql security definer set search_path = public as $$
declare me public.profiles; i public.indications;
begin
  if coalesce(new.data->'rateUnitOverride'->>'unit', 'percent') = 'per_mille' then
    select * into me from public.profiles where id = auth.uid();
    select * into i from public.indications where id = new.indication_id;
    insert into public.audit_log(user_id, user_name, entity, entity_id, summary, reason)
    values (auth.uid(), coalesce(me.full_name, me.email), 'quotation', coalesce(i.ref, '#' || new.indication_id) || ' v' || new.version,
            'Quotation saved with the rate entered in per mille; stored and shown on documents in % (per mille / 10).',
            left(new.data->'rateUnitOverride'->>'note', 300));
  end if;
  return new;
end $$;
drop trigger if exists quotations_rate_unit_audit on public.quotations;
create trigger quotations_rate_unit_audit after insert on public.quotations for each row execute function public.quotations_rate_unit_audit();
