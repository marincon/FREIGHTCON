-- =====================================================================
-- FREIGHTCON update 2026-11-12l — open covers (stage 1)
-- * client groups → policies → offices / warehouses / agents
--   (spot clients vs. open cover clients such as Bertling)
-- * minimum premium and deductible per policy, per office and per user
-- * open cover rating straight from the policy schedules
--   (no FREIGHTCON factors; ICC C 50 %, interest 40 %, on deck +50 %,
--    war & strikes included in sea rates and never deducted)
-- * per group: clients see the indicative premium, or the portal only
--   takes requests ("intake") — the premium then stays internal
-- * information firewall: zones, factors and hidden premiums are kept in
--   indication_internal, which only staff can read
-- * schedules and country zones are locked: changes only with a reason,
--   every change is written to the audit log
-- * GBP as a currency (Bertling UK)
-- * seed: Bertling Global (000181-304-0030) and Bertling UK
--   (000182-304-0030) with all offices, warehouses and agents (02/2026)
-- Run after update_2026-10-21k.sql. Safe to run more than once
-- (the Bertling seed is only inserted if the group does not exist yet).
-- =====================================================================

-- ---------- currencies: GBP ----------
alter table public.indications drop constraint if exists indications_currency_check;
alter table public.indications add constraint indications_currency_check check (currency in ('EUR','USD','GBP'));
alter table public.invoices    drop constraint if exists invoices_currency_check;
alter table public.invoices    add constraint invoices_currency_check check (currency in ('EUR','USD','GBP'));
alter table public.claims      drop constraint if exists claims_currency_check;
alter table public.claims      add constraint claims_currency_check check (currency is null or currency in ('EUR','USD','GBP'));

-- ---------- structure ----------
create table if not exists public.client_groups (
  id            bigserial primary key,
  name          text not null check (length(trim(name)) between 1 and 150),
  kind          text not null default 'spot' check (kind in ('spot','open_cover')),
  show_premium  boolean not null default true,      -- false: the portal only takes requests, no automatic premium for the client
  email_domains text[] not null default '{}',        -- users with these e-mail domains belong to the group (lower case, without @)
  notes         text,
  sort          int not null default 100,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create table if not exists public.policies (
  id               bigserial primary key,
  group_id         bigint not null references public.client_groups(id) on delete cascade,
  name             text not null check (length(trim(name)) between 1 and 150),
  policy_no        text,
  policyholder     text,
  currency         text not null default 'EUR' check (currency in ('EUR','USD','GBP')),
  limit_conveyance numeric(14,2) check (limit_conveyance > 0),   -- any one conveyance / fire-protected storage
  limit_on_deck    numeric(14,2) check (limit_on_deck > 0),      -- on deck or barge
  limit_post       numeric(14,2) check (limit_post > 0),         -- parcel post / mail
  min_premium      numeric(12,2) not null default 100 check (min_premium >= 0),
  deductible       numeric(12,2) check (deductible >= 0),        -- each and every loss, in the policy currency
  placed_via       text,
  security         jsonb not null default '[]'::jsonb,           -- [{insurer, share, lead}]
  rating           text not null default 'schedule' check (rating in ('schedule','standard')),
  rules            jsonb not null default '{}'::jsonb,           -- schedule rules (loadings, cover / interest shares), see below
  notes            text,
  active           boolean not null default true,
  sort             int not null default 100,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
create unique index if not exists policies_no_uq on public.policies(policy_no) where policy_no is not null;
alter table public.policies add column if not exists rules jsonb not null default '{}'::jsonb;

-- the schedule rules of an open cover; empty keys fall back to these defaults (Bertling 2025)
create or replace function public.policy_rule(p_rules jsonb, p_path text[]) returns numeric
language sql immutable as $$
  select coalesce((p_rules #>> p_path)::numeric, ('{
    "icc_c_pct": 50, "interest_pct": 40, "deck_loading_pct": 50, "air_war_permille": 0.5,
    "air_freight": {"used_pct": 50, "cars_pct": 50, "household_permille": 10},
    "air_charter": {"used_pct": 25, "cars_pct": 25}
  }'::jsonb #>> p_path)::numeric)
$$;

-- the Bertling schedules are in active use for open covers now
update public.rate_tables set name = replace(name, ' (reference only)', ''),
  notes = 'Open cover schedule (Bertling 2025), used as it stands for open cover policies. Not used for spot clients.'
 where id in ('sea_used','sea_newcars','sea_usedcars','sea_household');
update public.rate_tables set notes = 'Open cover: schedule rate as it stands (incl. 0.5 ‰ war & strikes, never deducted). Spot clients: base rate for class factor 1.0, war & strikes deducted and charged separately. Incl. pre- and on-carriage.'
 where id = 'sea_new';
create table if not exists public.offices (
  id           bigserial primary key,
  policy_id    bigint not null references public.policies(id) on delete cascade,
  name         text not null check (length(trim(name)) between 1 and 200),
  location     text,
  country      text,
  kind         text not null default 'office' check (kind in ('office','warehouse','agent')),
  subcategory  text,                                   -- e.g. 'Singapore' (own minimum premium / deductible)
  min_premium  numeric(12,2) check (min_premium >= 0), -- empty = as the policy
  deductible   numeric(12,2) check (deductible >= 0),  -- empty = as the policy
  contacts     text,                                   -- internal only
  active       boolean not null default true,
  sort         int not null default 100,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index if not exists offices_policy_idx on public.offices(policy_id);

alter table public.profiles add column if not exists group_id             bigint references public.client_groups(id) on delete set null;
alter table public.profiles add column if not exists office_id            bigint references public.offices(id) on delete set null;
alter table public.profiles add column if not exists min_premium_override numeric(12,2) check (min_premium_override >= 0);
alter table public.profiles add column if not exists deductible_override  numeric(12,2) check (deductible_override >= 0);

alter table public.indications add column if not exists office_id bigint references public.offices(id) on delete set null;
alter table public.indications add column if not exists policy_id bigint references public.policies(id) on delete set null;
alter table public.indications add column if not exists intake    boolean not null default false;   -- premium kept internal, request goes straight to the brokers

-- what only staff may see about a calculation
create table if not exists public.indication_internal (
  indication_id bigint primary key references public.indications(id) on delete cascade,
  status        text,
  rate_pct      numeric(8,4),
  premium_gross numeric(14,2),
  premium       numeric(14,2),
  min_applied   boolean not null default false,
  reasons       text[] not null default '{}',
  notes         text[] not null default '{}',   -- internal hints for the broker
  calc_detail   jsonb,
  created_at    timestamptz not null default now()
);

alter table public.commodities add column if not exists oc_class text check (oc_class is null or oc_class in ('new','used','cars_new','cars_used','household'));

create table if not exists public.audit_log (
  id         bigserial primary key,
  at         timestamptz not null default now(),
  user_id    uuid,
  user_name  text,
  entity     text not null,
  entity_id  text,
  summary    text not null,
  reason     text
);
create index if not exists audit_log_at_idx on public.audit_log(at desc);

do $$
declare t text;
begin
  foreach t in array array['client_groups','policies','offices','indication_internal'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists admin_all on public.%I', t);
    execute format('create policy admin_all on public.%I for all to authenticated using (public.is_admin()) with check (public.is_admin())', t);
  end loop;
end $$;
alter table public.audit_log enable row level security;
drop policy if exists admin_read on public.audit_log;
create policy admin_read on public.audit_log for select to authenticated using (public.is_admin());

do $$
declare t text;
begin
  foreach t in array array['client_groups','policies','offices'] loop
    execute format('drop trigger if exists %I on public.%I', t || '_touch', t);
    execute format('create trigger %I before update on public.%I for each row execute function public.touch_updated_at()', t || '_touch', t);
  end loop;
end $$;

-- non-admins must never change privileged columns (now also group, office and overrides)
create or replace function public.profiles_guard() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() and current_user not in ('postgres','service_role','supabase_admin') then
    if new.is_admin is distinct from old.is_admin or new.approved is distinct from old.approved
       or new.rejected is distinct from old.rejected or new.client_discount_pct is distinct from old.client_discount_pct
       or new.email is distinct from old.email or new.company is distinct from old.company
       or new.referral_code is distinct from old.referral_code
       or new.group_id is distinct from old.group_id or new.office_id is distinct from old.office_id
       or new.min_premium_override is distinct from old.min_premium_override
       or new.deductible_override is distinct from old.deductible_override then
      raise exception 'not allowed';
    end if;
  end if;
  return new;
end $$;

-- ---------- which group a user belongs to: office → assigned group → e-mail domain ----------
create or replace function public.user_group_id(p_uid uuid) returns bigint
language sql stable security definer set search_path = public as $$
  select coalesce(
    (select po.group_id from public.profiles p join public.offices o on o.id = p.office_id join public.policies po on po.id = o.policy_id where p.id = p_uid),
    (select group_id from public.profiles where id = p_uid),
    (select g.id from public.client_groups g, public.profiles p
      where p.id = p_uid and lower(split_part(p.email, '@', 2)) = any(g.email_domains)
      order by g.sort, g.id limit 1))
$$;
revoke execute on function public.user_group_id(uuid) from public, anon, authenticated;

-- what the client may know about his own set-up (no minimum premiums, no rates, no security)
create or replace function public.my_org() returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare p public.profiles; g public.client_groups; o public.offices; po public.policies;
begin
  select * into p from public.profiles where id = auth.uid();
  if not found then return null; end if;
  select * into g from public.client_groups where id = public.user_group_id(p.id);
  if p.office_id is not null then
    select * into o from public.offices where id = p.office_id;
    select * into po from public.policies where id = o.policy_id;
  end if;
  return jsonb_build_object(
    'group', case when g.id is null then null else jsonb_build_object('id', g.id, 'name', g.name, 'kind', g.kind, 'show_premium', g.show_premium) end,
    'office', case when o.id is null then null else jsonb_build_object('id', o.id, 'name', o.name, 'location', o.location, 'country', o.country,
                                                                        'policy', po.name, 'policy_no', po.policy_no, 'currency', po.currency) end,
    'offices', case when g.id is null then '[]'::jsonb else coalesce((
        select jsonb_agg(jsonb_build_object('id', x.id, 'name', x.name, 'location', x.location, 'country', x.country, 'kind', x.kind,
                                            'policy', y.name, 'policy_no', y.policy_no, 'currency', y.currency)
                         order by y.sort, y.id, case x.kind when 'office' then 0 when 'warehouse' then 1 else 2 end, x.sort, x.name)
          from public.offices x join public.policies y on y.id = x.policy_id
         where y.group_id = g.id and x.active and y.active), '[]'::jsonb) end);
end $$;
grant execute on function public.my_org() to authenticated;

create or replace function public.set_my_office(p_office_id bigint) returns boolean
language plpgsql security definer set search_path = public as $$
declare o public.offices; po public.policies; v_g bigint;
begin
  select * into o from public.offices where id = p_office_id and active;
  if not found then raise exception 'invalid office'; end if;
  select * into po from public.policies where id = o.policy_id and active;
  if not found then raise exception 'invalid office'; end if;
  v_g := public.user_group_id(auth.uid());
  if v_g is null or po.group_id <> v_g then raise exception 'invalid office'; end if;
  update public.profiles set office_id = o.id, group_id = po.group_id where id = auth.uid();
  return true;
end $$;
grant execute on function public.set_my_office(bigint) to authenticated;

-- ---------- locked schedules and zones: only changed with a reason, always logged ----------
create or replace function public.rate_lock_guard() returns trigger
language plpgsql as $$
begin
  -- API callers (logged-in users) must go through the audited functions; SQL editor / migrations are not affected
  if auth.uid() is not null and coalesce(current_setting('fc.audited', true), '') <> '1' then
    if tg_table_name = 'countries' then
      if new.sea_zone is distinct from old.sea_zone or new.air_zone is distinct from old.air_zone then
        raise exception 'zones are locked — change them in Internal → Rates with a reason';
      end if;
      return new;
    end if;
    raise exception 'schedules are locked — change them in Internal → Rates with a reason';
  end if;
  return coalesce(new, old);
end $$;
drop trigger if exists rate_cells_lock on public.rate_cells;
create trigger rate_cells_lock before insert or update or delete on public.rate_cells for each row execute function public.rate_lock_guard();
drop trigger if exists countries_zone_lock on public.countries;
create trigger countries_zone_lock before update on public.countries for each row execute function public.rate_lock_guard();

create or replace function public.admin_save_rate_table(p_table text, p_meta jsonb, p_cells jsonb, p_removed jsonb, p_reason text) returns int
language plpgsql security definer set search_path = public as $$
declare t public.rate_tables; me public.profiles; c jsonb; a int; b int; v_old numeric; v_new numeric; v_ch text[] := '{}'; n int := 0; k text;
begin
  if not public.is_admin() then raise exception 'not authorised'; end if;
  if length(trim(coalesce(p_reason, ''))) < 3 then raise exception 'reason required'; end if;
  select * into t from public.rate_tables where id = p_table for update;
  if not found then raise exception 'schedule not found'; end if;
  select * into me from public.profiles where id = auth.uid();
  perform set_config('fc.audited', '1', true);
  p_meta := coalesce(p_meta, '{}'::jsonb);
  foreach k in array array['min_premium','war_included_permille','used_loading_pct','cars_loading_pct','household_flat_permille'] loop
    if p_meta ? k and (p_meta->>k)::numeric is distinct from (to_jsonb(t)->>k)::numeric then
      v_ch := v_ch || (replace(k, '_', ' ') || ' ' || coalesce(trim_scale((to_jsonb(t)->>k)::numeric)::text, '—') || ' → ' || coalesce(trim_scale((p_meta->>k)::numeric)::text, '—'));
    end if;
  end loop;
  foreach k in array array['deck_allowed','contingency_allowed'] loop
    if p_meta ? k and (p_meta->>k)::boolean is distinct from (to_jsonb(t)->>k)::boolean then
      v_ch := v_ch || (replace(k, '_', ' ') || ' → ' || (p_meta->>k));
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
      v_ch := v_ch || (a || '–' || b || ': ' || coalesce(trim_scale(v_old)::text, '—') || ' → ' || trim_scale(v_new)); n := n + 1;
    end if;
  end loop;
  for c in select * from jsonb_array_elements(coalesce(p_removed, '[]'::jsonb)) loop
    a := least((c->>'a')::int, (c->>'b')::int); b := greatest((c->>'a')::int, (c->>'b')::int);
    delete from public.rate_cells where table_id = p_table and zone_a = a and zone_b = b returning permille into v_old;
    if found then v_ch := v_ch || (a || '–' || b || ': ' || trim_scale(v_old) || ' → individually'); n := n + 1; end if;
  end loop;
  if array_length(v_ch, 1) is not null then
    insert into public.audit_log(user_id, user_name, entity, entity_id, summary, reason)
    values (auth.uid(), coalesce(me.full_name, me.email), 'schedule', t.name, array_to_string(v_ch, '; '), trim(p_reason));
  end if;
  return coalesce(array_length(v_ch, 1), 0);
end $$;
grant execute on function public.admin_save_rate_table(text, jsonb, jsonb, jsonb, text) to authenticated;

-- p_rows: [{iso2, sea_zone, air_zone}]
create or replace function public.admin_set_zones(p_rows jsonb, p_reason text) returns int
language plpgsql security definer set search_path = public as $$
declare me public.profiles; c jsonb; o public.countries; v_sea int; v_air int; v_ch text[] := '{}';
begin
  if not public.is_admin() then raise exception 'not authorised'; end if;
  if length(trim(coalesce(p_reason, ''))) < 3 then raise exception 'reason required'; end if;
  select * into me from public.profiles where id = auth.uid();
  perform set_config('fc.audited', '1', true);
  for c in select * from jsonb_array_elements(coalesce(p_rows, '[]'::jsonb)) loop
    select * into o from public.countries where iso2 = c->>'iso2';
    if not found then raise exception 'unknown country %', c->>'iso2'; end if;
    v_sea := nullif(c->>'sea_zone', '')::int; v_air := nullif(c->>'air_zone', '')::int;
    if v_sea is distinct from o.sea_zone or v_air is distinct from o.air_zone then
      update public.countries set sea_zone = v_sea, air_zone = v_air, updated_at = now() where iso2 = o.iso2;
      v_ch := v_ch || (o.name || ': sea ' || coalesce(o.sea_zone::text, '—') || ' → ' || coalesce(v_sea::text, '—') || ', air ' || coalesce(o.air_zone::text, '—') || ' → ' || coalesce(v_air::text, '—'));
    end if;
  end loop;
  if array_length(v_ch, 1) is not null then
    insert into public.audit_log(user_id, user_name, entity, entity_id, summary, reason)
    values (auth.uid(), coalesce(me.full_name, me.email), 'zones', null, array_to_string(v_ch, '; '), trim(p_reason));
  end if;
  return coalesce(array_length(v_ch, 1), 0);
end $$;
grant execute on function public.admin_set_zones(jsonb, text) to authenticated;

-- ---------- the calculation ----------
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

  select * into com from public.commodities where id = p->>'commodity_id' and active;
  if not found then raise exception 'invalid commodity'; end if;
  if not com.ext_hssc then v_hssc := false; end if;
  if not com.ext_liw  then v_liw  := false; end if;
  select * into o_c from public.countries where iso2 = upper(p->>'origin_country'); if not found then raise exception 'invalid origin country'; end if;
  select * into d_c from public.countries where iso2 = upper(p->>'dest_country');   if not found then raise exception 'invalid destination country'; end if;
  select * into o_r from public.regions where id = o_c.region_id;
  select * into d_r from public.regions where id = d_c.region_id;

  v_si   := round(v_inv * (1 + v_uplift / 100), 2);
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
    if o_c.local_insurance then v_reasons := array_append(v_reasons, ('Local insurance rules apply in ' || o_c.name || ' — we check this individually')::text); end if;
    if d_c.local_insurance then v_reasons := array_append(v_reasons, ('Local insurance rules apply in ' || d_c.name || ' — we check this individually')::text); end if;
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

  insert into public.indications(user_id, company, commodity_id, goods_description, packaging, conveyance,
      origin_country, origin_place, dest_country, dest_place, departure_date, invoice_value, currency,
      uplift_pct, sum_insured, cover, war_strikes, status, rate_pct, premium_gross, discount_pct, premium,
      min_applied, reasons, conditions, vessel, incoterm, insured_party, on_deck, interest_only, calc_detail,
      insured_name, insured_address, customer_ref, source, ext_hssc, ext_liw, office_id, policy_id, intake, quote_requested_at)
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
      ofc.id, pol.id, v_hide, case when v_hide then now() end)
  returning * into r;

  insert into public.indication_internal(indication_id, status, rate_pct, premium_gross, premium, min_applied, reasons, notes, calc_detail)
  values (r.id, v_status, case when v_status = 'quoted' then v_rate end, case when v_status = 'quoted' then v_gross end,
          case when v_status = 'quoted' then v_net end, v_min_hit, v_reasons, v_notes, v_detail);

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
         || case when prof.is_admin then jsonb_build_object('calc_detail', v_detail, 'notes', to_jsonb(v_notes)) else '{}'::jsonb end;
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
           i.office_id, i.intake
      from public.indications i
     where i.user_id = auth.uid() and not i.hidden_by_user
     order by i.created_at desc limit least(greatest(p_limit, 1), 500)
  ) s
$$;
grant execute on function public.my_history(int) to authenticated;

-- old calculations: the zone breakdown is internal from now on
insert into public.indication_internal(indication_id, status, rate_pct, premium_gross, premium, min_applied, reasons, calc_detail)
select i.id, i.status, i.rate_pct, i.premium_gross, i.premium, i.min_applied, i.reasons, i.calc_detail
  from public.indications i
 where i.calc_detail is not null
on conflict (indication_id) do nothing;
update public.indications i set calc_detail = null
  from public.profiles p
 where p.id = i.user_id and not p.is_admin and i.calc_detail is not null;

-- ---------- cargo types: which open cover schedule they fall under ----------
update public.commodities set oc_class = 'new'       where id in ('general','machinery_new','spare_parts','steel','textiles') and oc_class is null;
update public.commodities set oc_class = 'used'      where id = 'machinery_used' and oc_class is null;
update public.commodities set oc_class = 'cars_new'  where id = 'vehicles_new'   and oc_class is null;
update public.commodities set oc_class = 'cars_used' where id = 'vehicles_used'  and oc_class is null;
update public.commodities set oc_class = 'household' where id = 'household'      and oc_class is null;

-- ---------- seed: spot group + Bertling ----------
do $$
declare g bigint; pg bigint; pu bigint;
begin
  if not exists (select 1 from public.client_groups where kind = 'spot') then
    insert into public.client_groups(name, kind, show_premium, notes, sort)
    values ('Regular / spot clients', 'spot', true, 'One-off shipments. Terms, rates, minimum premiums and deductibles are set per quotation.', 10);
  end if;

  if exists (select 1 from public.client_groups where name = 'Bertling') then return; end if;

  insert into public.client_groups(name, kind, show_premium, email_domains, notes, sort)
  values ('Bertling', 'open_cover', false, array['bertling.com'],
          'Open cover via Assekuranz-Kontor Montan GmbH. Users with an @bertling.com address choose their office; the portal only takes declarations and requests.', 20)
  returning id into g;

  insert into public.policies(group_id, name, policy_no, policyholder, currency, limit_conveyance, limit_on_deck, limit_post, min_premium, deductible, placed_via, security, rating, sort)
  values (g, 'Bertling Global', '000181-304-0030', 'BERTLING Group of Companies c/o F.H. BERTLING Holding GmbH &/or subsidiaries', 'USD',
          30000000, 5000000, 50000, 100, 100, 'Assekuranz-Kontor Montan GmbH',
          '[{"insurer":"Baloise","share":20,"lead":true},{"insurer":"Allianz","share":20},{"insurer":"Liberty Specialty Markets","share":14},
            {"insurer":"Mannheimer","share":12},{"insurer":"Delvag","share":10},{"insurer":"MS Amlin Marine","share":10},
            {"insurer":"Bayerischer Versicherungsverband","share":7},{"insurer":"Helvetia","share":7}]'::jsonb, 'schedule', 10)
  returning id into pg;
  insert into public.policies(group_id, name, policy_no, policyholder, currency, limit_conveyance, limit_on_deck, limit_post, min_premium, deductible, placed_via, security, rating, notes, sort)
  values (g, 'Bertling UK', '000182-304-0030', 'FH Bertling Logistics Aberdeen Limited &/or subsidiaries', 'GBP',
          5000000, 5000000, 50000, 100, 100, 'Assekuranz-Kontor Montan GmbH',
          '[{"insurer":"MS Amlin Marine","share":30,"lead":true},{"insurer":"Allianz","share":20},{"insurer":"Liberty Specialty Markets","share":20},
            {"insurer":"QBE Europe","share":20},{"insurer":"Starr Europe","share":10}]'::jsonb, 'schedule', 'Security as per Addendum 1.', 20)
  returning id into pu;

  insert into public.offices(policy_id, name, location, country, kind, subcategory, min_premium, deductible, contacts, sort) values
    (pu, 'F.H. Bertling Logistics Aberdeen Limited', 'Aberdeen', 'GB', 'office', null, null, null, 'Stuart Henderson (stuart.henderson@bertling.com)', 10),
    (pu, 'F.H. Bertling Logistics Aberdeen Limited', 'Harrow', 'GB', 'office', null, null, null, 'Stuart Henderson (stuart.henderson@bertling.com)', 20),
    (pu, 'F.H. Bertling Logistics Aberdeen Limited', 'Middlesbrough', 'GB', 'office', null, null, null, 'Stuart Henderson (stuart.henderson@bertling.com)', 30),
    (pg, 'F.H. Bertling Pte Ltd', 'Singapore (Harbourfront & Penjuru Lane)', 'SG', 'office', 'Singapore', 50, 50, 'Ron See (ron.see@bertling.com)', 10),
    (pg, 'F.H. Bertling Chartering & Ship Management Pte. Ltd.', 'Singapore', 'SG', 'office', 'Singapore', 50, 50, 'Konstantin Bahr (konstantin.bahr@bertling.com)', 11),
    (pg, 'F.H. Bertling Logistics GmbH', 'Hamburg, Bremen, Düsseldorf', 'DE', 'office', null, null, null, 'Johannes Saade / Janine Seemke', 20),
    (pg, 'F.H. Bertling GmbH & Co. KG / Holding / Reederei / OneBulk / EDI', 'Hamburg & Lübeck', 'DE', 'office', null, null, null, 'Frank Fischer / Jörn Held / Ralf Veigel / Malte Sibberns / Peter Kossing', 21),
    (pg, 'Bertling Logistics Australia Pty. Ltd.', 'Brisbane & Perth', 'AU', 'office', null, null, null, 'Antonio Martin (antonio.martin@bertling.com)', 30),
    (pg, 'Bertling Logistics Brasil Ltda.', 'São Paulo & Rio de Janeiro', 'BR', 'office', null, null, null, 'Rogerio Azevedo (rogerio.azevedo@bertling.com)', 30),
    (pg, 'Bertling Logistics Chile S.A. / Transporte Marítimo SpA', 'Santiago de Chile', 'CL', 'office', null, null, null, 'Marcela Vargas / Hans Koch', 30),
    (pg, 'Bertling Logistics (Shanghai) & (Beijing) Co. Ltd. / Rep Office', 'Shanghai & Beijing', 'CN', 'office', null, null, null, 'Vincent Gao / Frank Fischer', 30),
    (pg, 'F.H. Bertling Logistics Colombia S.A.S', 'Bogotá', 'CO', 'office', null, null, null, 'Arndt Drögemüller (arndt.drogemuller@bertling.com)', 30),
    (pg, 'F.H. Bertling Logistics Egypt Ltd.', 'Cairo', 'EG', 'office', null, null, null, 'Ashraf Yehia (ashraf.yehia@bertling.com)', 30),
    (pg, 'F.H. Bertling Logistics Georgia LLC', 'Tbilisi', 'GE', 'office', null, null, null, 'Samantha Nelson (samantha.nelson@bertling.com)', 30),
    (pg, 'Rafeek & Moore Bertling Logistics (Guyana) Inc.', 'Georgetown', 'GY', 'office', null, null, null, 'Starr Borden (starr.borden@bertling.com)', 30),
    (pg, 'Bertling Logistics India Pvt. Ltd.', 'Mumbai', 'IN', 'office', null, null, null, 'Sharmila Amin (sharmila.amin@bertling.com)', 30),
    (pg, 'PT. F.H. Bertling Logistics Indonesia', 'Jakarta & Batam', 'ID', 'office', null, null, null, 'Sarvanen Supaya / Mohd Nureski', 30),
    (pg, 'Bertling Kazakh Logistics LLP / In-House Tengiz Dept.', 'Atyrau & Tengiz', 'KZ', 'office', null, null, null, 'Aliya Zhaksylykova (aliya.zhaksylykova@bertling.com)', 30),
    (pg, 'F.H. Bertling Projects Logistics Sdn. Bhd.', 'Selangor / Kuala Lumpur', 'MY', 'office', null, null, null, 'Niall White (niall.white@bertling.com)', 30),
    (pg, 'F.H. Bertling Logistics Lda', 'Maputo', 'MZ', 'office', null, null, null, 'Patrick Golden (patrick.golden@bertling.com)', 30),
    (pg, 'Bertling Logistics (Peru) S.A.C.', 'Lima', 'PE', 'office', null, null, null, 'Cecilia Gallo Lopez (cecilia.gallo@bertling.com)', 30),
    (pg, 'Al Khaldi-Bertling Logistics Ltd.', 'Dhahran', 'SA', 'office', null, null, null, 'Matthew Freeman (matthew.freeman@bertling.com)', 30),
    (pg, 'F.H. Bertling Logistics (Pty) Ltd', 'Cape Town, Johannesburg, Durban, Port Elizabeth', 'ZA', 'office', null, null, null, 'Patrick Golden / Eugene Nair', 30),
    (pg, 'Bertling Logistics Spain, S.L.U.', 'Madrid', 'ES', 'office', null, null, null, 'Veronica Moreno (veronica.moreno@bertling.com)', 30),
    (pg, 'Bertling Logistics Suriname N.V.', 'Paramaribo', 'SR', 'office', null, null, null, 'Roberto Prado (roberto.prado@bertling.com)', 30),
    (pg, 'F.H. Bertling AB / Bertling Enviro AB', 'Sävedalen', 'SE', 'office', null, null, null, 'Malin Ståhl / Niklas Amour', 30),
    (pg, 'F.H. Bertling Lojistik ve Uluslararasi Nakliyat Ltd. Sti.', 'Istanbul', 'TR', 'office', null, null, null, 'Emir Tanju (emir.tanju@bertling.com)', 30),
    (pg, 'Bertling Logistics (TURKMEN) L.L.C.', 'Ashgabat, Hazar, Turkmenbashy', 'TM', 'office', null, null, null, 'Bayramtagan Abdurahimov', 30),
    (pg, 'Bertling Logistics LLC', 'Dubai & Abu Dhabi — check FTZ status', 'AE', 'office', null, null, null, 'Gary Gordon / Ramesh Pillai', 30),
    (pg, 'Bertling Logistics, Inc.', 'Dallas, Houston, Miami', 'US', 'office', null, null, null, 'Wendy Bell / Starr Borden / Roberto Prado / Sebastian Cisneros', 30),
    (pg, 'Al Marasi (approved agent)', 'Iraq', 'IQ', 'agent', null, null, null, 'Ali Majid', 50),
    (pg, 'G.P. Coordinamento (approved agent)', 'Italy', 'IT', 'agent', null, null, null, 'Gianfranco Pia', 50),
    (pg, 'MSL Msharib (approved agent)', 'Pakistan', 'PK', 'agent', null, null, null, 'Calvin Wilson', 50),
    (pg, 'Vantage Logistics (approved agent)', 'Vietnam', 'VN', 'agent', null, null, null, 'Kathy Truong', 50),
    (pg, 'Neft Oil (approved agent)', 'Bulgaria', 'BG', 'agent', null, null, null, 'Velislav Naydenov', 50),
    (pg, 'United Logistics (approved agent)', 'Qatar', 'QA', 'agent', null, null, null, 'Shan Mathews George', 50),
    (pg, 'SJ Global (approved agent)', 'South Korea', 'KR', 'agent', null, null, null, 'Daniel Jung', 50);
end $$;

notify pgrst, 'reload schema';
