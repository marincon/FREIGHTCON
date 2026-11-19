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

-- saving a schedule: the unit is part of the settings (and of the change log)
do $$
declare d text;
begin
  d := pg_get_functiondef('public.admin_save_rate_table(text, jsonb, jsonb, jsonb, text)'::regprocedure);
  if position('rate_unit' in d) = 0 then
    if position('  update public.rate_tables set' || chr(10) || '    min_premium ' in d) = 0 then raise exception 'admin_save_rate_table: pattern not found'; end if;
    d := replace(d, '  update public.rate_tables set' || chr(10) || '    min_premium ',
      '  if p_meta ? ''rate_unit'' and p_meta->>''rate_unit'' not in (''percent'',''per_mille'') then raise exception ''invalid rate unit''; end if;' || chr(10) ||
      '  if p_meta ? ''rate_unit'' and p_meta->>''rate_unit'' is distinct from t.rate_unit then' || chr(10) ||
      '    v_ch := v_ch || (''rate unit '' || case t.rate_unit when ''percent'' then ''%'' else ''per mille'' end || '' -> '' || case p_meta->>''rate_unit'' when ''percent'' then ''%'' else ''per mille'' end);' || chr(10) ||
      '  end if;' || chr(10) ||
      '  update public.rate_tables set' || chr(10) ||
      '    rate_unit               = case when p_meta ? ''rate_unit'' then p_meta->>''rate_unit'' else rate_unit end,' || chr(10) ||
      '    min_premium ');
    execute d;
  end if;
end $$;

-- copying schedules to another client / subcategory keeps their unit
do $$
declare d text;
begin
  d := pg_get_functiondef('public.admin_copy_config(jsonb, text, bigint, jsonb, jsonb, text)'::regprocedure);
  if position('rate_unit' in d) = 0 then
    if position('household_flat_permille, notes, sort, kind, scope_type, scope_id)' || chr(10) || '        values (new_id,' in d) = 0 then raise exception 'admin_copy_config: pattern not found'; end if;
    d := replace(d, 'household_flat_permille, notes, sort, kind, scope_type, scope_id)' || chr(10) || '        values (new_id,',
                    'household_flat_permille, notes, sort, kind, scope_type, scope_id, rate_unit)' || chr(10) || '        values (new_id,');
    d := replace(d, 't.household_flat_permille, t.notes, t.sort, t.kind, tt, ti)', 't.household_flat_permille, t.notes, t.sort, t.kind, tt, ti, t.rate_unit)');
    d := replace(d, 'household_flat_permille = excluded.household_flat_permille, updated_at = now();', 'household_flat_permille = excluded.household_flat_permille, rate_unit = excluded.rate_unit, updated_at = now();');
    execute d;
  end if;
end $$;

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
