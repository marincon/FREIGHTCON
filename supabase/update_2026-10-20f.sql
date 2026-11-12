-- =====================================================================
-- FREIGHTCON update 2026-10-20f
-- * Insurers: default brokerage % (internal)
-- * quotation_internal: insurer + brokerage per quotation (admins only,
--   customers can never read it)
-- * Setting insurance_tax_pct (default 19 %)
-- * admin_save_quotation gets a 4th parameter p_internal
-- Run once in the Supabase SQL Editor after update e.
-- =====================================================================

alter table public.insurers add column if not exists brokerage_pct numeric(5,2) not null default 0
  check (brokerage_pct >= 0 and brokerage_pct <= 50);

create table if not exists public.quotation_internal (
  quotation_id     bigint primary key references public.quotations(id) on delete cascade,
  insurer_id       bigint references public.insurers(id) on delete set null,
  insurer_name     text,
  brokerage_pct    numeric(5,2) not null default 0 check (brokerage_pct >= 0 and brokerage_pct <= 50),
  brokerage_amount numeric(14,2) not null default 0,
  net_to_insurer   numeric(14,2),
  currency         text,
  created_at       timestamptz not null default now()
);
alter table public.quotation_internal enable row level security;
drop policy if exists admin_all on public.quotation_internal;
create policy admin_all on public.quotation_internal for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

insert into public.settings(key, value, note) values
  ('insurance_tax_pct', '19', 'Insurance tax % used when "Add insurance tax" is ticked on a quotation')
on conflict (key) do nothing;

drop function if exists public.admin_save_quotation(bigint, jsonb, timestamptz);
create or replace function public.admin_save_quotation(p_indication_id bigint, p_data jsonb, p_valid_until timestamptz, p_internal jsonb default null) returns bigint
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
  if p_internal is not null then
    insert into public.quotation_internal(quotation_id, insurer_id, insurer_name, brokerage_pct, brokerage_amount, net_to_insurer, currency)
    values (v_id, nullif(p_internal->>'insurer_id', '')::bigint, p_internal->>'insurer_name',
            coalesce((p_internal->>'brokerage_pct')::numeric, 0), coalesce((p_internal->>'brokerage_amount')::numeric, 0),
            (p_internal->>'net_to_insurer')::numeric, p_data->>'currency');
  end if;
  update public.indications set stage = 'quoted' where id = i.id;
  select * into p from public.profiles where id = i.user_id;
  perform public.emit('quotation_sent', jsonb_build_object('quotation_id', v_id, 'indication_id', i.id, 'ref', i.ref,
    'version', v_ver, 'email', p.email, 'name', p.full_name, 'company', p.company,
    'total', p_data->'total', 'currency', p_data->>'currency', 'valid_until', p_valid_until));
  return v_id;
end $$;
grant execute on function public.admin_save_quotation(bigint, jsonb, timestamptz, jsonb) to authenticated;

notify pgrst, 'reload schema';
