-- Tenant isolation for the hosted Tajiri POS SaaS.
-- Run after supabase-schema.sql in the Supabase SQL editor.

create table if not exists public.shops (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(trim(name)) between 2 and 100),
  owner_user_id uuid not null references auth.users (id) on delete restrict,
  trial_started_at timestamptz not null default now(),
  trial_ends_at timestamptz not null,
  monthly_price_kes integer not null default 100 check (monthly_price_kes > 0),
  currency text not null default 'KES' check (currency = 'KES'),
  subscription_status text not null default 'trial'
    check (subscription_status in ('trial', 'active', 'past_due', 'cancelled', 'legacy')),
  created_at timestamptz not null default now()
);

alter table public.users
  add column if not exists tenant_id uuid references public.shops (id) on delete cascade;

create index if not exists users_tenant_id_idx on public.users (tenant_id);

do $$
declare
  legacy_shop_id uuid;
  legacy_owner_id uuid;
begin
  if exists (select 1 from public.users where tenant_id is null) then
    select id into legacy_shop_id from public.shops where name = 'Existing Tajiri POS business' limit 1;
    if legacy_shop_id is null then
      select id into legacy_owner_id
        from public.users
       where role = 'admin'
       order by created_at, id
       limit 1;
      if legacy_owner_id is null then
        select id into legacy_owner_id from public.users order by created_at, id limit 1;
      end if;
      if legacy_owner_id is not null then
        insert into public.shops (
          name, owner_user_id, trial_started_at, trial_ends_at, subscription_status
        )
        values (
          'Existing Tajiri POS business', legacy_owner_id, now(), now(), 'legacy'
        )
        returning id into legacy_shop_id;
      end if;
    end if;
    if legacy_shop_id is not null then
      update public.users set tenant_id = legacy_shop_id where tenant_id is null;
    end if;
  end if;
end;
$$;

create or replace function public.current_tenant_id()
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select tenant_id from public.users where id = auth.uid()
$$;

create or replace function public.is_shop_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.users
     where id = auth.uid()
       and role = 'admin'
  )
$$;

revoke all on function public.current_tenant_id() from public, anon;
grant execute on function public.current_tenant_id() to authenticated, service_role;
revoke all on function public.is_shop_admin() from public, anon;
grant execute on function public.is_shop_admin() to authenticated, service_role;

create table if not exists public.shop_state (
  tenant_id uuid primary key references public.shops (id) on delete cascade,
  data jsonb not null default '{}'::jsonb check (jsonb_typeof(data) = 'object'),
  revision bigint not null default 0 check (revision >= 0),
  updated_by uuid references auth.users (id) on delete set null,
  updated_at timestamptz not null default now()
);

alter table public.shops enable row level security;
alter table public.shop_state enable row level security;

do $$
declare
  policy_row record;
begin
  for policy_row in
    select schemaname, tablename, policyname
      from pg_policies
     where schemaname = 'public'
       and tablename in ('users', 'shops', 'shop_state')
  loop
    execute format(
      'drop policy %I on %I.%I',
      policy_row.policyname,
      policy_row.schemaname,
      policy_row.tablename
    );
  end loop;
end;
$$;

create policy "shop members read their shop" on public.shops
  for select to authenticated
  using (id = public.current_tenant_id());

create policy "users read their shop" on public.users
  for select to authenticated
  using (tenant_id = public.current_tenant_id());

create policy "shop admins update profile fields" on public.users
  for update to authenticated
  using (
    tenant_id = public.current_tenant_id()
    and public.is_shop_admin()
  )
  with check (tenant_id = public.current_tenant_id());

create policy "shop state members read" on public.shop_state
  for select to authenticated
  using (tenant_id = public.current_tenant_id());

revoke all on public.shops, public.shop_state from anon, authenticated;
grant select on public.shops, public.shop_state to authenticated;
revoke all on public.users from anon, authenticated;
grant select on public.users to authenticated;
grant update (name, username, phone) on public.users to authenticated;

create or replace function public.save_shop_state(
  p_expected_revision bigint,
  p_data jsonb
)
returns bigint
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  current_uid uuid := auth.uid();
  current_tenant uuid := public.current_tenant_id();
  current_revision bigint;
  next_revision bigint;
begin
  if current_uid is null or current_tenant is null then
    raise exception 'A shop account is required.' using errcode = '42501';
  end if;
  if p_data is null or jsonb_typeof(p_data) <> 'object'
     or p_data ? 'users' then
    raise exception 'Shop data has an invalid shape.' using errcode = '22023';
  end if;
  if octet_length(p_data::text) > 5000000 then
    raise exception 'Shop data exceeds the 5 MB limit.' using errcode = '22023';
  end if;

  select revision into current_revision
    from public.shop_state
   where tenant_id = current_tenant
   for update;

  if current_revision is null then
    if p_expected_revision <> 0 then
      raise exception 'Shop data changed on another device. Reload before saving.'
        using errcode = '40001';
    end if;
    insert into public.shop_state (tenant_id, data, revision, updated_by)
    values (current_tenant, p_data, 1, current_uid)
    on conflict (tenant_id) do nothing
    returning revision into next_revision;
    if next_revision is null then
      raise exception 'Shop data changed on another device. Reload before saving.'
        using errcode = '40001';
    end if;
    return next_revision;
  end if;

  if current_revision <> p_expected_revision then
    raise exception 'Shop data changed on another device. Reload before saving.'
      using errcode = '40001';
  end if;

  next_revision := current_revision + 1;
  update public.shop_state
     set data = p_data,
         revision = next_revision,
         updated_by = current_uid,
         updated_at = now()
   where tenant_id = current_tenant;
  return next_revision;
end;
$$;

alter table public.users alter column tenant_id set not null;

do $$
declare
  username_constraint record;
begin
  for username_constraint in
    select conname
      from pg_constraint
     where conrelid = 'public.users'::regclass
       and contype = 'u'
       and pg_get_constraintdef(oid) = 'UNIQUE (username)'
  loop
    execute format(
      'alter table public.users drop constraint %I',
      username_constraint.conname
    );
  end loop;
end;
$$;

create unique index if not exists users_tenant_username_key
  on public.users (tenant_id, username);

revoke all on function public.save_shop_state(bigint, jsonb) from public, anon;
grant execute on function public.save_shop_state(bigint, jsonb) to authenticated;

drop function if exists public.create_shop_for_current_user(text, text, text, text);

create function public.create_shop_for_current_user(
  p_shop_name text,
  p_name text,
  p_username text,
  p_email text
)
returns jsonb
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  current_uid uuid := auth.uid();
  current_phone text;
  existing_profile public.users%rowtype;
  new_shop public.shops%rowtype;
  new_profile public.users%rowtype;
begin
  if current_uid is null then
    raise exception 'Sign in to create a shop.' using errcode = '42501';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended(current_uid::text, 8147235101)
  );

  select phone into current_phone
    from auth.users
   where id = current_uid;
  if current_phone is null then
    raise exception 'A signed-in phone account is required to create a shop.';
  end if;

  if length(trim(coalesce(p_shop_name, ''))) not between 2 and 100
     or length(trim(coalesce(p_name, ''))) not between 2 and 100
     or coalesce(p_username, '') !~ '^[a-z0-9._-]{2,60}$'
     or coalesce(p_email, '') !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' then
    raise exception 'Enter a valid shop name, full name, username, and contact email.';
  end if;

  select * into existing_profile from public.users where id = current_uid;
  if found then
    if existing_profile.tenant_id is null then
      raise exception 'This account is not assigned to a shop. Contact support.';
    end if;
    return jsonb_build_object(
      'uid', existing_profile.id,
      'tenant_id', existing_profile.tenant_id,
      'name', existing_profile.name,
      'username', existing_profile.username,
      'email', existing_profile.email,
      'phone', existing_profile.phone,
      'role', existing_profile.role,
      'createdAt', existing_profile.created_at
    );
  end if;

  insert into public.shops (
    name, owner_user_id, trial_started_at, trial_ends_at, monthly_price_kes
  )
  values (
    trim(p_shop_name), current_uid, now(), now() + interval '14 days', 100
  )
  returning * into new_shop;

  insert into public.users (id, key, tenant_id, name, username, email, phone, role)
  values (
    current_uid, current_uid::text, new_shop.id, trim(p_name),
    p_username, lower(trim(p_email)), current_phone, 'admin'
  )
  returning * into new_profile;

  return jsonb_build_object(
    'uid', new_profile.id,
    'tenant_id', new_profile.tenant_id,
    'shop_name', new_shop.name,
    'trial_ends_at', new_shop.trial_ends_at,
    'monthly_price_kes', new_shop.monthly_price_kes,
    'name', new_profile.name,
    'username', new_profile.username,
    'email', new_profile.email,
    'phone', new_profile.phone,
    'role', new_profile.role,
    'createdAt', new_profile.created_at
  );
end;
$$;

revoke all on function public.create_shop_for_current_user(text, text, text, text)
  from public, anon;
grant execute on function public.create_shop_for_current_user(text, text, text, text)
  to authenticated;

create or replace function public.bootstrap_first_admin(
  p_name text,
  p_username text,
  p_phone text default ''
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
begin
  raise exception 'Use the shop signup flow to create a shop administrator.';
end;
$$;

revoke all on function public.bootstrap_first_admin(text, text, text)
  from public, anon, authenticated;

drop function if exists public.create_staff_profile(
  uuid, uuid, text, text, text, text, text
);

create function public.create_staff_profile(
  p_admin_uid uuid,
  p_user_id uuid,
  p_tenant_id uuid,
  p_name text,
  p_username text,
  p_email text,
  p_phone text,
  p_role text
)
returns jsonb
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  admin_phone text;
  staff_phone text;
  profile_row public.users%rowtype;
begin
  if auth.role() <> 'service_role' then
    raise exception 'This operation must be performed by the trusted staff service.';
  end if;

  select u.phone into admin_phone
    from public.users p
    join auth.users u on u.id = p.id
   where p.id = p_admin_uid
     and p.tenant_id = p_tenant_id
     and p.role = 'admin';
  if admin_phone is null then
    raise exception 'A shop administrator with a phone account is required.';
  end if;

  select phone into staff_phone
    from auth.users
   where id = p_user_id;
  if staff_phone is null or staff_phone <> p_phone then
    raise exception 'The Supabase Auth account does not match the staff phone.';
  end if;

  if coalesce(trim(p_name), '') = ''
     or p_username !~ '^[a-z0-9._-]{2,60}$'
     or coalesce(p_email, '') !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
     or coalesce(p_phone, '') !~ '^\+[1-9][0-9]{7,14}$'
     or p_role not in ('admin', 'cashier') then
    raise exception 'Enter valid staff details, contact email, phone, and role.';
  end if;

  insert into public.users (id, key, tenant_id, name, username, email, phone, role)
  values (
    p_user_id, p_user_id::text, p_tenant_id, trim(p_name), p_username,
    lower(p_email), coalesce(p_phone, ''), p_role
  )
  returning * into profile_row;

  return jsonb_build_object(
    'uid', profile_row.id,
    'tenant_id', profile_row.tenant_id,
    'name', profile_row.name,
    'username', profile_row.username,
    'email', profile_row.email,
    'phone', profile_row.phone,
    'role', profile_row.role,
    'createdAt', profile_row.created_at
  );
end;
$$;

revoke all on function public.create_staff_profile(
  uuid, uuid, uuid, text, text, text, text, text
) from public, anon, authenticated;
grant execute on function public.create_staff_profile(
  uuid, uuid, uuid, text, text, text, text, text
) to service_role;

notify pgrst, 'reload schema';
