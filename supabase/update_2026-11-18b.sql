-- =====================================================================================================
-- FREIGHTCON update 2026-11-18b: certificate rights
--   * Staff (admin, placing, claims) may ALWAYS issue certificates, for any case, client or policy.
--   * Clients: the certificate right is read from their tree. The most specific explicit setting wins:
--       user  >  subcategory (policy)  >  office  >  client (company)  >  client group.  Nothing set = no certificates.
-- Run after update_2026-11-18a.sql. Idempotent.
-- =====================================================================================================

-- optional switches on the levels that had none (null = as the next level up)
alter table public.profiles add column if not exists can_issue_certificates boolean;
alter table public.offices add column if not exists can_issue_certificates boolean;
alter table public.client_groups add column if not exists can_issue_certificates boolean;

-- a client cannot switch its own certificate right on
create or replace function public.profiles_guard() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() and current_user not in ('postgres','service_role','supabase_admin') then
    if new.is_admin is distinct from old.is_admin or new.approved is distinct from old.approved
       or new.rejected is distinct from old.rejected
       or new.discount_mode is distinct from old.discount_mode or new.special_discount_pct is distinct from old.special_discount_pct
       or new.requested_company_name is distinct from old.requested_company_name
       or new.email is distinct from old.email or new.company is distinct from old.company
       or new.group_id is distinct from old.group_id or new.office_id is distinct from old.office_id
       or new.customer_id is distinct from old.customer_id or new.cover_type is distinct from old.cover_type
       or new.is_active is distinct from old.is_active or new.deleted_at is distinct from old.deleted_at
       or new.min_premium_override is distinct from old.min_premium_override
       or new.deductible_override is distinct from old.deductible_override
       or new.staff_roles is distinct from old.staff_roles
       or new.can_issue_certificates is distinct from old.can_issue_certificates then
      raise exception 'not allowed';
    end if;
  end if;
  return new;
end $$;

-- the certificate right of a client user (staff: always)
create or replace function public.cert_right_tree(p_user uuid, p_policy bigint default null, p_office bigint default null, p_customer bigint default null)
returns boolean
language plpgsql stable security definer set search_path = public as $$
declare pr public.profiles; po public.policies; o public.offices; cu public.customers; g public.client_groups;
begin
  if p_user is not null then select * into pr from public.profiles where id = p_user; end if;
  if pr.is_admin then return true; end if;
  select * into po from public.policies where id = coalesce(p_policy, case when p_user is not null then public.user_policy_id(p_user) end);
  select * into o from public.offices where id = coalesce(p_office, pr.office_id);
  select * into cu from public.customers where id = coalesce(p_customer, po.customer_id, o.customer_id, case when p_user is not null then public.user_customer_id(p_user) end);
  select * into g from public.client_groups where id = cu.group_id;
  return coalesce(pr.can_issue_certificates, po.can_issue_certificates, o.can_issue_certificates, cu.can_issue_certificates, g.can_issue_certificates, false);
end $$;
grant execute on function public.cert_right_tree(uuid, bigint, bigint, bigint) to authenticated;

-- client portal features: the same tree; staff always
do $$
declare d text;
begin
  d := pg_get_functiondef('public.my_features()'::regprocedure);
  if position('cert_right_tree' in d) = 0 then
    if position('can := coalesce(po.can_issue_certificates, c.can_issue_certificates, false);' in d) = 0 then raise exception 'my_features: pattern not found'; end if;
    d := replace(d, 'can := coalesce(po.can_issue_certificates, c.can_issue_certificates, false);',
                    'can := public.cert_right_tree(p.id, po.id, p.office_id, c.id);');
    execute d;
  end if;
end $$;

-- the right per case (used by the staff lists and the client portal): the tree of the case's user, office and policy
do $$
declare d text;
begin
  d := pg_get_viewdef('public.case_certificate_rights'::regclass);
  if position('cert_right_tree' in d) = 0 then
    if position('(COALESCE(po.can_issue_certificates, cu.can_issue_certificates, false) OR COALESCE(c.is_direct_certificate, false))' in d) = 0 then raise exception 'case_certificate_rights: pattern not found'; end if;
    d := replace(d, '(COALESCE(po.can_issue_certificates, cu.can_issue_certificates, false) OR COALESCE(c.is_direct_certificate, false))',
                    '(public.cert_right_tree(c.user_id, c.pol_id, c.office_id, c.cust_id) OR COALESCE(c.is_direct_certificate, false))');
    execute 'create or replace view public.case_certificate_rights as ' || d;
  end if;
end $$;

-- staff issue: every staff role (was placing only)
do $$
declare d text;
begin
  d := pg_get_functiondef('public.admin_issue_certificate(bigint, bigint, jsonb, text)'::regprocedure);
  if position('if not public.has_role(''placing'') then raise exception ''not authorised''; end if;' in d) > 0 then
    execute replace(d, 'if not public.has_role(''placing'') then raise exception ''not authorised''; end if;',
                       'if not public.is_admin() then raise exception ''not authorised''; end if;   -- every staff user, regardless of the client''s switch');
  end if;
end $$;

-- RLS on certificates: staff unconditionally (insert / update / delete), clients read their own;
-- clients issue only through client_issue_certificate(), which checks the tree above.
drop policy if exists admin_all on public.certificates;
create policy admin_all on public.certificates for all to authenticated using (public.is_admin()) with check (public.is_admin());
