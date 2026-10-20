-- =====================================================================
-- FREIGHTCON — database schema for Supabase (PostgreSQL 15+)
-- Cargo Insurance Indications, Quotations & Cover
--
-- Run this once in a NEW Supabase project: Dashboard → SQL Editor → paste → Run.
-- It is idempotent where practical (CREATE ... IF NOT EXISTS / OR REPLACE),
-- so it can be re-run after changes.
--
-- Design:
--  * Customers never read the rate tables. Indications are calculated in the
--    database (calc_indication), so rates stay confidential and every number a
--    customer sees is the number that was logged.
--  * Every change that should alert someone writes a row to public.outbox.
--    A Database Webhook on outbox INSERT calls the Edge Function "notify",
--    which sends Telegram + e-mail (see README).
--  * Admins (profiles.is_admin) can read and edit everything through RLS.
-- =====================================================================


-- ---------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------
create or replace function public.touch_updated_at() returns trigger
language plpgsql as $$ begin new.updated_at := now(); return new; end $$;

-- ---------------------------------------------------------------------
-- Profiles (one per auth user)
-- ---------------------------------------------------------------------
create table if not exists public.profiles (
  id                    uuid primary key references auth.users(id) on delete cascade,
  email                 text not null,
  full_name             text,
  company               text,
  country               text,
  phone                 text,
  approved              boolean not null default false,
  rejected              boolean not null default false,
  is_admin              boolean not null default false,
  terms_version         text,
  referral_code         text unique,
  referred_by           uuid references public.profiles(id) on delete set null,
  client_discount_pct   numeric(5,2) not null default 0 check (client_discount_pct >= 0 and client_discount_pct < 100),
  internal_note         text,
  deletion_requested_at timestamptz,
  approved_at           timestamptz,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);
create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select is_admin from public.profiles where id = auth.uid()), false)
$$;

create or replace function public.is_approved() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select approved and not rejected from public.profiles where id = auth.uid()), false)
$$;

drop trigger if exists profiles_touch on public.profiles;
create trigger profiles_touch before update on public.profiles for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------------
-- Settings (key/value). Customers read a safe subset via public_settings().
-- ---------------------------------------------------------------------
create table if not exists public.settings (
  key        text primary key,
  value      jsonb not null,
  note       text,
  updated_at timestamptz not null default now()
);

insert into public.settings(key, value, note) values
  ('uplift_pct',           '10',      'Default uplift on invoice value (CIF + x %) for the sum insured'),
  ('cover_factors',        '{"icc_a":1.0,"icc_b":0.75,"icc_c":0.55}', 'Multiplier on the base rate per cover (ICC A / B / C)'),
  ('min_premium',          '{"EUR":75,"USD":85}', 'Minimum premium per shipment'),
  ('auto_limit',           '{"EUR":2000000,"USD":2200000}', 'Highest sum insured that is priced automatically; above → on request'),
  ('deductible_text',      '"EUR / USD 500 each and every loss"', 'Deductible shown on indications'),
  ('referral_discount_pct','5',       'Client discount granted to a customer who brings in a new customer'),
  ('maintenance',          'false',   'When true customers cannot calculate or request'),
  ('telegram_enabled',     'true',    'Telegram alerts on/off'),
  ('email_enabled',        'true',    'E-mail alerts on/off'),
  ('alert_cc',             '""',      'Address that receives every alert (e.g. placing@…)'),
  ('staff_emails',         '[]',      'Addresses that receive staff alerts (new requests, responses, registrations)'),
  ('brand_name',           '"FREIGHTCON"', 'Shown in e-mails and PDFs'),
  ('company_legal',        '""',      'Legal entity shown on PDFs and e-mails'),
  ('default_insurer',      '""',      'Pre-filled insurer on quotations'),
  ('quote_closing',        '"To accept, please confirm in FREIGHTCON before the quotation expires. Cover is only bound once confirmed in writing."', 'Default closing text on quotations'),
  ('quote_subjectivities', '["Subject to satisfactory sanctions screening of all parties","Subject to no known or reported losses","Institute Cargo Clauses (2009) as stated","Institute War Clauses (Cargo) and Institute Strikes Clauses (Cargo) if war & strikes is included","Institute Classification Clause and Cargo ISM Endorsement","Sanction Limitation and Exclusion Clause (JC2010/014)"]', 'Default subjectivities on quotations'),
  ('claims_text',          '"Notify us immediately of any loss or damage. Note exceptions on the delivery receipt, keep damaged goods and packing, and hold carriers liable in writing within the time limits. A surveyor will be appointed where needed."', 'Claims instructions printed on cover notes'),
  ('terms_version',        '"2026-10-20"', 'Current Terms of Use version customers must accept')
on conflict (key) do nothing;

create or replace function public.setting(p_key text) returns jsonb
language sql stable security definer set search_path = public as $$
  select value from public.settings where key = p_key
$$;

-- ---------------------------------------------------------------------
-- Rating tables (admin only)
-- ---------------------------------------------------------------------
create table if not exists public.regions (
  id         text primary key,
  name       text not null,
  factor     numeric(6,3) not null default 1 check (factor > 0),    -- multiplier on the base rate
  war_rate   numeric(6,4) not null default 0 check (war_rate >= 0),  -- % of sum insured added for war & strikes
  on_request boolean not null default false,
  sanctioned boolean not null default false,
  sort       int not null default 100,
  updated_at timestamptz not null default now()
);

create table if not exists public.countries (
  iso2       text primary key check (iso2 ~ '^[A-Z]{2}$'),
  name       text not null,
  region_id  text not null references public.regions(id),
  on_request boolean not null default false,   -- this country is always quoted individually
  sanctioned boolean not null default false,   -- no indication, compliance review
  note       text,
  updated_at timestamptz not null default now()
);

-- base rates in % of the sum insured, per conveyance; NULL = not priced automatically for that conveyance
create table if not exists public.commodities (
  id                text primary key,
  name              text not null,
  description       text,
  rate_sea_container numeric(6,4),
  rate_sea_breakbulk numeric(6,4),
  rate_air          numeric(6,4),
  rate_road         numeric(6,4),
  rate_rail         numeric(6,4),
  allowed_covers    text[] not null default array['icc_a','icc_b','icc_c'],
  on_request        boolean not null default false,
  conditions        text,       -- special conditions shown on the indication (e.g. rust exclusion)
  active            boolean not null default true,
  sort              int not null default 100,
  updated_at        timestamptz not null default now()
);

do $$ begin
  perform 1;
  drop trigger if exists regions_touch on public.regions;
  create trigger regions_touch before update on public.regions for each row execute function public.touch_updated_at();
  drop trigger if exists countries_touch on public.countries;
  create trigger countries_touch before update on public.countries for each row execute function public.touch_updated_at();
  drop trigger if exists commodities_touch on public.commodities;
  create trigger commodities_touch before update on public.commodities for each row execute function public.touch_updated_at();
end $$;

-- ---------------------------------------------------------------------
-- Insurers (admin only)
-- ---------------------------------------------------------------------
create table if not exists public.insurers (
  id         bigserial primary key,
  name       text not null,
  contact    text,
  email      text,
  phone      text,
  notes      text,
  active     boolean not null default true,
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------
-- Reference numbers (FRCN-YYMM-NNNN, FRCN-CN-YYYY-NNNN, …)
-- ---------------------------------------------------------------------
create table if not exists public.ref_counters (
  scope text primary key,
  n     int not null default 0
);

create or replace function public.next_counter(p_scope text) returns int
language plpgsql security definer set search_path = public as $$
declare v int;
begin
  insert into public.ref_counters(scope, n) values (p_scope, 1)
  on conflict (scope) do update set n = public.ref_counters.n + 1
  returning n into v;
  return v;
end $$;

-- ---------------------------------------------------------------------
-- Indications / requests (every calculation is one row)
-- ---------------------------------------------------------------------
create table if not exists public.indications (
  id                 bigserial primary key,
  ref                text unique,                    -- issued on PDF download or quotation request
  user_id            uuid not null references public.profiles(id) on delete cascade,
  company            text,
  created_at         timestamptz not null default now(),
  commodity_id       text references public.commodities(id),
  goods_description  text not null,
  packaging          text,
  conveyance         text not null check (conveyance in ('sea_container','sea_breakbulk','air','road','rail')),
  origin_country     text not null references public.countries(iso2),
  origin_place       text,
  dest_country       text not null references public.countries(iso2),
  dest_place         text,
  departure_date     date,
  invoice_value      numeric(14,2) not null check (invoice_value > 0),
  currency           text not null check (currency in ('EUR','USD')),
  uplift_pct         numeric(5,2) not null default 10 check (uplift_pct >= 0 and uplift_pct <= 30),
  sum_insured        numeric(14,2) not null,
  cover              text not null check (cover in ('icc_a','icc_b','icc_c')),
  war_strikes        boolean not null default true,
  status             text not null check (status in ('quoted','on_request','sanctioned')),
  rate_pct           numeric(8,4),
  premium_gross      numeric(14,2),
  discount_pct       numeric(5,2) not null default 0,
  premium            numeric(14,2),
  min_applied        boolean not null default false,
  reasons            text[] not null default '{}',
  conditions         text,
  -- customer actions
  pdf_downloaded_at  timestamptz,
  quote_requested_at timestamptz,
  customer_comment   text,
  hidden_by_user     boolean not null default false,
  -- internal handling
  stage              text not null default 'new' check (stage in ('new','in_progress','quoted','accepted','declined','bound','lost','closed')),
  owner              text,
  follow_up          date,
  is_test            boolean not null default false,
  updated_at         timestamptz not null default now()
);
create index if not exists indications_user_idx on public.indications(user_id, created_at desc);
create index if not exists indications_req_idx on public.indications(quote_requested_at desc) where quote_requested_at is not null;
drop trigger if exists indications_touch on public.indications;
create trigger indications_touch before update on public.indications for each row execute function public.touch_updated_at();

create table if not exists public.quotations (
  id            bigserial primary key,
  indication_id bigint not null references public.indications(id) on delete cascade,
  version       int not null default 1,
  data          jsonb not null,
  valid_until   timestamptz not null,
  status        text not null default 'open' check (status in ('open','accepted','declined','withdrawn','superseded')),
  response_note text,
  responded_at  timestamptz,
  seen_at       timestamptz,
  created_by    uuid references public.profiles(id) on delete set null,
  created_at    timestamptz not null default now(),
  unique (indication_id, version)
);

create table if not exists public.cover_notes (
  id            bigserial primary key,
  indication_id bigint not null references public.indications(id) on delete cascade,
  quotation_id  bigint references public.quotations(id) on delete set null,
  number        text not null unique,
  data          jsonb not null,
  issued_at     timestamptz not null default now(),
  created_by    uuid references public.profiles(id) on delete set null
);

create table if not exists public.invoices (
  id            bigserial primary key,
  indication_id bigint references public.indications(id) on delete set null,
  user_id       uuid not null references public.profiles(id) on delete cascade,
  number        text not null,
  amount        numeric(14,2) not null,
  currency      text not null check (currency in ('EUR','USD')),
  due_date      date,
  file_path     text,            -- path in storage bucket "invoices": <user_id>/<file>.pdf
  paid_at       timestamptz,
  created_at    timestamptz not null default now()
);

create table if not exists public.case_notes (
  id            bigserial primary key,
  indication_id bigint not null references public.indications(id) on delete cascade,
  author        text not null,
  body          text not null check (length(body) between 1 and 2000),
  created_at    timestamptz not null default now()
);

create table if not exists public.referrals (
  id          bigserial primary key,
  referrer_id uuid not null references public.profiles(id) on delete cascade,
  referred_id uuid not null unique references public.profiles(id) on delete cascade,
  status      text not null default 'pending' check (status in ('pending','approved','rejected')),
  decided_at  timestamptz,
  created_at  timestamptz not null default now()
);

create table if not exists public.feedback (
  id         bigserial primary key,
  user_id    uuid references public.profiles(id) on delete set null,
  message    text not null check (length(message) between 2 and 3000),
  page       text,
  done       boolean not null default false,
  created_at timestamptz not null default now()
);

-- Alerts: a Database Webhook on INSERT sends each row to the Edge Function "notify"
create table if not exists public.outbox (
  id           bigserial primary key,
  kind         text not null,
  payload      jsonb not null default '{}',
  created_at   timestamptz not null default now(),
  processed_at timestamptz,
  result       text
);

create or replace function public.emit(p_kind text, p_payload jsonb) returns void
language sql security definer set search_path = public as $$
  insert into public.outbox(kind, payload) values (p_kind, coalesce(p_payload, '{}'::jsonb))
$$;

-- ---------------------------------------------------------------------
-- New auth user → profile (+ referral)
-- ---------------------------------------------------------------------
create or replace function public.gen_referral_code() returns text
language plpgsql set search_path = public as $$
declare c text;
begin
  loop
    -- gen_random_uuid() is built into PostgreSQL 13+ (no extension/schema needed); digits 0 and 1 dropped to avoid O/I mix-ups
    c := upper(substr(translate(replace(gen_random_uuid()::text, '-', ''), '01', ''), 1, 8));
    exit when length(c) = 8 and not exists (select 1 from public.profiles where referral_code = c);
  end loop;
  return c;
end $$;

create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  m jsonb := coalesce(new.raw_user_meta_data, '{}'::jsonb);
  ref_owner uuid;
begin
  select id into ref_owner from public.profiles
   where referral_code = upper(nullif(trim(m->>'ref'), '')) limit 1;

  insert into public.profiles(id, email, full_name, company, country, phone, referral_code, referred_by)
  values (new.id, lower(new.email),
          left(nullif(trim(m->>'full_name'), ''), 100),
          left(nullif(trim(m->>'company'), ''), 150),
          left(nullif(trim(m->>'country'), ''), 80),
          left(nullif(trim(m->>'phone'), ''), 40),
          public.gen_referral_code(), ref_owner)
  on conflict (id) do nothing;

  if ref_owner is not null then
    insert into public.referrals(referrer_id, referred_id) values (ref_owner, new.id) on conflict do nothing;
  end if;

  perform public.emit('new_registration', jsonb_build_object(
    'email', lower(new.email), 'name', m->>'full_name', 'company', m->>'company', 'country', m->>'country',
    'referred', ref_owner is not null));
  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

-- approval / rejection → customer e-mail
create or replace function public.profiles_after_update() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.approved and not coalesce(old.approved, false) then
    new.approved_at := coalesce(new.approved_at, now());
    perform public.emit('account_approved', jsonb_build_object('user_id', new.id, 'email', new.email, 'name', new.full_name));
  end if;
  return new;
end $$;
drop trigger if exists profiles_approved on public.profiles;
create trigger profiles_approved before update of approved on public.profiles
  for each row execute function public.profiles_after_update();

-- non-admins must never change privileged columns, even if a policy allowed the update
create or replace function public.profiles_guard() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() and current_user not in ('postgres','service_role','supabase_admin') then
    if new.is_admin is distinct from old.is_admin or new.approved is distinct from old.approved
       or new.rejected is distinct from old.rejected or new.client_discount_pct is distinct from old.client_discount_pct
       or new.email is distinct from old.email or new.company is distinct from old.company
       or new.referral_code is distinct from old.referral_code then
      raise exception 'not allowed';
    end if;
  end if;
  return new;
end $$;
drop trigger if exists profiles_guard on public.profiles;
create trigger profiles_guard before update on public.profiles for each row execute function public.profiles_guard();

-- ---------------------------------------------------------------------
-- Row level security
-- ---------------------------------------------------------------------
alter table public.profiles     enable row level security;
alter table public.settings     enable row level security;
alter table public.regions      enable row level security;
alter table public.countries    enable row level security;
alter table public.commodities  enable row level security;
alter table public.insurers     enable row level security;
alter table public.ref_counters enable row level security;
alter table public.indications  enable row level security;
alter table public.quotations   enable row level security;
alter table public.cover_notes  enable row level security;
alter table public.invoices     enable row level security;
alter table public.case_notes   enable row level security;
alter table public.referrals    enable row level security;
alter table public.feedback     enable row level security;
alter table public.outbox       enable row level security;

do $$
declare t text;
begin
  -- admin full access on every table
  foreach t in array array['profiles','settings','regions','countries','commodities','insurers','indications',
                           'quotations','cover_notes','invoices','case_notes','referrals','feedback','outbox','ref_counters'] loop
    execute format('drop policy if exists admin_all on public.%I', t);
    execute format('create policy admin_all on public.%I for all to authenticated using (public.is_admin()) with check (public.is_admin())', t);
  end loop;
end $$;

drop policy if exists own_profile on public.profiles;
create policy own_profile on public.profiles for select to authenticated using (id = auth.uid());

-- country names are not confidential (needed for the form); rate tables are
drop policy if exists read_countries on public.countries;
create policy read_countries on public.countries for select to authenticated using (true);

drop policy if exists own_indications on public.indications;
create policy own_indications on public.indications for select to authenticated
  using (user_id = auth.uid() and public.is_approved());

drop policy if exists own_quotations on public.quotations;
create policy own_quotations on public.quotations for select to authenticated
  using (status <> 'superseded' and exists (select 1 from public.indications i where i.id = indication_id and i.user_id = auth.uid()));

drop policy if exists own_cover_notes on public.cover_notes;
create policy own_cover_notes on public.cover_notes for select to authenticated
  using (exists (select 1 from public.indications i where i.id = indication_id and i.user_id = auth.uid()));

drop policy if exists own_invoices on public.invoices;
create policy own_invoices on public.invoices for select to authenticated using (user_id = auth.uid());

-- ---------------------------------------------------------------------
-- Customer functions
-- ---------------------------------------------------------------------
create or replace function public.public_settings() returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'maintenance',     coalesce(public.setting('maintenance'), 'false'::jsonb),
    'terms_version',   public.setting('terms_version'),
    'uplift_pct',      public.setting('uplift_pct'),
    'deductible_text', public.setting('deductible_text'),
    'brand_name',      public.setting('brand_name'),
    'company_legal',   public.setting('company_legal'))
$$;

-- commodity list for the form, without rates
create or replace function public.list_commodities() returns table(id text, name text, description text, allowed_covers text[], conveyances text[], on_request boolean)
language sql stable security definer set search_path = public as $$
  select c.id, c.name, c.description, c.allowed_covers,
         array_remove(array[
           case when c.rate_sea_container is not null then 'sea_container' end,
           case when c.rate_sea_breakbulk is not null then 'sea_breakbulk' end,
           case when c.rate_air  is not null then 'air'  end,
           case when c.rate_road is not null then 'road' end,
           case when c.rate_rail is not null then 'rail' end], null),
         c.on_request
    from public.commodities c
   where c.active and public.is_approved()
   order by c.sort, c.name
$$;

create or replace function public.accept_terms(p_version text) returns boolean
language plpgsql security definer set search_path = public as $$
begin
  update public.profiles set terms_version = left(p_version, 20) where id = auth.uid();
  return found;
end $$;

create or replace function public.update_my_name(p_name text) returns boolean
language plpgsql security definer set search_path = public as $$
begin
  if length(trim(coalesce(p_name, ''))) < 2 then raise exception 'name too short'; end if;
  update public.profiles set full_name = left(trim(p_name), 100) where id = auth.uid();
  return found;
end $$;

create or replace function public.my_referral_code() returns text
language sql stable security definer set search_path = public as $$
  select referral_code from public.profiles where id = auth.uid() and approved
$$;

create or replace function public.request_account_deletion() returns boolean
language plpgsql security definer set search_path = public as $$
declare p public.profiles;
begin
  update public.profiles set deletion_requested_at = now() where id = auth.uid() returning * into p;
  if not found then return false; end if;
  perform public.emit('deletion_request', jsonb_build_object('user_id', p.id, 'email', p.email, 'name', p.full_name, 'company', p.company));
  return true;
end $$;

create or replace function public.submit_feedback(p_message text, p_page text) returns boolean
language plpgsql security definer set search_path = public as $$
declare p public.profiles;
begin
  select * into p from public.profiles where id = auth.uid();
  if not found then return false; end if;
  insert into public.feedback(user_id, message, page) values (auth.uid(), left(trim(p_message), 3000), left(p_page, 80));
  perform public.emit('feedback', jsonb_build_object('email', p.email, 'name', p.full_name, 'company', p.company, 'message', left(trim(p_message), 600)));
  return true;
end $$;

-- The indication calculation. Returns the stored row as JSON.
create or replace function public.calc_indication(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  prof        public.profiles;
  com         public.commodities;
  o_c         public.countries;
  d_c         public.countries;
  o_r         public.regions;
  d_r         public.regions;
  v_conv      text := p->>'conveyance';
  v_cover     text := coalesce(p->>'cover', 'icc_a');
  v_cur       text := upper(coalesce(p->>'currency', 'EUR'));
  v_inv       numeric := nullif(p->>'invoice_value', '')::numeric;
  v_uplift    numeric := coalesce(nullif(p->>'uplift_pct', '')::numeric, (public.setting('uplift_pct'))::text::numeric, 10);
  v_war       boolean := coalesce((p->>'war_strikes')::boolean, true);
  v_dep       date := nullif(p->>'departure_date', '')::date;
  v_si        numeric;
  v_base      numeric;
  v_factor    numeric;
  v_cf        numeric;
  v_rate      numeric;
  v_gross     numeric;
  v_disc      numeric;
  v_net       numeric;
  v_min       numeric;
  v_limit     numeric;
  v_min_hit   boolean := false;
  v_status    text := 'quoted';
  v_reasons   text[] := '{}';
  v_cond      text;
  v_id        bigint;
  r           public.indications;
begin
  select * into prof from public.profiles where id = auth.uid();
  if not found or not prof.approved or prof.rejected then raise exception 'not authorised'; end if;
  if coalesce((public.setting('maintenance'))::text::boolean, false) and not prof.is_admin then
    raise exception 'maintenance';
  end if;

  -- validation
  if v_conv not in ('sea_container','sea_breakbulk','air','road','rail') then raise exception 'invalid conveyance'; end if;
  if v_cover not in ('icc_a','icc_b','icc_c') then raise exception 'invalid cover'; end if;
  if v_cur not in ('EUR','USD') then raise exception 'invalid currency'; end if;
  if v_inv is null or v_inv <= 0 or v_inv > 1000000000 then raise exception 'invalid invoice value'; end if;
  if v_uplift < 0 or v_uplift > 30 then raise exception 'invalid uplift'; end if;
  if length(trim(coalesce(p->>'goods_description', ''))) < 2 then raise exception 'goods description required'; end if;

  select * into com from public.commodities where id = p->>'commodity_id' and active;
  if not found then raise exception 'invalid commodity'; end if;
  select * into o_c from public.countries where iso2 = upper(p->>'origin_country');
  if not found then raise exception 'invalid origin country'; end if;
  select * into d_c from public.countries where iso2 = upper(p->>'dest_country');
  if not found then raise exception 'invalid destination country'; end if;
  select * into o_r from public.regions where id = o_c.region_id;
  select * into d_r from public.regions where id = d_c.region_id;

  v_si := round(v_inv * (1 + v_uplift / 100), 2);
  v_cond := com.conditions;

  -- sanctions first: no price at all
  if o_c.sanctioned or d_c.sanctioned or o_r.sanctioned or d_r.sanctioned then
    v_status := 'sanctioned';
    v_reasons := array['Origin or destination is subject to sanctions — compliance review required'];
  else
    if com.on_request then v_reasons := array_append(v_reasons, 'This type of cargo is quoted individually'::text); end if;
    v_base := case v_conv
      when 'sea_container' then com.rate_sea_container
      when 'sea_breakbulk' then com.rate_sea_breakbulk
      when 'air'  then com.rate_air
      when 'road' then com.rate_road
      when 'rail' then com.rate_rail end;
    if v_base is null and not com.on_request then v_reasons := array_append(v_reasons, 'This cargo is quoted individually for the chosen conveyance'::text); end if;
    if not (v_cover = any(com.allowed_covers)) then v_reasons := array_append(v_reasons, 'The chosen cover is not available automatically for this cargo'::text); end if;
    if o_c.on_request or o_r.on_request then v_reasons := array_append(v_reasons, ('Shipments from ' || o_c.name || ' are quoted individually')::text); end if;
    if d_c.on_request or d_r.on_request then v_reasons := array_append(v_reasons, ('Shipments to ' || d_c.name || ' are quoted individually')::text); end if;
    v_limit := (public.setting('auto_limit')->>v_cur)::numeric;
    if v_limit is not null and v_si > v_limit then v_reasons := array_append(v_reasons, 'Sum insured above the automatic limit'::text); end if;
    if v_dep is not null and v_dep < current_date then v_reasons := array_append(v_reasons, 'Departure date lies in the past — cover cannot be backdated automatically'::text); end if;

    if array_length(v_reasons, 1) is not null then
      v_status := 'on_request';
    else
      v_factor := greatest(o_r.factor, d_r.factor);
      v_cf := coalesce((public.setting('cover_factors')->>v_cover)::numeric, 1);
      v_rate := v_base * v_factor * v_cf;
      -- war & strikes: full rate at sea / in the air; on land only strikes, riots & civil commotion (a quarter of the rate)
      if v_war then v_rate := v_rate + greatest(o_r.war_rate, d_r.war_rate) * case when v_conv in ('road','rail') then 0.25 else 1 end; end if;
      v_rate := round(v_rate, 4);
      v_gross := round(v_si * v_rate / 100, 2);
      v_disc := coalesce(prof.client_discount_pct, 0);
      v_net := round(v_gross * (1 - v_disc / 100), 2);
      v_min := (public.setting('min_premium')->>v_cur)::numeric;
      if v_min is not null and v_net < v_min then v_net := v_min; v_min_hit := true; end if;
    end if;
  end if;

  insert into public.indications(user_id, company, commodity_id, goods_description, packaging, conveyance,
      origin_country, origin_place, dest_country, dest_place, departure_date, invoice_value, currency,
      uplift_pct, sum_insured, cover, war_strikes, status, rate_pct, premium_gross, discount_pct, premium,
      min_applied, reasons, conditions)
  values (prof.id, prof.company, com.id, left(trim(p->>'goods_description'), 300), left(nullif(trim(p->>'packaging'), ''), 100), v_conv,
      o_c.iso2, left(nullif(trim(p->>'origin_place'), ''), 100), d_c.iso2, left(nullif(trim(p->>'dest_place'), ''), 100), v_dep, v_inv, v_cur,
      v_uplift, v_si, v_cover, v_war, v_status,
      case when v_status = 'quoted' then v_rate end,
      case when v_status = 'quoted' then v_gross end,
      case when v_status = 'quoted' then coalesce(v_disc, 0) else 0 end,
      case when v_status = 'quoted' then v_net end,
      v_min_hit, v_reasons, v_cond)
  returning * into r;

  return to_jsonb(r) || jsonb_build_object('origin_name', o_c.name, 'dest_name', d_c.name, 'commodity_name', com.name,
                                           'deductible_text', public.setting('deductible_text'));
end $$;

-- Reference for an indication (PDF download or request); issued once
create or replace function public.ensure_ref(p_id bigint) returns text
language plpgsql security definer set search_path = public as $$
declare v_ref text; v_month text := to_char(now() at time zone 'Europe/Berlin', 'YYMM');
begin
  select ref into v_ref from public.indications where id = p_id and user_id = auth.uid() for update;
  if not found then raise exception 'not found'; end if;
  if v_ref is null then
    v_ref := 'FRCN-' || v_month || '-' || lpad(public.next_counter('ind-' || v_month)::text, 4, '0');
    update public.indications set ref = v_ref where id = p_id;
  end if;
  return v_ref;
end $$;

create or replace function public.mark_pdf_downloaded(p_id bigint) returns text
language plpgsql security definer set search_path = public as $$
declare v_ref text;
begin
  v_ref := public.ensure_ref(p_id);
  update public.indications set pdf_downloaded_at = coalesce(pdf_downloaded_at, now()) where id = p_id;
  return v_ref;
end $$;

create or replace function public.request_quotation(p_id bigint, p_comment text) returns text
language plpgsql security definer set search_path = public as $$
declare v_ref text; r public.indications; p public.profiles;
begin
  select * into p from public.profiles where id = auth.uid();
  if coalesce((public.setting('maintenance'))::text::boolean, false) and not p.is_admin then raise exception 'maintenance'; end if;
  v_ref := public.ensure_ref(p_id);
  update public.indications
     set quote_requested_at = coalesce(quote_requested_at, now()),
         customer_comment   = coalesce(customer_comment, left(nullif(trim(p_comment), ''), 1000)),
         hidden_by_user     = false
   where id = p_id and user_id = auth.uid()
   returning * into r;
  if r.quote_requested_at >= now() - interval '5 seconds' then
    perform public.emit('quote_request', jsonb_build_object('indication_id', r.id, 'ref', r.ref, 'email', p.email,
      'name', p.full_name, 'company', p.company, 'goods', r.goods_description, 'conveyance', r.conveyance,
      'origin', r.origin_country, 'origin_place', r.origin_place, 'dest', r.dest_country, 'dest_place', r.dest_place,
      'sum_insured', r.sum_insured, 'currency', r.currency, 'status', r.status, 'premium', r.premium, 'comment', r.customer_comment));
  end if;
  return v_ref;
end $$;

create or replace function public.hide_my_indication(p_id bigint) returns boolean
language plpgsql security definer set search_path = public as $$
begin
  update public.indications set hidden_by_user = true where id = p_id and user_id = auth.uid();
  return found;
end $$;

-- All my quotations with their request (latest version only)
create or replace function public.my_quotations() returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(x order by x->>'created_at' desc), '[]'::jsonb) from (
    select jsonb_build_object(
      'id', q.id, 'indication_id', i.id, 'ref', i.ref, 'version', q.version, 'data', q.data,
      'valid_until', q.valid_until,
      'status', case when q.status = 'open' and q.valid_until < now() then 'expired' else q.status end,
      'response_note', q.response_note, 'responded_at', q.responded_at, 'created_at', q.created_at, 'seen_at', q.seen_at,
      'cover_note', (select jsonb_build_object('id', c.id, 'number', c.number, 'issued_at', c.issued_at, 'data', c.data)
                       from public.cover_notes c where c.indication_id = i.id order by c.issued_at desc limit 1)) x
      from public.quotations q join public.indications i on i.id = q.indication_id
     where i.user_id = auth.uid() and q.status <> 'superseded'
  ) s
$$;

create or replace function public.mark_quotations_seen() returns void
language sql security definer set search_path = public as $$
  update public.quotations q set seen_at = now()
    from public.indications i
   where i.id = q.indication_id and i.user_id = auth.uid() and q.seen_at is null
$$;

-- My open requests that have no quotation yet (shown in "My quotations" as waiting)
create or replace function public.my_pending_requests() returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(to_jsonb(i) order by i.quote_requested_at desc), '[]'::jsonb)
    from public.indications i
   where i.user_id = auth.uid() and i.quote_requested_at is not null and not i.hidden_by_user
     and i.stage not in ('lost','closed')
     and not exists (select 1 from public.quotations q where q.indication_id = i.id and q.status <> 'superseded')
$$;

create or replace function public.respond_to_quotation(p_quotation_id bigint, p_accept boolean, p_note text) returns text
language plpgsql security definer set search_path = public as $$
declare q public.quotations; i public.indications; p public.profiles;
begin
  select q2.* into q from public.quotations q2 join public.indications i2 on i2.id = q2.indication_id
   where q2.id = p_quotation_id and i2.user_id = auth.uid() for update of q2;
  if not found then raise exception 'not found'; end if;
  if q.status <> 'open' then raise exception 'quotation is no longer open'; end if;
  if q.valid_until < now() then raise exception 'quotation has expired'; end if;
  update public.quotations set status = case when p_accept then 'accepted' else 'declined' end,
         response_note = left(nullif(trim(p_note), ''), 1000), responded_at = now()
   where id = q.id;
  update public.indications set stage = case when p_accept then 'accepted' else 'declined' end
   where id = q.indication_id returning * into i;
  select * into p from public.profiles where id = auth.uid();
  perform public.emit('quotation_response', jsonb_build_object('quotation_id', q.id, 'indication_id', i.id, 'ref', i.ref,
    'accepted', p_accept, 'note', p_note, 'email', p.email, 'name', p.full_name, 'company', p.company,
    'total', q.data->'total', 'currency', q.data->>'currency'));
  return case when p_accept then 'accepted' else 'declined' end;
end $$;

-- My history (calculations), newest first
create or replace function public.my_history(p_limit int default 200) returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(to_jsonb(s) order by s.created_at desc), '[]'::jsonb) from (
    select i.id, i.ref, i.created_at, i.goods_description, i.commodity_id, i.conveyance, i.origin_country, i.origin_place,
           i.dest_country, i.dest_place, i.departure_date, i.invoice_value, i.currency, i.uplift_pct, i.sum_insured, i.cover,
           i.war_strikes, i.status, i.rate_pct, i.premium_gross, i.discount_pct, i.premium, i.min_applied, i.reasons, i.conditions,
           i.packaging, i.pdf_downloaded_at, i.quote_requested_at, i.customer_comment
      from public.indications i
     where i.user_id = auth.uid() and not i.hidden_by_user
     order by i.created_at desc limit least(greatest(p_limit, 1), 500)
  ) s
$$;

create or replace function public.my_referrals() returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'code', (select referral_code from public.profiles where id = auth.uid()),
    'discount_pct', (select client_discount_pct from public.profiles where id = auth.uid()),
    'reward_pct', public.setting('referral_discount_pct'),
    'count', (select count(*) from public.referrals where referrer_id = auth.uid()),
    'approved', (select count(*) from public.referrals where referrer_id = auth.uid() and status = 'approved'))
$$;

create or replace function public.export_my_data() returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'exported_at', now(),
    'profile', (select jsonb_build_object('name', full_name, 'company', company, 'email', email, 'country', country,
                       'phone', phone, 'registered_at', created_at) from public.profiles where id = auth.uid()),
    'indications', public.my_history(500),
    'quotations', public.my_quotations(),
    'invoices', (select coalesce(jsonb_agg(jsonb_build_object('number', number, 'amount', amount, 'currency', currency,
                        'due_date', due_date, 'paid_at', paid_at, 'created_at', created_at)), '[]'::jsonb)
                   from public.invoices where user_id = auth.uid()))
$$;

-- ---------------------------------------------------------------------
-- Admin functions
-- ---------------------------------------------------------------------
create or replace function public.admin_save_quotation(p_indication_id bigint, p_data jsonb, p_valid_until timestamptz) returns bigint
language plpgsql security definer set search_path = public as $$
declare v_ver int; v_id bigint; i public.indications; p public.profiles;
begin
  if not public.is_admin() then raise exception 'not authorised'; end if;
  if p_valid_until <= now() then raise exception 'validity must be in the future'; end if;
  select * into i from public.indications where id = p_indication_id for update;
  if not found then raise exception 'not found'; end if;
  if i.ref is null then
    i.ref := 'FRCN-' || to_char(now() at time zone 'Europe/Berlin', 'YYMM') || '-' ||
             lpad(public.next_counter('ind-' || to_char(now() at time zone 'Europe/Berlin', 'YYMM'))::text, 4, '0');
    update public.indications set ref = i.ref where id = i.id;
  end if;
  update public.quotations set status = 'superseded' where indication_id = i.id and status = 'open';
  select coalesce(max(version), 0) + 1 into v_ver from public.quotations where indication_id = i.id;
  insert into public.quotations(indication_id, version, data, valid_until, created_by)
  values (i.id, v_ver, p_data, p_valid_until, auth.uid()) returning id into v_id;
  update public.indications set stage = 'quoted' where id = i.id;
  select * into p from public.profiles where id = i.user_id;
  perform public.emit('quotation_sent', jsonb_build_object('quotation_id', v_id, 'indication_id', i.id, 'ref', i.ref,
    'version', v_ver, 'email', p.email, 'name', p.full_name, 'company', p.company,
    'total', p_data->'total', 'currency', p_data->>'currency', 'valid_until', p_valid_until));
  return v_id;
end $$;

create or replace function public.admin_withdraw_quotation(p_quotation_id bigint) returns boolean
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'not authorised'; end if;
  update public.quotations set status = 'withdrawn' where id = p_quotation_id and status = 'open';
  return found;
end $$;

create or replace function public.admin_issue_cover_note(p_indication_id bigint, p_quotation_id bigint, p_data jsonb) returns text
language plpgsql security definer set search_path = public as $$
declare v_no text; i public.indications; p public.profiles; v_year text := to_char(now() at time zone 'Europe/Berlin', 'YYYY');
begin
  if not public.is_admin() then raise exception 'not authorised'; end if;
  select * into i from public.indications where id = p_indication_id;
  if not found then raise exception 'not found'; end if;
  v_no := 'FRCN-CN-' || v_year || '-' || lpad(public.next_counter('cn-' || v_year)::text, 4, '0');
  insert into public.cover_notes(indication_id, quotation_id, number, data, created_by)
  values (i.id, p_quotation_id, v_no, p_data || jsonb_build_object('number', v_no), auth.uid());
  update public.indications set stage = 'bound' where id = i.id;
  select * into p from public.profiles where id = i.user_id;
  perform public.emit('cover_note_issued', jsonb_build_object('indication_id', i.id, 'ref', i.ref, 'number', v_no,
    'email', p.email, 'name', p.full_name, 'company', p.company));
  return v_no;
end $$;

create or replace function public.admin_decide_referral(p_id bigint, p_approve boolean) returns boolean
language plpgsql security definer set search_path = public as $$
declare r public.referrals; v_pct numeric := coalesce((public.setting('referral_discount_pct'))::text::numeric, 5);
begin
  if not public.is_admin() then raise exception 'not authorised'; end if;
  update public.referrals set status = case when p_approve then 'approved' else 'rejected' end, decided_at = now()
   where id = p_id and status = 'pending' returning * into r;
  if not found then return false; end if;
  if p_approve then
    update public.profiles set client_discount_pct = greatest(client_discount_pct, v_pct) where id = r.referrer_id;
  end if;
  return true;
end $$;

create or replace function public.admin_overview(p_days int default 30) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare since timestamptz := now() - make_interval(days => greatest(p_days, 1));
begin
  if not public.is_admin() then raise exception 'not authorised'; end if;
  return jsonb_build_object(
    'indications', (select count(*) from public.indications where created_at >= since and not is_test),
    'requests',    (select count(*) from public.indications where quote_requested_at >= since and not is_test),
    'quoted',      (select count(*) from public.quotations where created_at >= since),
    'accepted',    (select count(*) from public.quotations where responded_at >= since and status = 'accepted'),
    'bound',       (select count(*) from public.cover_notes where issued_at >= since),
    'open_requests',(select count(*) from public.indications i where quote_requested_at is not null and stage in ('new','in_progress')
                       and not exists (select 1 from public.quotations q where q.indication_id = i.id and q.status <> 'superseded')),
    'pending_users',(select count(*) from public.profiles where not approved and not rejected),
    'open_feedback',(select count(*) from public.feedback where not done),
    'pending_referrals',(select count(*) from public.referrals where status = 'pending'),
    'premium_bound', (select coalesce(jsonb_object_agg(cur, total), '{}'::jsonb) from (
        select q.data->>'currency' cur, sum((q.data->>'total')::numeric) total
          from public.cover_notes c join public.quotations q on q.id = c.quotation_id
         where c.issued_at >= since group by 1) s),
    'by_day', (select coalesce(jsonb_agg(jsonb_build_object('d', d, 'n', n, 'r', r) order by d), '[]'::jsonb) from (
        select date_trunc('day', created_at)::date d, count(*) n, count(quote_requested_at) r
          from public.indications where created_at >= since and not is_test group by 1) s),
    'top_routes', (select coalesce(jsonb_agg(jsonb_build_object('route', route, 'n', n)), '[]'::jsonb) from (
        select origin_country || ' → ' || dest_country route, count(*) n from public.indications
         where created_at >= since and not is_test group by 1 order by 2 desc limit 6) s));
end $$;

grant execute on all functions in schema public to authenticated;
revoke execute on function public.emit(text, jsonb) from authenticated, anon;
revoke execute on function public.next_counter(text) from authenticated, anon;
revoke execute on function public.handle_new_user() from authenticated, anon;

-- ---------------------------------------------------------------------
-- Storage bucket for invoice PDFs (private). Files: invoices/<user_id>/<name>.pdf
-- ---------------------------------------------------------------------
do $$
begin
  if exists (select 1 from information_schema.schemata where schema_name = 'storage') then
    insert into storage.buckets(id, name, public) values ('invoices', 'invoices', false) on conflict (id) do nothing;
    execute 'drop policy if exists "invoices admin" on storage.objects';
    execute $p$create policy "invoices admin" on storage.objects for all to authenticated
             using (bucket_id = 'invoices' and public.is_admin()) with check (bucket_id = 'invoices' and public.is_admin())$p$;
    execute 'drop policy if exists "invoices own" on storage.objects';
    execute $p$create policy "invoices own" on storage.objects for select to authenticated
             using (bucket_id = 'invoices' and (storage.foldername(name))[1] = auth.uid()::text)$p$;
  end if;
end $$;


-- ===================== included update 2026-10-20b =====================
-- =====================================================================
-- FREIGHTCON update 2026-10-20b: vessel, Incoterms, company address
-- Run once in Supabase → SQL Editor on an EXISTING database. Safe to re-run.
-- (Already included at the end of schema.sql for new installations.)
-- =====================================================================

alter table public.profiles    add column if not exists first_name   text;
alter table public.profiles    add column if not exists last_name    text;
alter table public.profiles    add column if not exists address_line text;
alter table public.profiles    add column if not exists postcode     text;
alter table public.profiles    add column if not exists city         text;

alter table public.indications add column if not exists vessel        text;
alter table public.indications add column if not exists incoterm      text;
alter table public.indications add column if not exists insured_party text;
do $$ begin
  alter table public.indications add constraint indications_incoterm_chk
    check (incoterm is null or incoterm in ('EXW','FCA','FAS','FOB','CFR','CIF','CPT','CIP','DAP','DPU','DDP'));
exception when duplicate_object then null; end $$;
do $$ begin
  alter table public.indications add constraint indications_party_chk check (insured_party is null or insured_party in ('seller','buyer'));
exception when duplicate_object then null; end $$;

-- customers may correct their own address (company name and e-mail stay fixed)
create or replace function public.update_my_address(p_address text, p_postcode text, p_city text, p_country text, p_phone text) returns boolean
language plpgsql security definer set search_path = public as $$
begin
  update public.profiles
     set address_line = left(nullif(trim(p_address), ''), 150), postcode = left(nullif(trim(p_postcode), ''), 20),
         city = left(nullif(trim(p_city), ''), 80), country = left(nullif(trim(p_country), ''), 80), phone = left(nullif(trim(p_phone), ''), 40)
   where id = auth.uid();
  return found;
end $$;

create or replace function public.update_my_name(p_name text) returns boolean
language plpgsql security definer set search_path = public as $$
begin
  if length(trim(coalesce(p_name, ''))) < 2 then raise exception 'name too short'; end if;
  update public.profiles set full_name = left(trim(p_name), 100),
         first_name = left(split_part(trim(p_name), ' ', 1), 60),
         last_name = left(nullif(trim(substr(trim(p_name), length(split_part(trim(p_name), ' ', 1)) + 1)), ''), 60)
   where id = auth.uid();
  return found;
end $$;

create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  m jsonb := coalesce(new.raw_user_meta_data, '{}'::jsonb);
  ref_owner uuid;
begin
  select id into ref_owner from public.profiles
   where referral_code = upper(nullif(trim(m->>'ref'), '')) limit 1;

  insert into public.profiles(id, email, full_name, first_name, last_name, company, address_line, postcode, city, country, phone, referral_code, referred_by)
  values (new.id, lower(new.email),
          left(coalesce(nullif(trim(m->>'full_name'), ''), nullif(trim(concat_ws(' ', nullif(trim(m->>'first_name'), ''), nullif(trim(m->>'last_name'), ''))), '')), 100),
          left(nullif(trim(m->>'first_name'), ''), 60),
          left(nullif(trim(m->>'last_name'), ''), 60),
          left(nullif(trim(m->>'company'), ''), 150),
          left(nullif(trim(m->>'address_line'), ''), 150),
          left(nullif(trim(m->>'postcode'), ''), 20),
          left(nullif(trim(m->>'city'), ''), 80),
          left(nullif(trim(m->>'country'), ''), 80),
          left(nullif(trim(m->>'phone'), ''), 40),
          public.gen_referral_code(), ref_owner)
  on conflict (id) do nothing;

  if ref_owner is not null then
    insert into public.referrals(referrer_id, referred_id) values (ref_owner, new.id) on conflict do nothing;
  end if;

  perform public.emit('new_registration', jsonb_build_object(
    'email', lower(new.email), 'name', coalesce(nullif(m->>'full_name', ''), concat_ws(' ', m->>'first_name', m->>'last_name')), 'company', m->>'company', 'country', m->>'country',
    'address', concat_ws(', ', nullif(m->>'address_line', ''), nullif(concat_ws(' ', m->>'postcode', m->>'city'), ''), nullif(m->>'country', '')),
    'referred', ref_owner is not null));
  return new;
end $$;

create or replace function public.calc_indication(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  prof        public.profiles;
  com         public.commodities;
  o_c         public.countries;
  d_c         public.countries;
  o_r         public.regions;
  d_r         public.regions;
  v_conv      text := p->>'conveyance';
  v_cover     text := coalesce(p->>'cover', 'icc_a');
  v_cur       text := upper(coalesce(p->>'currency', 'EUR'));
  v_inv       numeric := nullif(p->>'invoice_value', '')::numeric;
  v_uplift    numeric := coalesce(nullif(p->>'uplift_pct', '')::numeric, (public.setting('uplift_pct'))::text::numeric, 10);
  v_war       boolean := coalesce((p->>'war_strikes')::boolean, true);
  v_dep       date := nullif(p->>'departure_date', '')::date;
  v_incoterm  text := nullif(upper(trim(coalesce(p->>'incoterm', ''))), '');
  v_party     text := nullif(lower(trim(coalesce(p->>'insured_party', ''))), '');
  v_vessel    text := nullif(trim(coalesce(p->>'vessel', '')), '');
  v_si        numeric;
  v_base      numeric;
  v_factor    numeric;
  v_cf        numeric;
  v_rate      numeric;
  v_gross     numeric;
  v_disc      numeric;
  v_net       numeric;
  v_min       numeric;
  v_limit     numeric;
  v_min_hit   boolean := false;
  v_status    text := 'quoted';
  v_reasons   text[] := '{}';
  v_cond      text;
  v_id        bigint;
  r           public.indications;
begin
  select * into prof from public.profiles where id = auth.uid();
  if not found or not prof.approved or prof.rejected then raise exception 'not authorised'; end if;
  if coalesce((public.setting('maintenance'))::text::boolean, false) and not prof.is_admin then
    raise exception 'maintenance';
  end if;

  -- validation
  if v_conv not in ('sea_container','sea_breakbulk','air','road','rail') then raise exception 'invalid conveyance'; end if;
  if v_cover not in ('icc_a','icc_b','icc_c') then raise exception 'invalid cover'; end if;
  if v_cur not in ('EUR','USD') then raise exception 'invalid currency'; end if;
  if v_inv is null or v_inv <= 0 or v_inv > 1000000000 then raise exception 'invalid invoice value'; end if;
  if v_uplift < 0 or v_uplift > 30 then raise exception 'invalid uplift'; end if;
  if length(trim(coalesce(p->>'goods_description', ''))) < 2 then raise exception 'goods description required'; end if;
  if v_incoterm is not null and v_incoterm not in ('EXW','FCA','FAS','FOB','CFR','CIF','CPT','CIP','DAP','DPU','DDP') then raise exception 'invalid incoterm'; end if;
  if v_party is not null and v_party not in ('seller','buyer') then raise exception 'invalid party'; end if;
  if v_conv not in ('sea_container','sea_breakbulk') then v_vessel := null; end if;

  select * into com from public.commodities where id = p->>'commodity_id' and active;
  if not found then raise exception 'invalid commodity'; end if;
  select * into o_c from public.countries where iso2 = upper(p->>'origin_country');
  if not found then raise exception 'invalid origin country'; end if;
  select * into d_c from public.countries where iso2 = upper(p->>'dest_country');
  if not found then raise exception 'invalid destination country'; end if;
  select * into o_r from public.regions where id = o_c.region_id;
  select * into d_r from public.regions where id = d_c.region_id;

  v_si := round(v_inv * (1 + v_uplift / 100), 2);
  v_cond := com.conditions;

  -- sanctions first: no price at all
  if o_c.sanctioned or d_c.sanctioned or o_r.sanctioned or d_r.sanctioned then
    v_status := 'sanctioned';
    v_reasons := array['Origin or destination is subject to sanctions — compliance review required'];
  else
    if com.on_request then v_reasons := array_append(v_reasons, 'This type of cargo is quoted individually'::text); end if;
    v_base := case v_conv
      when 'sea_container' then com.rate_sea_container
      when 'sea_breakbulk' then com.rate_sea_breakbulk
      when 'air'  then com.rate_air
      when 'road' then com.rate_road
      when 'rail' then com.rate_rail end;
    if v_base is null and not com.on_request then v_reasons := array_append(v_reasons, 'This cargo is quoted individually for the chosen conveyance'::text); end if;
    if not (v_cover = any(com.allowed_covers)) then v_reasons := array_append(v_reasons, 'The chosen cover is not available automatically for this cargo'::text); end if;
    if o_c.on_request or o_r.on_request then v_reasons := array_append(v_reasons, ('Shipments from ' || o_c.name || ' are quoted individually')::text); end if;
    if d_c.on_request or d_r.on_request then v_reasons := array_append(v_reasons, ('Shipments to ' || d_c.name || ' are quoted individually')::text); end if;
    v_limit := (public.setting('auto_limit')->>v_cur)::numeric;
    if v_limit is not null and v_si > v_limit then v_reasons := array_append(v_reasons, 'Sum insured above the automatic limit'::text); end if;
    if v_dep is not null and v_dep < current_date then v_reasons := array_append(v_reasons, 'Departure date lies in the past — cover cannot be backdated automatically'::text); end if;

    if array_length(v_reasons, 1) is not null then
      v_status := 'on_request';
    else
      v_factor := greatest(o_r.factor, d_r.factor);
      v_cf := coalesce((public.setting('cover_factors')->>v_cover)::numeric, 1);
      v_rate := v_base * v_factor * v_cf;
      -- war & strikes: full rate at sea / in the air; on land only strikes, riots & civil commotion (a quarter of the rate)
      if v_war then v_rate := v_rate + greatest(o_r.war_rate, d_r.war_rate) * case when v_conv in ('road','rail') then 0.25 else 1 end; end if;
      v_rate := round(v_rate, 4);
      v_gross := round(v_si * v_rate / 100, 2);
      v_disc := coalesce(prof.client_discount_pct, 0);
      v_net := round(v_gross * (1 - v_disc / 100), 2);
      v_min := (public.setting('min_premium')->>v_cur)::numeric;
      if v_min is not null and v_net < v_min then v_net := v_min; v_min_hit := true; end if;
    end if;
  end if;

  insert into public.indications(user_id, company, commodity_id, goods_description, packaging, conveyance,
      origin_country, origin_place, dest_country, dest_place, departure_date, invoice_value, currency,
      uplift_pct, sum_insured, cover, war_strikes, status, rate_pct, premium_gross, discount_pct, premium,
      min_applied, reasons, conditions, vessel, incoterm, insured_party)
  values (prof.id, prof.company, com.id, left(trim(p->>'goods_description'), 300), left(nullif(trim(p->>'packaging'), ''), 100), v_conv,
      o_c.iso2, left(nullif(trim(p->>'origin_place'), ''), 100), d_c.iso2, left(nullif(trim(p->>'dest_place'), ''), 100), v_dep, v_inv, v_cur,
      v_uplift, v_si, v_cover, v_war, v_status,
      case when v_status = 'quoted' then v_rate end,
      case when v_status = 'quoted' then v_gross end,
      case when v_status = 'quoted' then coalesce(v_disc, 0) else 0 end,
      case when v_status = 'quoted' then v_net end,
      v_min_hit, v_reasons, v_cond, left(v_vessel, 100), v_incoterm, v_party)
  returning * into r;

  return to_jsonb(r) || jsonb_build_object('origin_name', o_c.name, 'dest_name', d_c.name, 'commodity_name', com.name,
                                           'deductible_text', public.setting('deductible_text'));
end $$;

create or replace function public.request_quotation(p_id bigint, p_comment text) returns text
language plpgsql security definer set search_path = public as $$
declare v_ref text; r public.indications; p public.profiles;
begin
  select * into p from public.profiles where id = auth.uid();
  if coalesce((public.setting('maintenance'))::text::boolean, false) and not p.is_admin then raise exception 'maintenance'; end if;
  v_ref := public.ensure_ref(p_id);
  update public.indications
     set quote_requested_at = coalesce(quote_requested_at, now()),
         customer_comment   = coalesce(customer_comment, left(nullif(trim(p_comment), ''), 1000)),
         hidden_by_user     = false
   where id = p_id and user_id = auth.uid()
   returning * into r;
  if r.quote_requested_at >= now() - interval '5 seconds' then
    perform public.emit('quote_request', jsonb_build_object('indication_id', r.id, 'ref', r.ref, 'email', p.email,
      'name', p.full_name, 'company', p.company, 'goods', r.goods_description, 'conveyance', r.conveyance,
      'origin', r.origin_country, 'origin_place', r.origin_place, 'dest', r.dest_country, 'dest_place', r.dest_place,
      'vessel', r.vessel, 'incoterm', r.incoterm, 'insured_party', r.insured_party, 'sum_insured', r.sum_insured, 'currency', r.currency, 'status', r.status, 'premium', r.premium, 'comment', r.customer_comment));
  end if;
  return v_ref;
end $$;

create or replace function public.my_history(p_limit int default 200) returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(to_jsonb(s) order by s.created_at desc), '[]'::jsonb) from (
    select i.id, i.ref, i.created_at, i.goods_description, i.commodity_id, i.conveyance, i.origin_country, i.origin_place,
           i.dest_country, i.dest_place, i.departure_date, i.invoice_value, i.currency, i.uplift_pct, i.sum_insured, i.cover,
           i.war_strikes, i.status, i.rate_pct, i.premium_gross, i.discount_pct, i.premium, i.min_applied, i.reasons, i.conditions,
           i.packaging, i.vessel, i.incoterm, i.insured_party, i.pdf_downloaded_at, i.quote_requested_at, i.customer_comment
      from public.indications i
     where i.user_id = auth.uid() and not i.hidden_by_user
     order by i.created_at desc limit least(greatest(p_limit, 1), 500)
  ) s
$$;

grant execute on function public.update_my_address(text, text, text, text, text) to authenticated;
grant execute on function public.calc_indication(jsonb) to authenticated;
grant execute on function public.my_history(int) to authenticated;
