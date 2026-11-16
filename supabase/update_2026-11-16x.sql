-- =====================================================================
-- FREIGHTCON update 2026-11-16x (website version 2026-11-16c)
-- Certificates for every client with can_issue_certificates:
--  1  the rights per case also find the client through the office, the subcategory
--     and the user's company (cases without customer_id were treated as "no certificates")
--  2  the old switch "direct certificate issuance" always follows can_issue_certificates
--  3  cover notes: state (issued / cancelled) for the new Cover notes tab
-- Run after update_2026-11-16w.sql. Safe to run more than once.
-- =====================================================================

-- 1  one client per case: case -> subcategory -> office -> the user's company
drop view if exists public.case_certificate_rights;
create view public.case_certificate_rights as
  with c as (
    select i.*, coalesce(i.customer_id, po.customer_id, o.customer_id, pro.customer_id, pr.customer_id,
             -- same order as user_customer_id(), written out here: that helper is not executable by signed-in users
             (select c2.id from public.customers c2 where c2.active and lower(split_part(pr.email, '@', 2)) = any(c2.email_domains) order by c2.sort, c2.id limit 1),
             (select min(c3.id) from public.customers c3 join public.client_groups g on g.id = c3.group_id
               where lower(split_part(pr.email, '@', 2)) = any(g.email_domains) having count(*) = 1)) as cust_id,
           case when coalesce(i.is_standalone_one_off, false) then null else coalesce(i.policy_id, o.policy_id) end as pol_id
      from public.indications i
      left join public.offices o on o.id = i.office_id
      left join public.profiles pr on pr.id = i.user_id
      left join public.offices pro on pro.id = pr.office_id
      left join public.policies po on po.id = i.policy_id
     where public.is_admin() or i.user_id = auth.uid()
  )
  select c.id as indication_id, c.cust_id as customer_id, c.pol_id as policy_id,
         coalesce(po.can_issue_certificates, cu.can_issue_certificates, false) or coalesce(c.is_direct_certificate, false) as can_issue_certificates,
         coalesce(po.certificate_mode, cu.certificate_mode, 'platform_pdf') as certificate_mode,
         coalesce(nullif(cu.cert_holder, ''), nullif(c.insured_name, ''), cu.name, c.company) as policy_holder_name,
         coalesce(nullif(po.policy_no, ''), nullif(cu.cert_open_policy, '')) as open_policy_no
    from c
    left join public.customers cu on cu.id = c.cust_id
    left join public.policies po on po.id = c.pol_id;
grant select on public.case_certificate_rights to authenticated;

-- 2  one switch: can_issue_certificates (the older flags follow it)
create or replace function public.customers_cert_sync() returns trigger
language plpgsql as $$
begin
  new.fdf_certificate_enabled := new.can_issue_certificates;
  new.direct_certificate_enabled := new.can_issue_certificates;
  return new;
end $$;
update public.customers set can_issue_certificates = can_issue_certificates;

-- 3  cover note states
alter table public.cover_notes add column if not exists status text not null default 'issued';
alter table public.cover_notes drop constraint if exists cover_notes_status_check;
alter table public.cover_notes add constraint cover_notes_status_check check (status in ('issued','cancelled'));
alter table public.cover_notes add column if not exists status_note text;

notify pgrst, 'reload schema';
