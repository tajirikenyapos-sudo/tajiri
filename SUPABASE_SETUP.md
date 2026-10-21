# Supabase account setup

Tajiri POS uses Supabase Auth for phone/password sign-in. New shop owners verify
their phone once by SMS during signup; subsequent sign-ins require only the
phone number and password. Email addresses are stored as contact details;
passwords are managed by Supabase Auth and are not stored in POS profile records
or browser storage.

The browser uses `supabase-shim.js` to provide the compatibility interface
expected by the existing POS authentication code. The `create-staff` Edge
Function is required for admin-created accounts; it verifies the administrator,
creates the Auth account, and writes the profile through a restricted database
function.

## Configure a Supabase project

1. Create a Supabase project at [supabase.com](https://supabase.com).
2. In the Supabase SQL editor, run [`supabase-schema.sql`](./supabase-schema.sql)
   first, then run [`supabase-saas-migration.sql`](./supabase-saas-migration.sql),
   then [`supabase-phone-auth-migration.sql`](./supabase-phone-auth-migration.sql).
   These install tenant-isolated shop membership, POS data storage, and
   phone-based shop signup. Review the migration and back up production data
   before applying it.
3. In **Authentication → Providers → Phone**, enable phone sign-in and phone
   confirmation, and configure an SMS provider (such as Twilio, Vonage, or
   MessageBird). Without a configured provider, signup codes cannot be
   delivered. Configure Supabase SMS rate limits and CAPTCHA to control abuse
   and messaging costs. In **Authentication → Providers → Email**, email
   confirmation is not needed because email is only collected as a contact
   address. Do not disable password requirements or publish service-role
   credentials.
   Re-run `supabase-saas-migration.sql` and
   `supabase-phone-auth-migration.sql` after deploying this version so the
   database functions require a confirmed phone before creating a shop.
4. Copy the **Project URL** and **anon/public key** from **Settings → API**.
   Put these public client values in the Supabase configuration near the top of
   `index.html`:

   ```js
   window.TAJIRI_SUPABASE_CONFIG = {
     url: "https://YOUR-PROJECT.supabase.co",
     anonKey: "YOUR-ANON-PUBLIC-KEY",
   };
   ```

   Do not put the `service_role` key in `index.html` or any client-side file.
5. Install and authenticate the Supabase CLI, then link it to this project and
   deploy the staff function from the project directory after both SQL scripts
   have completed:

   ```text
   supabase login
   supabase link --project-ref YOUR_PROJECT_REF
   supabase functions deploy create-staff
   ```

   Supabase provides the function's `SUPABASE_URL`, `SUPABASE_ANON_KEY`, and
   `SUPABASE_SERVICE_ROLE_KEY` server-side environment variables. Never expose
   or copy the service-role key into the browser.
6. Open the Admin page and choose **Start free trial**. The owner signs up with
   a Kenyan phone number and contact email, enters the SMS code once, then
   signs in with the phone number and password. The database assigns the shop owner
   a 14-day trial and a KES 100 monthly plan record. Creating that record does
   not collect payment or enforce subscription expiry.
7. Use **Staff access** in the Admin workspace to create cashier and
   administrator accounts. The Edge Function creates phone/password accounts
   inside the administrator's shop; the administrator is responsible for
   entering each staff member's correct phone number. Row-level security limits
   profile reads and POS state to the signed-in user's shop.

If the Supabase values are not configured, the app can still use its existing
device-local account mode; that mode does not authenticate against Supabase or
synchronize accounts between devices.

Password reset still uses an SMS code to prove account ownership. Removing that
recovery check would let anyone who knows a phone number take over its account.

Tajiri POS is also available on phones through its responsive web interface.
Open the HTTPS site in a phone browser; on Android use the browser menu and
choose **Install app** or **Add to Home screen**, and on iPhone use Safari's
**Share → Add to Home Screen**. The app shell can open offline after it has
been loaded once online, but signing in and cloud sync require internet.

## Existing local accounts and POS data

Accounts created before cloud authentication exist only in that browser's
local storage. Their password hashes cannot be converted to Supabase passwords.
Accounts in the previous email-auth Supabase project are not copied to the new
phone-auth project. Create a phone/password shop account in the new project,
then recreate staff accounts from the Admin workspace and assign each a
password.

Cloud POS data is stored in a revision-checked JSON document per shop. A
stale-device write is rejected rather than overwriting a newer cloud revision;
the POS reports when a change remains only on the current device. This is an
initial cloud-sync layer, not transactional multi-register inventory
accounting. Do not use it for concurrent real-money tills until transactional
sales and stock updates are implemented and validated.

The current M-Pesa configuration is sandbox only. The trial and price records
are not a billing service, and subscriptions are not charged or gated. Live
launch requires a production-approved Daraja account, a secure server-side
subscription/payment workflow, subscription enforcement, and a public HTTPS
hosting environment. Never expose the local `server.js` payment API directly
to the internet.
