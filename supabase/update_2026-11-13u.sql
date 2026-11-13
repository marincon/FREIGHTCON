-- =====================================================================
-- FREIGHTCON update 2026-11-13u (website version 2026-11-13c)
-- Certificates issued by clients: the open policy no. on the form comes from the policy
-- of the case (Customers, policy, policy no.), then the client's certificate setting.
-- Run after update_2026-11-13t.sql. Safe to run more than once.
-- =====================================================================
do $$
declare d text;
begin
  select pg_get_functiondef('public.client_issue_certificate(bigint, jsonb, jsonb)'::regprocedure) into d;
  if position('pol_no'', coalesce((select nullif(policy_no' in d) = 0 then
    d := replace(d, $x$'pol_no', coalesce((select cert_open_policy$x$,
                    $x$'pol_no', coalesce((select nullif(policy_no, '') from public.policies where id = r.policy_id and not coalesce(r.is_standalone_one_off, false)), (select cert_open_policy$x$);
    execute d;
  end if;
end $$;
notify pgrst, 'reload schema';
