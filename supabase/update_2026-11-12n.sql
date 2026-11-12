-- =====================================================================
-- FREIGHTCON update 2026-11-12n — open covers (stage 3): wording & ledger
-- * clause library in seven uniform categories (header, general conditions,
--   sanctions, pricing note, disclaimer, special conditions, subjectivities)
-- * per policy: a tick box for every clause = included by default in the
--   quotation (vessel / maritime clauses are left out for road & rail)
-- * spot clients: same library, nothing ticked by default
-- * quotation_internal: commission / rebate passed to the client, so the
--   ledger shows gross premium, underwriter commission, client rebate and
--   the net retained brokerage
-- The clause texts below are working drafts: replace them with the exact
-- wording of your policies (Internal → Clauses).
-- Run after update_2026-11-12m.sql. Safe to run more than once.
-- =====================================================================

create table if not exists public.clause_library (
  id           bigserial primary key,
  category     text not null check (category in ('header','general','sanctions','pricing','disclaimer','special','subjectivity')),
  title        text not null check (length(trim(title)) between 1 and 200),
  body         text not null default '',          -- plain text; {policy_no}, {assured}, {ref}, {currency} are filled in
  maritime     boolean not null default false,   -- vessel / sea clause: left out for road and rail
  default_spot boolean not null default false,   -- ticked by default for spot quotations
  active       boolean not null default true,
  sort         int not null default 100,
  updated_at   timestamptz not null default now()
);
create unique index if not exists clause_library_title_uq on public.clause_library(category, title);
create table if not exists public.policy_clauses (
  policy_id bigint not null references public.policies(id) on delete cascade,
  clause_id bigint not null references public.clause_library(id) on delete cascade,
  enabled   boolean not null default true,
  primary key (policy_id, clause_id)
);
alter table public.clause_library enable row level security;
alter table public.policy_clauses enable row level security;
drop policy if exists admin_all on public.clause_library;
create policy admin_all on public.clause_library for all to authenticated using (public.is_admin()) with check (public.is_admin());
drop policy if exists admin_all on public.policy_clauses;
create policy admin_all on public.policy_clauses for all to authenticated using (public.is_admin()) with check (public.is_admin());

alter table public.quotation_internal add column if not exists client_rebate_pct    numeric(5,2) not null default 0 check (client_rebate_pct >= 0 and client_rebate_pct <= 50);
alter table public.quotation_internal add column if not exists client_rebate_amount numeric(14,2) not null default 0;

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
    insert into public.quotation_internal(quotation_id, insurer_id, insurer_name, brokerage_pct, brokerage_amount, net_to_insurer, currency, client_rebate_pct, client_rebate_amount)
    values (v_id, nullif(p_internal->>'insurer_id', '')::bigint, p_internal->>'insurer_name',
            coalesce((p_internal->>'brokerage_pct')::numeric, 0), coalesce((p_internal->>'brokerage_amount')::numeric, 0),
            (p_internal->>'net_to_insurer')::numeric, p_data->>'currency',
            coalesce((p_internal->>'client_rebate_pct')::numeric, 0), coalesce((p_internal->>'client_rebate_amount')::numeric, 0));
  end if;
  update public.indications set stage = 'quoted' where id = i.id;
  select * into p from public.profiles where id = i.user_id;
  perform public.emit('quotation_sent', jsonb_build_object('quotation_id', v_id, 'indication_id', i.id, 'ref', i.ref,
    'version', v_ver, 'email', p.email, 'name', p.full_name, 'company', p.company,
    'total', p_data->'total', 'currency', p_data->>'currency', 'valid_until', p_valid_until));
  return v_id;
end $$;
grant execute on function public.admin_save_quotation(bigint, jsonb, timestamptz, jsonb) to authenticated;

-- ---------- library (drafts — adjust to your policy wording) ----------
insert into public.clause_library(category, title, body, maritime, default_spot, sort) values
  ('header', 'Opening (open cover)', 'Further to your declaration we are pleased to confirm the following terms under Open Policy {policy_no}. Reference {ref}.', false, false, 10),
  ('header', 'Opening (single shipment)', 'Further to your request we are pleased to quote as follows for the shipment described above. Reference {ref}.', false, true, 20),
  ('general', 'Institute Cargo Clauses 1/1/09', 'Institute Cargo Clauses (A), (B) or (C) 1/1/09 as stated in the cover, CL382.', false, true, 10),
  ('general', 'Institute War Clauses (Cargo) 1/1/09', 'Institute War Clauses (Cargo) 1/1/09, CL385 — sea transit (Institute War Clauses (Air Cargo) CL388 for air).', false, true, 20),
  ('general', 'Institute Strikes Clauses (Cargo) 1/1/09', 'Institute Strikes Clauses (Cargo) 1/1/09, CL386.', false, true, 30),
  ('general', 'Institute Classification Clause', 'Institute Classification Clause 1/1/01, CL354 — vessels over the age limits or not classed by an IACS society subject to additional premium.', true, true, 40),
  ('general', 'Cargo ISM Endorsement', 'Cargo ISM Endorsement JC98/019.', true, true, 50),
  ('general', 'Institute Radioactive Contamination Exclusion Clause', 'Institute Radioactive Contamination, Chemical, Biological, Bio-Chemical and Electromagnetic Weapons Exclusion Clause 10/11/03, CL370.', false, true, 60),
  ('general', 'Institute Cyber Attack Exclusion Clause', 'Institute Cyber Attack Exclusion Clause 10/11/03, CL380.', false, true, 70),
  ('general', 'Termination of Transit Clause (Terrorism)', 'Termination of Transit Clause (Terrorism) 2009, JC2009/056.', false, true, 80),
  ('general', 'Communicable Disease Exclusion', 'Communicable Disease Exclusion (Cargo), JC2020/011.', false, true, 90),
  ('general', 'Institute Replacement Clause', 'Institute Replacement Clause 1/12/08, CL372 — for machinery and parts.', false, false, 100),
  ('general', 'Label Clause', 'In case of damage to labels, capsules or wrappers, cover is limited to the cost of reconditioning, relabelling and repacking.', false, false, 110),
  ('general', 'Unattended Vehicle Clause', 'Theft from unattended vehicles is covered only if the vehicle was locked and parked in a secured or attended place.', false, false, 120),
  ('sanctions', 'German / EU market sanctions clause', 'No insurer shall provide cover or pay any claim or benefit hereunder to the extent that doing so would expose that insurer to any sanction, prohibition or restriction under United Nations resolutions or the trade or economic sanctions, laws or regulations of the European Union or the Federal Republic of Germany.', false, true, 10),
  ('sanctions', 'Sanction Limitation and Exclusion Clause', 'Sanction Limitation and Exclusion Clause, JC2010/014.', false, false, 20),
  ('pricing', 'Pricing note', 'Premium and minimum premium as shown above. Rates are confidential and must not be passed on.', false, true, 10),
  ('disclaimer', 'Title to goods and instruction to insure', 'This quotation is not evidence of title to the goods. Cover attaches only on the client''s written instruction to insure and our written confirmation, and only for goods in which the assured has an insurable interest.', false, true, 10),
  ('special', 'Used machinery', 'Excluding pre-existing damage, rust, oxidation, scratching, denting and mechanical or electrical derangement unless caused by an insured peril.', false, false, 10),
  ('special', 'Unpacked goods', 'Excluding scratching, denting, chipping and bruising unless caused by an insured peril.', false, false, 20),
  ('special', 'On deck', 'Cargo stowed on deck: covered for ICC (C) plus jettison and washing overboard only, unless agreed otherwise.', true, false, 30),
  ('special', 'Heavy lift / project', 'Subject to approval of loading, lashing and securing by a marine warranty surveyor.', true, false, 40),
  ('subjectivity', 'Sanctions screening', 'Subject to satisfactory sanctions screening of all parties.', false, true, 10),
  ('subjectivity', 'No known losses', 'Subject to no known or reported losses.', false, true, 20),
  ('subjectivity', 'Vessel details', 'Subject to satisfactory vessel details (name, IMO, year built, class, flag).', true, true, 30),
  ('subjectivity', 'Pre-shipment exception report', 'Subject to a pre-shipment survey / exception report for used goods, to be provided before attachment.', false, false, 40),
  ('subjectivity', 'Marine warranty survey', 'Subject to a marine warranty survey (MWS) for heavy lift, unpacked or on-deck cargo, survey recommendations to be complied with.', true, false, 50),
  ('subjectivity', 'Storage', 'Storage before or after transit beyond 30 days subject to prior agreement.', false, false, 60)
on conflict (category, title) do nothing;

-- every open cover policy: general conditions, sanctions, pricing, disclaimer and the standard subjectivities ticked
insert into public.policy_clauses(policy_id, clause_id, enabled)
select p.id, c.id, (c.category in ('general','sanctions','pricing','disclaimer') and c.title not in ('Institute Replacement Clause','Label Clause','Unattended Vehicle Clause','Sanction Limitation and Exclusion Clause'))
                    or (c.category = 'header' and c.title = 'Opening (open cover)')
                    or (c.category = 'subjectivity' and c.default_spot)
  from public.policies p cross join public.clause_library c
 where not exists (select 1 from public.policy_clauses x where x.policy_id = p.id and x.clause_id = c.id);

notify pgrst, 'reload schema';
