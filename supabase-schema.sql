-- Tajiri POS base Supabase schema. Run this before supabase-saas-migration.sql.
-- The SaaS migration replaces the legacy one-time admin bootstrap with shop signup.

create table if not exists public.users (
  id uuid primary key references auth.users (id) on delete cascade,
  key text unique,
  name text not null,
  username text not null unique,
  email text not null unique,
  phone text not null default '',
  role text not null check (role in ('admin', 'cashier')),
  created_at timestamptz not null default now()
);

create table if not exists public.system (
  key text primary key,
  value jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.users enable row level security;
alter table public.system enable row level security;

drop policy if exists "users read while signed in" on public.users;
create policy "users read while signed in" on public.users
  for select to authenticated using (true);

drop policy if exists "users update own profile" on public.users;
drop policy if exists "users insert own profile" on public.users;
drop policy if exists "users insert self" on public.users;
drop policy if exists "users update self" on public.users;

drop policy if exists "bootstrap readable by anyone" on public.system;
create policy "bootstrap readable by anyone" on public.system
  for select to anon, authenticated using (true);

drop policy if exists "bootstrap written via rpc only" on public.system;
create policy "bootstrap written via rpc only" on public.system
  for all to authenticated using (false) with check (false);

create or replace function public.bootstrap_first_admin(
  p_name text,
  p_username text,
  p_phone text default ''
)
returns integer
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  current_uid uuid := auth.uid();
  current_email text;
  bootstrap_value jsonb;
  current_admin_count integer;
begin
  if current_uid is null then
    raise exception 'Sign in to complete administrator setup.';
  end if;

  perform pg_advisory_xact_lock(8147235101);

  select email
    into current_email
    from auth.users
   where id = current_uid;

  if current_email is null then
    raise exception 'A signed-in account with an email address is required.';
  end if;

  if coalesce(trim(p_name), '') = ''
     or p_username !~ '^[a-z0-9._-]{2,60}$' then
    raise exception 'Enter a valid name and username.';
  end if;

  select value into bootstrap_value
    from public.system
   where key = 'bootstrap'
   for update;

  current_admin_count := coalesce(
    (bootstrap_value ->> 'adminCount')::integer,
    0
  );
  if current_admin_count >= 3 then
    raise exception 'The first three administrator accounts have already been created.';
  end if;

  insert into public.users (id, key, name, username, email, phone, role)
  values (current_uid, current_uid::text, trim(p_name), p_username,
          lower(current_email), coalesce(p_phone, ''), 'admin');

  if bootstrap_value is null then
    insert into public.system (key, value)
    values (
      'bootstrap',
      jsonb_build_object(
        'adminUid', current_uid,
        'adminCount', 1,
        'createdAt', now()
      )
    );
  else
    update public.system
       set value = bootstrap_value || jsonb_build_object(
         'adminCount', current_admin_count + 1,
         'lastAdminUid', current_uid
       ),
       updated_at = now()
     where key = 'bootstrap';
  end if;

  return 1;
end;
$$;

revoke all on function public.bootstrap_first_admin(text, text, text)
  from public, anon;
grant execute on function public.bootstrap_first_admin(text, text, text)
  to authenticated;

create or replace function public.create_staff_profile(
  p_admin_uid uuid,
  p_user_id uuid,
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
  admin_email text;
  staff_email text;
  bootstrap_value jsonb;
  current_count integer;
  profile_row public.users%rowtype;
begin
  if auth.role() <> 'service_role' then
    raise exception 'This operation must be performed by the trusted staff service.';
  end if;

  perform pg_advisory_xact_lock(8147235101);

  select u.email into admin_email
    from public.users p
    join auth.users u on u.id = p.id
   where p.id = p_admin_uid
     and p.role = 'admin';

  if admin_email is null then
    raise exception 'An authenticated administrator is required.';
  end if;

  select email into staff_email from auth.users where id = p_user_id;
  if staff_email is null or lower(staff_email) <> lower(p_email) then
    raise exception 'The Supabase Auth account does not match the staff email.';
  end if;

  if coalesce(trim(p_name), '') = ''
     or p_username !~ '^[a-z0-9._-]{2,60}$'
     or p_role not in ('admin', 'cashier') then
    raise exception 'Enter valid staff details and role.';
  end if;

  if p_role = 'admin' then
    select value into bootstrap_value
      from public.system
     where key = 'bootstrap'
     for update;
    if bootstrap_value is null then
      raise exception 'Administrator setup has not been completed.';
    end if;

    current_count := coalesce((bootstrap_value ->> 'adminCount')::integer, 1);
    if current_count >= 3 then
      raise exception 'The store already has the maximum of 3 administrators.';
    end if;

    update public.system
       set value = bootstrap_value || jsonb_build_object(
         'adminCount', current_count + 1,
         'lastAdminUid', p_user_id
       ),
       updated_at = now()
     where key = 'bootstrap';
  end if;

  insert into public.users (id, key, name, username, email, phone, role)
  values (p_user_id, p_user_id::text, trim(p_name), p_username,
          lower(p_email), coalesce(p_phone, ''), p_role)
  returning * into profile_row;

  return jsonb_build_object(
    'uid', profile_row.id,
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
  uuid, uuid, text, text, text, text, text
) from public, anon, authenticated;
grant execute on function public.create_staff_profile(
  uuid, uuid, text, text, text, text, text
) to service_role;

notify pgrst, 'reload schema';
