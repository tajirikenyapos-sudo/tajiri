-- Switch shop and staff accounts from email authentication to phone authentication.
-- Apply after supabase-schema.sql and supabase-saas-migration.sql.

begin;

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
  phone_confirmed_at timestamptz;
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

  select auth_user.phone, auth_user.phone_confirmed_at
    into current_phone, phone_confirmed_at
    from auth.users as auth_user
   where auth_user.id = current_uid;
  if current_phone is null then
    raise exception 'A signed-in phone account is required to create a shop.';
  end if;
  if phone_confirmed_at is null then
    raise exception 'Verify your phone before creating a shop.' using errcode = '42501';
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

create or replace function public.create_staff_profile(
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
    lower(trim(p_email)), p_phone, p_role
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

commit;
