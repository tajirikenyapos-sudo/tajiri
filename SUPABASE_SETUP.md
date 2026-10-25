# Supabase account setup

Tajiri POS uses Supabase Auth email/password sign-in and requires shop owners
to confirm their email before their shop is created. Passwords are managed by
Supabase Auth and are not stored in POS profile records or browser storage.

The browser uses `supabase-shim.js` as a compatibility layer for Supabase Auth
and database operations. The `create-staff` Edge Function is required for
admin-created staff accounts. It verifies the administrator, creates a
staff login, and writes the profile through a restricted database function.

## Configure a Supabase project

1. Create a Supabase project at [supabase.com](https://supabase.com).
2. In the Supabase SQL editor, run [`supabase-schema.sql`](./supabase-schema.sql)
   first, then [`supabase-saas-migration.sql`](./supabase-saas-migration.sql),
   then [`supabase-email-auth-migration.sql`](./supabase-email-auth-migration.sql).
   The email migration replaces legacy phone-dependent signup and staff
   profile procedures. Do not apply `supabase-phone-auth-migration.sql` to a
   new project. Existing projects that already applied it should apply the
   email migration afterward.
3. In **Authentication → Providers → Email**, enable email/password sign-in
   and enable **Confirm email**. Shop owners receive a confirmation link;
   their shop is created after they open the link and return to the app. Set up
   custom SMTP so confirmation messages are delivered reliably. Configure
   Auth rate limits and CAPTCHA as appropriate. Do not enable phone sign-in
   for POS authentication.
4. In **Authentication → URL Configuration**, set the deployed POS URL as the
   Site URL and allow the app's exact confirmation redirect URLs (including
   the deployed `/index.html` and `/admin.html` routes, plus local development
   URLs if needed). Only allow domains you control.
5. Copy the **Project URL** and **publishable key** from **Settings → API**.
   Put these public client values in the Supabase configuration near the top of
   `index.html`:

   ```js
   window.TAJIRI_SUPABASE_CONFIG = {
     url: "https://YOUR-PROJECT.supabase.co",
     anonKey: "YOUR-ANON-PUBLIC-KEY",
   };
   ```

   Do not put the `service_role` key in `index.html` or any client-side file.
6. Install and authenticate the Supabase CLI, link the project, and deploy the
   staff function:

   ```text
   supabase login
   supabase link --project-ref YOUR_PROJECT_REF
   supabase functions deploy create-staff
   ```

   The function requires Supabase's server-side `SUPABASE_URL` and
   `SUPABASE_SERVICE_ROLE_KEY`. Never expose the service-role key to the
   browser.
7. Open the Admin page and choose **Start free trial**. The owner signs up,
   confirms their email, then returns to the app to finish setting up the
   shop. The database assigns the shop owner a 14-day trial and a KES 100
   monthly plan record. Creating that record does not collect payment or
   enforce subscription expiry.
8. Use **Staff access** in the Admin workspace to create cashier and
   administrator accounts. Set an initial password and share it securely;
   staff sign in immediately with their email and password. Up to three
   administrator accounts are allowed per shop. Row-level security limits
   profile reads and POS state to the signed-in user's shop.

Password recovery sends an email reset link. Opening the link lets the user
choose a new password. A device PIN, where configured, is only a convenience
unlock for the already authenticated account on that device; it is not a cloud
sign-in method and cannot replace email/password authentication.

If Supabase values are not configured, the app can use device-local accounts.
Those accounts do not authenticate against Supabase or synchronize between
devices.

Tajiri POS is also available on phones through its responsive web interface.
Open the HTTPS site in a phone browser; on Android use the browser menu and
choose **Install app** or **Add to Home screen**, and on iPhone use Safari's
**Share → Add to Home Screen**. The app shell can open offline after it has
been loaded once online, but signing in and cloud sync require internet.

## Existing local accounts and POS data

Accounts created before cloud authentication exist only in that browser's
local storage. Their password hashes cannot be converted to Supabase passwords.
Accounts in another Supabase project are not copied automatically. Create an
email/password shop account in the target project, then recreate staff accounts
from the Admin workspace.

Cloud POS data is stored in a revision-checked JSON document per shop. A
stale-device write is rejected rather than overwriting a newer cloud revision;
the POS reports when a change remains only on the current device. This is an
initial cloud-sync layer, not transactional multi-register inventory
accounting. Do not use it for concurrent real-money tills until transactional
sales and stock updates are implemented and validated.

The current M-Pesa configuration is sandbox only. Trial and price records are
not a billing service, and subscriptions are not charged or gated. Live launch
requires a production-approved Daraja account, a secure server-side
subscription/payment workflow, subscription enforcement, and public HTTPS
hosting. Never expose the local `server.js` payment API directly to the
internet.
