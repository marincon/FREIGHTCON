-- =====================================================================================================
-- FREIGHTCON update 2026-11-19d: German IPT territorial rule, multiple High-Risk Areas, certificate rights
-- (colleague prompt file name: 20261119_ipt_hra_cert_update.sql - same content)
--   1  German IPT (Versicherungsteuer) 19 %:
--        default_de_domestic = 19 % only when the transport starts AND ends in Germany (DE to DE)
--        always_19           = always 19 % (German policyholder / taxable risk override)
--        exempt_0            = exempt, 0 %
--      Order: case (on the spot) -> subcategory (policy) -> client (company) -> client group -> configuration.
--      New clients and client groups start with default_de_domestic; one-off cases inherit the configuration
--      default, which is default_de_domestic again. Old values are converted: auto -> default_de_domestic,
--      on -> always_19, off -> exempt_0 (also when an old browser tab still sends them).
--   2  selected_hras jsonb on indications (requests) and quotations: the High-Risk Areas / war & strikes zones
--      attached to a case or quotation, with their gross rate, NCB, net buy-back and include / optional flag.
--   3  Certificates: staff (admin, placing, claims) always; a client only when the certificate right of the
--      case's tree is on (user > subcategory > office > client > client group). Enforced by RLS and a trigger.
-- Run after update_2026-11-19c.sql. Idempotent.
-- =====================================================================================================

-- ---------------------------------------------------------------------------------------------------
-- 1  German IPT
-- ---------------------------------------------------------------------------------------------------
create or replace function public.ipt_mode_norm(p text) returns text
language sql immutable set search_path = public as $$
  select case lower(trim(coalesce(p, '')))
           when '' then null
           when 'auto' then 'default_de_domestic'
           when 'on' then 'always_19'
           when 'off' then 'exempt_0'
           else lower(trim(p)) end
$$;
grant execute on function public.ipt_mode_norm(text) to authenticated;

alter table public.client_groups add column if not exists ipt_mode text;

-- old check constraints out, values converted, new check constraints in
alter table public.customers     drop constraint if exists customers_ipt_mode_check;
alter table public.policies      drop constraint if exists policies_ipt_mode_check;
alter table public.indications   drop constraint if exists indications_ipt_mode_check;
alter table public.client_groups drop constraint if exists client_groups_ipt_mode_check;
alter table public.german_ipt_settings drop constraint if exists german_ipt_settings_default_mode_check;

update public.customers     set ipt_mode = public.ipt_mode_norm(ipt_mode) where ipt_mode is distinct from public.ipt_mode_norm(ipt_mode);
update public.policies      set ipt_mode = public.ipt_mode_norm(ipt_mode) where ipt_mode is distinct from public.ipt_mode_norm(ipt_mode);
update public.client_groups set ipt_mode = public.ipt_mode_norm(ipt_mode) where ipt_mode is distinct from public.ipt_mode_norm(ipt_mode);
-- the configuration goes back to the territorial rule (no flat / route-or-domicile IPT any more)
update public.german_ipt_settings set default_mode = 'default_de_domestic', default_rate = 19,
       rule_holder_de = false, rule_assured_de = false, rule_domestic = true, rule_from_de = false, rule_to_de = false, combine = 'domicile_and_route'
 where id = 1 and default_mode in ('auto','on','off');
insert into public.german_ipt_settings(id, default_rate, default_mode) values (1, 19, 'default_de_domestic') on conflict (id) do nothing;

alter table public.customers     add constraint customers_ipt_mode_check     check (ipt_mode is null or ipt_mode in ('default_de_domestic','always_19','exempt_0'));
alter table public.policies      add constraint policies_ipt_mode_check      check (ipt_mode is null or ipt_mode in ('default_de_domestic','always_19','exempt_0'));
alter table public.client_groups add constraint client_groups_ipt_mode_check check (ipt_mode is null or ipt_mode in ('default_de_domestic','always_19','exempt_0'));
alter table public.german_ipt_settings alter column default_mode set default 'default_de_domestic';
alter table public.german_ipt_settings add constraint german_ipt_settings_default_mode_check check (default_mode in ('default_de_domestic','always_19','exempt_0'));
-- new companies and client groups start with the default rule
alter table public.customers     alter column ipt_mode set default 'default_de_domestic';
alter table public.client_groups alter column ipt_mode set default 'default_de_domestic';

-- old values from a stale browser tab are converted instead of rejected
create or replace function public.ipt_mode_normalise() returns trigger
language plpgsql set search_path = public as $$
begin
  if tg_table_name = 'german_ipt_settings' then new.default_mode := coalesce(public.ipt_mode_norm(new.default_mode), 'default_de_domestic');
  else new.ipt_mode := public.ipt_mode_norm(new.ipt_mode); end if;
  return new;
end $$;
drop trigger if exists customers_ipt_norm on public.customers;
create trigger customers_ipt_norm before insert or update of ipt_mode on public.customers for each row execute function public.ipt_mode_normalise();
drop trigger if exists policies_ipt_norm on public.policies;
create trigger policies_ipt_norm before insert or update of ipt_mode on public.policies for each row execute function public.ipt_mode_normalise();
drop trigger if exists client_groups_ipt_norm on public.client_groups;
create trigger client_groups_ipt_norm before insert or update of ipt_mode on public.client_groups for each row execute function public.ipt_mode_normalise();
drop trigger if exists german_ipt_settings_norm on public.german_ipt_settings;
create trigger german_ipt_settings_norm before insert or update of default_mode on public.german_ipt_settings for each row execute function public.ipt_mode_normalise();
-- indications: the normalising trigger fires before indications_rules (alphabetical order)
drop trigger if exists indications_ipt_norm on public.indications;
create trigger indications_ipt_norm before insert or update of ipt_mode on public.indications for each row execute function public.ipt_mode_normalise();

-- the rule: 19 % only for DE to DE, unless the policyholder setting says always / exempt
create or replace function public.ipt_eval(p_mode text, p_from text, p_to text, p_holder text, p_assured text) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare s public.german_ipt_settings; m text; r text; v_rate numeric;
begin
  select * into s from public.german_ipt_settings where id = 1;
  v_rate := coalesce(s.default_rate, 19);
  r := rtrim(rtrim(v_rate::text, '0'), '.');
  m := coalesce(public.ipt_mode_norm(p_mode), public.ipt_mode_norm(s.default_mode), 'default_de_domestic');
  if m = 'exempt_0' then
    return jsonb_build_object('applied', false, 'rate', 0, 'mode', m, 'reason', 'No German IPT (0%): exempt by the policyholder setting');
  end if;
  if m = 'always_19' then
    return jsonb_build_object('applied', true, 'rate', v_rate, 'mode', m, 'reason', 'German IPT ' || r || '% applied: always applied (German policyholder / taxable risk)');
  end if;
  if upper(coalesce(p_from, '')) = 'DE' and upper(coalesce(p_to, '')) = 'DE' then
    return jsonb_build_object('applied', true, 'rate', v_rate, 'mode', m, 'reason', 'German IPT ' || r || '% applied: domestic German transport (starts and ends in Germany)');
  end if;
  return jsonb_build_object('applied', false, 'rate', 0, 'mode', m, 'reason', 'No German IPT (0%): cross-border / international transport');
end $$;
grant execute on function public.ipt_eval(text, text, text, text, text) to authenticated;

-- the inputs of a case: mode case -> policy -> client -> client group -> configuration
create or replace function public.ipt_for(i public.indications) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare pol public.policies; cu public.customers; grp public.client_groups; ofc public.offices; pr public.profiles; holder text;
begin
  if i.policy_id is not null and not coalesce(i.is_standalone_one_off, false) then select * into pol from public.policies where id = i.policy_id; end if;
  if i.customer_id is not null then select * into cu from public.customers where id = i.customer_id; end if;
  if cu.group_id is not null then select * into grp from public.client_groups where id = cu.group_id; end if;
  if i.office_id is not null then select * into ofc from public.offices where id = i.office_id; end if;
  select * into pr from public.profiles where id = i.user_id;
  holder := coalesce(nullif(pol.policyholder_country, ''), nullif(cu.country, ''), nullif(ofc.country, ''), nullif(pr.country, ''));
  return public.ipt_eval(coalesce(i.ipt_mode, pol.ipt_mode, cu.ipt_mode, grp.ipt_mode), i.origin_country, i.dest_country, holder, coalesce(nullif(i.insured_country, ''), holder))
         || jsonb_build_object('holder_country', holder);
end $$;
grant execute on function public.ipt_for(public.indications) to authenticated;

-- the IPT of the cases is re-read with the territorial rule; cases with an accepted quotation keep their figures
alter table public.indications add constraint indications_ipt_mode_check check (ipt_mode is null or ipt_mode in ('default_de_domestic','always_19','exempt_0')) not valid;
update public.indications set ipt_mode = public.ipt_mode_norm(ipt_mode) where ipt_mode is distinct from public.ipt_mode_norm(ipt_mode);
alter table public.indications validate constraint indications_ipt_mode_check;
update public.indications i set ipt_applied = coalesce((s.e->>'applied')::boolean, false), ipt_rate = (s.e->>'rate')::numeric, ipt_reason = s.e->>'reason',
       ipt_amount = case when (s.e->>'applied')::boolean and i.premium is not null then round(i.premium * (s.e->>'rate')::numeric / 100, 2) end
  from (select x.id, public.ipt_for(x) e from public.indications x
         where not exists (select 1 from public.quotations q where q.indication_id = x.id and q.status = 'accepted')) s
 where s.id = i.id and (i.ipt_applied is distinct from coalesce((s.e->>'applied')::boolean, false) or i.ipt_reason is distinct from s.e->>'reason');

-- ---------------------------------------------------------------------------------------------------
-- 2  High-Risk Areas (war & strikes zones) on requests and quotations
--    [{ code, name, kind, country, gross_pct, ncb_pct, net_pct, include, refer, source }]
-- ---------------------------------------------------------------------------------------------------
alter table public.indications add column if not exists selected_hras jsonb not null default '[]'::jsonb;
alter table public.quotations  add column if not exists selected_hras jsonb not null default '[]'::jsonb;
do $$ begin
  alter table public.indications add constraint indications_selected_hras_chk check (jsonb_typeof(selected_hras) = 'array' and jsonb_array_length(selected_hras) <= 40);
exception when duplicate_object then null; end $$;
do $$ begin
  alter table public.quotations add constraint quotations_selected_hras_chk check (jsonb_typeof(selected_hras) = 'array' and jsonb_array_length(selected_hras) <= 40);
exception when duplicate_object then null; end $$;

-- a quotation keeps the HRAs of its data in the column (admin_save_quotation stays as it is)
create or replace function public.quotations_hras() returns trigger
language plpgsql set search_path = public as $$
begin
  if jsonb_typeof(new.data->'selectedHras') = 'array' then new.selected_hras := new.data->'selectedHras'; end if;
  return new;
end $$;
drop trigger if exists quotations_hras on public.quotations;
create trigger quotations_hras before insert or update of data on public.quotations for each row execute function public.quotations_hras();
update public.quotations set selected_hras = data->'selectedHras' where jsonb_typeof(data->'selectedHras') = 'array' and selected_hras = '[]'::jsonb;

-- staff save the HRAs of a request (validated, logged)
create or replace function public.admin_set_case_hras(p_indication bigint, p_hras jsonb) returns boolean
language plpgsql security definer set search_path = public as $$
declare v jsonb := '[]'::jsonb; x jsonb; n text; g numeric; c numeric; t numeric;
begin
  if not public.has_role('placing') then raise exception 'not authorised'; end if;
  if jsonb_typeof(coalesce(p_hras, '[]'::jsonb)) <> 'array' then raise exception 'HRAs must be a list'; end if;
  for x in select * from jsonb_array_elements(coalesce(p_hras, '[]'::jsonb)) loop
    if coalesce(x->>'name', '') = '' then continue; end if;
    g := case when (x->>'gross_pct') ~ '^[0-9]+([.][0-9]+)?$' then round((x->>'gross_pct')::numeric, 4) end;
    c := case when (x->>'ncb_pct') ~ '^[0-9]+([.][0-9]+)?$' then least(100, round((x->>'ncb_pct')::numeric, 2)) else 0 end;
    t := case when (x->>'net_pct') ~ '^[0-9]+([.][0-9]+)?$' then round((x->>'net_pct')::numeric, 4)
              when g is not null then round(g * (1 - c / 100), 4) end;
    -- an area without net buy-back terms is Refer / A.P.: it can only be quoted as excluded / optional
    v := v || jsonb_build_object('code', left(coalesce(x->>'code', ''), 40), 'name', left(x->>'name', 120), 'kind', x->>'kind', 'country', x->>'country',
           'gross_pct', g, 'ncb_pct', c, 'net_pct', t, 'include', coalesce((x->>'include')::boolean, false) and t is not null, 'refer', t is null,
           'source', case when x->>'source' in ('auto','manual') then x->>'source' else 'manual' end);
  end loop;
  update public.indications set selected_hras = v where id = p_indication;
  if not found then raise exception 'not found'; end if;
  select string_agg((e->>'name') || case when (e->>'include')::boolean then ' (included)' else ' (optional / excluded)' end, ', ') into n from jsonb_array_elements(v) e;
  insert into public.audit_log(user_id, user_name, entity, entity_id, summary)
    values (auth.uid(), (select coalesce(full_name, email) from public.profiles where id = auth.uid()), 'case', p_indication::text,
            'High-Risk Areas set: ' || coalesce(n, 'none'));
  return true;
end $$;
grant execute on function public.admin_set_case_hras(bigint, jsonb) to authenticated;

-- ---------------------------------------------------------------------------------------------------
-- 3  Certificates: staff always, clients gated by the tree of the case
-- ---------------------------------------------------------------------------------------------------
-- staff: unconditional insert / update / delete (kept from 18b)
drop policy if exists admin_all on public.certificates;
create policy admin_all on public.certificates for all to authenticated using (public.is_admin()) with check (public.is_admin());
-- a restrictive gate: a non-staff insert must come from a client whose tree allows certificates for that case
drop policy if exists client_cert_gate on public.certificates;
create policy client_cert_gate on public.certificates as restrictive for insert to authenticated
  with check (public.is_admin() or exists (select 1 from public.indications i where i.id = indication_id and i.user_id = auth.uid()
                                           and public.cert_right_tree(auth.uid(), case when coalesce(i.is_standalone_one_off, false) then null else i.policy_id end, i.office_id, i.customer_id)));
drop policy if exists client_cert_no_update on public.certificates;
create policy client_cert_no_update on public.certificates as restrictive for update to authenticated using (public.is_admin()) with check (public.is_admin());
-- the same rule for the client portal function (security definer bypasses RLS): checked per case in a trigger
create or replace function public.certificates_client_gate() returns trigger
language plpgsql security definer set search_path = public as $$
declare i public.indications;
begin
  if auth.uid() is null or public.is_admin() then return new; end if;
  select * into i from public.indications where id = new.indication_id;
  if i.user_id is distinct from auth.uid()
     or not public.cert_right_tree(auth.uid(), case when coalesce(i.is_standalone_one_off, false) then null else i.policy_id end, i.office_id, i.customer_id) then
    raise exception 'Certificates are issued by MARINCON for this account. Please send a request or accept the quotation; MARINCON will issue the certificate.';
  end if;
  return new;
end $$;
drop trigger if exists certificates_client_gate on public.certificates;
create trigger certificates_client_gate before insert on public.certificates for each row execute function public.certificates_client_gate();

comment on column public.customers.can_issue_certificates is 'Client can issue certificates: whether the external client / policyholder can self-issue certificates in their portal. MARINCON staff can always issue certificates regardless of this setting.';
comment on column public.policies.can_issue_certificates is 'Policy client can issue certificates (null = as the client). MARINCON staff can always issue certificates regardless of this setting.';
comment on column public.offices.can_issue_certificates is 'Client can issue certificates, for this office (null = as the subcategory / client). Staff always can.';
comment on column public.client_groups.can_issue_certificates is 'Client can issue certificates, for the clients of this group (null = as each client). Staff always can.';
comment on column public.profiles.can_issue_certificates is 'Client can issue certificates, for this user (null = as the tree). Staff always can.';

