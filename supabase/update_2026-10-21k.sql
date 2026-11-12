-- =====================================================================
-- FREIGHTCON update 2026-10-21k — claims (Schadenmeldungen)
-- * claims, claim_events (timeline + messages), claim_files, claim_internal
-- * private storage bucket "claims": <user_id>/<claim_id>/<file>
-- * report_claim, add_claim_file, add_claim_message, my_claims (customer)
-- * admin_update_claim (internal: status, message to client, internal data)
-- * alerts: claim_reported, claim_message (to staff), claim_update (to client)
-- Run once after update j.
-- =====================================================================

create table if not exists public.claims (
  id               bigserial primary key,
  ref              text unique,
  user_id          uuid not null references public.profiles(id) on delete cascade,
  indication_id    bigint references public.indications(id) on delete set null,
  cover_note_id    bigint references public.cover_notes(id) on delete set null,
  cover_note_no    text,
  status           text not null default 'reported' check (status in ('reported','in_review','documents_requested','surveyor_appointed','with_insurer','settled','rejected','closed')),
  loss_type        text not null check (loss_type in ('damage','wet','theft','shortage','temperature','total_loss','other')),
  transit_stage    text check (transit_stage in ('loading','transit','transhipment','storage','delivery','unknown')),
  incident_date    date,
  discovered_date  date,
  place            text check (length(place) <= 200),
  description      text not null check (length(description) between 10 and 4000),
  estimated_amount numeric(14,2) check (estimated_amount is null or estimated_amount >= 0),
  currency         text check (currency in ('EUR','USD')),
  goods_location   text check (length(goods_location) <= 300),
  carrier_notified boolean not null default false,
  receipt_remarks  boolean not null default false,
  contact_name     text check (length(contact_name) <= 120),
  contact_phone    text check (length(contact_phone) <= 60),
  insurer_claim_no text,
  settled_amount   numeric(14,2),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
create index if not exists claims_user_idx on public.claims(user_id, created_at desc);
drop trigger if exists claims_touch on public.claims;
create trigger claims_touch before update on public.claims for each row execute function public.touch_updated_at();

create table if not exists public.claim_events (
  id          bigserial primary key,
  claim_id    bigint not null references public.claims(id) on delete cascade,
  author_role text not null check (author_role in ('client','staff','system')),
  author_name text,
  body        text check (length(body) <= 4000),
  status      text,
  created_at  timestamptz not null default now()
);
create index if not exists claim_events_idx on public.claim_events(claim_id, created_at);

create table if not exists public.claim_files (
  id          bigserial primary key,
  claim_id    bigint not null references public.claims(id) on delete cascade,
  user_id     uuid not null references public.profiles(id) on delete cascade,
  path        text not null unique,
  name        text not null check (length(name) <= 200),
  size        bigint,
  mime        text,
  uploaded_by text not null default 'client' check (uploaded_by in ('client','staff')),
  created_at  timestamptz not null default now()
);

-- internal only: reserve, handler, notes (customers can never read this table)
create table if not exists public.claim_internal (
  claim_id      bigint primary key references public.claims(id) on delete cascade,
  handler       text,
  reserve       numeric(14,2),
  insurer_id    bigint references public.insurers(id) on delete set null,
  surveyor      text,
  internal_note text check (length(internal_note) <= 4000),
  updated_at    timestamptz not null default now()
);

alter table public.claims         enable row level security;
alter table public.claim_events   enable row level security;
alter table public.claim_files    enable row level security;
alter table public.claim_internal enable row level security;
do $$
declare t text;
begin
  foreach t in array array['claims','claim_events','claim_files','claim_internal'] loop
    execute format('drop policy if exists admin_all on public.%I', t);
    execute format('create policy admin_all on public.%I for all to authenticated using (public.is_admin()) with check (public.is_admin())', t);
  end loop;
end $$;
drop policy if exists own_claims on public.claims;
create policy own_claims on public.claims for select to authenticated using (user_id = auth.uid());
drop policy if exists own_claim_events on public.claim_events;
create policy own_claim_events on public.claim_events for select to authenticated
  using (exists (select 1 from public.claims c where c.id = claim_id and c.user_id = auth.uid()));
drop policy if exists own_claim_files on public.claim_files;
create policy own_claim_files on public.claim_files for select to authenticated using (user_id = auth.uid());

-- storage bucket for photos and documents (private, max 20 MB per file)
do $$
begin
  if exists (select 1 from information_schema.tables where table_schema = 'storage' and table_name = 'buckets') then
    insert into storage.buckets(id, name, public, file_size_limit) values ('claims', 'claims', false, 20971520)
    on conflict (id) do update set file_size_limit = 20971520;
    execute 'drop policy if exists "claims admin" on storage.objects';
    execute $p$create policy "claims admin" on storage.objects for all to authenticated
             using (bucket_id = 'claims' and public.is_admin()) with check (bucket_id = 'claims' and public.is_admin())$p$;
    execute 'drop policy if exists "claims own read" on storage.objects';
    execute $p$create policy "claims own read" on storage.objects for select to authenticated
             using (bucket_id = 'claims' and (storage.foldername(name))[1] = auth.uid()::text)$p$;
    execute 'drop policy if exists "claims own upload" on storage.objects';
    execute $p$create policy "claims own upload" on storage.objects for insert to authenticated
             with check (bucket_id = 'claims' and (storage.foldername(name))[1] = auth.uid()::text)$p$;
  end if;
end $$;

-- ---------------------------------------------------------------------
-- customer: report a claim on one of the own covered / accepted shipments
-- ---------------------------------------------------------------------
create or replace function public.report_claim(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  prof public.profiles; i public.indications; cn public.cover_notes; c public.claims;
  v_type text := p->>'loss_type'; v_stage text := nullif(p->>'transit_stage', '');
  v_inc date := nullif(p->>'incident_date', '')::date; v_dis date := nullif(p->>'discovered_date', '')::date;
  v_year text := to_char(now() at time zone 'Europe/Berlin', 'YYYY');
begin
  select * into prof from public.profiles where id = auth.uid();
  if not found or not prof.approved or prof.rejected then raise exception 'not authorised'; end if;
  select * into i from public.indications where id = (p->>'indication_id')::bigint and user_id = auth.uid();
  if not found then raise exception 'shipment not found'; end if;
  select * into cn from public.cover_notes where indication_id = i.id order by issued_at desc limit 1;
  if cn.id is null and i.stage not in ('accepted','bound') then raise exception 'this shipment is not covered'; end if;
  if v_type is null or v_type not in ('damage','wet','theft','shortage','temperature','total_loss','other') then raise exception 'choose what happened'; end if;
  if length(trim(coalesce(p->>'description', ''))) < 10 then raise exception 'please describe what happened'; end if;
  if v_inc is not null and v_inc > current_date + 1 then raise exception 'the date of the incident lies in the future'; end if;
  if v_dis is not null and v_dis > current_date + 1 then raise exception 'the date of discovery lies in the future'; end if;

  insert into public.claims(ref, user_id, indication_id, cover_note_id, cover_note_no, loss_type, transit_stage, incident_date, discovered_date, place,
                            description, estimated_amount, currency, goods_location, carrier_notified, receipt_remarks, contact_name, contact_phone)
  values ('FRCN-CL-' || v_year || '-' || lpad(public.next_counter('cl-' || v_year)::text, 4, '0'), prof.id, i.id, cn.id, cn.number, v_type,
          case when v_stage in ('loading','transit','transhipment','storage','delivery','unknown') then v_stage end, v_inc, v_dis,
          left(nullif(trim(p->>'place'), ''), 200), left(trim(p->>'description'), 4000),
          nullif(p->>'estimated_amount', '')::numeric, coalesce(nullif(p->>'currency', ''), i.currency),
          left(nullif(trim(p->>'goods_location'), ''), 300), coalesce((p->>'carrier_notified')::boolean, false), coalesce((p->>'receipt_remarks')::boolean, false),
          left(coalesce(nullif(trim(p->>'contact_name'), ''), prof.full_name), 120), left(coalesce(nullif(trim(p->>'contact_phone'), ''), prof.phone), 60))
  returning * into c;
  insert into public.claim_events(claim_id, author_role, author_name, body, status) values (c.id, 'system', null, 'Claim reported', 'reported');
  perform public.emit('claim_reported', jsonb_build_object('claim_id', c.id, 'ref', c.ref, 'shipment_ref', i.ref, 'cover_note', cn.number,
    'email', prof.email, 'name', prof.full_name, 'company', prof.company, 'loss_type', c.loss_type, 'place', c.place,
    'incident_date', c.incident_date, 'amount', c.estimated_amount, 'currency', c.currency, 'description', left(c.description, 600),
    'goods', i.goods_description, 'origin', i.origin_country, 'dest', i.dest_country, 'phone', c.contact_phone));
  return jsonb_build_object('id', c.id, 'ref', c.ref);
end $$;
grant execute on function public.report_claim(jsonb) to authenticated;

-- register an uploaded file (the file itself goes to storage first)
create or replace function public.add_claim_file(p_claim_id bigint, p_path text, p_name text, p_size bigint, p_mime text) returns bigint
language plpgsql security definer set search_path = public as $$
declare c public.claims; v_id bigint; v_admin boolean := public.is_admin();
begin
  select * into c from public.claims where id = p_claim_id;
  if not found or (c.user_id <> auth.uid() and not v_admin) then raise exception 'not found'; end if;
  if p_path not like c.user_id::text || '/' || c.id::text || '/%' then raise exception 'invalid file path'; end if;
  insert into public.claim_files(claim_id, user_id, path, name, size, mime, uploaded_by)
  values (c.id, c.user_id, p_path, left(coalesce(nullif(trim(p_name), ''), 'file'), 200), p_size, left(p_mime, 100), case when v_admin and c.user_id <> auth.uid() then 'staff' else 'client' end)
  returning id into v_id;
  return v_id;
end $$;
grant execute on function public.add_claim_file(bigint, text, text, bigint, text) to authenticated;

-- customer writes to us about the claim (optionally after uploading more files)
create or replace function public.add_claim_message(p_claim_id bigint, p_body text, p_files int default 0) returns boolean
language plpgsql security definer set search_path = public as $$
declare c public.claims; prof public.profiles;
begin
  select * into c from public.claims where id = p_claim_id and user_id = auth.uid();
  if not found then raise exception 'not found'; end if;
  select * into prof from public.profiles where id = auth.uid();
  if length(trim(coalesce(p_body, ''))) = 0 and coalesce(p_files, 0) = 0 then raise exception 'empty message'; end if;
  insert into public.claim_events(claim_id, author_role, author_name, body)
  values (c.id, 'client', prof.full_name, left(coalesce(nullif(trim(p_body), ''), p_files || ' file(s) added'), 4000));
  update public.claims set updated_at = now() where id = c.id;
  perform public.emit('claim_message', jsonb_build_object('claim_id', c.id, 'ref', c.ref, 'email', prof.email, 'name', prof.full_name,
    'company', prof.company, 'message', left(p_body, 600), 'files', p_files));
  return true;
end $$;
grant execute on function public.add_claim_message(bigint, text, int) to authenticated;

create or replace function public.my_claims() returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(x order by (x->>'created_at') desc), '[]'::jsonb) from (
    select to_jsonb(c) || jsonb_build_object(
      'shipment', (select jsonb_build_object('ref', i.ref, 'goods', i.goods_description, 'origin', i.origin_country, 'dest', i.dest_country,
                     'origin_place', i.origin_place, 'dest_place', i.dest_place, 'conveyance', i.conveyance, 'sum_insured', i.sum_insured, 'currency', i.currency)
                     from public.indications i where i.id = c.indication_id),
      'events', (select coalesce(jsonb_agg(to_jsonb(e) order by e.created_at), '[]'::jsonb) from public.claim_events e where e.claim_id = c.id),
      'files',  (select coalesce(jsonb_agg(jsonb_build_object('id', f.id, 'path', f.path, 'name', f.name, 'size', f.size, 'mime', f.mime, 'uploaded_by', f.uploaded_by, 'created_at', f.created_at) order by f.created_at), '[]'::jsonb)
                   from public.claim_files f where f.claim_id = c.id)) x
      from public.claims c where c.user_id = auth.uid()
  ) s
$$;
grant execute on function public.my_claims() to authenticated;

-- ---------------------------------------------------------------------
-- internal: status, message to the client, internal data
-- ---------------------------------------------------------------------
create or replace function public.admin_update_claim(p_claim_id bigint, p_status text, p_message text, p_data jsonb default '{}'::jsonb) returns boolean
language plpgsql security definer set search_path = public as $$
declare c public.claims; prof public.profiles; me public.profiles; v_changed boolean;
begin
  if not public.is_admin() then raise exception 'not authorised'; end if;
  select * into c from public.claims where id = p_claim_id for update;
  if not found then raise exception 'not found'; end if;
  select * into me from public.profiles where id = auth.uid();
  v_changed := p_status is not null and p_status <> c.status;
  if v_changed and p_status not in ('reported','in_review','documents_requested','surveyor_appointed','with_insurer','settled','rejected','closed') then raise exception 'invalid status'; end if;
  update public.claims set status = coalesce(p_status, status),
         insurer_claim_no = case when p_data ? 'insurer_claim_no' then nullif(trim(p_data->>'insurer_claim_no'), '') else insurer_claim_no end,
         settled_amount   = case when p_data ? 'settled_amount' then nullif(p_data->>'settled_amount', '')::numeric else settled_amount end
   where id = c.id;
  if p_data ? 'internal' then
    insert into public.claim_internal(claim_id, handler, reserve, insurer_id, surveyor, internal_note, updated_at)
    values (c.id, p_data#>>'{internal,handler}', nullif(p_data#>>'{internal,reserve}', '')::numeric, nullif(p_data#>>'{internal,insurer_id}', '')::bigint,
            p_data#>>'{internal,surveyor}', p_data#>>'{internal,internal_note}', now())
    on conflict (claim_id) do update set handler = excluded.handler, reserve = excluded.reserve, insurer_id = excluded.insurer_id,
            surveyor = excluded.surveyor, internal_note = excluded.internal_note, updated_at = now();
  end if;
  if v_changed or length(trim(coalesce(p_message, ''))) > 0 then
    insert into public.claim_events(claim_id, author_role, author_name, body, status)
    values (c.id, 'staff', coalesce(me.full_name, 'FREIGHTCON'), nullif(trim(p_message), ''), case when v_changed then p_status end);
    select * into prof from public.profiles where id = c.user_id;
    perform public.emit('claim_update', jsonb_build_object('claim_id', c.id, 'ref', c.ref, 'email', prof.email, 'name', prof.full_name,
      'company', prof.company, 'status', case when v_changed then p_status end, 'message', left(p_message, 1500)));
  end if;
  return true;
end $$;
grant execute on function public.admin_update_claim(bigint, text, text, jsonb) to authenticated;

notify pgrst, 'reload schema';
