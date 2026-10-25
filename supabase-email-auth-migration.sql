-- Switch shop signup and staff profiles from phone auth to email/password.
-- Apply after supabase-saas-migration.sql.

begin;

create or replace function public.create_shop_for_current_user(
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
  current_email text;
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

  select auth_user.email
    into current_email
    from auth.users as auth_user
   where auth_user.id = current_uid;
  if current_email is null then
    raise exception 'A signed-in email account is required to create a shop.';
  end if;

  if length(trim(coalesce(p_shop_name, ''))) not between 2 and 100
     or length(trim(coalesce(p_name, ''))) not between 2 and 100
     or coalesce(p_username, '') !~ '^[a-z0-9._-]{2,60}$'
     or coalesce(p_email, '') !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
     or lower(trim(p_email)) <> lower(current_email) then
    raise exception 'Enter a valid shop name, full name, username, and account email.';
  end if;

  select * into existing_profile
    from public.users
   where id = current_uid;
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
    p_username, lower(trim(current_email)), '', 'admin'
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
  admin_email text;
  staff_email text;
  profile_row public.users%rowtype;
begin
  if auth.role() <> 'service_role' then
    raise exception 'This operation must be performed by the trusted staff service.';
  end if;

  select auth_user.email
    into admin_email
    from public.users as profile
    join auth.users as auth_user on auth_user.id = profile.id
   where profile.id = p_admin_uid
     and profile.tenant_id = p_tenant_id
     and profile.role = 'admin'
     and lower(profile.email) = lower(auth_user.email);
  if admin_email is null then
    raise exception 'A shop administrator with an email account is required.';
  end if;

  select email into staff_email
    from auth.users
   where id = p_user_id;
  if staff_email is null or lower(staff_email) <> lower(coalesce(p_email, '')) then
    raise exception 'The Supabase Auth account does not match the staff email.';
  end if;

  if coalesce(trim(p_name), '') = ''
     or p_username !~ '^[a-z0-9._-]{2,60}$'
     or coalesce(p_email, '') !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
     or p_role not in ('admin', 'cashier') then
    raise exception 'Enter valid staff details, account email, and role.';
  end if;

  insert into public.users (id, key, tenant_id, name, username, email, phone, role)
  values (
    p_user_id, p_user_id::text, p_tenant_id, trim(p_name), p_username,
    lower(p_email), '', p_role
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

notify pgrst, 'reload schema';

commit;
