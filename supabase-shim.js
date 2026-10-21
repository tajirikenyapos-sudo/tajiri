/* Supabase compatibility shim for Tajiri POS.
 *
 * Loads @supabase/supabase-js from the CDN and exposes the same
 * `window.firebaseAuth`, `window.firebaseDb`, and `window.firebase`
 * globals the POS previously got from the Firebase compat SDK. The rest
 * of the app (welcome.js, app.js, index.html boot code) keeps working
 * unchanged while the backend is Supabase.
 *
 * Backing store (run supabase-schema.sql and supabase-saas-migration.sql):
 *   users      – staff profiles with tenant membership
 *   shops      – shop owners, trial metadata, and plan price
 *   shop_state – revision-checked POS data, isolated by tenant
 *
 * Supabase Auth handles phone/password sign-in and password reset.
 * Persistence (LOCAL vs SESSION) is emulated by storing the session in
 * localStorage or sessionStorage.
 */
(() => {
  window.firebaseAuth = null;
  window.firebaseDb = null;
  window.__tajiriFirebaseError = null;
  let finishBackendInitialization;
  window.__tajiriBackendReady = new Promise(resolve => {
    finishBackendInitialization = resolve;
  });

  const SUPABASE_URL = window.TAJIRI_SUPABASE_URL || "";
  const SUPABASE_ANON_KEY = window.TAJIRI_SUPABASE_ANON_KEY || "";
  const hasRealValues =
    SUPABASE_URL &&
    !SUPABASE_URL.startsWith("REPLACE_") &&
    SUPABASE_ANON_KEY &&
    !SUPABASE_ANON_KEY.startsWith("REPLACE_");

  if (!window.TAJIRI_SUPABASE_CONFIG) {
    window.TAJIRI_SUPABASE_CONFIG = {
      url: SUPABASE_URL,
      anonKey: SUPABASE_ANON_KEY,
    };
  }

  if (!hasRealValues) {
    finishBackendInitialization(false);
    return;
  }

  const config = window.TAJIRI_SUPABASE_CONFIG;

  // Deep-link target for Supabase email links/redirects. In the packaged
  // Electron app there is no http origin, so fall back to the local server.
  const redirectUrl = () => {
    if (window.location?.origin && window.location.origin.startsWith("http")) {
      return `${window.location.origin}${window.location.pathname || "/"}`;
    }
    return "http://localhost:3000/";
  };

  // Load supabase-js v2 as a classic script (UMD build exposes window.supabase).
  const script = document.createElement("script");
  script.src =
    "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.js";
  script.async = false;
  script.onerror = () => {
    window.__tajiriFirebaseError =
      "Cloud sign-in is unavailable. Check the Supabase setup; saved legacy accounts only work on this browser.";
    finishBackendInitialization(false);
  };
  script.onload = () => {
    try {
      initializeSupabase();
      finishBackendInitialization(true);
    } catch (error) {
      console.warn("Supabase initialization failed:", error);
      window.__tajiriFirebaseError =
        "Cloud sign-in is unavailable. Check the Supabase setup; saved legacy accounts only work on this browser.";
      finishBackendInitialization(false);
    }
  };
  document.head.append(script);

  function firebaseAuthErrorMessage(error, action) {
    const code = String(error?.message || "").toLowerCase();
    if (code.includes("invalid login credentials"))
      return "The email or password is incorrect.";
    if (code.includes("email not confirmed"))
      return "Email confirmation is still enabled in Supabase. Disable it to allow password-only sign-in.";
    if (code.includes("already registered") || code.includes("already exists"))
      return "An account already exists for this email. Sign in or use password reset.";
    if (code.includes("at least 6"))
      return "Choose a stronger password with at least 6 characters.";
    if (code.includes("invalid email") || code.includes("valid email"))
      return "Enter a valid email address.";
    if (code.includes("too many requests"))
      return "Too many attempts. Wait a while, then try again.";
    if (code.includes("network") || code.includes("failed to fetch"))
      return "Could not reach Supabase. Check your internet connection and try again.";
    if (code.includes("row-level security") || code.includes("permission"))
      return action === "signup"
        ? "Could not verify administrator setup. Publish the current Supabase policies, then try again."
        : "Could not verify your account role. Check the Supabase policies and try again.";
    return action === "signup"
      ? "The account could not be created. Check Supabase Authentication and try again."
      : "Sign-in could not be completed. Check your connection and Supabase setup, then try again.";
  }
  window.firebaseAuthErrorMessage = firebaseAuthErrorMessage;

  function initializeSupabase() {
    const persistenceStore = { mode: "local" };
    const authStorage = {
      async getItem(key) {
        return (
          window.sessionStorage.getItem(key) ||
          window.localStorage.getItem(key)
        );
      },
      async setItem(key, value) {
        const destination =
          persistenceStore.mode === "session"
            ? window.sessionStorage
            : window.localStorage;
        const other =
          persistenceStore.mode === "session"
            ? window.localStorage
            : window.sessionStorage;
        destination.setItem(key, value);
        other.removeItem(key);
      },
      async removeItem(key) {
        window.localStorage.removeItem(key);
        window.sessionStorage.removeItem(key);
      },
    };
    const client = window.supabase.createClient(config.url, config.anonKey, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        storage: authStorage,
      },
    });

    /* ---------------- window.firebase compat surface ---------------- */
    window.firebase = {
      auth: {
        Auth: {
          Persistence: {
            LOCAL: "local",
            SESSION: "session",
          },
        },
      },
      firestore: {
        FieldValue: {
          serverTimestamp: () => new Date().toISOString(),
        },
      },
      __tajiriPersistence: persistenceStore,
    };

    /* ---------------- window.firebaseAuth compat ---------------- */
    const userWrapper = (session) => {
      if (!session?.user) return null;
      const u = session.user;
      return {
        uid: u.id,
        email: u.email,
        phone: u.phone,
        emailVerified: Boolean(u.email_confirmed_at || u.confirmed_at),
        phoneVerified: Boolean(u.phone_confirmed_at),
        displayName: (u.user_metadata && u.user_metadata.display_name) || "",
        async updateProfile(profile) {
          const { error } = await client.auth.updateUser({
            data: { display_name: profile.displayName ?? "" },
          });
          if (error) throw error;
        },
        async sendEmailVerification() {
          const { error } = await client.auth.resend({
            type: "signup",
            email: u.email,
          });
          if (error) throw error;
        },
        async resendVerificationEmail() {
          const { error } = await client.auth.resend({
            type: "signup",
            email: u.email,
          });
          if (error) throw error;
        },
        async verifyEmail(code) {
          const { data: verifyData, error } = await client.auth.verifyOtp({
            email: u.email,
            token: String(code || "").trim(),
            type: "signup",
          });
          if (error) throw error;
          if (verifyData?.session) rememberSession(verifyData.session);
          return { user: userWrapper(verifyData?.session) };
        },
        async delete() {
          throw new Error("Auth users can only be removed by the trusted server.");
        },
      };
    };

    window.firebaseAuth = {
      async setPersistence(persistence) {
        const nextMode = persistence === "session" ? "session" : "local";
        const key = storageKey();
        const currentValue =
          window.sessionStorage.getItem(key) ||
          window.localStorage.getItem(key);
        persistenceStore.mode = nextMode;
        if (currentValue) {
          const destination =
            nextMode === "session"
              ? window.sessionStorage
              : window.localStorage;
          const other =
            nextMode === "session"
              ? window.localStorage
              : window.sessionStorage;
          destination.setItem(key, currentValue);
          other.removeItem(key);
        }
      },

      async signInWithEmailCode(email, code) {
        const { data, error } = await client.auth.verifyOtp({
          email,
          token: String(code || "").trim(),
          type: "email",
        });
        if (error) {
          const message = String(error.message || "").toLowerCase();
          if (
            message.includes("expired") ||
            message.includes("invalid") ||
            message.includes("token")
          ) {
            error.code = "auth/invalid-verification-code";
          } else if (message.includes("too many requests")) {
            error.code = "auth/too-many-requests";
          } else if (
            message.includes("network") ||
            message.includes("failed to fetch")
          ) {
            error.code = "auth/network-request-failed";
          }
          throw error;
        }
        if (data?.session) rememberSession(data.session);
        return { user: userWrapper(data?.session) };
      },

      async verifyEmailCode(email, code) {
        const { data, error } = await client.auth.verifyOtp({
          email,
          token: String(code || "").trim(),
          type: "signup",
        });
        if (error) {
          const message = String(error.message || "").toLowerCase();
          if (
            message.includes("expired") ||
            message.includes("invalid") ||
            message.includes("token")
          ) {
            error.code = "auth/invalid-verification-code";
          } else if (message.includes("too many requests")) {
            error.code = "auth/too-many-requests";
          } else if (
            message.includes("network") ||
            message.includes("failed to fetch")
          ) {
            error.code = "auth/network-request-failed";
          }
          throw error;
        }
        if (data?.session) rememberSession(data.session);
        return { user: userWrapper(data?.session) };
      },

      async resendVerificationEmail(email) {
        const { error } = await client.auth.resend({
          type: "signup",
          email,
        });
        if (error) {
          const message = String(error.message || "").toLowerCase();
          if (message.includes("too many requests") || message.includes("rate limit")) {
            error.code = "auth/too-many-requests";
          } else if (
            message.includes("network") ||
            message.includes("failed to fetch")
          ) {
            error.code = "auth/network-request-failed";
          }
          throw error;
        }
      },

      async sendSignInCode(email) {
        const { error } = await client.auth.signInWithOtp({
          email,
          options: { emailRedirectTo: redirectUrl() },
        });
        if (error) throw error;
      },

      async signInWithEmailAndPassword(email, password) {
        const { data, error } = await client.auth.signInWithPassword({
          email,
          password,
        });
        if (error) {
          const message = String(error.message || "").toLowerCase();
          if (message.includes("email not confirmed")) {
            error.code = "auth/email-not-confirmed";
          } else if (message.includes("too many requests")) {
            error.code = "auth/too-many-requests";
          } else if (
            message.includes("network") ||
            message.includes("failed to fetch")
          ) {
            error.code = "auth/network-request-failed";
          } else {
            error.code = "auth/invalid-credential";
          }
          throw error;
        }
        rememberSession(data.session);
        return { user: userWrapper(data.session) };
      },

      async signInWithPhoneAndPassword(phone, password) {
        const { data, error } = await client.auth.signInWithPassword({
          phone,
          password,
        });
        if (error) {
          const message = String(error.message || "").toLowerCase();
          if (message.includes("phone not confirmed")) {
            error.code = "auth/phone-not-confirmed";
          } else if (message.includes("too many requests")) {
            error.code = "auth/too-many-requests";
          } else if (message.includes("network") || message.includes("failed to fetch")) {
            error.code = "auth/network-request-failed";
          } else {
            error.code = "auth/invalid-credential";
          }
          throw error;
        }
        rememberSession(data.session);
        return { user: userWrapper(data.session) };
      },

      async createUserWithPhoneAndPassword(phone, password, metadata = {}) {
        const { data, error } = await client.auth.signUp({
          phone,
          password,
          options: { data: metadata },
        });
        if (error) {
          const message = String(error.message || "").toLowerCase();
          const code = String(error.code || "").toLowerCase();
          if (message.includes("already registered") || message.includes("already exists")) {
            error.code = "auth/phone-already-in-use";
          } else if (
            code === "phone_provider_disabled" ||
            message.includes("phone signups are disabled") ||
            message.includes("unsupported provider: phone")
          ) {
            error.code = "auth/phone-signup-disabled";
          } else if (message.includes("rate limit") || message.includes("too many requests")) {
            error.code = "auth/too-many-requests";
          } else if (message.includes("phone") && message.includes("invalid")) {
            error.code = "auth/invalid-phone-number";
          } else if (
            message.includes("sms") ||
            message.includes("phone provider") ||
            message.includes("not configured")
          ) {
            error.code = "auth/sms-provider-not-configured";
          }
          throw error;
        }
        if (!data?.user?.id) {
          throw new Error("Supabase did not create the phone account.");
        }
        if (data.session && !data.user.phone_confirmed_at) {
          const { error: signOutError } = await client.auth.signOut();
          if (signOutError) throw signOutError;
          const confirmationError = new Error(
            "Supabase phone confirmation is disabled.",
          );
          confirmationError.code = "auth/phone-confirmation-disabled";
          throw confirmationError;
        }
        return {
          user: {
            uid: data.user.id,
            phone,
            phoneVerified: Boolean(data.user.phone_confirmed_at),
            displayName: metadata.display_name || "",
          },
        };
      },

      async verifyPhoneCode(phone, code) {
        const { data, error } = await client.auth.verifyOtp({
          phone,
          token: String(code || "").trim(),
          type: "sms",
        });
        if (error) {
          const message = String(error.message || "").toLowerCase();
          if (message.includes("expired") || message.includes("invalid") || message.includes("token")) {
            error.code = "auth/invalid-verification-code";
          } else if (message.includes("too many requests")) {
            error.code = "auth/too-many-requests";
          }
          throw error;
        }
        if (data?.session) rememberSession(data.session);
        return { user: userWrapper(data?.session) };
      },

      async resendPhoneVerificationCode(phone) {
        const { error } = await client.auth.resend({ type: "sms", phone });
        if (error) {
          const message = String(error.message || "").toLowerCase();
          if (message.includes("too many requests") || message.includes("rate limit")) {
            error.code = "auth/too-many-requests";
          } else if (
            message.includes("sms") ||
            message.includes("phone provider") ||
            message.includes("not configured")
          ) {
            error.code = "auth/sms-provider-not-configured";
          }
          throw error;
        }
      },

      async sendPhonePasswordResetCode(phone) {
        const { error } = await client.auth.signInWithOtp({
          phone,
          options: { shouldCreateUser: false },
        });
        if (error) throw error;
      },

      async verifyPhonePasswordResetCode(phone, code, password) {
        const { data, error } = await client.auth.verifyOtp({
          phone,
          token: String(code || "").trim(),
          type: "sms",
        });
        if (error) throw error;
        if (data?.session) rememberSession(data.session);
        const { error: updateError } = await client.auth.updateUser({ password });
        if (updateError) throw updateError;
      },

      async createUserWithEmailAndPassword(email, password, metadata = {}) {
        const { data, error } = await client.auth.signUp({
          email,
          password,
          options: { data: metadata, emailRedirectTo: redirectUrl() },
        });
        if (error) {
          const message = String(error.message || "").toLowerCase();
          const code = String(error.code || "").toLowerCase();
          if (
            code.includes("already") ||
            message.includes("already registered") ||
            message.includes("already exists")
          ) {
            error.code = "auth/email-already-in-use";
          } else if (
            code.includes("rate_limit") ||
            message.includes("rate limit") ||
            message.includes("too many requests")
          ) {
            error.code = "auth/too-many-requests";
          } else if (
            message.includes("not authorized") ||
            message.includes("not allowed") ||
            message.includes("only send") ||
            message.includes("can only send")
          ) {
            error.code = "auth/email-delivery-not-configured";
          } else if (
            code.includes("email_address_invalid") ||
            message.includes("invalid email") ||
            message.includes("email address is invalid")
          ) {
            error.code = "auth/invalid-email";
          } else if (
            code.includes("weak_password") ||
            message.includes("password")
          ) {
            error.code = "auth/weak-password";
          }
          throw error;
        }
        if (!data.session) {
          // Email confirmation required: return a wrapper without a session.
          const pseudoUser = {
            uid: data.user?.id || "",
            email,
            emailVerified: false,
            async updateProfile() {},
            async sendEmailVerification() {
              // Supabase already sent the confirmation code at signUp; resending
              // immediately can trip rate limits, so this stays a no-op here.
            },
            async resendVerificationEmail() {
              const { error } = await client.auth.resend({
                type: "signup",
                email,
              });
              if (error) throw error;
            },
            async verifyEmail(code) {
              const { data: verifyData, error } = await client.auth.verifyOtp({
                email,
                token: String(code || "").trim(),
                type: "signup",
              });
              if (error) throw error;
              if (verifyData?.session) rememberSession(verifyData.session);
              return { user: userWrapper(verifyData?.session) };
            },
            async delete() {
              throw new Error("Auth users can only be removed by the trusted server.");
            },
          };
          return { user: pseudoUser };
        }
        rememberSession(data.session);
        return { user: userWrapper(data.session) };
      },

      async sendPasswordResetEmail(email) {
        const { error } = await client.auth.resetPasswordForEmail(email);
        if (error) throw error;
      },

      async signOut() {
        const { error } = await client.auth.signOut();
        if (error) throw error;
      },

      get currentUser() {
        // Synchronous best-effort read of the cached session.
        const key = storageKey();
        try {
          const raw = JSON.parse(
            window.sessionStorage.getItem(key) ||
              window.localStorage.getItem(key) ||
              "null",
          );
          return userWrapper(raw?.currentSession || raw);
        } catch (error) {
          console.error("Could not read the saved Supabase session:", error);
          return null;
        }
      },

      onAuthStateChanged(callback, errorListener) {
        let settled = false;
        const { data: sub } = client.auth.onAuthStateChange(
          (event, session) => {
            if (settled) callback(userWrapper(session));
          },
        );
        const unsubscribe = () => sub?.subscription?.unsubscribe?.();
        const timeout = window.setTimeout(() => {
          if (settled) return;
          settled = true;
          unsubscribe();
          errorListener
            ? errorListener(
                new Error("Timed out while checking Supabase sign-in."),
              )
            : callback(null);
        }, 10000);
        client.auth.getSession().then(({ data, error }) => {
          if (settled) return;
          settled = true;
          window.clearTimeout(timeout);
          if (error) {
            unsubscribe();
            errorListener ? errorListener(error) : callback(null);
            return;
          }
          callback(userWrapper(data.session));
        }).catch(error => {
          if (settled) return;
          settled = true;
          window.clearTimeout(timeout);
          unsubscribe();
          errorListener ? errorListener(error) : callback(null);
        });
        return unsubscribe;
      },
    };

    function storageKey() {
      return `sb-${new URL(config.url).hostname.split(".")[0]}-auth-token`;
    }

    // Move the Supabase session between local/session storage to honor the
    // requested persistence mode (Supabase-js v2 always writes localStorage).
    function rememberSession(session) {
      if (!session) return;
      try {
        const key = storageKey();
        const payload = JSON.stringify({
          currentSession: session,
          ...session,
        });
        if (persistenceStore.mode === "session") {
          window.sessionStorage.setItem(key, payload);
          window.localStorage.removeItem(key);
        } else {
          window.localStorage.setItem(key, payload);
          window.sessionStorage.removeItem(key);
        }
      } catch (error) {
        console.warn(
          "Could not apply the requested session persistence:",
          error,
        );
      }
    }
    window.__tajiriRememberSupabaseSession = rememberSession;

    /* ---------------- window.firebaseDb compat (Firestore → Postgres) ---------------- */
    function toUserProfile(row) {
      if (!row) return null;
      return {
        ...row,
        uid: row.id,
        createdAt: row.created_at,
      };
    }

    const snapshotFromRow = (row, name) => {
      const result =
        name === "system"
          ? row?.value
            ? { ...row.value }
            : null
          : name === "users"
            ? toUserProfile(row)
            : row;
      return {
        exists: Boolean(row),
        id: row?.id ?? row?.key ?? null,
        data: () => (result ? { ...result } : {}),
      };
    };

    function makeCollectionRef(name) {
      return {
        name,
        doc(id) {
          const table = name === "system" ? "system" : name;
          return {
            id,
            async get() {
              const keyColumn = table === "system" ? "key" : "id";
              const query = client.from(table).select("*").eq(keyColumn, id);
              const { data, error } = await query.maybeSingle();
              if (error) throw error;
              return snapshotFromRow(data, table);
            },
            async set(value) {
              if (table === "system") {
                throw new Error("System rows can only be changed using a trusted RPC.");
              }
              const { error } = await client.from(table).upsert(
                {
                  id,
                  key: id,
                  name: value.name,
                  username: value.username,
                  email: value.email,
                  phone: value.phone || "",
                  role: value.role,
                },
                { onConflict: "id" },
              );
              if (error) throw error;
            },
            async update(value) {
              if (table === "system") {
                throw new Error("System rows can only be changed using a trusted RPC.");
              }
              const updates = {};
              if (value.name !== undefined) updates.name = value.name;
              if (value.username !== undefined) updates.username = value.username;
              if (value.phone !== undefined) updates.phone = value.phone;
              const { error } = await client
                .from(table)
                .update(updates)
                .eq("id", id);
              if (error) throw error;
            },
            async delete() {
              const { error } = await client
                .from(table)
                .delete()
                .eq(table === "system" ? "key" : "id", id);
              if (error) throw error;
            },
          };
        },
        async get() {
          const { data, error } = await client.from(name).select("*");
          if (error) throw error;
          return {
            empty: !data || data.length === 0,
            docs: (data || []).map((row) => snapshotFromRow(row, name)),
          };
        },
      };
    }

    window.firebaseDb = {
      collection: makeCollectionRef,

      async createShopForCurrentUser(profile) {
        const { data, error } = await client.rpc(
          "create_shop_for_current_user",
          {
            p_shop_name: profile.shopName,
            p_name: profile.name,
            p_username: profile.username,
            p_email: profile.email,
          },
        );
        if (error) throw error;
        if (!data?.tenant_id) {
          throw new Error("Supabase did not return the new shop membership.");
        }
        return data;
      },
    };
    window.tajiriSupabase = {
      client,
      async loadShopState(tenantId) {
        if (!tenantId) throw new Error("A shop account is required to load POS data.");
        const { data, error } = await client
          .from("shop_state")
          .select("data, revision")
          .eq("tenant_id", tenantId)
          .maybeSingle();
        if (error) throw error;
        return data
          ? { state: data.data, revision: data.revision }
          : { state: null, revision: 0 };
      },
      async saveShopState(data, expectedRevision) {
        if (data?.users !== undefined) {
          throw new Error("Account profiles must not be saved as shop data.");
        }
        const { data: revision, error } = await client.rpc("save_shop_state", {
          p_expected_revision: expectedRevision,
          p_data: data,
        });
        if (error) throw error;
        if (!Number.isSafeInteger(Number(revision)) || Number(revision) < 1) {
          throw new Error("Supabase did not confirm the saved POS data revision.");
        }
        return Number(revision);
      },
      async createStaffAccount(account) {
        const { data, error } = await client.functions.invoke("create-staff", {
          body: account,
        });
        if (error) {
          let message = error.message || "Staff account creation failed.";
          if (error.context && typeof error.context.json === "function") {
            try {
              const responseBody = await error.context.json();
              message = responseBody.error || message;
            } catch (parseError) {
              console.warn("Could not read staff service error response:", parseError);
            }
          }
          const staffError = new Error(message);
          if (/phone number already has an account/i.test(message)) {
            staffError.code = "auth/phone-already-in-use";
          }
          throw staffError;
        }
        if (!data?.profile) {
          throw new Error("Supabase did not return the new staff profile.");
        }
        return data.profile;
      },
    };
  }
})();
