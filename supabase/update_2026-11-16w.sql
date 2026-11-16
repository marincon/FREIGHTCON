-- =====================================================================
-- FREIGHTCON update 2026-11-16w (website version 2026-11-16b)
-- The colleague's "20261116b_cert_and_tracking_fix.sql":
--  1  certificate rights in one place: view case_certificate_rights (client / subcategory flags per case)
--  2  clients with can_issue_certificates may issue directly (no second switch needed)
--  3  certificates: state (issued / draft / cancelled / amended)
--  4  claims: loss type "general average"
-- Run after update_2026-11-16v.sql. Safe to run more than once.
-- =====================================================================

-- 1  every case with the certificate rights of its client and subcategory
drop view if exists public.case_certificate_rights;
create view public.case_certificate_rights with (security_invoker = true) as
  select i.id as indication_id, i.customer_id, case when coalesce(i.is_standalone_one_off, false) then null else i.policy_id end as policy_id,
         coalesce(case when coalesce(i.is_standalone_one_off, false) then null else po.can_issue_certificates end, cu.can_issue_certificates, false) or coalesce(i.is_direct_certificate, false) as can_issue_certificates,
         coalesce(case when coalesce(i.is_standalone_one_off, false) then null else po.certificate_mode end, cu.certificate_mode, 'platform_pdf') as certificate_mode,
         coalesce(nullif(cu.cert_holder, ''), nullif(i.insured_name, ''), cu.name, i.company) as policy_holder_name,
         coalesce(case when coalesce(i.is_standalone_one_off, false) then null else nullif(po.policy_no, '') end, nullif(cu.cert_open_policy, '')) as open_policy_no
    from public.indications i
    left join public.customers cu on cu.id = i.customer_id
    left join public.policies po on po.id = i.policy_id;
grant select on public.case_certificate_rights to authenticated;

-- 2  direct certificates follow can_issue_certificates (the permission matrix can still switch the feature off)
do $$
declare d text;
begin
  select pg_get_functiondef('public.my_features()'::regprocedure) into d;
  if position('coalesce(c.direct_certificate_enabled, false) and can' in d) > 0 then
    d := replace(d, 'coalesce(c.direct_certificate_enabled, false) and can', 'can');
    execute d;
  end if;
end $$;
update public.customers set direct_certificate_enabled = can_issue_certificates;

-- 3  certificate states
alter table public.certificates add column if not exists status text not null default 'issued';
alter table public.certificates drop constraint if exists certificates_status_check;
alter table public.certificates add constraint certificates_status_check check (status in ('issued','draft','cancelled','amended'));
alter table public.certificates add column if not exists status_note text;
alter table public.certificates add column if not exists status_at timestamptz;
create or replace function public.certificates_status_stamp() returns trigger
language plpgsql as $$
begin
  if tg_op = 'UPDATE' and new.status is distinct from old.status then new.status_at := now(); end if;
  return new;
end $$;
drop trigger if exists certificates_status_stamp on public.certificates;
create trigger certificates_status_stamp before update on public.certificates for each row execute function public.certificates_status_stamp();

-- 4  claims: general average
alter table public.claims drop constraint if exists claims_loss_type_check;
alter table public.claims add constraint claims_loss_type_check check (loss_type in ('damage','wet','theft','shortage','temperature','total_loss','general_average','other'));

notify pgrst, 'reload schema';
