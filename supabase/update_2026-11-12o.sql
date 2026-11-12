-- =====================================================================
-- FREIGHTCON update 2026-11-12o — open covers (stage 4)
-- * certificates (Bertling): issued certificate numbers and the data that
--   went into the AKM / MARINCON certificate form (.fdf / filled PDF)
-- * policies.certificate: which policies issue certificates on that form
-- * information firewall: clients no longer read the country table
--   directly (zones, compliance and crisis loadings are internal); they get
--   names plus a routing hint from list_countries()
-- * zones can be added (new last zone) or removed (last zone; its
--   countries become "unassigned") — with a reason, in the change log
-- Run after update_2026-11-12n.sql. Safe to run more than once.
-- =====================================================================

alter table public.policies add column if not exists certificate boolean not null default false;
update public.policies set certificate = true where policy_no in ('000181-304-0030', '000182-304-0030');

create table if not exists public.certificates (
  id            bigserial primary key,
  indication_id bigint not null references public.indications(id) on delete cascade,
  quotation_id  bigint references public.quotations(id) on delete set null,
  number        text not null,
  data          jsonb not null default '{}'::jsonb,
  created_by    uuid,
  created_at    timestamptz not null default now()
);
create unique index if not exists certificates_number_uq on public.certificates(number);
alter table public.certificates enable row level security;
drop policy if exists admin_all on public.certificates;
create policy admin_all on public.certificates for all to authenticated using (public.is_admin()) with check (public.is_admin());

insert into public.settings(key, value, note) values
  ('certificate_form', '{"file":"BERTLING_MASTER_TRANSPORT_POLICY_OHNE_STEMPEL_202304.pdf","open_policy":"3441","claims_contact":"www.vht-network.de"}',
   'Certificate form: PDF file name the .fdf points to, open policy number on the form, claims contact')
on conflict (key) do nothing;

-- private storage for the blank certificate form (staff only; never on the public website)
do $$
begin
  if exists (select 1 from information_schema.tables where table_schema = 'storage' and table_name = 'buckets') then
    insert into storage.buckets(id, name, public, file_size_limit) values ('forms', 'forms', false, 10485760)
      on conflict (id) do nothing;
    execute 'drop policy if exists "forms admin" on storage.objects';
    execute $p$create policy "forms admin" on storage.objects for all to authenticated
             using (bucket_id = 'forms' and public.is_admin()) with check (bucket_id = 'forms' and public.is_admin())$p$;
  end if;
end $$;

-- ---------- countries: names for clients, everything else internal ----------
drop policy if exists read_countries on public.countries;
create or replace function public.list_countries() returns table(iso2 text, name text, sanctioned boolean, on_request boolean, suez text)
language sql stable security definer set search_path = public as $$
  -- suez: 'w' = west of Suez (Europe, Mediterranean, Black Sea), 'e' = east of Suez, 'r' = on the Red Sea
  select c.iso2, c.name, c.sanctioned, c.on_request,
         case when c.iso2 in ('EG','SA','JO','SD','ER','DJ','YE','IL') then 'r'
              when c.sea_zone in (5,6,11,12) then 'w'
              when c.sea_zone in (9,10,14,15,16,17,18,19) then 'e' end
    from public.countries c order by c.name
$$;
grant execute on function public.list_countries() to authenticated, anon;

-- ---------- add / remove a zone (last zone only) ----------
create or replace function public.admin_zone_count(p_mode text, p_action text, p_reason text) returns int
language plpgsql security definer set search_path = public as $$
declare me public.profiles; n int; v_list text;
begin
  if not public.is_admin() then raise exception 'not authorised'; end if;
  if p_mode not in ('sea','air') or p_action not in ('add','remove') then raise exception 'invalid'; end if;
  if length(trim(coalesce(p_reason, ''))) < 3 then raise exception 'reason required'; end if;
  select * into me from public.profiles where id = auth.uid();
  perform set_config('fc.audited', '1', true);
  select max(zones) into n from public.rate_tables where mode = p_mode;
  if p_action = 'add' then
    update public.rate_tables set zones = n + 1, updated_at = now() where mode = p_mode;
    insert into public.audit_log(user_id, user_name, entity, entity_id, summary, reason)
    values (auth.uid(), coalesce(me.full_name, me.email), 'zones', p_mode, initcap(p_mode) || ' zone ' || (n + 1) || ' added (rates empty = on request until filled in)', trim(p_reason));
    return n + 1;
  end if;
  if n <= 1 then raise exception 'at least one zone'; end if;
  select string_agg(name, ', ' order by name) into v_list from public.countries where (case p_mode when 'sea' then sea_zone else air_zone end) = n;
  if p_mode = 'sea' then update public.countries set sea_zone = null where sea_zone = n;
  else update public.countries set air_zone = null where air_zone = n; end if;
  delete from public.rate_cells c using public.rate_tables t where t.id = c.table_id and t.mode = p_mode and c.zone_b = n;
  update public.rate_tables set zones = n - 1, updated_at = now() where mode = p_mode;
  insert into public.audit_log(user_id, user_name, entity, entity_id, summary, reason)
  values (auth.uid(), coalesce(me.full_name, me.email), 'zones', p_mode, initcap(p_mode) || ' zone ' || n || ' removed; now unassigned: ' || coalesce(v_list, 'no countries'), trim(p_reason));
  return n - 1;
end $$;
grant execute on function public.admin_zone_count(text, text, text) to authenticated;

notify pgrst, 'reload schema';
