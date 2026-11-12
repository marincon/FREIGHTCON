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
