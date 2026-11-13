-- =====================================================================
-- FREIGHTCON update 2026-11-13t (website version 2026-11-13b)
--  1  clause categories: add, rename, describe, delete, reorder; free sorting inside every category
--  2  text templates per level (general / client / policy) with merge tags and default formatting
--  3  quotations: save without sending, send / resend, immutable sending history
--  4  rate vs premium display mode (rate_only / premium_only / both) per level and per quotation
--  5  request lifecycle: request, working_on_it, quotation, certificate, closed (+ closure reason)
--  6  policy years, hard expiry lock, certificate numbering matrices per policy year
--  7  German insurance premium tax (IPT / Versicherungsteuer) with route and domicile rules
--  8  no em / en dashes left in any function text
-- Run after update_2026-11-13s.sql. Safe to run more than once.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1  clause categories
-- ---------------------------------------------------------------------
create table if not exists public.clause_categories (
  key         text primary key check (key ~ '^[a-z][a-z0-9_]{0,39}$'),
  label       text not null check (length(trim(label)) between 1 and 80),
  description text,
  doc_heading text not null default '',          -- heading in the quotation (bold + underlined); empty = none
  show_titles boolean not null default false,    -- clause titles printed above their wording
  sort        int not null default 100,
  system      boolean not null default false,    -- used by the quotation logic: can be renamed and moved, not deleted
  updated_at  timestamptz not null default now()
);
insert into public.clause_categories(key, label, doc_heading, show_titles, sort, system) values
  ('header','Opening','',false,10,false),
  ('general','General conditions','General Conditions:',false,20,false),
  ('subject_matter','Subject-matter insured','Subject-Matter Insured:',true,30,false),
  ('special_cargo','Special cargoes','Special Cargoes:',true,40,false),
  ('special','Special conditions','Special Conditions:',true,50,true),
  ('expenses','Expenses','Expenses:',true,60,false),
  ('contingency','Contingency','Contingency:',true,70,false),
  ('claims','Claims','Claims:',true,80,false),
  ('administration','Administration','Administration:',true,90,false),
  ('sanctions','Sanctions','Sanctions Clause:',false,100,false),
  ('pricing','Rate, minimum premium & deductible','',false,110,true),
  ('disclaimer','Disclaimer','',false,120,false),
  ('subjectivity','Subjectivities & warranties','Subjectivities:',false,130,true)
on conflict (key) do nothing;
insert into public.clause_categories(key, label, sort)
  select distinct l.category, initcap(replace(l.category, '_', ' ')), 900 from public.clause_library l
   where not exists (select 1 from public.clause_categories k where k.key = l.category)
on conflict (key) do nothing;
alter table public.clause_library drop constraint if exists clause_library_category_check;
alter table public.clause_library drop constraint if exists clause_library_category_fk;
alter table public.clause_library add constraint clause_library_category_fk foreign key (category)
  references public.clause_categories(key) on update cascade;

-- delete a category: move its clauses to another category, or delete them with it
create or replace function public.admin_delete_category(p_key text, p_move_to text default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare c public.clause_categories; t public.clause_categories; n int := 0;
begin
  if not public.has_role('admin') then raise exception 'not authorised'; end if;
  select * into c from public.clause_categories where key = p_key;
  if not found then raise exception 'category not found'; end if;
  if c.system then raise exception 'The category "%" is used by the quotation logic. Rename or move it instead of deleting it.', c.label; end if;
  if p_move_to is not null then
    select * into t from public.clause_categories where key = p_move_to;
    if not found or t.key = c.key then raise exception 'choose another category to move the clauses to'; end if;
    -- same title in the target category: keep both, the moved one gets the old category in brackets
    update public.clause_library l set title = left(l.title || ' (' || c.label || ')', 200)
     where l.category = c.key and exists (select 1 from public.clause_library x where x.scope_type = l.scope_type
           and coalesce(x.scope_id, 0) = coalesce(l.scope_id, 0) and x.category = t.key and x.title = l.title);
    update public.clause_library set category = t.key where category = c.key;
    get diagnostics n = row_count;
  else
    delete from public.clause_library where category = c.key;
    get diagnostics n = row_count;
  end if;
  delete from public.clause_categories where key = c.key;
  insert into public.audit_log(user_id, user_name, entity, entity_id, summary)
  values (auth.uid(), (select full_name from public.profiles where id = auth.uid()), 'clause_category', c.key,
          'Category "' || c.label || '" deleted; ' || n || ' clause(s) ' || case when t.key is null then 'deleted' else 'moved to "' || t.label || '"' end);
  return jsonb_build_object('clauses', n, 'moved_to', t.key);
end $$;
grant execute on function public.admin_delete_category(text, text) to authenticated;

-- reorder categories (keys in the new order)
create or replace function public.admin_sort_categories(p_keys text[]) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.has_role('admin') then raise exception 'not authorised'; end if;
  update public.clause_categories k set sort = x.i * 10, updated_at = now()
    from unnest(p_keys) with ordinality x(key, i) where k.key = x.key;
end $$;
grant execute on function public.admin_sort_categories(text[]) to authenticated;

-- reorder clauses: library (one-off) or a client / policy list; ids in the new order
create or replace function public.admin_sort_clauses(p_level text, p_id bigint, p_ids bigint[]) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.has_role('admin') then raise exception 'not authorised'; end if;
  if p_level = 'library' then
    update public.clause_library l set sort = x.i * 10 from unnest(p_ids) with ordinality x(id, i) where l.id = x.id;
  elsif p_level = 'customer' then
    update public.customer_clauses l set sort = x.i * 10 from unnest(p_ids) with ordinality x(id, i) where l.customer_id = p_id and l.clause_id = x.id;
  elsif p_level = 'policy' then
    update public.policy_clauses l set sort = x.i * 10 from unnest(p_ids) with ordinality x(id, i) where l.policy_id = p_id and l.clause_id = x.id;
  else raise exception 'unknown level'; end if;
end $$;
grant execute on function public.admin_sort_clauses(text, bigint, bigint[]) to authenticated;

drop view if exists public.master_clauses_library;
create view public.master_clauses_library as
  select l.id, l.category, k.label as category_label, k.sort as category_sort, l.title, l.body, l.maritime, l.air_only,
         l.active, l.sort, l.source, l.default_spot as oneoff_active, l.oneoff_list
    from public.clause_library l join public.clause_categories k on k.key = l.category
   where l.scope_type = 'one_off_general';
grant select on public.master_clauses_library to authenticated;

-- ---------------------------------------------------------------------
-- 2  text templates and default formatting (general -> client -> policy)
-- ---------------------------------------------------------------------
create table if not exists public.text_templates (
  id          bigserial primary key,
  scope_type  text not null check (scope_type in ('one_off_general','customer','policy')),
  scope_id    bigint,
  kind        text not null check (kind in ('quotation','client_text','insurer_text','certificate_agreements')),
  name        text not null default 'Default' check (length(trim(name)) between 1 and 120),
  body        text not null default '',     -- HTML with {{merge_tags}} and [[blocks]]
  active      boolean not null default true,
  updated_by  uuid,
  updated_at  timestamptz not null default now(),
  check ((scope_type = 'one_off_general' and scope_id is null) or (scope_type <> 'one_off_general' and scope_id is not null))
);
create unique index if not exists text_templates_uq on public.text_templates(scope_type, coalesce(scope_id, 0), kind);

create table if not exists public.text_formatting (
  scope_type           text not null check (scope_type in ('one_off_general','customer','policy')),
  scope_id             bigint,
  font_family          text not null default 'Calibri' check (length(font_family) between 1 and 60),
  font_size_pt         numeric(4,1) not null default 10 check (font_size_pt between 6 and 24),
  line_height          numeric(3,2) not null default 1.35 check (line_height between 1 and 3),
  paragraph_spacing_pt numeric(4,1) not null default 8 check (paragraph_spacing_pt between 0 and 40),
  text_color           text not null default '#000000' check (text_color ~ '^#[0-9a-fA-F]{6}$'),
  updated_at           timestamptz not null default now(),
  check ((scope_type = 'one_off_general' and scope_id is null) or (scope_type <> 'one_off_general' and scope_id is not null))
);
create unique index if not exists text_formatting_uq on public.text_formatting(scope_type, coalesce(scope_id, 0));
insert into public.text_formatting(scope_type, scope_id)
  select 'one_off_general', null where not exists (select 1 from public.text_formatting where scope_type = 'one_off_general');

insert into public.text_templates(scope_type, scope_id, kind, name, body)
select 'one_off_general', null, k, n, b from (values
  ('quotation', 'Quotation wording', '[[clauses]]'),
  ('client_text', 'E-mail to the client',
   '<p>Dear {{client_name}},</p><p>Thank you for your enquiry. Please find our quotation {{reference}} for {{cargo_description}} from {{voyage_from}} to {{voyage_to}} below.</p>[[quotation]]<p>We look forward to hearing from you.</p><p>Kind regards<br>{{handler_name}}</p>'),
  ('insurer_text', 'Request to the insurer', '[[shipment_details]]'),
  ('certificate_agreements', 'Certificate: additional agreements', '')
) v(k, n, b)
where not exists (select 1 from public.text_templates t where t.scope_type = 'one_off_general' and t.kind = v.k);

create or replace function public.text_scope_cleanup() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  delete from public.text_templates where scope_type = case when tg_table_name = 'customers' then 'customer' else 'policy' end and scope_id = old.id;
  delete from public.text_formatting where scope_type = case when tg_table_name = 'customers' then 'customer' else 'policy' end and scope_id = old.id;
  return old;
end $$;
drop trigger if exists customers_text_cleanup on public.customers;
create trigger customers_text_cleanup after delete on public.customers for each row execute function public.text_scope_cleanup();
drop trigger if exists policies_text_cleanup on public.policies;
create trigger policies_text_cleanup after delete on public.policies for each row execute function public.text_scope_cleanup();

-- ---------------------------------------------------------------------
-- 4  display mode (needed by the quotation functions below)
-- ---------------------------------------------------------------------
alter table public.customers   add column if not exists quote_display_mode text;
alter table public.policies    add column if not exists quote_display_mode text;
alter table public.indications add column if not exists quote_display_mode text;
alter table public.customers   drop constraint if exists customers_display_mode_check;
alter table public.customers   add constraint customers_display_mode_check check (quote_display_mode is null or quote_display_mode in ('rate_only','premium_only','both'));
alter table public.policies    drop constraint if exists policies_display_mode_check;
alter table public.policies    add constraint policies_display_mode_check check (quote_display_mode is null or quote_display_mode in ('rate_only','premium_only','both'));
alter table public.indications drop constraint if exists indications_display_mode_check;
alter table public.indications add constraint indications_display_mode_check check (quote_display_mode is null or quote_display_mode in ('rate_only','premium_only','both'));
insert into public.settings(key, value, note) values
  ('quote_display_mode', '"both"', 'What clients see on quotations: rate_only, premium_only or both (clients and policies can override it)')
on conflict (key) do nothing;

-- the mode for a case: quotation / indication -> policy -> client -> configuration
create or replace function public.display_mode_for(p_indication bigint) returns text
language sql stable security definer set search_path = public as $$
  select coalesce(i.quote_display_mode, pol.quote_display_mode, cu.quote_display_mode, public.setting('quote_display_mode') #>> '{}', 'both')
    from public.indications i
    left join public.policies pol on pol.id = i.policy_id and not coalesce(i.is_standalone_one_off, false)
    left join public.customers cu on cu.id = i.customer_id
   where i.id = p_indication
$$;
grant execute on function public.display_mode_for(bigint) to authenticated;

-- the mode for the logged-in client (office policy -> first policy -> client -> configuration)
create or replace function public.my_display_mode() returns text
language plpgsql stable security definer set search_path = public as $$
declare prof public.profiles; ofc public.offices; cu public.customers; pol public.policies;
begin
  select * into prof from public.profiles where id = auth.uid();
  if not found then return 'both'; end if;
  if prof.office_id is not null then select * into ofc from public.offices where id = prof.office_id; end if;
  select * into cu from public.customers where id = coalesce(ofc.customer_id, public.user_customer_id(prof.id));
  if ofc.policy_id is not null then select * into pol from public.policies where id = ofc.policy_id;
  elsif cu.id is not null then select * into pol from public.policies where customer_id = cu.id and active order by sort, id limit 1; end if;
  return coalesce(pol.quote_display_mode, cu.quote_display_mode, public.setting('quote_display_mode') #>> '{}', 'both');
end $$;
grant execute on function public.my_display_mode() to authenticated;

-- what a client may see of a quotation
create or replace function public.quote_redact(d jsonb, m text) returns jsonb
language sql immutable as $$
  select case coalesce(m, 'both')
    when 'rate_only' then (d - 'subtotal' - 'discountAmount' - 'net' - 'tax' - 'total')
      || jsonb_build_object('displayMode', 'rate_only',
           'lines', coalesce((select jsonb_agg(l - 'premium') from jsonb_array_elements(case when jsonb_typeof(d->'lines') = 'array' then d->'lines' else '[]'::jsonb end) l), '[]'::jsonb),
           'warExcl', case when jsonb_typeof(d->'warExcl') = 'object' then (d->'warExcl') - 'totalExcl' - 'totalIncl' - 'netIncl' else d->'warExcl' end)
    when 'premium_only' then d
      || jsonb_build_object('displayMode', 'premium_only',
           'lines', coalesce((select jsonb_agg(l - 'rate') from jsonb_array_elements(case when jsonb_typeof(d->'lines') = 'array' then d->'lines' else '[]'::jsonb end) l), '[]'::jsonb),
           'warExcl', case when jsonb_typeof(d->'warExcl') = 'object' then (d->'warExcl') - 'rateExcl' - 'rateIncl' - 'buybackPct' else d->'warExcl' end)
    else d || jsonb_build_object('displayMode', 'both') end
$$;

-- ---------------------------------------------------------------------
-- 5  request lifecycle
-- ---------------------------------------------------------------------
alter table public.indications drop constraint if exists indications_stage_check;
alter table public.indications add column if not exists closure_reason   text;
alter table public.indications add column if not exists status_note      text;
alter table public.indications add column if not exists stage_changed_at timestamptz;
alter table public.indications add column if not exists working_at       timestamptz;
alter table public.indications add column if not exists quotation_at     timestamptz;
alter table public.indications add column if not exists certificate_at   timestamptz;
alter table public.indications add column if not exists closed_at        timestamptz;
alter table public.indications drop constraint if exists indications_closure_reason_check;
alter table public.indications add constraint indications_closure_reason_check
  check (closure_reason is null or closure_reason in ('completed','declined_by_insurer','not_taken_up','cancelled'));

-- older code still writes new / in_progress / quoted / accepted / bound / declined / lost: mapped here
create or replace function public.indication_stage() returns trigger
language plpgsql as $$
declare v text := new.stage;
begin
  new.stage := case v when 'new' then 'request' when 'in_progress' then 'working_on_it' when 'quoted' then 'quotation'
                      when 'accepted' then 'certificate' when 'bound' then 'certificate' when 'declined' then 'closed' when 'lost' then 'closed'
                      else coalesce(v, 'request') end;
  if new.stage = 'closed' then
    if new.closure_reason is null then new.closure_reason := case when v in ('declined','lost') then 'not_taken_up' else 'completed' end; end if;
  else
    new.closure_reason := null;
  end if;
  if tg_op = 'INSERT' or new.stage is distinct from old.stage then
    new.stage_changed_at := now();
    if new.stage = 'working_on_it' then new.working_at := coalesce(new.working_at, now());
    elsif new.stage = 'quotation' then new.quotation_at := coalesce(new.quotation_at, now());
    elsif new.stage = 'certificate' then new.certificate_at := coalesce(new.certificate_at, now());
    elsif new.stage = 'closed' then new.closed_at := now(); end if;
  end if;
  return new;
end $$;
drop trigger if exists indications_stage on public.indications;
create trigger indications_stage before insert or update on public.indications for each row execute function public.indication_stage();

update public.indications set closure_reason = case when stage in ('declined','lost') then 'not_taken_up' else 'completed' end
 where stage in ('declined','lost','closed') and closure_reason is null;
update public.indications set stage = stage where stage in ('new','in_progress','quoted','accepted','bound','declined','lost');
update public.indications set stage_changed_at = coalesce(stage_changed_at, updated_at, created_at) where stage_changed_at is null;
alter table public.indications alter column stage set default 'request';
alter table public.indications add constraint indications_stage_check check (stage in ('request','working_on_it','quotation','certificate','closed'));

-- ---------------------------------------------------------------------
-- 6  policy years, expiry lock, certificate numbering
-- ---------------------------------------------------------------------
create table if not exists public.policy_years (
  id          bigserial primary key,
  policy_id   bigint not null references public.policies(id) on delete cascade,
  label       text not null check (length(trim(label)) between 1 and 60),
  starts_on   date not null,
  ends_on     date not null,
  status      text not null default 'active' check (status in ('active','extended','expired')),
  extended_to date,
  notes       text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  check (ends_on >= starts_on),
  check (extended_to is null or extended_to >= ends_on)
);
create index if not exists policy_years_policy_idx on public.policy_years(policy_id, starts_on);

create or replace function public.policy_years_guard() returns trigger
language plpgsql as $$
declare x public.policy_years;
begin
  if new.status <> 'extended' then new.extended_to := null; end if;
  if new.status = 'extended' and new.extended_to is null then raise exception 'Enter the date the policy year is extended to.'; end if;
  select * into x from public.policy_years y where y.policy_id = new.policy_id and y.id <> coalesce(new.id, 0)
     and daterange(y.starts_on, coalesce(y.extended_to, y.ends_on), '[]') && daterange(new.starts_on, coalesce(new.extended_to, new.ends_on), '[]') limit 1;
  if found then raise exception 'The period overlaps policy year % (% to %).', x.label, to_char(x.starts_on, 'DD.MM.YYYY'), to_char(coalesce(x.extended_to, x.ends_on), 'DD.MM.YYYY'); end if;
  new.updated_at := now();
  return new;
end $$;
drop trigger if exists policy_years_guard on public.policy_years;
create trigger policy_years_guard before insert or update on public.policy_years for each row execute function public.policy_years_guard();

-- every policy starts with the current calendar year (staff adjust or add years in the policy profile)
create or replace function public.policy_first_year() returns trigger
language plpgsql security definer set search_path = public as $$
declare y int := extract(year from current_date)::int;
begin
  if not exists (select 1 from public.policy_years where policy_id = new.id) then
    insert into public.policy_years(policy_id, label, starts_on, ends_on, status)
    values (new.id, y || '/' || (y + 1), make_date(y, 1, 1), make_date(y, 12, 31), 'active');
  end if;
  return new;
end $$;
drop trigger if exists policies_first_year on public.policies;
create trigger policies_first_year after insert on public.policies for each row execute function public.policy_first_year();
insert into public.policy_years(policy_id, label, starts_on, ends_on, status)
  select p.id, extract(year from current_date)::int || '/' || (extract(year from current_date)::int + 1),
         make_date(extract(year from current_date)::int, 1, 1), make_date(extract(year from current_date)::int, 12, 31), 'active'
    from public.policies p where not exists (select 1 from public.policy_years y where y.policy_id = p.id);

create table if not exists public.certificate_numbering_matrices (
  id                  bigserial primary key,
  policy_year_id      bigint not null references public.policy_years(id) on delete cascade,
  matrix_name         text not null check (length(trim(matrix_name)) between 1 and 120),
  naming_pattern      text not null default '',     -- prefix; {{policy_no}} {{yy}} {{yyyy}} are filled in
  starting_from       int not null default 1 check (starting_from >= 0),
  current_next_number int not null default 1 check (current_next_number >= 0),
  zero_padding        int not null default 0 check (zero_padding between 0 and 10),
  suffix              text not null default '',
  allow_manual        boolean not null default true,
  active              boolean not null default true,
  updated_at          timestamptz not null default now()
);
create unique index if not exists cert_matrix_year_uq on public.certificate_numbering_matrices(policy_year_id) where active;

alter table public.certificates add column if not exists policy_year_id bigint references public.policy_years(id) on delete set null;
alter table public.certificates add column if not exists matrix_id      bigint references public.certificate_numbering_matrices(id) on delete set null;
alter table public.certificates add column if not exists numbering_mode text not null default 'legacy';
alter table public.certificates drop constraint if exists certificates_numbering_mode_check;
alter table public.certificates add constraint certificates_numbering_mode_check check (numbering_mode in ('legacy','matrix','manual'));

-- the policy year that covers a date; null when there is none
create or replace function public.policy_year_covering(p_policy bigint, p_date date) returns bigint
language sql stable security definer set search_path = public as $$
  select id from public.policy_years
   where policy_id = p_policy and status in ('active','extended') and p_date between starts_on and coalesce(extended_to, ends_on)
   order by starts_on desc limit 1
$$;
grant execute on function public.policy_year_covering(bigint, date) to authenticated;

-- hard expiry lock: a case under a policy needs a policy year covering the shipment (or today)
create or replace function public.policy_period_check(p_indication bigint, p_date date default null) returns bigint
language plpgsql stable security definer set search_path = public as $$
declare i public.indications; po public.policies; d date; y bigint;
begin
  select * into i from public.indications where id = p_indication;
  if not found or i.policy_id is null or coalesce(i.is_standalone_one_off, false) then return null; end if;
  select * into po from public.policies where id = i.policy_id;
  if not found then return null; end if;
  d := coalesce(p_date, i.departure_date, current_date);
  y := public.policy_year_covering(po.id, d);
  if y is null then
    raise exception 'Policy % has no active or extended policy year covering %. Extend the policy year or add a new policy year first (Customers, policy, Policy years).',
      coalesce(po.policy_no, po.name), to_char(d, 'DD.MM.YYYY');
  end if;
  return y;
end $$;
grant execute on function public.policy_period_check(bigint, date) to authenticated;

create or replace function public.cert_format(m public.certificate_numbering_matrices, n int) returns text
language sql stable security definer set search_path = public as $$
  select replace(replace(replace(m.naming_pattern, '{{policy_no}}', coalesce(po.policy_no, '')), '{{yyyy}}', to_char(y.starts_on, 'YYYY')), '{{yy}}', to_char(y.starts_on, 'YY'))
         || case when m.zero_padding > 0 then lpad(n::text, greatest(m.zero_padding, length(n::text)), '0') else n::text end
         || coalesce(m.suffix, '')
    from public.policy_years y join public.policies po on po.id = y.policy_id where y.id = m.policy_year_id
$$;
create or replace function public.cert_matrix_preview(p_matrix bigint) returns text
language sql stable security definer set search_path = public as $$
  select public.cert_format(m, m.current_next_number) from public.certificate_numbering_matrices m where m.id = p_matrix and public.is_admin()
$$;
grant execute on function public.cert_matrix_preview(bigint) to authenticated;

-- next number of a policy year's matrix (skips numbers already used); null = no active matrix
create or replace function public.take_cert_number(p_year bigint, out number text, out matrix_id bigint)
language plpgsql security definer set search_path = public as $$
declare m public.certificate_numbering_matrices; n int;
begin
  select * into m from public.certificate_numbering_matrices where policy_year_id = p_year and active for update;
  if not found then return; end if;
  n := greatest(m.current_next_number, m.starting_from);
  loop
    number := public.cert_format(m, n);
    exit when not exists (select 1 from public.certificates c where c.number = take_cert_number.number);
    n := n + 1;
  end loop;
  update public.certificate_numbering_matrices set current_next_number = n + 1, updated_at = now() where id = m.id;
  matrix_id := m.id;
end $$;
revoke execute on function public.take_cert_number(bigint) from public, anon, authenticated;

-- legacy numbering (cases without a matrix): 1, 2, 3 ... over the plain numbers
create or replace function public.next_plain_cert_number() returns text
language sql security definer set search_path = public as $$
  select (coalesce(max(number::bigint), 0) + 1)::text from public.certificates where number ~ '^\d{1,15}$'
$$;
revoke execute on function public.next_plain_cert_number() from public, anon, authenticated;

-- every certificate: expiry lock and the policy year it belongs to
create or replace function public.certificates_period() returns trigger
language plpgsql security definer set search_path = public as $$
declare i public.indications;
begin
  select * into i from public.indications where id = new.indication_id;
  new.policy_year_id := coalesce(new.policy_year_id, public.policy_period_check(new.indication_id, coalesce(i.departure_date, current_date)));
  return new;
end $$;
drop trigger if exists certificates_period on public.certificates;
create trigger certificates_period before insert on public.certificates for each row execute function public.certificates_period();

-- staff: issue a certificate (number from the policy year's matrix, or a manual number)
create or replace function public.admin_issue_certificate(p_indication bigint, p_quotation bigint, p_data jsonb, p_number text default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare i public.indications; y bigint; m public.certificate_numbering_matrices; t record; cno text; mode text; mid bigint; cid bigint;
begin
  if not public.has_role('placing') then raise exception 'not authorised'; end if;
  select * into i from public.indications where id = p_indication;
  if not found then raise exception 'case not found'; end if;
  y := public.policy_period_check(i.id, coalesce(i.departure_date, current_date));
  perform pg_advisory_xact_lock(4711);
  if y is not null then select * into m from public.certificate_numbering_matrices where policy_year_id = y and active; end if;
  if nullif(trim(coalesce(p_number, '')), '') is not null then
    if m.id is not null and not m.allow_manual then raise exception 'Manual certificate numbers are switched off for the matrix "%".', m.matrix_name; end if;
    cno := trim(p_number); mode := 'manual';
    if exists (select 1 from public.certificates where number = cno) then raise exception 'Certificate no. % is already used.', cno; end if;
  elsif m.id is not null then
    select * into t from public.take_cert_number(y); cno := t.number; mid := t.matrix_id; mode := 'matrix';
  else
    cno := public.next_plain_cert_number(); mode := 'legacy';
  end if;
  insert into public.certificates(indication_id, quotation_id, number, data, created_by, policy_year_id, matrix_id, numbering_mode)
  values (i.id, p_quotation, cno, coalesce(p_data, '{}'::jsonb) || jsonb_build_object('no', cno), auth.uid(), y, mid, mode)
  returning id into cid;
  update public.indications set stage = 'certificate' where id = i.id and stage <> 'certificate';
  return jsonb_build_object('id', cid, 'number', cno, 'mode', mode);
end $$;
grant execute on function public.admin_issue_certificate(bigint, bigint, jsonb, text) to authenticated;

-- next number preview for a case (staff dialog)
create or replace function public.admin_cert_number_preview(p_indication bigint) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare i public.indications; y bigint; m public.certificate_numbering_matrices; n int; v text;
begin
  if not public.is_admin() then raise exception 'not authorised'; end if;
  select * into i from public.indications where id = p_indication;
  begin
    y := public.policy_period_check(i.id, coalesce(i.departure_date, current_date));
  exception when others then
    return jsonb_build_object('blocked', true, 'message', sqlerrm);
  end;
  if y is not null then select * into m from public.certificate_numbering_matrices where policy_year_id = y and active; end if;
  if m.id is null then return jsonb_build_object('mode', 'legacy', 'number', public.next_plain_cert_number(), 'policy_year_id', y); end if;
  n := greatest(m.current_next_number, m.starting_from);
  loop v := public.cert_format(m, n); exit when not exists (select 1 from public.certificates where number = v); n := n + 1; end loop;
  return jsonb_build_object('mode', 'matrix', 'number', v, 'matrix', m.matrix_name, 'allow_manual', m.allow_manual, 'policy_year_id', y);
end $$;
grant execute on function public.admin_cert_number_preview(bigint) to authenticated;

-- ---------------------------------------------------------------------
-- 7  German insurance premium tax
-- ---------------------------------------------------------------------
create table if not exists public.german_ipt_settings (
  id             int primary key default 1 check (id = 1),
  default_rate   numeric(5,2) not null default 19 check (default_rate between 0 and 100),
  default_mode   text not null default 'auto' check (default_mode in ('on','auto','off')),
  rule_holder_de  boolean not null default true,   -- policyholder (client) located in Germany
  rule_assured_de boolean not null default true,   -- assured (holder of the policy / party) located in Germany
  rule_domestic   boolean not null default true,   -- transport within Germany
  rule_from_de    boolean not null default false,  -- transport starting in Germany
  rule_to_de      boolean not null default false,  -- transport heading to Germany
  combine        text not null default 'domicile_and_route' check (combine in ('domicile_and_route','any')),
  updated_by     uuid,
  updated_at     timestamptz not null default now()
);
insert into public.german_ipt_settings(id, default_rate)
  values (1, coalesce((select (value #>> '{}')::numeric from public.settings where key = 'insurance_tax_pct'), 19))
on conflict (id) do nothing;

alter table public.customers   add column if not exists ipt_mode text;
alter table public.policies    add column if not exists ipt_mode text;
alter table public.indications add column if not exists ipt_mode text;
alter table public.customers   add column if not exists country text;                -- domicile of the policyholder
alter table public.policies    add column if not exists policyholder_country text;
alter table public.customers   drop constraint if exists customers_ipt_mode_check;
alter table public.customers   add constraint customers_ipt_mode_check check (ipt_mode is null or ipt_mode in ('on','auto','off'));
alter table public.policies    drop constraint if exists policies_ipt_mode_check;
alter table public.policies    add constraint policies_ipt_mode_check check (ipt_mode is null or ipt_mode in ('on','auto','off'));
alter table public.indications drop constraint if exists indications_ipt_mode_check;
alter table public.indications add constraint indications_ipt_mode_check check (ipt_mode is null or ipt_mode in ('on','auto','off'));
alter table public.indications add column if not exists ipt_applied boolean not null default false;
alter table public.indications add column if not exists ipt_rate    numeric(5,2);
alter table public.indications add column if not exists ipt_amount  numeric(14,2);
alter table public.indications add column if not exists ipt_reason  text;
alter table public.quotations  add column if not exists ipt_applied boolean not null default false;
alter table public.quotations  add column if not exists ipt_rate    numeric(5,2);
alter table public.quotations  add column if not exists ipt_amount  numeric(14,2);
alter table public.quotations  add column if not exists ipt_reason  text;

-- the rule engine: mode on / auto / off, route and domicile
create or replace function public.ipt_eval(p_mode text, p_from text, p_to text, p_holder text, p_assured text) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare s public.german_ipt_settings; m text; dom boolean; route boolean; ok boolean; why text[] := '{}'; r text;
begin
  select * into s from public.german_ipt_settings where id = 1;
  if not found then return jsonb_build_object('applied', false, 'rate', 19, 'mode', 'off', 'reason', 'German IPT not set up'); end if;
  r := rtrim(rtrim(s.default_rate::text, '0'), '.');
  m := coalesce(p_mode, s.default_mode);
  if m = 'off' then return jsonb_build_object('applied', false, 'rate', s.default_rate, 'mode', m, 'reason', 'German IPT turned off'); end if;
  if m = 'on' then return jsonb_build_object('applied', true, 'rate', s.default_rate, 'mode', m, 'reason', 'German IPT ' || r || '% applied: set to apply by default'); end if;
  p_from := upper(coalesce(p_from, '')); p_to := upper(coalesce(p_to, '')); p_holder := upper(coalesce(p_holder, '')); p_assured := upper(coalesce(p_assured, ''));
  if s.rule_holder_de and p_holder = 'DE' then why := array_append(why, 'German Policyholder'); end if;
  if s.rule_assured_de and p_assured = 'DE' then why := array_append(why, 'German Assured'); end if;
  dom := cardinality(why) > 0 or not (s.rule_holder_de or s.rule_assured_de);
  route := false;
  if s.rule_domestic and p_from = 'DE' and p_to = 'DE' then why := array_append(why, 'Domestic German transport'); route := true;
  else
    if s.rule_from_de and p_from = 'DE' then why := array_append(why, 'Route from Germany'); route := true; end if;
    if s.rule_to_de and p_to = 'DE' then why := array_append(why, 'Route to Germany'); route := true; end if;
  end if;
  if not (s.rule_domestic or s.rule_from_de or s.rule_to_de) then route := s.combine = 'domicile_and_route'; end if;
  ok := case when s.combine = 'any' then (cardinality(why) > 0) else dom and route end;
  return jsonb_build_object('applied', ok, 'rate', s.default_rate, 'mode', m,
    'reason', case when ok then 'German IPT ' || r || '% applied: ' || array_to_string(why, ' & ')
                   else 'No German IPT: ' || coalesce(nullif(array_to_string(why, ' & '), '') || ' only', 'no German policyholder, assured or route') end);
end $$;
grant execute on function public.ipt_eval(text, text, text, text, text) to authenticated;

-- the inputs of a case: mode indication -> policy -> client; domicile policy -> client -> office -> user
create or replace function public.ipt_for(i public.indications) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare pol public.policies; cu public.customers; ofc public.offices; pr public.profiles; holder text;
begin
  if i.policy_id is not null and not coalesce(i.is_standalone_one_off, false) then select * into pol from public.policies where id = i.policy_id; end if;
  if i.customer_id is not null then select * into cu from public.customers where id = i.customer_id; end if;
  if i.office_id is not null then select * into ofc from public.offices where id = i.office_id; end if;
  select * into pr from public.profiles where id = i.user_id;
  holder := coalesce(nullif(pol.policyholder_country, ''), nullif(cu.country, ''), nullif(ofc.country, ''), nullif(pr.country, ''));
  return public.ipt_eval(coalesce(i.ipt_mode, pol.ipt_mode, cu.ipt_mode), i.origin_country, i.dest_country, holder, coalesce(nullif(i.insured_country, ''), holder))
         || jsonb_build_object('holder_country', holder);
end $$;
grant execute on function public.ipt_for(public.indications) to authenticated;
create or replace function public.ipt_for_indication(p_indication bigint) returns jsonb
language sql stable security definer set search_path = public as $$
  select public.ipt_for(i) from public.indications i where i.id = p_indication and (public.is_admin() or i.user_id = auth.uid())
$$;
grant execute on function public.ipt_for_indication(bigint) to authenticated;

-- every indication carries its IPT result; a policy without a covering policy year is "on request"
create or replace function public.indication_rules() returns trigger
language plpgsql security definer set search_path = public as $$
declare e jsonb; po public.policies; d date;
begin
  if tg_op = 'INSERT' or new.premium is distinct from old.premium or new.origin_country is distinct from old.origin_country
     or new.dest_country is distinct from old.dest_country or new.insured_country is distinct from old.insured_country
     or new.ipt_mode is distinct from old.ipt_mode or new.policy_id is distinct from old.policy_id or new.customer_id is distinct from old.customer_id then
    e := public.ipt_for(new);
    new.ipt_applied := coalesce((e->>'applied')::boolean, false);
    new.ipt_rate := (e->>'rate')::numeric;
    new.ipt_reason := e->>'reason';
    new.ipt_amount := case when new.ipt_applied and new.premium is not null then round(new.premium * new.ipt_rate / 100, 2) end;
  end if;
  if tg_op = 'INSERT' and new.policy_id is not null and not coalesce(new.is_standalone_one_off, false) and new.status = 'quoted' then
    d := coalesce(new.departure_date, current_date);
    if public.policy_year_covering(new.policy_id, d) is null then
      select * into po from public.policies where id = new.policy_id;
      new.status := 'on_request';
      new.reasons := array_append(coalesce(new.reasons, '{}'), 'Policy ' || coalesce(po.policy_no, po.name, '') || ' has no active policy year covering ' || to_char(d, 'DD.MM.YYYY'));
    end if;
  end if;
  return new;
end $$;
drop trigger if exists indications_rules on public.indications;
create trigger indications_rules before insert or update on public.indications for each row execute function public.indication_rules();
update public.indications i set ipt_applied = coalesce((s.e->>'applied')::boolean, false), ipt_rate = (s.e->>'rate')::numeric, ipt_reason = s.e->>'reason',
       ipt_amount = case when (s.e->>'applied')::boolean and i.premium is not null then round(i.premium * (s.e->>'rate')::numeric / 100, 2) end
  from (select x.id, public.ipt_for(x) e from public.indications x where x.ipt_reason is null) s
 where s.id = i.id;

-- ---------------------------------------------------------------------
-- 3  quotations: saved / sent, send history
-- ---------------------------------------------------------------------
alter table public.quotations add column if not exists send_status  text not null default 'sent';
alter table public.quotations add column if not exists sent_at      timestamptz;
alter table public.quotations add column if not exists sent_by      uuid;
alter table public.quotations add column if not exists send_count   int not null default 0;
alter table public.quotations add column if not exists display_mode text;
alter table public.quotations drop constraint if exists quotations_send_status_check;
alter table public.quotations add constraint quotations_send_status_check check (send_status in ('saved','sent'));
alter table public.quotations drop constraint if exists quotations_display_mode_check;
alter table public.quotations add constraint quotations_display_mode_check check (display_mode is null or display_mode in ('rate_only','premium_only','both'));
update public.quotations set sent_at = created_at, sent_by = created_by, send_count = 1 where send_status = 'sent' and sent_at is null;

create table if not exists public.quotation_send_history (
  id               bigserial primary key,
  quotation_id     bigint not null references public.quotations(id) on delete cascade,
  indication_id    bigint not null references public.indications(id) on delete cascade,
  version          int not null,
  sent_at          timestamptz not null default now(),
  sent_by          uuid references public.profiles(id) on delete set null,
  sent_by_name     text,
  recipient_user   uuid references public.profiles(id) on delete set null,
  recipient_email  text,
  delivery_method  text not null check (delivery_method in ('portal_email','manual')),
  is_resend        boolean not null default false,
  note             text,
  version_snapshot jsonb not null
);
create index if not exists qsh_quotation_idx on public.quotation_send_history(quotation_id, sent_at);
create index if not exists qsh_indication_idx on public.quotation_send_history(indication_id, sent_at);
create or replace function public.send_history_immutable() returns trigger
language plpgsql as $$
begin
  raise exception 'The sending history cannot be changed.';
end $$;
drop trigger if exists quotation_send_history_immutable on public.quotation_send_history;
create trigger quotation_send_history_immutable before update on public.quotation_send_history for each row execute function public.send_history_immutable();
-- quotations sent before the log existed
insert into public.quotation_send_history(quotation_id, indication_id, version, sent_at, sent_by, sent_by_name, recipient_user, recipient_email, delivery_method, note, version_snapshot)
select q.id, q.indication_id, q.version, q.created_at, q.created_by, (select full_name from public.profiles where id = q.created_by), i.user_id,
       (select email from public.profiles where id = i.user_id), 'portal_email', 'Recorded from the quotation (sent before the log existed)',
       q.data || jsonb_build_object('valid_until', q.valid_until, 'version', q.version)
  from public.quotations q join public.indications i on i.id = q.indication_id
 where q.send_status = 'sent' and not exists (select 1 from public.quotation_send_history h where h.quotation_id = q.id);

-- clients only see quotations that were sent
drop policy if exists own_quotations on public.quotations;
create policy own_quotations on public.quotations for select to authenticated
  using (status <> 'superseded' and send_status = 'sent' and exists (select 1 from public.indications i where i.id = indication_id and i.user_id = auth.uid()));

create or replace function public.my_quotations() returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(x order by x->>'created_at' desc), '[]'::jsonb) from (
    select jsonb_build_object(
      'id', q.id, 'indication_id', i.id, 'ref', i.ref, 'version', q.version,
      'data', public.quote_redact(q.data, coalesce(q.display_mode, q.data->>'displayMode', public.display_mode_for(i.id))),
      'display_mode', coalesce(q.display_mode, q.data->>'displayMode', public.display_mode_for(i.id)),
      'valid_until', q.valid_until,
      'status', case when q.status = 'open' and q.valid_until < now() then 'expired' else q.status end,
      'response_note', q.response_note, 'responded_at', q.responded_at, 'created_at', coalesce(q.sent_at, q.created_at), 'seen_at', q.seen_at,
      'cover_note', (select jsonb_build_object('id', c.id, 'number', c.number, 'issued_at', c.issued_at, 'data', c.data)
                       from public.cover_notes c where c.indication_id = i.id order by c.issued_at desc limit 1)) x
      from public.quotations q join public.indications i on i.id = q.indication_id
     where i.user_id = auth.uid() and q.status <> 'superseded' and q.send_status = 'sent'
  ) s
$$;

create or replace function public.mark_quotations_seen() returns void
language sql security definer set search_path = public as $$
  update public.quotations q set seen_at = now()
    from public.indications i
   where i.id = q.indication_id and i.user_id = auth.uid() and q.seen_at is null and q.send_status = 'sent'
$$;

create or replace function public.my_pending_requests() returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(to_jsonb(i) order by i.quote_requested_at desc), '[]'::jsonb)
    from public.indications i
   where i.user_id = auth.uid() and i.quote_requested_at is not null and not i.hidden_by_user
     and i.stage <> 'closed'
     and not exists (select 1 from public.quotations q where q.indication_id = i.id and q.status <> 'superseded' and q.send_status = 'sent')
$$;

create or replace function public.respond_to_quotation(p_quotation_id bigint, p_accept boolean, p_note text) returns text
language plpgsql security definer set search_path = public as $$
declare q public.quotations; i public.indications; p public.profiles;
begin
  select q2.* into q from public.quotations q2 join public.indications i2 on i2.id = q2.indication_id
   where q2.id = p_quotation_id and i2.user_id = auth.uid() and q2.send_status = 'sent' for update of q2;
  if not found then raise exception 'not found'; end if;
  if q.status <> 'open' then raise exception 'quotation is no longer open'; end if;
  if q.valid_until < now() then raise exception 'quotation has expired'; end if;
  update public.quotations set status = case when p_accept then 'accepted' else 'declined' end,
         response_note = left(nullif(trim(p_note), ''), 1000), responded_at = now()
   where id = q.id;
  update public.indications set stage = case when p_accept then 'certificate' else 'closed' end,
         closure_reason = case when p_accept then null else 'not_taken_up' end
   where id = q.indication_id returning * into i;
  select * into p from public.profiles where id = auth.uid();
  perform public.emit('quotation_response', jsonb_build_object('quotation_id', q.id, 'indication_id', i.id, 'ref', i.ref,
    'accepted', p_accept, 'note', p_note, 'email', p.email, 'name', p.full_name, 'company', p.company,
    'total', q.data->'total', 'currency', q.data->>'currency'));
  return case when p_accept then 'accepted' else 'declined' end;
end $$;

-- send (or resend) one quotation: visible in the portal, e-mail unless dispatched manually, always logged
create or replace function public.quote_send(p_quotation bigint, p_method text, p_note text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare q public.quotations; i public.indications; p public.profiles; me public.profiles; v_resend boolean; v_at timestamptz := now();
begin
  if coalesce(p_method, '') not in ('portal_email','manual') then raise exception 'unknown delivery method'; end if;
  select * into q from public.quotations where id = p_quotation for update;
  if not found then raise exception 'quotation not found'; end if;
  if q.status <> 'open' then raise exception 'Only open quotations can be sent (this one is %).', q.status; end if;
  if q.valid_until < now() then raise exception 'The validity has expired. Edit the quotation and set a new date first.'; end if;
  perform public.policy_period_check(q.indication_id);
  select * into i from public.indications where id = q.indication_id;
  select * into p from public.profiles where id = i.user_id;
  select * into me from public.profiles where id = auth.uid();
  v_resend := q.send_status = 'sent';
  update public.quotations set status = 'superseded' where indication_id = q.indication_id and id <> q.id and status = 'open';
  update public.quotations set send_status = 'sent', sent_at = v_at, sent_by = auth.uid(), send_count = send_count + 1,
         seen_at = case when v_resend then seen_at end
   where id = q.id;
  update public.indications set stage = 'quotation' where id = i.id and stage in ('request','working_on_it','quotation');
  insert into public.quotation_send_history(quotation_id, indication_id, version, sent_at, sent_by, sent_by_name, recipient_user, recipient_email, delivery_method, is_resend, note, version_snapshot)
  values (q.id, q.indication_id, q.version, v_at, auth.uid(), me.full_name, i.user_id, p.email, p_method, v_resend, left(nullif(trim(coalesce(p_note, '')), ''), 500),
          q.data || jsonb_build_object('valid_until', q.valid_until, 'version', q.version, 'display_mode', q.display_mode));
  if p_method = 'portal_email' then
    perform public.emit('quotation_sent', jsonb_build_object('quotation_id', q.id, 'indication_id', i.id, 'ref', i.ref,
      'version', q.version, 'email', p.email, 'name', p.full_name, 'company', p.company, 'resend', v_resend,
      'display_mode', coalesce(q.display_mode, 'both'),
      'total', case when coalesce(q.display_mode, 'both') = 'rate_only' then null else q.data->'total' end,
      'currency', q.data->>'currency', 'valid_until', q.valid_until));
  end if;
  return jsonb_build_object('quotation_id', q.id, 'sent_at', v_at, 'resend', v_resend, 'method', p_method);
end $$;
revoke execute on function public.quote_send(bigint, text, text) from public, anon, authenticated;

-- save a quotation (draft, or saved and sent); p_quotation_id edits an unsent draft in place
drop function if exists public.admin_save_quotation(bigint, jsonb, timestamptz, jsonb);
create or replace function public.admin_save_quotation(p_indication_id bigint, p_data jsonb, p_valid_until timestamptz, p_internal jsonb default null,
                                                       p_send boolean default true, p_method text default 'portal_email', p_quotation_id bigint default null) returns bigint
language plpgsql security definer set search_path = public as $$
declare v_ver int; v_id bigint; i public.indications; q public.quotations; v_mode text; v_tax numeric;
begin
  if not public.has_role('placing') then raise exception 'not authorised'; end if;
  if p_valid_until <= now() then raise exception 'validity must be in the future'; end if;
  select * into i from public.indications where id = p_indication_id for update;
  if not found then raise exception 'not found'; end if;
  perform public.policy_period_check(i.id);
  if i.ref is null then
    i.ref := 'FRCN-' || to_char(now() at time zone 'Europe/Berlin', 'YYMM') || '-' ||
             lpad(public.next_counter('ind-' || to_char(now() at time zone 'Europe/Berlin', 'YYMM'))::text, 4, '0');
    update public.indications set ref = i.ref where id = i.id;
  end if;
  v_mode := nullif(p_data->>'displayMode', '');
  if v_mode is not null and v_mode not in ('rate_only','premium_only','both') then v_mode := null; end if;
  v_tax := coalesce((p_data->>'taxPct')::numeric, 0);
  if p_quotation_id is not null then
    select * into q from public.quotations where id = p_quotation_id and indication_id = i.id for update;
    if not found or q.status <> 'open' or q.send_status <> 'saved' then raise exception 'Only an open quotation that was not sent yet can be edited in place.'; end if;
    update public.quotations set data = p_data, valid_until = p_valid_until, display_mode = v_mode,
           ipt_applied = v_tax > 0, ipt_rate = nullif(v_tax, 0), ipt_amount = nullif((p_data->>'tax')::numeric, 0), ipt_reason = p_data->>'iptReason'
     where id = q.id;
    v_id := q.id;
    if p_internal is not null then delete from public.quotation_internal where quotation_id = v_id; end if;
  else
    update public.quotations set status = 'superseded' where indication_id = i.id and status = 'open' and (coalesce(p_send, true) or send_status = 'saved');
    select coalesce(max(version), 0) + 1 into v_ver from public.quotations where indication_id = i.id;
    insert into public.quotations(indication_id, version, data, valid_until, created_by, send_status, display_mode, ipt_applied, ipt_rate, ipt_amount, ipt_reason)
    values (i.id, v_ver, p_data, p_valid_until, auth.uid(), 'saved', v_mode, v_tax > 0, nullif(v_tax, 0), nullif((p_data->>'tax')::numeric, 0), p_data->>'iptReason')
    returning id into v_id;
  end if;
  if p_internal is not null then
    insert into public.quotation_internal(quotation_id, insurer_id, insurer_name, brokerage_pct, brokerage_amount, net_to_insurer, currency, client_rebate_pct, client_rebate_amount)
    values (v_id, nullif(p_internal->>'insurer_id', '')::bigint, p_internal->>'insurer_name',
            coalesce((p_internal->>'brokerage_pct')::numeric, 0), coalesce((p_internal->>'brokerage_amount')::numeric, 0),
            (p_internal->>'net_to_insurer')::numeric, p_data->>'currency',
            coalesce((p_internal->>'client_rebate_pct')::numeric, 0), coalesce((p_internal->>'client_rebate_amount')::numeric, 0));
  end if;
  update public.indications set stage = 'quotation' where id = i.id and stage in ('request','working_on_it','quotation');
  if coalesce(p_send, true) then perform public.quote_send(v_id, coalesce(p_method, 'portal_email'), null); end if;
  return v_id;
end $$;
grant execute on function public.admin_save_quotation(bigint, jsonb, timestamptz, jsonb, boolean, text, bigint) to authenticated;

create or replace function public.admin_send_quotation(p_quotation_id bigint, p_method text default 'portal_email', p_note text default null) returns jsonb
language plpgsql security definer set search_path = public as $$
begin
  if not public.has_role('placing') then raise exception 'not authorised'; end if;
  return public.quote_send(p_quotation_id, p_method, p_note);
end $$;
grant execute on function public.admin_send_quotation(bigint, text, text) to authenticated;

-- ---------------------------------------------------------------------
-- client certificates: same expiry lock, numbers from the policy year's matrix
-- ---------------------------------------------------------------------
create or replace function public.client_issue_certificate(p_indication bigint, p_shipment jsonb, p_cert jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare me public.profiles; f jsonb := public.my_features(); r public.indications; res jsonb; cno text; q public.quotations; d jsonb; v_st text; v_rs text[];
        y bigint; t record; mid bigint; mode text := 'legacy';
begin
  select * into me from public.profiles where id = auth.uid();
  if not found or not public.is_approved() then raise exception 'not authorised'; end if;
  if not coalesce((f->>'fdf_certificate')::boolean, false) then raise exception 'certificates are not enabled for your account'; end if;
  if p_indication is null then
    if not coalesce((f->>'direct_certificate')::boolean, false) then raise exception 'direct certificates are not enabled for your account'; end if;
    res := public.calc_indication(p_shipment);
    select * into r from public.indications where id = (res->>'id')::bigint;
    select coalesce(ii.status, r.status), coalesce(ii.reasons, r.reasons) into v_st, v_rs from public.indications x left join public.indication_internal ii on ii.indication_id = x.id where x.id = r.id;
    if r.is_out_of_cover or v_st <> 'quoted' or r.status = 'on_request' and r.reasons::text like '%policy year%' then
      raise exception 'This shipment cannot be certified directly: %. Please send it as a request.', coalesce(nullif(array_to_string(coalesce(v_rs, '{}') || coalesce(r.reasons, '{}'), '; '), ''), case when r.is_out_of_cover then 'outside your open cover' else 'no automatic rate' end);
    end if;
    if r.ref is null then r.ref := public.assign_ref(r.id); end if;
    update public.indications set is_direct_certificate = true, stage = 'certificate', quote_requested_at = coalesce(quote_requested_at, now()) where id = r.id;
  else
    select * into r from public.indications where id = p_indication and user_id = me.id;
    if not found then raise exception 'not found'; end if;
    select * into q from public.quotations where indication_id = r.id and status = 'accepted' order by version desc limit 1;
    if q.id is null then raise exception 'accept the quotation first'; end if;
  end if;
  y := public.policy_period_check(r.id, coalesce(r.departure_date, current_date));
  perform pg_advisory_xact_lock(4711);
  if y is not null then select * into t from public.take_cert_number(y); cno := t.number; mid := t.matrix_id; if cno is not null then mode := 'matrix'; end if; end if;
  if cno is null then cno := public.next_plain_cert_number(); end if;
  d := coalesce(p_cert, '{}'::jsonb) || jsonb_build_object('no', cno, 'issued_by_client', true);
  insert into public.certificates(indication_id, quotation_id, number, data, created_by, policy_year_id, matrix_id, numbering_mode) values (r.id, q.id, cno, d, me.id, y, mid, mode);
  perform public.emit('certificate_issued', jsonb_build_object('indication_id', r.id, 'ref', coalesce(r.ref, public.assign_ref(r.id)), 'number', cno, 'email', me.email, 'name', me.full_name,
    'company', r.company, 'direct', p_indication is null, 'sum_insured', r.sum_insured, 'currency', r.currency));
  return jsonb_build_object('number', cno, 'indication_id', r.id, 'ref', coalesce(r.ref, (select ref from public.indications where id = r.id)), 'sum_insured', r.sum_insured, 'currency', r.currency,
    'uplift_pct', r.uplift_pct, 'incoterm', r.incoterm, 'conveyance', r.conveyance, 'vessel', r.vessel, 'goods', r.goods_description,
    'from', concat_ws(', ', r.origin_place, (select name from public.countries where iso2 = r.origin_country)), 'to', concat_ws(', ', r.dest_place, (select name from public.countries where iso2 = r.dest_country)),
    'conditions', r.conditions, 'holder', coalesce((select cert_holder from public.customers where id = r.customer_id), r.insured_name, r.company),
    'pol_no', coalesce((select cert_open_policy from public.customers where id = r.customer_id), public.setting('certificate_form')->>'open_policy'),
    'claims', coalesce((select cert_claims_contact from public.customers where id = r.customer_id), public.setting('certificate_form')->>'claims_contact', 'www.vht-network.de'),
    'agreements', (select t2.body from public.text_templates t2 where t2.kind = 'certificate_agreements' and t2.active and
                     ((t2.scope_type = 'policy' and t2.scope_id = r.policy_id) or (t2.scope_type = 'customer' and t2.scope_id = r.customer_id) or t2.scope_type = 'one_off_general')
                   order by case t2.scope_type when 'policy' then 1 when 'customer' then 2 else 3 end limit 1));
end $$;
grant execute on function public.client_issue_certificate(bigint, jsonb, jsonb) to authenticated;

-- ---------------------------------------------------------------------
-- access to the new tables
-- ---------------------------------------------------------------------
do $$
declare t text; r text;
begin
  foreach t in array array['clause_categories','text_templates','text_formatting','german_ipt_settings','policy_years','certificate_numbering_matrices']
  loop
    r := case when t in ('policy_years','certificate_numbering_matrices') then 'placing' else 'admin' end;
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists staff_read on public.%I', t);
    execute format('drop policy if exists role_write on public.%I', t);
    execute format('create policy staff_read on public.%I for select to authenticated using (public.is_admin())', t);
    execute format('create policy role_write on public.%I for all to authenticated using (public.has_role(%L)) with check (public.has_role(%L))', t, r, r);
  end loop;
  alter table public.quotation_send_history enable row level security;
  drop policy if exists staff_read on public.quotation_send_history;
  create policy staff_read on public.quotation_send_history for select to authenticated using (public.is_admin());
  -- no dashes in anything typed into the new tables
  foreach t in array array['clause_categories','text_templates','text_formatting','policy_years','certificate_numbering_matrices','quotation_send_history']
  loop
    execute format('drop trigger if exists %I on public.%I', t || '_no_dashes', t);
    execute format('create trigger %I before insert or update on public.%I for each row execute function public.no_dashes()', t || '_no_dashes', t);
  end loop;
end $$;

-- ---------------------------------------------------------------------
-- 5 + 8  older functions: new stage names, and no em / en dashes in any message
-- ---------------------------------------------------------------------
do $$
declare f record; d text;
begin
  for f in select p.oid from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'public' and p.prokind = 'f'
              and (position(U&'\2014' in p.prosrc) > 0 or position(U&'\2013' in p.prosrc) > 0
                   or p.prosrc like '%stage in (''new'',''in_progress'')%' or p.prosrc like '%stage not in (''accepted'',''bound'')%'
                   or p.prosrc like '%stage not in (''lost'',''closed'')%')
  loop
    d := pg_get_functiondef(f.oid);
    d := replace(replace(d, U&'\2014', '-'), U&'\2013', '-');
    d := replace(d, $x$stage in ('new','in_progress')$x$, $x$stage in ('request','working_on_it')$x$);
    d := replace(d, $x$stage not in ('accepted','bound')$x$, $x$stage <> 'certificate'$x$);
    d := replace(d, $x$stage not in ('lost','closed')$x$, $x$stage <> 'closed'$x$);
    execute d;
  end loop;
end $$;

-- the client history carries the IPT result too
do $$
declare d text;
begin
  select pg_get_functiondef('public.my_history(int)'::regprocedure) into d;
  if position('i.ipt_applied' in d) = 0 then
    d := replace(d, 'i.war_excluded, i.is_out_of_cover', 'i.war_excluded, i.is_out_of_cover, i.ipt_applied, i.ipt_rate, i.ipt_amount, i.ipt_reason, i.party_role_other');
    execute d;
  end if;
end $$;

notify pgrst, 'reload schema';
