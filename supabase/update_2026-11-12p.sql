-- =====================================================================
-- FREIGHTCON update 2026-11-12p — multi-tenant compartmentalisation
-- * hierarchy: client_groups → customers → offices & policies
--   cover types: one_off | open_cover | policy (customer, policy, user)
-- * every rating / underwriting configuration is scoped by
--   (scope_type, scope_id): 'one_off_general' | 'customer' | 'policy'
--     rate schedules ......... rate_tables (+ rate_cells)
--     cargo types ............ commodities (general) + commodity_terms (customer / policy)
--     countries & zones ...... country_zones (zones, compliance, comment)
--     factors & limits ....... settings (general) + scope_settings
--     zone maps .............. zone_maps (colours, labels)
--     war & strikes areas .... war_areas + war_exclusions
--     clauses ................ clause_library + customer_clauses / policy_clauses
-- * resolution: office → policy → customer (→ group) for open covers and
--   policies; one-offs use the general one-off pool only. Nothing of a
--   customer's configuration ever reaches the one-off pool or another customer.
-- * Bertling gets its own copy of today's schedules, zones, cargo terms and
--   factors, so the general one-off pool and Bertling can now differ.
-- * out-of-cover: a declaration outside the open cover is flagged
--   (is_out_of_cover, policy_id NULL) and rated with the one-off pool
-- * currencies USD, GBP, EUR, SGD; allowed currencies per group, customer,
--   policy and office (the most specific non-empty list wins)
-- * users: disable (is_active), last login, cover type per user
-- * copy / apply configuration between scopes (admin_copy_config)
-- Run after update_2026-11-12o.sql.
-- =====================================================================

-- ---------- currencies ----------
alter table public.indications drop constraint if exists indications_currency_check;
alter table public.indications add constraint indications_currency_check check (currency in ('EUR','USD','GBP','SGD'));
alter table public.invoices    drop constraint if exists invoices_currency_check;
alter table public.invoices    add constraint invoices_currency_check check (currency in ('EUR','USD','GBP','SGD'));
alter table public.claims      drop constraint if exists claims_currency_check;
alter table public.claims      add constraint claims_currency_check check (currency is null or currency in ('EUR','USD','GBP','SGD'));
alter table public.policies    drop constraint if exists policies_currency_check;
alter table public.policies    add constraint policies_currency_check check (currency in ('EUR','USD','GBP','SGD'));
insert into public.settings(key, value, note) values
  ('currencies', '["EUR","USD","GBP","SGD"]', 'Currencies of the general one-off pool (customers, policies and offices can restrict further)')
on conflict (key) do nothing;
update public.settings set value = value || '{"GBP": 1750000, "SGD": 2900000}'::jsonb
 where key = 'auto_limit' and not (value ? 'GBP');
update public.settings set value = value || '{"GBP": 65, "SGD": 110}'::jsonb
 where key = 'min_premium' and not (value ? 'GBP');

-- ---------- customers ----------
create table if not exists public.customers (
  id            bigserial primary key,
  group_id      bigint references public.client_groups(id) on delete set null,
  name          text not null check (length(trim(name)) between 1 and 150),
  cover_type    text not null default 'one_off' check (cover_type in ('one_off','open_cover','policy')),
  currencies    text[] not null default '{}',
  email_domains text[] not null default '{}',
  show_premium  boolean,                            -- null = as the group
  notes         text,
  active        boolean not null default true,
  sort          int not null default 100,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  check (currencies <@ array['EUR','USD','GBP','SGD'])
);
alter table public.client_groups add column if not exists currencies text[] not null default '{}';
alter table public.policies add column if not exists customer_id bigint references public.customers(id) on delete cascade;
alter table public.policies add column if not exists cover_type  text not null default 'open_cover';
alter table public.policies drop constraint if exists policies_cover_type_check;
alter table public.policies add constraint policies_cover_type_check check (cover_type in ('open_cover','policy'));
alter table public.policies add column if not exists currencies  text[] not null default '{}';
alter table public.offices  add column if not exists customer_id bigint references public.customers(id) on delete cascade;
alter table public.offices  add column if not exists currencies  text[] not null default '{}';
alter table public.offices  alter column policy_id drop not null;
alter table public.profiles add column if not exists customer_id   bigint references public.customers(id) on delete set null;
alter table public.profiles add column if not exists cover_type    text check (cover_type is null or cover_type in ('one_off','open_cover','policy'));
alter table public.profiles add column if not exists is_active     boolean not null default true;
alter table public.profiles add column if not exists last_login_at timestamptz;
alter table public.profiles add column if not exists disabled_at   timestamptz;
alter table public.profiles add column if not exists deleted_at    timestamptz;

alter table public.indications add column if not exists customer_id          bigint references public.customers(id) on delete set null;
alter table public.indications add column if not exists is_out_of_cover      boolean not null default false;
alter table public.indications add column if not exists out_of_cover_reasons text[] not null default '{}';
alter table public.indications add column if not exists declared_policy_id   bigint references public.policies(id) on delete set null;
alter table public.indications drop constraint if exists indications_source_check;
alter table public.indications add constraint indications_source_check check (source in ('form','upload','staff'));

alter table public.customers enable row level security;
drop policy if exists admin_all on public.customers;
create policy admin_all on public.customers for all to authenticated using (public.is_admin()) with check (public.is_admin());
drop trigger if exists customers_touch on public.customers;
create trigger customers_touch before update on public.customers for each row execute function public.touch_updated_at();

-- a customer for every open cover group (Bertling) — its policies, offices and users move under it
do $$
declare g record; c bigint;
begin
  for g in select * from public.client_groups where kind = 'open_cover' loop
    select id into c from public.customers where group_id = g.id order by id limit 1;
    if c is null then
      insert into public.customers(group_id, name, cover_type, email_domains, notes, sort)
      values (g.id, g.name, 'open_cover', g.email_domains, g.notes, g.sort) returning id into c;
    end if;
    update public.policies set customer_id = c where group_id = g.id and customer_id is null;
    update public.offices o set customer_id = c from public.policies p where p.id = o.policy_id and p.group_id = g.id and o.customer_id is null;
    update public.profiles set customer_id = c where group_id = g.id and customer_id is null;
    update public.profiles pr set customer_id = c from public.offices o where o.id = pr.office_id and o.customer_id = c and pr.customer_id is null;
  end loop;
end $$;
update public.policies set currencies = array[currency] where currencies = '{}';
-- policies now hang off the customer; a group is only a bundle (deleting it must not delete policies)
alter table public.policies alter column group_id drop not null;
alter table public.policies drop constraint if exists policies_group_id_fkey;
alter table public.policies add constraint policies_group_id_fkey foreign key (group_id) references public.client_groups(id) on delete set null;

-- ---------- scoped configuration ----------
-- schedules: one row per (kind, scope); ids of copies are kind@c<id> / kind@p<id>
alter table public.rate_tables add column if not exists kind       text;
alter table public.rate_tables add column if not exists scope_type text not null default 'one_off_general';
alter table public.rate_tables add column if not exists scope_id   bigint;
update public.rate_tables set kind = id where kind is null;
alter table public.rate_tables drop constraint if exists rate_tables_scope_check;
alter table public.rate_tables add constraint rate_tables_scope_check check ((scope_type = 'one_off_general' and scope_id is null) or (scope_type in ('customer','policy') and scope_id is not null));
create unique index if not exists rate_tables_scope_kind_uq on public.rate_tables(kind, scope_type, coalesce(scope_id, 0));

-- cargo types: the commodity row holds the general one-off terms; customers / policies have their own rows
create table if not exists public.commodity_terms (
  id               bigserial primary key,
  scope_type       text not null check (scope_type in ('customer','policy')),
  scope_id         bigint not null,
  commodity_id     text not null references public.commodities(id) on delete cascade,
  active           boolean not null default true,
  on_request       boolean not null default false,
  allowed_covers   text[] not null default array['icc_a','icc_b','icc_c'],
  class_factor     numeric(6,3),
  sea_table        text,
  air_class        text,
  oc_class         text check (oc_class is null or oc_class in ('new','used','cars_new','cars_used','household')),
  loading_pct      numeric(6,2),
  theft_attractive boolean not null default false,
  deductible       text,
  conditions       text,
  max_sum_insured  numeric(14,2),
  ext_hssc         boolean not null default false,
  ext_liw          boolean not null default false,
  updated_at       timestamptz not null default now(),
  unique (scope_type, scope_id, commodity_id)
);
-- countries & zones per scope (country facts like name / sanctions stay in countries)
create table if not exists public.country_zones (
  id         bigserial primary key,
  scope_type text not null check (scope_type in ('one_off_general','customer','policy')),
  scope_id   bigint,
  iso2       text not null references public.countries(iso2) on delete cascade,
  sea_zone   int,
  air_zone   int,
  compliance text not null default 'ok' check (compliance in ('ok','blocked','local','hold')),
  note       text,                                  -- shown on the zone map (coastal splits, suspensions, licensing remarks)
  updated_at timestamptz not null default now(),
  check ((scope_type = 'one_off_general' and scope_id is null) or (scope_type <> 'one_off_general' and scope_id is not null))
);
create unique index if not exists country_zones_uq on public.country_zones(scope_type, coalesce(scope_id, 0), iso2);
-- factors & limits per scope (keys as in settings: cover_factors, conveyance_factors, packing_factors, deck_loading_pct, …)
create table if not exists public.scope_settings (
  scope_type text not null check (scope_type in ('customer','policy')),
  scope_id   bigint not null,
  key        text not null,
  value      jsonb not null,
  updated_at timestamptz not null default now(),
  primary key (scope_type, scope_id, key)
);
-- zone maps per scope
create table if not exists public.zone_maps (
  id         bigserial primary key,
  scope_type text not null check (scope_type in ('one_off_general','customer','policy')),
  scope_id   bigint,
  mode       text not null check (mode in ('sea','air')),
  colors     jsonb not null default '{}'::jsonb,   -- {"1":"#1F3F8F", …}
  labels     jsonb not null default '{}'::jsonb,   -- {"1":"North America", …}
  updated_at timestamptz not null default now()
);
create unique index if not exists zone_maps_uq on public.zone_maps(scope_type, coalesce(scope_id, 0), mode);
-- war & strikes: areas (general or scoped) and exclusions (customer / policy / one-off pool)
alter table public.war_areas add column if not exists scope_type text not null default 'one_off_general';
alter table public.war_areas add column if not exists scope_id   bigint;
alter table public.war_exclusions add column if not exists scope_type text;
alter table public.war_exclusions add column if not exists scope_id   bigint;
update public.war_exclusions x set scope_type = 'customer', scope_id = c.id
  from public.customers c where x.group_id is not null and c.group_id = x.group_id and x.scope_type is null;
update public.war_exclusions set scope_type = 'policy', scope_id = policy_id where policy_id is not null and scope_type is null;
delete from public.war_exclusions where scope_type is null;
alter table public.war_exclusions drop constraint if exists war_exclusions_check;
alter table public.war_exclusions alter column scope_type set not null;
alter table public.war_exclusions drop constraint if exists war_exclusions_scope_check;
alter table public.war_exclusions add constraint war_exclusions_scope_check check (scope_type in ('one_off_general','customer','policy'));
-- the legacy links would delete customer exclusions together with a group; the scope is what counts now
update public.war_exclusions set group_id = null where group_id is not null;
-- clauses: general library or a customer's / policy's own clauses; defaults per customer and per policy
alter table public.clause_library add column if not exists scope_type text not null default 'one_off_general';
alter table public.clause_library add column if not exists scope_id   bigint;
drop index if exists public.clause_library_title_uq;
create unique index if not exists clause_library_title_uq on public.clause_library(scope_type, coalesce(scope_id, 0), category, title);
create table if not exists public.customer_clauses (
  customer_id bigint not null references public.customers(id) on delete cascade,
  clause_id   bigint not null references public.clause_library(id) on delete cascade,
  enabled     boolean not null default true,
  primary key (customer_id, clause_id)
);

do $$
declare t text;
begin
  foreach t in array array['commodity_terms','country_zones','scope_settings','zone_maps','customer_clauses'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists admin_all on public.%I', t);
    execute format('create policy admin_all on public.%I for all to authenticated using (public.is_admin()) with check (public.is_admin())', t);
  end loop;
end $$;

-- ---------- migration: general pool from today's data, Bertling gets its own copy ----------
insert into public.country_zones(scope_type, scope_id, iso2, sea_zone, air_zone, compliance, note)
select 'one_off_general', null, iso2, sea_zone, air_zone, compliance, note from public.countries
on conflict do nothing;
do $$
declare c record; t record; new_id text;
begin
  for c in select * from public.customers where cover_type in ('open_cover','policy') loop
    -- schedules
    for t in select * from public.rate_tables where scope_type = 'one_off_general' loop
      new_id := t.kind || '@c' || c.id;
      if not exists (select 1 from public.rate_tables where id = new_id) then
        insert into public.rate_tables(id, name, mode, zones, war_included_permille, min_premium, deck_allowed, contingency_allowed, used_loading_pct, cars_loading_pct, household_flat_permille, notes, sort, kind, scope_type, scope_id)
        values (new_id, t.name, t.mode, t.zones, t.war_included_permille, t.min_premium, t.deck_allowed, t.contingency_allowed, t.used_loading_pct, t.cars_loading_pct, t.household_flat_permille,
                'Schedule of ' || c.name || ' (copied from the general pool on ' || to_char(now(), 'DD Mon YYYY') || ').', t.sort, t.kind, 'customer', c.id);
        insert into public.rate_cells(table_id, zone_a, zone_b, permille) select new_id, zone_a, zone_b, permille from public.rate_cells where table_id = t.id;
      end if;
    end loop;
    -- zones & country check
    insert into public.country_zones(scope_type, scope_id, iso2, sea_zone, air_zone, compliance, note)
    select 'customer', c.id, iso2, sea_zone, air_zone, compliance, note from public.country_zones where scope_type = 'one_off_general'
    on conflict do nothing;
    -- cargo terms
    insert into public.commodity_terms(scope_type, scope_id, commodity_id, active, on_request, allowed_covers, class_factor, sea_table, air_class, oc_class, loading_pct, theft_attractive, deductible, conditions, max_sum_insured, ext_hssc, ext_liw)
    select 'customer', c.id, id, active, on_request, allowed_covers, class_factor, sea_table, air_class, oc_class, loading_pct, theft_attractive, deductible, conditions, max_sum_insured, ext_hssc, ext_liw
      from public.commodities on conflict do nothing;
    -- factors & limits
    insert into public.scope_settings(scope_type, scope_id, key, value)
    select 'customer', c.id, key, value from public.settings
     where key in ('cover_factors','conveyance_factors','packing_factors','deck_loading_pct','theft_land_factor','contingency_factor','sea_war_permille','air_war_permille','land_strikes_permille','land_rates','land_min_premium','auto_limit','uplift_pct','extensions','land_groups')
    on conflict do nothing;
    -- clause defaults of the customer = the ticks of its first policy
    insert into public.customer_clauses(customer_id, clause_id, enabled)
    select c.id, pc.clause_id, pc.enabled from public.policy_clauses pc
     where pc.policy_id = (select id from public.policies where customer_id = c.id order by sort, id limit 1)
    on conflict do nothing;
  end loop;
end $$;

-- a deleted customer / policy takes its own configuration with it (scoped rows have no foreign key)
create or replace function public.scope_cleanup() returns trigger
language plpgsql security definer set search_path = public as $$
declare st text := case tg_table_name when 'customers' then 'customer' else 'policy' end;
begin
  perform set_config('fc.audited', '1', true);
  delete from public.rate_tables    where scope_type = st and scope_id = old.id;   -- rate_cells cascade
  delete from public.commodity_terms where scope_type = st and scope_id = old.id;
  delete from public.country_zones  where scope_type = st and scope_id = old.id;
  delete from public.scope_settings where scope_type = st and scope_id = old.id;
  delete from public.zone_maps      where scope_type = st and scope_id = old.id;
  delete from public.war_exclusions where scope_type = st and scope_id = old.id;
  delete from public.clause_library where scope_type = st and scope_id = old.id;
  return old;
end $$;
drop trigger if exists customers_scope_cleanup on public.customers;
create trigger customers_scope_cleanup after delete on public.customers for each row execute function public.scope_cleanup();
drop trigger if exists policies_scope_cleanup on public.policies;
create trigger policies_scope_cleanup after delete on public.policies for each row execute function public.scope_cleanup();

-- the zone / compliance lock now protects country_zones
create or replace function public.rate_lock_guard() returns trigger
language plpgsql as $$
begin
  if auth.uid() is not null and coalesce(current_setting('fc.audited', true), '') <> '1' then
    if tg_table_name in ('countries','country_zones') then
      if tg_op = 'UPDATE' and (new.sea_zone is distinct from old.sea_zone or new.air_zone is distinct from old.air_zone) then
        raise exception 'zones are locked — change them in Internal → Rates with a reason';
      end if;
      return coalesce(new, old);
    end if;
    raise exception 'schedules are locked — change them in Internal → Rates with a reason';
  end if;
  return coalesce(new, old);
end $$;
drop trigger if exists country_zones_lock on public.country_zones;
create trigger country_zones_lock before update on public.country_zones for each row execute function public.rate_lock_guard();

-- ---------- resolution helpers (policy → customer; one-off → general pool only) ----------
-- the schedule of a kind (sea_new, air_freight, …) for this context
create or replace function public.rt_pick(p_kind text, p_pol bigint, p_cust bigint) returns public.rate_tables
language plpgsql stable security definer set search_path = public as $$
declare t public.rate_tables;
begin
  if p_pol is null and p_cust is null then
    select * into t from public.rate_tables where kind = p_kind and scope_type = 'one_off_general';
    return t;
  end if;
  if p_pol is not null then select * into t from public.rate_tables where kind = p_kind and scope_type = 'policy' and scope_id = p_pol; end if;
  if t.id is null and p_cust is not null then select * into t from public.rate_tables where kind = p_kind and scope_type = 'customer' and scope_id = p_cust; end if;
  return t;
end $$;
-- the zoning scope: the policy's own zones, else the customer's, else (one-off) the general pool
create or replace function public.zone_scope(p_pol bigint, p_cust bigint, out st text, out sid bigint)
language plpgsql stable security definer set search_path = public as $$
begin
  if p_pol is null and p_cust is null then st := 'one_off_general'; sid := null; return; end if;
  if p_pol is not null and exists (select 1 from public.country_zones where scope_type = 'policy' and scope_id = p_pol) then st := 'policy'; sid := p_pol; return; end if;
  if p_cust is not null and exists (select 1 from public.country_zones where scope_type = 'customer' and scope_id = p_cust) then st := 'customer'; sid := p_cust; return; end if;
  st := null; sid := null;
end $$;
create or replace function public.cz(p_iso text, p_st text, p_sid bigint) returns public.country_zones
language sql stable security definer set search_path = public as $$
  select * from public.country_zones where iso2 = p_iso and scope_type = p_st and coalesce(scope_id, 0) = coalesce(p_sid, 0)
$$;
-- cargo terms: the commodity row (general) or the customer's / policy's own terms; none → not covered
create or replace function public.cargo_pick(p_com text, p_pol bigint, p_cust bigint) returns public.commodities
language plpgsql stable security definer set search_path = public as $$
declare c public.commodities; t public.commodity_terms;
begin
  select * into c from public.commodities where id = p_com;
  if c.id is null or (p_pol is null and p_cust is null) then return c; end if;
  if p_pol is not null then select * into t from public.commodity_terms where scope_type = 'policy' and scope_id = p_pol and commodity_id = p_com; end if;
  if t.id is null and p_cust is not null then select * into t from public.commodity_terms where scope_type = 'customer' and scope_id = p_cust and commodity_id = p_com; end if;
  if t.id is null then
    c.active := true; c.on_request := true; c.oc_class := null; c.sea_table := null; c.air_class := null;   -- not part of this cover
    c.description := 'not configured for this customer / policy';
    return c;
  end if;
  c.active := t.active; c.on_request := t.on_request; c.allowed_covers := t.allowed_covers; c.class_factor := coalesce(t.class_factor, c.class_factor);
  c.sea_table := t.sea_table; c.air_class := t.air_class; c.oc_class := t.oc_class; c.loading_pct := t.loading_pct; c.theft_attractive := t.theft_attractive;
  c.deductible := t.deductible; c.conditions := t.conditions; c.max_sum_insured := t.max_sum_insured; c.ext_hssc := t.ext_hssc; c.ext_liw := t.ext_liw;
  return c;
end $$;
-- factors & limits: policy → customer → general settings
create or replace function public.sset(p_key text, p_pol bigint, p_cust bigint) returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce(
    (select value from public.scope_settings where scope_type = 'policy' and scope_id = p_pol and key = p_key),
    (select value from public.scope_settings where scope_type = 'customer' and scope_id = p_cust and key = p_key),
    (select value from public.settings where key = p_key))
$$;
-- which customer a user belongs to: office → profile → e-mail domain (customer, then single-customer group)
create or replace function public.user_customer_id(p_uid uuid) returns bigint
language sql stable security definer set search_path = public as $$
  select coalesce(
    (select o.customer_id from public.profiles p join public.offices o on o.id = p.office_id where p.id = p_uid),
    (select customer_id from public.profiles where id = p_uid),
    (select c.id from public.customers c, public.profiles p where p.id = p_uid and c.active and lower(split_part(p.email, '@', 2)) = any(c.email_domains) order by c.sort, c.id limit 1),
    (select min(c.id) from public.customers c join public.client_groups g on g.id = c.group_id, public.profiles p
      where p.id = p_uid and lower(split_part(p.email, '@', 2)) = any(g.email_domains) having count(*) = 1))
$$;
revoke execute on function public.user_customer_id(uuid) from public, anon, authenticated;
-- the group stays reachable for older code paths
create or replace function public.user_group_id(p_uid uuid) returns bigint
language sql stable security definer set search_path = public as $$
  select coalesce((select group_id from public.customers where id = public.user_customer_id(p_uid)),
    (select g.id from public.client_groups g, public.profiles p where p.id = p_uid and lower(split_part(p.email, '@', 2)) = any(g.email_domains) order by g.sort, g.id limit 1),
    (select group_id from public.profiles where id = p_uid))
$$;
revoke execute on function public.user_group_id(uuid) from public, anon, authenticated;
-- allowed currencies: office → policy → customer → group → general pool (first non-empty list)
create or replace function public.allowed_currencies(p_ofc bigint, p_pol bigint, p_cust bigint) returns text[]
language sql stable security definer set search_path = public as $$
  select coalesce(
    (select nullif(currencies, '{}') from public.offices where id = p_ofc),
    (select nullif(currencies, '{}') from public.policies where id = p_pol),
    (select nullif(currencies, '{}') from public.customers where id = p_cust),
    (select nullif(g.currencies, '{}') from public.customers c join public.client_groups g on g.id = c.group_id where c.id = p_cust),
    (select array(select jsonb_array_elements_text(value)) from public.settings where key = 'currencies'),
    array['EUR','USD'])
$$;
-- geographic side of Suez from the general pool (routing question, Red Sea assumption)
create or replace function public.suez_side(p_iso text) returns text
language sql stable security definer set search_path = public as $$
  select case when p_iso in ('EG','SA','JO','SD','ER','DJ','YE','IL') then 'r'
              when z.sea_zone in (5,6,11,12) then 'w' when z.sea_zone in (9,10,14,15,16,17,18,19) then 'e' end
    from public.country_zones z where z.iso2 = p_iso and z.scope_type = 'one_off_general'
$$;

-- ---------- the rating core: one calculation for a given context, no side effects ----------
-- p_pol / p_cust null → general one-off pool. Raises on invalid input. Returns a bundle used by
-- calc_indication (clients), admin_indicate (staff "New quotation") and the quotation update.
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
  c_blocked constant text := 'A route or party in this shipment is outside the cover — checked individually';
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
    v_reasons := array['Origin or destination is subject to sanctions — compliance review required'];

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

    if not pol.active then v_reasons := array_append(v_reasons, 'Your cover is not active — we quote this individually'::text); end if;
    if v_mode = 'land' then
      v_reasons := array_append(v_reasons, 'Road / rail transport on its own is quoted individually'::text);
      v_notes := array_append(v_notes, 'Simple road transport — must ask insurers for rate / terms before quoting'::text);
      if 'SA' in (o_c.iso2, d_c.iso2) then v_notes := array_append(v_notes, 'Road transport in Saudi Arabia only after request / underwriter approval'::text); end if;
    end if;
    if com.on_request then v_reasons := array_append(v_reasons, 'This type of cargo is quoted individually'::text);
    elsif v_mode <> 'land' and v_ocls is null then v_reasons := array_append(v_reasons, 'This cargo is not part of the open cover schedules — quoted individually'::text);
      v_notes := array_append(v_notes, 'Cargo type has no open cover class (Rates → Cargo types of this customer / policy)'::text);
    elsif v_mode <> 'land' and tb.id is null then v_reasons := array_append(v_reasons, 'No schedule for this cargo and conveyance — quoted individually'::text); end if;
    if not (v_cover = any(com.allowed_covers)) or v_cover = 'icc_b' or (v_cover = 'icc_c' and v_mode <> 'sea') then
      v_reasons := array_append(v_reasons, 'The chosen cover is quoted individually under the open cover'::text); end if;
    if zs.st is null and v_mode <> 'land' then v_reasons := array_append(v_reasons, 'No zones set up for this cover — quoted individually'::text);
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
      v_reasons := array_append(v_reasons, 'Sum insured above the limit of your open cover — quoted individually'::text);
      v_notes := array_append(v_notes, ('Over policy limit: ' || pol.currency || ' ' || to_char(v_limit, 'FM999,999,999,990') || (case when v_deck then ' on deck / barge' else ' any one conveyance' end))::text);
    end if;
    if v_dep is not null and v_dep < current_date then v_reasons := array_append(v_reasons, 'Departure date / ETA of loading lies in the past — cover cannot be backdated automatically'::text); end if;

    if array_length(v_reasons, 1) is null then
      if v_mode = 'air' and v_ocls = 'household' then
        v_base := public.policy_rule(pol.rules, array[v_kind, 'household_permille']); v_cell := v_base;
      else
        select permille into v_cell from public.rate_cells where table_id = tb.id and zone_a = least(zo, zd) and zone_b = greatest(zo, zd);
        if v_cell is null then v_reasons := array_append(v_reasons, 'No rate for this route in the open cover — quoted individually'::text);
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
      v_disc  := coalesce(prof.client_discount_pct, 0);
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
    if zs.st is null then v_reasons := array_append(v_reasons, 'No zones set up — quoted individually'::text);
    else
      if zo is null then v_reasons := array_append(v_reasons, ('Shipments from ' || o_c.name || ' are checked with underwriters individually')::text); end if;
      if zd is null then v_reasons := array_append(v_reasons, ('Shipments to ' || d_c.name || ' are checked with underwriters individually')::text); end if;
    end if;
    if o_c.local_insurance then v_reasons := array_append(v_reasons, ('Local insurance rules apply in ' || o_c.name || ' — we check this individually')::text); end if;
    if d_c.local_insurance then v_reasons := array_append(v_reasons, ('Local insurance rules apply in ' || d_c.name || ' — we check this individually')::text); end if;
    if o_c.on_request or coalesce(o_r.on_request, false) then v_reasons := array_append(v_reasons, ('Shipments from ' || o_c.name || ' are quoted individually')::text); end if;
    if d_c.on_request or coalesce(d_r.on_request, false) then v_reasons := array_append(v_reasons, ('Shipments to ' || d_c.name || ' are quoted individually')::text); end if;
    if v_deck and (tb.id is null or not tb.deck_allowed or com.id in ('vehicles_new','vehicles_used','household','reefer','pharma','electronics')) then
      v_reasons := array_append(v_reasons, 'On-deck shipment of this cargo is quoted individually'::text); end if;
    if v_mode = 'land' and o_c.iso2 <> d_c.iso2 and zo is not null and zd is not null and zo <> zd
       and not exists (select 1 from jsonb_each(coalesce(public.sset('land_groups', p_pol, p_cust), '{}'::jsonb)) g
                        where g.value @> to_jsonb(zo) and g.value @> to_jsonb(zd)) then
      v_reasons := array_append(v_reasons, ('No road / rail connection between ' || o_c.name || ' and ' || d_c.name || ' in our tariff — please choose sea or air, or request a quotation')::text); end if;
    v_limit := coalesce(com.max_sum_insured, (public.sset('auto_limit', p_pol, p_cust)->>v_cur)::numeric);
    if (public.sset('auto_limit', p_pol, p_cust)->>v_cur)::numeric is not null then v_limit := least(v_limit, (public.sset('auto_limit', p_pol, p_cust)->>v_cur)::numeric); end if;
    if pol.id is not null and pol.limit_conveyance is not null then v_limit := least(coalesce(v_limit, pol.limit_conveyance), pol.limit_conveyance); end if;
    if v_limit is not null and v_si > v_limit then v_reasons := array_append(v_reasons, 'Sum insured above the automatic limit for this cargo'::text); end if;
    if v_dep is not null and v_dep < current_date then v_reasons := array_append(v_reasons, 'Departure date / ETA of loading lies in the past — cover cannot be backdated automatically'::text); end if;

    if array_length(v_reasons, 1) is null then
      if v_mode = 'land' then
        v_base := coalesce((public.sset('land_rates', p_pol, p_cust)->>v_band)::numeric, 1);
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
      v_disc  := coalesce(prof.client_discount_pct, 0);
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
      v_alerts := v_alerts || jsonb_build_object('level', 'red', 'text', 'Blocked / prohibited: ' || (select name from public.countries where iso2 = v_cc) || ' (' || v_role || ')' || case when pol.id is not null then ' — do not quote under the open cover' else '' end);
      if not (c_blocked = any(v_reasons)) then v_reasons := array_append(v_reasons, c_blocked); end if;
    elsif v_comp = 'local' and not (v_cc = 'AE') then
      v_alerts := v_alerts || jsonb_build_object('level', 'amber', 'text', 'Compliance / local licensing: ' || (select name from public.countries where iso2 = v_cc) || ' (' || v_role || ') — check admitted / local insurers');
    elsif v_comp = 'hold' then
      v_alerts := v_alerts || jsonb_build_object('level', 'yellow', 'text', 'Hold covered: ' || (select name from public.countries where iso2 = v_cc) || ' (' || v_role || ') — refer to underwriters prior to attachment');
      if not (c_hold = any(v_reasons)) then v_reasons := array_append(v_reasons, c_hold); end if;
    end if;
  end loop;
  if v_dom_cc = 'AE' then
    if v_ins_cc is null then v_ftz := ofc.ftz; end if;
    if not coalesce(v_ftz, false) then
      v_alerts := v_alerts || jsonb_build_object('level', 'amber', 'text', 'UAE interest ' || case when v_ftz is null then 'with unknown Free Trade Zone status' else 'on the mainland (no FTZ)' end || ' — place with local UAE insurers');
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
              if not (v_alerts @> jsonb_build_array(jsonb_build_object('level', 'orange', 'text', 'Port in ' || (select name from public.countries where iso2 = v_cc) || ' not stated or not known — both coasts assumed'))) then
                v_alerts := v_alerts || jsonb_build_object('level', 'orange', 'text', 'Port in ' || (select name from public.countries where iso2 = v_cc) || ' not stated or not known — both coasts assumed'); end if;
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
    'out_of_cover', pol.id is not null and exists (select 1 from unnest(v_reasons) x where x not like 'Departure date%' and x <> c_hold),
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
revoke execute on function public.rate_core(jsonb, uuid, bigint, bigint, bigint) from public, anon, authenticated;

-- ---------- storing an indication (shared by clients and staff) ----------
create or replace function public.assign_ref(p_id bigint) returns text
language plpgsql security definer set search_path = public as $$
declare v_ref text; v_month text := to_char(now() at time zone 'Europe/Berlin', 'YYMM');
begin
  select ref into v_ref from public.indications where id = p_id for update;
  if v_ref is null then
    v_ref := 'FRCN-' || v_month || '-' || lpad(public.next_counter('ind-' || v_month)::text, 4, '0');
    update public.indications set ref = v_ref where id = p_id;
  end if;
  return v_ref;
end $$;
revoke execute on function public.assign_ref(bigint) from public, anon, authenticated;

-- r1: result in the client's own context, r2: one-off result when the shipment is out of cover
create or replace function public.store_indication(p jsonb, r1 jsonb, r2 jsonb, p_user uuid, p_company text, p_ofc bigint, p_pol bigint, p_cust bigint,
                                                    p_hide boolean, p_source text, p_detail_visible boolean) returns public.indications
language plpgsql security definer set search_path = public as $$
declare r public.indications; n jsonb := r1->'n'; ooc boolean := coalesce((r1->>'out_of_cover')::boolean, false); x jsonb;
  v_status text; v_reasons text[];
begin
  x := case when ooc and r2 is not null then r2 else r1 end;    -- what the brokers work with
  if p_hide then v_status := 'on_request'; v_reasons := '{}';
  elsif ooc then v_status := 'on_request'; v_reasons := array['Outside your open cover — we quote this shipment separately'] || array(select jsonb_array_elements_text(r1->'ooc_reasons'));
  else v_status := r1->>'status'; v_reasons := array(select jsonb_array_elements_text(r1->'reasons')); end if;

  insert into public.indications(user_id, company, commodity_id, goods_description, packaging, conveyance,
      origin_country, origin_place, dest_country, dest_place, departure_date, invoice_value, currency,
      uplift_pct, sum_insured, cover, war_strikes, status, rate_pct, premium_gross, discount_pct, premium,
      min_applied, reasons, conditions, vessel, incoterm, insured_party, on_deck, interest_only, calc_detail,
      insured_name, insured_address, customer_ref, source, ext_hssc, ext_liw, office_id, policy_id, intake, quote_requested_at,
      transit_countries, insured_country, ftz, freight_value, red_sea, details, war_excluded,
      customer_id, is_out_of_cover, out_of_cover_reasons, declared_policy_id)
  values (p_user, p_company, n->>'commodity_id', left(trim(p->>'goods_description'), 300), left(nullif(n->>'packaging', ''), 100), n->>'conveyance',
      n->>'origin_country', left(nullif(trim(p->>'origin_place'), ''), 100), n->>'dest_country', left(nullif(trim(p->>'dest_place'), ''), 100),
      (n->>'departure_date')::date, (n->>'invoice_value')::numeric, n->>'currency',
      (n->>'uplift_pct')::numeric, (n->>'sum_insured')::numeric, n->>'cover', (n->>'war_strikes')::boolean,
      v_status,
      case when v_status = 'quoted' then (r1->>'rate')::numeric end, case when v_status = 'quoted' then (r1->>'gross')::numeric end,
      case when v_status = 'quoted' then (r1->>'disc')::numeric else 0 end, case when v_status = 'quoted' then (r1->>'net')::numeric end,
      v_status = 'quoted' and coalesce((r1->>'min_hit')::boolean, false), v_reasons, r1->>'conditions', left(n->>'vessel', 100), n->>'incoterm', n->>'insured_party',
      (n->>'on_deck')::boolean, (n->>'interest_only')::boolean, case when p_detail_visible then x->'detail' end,
      left(nullif(trim(coalesce(p->>'insured_name', '')), ''), 150), left(nullif(trim(coalesce(p->>'insured_address', '')), ''), 250),
      left(nullif(trim(coalesce(p->>'customer_ref', '')), ''), 60), p_source, (n->>'ext_hssc')::boolean, (n->>'ext_liw')::boolean,
      p_ofc, case when ooc then null else p_pol end, p_hide, case when p_hide or p_source = 'staff' then now() end,
      array(select jsonb_array_elements_text(n->'transit_countries')), n->>'insured_country', (n->>'ftz')::boolean, nullif((n->>'freight_value')::numeric, 0),
      n->>'red_sea', n->'details', array(select jsonb_array_elements_text(r1->'war_names')),
      p_cust, ooc, case when ooc then array(select jsonb_array_elements_text(r1->'ooc_reasons')) else '{}' end, case when ooc then p_pol end)
  returning * into r;

  insert into public.indication_internal(indication_id, status, rate_pct, premium_gross, premium, min_applied, reasons, notes, calc_detail, alerts, war)
  values (r.id, x->>'status', (x->>'rate')::numeric, (x->>'gross')::numeric, (x->>'net')::numeric, coalesce((x->>'min_hit')::boolean, false),
          array(select jsonb_array_elements_text(x->'reasons')),
          array(select jsonb_array_elements_text(r1->'notes')) || case when ooc then array['Out of cover — rated with the general one-off pool: ' || array_to_string(array(select jsonb_array_elements_text(r1->'ooc_reasons')), '; ')] else '{}'::text[] end,
          x->'detail',
          case when ooc then coalesce(r1->'alerts', '[]'::jsonb) || jsonb_build_array(jsonb_build_object('level', 'red', 'text', 'Out of cover — not attached to the policy; quote as a one-off')) || coalesce(r2->'alerts', '[]'::jsonb)
               else coalesce(x->'alerts', '[]'::jsonb) end,
          x->'war');
  return r;
end $$;
revoke execute on function public.store_indication(jsonb, jsonb, jsonb, uuid, text, bigint, bigint, bigint, boolean, text, boolean) from public, anon, authenticated;

-- ---------- client calculation ----------
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
  v_hide := cust.id is not null and not coalesce(cust.show_premium, grp.show_premium, true) and not prof.is_admin;

  if pol.id is not null then
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

-- ---------- staff: indication for any context, optionally logged as a request ----------
-- p_one_off true → general one-off pool; else customer / office / policy
create or replace function public.admin_indicate(p jsonb, p_customer bigint, p_office bigint, p_policy bigint, p_one_off boolean, p_save boolean, p_user uuid default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare ofc public.offices; pol public.policies; cust public.customers; r1 jsonb; r2 jsonb; r public.indications; v_company text;
begin
  if not public.is_admin() then raise exception 'not authorised'; end if;
  if p_office is not null then select * into ofc from public.offices where id = p_office; end if;
  if not coalesce(p_one_off, false) then
    select * into pol from public.policies where id = coalesce(p_policy, ofc.policy_id);
    select * into cust from public.customers where id = coalesce(p_customer, pol.customer_id, ofc.customer_id);
    if pol.id is null and cust.id is not null then select * into pol from public.policies where customer_id = cust.id and active order by sort, id limit 1; end if;
  else
    select * into cust from public.customers where id = p_customer;
  end if;
  if pol.id is not null and not coalesce(p_one_off, false) then
    r1 := public.rate_core(p, p_user, ofc.id, pol.id, cust.id);
    if (r1->>'out_of_cover')::boolean then r2 := public.rate_core(p, p_user, ofc.id, null, null); end if;
  else
    r1 := public.rate_core(p, p_user, ofc.id, null, null);
  end if;
  if coalesce(p_save, false) then
    v_company := coalesce(nullif(trim(p->>'company'), ''), ofc.name, cust.name, (select company from public.profiles where id = p_user), 'Staff indication');
    r := public.store_indication(p, r1, r2, coalesce(p_user, auth.uid()), v_company, ofc.id, case when coalesce(p_one_off, false) then null else pol.id end, cust.id, false, 'staff', true);
    r.ref := public.assign_ref(r.id);
  end if;
  return jsonb_build_object('result', r1, 'one_off', r2, 'policy', case when pol.id is null then null else jsonb_build_object('id', pol.id, 'name', pol.name, 'policy_no', pol.policy_no, 'currency', pol.currency) end,
                            'customer', case when cust.id is null then null else jsonb_build_object('id', cust.id, 'name', cust.name) end,
                            'saved', case when r.id is null then null else jsonb_build_object('id', r.id, 'ref', r.ref) end);
end $$;
grant execute on function public.admin_indicate(jsonb, bigint, bigint, bigint, boolean, boolean, uuid) to authenticated;

-- ---------- client: own set-up ----------
create or replace function public.my_org() returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare p public.profiles; c public.customers; g public.client_groups; o public.offices; po public.policies; v_type text;
begin
  select * into p from public.profiles where id = auth.uid();
  if not found then return null; end if;
  select * into c from public.customers where id = public.user_customer_id(p.id);
  select * into g from public.client_groups where id = coalesce(c.group_id, public.user_group_id(p.id));
  v_type := coalesce(p.cover_type, c.cover_type, 'one_off');
  if p.office_id is not null then select * into o from public.offices where id = p.office_id; select * into po from public.policies where id = o.policy_id; end if;
  return jsonb_build_object(
    'cover_type', v_type,
    'customer', case when c.id is null then null else jsonb_build_object('id', c.id, 'name', c.name) end,
    'group', case when g.id is null and c.id is null then null else jsonb_build_object('id', g.id, 'name', coalesce(c.name, g.name),
               'kind', case when v_type in ('open_cover','policy') then 'open_cover' else 'spot' end,
               'show_premium', coalesce(c.show_premium, g.show_premium, true)) end,
    'currencies', to_jsonb(public.allowed_currencies(null, null, c.id)),
    'office', case when o.id is null then null else jsonb_build_object('id', o.id, 'name', o.name, 'location', o.location, 'country', o.country,
                'policy', po.name, 'policy_no', po.policy_no, 'currency', po.currency, 'currencies', to_jsonb(public.allowed_currencies(o.id, o.policy_id, c.id))) end,
    'offices', case when c.id is null or v_type = 'one_off' then '[]'::jsonb else coalesce((
        select jsonb_agg(jsonb_build_object('id', x.id, 'name', x.name, 'location', x.location, 'country', x.country, 'kind', x.kind,
                                            'policy', coalesce(y.name, c.name), 'policy_no', y.policy_no, 'currency', coalesce(y.currency, (public.allowed_currencies(x.id, x.policy_id, c.id))[1]),
                                            'currencies', to_jsonb(public.allowed_currencies(x.id, x.policy_id, c.id)))
                         order by y.sort nulls last, y.id, case x.kind when 'office' then 0 when 'warehouse' then 1 else 2 end, x.sort, x.name)
          from public.offices x left join public.policies y on y.id = x.policy_id
         where x.customer_id = c.id and x.active and (y.id is null or y.active)), '[]'::jsonb) end);
end $$;
grant execute on function public.my_org() to authenticated;

create or replace function public.set_my_office(p_office_id bigint) returns boolean
language plpgsql security definer set search_path = public as $$
declare o public.offices; v_c bigint;
begin
  select * into o from public.offices where id = p_office_id and active;
  if not found then raise exception 'invalid office'; end if;
  v_c := public.user_customer_id(auth.uid());
  if v_c is null or o.customer_id <> v_c then raise exception 'invalid office'; end if;
  update public.profiles set office_id = o.id, customer_id = o.customer_id where id = auth.uid();
  return true;
end $$;
grant execute on function public.set_my_office(bigint) to authenticated;

create or replace function public.touch_login() returns void
language sql security definer set search_path = public as $$
  update public.profiles set last_login_at = now() where id = auth.uid()
$$;
grant execute on function public.touch_login() to authenticated;

create or replace function public.is_approved() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select approved and not rejected and is_active from public.profiles where id = auth.uid()), false)
$$;

create or replace function public.profiles_guard() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() and current_user not in ('postgres','service_role','supabase_admin') then
    if new.is_admin is distinct from old.is_admin or new.approved is distinct from old.approved
       or new.rejected is distinct from old.rejected or new.client_discount_pct is distinct from old.client_discount_pct
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

create or replace function public.list_countries() returns table(iso2 text, name text, sanctioned boolean, on_request boolean, suez text)
language sql stable security definer set search_path = public as $$
  select c.iso2, c.name, c.sanctioned, c.on_request, public.suez_side(c.iso2) from public.countries c order by c.name
$$;
grant execute on function public.list_countries() to authenticated, anon;

create or replace function public.my_history(p_limit int default 200) returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(to_jsonb(s) order by s.created_at desc), '[]'::jsonb) from (
    select i.id, i.ref, i.created_at, i.goods_description, i.commodity_id, i.conveyance, i.origin_country, i.origin_place,
           i.dest_country, i.dest_place, i.departure_date, i.invoice_value, i.currency, i.uplift_pct, i.sum_insured, i.cover,
           i.war_strikes, i.status, i.rate_pct, i.premium_gross, i.discount_pct, i.premium, i.min_applied, i.reasons, i.conditions,
           i.packaging, i.vessel, i.incoterm, i.insured_party, i.on_deck, i.interest_only, i.insured_name, i.insured_address,
           i.customer_ref, i.source, i.ext_hssc, i.ext_liw, i.pdf_downloaded_at, i.quote_requested_at, i.customer_comment,
           i.office_id, i.intake, i.transit_countries, i.insured_country, i.ftz, i.freight_value, i.red_sea, i.details, i.war_excluded, i.is_out_of_cover
      from public.indications i
     where i.user_id = auth.uid() and not i.hidden_by_user
     order by i.created_at desc limit least(greatest(p_limit, 1), 500)
  ) s
$$;
grant execute on function public.my_history(int) to authenticated;

-- ---------- zones per scope (locked: reason + change log) ----------
drop function if exists public.admin_set_zones(jsonb, text);
create or replace function public.admin_set_zones(p_rows jsonb, p_reason text, p_scope_type text default 'one_off_general', p_scope_id bigint default null) returns int
language plpgsql security definer set search_path = public as $$
declare me public.profiles; c jsonb; z public.country_zones; v_sea int; v_air int; v_ch text[] := '{}'; v_name text;
begin
  if not public.is_admin() then raise exception 'not authorised'; end if;
  if length(trim(coalesce(p_reason, ''))) < 3 then raise exception 'reason required'; end if;
  if p_scope_type = 'one_off_general' then p_scope_id := null; end if;
  select * into me from public.profiles where id = auth.uid();
  perform set_config('fc.audited', '1', true);
  for c in select * from jsonb_array_elements(coalesce(p_rows, '[]'::jsonb)) loop
    select name into v_name from public.countries where iso2 = c->>'iso2';
    if v_name is null then raise exception 'unknown country %', c->>'iso2'; end if;
    z := public.cz(c->>'iso2', p_scope_type, p_scope_id);
    v_sea := nullif(c->>'sea_zone', '')::int; v_air := nullif(c->>'air_zone', '')::int;
    if z.id is null then
      insert into public.country_zones(scope_type, scope_id, iso2, sea_zone, air_zone) values (p_scope_type, p_scope_id, c->>'iso2', v_sea, v_air);
      v_ch := v_ch || (v_name || ': sea — → ' || coalesce(v_sea::text, '—') || ', air — → ' || coalesce(v_air::text, '—'));
    elsif v_sea is distinct from z.sea_zone or v_air is distinct from z.air_zone then
      update public.country_zones set sea_zone = v_sea, air_zone = v_air, updated_at = now() where id = z.id;
      v_ch := v_ch || (v_name || ': sea ' || coalesce(z.sea_zone::text, '—') || ' → ' || coalesce(v_sea::text, '—') || ', air ' || coalesce(z.air_zone::text, '—') || ' → ' || coalesce(v_air::text, '—'));
    end if;
    if p_scope_type = 'one_off_general' then update public.countries set sea_zone = v_sea, air_zone = v_air where iso2 = c->>'iso2'; end if;
  end loop;
  if array_length(v_ch, 1) is not null then
    insert into public.audit_log(user_id, user_name, entity, entity_id, summary, reason)
    values (auth.uid(), coalesce(me.full_name, me.email), 'zones', p_scope_type || coalesce(':' || p_scope_id, ''), array_to_string(v_ch, '; '), trim(p_reason));
  end if;
  return coalesce(array_length(v_ch, 1), 0);
end $$;
grant execute on function public.admin_set_zones(jsonb, text, text, bigint) to authenticated;

drop function if exists public.admin_zone_count(text, text, text);
create or replace function public.admin_zone_count(p_mode text, p_action text, p_reason text, p_scope_type text default 'one_off_general', p_scope_id bigint default null) returns int
language plpgsql security definer set search_path = public as $$
declare me public.profiles; n int; v_list text;
begin
  if not public.is_admin() then raise exception 'not authorised'; end if;
  if p_mode not in ('sea','air') or p_action not in ('add','remove') then raise exception 'invalid'; end if;
  if length(trim(coalesce(p_reason, ''))) < 3 then raise exception 'reason required'; end if;
  if p_scope_type = 'one_off_general' then p_scope_id := null; end if;
  select * into me from public.profiles where id = auth.uid();
  perform set_config('fc.audited', '1', true);
  select max(zones) into n from public.rate_tables where mode = p_mode and scope_type = p_scope_type and coalesce(scope_id, 0) = coalesce(p_scope_id, 0);
  if n is null then raise exception 'no % schedules in this scope', p_mode; end if;
  if p_action = 'add' then
    update public.rate_tables set zones = n + 1, updated_at = now() where mode = p_mode and scope_type = p_scope_type and coalesce(scope_id, 0) = coalesce(p_scope_id, 0);
    insert into public.audit_log(user_id, user_name, entity, entity_id, summary, reason)
    values (auth.uid(), coalesce(me.full_name, me.email), 'zones', p_scope_type || coalesce(':' || p_scope_id, ''), initcap(p_mode) || ' zone ' || (n + 1) || ' added (rates empty = on request until filled in)', trim(p_reason));
    return n + 1;
  end if;
  if n <= 1 then raise exception 'at least one zone'; end if;
  select string_agg(c.name, ', ' order by c.name) into v_list from public.country_zones z join public.countries c on c.iso2 = z.iso2
   where z.scope_type = p_scope_type and coalesce(z.scope_id, 0) = coalesce(p_scope_id, 0) and (case p_mode when 'sea' then z.sea_zone else z.air_zone end) = n;
  if p_mode = 'sea' then update public.country_zones set sea_zone = null where scope_type = p_scope_type and coalesce(scope_id, 0) = coalesce(p_scope_id, 0) and sea_zone = n;
  else update public.country_zones set air_zone = null where scope_type = p_scope_type and coalesce(scope_id, 0) = coalesce(p_scope_id, 0) and air_zone = n; end if;
  delete from public.rate_cells c using public.rate_tables t where t.id = c.table_id and t.mode = p_mode and t.scope_type = p_scope_type and coalesce(t.scope_id, 0) = coalesce(p_scope_id, 0) and c.zone_b = n;
  update public.rate_tables set zones = n - 1, updated_at = now() where mode = p_mode and scope_type = p_scope_type and coalesce(scope_id, 0) = coalesce(p_scope_id, 0);
  insert into public.audit_log(user_id, user_name, entity, entity_id, summary, reason)
  values (auth.uid(), coalesce(me.full_name, me.email), 'zones', p_scope_type || coalesce(':' || p_scope_id, ''), initcap(p_mode) || ' zone ' || n || ' removed; now unassigned: ' || coalesce(v_list, 'no countries'), trim(p_reason));
  return n - 1;
end $$;
grant execute on function public.admin_zone_count(text, text, text, text, bigint) to authenticated;

-- ---------- copy / apply configuration to other scopes ----------
-- p_parts: schedules, cargo, zones, factors, map, war, clauses
-- p_targets: [{"type":"customer","id":3}, {"type":"policy","id":7}, {"type":"one_off_general"}]
-- p_items (optional): {"schedules":["sea_new"], "cargo":["general"], "zones":["DE","FR"], "clauses":[12,13]}
-- Target-specific identifiers (policy number, currency, limits, minimum premium, deductible, security) are never touched.
drop function if exists public.admin_copy_config(text[], text, bigint, jsonb, jsonb, text);
create or replace function public.admin_copy_config(p_parts_j jsonb, p_from_type text, p_from_id bigint, p_targets jsonb, p_items jsonb, p_reason text) returns int
language plpgsql security definer set search_path = public as $$
declare p_parts text[] := array(select jsonb_array_elements_text(p_parts_j)); me public.profiles; tg jsonb; tt text; ti bigint; n int := 0; t public.rate_tables; new_id text; sfx text; k text; v jsonb; x record; cid bigint; c public.clause_library;
  keys text[] := array['cover_factors','conveyance_factors','packing_factors','deck_loading_pct','theft_land_factor','contingency_factor','sea_war_permille','air_war_permille','land_strikes_permille','land_rates','land_min_premium','auto_limit','uplift_pct','extensions','land_groups'];
  it_s text[] := array(select jsonb_array_elements_text(coalesce(p_items->'schedules', 'null'::jsonb)) where jsonb_typeof(p_items->'schedules') = 'array');
  it_c text[] := array(select jsonb_array_elements_text(p_items->'cargo') where jsonb_typeof(p_items->'cargo') = 'array');
  it_z text[] := array(select jsonb_array_elements_text(p_items->'zones') where jsonb_typeof(p_items->'zones') = 'array');
  it_k bigint[] := array(select (jsonb_array_elements_text(p_items->'clauses'))::bigint where jsonb_typeof(p_items->'clauses') = 'array');
begin
  if not public.is_admin() then raise exception 'not authorised'; end if;
  if length(trim(coalesce(p_reason, ''))) < 3 then raise exception 'reason required'; end if;
  if p_from_type = 'one_off_general' then p_from_id := null; end if;
  select * into me from public.profiles where id = auth.uid();
  perform set_config('fc.audited', '1', true);
  for tg in select * from jsonb_array_elements(coalesce(p_targets, '[]'::jsonb)) loop
    tt := tg->>'type'; ti := case when tt = 'one_off_general' then null else (tg->>'id')::bigint end;
    if tt not in ('one_off_general','customer','policy') then raise exception 'invalid target'; end if;
    if tt = p_from_type and coalesce(ti, 0) = coalesce(p_from_id, 0) then continue; end if;
    sfx := case tt when 'customer' then '@c' || ti when 'policy' then '@p' || ti else '' end;

    if 'schedules' = any(p_parts) then
      for t in select * from public.rate_tables where scope_type = p_from_type and coalesce(scope_id, 0) = coalesce(p_from_id, 0)
                 and (array_length(it_s, 1) is null or kind = any(it_s)) loop
        new_id := t.kind || sfx;
        insert into public.rate_tables(id, name, mode, zones, war_included_permille, min_premium, deck_allowed, contingency_allowed, used_loading_pct, cars_loading_pct, household_flat_permille, notes, sort, kind, scope_type, scope_id)
        values (new_id, t.name, t.mode, t.zones, t.war_included_permille, t.min_premium, t.deck_allowed, t.contingency_allowed, t.used_loading_pct, t.cars_loading_pct, t.household_flat_permille, t.notes, t.sort, t.kind, tt, ti)
        on conflict (id) do update set name = excluded.name, zones = excluded.zones, war_included_permille = excluded.war_included_permille, min_premium = excluded.min_premium,
          deck_allowed = excluded.deck_allowed, contingency_allowed = excluded.contingency_allowed, used_loading_pct = excluded.used_loading_pct,
          cars_loading_pct = excluded.cars_loading_pct, household_flat_permille = excluded.household_flat_permille, updated_at = now();
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
end $$;
grant execute on function public.admin_copy_config(jsonb, text, bigint, jsonb, jsonb, text) to authenticated;

notify pgrst, 'reload schema';
