// @vitest-environment node
//
// Unit tests for supabase-shim.js — the Firebase-compat layer over Supabase.
//
// The shim is a browser IIFE that reads window.TAJIRI_SUPABASE_* globals,
// injects a <script> for supabase-js, and exposes window.firebaseAuth /
// window.firebaseDb / window.tajiriSupabase. We evaluate it inside a jsdom
// window through a `vm` sandbox, intercept the injected script element so we
// can trigger its onload/onerror ourselves, and back it with a hand-rolled
// mock of the supabase-js client surface. This keeps the tests fast,
// deterministic and free of any real network traffic.
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { JSDOM } = require("jsdom");
const { afterEach, beforeEach, describe, expect, it, vi } =
  await import("vitest");

const SOURCE_PATH = path.join(__dirname, "supabase-shim.js");
const source = fs.readFileSync(SOURCE_PATH, "utf8");

const TEST_URL = "https://abcdefg.supabase.co";
const TEST_KEY = "anon-key-123";
const STORAGE_KEY = "sb-abcdefg-auth-token";

/* ------------------------------------------------------------------ */
/* Mock supabase-js client                                             */
/* ------------------------------------------------------------------ */

function makeSupabaseClientMock() {
  const calls = {
    signInWithPassword: [],
    signInWithOtp: [],
    signUp: [],
    rpc: [],
    invoke: [],
    resetPasswordForEmail: [],
    updateUser: [],
    resend: [],
    verifyOtp: [],
  };
  // rows for `from(table).select("*").eq(keyColumn, id).maybeSingle()`
  const rowResults = new Map(); // `${table}:${key}` -> { row?, error? }
  const tableRows = new Map(); // table -> [rows]
  let client;
  const mutationQuery = getError => {
    const query = {
      eq: vi.fn(() => query),
      then(resolve, reject) {
        return Promise.resolve({ error: getError() }).then(resolve, reject);
      },
    };
    return query;
  };
  const upsert = vi.fn(() =>
    mutationQuery(() => client.__upsertError),
  );
  const update = vi.fn(() =>
    mutationQuery(() => client.__updateError),
  );
  const deleteRow = vi.fn(() =>
    mutationQuery(() => client.__deleteError),
  );

  client = {
    __calls: calls,
    __rowResults: rowResults,
    __tableRows: tableRows,
    auth: {
      signInWithPassword: vi.fn(async (args) => {
        calls.signInWithPassword.push(args);
        return client.__nextSignIn
          ? await client.__nextSignIn(args)
          : { data: { session: null, user: null }, error: null };
      }),
      signInWithOtp: vi.fn(async (args) => {
        calls.signInWithOtp.push(args);
        return client.__nextSignInOtp || { error: null };
      }),
      signUp: vi.fn(async (args) => {
        calls.signUp.push(args);
        return client.__nextSignUp
          ? await client.__nextSignUp(args)
          : { data: { session: null, user: null }, error: null };
      }),
      signOut: vi.fn(async () => ({ error: null })),
      getSession: vi.fn(async () => ({
        data: { session: client.__session || null },
        error: null,
      })),
      onAuthStateChange: vi.fn(() => ({
        data: {
          subscription: { unsubscribe: vi.fn(), id: "sub-1" },
        },
      })),
      resetPasswordForEmail: vi.fn(async (email) => {
        calls.resetPasswordForEmail.push(email);
        return client.__nextReset || { error: null };
      }),
      resend: vi.fn(async args => {
        calls.resend.push(args);
        return client.__nextResend || { error: null };
      }),
      verifyOtp: vi.fn(async args => {
        calls.verifyOtp.push(args);
        return client.__nextVerifyOtp || {
          data: { session: null, user: null },
          error: null,
        };
      }),
      updateUser: vi.fn(async (payload) => {
        calls.updateUser.push(payload);
        return client.__nextUpdateUser || { error: null };
      }),
    },
    from(table) {
      const builder = {
        select: () => {
          const rows = tableRows.get(table) || [];
          const selectBuilder = {
            eq: (col, val) => {
              selectBuilder.__eq = [col, val];
              return selectBuilder;
            },
            maybeSingle: async () => {
              const [col, val] = selectBuilder.__eq || [];
              const key = `${table}:${val}`;
              const hit = rowResults.get(key);
              return hit
                ? { data: hit.row ?? null, error: hit.error ?? null }
                : { data: null, error: null };
            },
            then(resolve, reject) {
              resolve({ data: rows, error: null });
            },
          };
          return selectBuilder;
        },
        upsert,
        update,
        delete: deleteRow,
      };
      return builder;
    },
    rpc: vi.fn(async (fn, args) => {
      calls.rpc.push({ fn, args });
      return client.__nextRpc || { error: null };
    }),
    functions: {
      invoke: vi.fn(async (name, opts) => {
        calls.invoke.push({ name, body: opts?.body });
        return client.__nextInvoke || { data: {}, error: null };
      }),
    },
  };
  return client;
}

/* ------------------------------------------------------------------ */
/* Shim loader                                                         */
/* ------------------------------------------------------------------ */

function loadShim({
  url = TEST_URL,
  anonKey = TEST_KEY,
  config,
  autoLoad = true,
  client,
} = {}) {
  const dom = new JSDOM("<!doctype html><html><head></head><body></body></html>", {
    url: "https://pos.example.test/",
  });
  const window = dom.window;
  let injectedScript = null;
  window.document.head.append = (el) => {
    injectedScript = el;
  };
  if (url !== undefined) window.TAJIRI_SUPABASE_URL = url;
  if (anonKey !== undefined) window.TAJIRI_SUPABASE_ANON_KEY = anonKey;
  if (config !== undefined) window.TAJIRI_SUPABASE_CONFIG = config;
  if (client) window.supabase = { createClient: vi.fn(() => client) };
  const ctx = {
    window,
    document: window.document,
    console,
    URL: window.URL,
  };
  vm.createContext(ctx);
  vm.runInContext(source, ctx, { filename: "supabase-shim.js" });

  const finish = async (ok) => {
    await ctx.window.__tajiriBackendReady;
    return ok;
  };
  const result = {
    window,
    ctx,
    injectedScript,
    ready: () => ctx.window.__tajiriBackendReady,
  };
  result.client = client;
  result.createClient = window.supabase?.createClient;

  if (autoLoad && injectedScript) {
    // Simulate the CDN script finishing loading.
    injectedScript.onload();
  }
  return result;
}

const SESSION = {
  access_token: "at-1",
  refresh_token: "rt-1",
  user: {
    id: "user-1",
    email: "admin@example.com",
    email_confirmed_at: "2026-01-01T00:00:00Z",
    phone: "+254712345678",
    phone_confirmed_at: "2026-01-01T00:00:00Z",
    user_metadata: { display_name: "Ada" },
  },
};

beforeEach(() => {
  vi.stubGlobal("__TAJIRI_TEST_NOW__", Date.now());
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

/* ------------------------------------------------------------------ */
/* Configuration / bootstrap                                           */
/* ------------------------------------------------------------------ */

describe("configuration bootstrap", () => {
  it("resolves backend initialization as failed when no real values are configured", async () => {
    const { window } = loadShim({ url: "", anonKey: "" });
    expect(await window.__tajiriBackendReady).toBe(false);
    expect(window.firebaseAuth).toBeNull();
    expect(window.firebaseDb).toBeNull();
  });

  it("treats placeholder REPLACE_ values as unconfigured", async () => {
    const { window } = loadShim({
      url: "REPLACE_WITH_YOUR_SUPABASE_URL",
      anonKey: "REPLACE_WITH_YOUR_SUPABASE_ANON_KEY",
    });
    expect(await window.__tajiriBackendReady).toBe(false);
  });

  it("defaults TAJIRI_SUPABASE_CONFIG from the globals and does not overwrite an existing one", async () => {
    const existing = { url: "https://custom.supabase.co", anonKey: "k" };
    const { window } = loadShim({
      url: TEST_URL,
      anonKey: TEST_KEY,
      autoLoad: false,
    });
    expect(window.TAJIRI_SUPABASE_CONFIG).toEqual({
      url: TEST_URL,
      anonKey: TEST_KEY,
    });

    const configured = loadShim({
      url: TEST_URL,
      anonKey: TEST_KEY,
      config: existing,
      autoLoad: false,
    });
    expect(configured.window.TAJIRI_SUPABASE_CONFIG).toBe(existing);
  });

  it("injects the supabase-js UMD script and resolves ready=true on successful init", async () => {
    const client = makeSupabaseClientMock();
    const { window, injectedScript, createClient } = loadShim({ client });
    expect(injectedScript.src).toContain(
      "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.js",
    );
    expect(createClient).toHaveBeenCalledWith(TEST_URL, TEST_KEY, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        storage: expect.objectContaining({
          getItem: expect.any(Function),
          setItem: expect.any(Function),
          removeItem: expect.any(Function),
        }),
      },
    });
    expect(window.firebaseAuth).toBeTruthy();
    expect(window.firebaseDb).toBeTruthy();
    expect(window.firebase).toBeTruthy();
    expect(await window.__tajiriBackendReady).toBe(true);
  });

  it("exposes the Firebase compat surface", async () => {
    const client = makeSupabaseClientMock();
    const { window } = loadShim({ client });
    expect(window.firebase.auth.Auth.Persistence).toEqual({
      LOCAL: "local",
      SESSION: "session",
    });
    expect(typeof window.firebase.firestore.FieldValue.serverTimestamp()).toBe(
      "string",
    );
    expect(window.firebase.__tajiriPersistence).toEqual({ mode: "local" });
  });

  it("resolves ready=false with a friendly error when script load fails", async () => {
    const client = makeSupabaseClientMock();
    const { window, injectedScript } = loadShim({ client, autoLoad: false });
    injectedScript.onerror();
    expect(await window.__tajiriBackendReady).toBe(false);
    expect(window.__tajiriFirebaseError).toMatch(/Cloud sign-in is unavailable/i);
    expect(window.firebaseAuth).toBeNull();
  });

  it("resolves ready=false with a friendly error when initialization throws", async () => {
    const client = makeSupabaseClientMock();
    const { window, injectedScript } = loadShim({
      client,
      autoLoad: false,
    });
    window.supabase.createClient.mockImplementation(() => {
      throw new Error("boom");
    });
    injectedScript.onload();
    expect(await window.__tajiriBackendReady).toBe(false);
    expect(window.__tajiriFirebaseError).toMatch(/Cloud sign-in is unavailable/i);
  });
});

/* ------------------------------------------------------------------ */
/* firebaseAuthErrorMessage                                            */
/* ------------------------------------------------------------------ */

describe("firebaseAuthErrorMessage", () => {
  const cases = [
    ["Invalid login credentials", null, "The email or password is incorrect."],
    [
      "Email not confirmed",
      null,
      "Email confirmation is still enabled in Supabase. Disable it to allow password-only sign-in.",
    ],
    [
      "User already registered",
      null,
      "An account already exists for this email. Sign in or use password reset.",
    ],
    [
      "Password should be at least 6 characters",
      null,
      "Choose a stronger password with at least 6 characters.",
    ],
    ["invalid email", null, "Enter a valid email address."],
    [
      "Too many requests",
      null,
      "Too many attempts. Wait a while, then try again.",
    ],
    [
      "Failed to fetch",
      null,
      "Could not reach Supabase. Check your internet connection and try again.",
    ],
    [
      "new row violates row-level security policy",
      "signup",
      "Could not verify administrator setup. Publish the current Supabase policies, then try again.",
    ],
    [
      "permission denied",
      "signin",
      "Could not verify your account role. Check the Supabase policies and try again.",
    ],
    [
      "something obscure",
      "signup",
      "The account could not be created. Check Supabase Authentication and try again.",
    ],
    [
      "something obscure",
      "signin",
      "Sign-in could not be completed. Check your connection and Supabase setup, then try again.",
    ],
  ];

  it.each(cases)('maps "%s" (%s) to a friendly message', (raw, action, expected) => {
    const client = makeSupabaseClientMock();
    const { window } = loadShim({ client });
    expect(window.firebaseAuthErrorMessage({ message: raw }, action)).toBe(
      expected,
    );
  });

  it("handles null/undefined errors", () => {
    const client = makeSupabaseClientMock();
    const { window } = loadShim({ client });
    expect(window.firebaseAuthErrorMessage(null, "signin")).toBe(
      "Sign-in could not be completed. Check your connection and Supabase setup, then try again.",
    );
    expect(window.firebaseAuthErrorMessage({}, "signin")).toBe(
      "Sign-in could not be completed. Check your connection and Supabase setup, then try again.",
    );
  });
});

/* ------------------------------------------------------------------ */
/* sign in                                                             */
/* ------------------------------------------------------------------ */

describe("signInWithEmailAndPassword", () => {
  it("returns a wrapped user on success and stores the session in localStorage", async () => {
    const client = makeSupabaseClientMock();
    client.__nextSignIn = async () => ({ data: { session: SESSION }, error: null });
    const { window } = loadShim({ client });
    const { user } = await window.firebaseAuth.signInWithEmailAndPassword(
      "admin@example.com",
      "secret",
    );
    expect(client.auth.signInWithPassword).toHaveBeenCalledWith({
      email: "admin@example.com",
      password: "secret",
    });
    expect(user.uid).toBe("user-1");
    expect(user.email).toBe("admin@example.com");
    expect(user.emailVerified).toBe(true);
    expect(user.displayName).toBe("Ada");
    expect(JSON.parse(window.localStorage.getItem(STORAGE_KEY)).currentSession)
      .toEqual(SESSION);
    expect(window.sessionStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  it("throws an error tagged auth/invalid-credential for bad credentials", async () => {
    const client = makeSupabaseClientMock();
    client.__nextSignIn = async () => ({
      data: null,
      error: { message: "Invalid login credentials" },
    });
    const { window } = loadShim({ client });
    await expect(
      window.firebaseAuth.signInWithEmailAndPassword("a@b.c", "nope"),
    ).rejects.toMatchObject({ code: "auth/invalid-credential" });
  });

  it.each([
    ["Email not confirmed", "auth/email-not-confirmed"],
    ["Too many requests", "auth/too-many-requests"],
    ["Failed to fetch", "auth/network-request-failed"],
  ])('tags "%s" failures with the right code', async (message, code) => {
    const client = makeSupabaseClientMock();
    client.__nextSignIn = async () => ({ data: null, error: { message } });
    const { window } = loadShim({ client });
    await expect(
      window.firebaseAuth.signInWithEmailAndPassword("a@b.c", "nope"),
    ).rejects.toMatchObject({ code });
  });

  it("does not store anything when sign-in fails", async () => {
    const client = makeSupabaseClientMock();
    client.__nextSignIn = async () => ({
      data: null,
      error: { message: "Invalid login credentials" },
    });
    const { window } = loadShim({ client });
    await expect(
      window.firebaseAuth.signInWithEmailAndPassword("a@b.c", "nope"),
    ).rejects.toBeTruthy();
    expect(window.localStorage.getItem(STORAGE_KEY)).toBeNull();
  });
});

/* ------------------------------------------------------------------ */
/* sign up                                                             */
/* ------------------------------------------------------------------ */

describe("createUserWithEmailAndPassword", () => {
  it("signs up with metadata and wraps the returned session user", async () => {
    const client = makeSupabaseClientMock();
    client.__nextSignUp = async () => ({ data: { session: SESSION }, error: null });
    const { window } = loadShim({ client });
    const { user } = await window.firebaseAuth.createUserWithEmailAndPassword(
      "new@example.com",
      "secret",
      { display_name: "Bob" },
    );
    expect(client.auth.signUp).toHaveBeenCalledWith({
      email: "new@example.com",
      password: "secret",
      options: {
        data: { display_name: "Bob" },
        emailRedirectTo: "https://pos.example.test/",
      },
    });
    expect(user.uid).toBe("user-1");
    expect(JSON.parse(window.localStorage.getItem(STORAGE_KEY)).currentSession)
      .toEqual(SESSION);
  });

  it("returns a pseudo-user without storing a session when confirmation is required", async () => {
    const client = makeSupabaseClientMock();
    client.__nextSignUp = async () => ({
      data: { session: null, user: { id: "user-2" } },
      error: null,
    });
    const { window } = loadShim({ client });
    const { user } = await window.firebaseAuth.createUserWithEmailAndPassword(
      "new@example.com",
      "secret",
    );
    expect(user.uid).toBe("user-2");
    expect(user.emailVerified).toBe(false);
    // Sending verification again is a no-op, and delete is forbidden client-side.
    await expect(user.sendEmailVerification()).resolves.toBeUndefined();
    await expect(user.delete()).rejects.toThrow(/trusted server/i);
    expect(window.localStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  it("falls back to an empty uid when the server returns no user id", async () => {
    const client = makeSupabaseClientMock();
    client.__nextSignUp = async () => ({
      data: { session: null, user: null },
      error: null,
    });
    const { window } = loadShim({ client });
    const { user } = await window.firebaseAuth.createUserWithEmailAndPassword(
      "new@example.com",
      "secret",
    );
    expect(user.uid).toBe("");
  });

  it.each([
    ["User already registered", "auth/email-already-in-use"],
    ["Invalid email format", "auth/invalid-email"],
    ["Password should be at least 6 characters", "auth/weak-password"],
  ])('tags "%s" with code %s', async (message, code) => {
    const client = makeSupabaseClientMock();
    client.__nextSignUp = async () => ({ data: null, error: { message } });
    const { window } = loadShim({ client });
    await expect(
      window.firebaseAuth.createUserWithEmailAndPassword("a@b.c", "x"),
    ).rejects.toMatchObject({ code });
  });
});

describe("email verification codes", () => {
  it("verifies signup codes with the Supabase signup token type", async () => {
    const client = makeSupabaseClientMock();
    client.__nextVerifyOtp = { data: { session: SESSION }, error: null };
    const { window } = loadShim({ client });

    const result = await window.firebaseAuth.verifyEmailCode(
      "new@example.com",
      "123456",
    );

    expect(client.auth.verifyOtp).toHaveBeenCalledWith({
      email: "new@example.com",
      token: "123456",
      type: "signup",
    });
    expect(result.user.uid).toBe("user-1");
    expect(JSON.parse(window.localStorage.getItem(STORAGE_KEY)).currentSession)
      .toEqual(SESSION);
  });

  it("maps invalid signup codes to an actionable error code", async () => {
    const client = makeSupabaseClientMock();
    client.__nextVerifyOtp = {
      data: null,
      error: { message: "Token has expired" },
    };
    const { window } = loadShim({ client });

    await expect(
      window.firebaseAuth.verifyEmailCode("new@example.com", "123456"),
    ).rejects.toMatchObject({ code: "auth/invalid-verification-code" });
  });

  it("resends signup codes via Supabase Auth", async () => {
    const client = makeSupabaseClientMock();
    const { window } = loadShim({ client });

    await window.firebaseAuth.resendVerificationEmail("new@example.com");

    expect(client.auth.resend).toHaveBeenCalledWith({
      type: "signup",
      email: "new@example.com",
    });
  });
});

describe("phone authentication", () => {
  it("starts signup with a phone identity and contact metadata", async () => {
    const client = makeSupabaseClientMock();
    client.__nextSignUp = async () => ({
      data: { user: { id: "new-user", phone: "+254712345678" }, session: null },
      error: null,
    });
    const { window } = loadShim({ client });

    const result = await window.firebaseAuth.createUserWithPhoneAndPassword(
      "+254712345678",
      "secret1",
      { display_name: "Ada", email_contact: "ada@example.com" },
    );

    expect(client.auth.signUp).toHaveBeenCalledWith({
      phone: "+254712345678",
      password: "secret1",
      options: {
        data: { display_name: "Ada", email_contact: "ada@example.com" },
      },
    });
    expect(result.user).toMatchObject({
      uid: "new-user",
      phone: "+254712345678",
      phoneVerified: false,
    });
  });

  it("rejects signup when Supabase allows an unconfirmed phone session", async () => {
    const client = makeSupabaseClientMock();
    client.__nextSignUp = async () => ({
      data: {
        user: { id: "new-user", phone: "+254712345678" },
        session: { access_token: "unverified-token" },
      },
      error: null,
    });
    const { window } = loadShim({ client });

    await expect(
      window.firebaseAuth.createUserWithPhoneAndPassword(
        "+254712345678",
        "secret1",
      ),
    ).rejects.toMatchObject({ code: "auth/phone-confirmation-disabled" });
    expect(client.auth.signOut).toHaveBeenCalled();
  });

  it("identifies Supabase phone-provider-disabled signup errors", async () => {
    const client = makeSupabaseClientMock();
    client.__nextSignUp = async () => ({
      data: null,
      error: {
        code: "phone_provider_disabled",
        message: "Phone signups are disabled",
      },
    });
    const { window } = loadShim({ client });

    await expect(
      window.firebaseAuth.createUserWithPhoneAndPassword(
        "+254712345678",
        "secret1",
      ),
    ).rejects.toMatchObject({ code: "auth/phone-signup-disabled" });
  });

  it("verifies SMS codes as phone OTPs", async () => {
    const client = makeSupabaseClientMock();
    client.__nextVerifyOtp = { data: { session: SESSION }, error: null };
    const { window } = loadShim({ client });

    const result = await window.firebaseAuth.verifyPhoneCode(
      "+254712345678",
      "123456",
    );

    expect(client.auth.verifyOtp).toHaveBeenCalledWith({
      phone: "+254712345678",
      token: "123456",
      type: "sms",
    });
    expect(result.user.phoneVerified).toBe(true);
  });

  it("resends SMS signup codes through Supabase Auth", async () => {
    const client = makeSupabaseClientMock();
    const { window } = loadShim({ client });

    await window.firebaseAuth.resendPhoneVerificationCode("+254712345678");

    expect(client.auth.resend).toHaveBeenCalledWith({
      type: "sms",
      phone: "+254712345678",
    });
  });

  it("requests password-reset SMS without allowing account creation", async () => {
    const client = makeSupabaseClientMock();
    const { window } = loadShim({ client });

    await window.firebaseAuth.sendPhonePasswordResetCode("+254712345678");

    expect(client.auth.signInWithOtp).toHaveBeenCalledWith({
      phone: "+254712345678",
      options: { shouldCreateUser: false },
    });
  });
});

/* ------------------------------------------------------------------ */
/* user wrapper behaviors                                              */
/* ------------------------------------------------------------------ */

describe("user wrapper", () => {
  it("treats users without confirmation timestamps as unverified", async () => {
    const client = makeSupabaseClientMock();
    const session = JSON.parse(JSON.stringify(SESSION));
    delete session.user.email_confirmed_at;
    client.__nextSignIn = async () => ({ data: { session }, error: null });
    const { window } = loadShim({ client });
    const { user } = await window.firebaseAuth.signInWithEmailAndPassword(
      "a@b.c",
      "pw",
    );
    expect(user.emailVerified).toBe(false);
    expect(user.displayName).toBe("Ada");
  });

  it("maps a missing display_name to an empty string", async () => {
    const client = makeSupabaseClientMock();
    const session = JSON.parse(JSON.stringify(SESSION));
    session.user.user_metadata = {};
    client.__nextSignIn = async () => ({ data: { session }, error: null });
    const { window } = loadShim({ client });
    const { user } = await window.firebaseAuth.signInWithEmailAndPassword(
      "a@b.c",
      "pw",
    );
    expect(user.displayName).toBe("");
  });

  it("updateProfile pushes display_name through updateUser and rethrows errors", async () => {
    const client = makeSupabaseClientMock();
    client.__nextSignIn = async () => ({ data: { session: SESSION }, error: null });
    const { window } = loadShim({ client });
    const { user } = await window.firebaseAuth.signInWithEmailAndPassword(
      "a@b.c",
      "pw",
    );

    await user.updateProfile({ displayName: "New Name" });
    expect(client.auth.updateUser).toHaveBeenCalledWith({
      data: { display_name: "New Name" },
    });

    client.__nextUpdateUser = { error: { message: "nope" } };
    await expect(user.updateProfile({ displayName: "X" })).rejects.toThrow("nope");

    // Missing displayName falls back to an empty string.
    client.__nextUpdateUser = null;
    await user.updateProfile({});
    expect(client.auth.updateUser).toHaveBeenLastCalledWith({
      data: { display_name: "" },
    });
  });

  it("returns null for sessions without a user", async () => {
    const client = makeSupabaseClientMock();
    client.__nextSignIn = async () => ({
      data: { session: { access_token: "x" } },
      error: null,
    });
    const { window } = loadShim({ client });
    const { user } = await window.firebaseAuth.signInWithEmailAndPassword(
      "a@b.c",
      "pw",
    );
    expect(user).toBeNull();
  });
});

/* ------------------------------------------------------------------ */
/* password reset / sign out                                           */
/* ------------------------------------------------------------------ */

describe("sendPasswordResetEmail and signOut", () => {
  it("forwards the email to resetPasswordForEmail and rethrows errors", async () => {
    const client = makeSupabaseClientMock();
    const { window } = loadShim({ client });
    await window.firebaseAuth.sendPasswordResetEmail("a@b.c");
    expect(client.auth.resetPasswordForEmail).toHaveBeenCalledWith("a@b.c");

    client.__nextReset = { error: { message: "rate limited" } };
    await expect(
      window.firebaseAuth.sendPasswordResetEmail("a@b.c"),
    ).rejects.toThrow("rate limited");
  });

  it("signs out through the client", async () => {
    const client = makeSupabaseClientMock();
    const { window } = loadShim({ client });
    await window.firebaseAuth.signOut();
    expect(client.auth.signOut).toHaveBeenCalledTimes(1);
  });

  it("reports sign-out failures to the caller", async () => {
    const client = makeSupabaseClientMock();
    client.auth.signOut.mockResolvedValueOnce({
      error: new Error("sign-out unavailable"),
    });
    const { window } = loadShim({ client });
    await expect(window.firebaseAuth.signOut()).rejects.toThrow(
      "sign-out unavailable",
    );
  });
});

/* ------------------------------------------------------------------ */
/* persistence                                                         */
/* ------------------------------------------------------------------ */

describe("session persistence", () => {
  it("moves an existing session from localStorage to sessionStorage with setPersistence(SESSION)", async () => {
    const client = makeSupabaseClientMock();
    client.__nextSignIn = async () => ({ data: { session: SESSION }, error: null });
    const { window } = loadShim({ client });
    await window.firebaseAuth.signInWithEmailAndPassword("a@b.c", "pw");
    expect(window.localStorage.getItem(STORAGE_KEY)).toBeTruthy();

    await window.firebaseAuth.setPersistence(window.firebase.auth.Auth.Persistence.SESSION);
    expect(window.sessionStorage.getItem(STORAGE_KEY)).toBeTruthy();
    expect(window.localStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  it("moves the session back to localStorage with setPersistence(LOCAL)", async () => {
    const client = makeSupabaseClientMock();
    client.__nextSignIn = async () => ({ data: { session: SESSION }, error: null });
    const { window } = loadShim({ client });
    await window.firebaseAuth.signInWithEmailAndPassword("a@b.c", "pw");
    await window.firebaseAuth.setPersistence("session");
    await window.firebaseAuth.setPersistence("local");
    expect(window.localStorage.getItem(STORAGE_KEY)).toBeTruthy();
    expect(window.sessionStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  it("treats unknown persistence values as local and is safe with no stored session", async () => {
    const client = makeSupabaseClientMock();
    const { window } = loadShim({ client });
    await expect(window.firebaseAuth.setPersistence("banana")).resolves.toBeUndefined();
  });

  it("currentUser reads the cached session from either storage and is null otherwise", async () => {
    const client = makeSupabaseClientMock();
    const { window } = loadShim({ client });
    expect(window.firebaseAuth.currentUser).toBeNull();

    client.__nextSignIn = async () => ({ data: { session: SESSION }, error: null });
    await window.firebaseAuth.signInWithEmailAndPassword("a@b.c", "pw");
    expect(window.firebaseAuth.currentUser?.uid).toBe("user-1");

    await window.firebaseAuth.setPersistence("session");
    expect(window.firebaseAuth.currentUser?.uid).toBe("user-1");
  });

  it("currentUser returns null (not throws) for corrupted storage data", async () => {
    const client = makeSupabaseClientMock();
    const { window } = loadShim({ client });
    window.localStorage.setItem(STORAGE_KEY, "{not json");
    const warn = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(window.firebaseAuth.currentUser).toBeNull();
    warn.mockRestore();
  });

  it("the authStorage adapter reads sessionStorage before localStorage", async () => {
    const client = makeSupabaseClientMock();
    const { window } = loadShim({ client });
    const storage = window.TAJIRI_SUPABASE_CONFIG; // placeholder, real check below
    // The adapter is passed to createClient; exercise it via currentUser +
    // setPersistence which use the same stores. Set a session-only value and
    // confirm currentUser (which checks session first) picks it up.
    window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify({ currentSession: SESSION }));
    expect(window.firebaseAuth.currentUser?.uid).toBe("user-1");
  });
});

/* ------------------------------------------------------------------ */
/* onAuthStateChanged                                                  */
/* ------------------------------------------------------------------ */

describe("onAuthStateChanged", () => {
  it("fires the callback with the wrapped user from getSession", async () => {
    const client = makeSupabaseClientMock();
    client.__session = SESSION;
    const { window } = loadShim({ client });
    const cb = vi.fn();
    const unsub = window.firebaseAuth.onAuthStateChanged(cb);
    await vi.waitFor(() => expect(cb).toHaveBeenCalledTimes(1));
    expect(cb.mock.calls[0][0]?.uid).toBe("user-1");
    expect(typeof unsub).toBe("function");
  });

  it("fires callback(null) when there is no session", async () => {
    const client = makeSupabaseClientMock();
    const { window } = loadShim({ client });
    const cb = vi.fn();
    window.firebaseAuth.onAuthStateChanged(cb);
    await vi.waitFor(() => expect(cb).toHaveBeenCalledWith(null));
  });

  it("routes getSession errors to the error listener when provided", async () => {
    const client = makeSupabaseClientMock();
    client.auth.getSession = vi.fn(async () => ({
      data: null,
      error: { message: "boom" },
    }));
    const { window } = loadShim({ client });
    const cb = vi.fn();
    const errCb = vi.fn();
    window.firebaseAuth.onAuthStateChanged(cb, errCb);
    await vi.waitFor(() => expect(errCb).toHaveBeenCalledTimes(1));
    expect(errCb.mock.calls[0][0]).toMatchObject({ message: "boom" });
    expect(cb).not.toHaveBeenCalled();
  });

  it("falls back to callback(null) on getSession rejection without an error listener", async () => {
    const client = makeSupabaseClientMock();
    client.auth.getSession = vi.fn(async () => {
      throw new Error("network down");
    });
    const { window } = loadShim({ client });
    const cb = vi.fn();
    window.firebaseAuth.onAuthStateChanged(cb);
    await vi.waitFor(() => expect(cb).toHaveBeenCalledWith(null));
  });

  it("replays subsequent auth-state events as user objects", async () => {
    const client = makeSupabaseClientMock();
    const { window } = loadShim({ client });
    const cb = vi.fn();
    window.firebaseAuth.onAuthStateChanged(cb);
    await vi.waitFor(() => expect(cb).toHaveBeenCalledTimes(1));
    expect(cb.mock.calls[0][0]).toBeNull();

    const handler = client.auth.onAuthStateChange.mock.calls[0][0];
    handler("SIGNED_IN", SESSION);
    expect(cb).toHaveBeenCalledTimes(2);
    expect(cb.mock.calls[1][0]?.uid).toBe("user-1");

    handler("SIGNED_OUT", null);
    expect(cb).toHaveBeenCalledTimes(3);
    expect(cb.mock.calls[2][0]).toBeNull();
  });

  it("calls the error listener on the 10s timeout and stops listening", async () => {
    vi.useFakeTimers();
    const client = makeSupabaseClientMock();
    client.auth.getSession = vi.fn(() => new Promise(() => {})); // never settles
    const { window } = loadShim({ client });
    const cb = vi.fn();
    const errCb = vi.fn();
    const unsub = window.firebaseAuth.onAuthStateChanged(cb, errCb);
    vi.advanceTimersByTime(10000);
    expect(errCb).toHaveBeenCalledTimes(1);
    expect(errCb.mock.calls[0][0].message).toMatch(/Timed out/i);
    expect(cb).not.toHaveBeenCalled();
    // Unsubscribing must not throw.
    expect(() => unsub()).not.toThrow();
  });

  it("falls back to callback(null) on timeout when no error listener is given", async () => {
    vi.useFakeTimers();
    const client = makeSupabaseClientMock();
    client.auth.getSession = vi.fn(() => new Promise(() => {}));
    const { window } = loadShim({ client });
    const cb = vi.fn();
    window.firebaseAuth.onAuthStateChanged(cb);
    vi.advanceTimersByTime(10000);
    expect(cb).toHaveBeenCalledWith(null);
  });
});

/* ------------------------------------------------------------------ */
/* firebaseDb                                                          */
/* ------------------------------------------------------------------ */

describe("firebaseDb", () => {
  it("doc().get() on users maps the row to a profile snapshot", async () => {
    const client = makeSupabaseClientMock();
    client.__rowResults.set("users:user-1", {
      row: {
        id: "user-1",
        name: "Ada",
        username: "ada",
        email: "a@b.c",
        role: "admin",
        created_at: "2026-01-01T00:00:00Z",
      },
    });
    const { window } = loadShim({ client });
    const snap = await window.firebaseDb.collection("users").doc("user-1").get();
    expect(snap.exists).toBe(true);
    expect(snap.id).toBe("user-1");
    const data = snap.data();
    expect(data.uid).toBe("user-1");
    expect(data.createdAt).toBe("2026-01-01T00:00:00Z");
    expect(data.name).toBe("Ada");
  });

  it("doc().get() returns a non-existent snapshot for a missing row", async () => {
    const client = makeSupabaseClientMock();
    const { window } = loadShim({ client });
    const snap = await window.firebaseDb.collection("users").doc("missing").get();
    expect(snap.exists).toBe(false);
    expect(snap.id).toBeNull();
    expect(snap.data()).toEqual({});
  });

  it("doc().get() rethrows client errors", async () => {
    const client = makeSupabaseClientMock();
    client.__rowResults.set("users:user-1", {
      error: { message: "rls blocked" },
    });
    const { window } = loadShim({ client });
    await expect(
      window.firebaseDb.collection("users").doc("user-1").get(),
    ).rejects.toThrow("rls blocked");
  });

  it("system doc().get() unwraps the value column", async () => {
    const client = makeSupabaseClientMock();
    client.__rowResults.set("system:bootstrap", {
      row: { id: 1, key: "bootstrap", value: { ready: true } },
    });
    const { window } = loadShim({ client });
    const snap = await window.firebaseDb.collection("system").doc("bootstrap").get();
    expect(snap.exists).toBe(true);
    expect(snap.data()).toEqual({ ready: true });
  });

  it("refuses to write system rows from the client", async () => {
    const client = makeSupabaseClientMock();
    const { window } = loadShim({ client });
    const doc = window.firebaseDb.collection("system").doc("bootstrap");
    await expect(doc.set({ name: "x" })).rejects.toThrow(/trusted RPC/i);
    await expect(doc.update({ name: "x" })).rejects.toThrow(/trusted RPC/i);
  });

  it("users doc().set() upserts with id, key and profile columns", async () => {
    const client = makeSupabaseClientMock();
    const { window } = loadShim({ client });
    await window.firebaseDb.collection("users").doc("user-1").set({
      name: "Ada",
      username: "ada",
      email: "a@b.c",
      phone: "0700",
      role: "admin",
    });
    const upsert = client.from("users").upsert;
    expect(upsert).toHaveBeenCalledWith(
      {
        id: "user-1",
        key: "user-1",
        name: "Ada",
        username: "ada",
        email: "a@b.c",
        phone: "0700",
        role: "admin",
      },
      { onConflict: "id" },
    );
  });

  it("users doc().set() defaults phone to an empty string and rethrows upsert errors", async () => {
    const client = makeSupabaseClientMock();
    client.__upsertError = { message: "rls" };
    const { window } = loadShim({ client });
    await expect(
      window.firebaseDb.collection("users").doc("user-1").set({
        name: "A",
        username: "a",
        email: "a@b.c",
        role: "staff",
      }),
    ).rejects.toThrow("rls");
    expect(client.from("users").upsert).toHaveBeenLastCalledWith(
      expect.objectContaining({ phone: "" }),
      { onConflict: "id" },
    );
  });

  it("users doc().update() only sends the provided fields", async () => {
    const client = makeSupabaseClientMock();
    const { window } = loadShim({ client });
    const doc = window.firebaseDb.collection("users").doc("user-1");
    await doc.update({ name: "New", phone: "123" });
    expect(client.from("users").update).toHaveBeenCalledWith({
      name: "New",
      phone: "123",
    });
    // An empty patch sends nothing.
    await doc.update({});
    expect(client.from("users").update).toHaveBeenLastCalledWith({});
  });

  it("users doc().update() rethrows errors", async () => {
    const client = makeSupabaseClientMock();
    client.__updateError = { message: "nope" };
    const { window } = loadShim({ client });
    await expect(
      window.firebaseDb.collection("users").doc("user-1").update({ name: "X" }),
    ).rejects.toThrow("nope");
  });

  it("users doc().delete() deletes by id", async () => {
    const client = makeSupabaseClientMock();
    const { window } = loadShim({ client });
    await window.firebaseDb.collection("users").doc("user-1").delete();
    expect(client.from("users").delete).toHaveBeenCalledTimes(1);
  });

  it("doc().delete() rethrows errors", async () => {
    const client = makeSupabaseClientMock();
    client.__deleteError = { message: "denied" };
    const { window } = loadShim({ client });
    await expect(
      window.firebaseDb.collection("users").doc("user-1").delete(),
    ).rejects.toThrow("denied");
  });

  it("collection().get() lists docs, reports emptiness, and rethrows errors", async () => {
    const client = makeSupabaseClientMock();
    const { window } = loadShim({ client });

    let result = await window.firebaseDb.collection("users").get();
    expect(result.empty).toBe(true);
    expect(result.docs).toEqual([]);

    client.__tableRows.set("users", [
      { id: "u1", name: "Ada", created_at: "2026-01-01T00:00:00Z" },
    ]);
    result = await window.firebaseDb.collection("users").get();
    expect(result.empty).toBe(false);
    expect(result.docs).toHaveLength(1);
    expect(result.docs[0].data().uid).toBe("u1");
    expect(result.docs[0].data().createdAt).toBe("2026-01-01T00:00:00Z");
  });

  it("createShopForCurrentUser creates a tenant and returns its membership", async () => {
    const client = makeSupabaseClientMock();
    const profile = {
      uid: "u1",
      tenant_id: "shop-1",
      role: "admin",
    };
    client.__nextRpc = { data: profile, error: null };
    const { window } = loadShim({ client });
    const result = await window.firebaseDb.createShopForCurrentUser({
      shopName: "Amina's Market",
      name: "Ada",
      username: "ada",
      email: "ada@example.com",
    });
    expect(client.rpc).toHaveBeenCalledWith("create_shop_for_current_user", {
      p_shop_name: "Amina's Market",
      p_name: "Ada",
      p_username: "ada",
      p_email: "ada@example.com",
    });
    expect(result).toEqual(profile);
  });

  it("surfaces shop signup failures and rejects profiles without a tenant", async () => {
    const client = makeSupabaseClientMock();
    const { window } = loadShim({ client });
    client.__nextRpc = { error: { message: "migration required" } };
    await expect(
      window.firebaseDb.createShopForCurrentUser({
        shopName: "Amina's Market",
        name: "Ada",
        username: "ada",
        email: "ada@example.com",
      }),
    ).rejects.toThrow("migration required");

    client.__nextRpc = { data: { uid: "u1" }, error: null };
    await expect(
      window.firebaseDb.createShopForCurrentUser({
        shopName: "Amina's Market",
        name: "Ada",
        username: "ada",
        email: "ada@example.com",
      }),
    ).rejects.toThrow(/shop membership/i);
  });
});

describe("tajiriSupabase shop data", () => {
  it("loads only the requested tenant's cloud state and revision", async () => {
    const client = makeSupabaseClientMock();
    client.__rowResults.set("shop_state:shop-1", {
      row: { data: { salesLog: [] }, revision: 4 },
    });
    const { window } = loadShim({ client });
    await expect(window.tajiriSupabase.loadShopState("shop-1")).resolves.toEqual({
      state: { salesLog: [] },
      revision: 4,
    });
  });

  it("saves through the revision-checked RPC and excludes account profiles", async () => {
    const client = makeSupabaseClientMock();
    client.__nextRpc = { data: 8, error: null };
    const { window } = loadShim({ client });
    await expect(
      window.tajiriSupabase.saveShopState({ salesLog: [] }, 7),
    ).resolves.toBe(8);
    expect(client.rpc).toHaveBeenCalledWith("save_shop_state", {
      p_expected_revision: 7,
      p_data: { salesLog: [] },
    });
    await expect(
      window.tajiriSupabase.saveShopState({ users: [] }, 8),
    ).rejects.toThrow(/profiles/i);
  });
});

/* ------------------------------------------------------------------ */
/* createStaffAccount                                                  */
/* ------------------------------------------------------------------ */

describe("tajiriSupabase.createStaffAccount", () => {
  const PROFILE = {
    uid: "u9",
    tenant_id: "shop-1",
    name: "Staff",
    email: "s@x.c",
    role: "cashier",
  };

  it("invokes the create-staff edge function with the account payload", async () => {
    const client = makeSupabaseClientMock();
    client.__nextInvoke = { data: { profile: PROFILE }, error: null };
    const { window } = loadShim({ client });
    const account = {
      name: "Staff",
      username: "staff",
      email: "s@x.c",
      role: "cashier",
      password: "pw12345",
    };
    const profile = await window.tajiriSupabase.createStaffAccount(account);
    expect(client.functions.invoke).toHaveBeenCalledWith("create-staff", {
      body: account,
    });
    expect(profile).toEqual(PROFILE);
  });

  it("throws when the response has no profile", async () => {
    const client = makeSupabaseClientMock();
    client.__nextInvoke = { data: {}, error: null };
    const { window } = loadShim({ client });
    await expect(
      window.tajiriSupabase.createStaffAccount({ name: "S" }),
    ).rejects.toThrow(/did not return the new staff profile/i);
  });

  it("extracts the error message and tags duplicate phone accounts", async () => {
    const client = makeSupabaseClientMock();
    client.__nextInvoke = {
      data: null,
      error: {
        message: "HTTP 409",
        context: {
          json: async () => ({ error: "That phone number already has an account." }),
        },
      },
    };
    const { window } = loadShim({ client });
    await expect(
      window.tajiriSupabase.createStaffAccount({ name: "S" }),
    ).rejects.toMatchObject({
      message: "That phone number already has an account.",
      code: "auth/phone-already-in-use",
    });
  });

  it("falls back to the default message when context.json fails", async () => {
    const client = makeSupabaseClientMock();
    client.__nextInvoke = {
      data: null,
      error: {
        message: "HTTP 500",
        context: {
          json: async () => {
            throw new Error("not json");
          },
        },
      },
    };
    const { window } = loadShim({ client });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await expect(
      window.tajiriSupabase.createStaffAccount({ name: "S" }),
    ).rejects.toThrow("HTTP 500");
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("uses a generic message when error has neither message nor context", async () => {
    const client = makeSupabaseClientMock();
    client.__nextInvoke = { data: null, error: {} };
    const { window } = loadShim({ client });
    await expect(
      window.tajiriSupabase.createStaffAccount({ name: "S" }),
    ).rejects.toThrow("Staff account creation failed.");
  });
});
