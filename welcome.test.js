// @vitest-environment node
//
// Unit tests for welcome.js (the sign-in / admin-signup page script).
//
// welcome.js is a browser IIFE with no module exports, so — like app.test.js —
// we evaluate it inside a jsdom window with a minimal DOM fixture and assert
// on observable side effects: toasts, error messages, tabs, sessionStorage
// entries, and validation messages.

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { JSDOM } = require("jsdom");
const { afterEach, beforeEach, describe, expect, it, vi } =
  await import("vitest");

const SOURCE_PATH = path.join(__dirname, "welcome.js");
const source = fs.readFileSync(SOURCE_PATH, "utf8");
const MAIN_PAGE_SOURCE = fs.readFileSync(
  path.join(__dirname, "main.html"),
  "utf8",
);
const INDEX_PAGE_SOURCE = fs.readFileSync(
  path.join(__dirname, "index.html"),
  "utf8",
);
const APP_SOURCE = fs.readFileSync(path.join(__dirname, "app.js"), "utf8");
const openDoms = new Set();

/* ---------- DOM fixture ---------- */

const FIXTURE_HTML = `
<body>
  <section id="welcomeView">
    <h1><span id="welcomeBrandName">Tajiri POS</span></h1>
    <p id="welcomeTagline">Smart POS Solutions for Modern Shops</p>
    <span id="heroYear"></span>
    <div id="heroAccounts"></div>
  </section>

  <div id="modal-access" class="modal-layer" hidden>
    <div role="dialog">
        <div class="modal-head"><h2>Sign in to Tajiri POS</h2></div>
        <div class="auth-card">
          <button id="tabLogin" data-tab="login">Sign in</button>
          <button id="tabSignup" data-tab="signup" hidden>Sign up</button>
          <form id="loginForm" class="auth-form">
            <h2>Welcome back</h2>
            <p class="auth-sub">Sign in to continue.</p>
            <input id="loginIdentity" />
            <input id="loginPassword" type="password" />
            <input id="rememberLogin" type="checkbox" />
            <button id="loginSubmit" type="submit">Sign in →</button>
            <p id="loginError" hidden></p>
            <a id="forgotLink" href="#">Forgot password?</a>
          </form>
          <form id="signupForm" class="auth-form" hidden>
            <h2>Create account</h2>
            <p class="auth-sub">Set up the first administrator.</p>
            <input id="signupShopName" />
            <input id="signupName" />
            <input id="signupEmail" />
            <label><input id="signupRole" /></label>
            <input id="signupPassword" type="password" />
            <input id="signupConfirmPassword" type="password" />
            <button id="signupSubmit" type="submit">Create account →</button>
            <p id="signupError" hidden></p>
            <p id="adminSetupError" hidden></p>
            <div id="passwordStrength" hidden>
              <div id="strengthFill"></div>
              <span id="strengthLabel"></span>
            </div>
          </form>
          <section id="signupConfirmationNotice" hidden>
            <strong id="signupConfirmationEmail"></strong>
            <button type="button" data-switch="login">Back to sign in</button>
          </section>
          <form id="setPasswordForm" class="auth-form" hidden>
            <input id="setPasswordInput" type="password" />
            <input id="setPasswordConfirmation" type="password" />
            <button id="setPasswordSubmit" type="submit">Save password</button>
            <p id="setPasswordError" hidden></p>
          </form>
        </div>
    </div>
  </div>

  <div id="modal-password-reset" class="modal-layer" hidden>
    <form id="passwordResetForm">
      <input id="passwordResetIdentity" />
      <p id="passwordResetError" hidden></p>
    </form>
  </div>

  <div id="toast"></div>
  <button id="navMoreBtn" aria-expanded="false"></button>
  <div id="navMoreMenu" hidden></div>
</body>`;

/* ---------- helpers ---------- */

function makeFirebaseStubs() {
  return {
    firebaseAuth: {
      setPersistence: vi.fn().mockResolvedValue(undefined),
      signInWithEmailAndPassword: vi.fn().mockResolvedValue({
        user: {
          uid: "uid-1",
          emailVerified: true,
          displayName: "Ada",
          updateProfile: vi.fn().mockResolvedValue(undefined),
          delete: vi.fn().mockResolvedValue(undefined),
        },
      }),
      createUserWithEmailAndPassword: vi.fn().mockResolvedValue({
        user: {
          uid: "uid-new",
          email: "ada@example.test",
          emailVerified: true,
          updateProfile: vi.fn().mockResolvedValue(undefined),
          delete: vi.fn().mockResolvedValue(undefined),
        },
      }),
      sendPasswordResetEmail: vi.fn().mockResolvedValue(undefined),
      updatePassword: vi.fn().mockResolvedValue(undefined),
      onAuthStateChanged: vi.fn(callback => {
        callback({
          uid: "uid-1",
          email: "ada@example.test",
          emailVerified: true,
        });
        return vi.fn();
      }),
      signOut: vi.fn().mockResolvedValue(undefined),
      currentUser: null,
    },
    firebaseDb: {
      collection: (name) => ({
        name,
        doc: () => ({
          get: async () => ({ exists: false, data: () => ({}) }),
          set: vi.fn(),
        }),
      }),
      runTransaction: vi.fn().mockResolvedValue(undefined),
      createShopForCurrentUser: vi.fn(async (profile) => ({
        uid: "uid-new",
        tenant_id: "shop-new",
        ...profile,
        role: "admin",
      })),
      profileFromAuthUser: vi.fn(() => null),
    },
  };
}

// Builds a jsdom document, injects a stubbed window.location, then evaluates
// welcome.js inside it. Returns the JSDOM instance.
function loadWelcomePage({
  url = "https://pos.example.test/welcome.html",
  stubs = {},
} = {}) {
  const dom = new JSDOM(FIXTURE_HTML, {
    url,
    runScripts: "outside-only",
    pretendToBeVisual: true,
  });
  openDoms.add(dom);
  const win = dom.window;

  // jsdom's Location is read-only; replace it with a controllable stub.
  // The script needs `window.location.search` (role shell routing) and must
  // not actually navigate on `window.location.reload()`.
  const locationStub = {
    search: new URL(url).search,
    href: url,
    reload: vi.fn(),
    assign: vi.fn(),
  };
  try {
    delete win.location;
  } catch {
    /* some jsdom versions keep it; the try below covers us either way */
  }
  let effectiveLocation = locationStub;
  try {
    win.location = locationStub;
  } catch {
    effectiveLocation = win.location;
    win.location.reload = locationStub.reload;
    win.location.assign = locationStub.assign;
  }
  win.__location = effectiveLocation;

  Object.assign(win, stubs);

  // welcome.js reads the global `firebase` SDK object for persistence enums
  // and Firestore server timestamps, independent of window.firebaseAuth/Db.
  if (!win.firebase) {
    win.firebase = {
      auth: {
        Auth: {
          Persistence: { LOCAL: "local", SESSION: "session" },
        },
      },
      firestore: {
        FieldValue: {
          serverTimestamp: () => null,
        },
      },
    };
  }

  // Silence the noisy "Not implemented: window.scrollTo" style jsdom errors.
  win.addEventListener("error", () => {});

  win.eval(source);
  return dom;
}

function submitForm(dom, formId) {
  const event = new dom.window.Event("submit", {
    bubbles: true,
    cancelable: true,
  });
  dom.window.document.getElementById(formId).dispatchEvent(event);
}

function click(dom, selector) {
  const element = dom.window.document.querySelector(selector);
  element.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
  return element;
}

function textOfError(dom, id) {
  const element = dom.window.document.getElementById(id);
  return { text: element.textContent, hidden: element.hidden };
}

// Mirrors the FNV-1a session signature used by welcome.js.
function sessionSignature(user, role) {
  const value = `${String(user || "").trim()}|${String(role || "").trim()}|tajiri-pos-session-v1`;
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash = Math.imul(hash ^ value.charCodeAt(index), 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

// Mirrors welcome.js hashPassword: SHA-256 when crypto.subtle exists in the
// jsdom window, otherwise the FNV-1a fallback. Node's createHash produces the
// identical hex digest as SubtleCrypto.digest.
function expectedPasswordHash(win, password) {
  if (win.crypto && win.crypto.subtle) {
    return crypto.createHash("sha256").update(password, "utf8").digest("hex");
  }
  let hash = 2166136261;
  for (const character of password) {
    hash = Math.imul(hash ^ character.charCodeAt(0), 16777619);
  }
  return `fallback-${(hash >>> 0).toString(16)}`;
}

function flush(times = 4) {
  let promise = Promise.resolve();
  for (let i = 0; i < times; i += 1) {
    promise = promise.then(
      () => new Promise((resolve) => setTimeout(resolve, 0)),
    );
  }
  return promise;
}

/* ---------- tests ---------- */

describe("welcome.js", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });
  afterEach(() => {
    for (const dom of openDoms) dom.window.close();
    openDoms.clear();
  });

  describe("boot-time rendering", () => {
    it("activates the login tab by default and hides other forms", () => {
      const dom = loadWelcomePage();
      const doc = dom.window.document;
      expect(doc.getElementById("loginForm").classList.contains("active")).toBe(
        true,
      );
      expect(
        doc.getElementById("signupForm").classList.contains("active"),
      ).toBe(false);
      expect(doc.getElementById("tabLogin").getAttribute("aria-selected")).toBe(
        "true",
      );
    });

    it("shows the offline toast when the cloud backend is unavailable", () => {
      const dom = loadWelcomePage();
      expect(dom.window.document.getElementById("toast").textContent).toBe(
        "Cloud sign-in is unavailable. Local accounts only work on this browser.",
      );
    });

    it("renders brand/tagline from saved settings with safe fallbacks", () => {
      const dom = loadWelcomePage({
        stubs: {},
      });
      // No saved state → default brand and tagline.
      expect(
        dom.window.document.getElementById("welcomeBrandName").textContent,
      ).toBe("Tajiri POS");
      expect(
        dom.window.document.getElementById("welcomeTagline").textContent,
      ).toBe("Smart POS Solutions for Modern Shops");
    });

    it("stamps the current year into the hero", () => {
      const dom = loadWelcomePage();
      expect(dom.window.document.getElementById("heroYear").textContent).toBe(
        String(new Date().getFullYear()),
      );
    });

    it("offers separate admin and cashier sign-in entries", () => {
      const doc = new JSDOM(MAIN_PAGE_SOURCE).window.document;
      const adminLogin = doc.getElementById("adminLoginLink");
      const cashierLogin = doc.getElementById("cashierLoginLink");

      expect(adminLogin?.textContent).toContain("Admin Login");
      expect(adminLogin?.textContent).toContain("Manage your shop, staff, and reports");
      expect(adminLogin?.getAttribute("href")).toBe(
        "login.html?roleShell=admin",
      );
      expect(cashierLogin?.textContent).toContain("Cashier Login");
      expect(cashierLogin?.textContent).toContain("Process sales and print receipts");
      expect(cashierLogin?.getAttribute("href")).toBe(
        "login.html?roleShell=cashier",
      );
      const resourceOptions = doc.querySelector(".resource-options");
      expect(resourceOptions?.open).toBe(false);
      expect(resourceOptions?.querySelector("summary")?.textContent).toContain(
        "Download & install options",
      );
      expect(
        resourceOptions?.querySelector(".download-link")?.getAttribute("href"),
      ).toBe("https://pos-tajiri.vercel.app/download-installer.html");
      expect(
        resourceOptions?.contains(doc.getElementById("installAppButton")),
      ).toBe(true);
      expect(doc.querySelector("#startTrialLink")).toBeNull();
      expect(doc.querySelector(".trial-link")).toBeNull();
      expect(doc.body.textContent).not.toMatch(/14.day free trial/i);
      expect(doc.querySelector(".download-link")?.getAttribute("href")).toBe(
        "https://pos-tajiri.vercel.app/download-installer.html",
      );
      expect(doc.getElementById("guestModeButton")).toBeNull();
      expect(doc.getElementById("guestDashboard")).toBeNull();
      const appDoc = new JSDOM(INDEX_PAGE_SOURCE).window.document;
      const downloadLinks = [
        ...appDoc.querySelectorAll("#modal-downloads a"),
      ];
      expect(downloadLinks.map((link) => link.getAttribute("href"))).toEqual([
        "https://pos-tajiri.vercel.app/download-installer.html",
      ]);
      expect(
        downloadLinks.every((link) => link.getAttribute("target") === "_blank"),
      ).toBe(true);
      expect(appDoc.querySelector("#modal-downloads")?.textContent).toContain(
        "The Android APK is not included in this release yet.",
      );
    });

    it("omits Inventory, Reports, and data downloads from the POS More menu", () => {
      const doc = new JSDOM(INDEX_PAGE_SOURCE).window.document;
      const moreMenu = doc.querySelector("#appView #moreDropdown");

      expect(moreMenu).not.toBeNull();
      expect(moreMenu.querySelector('[data-view="Inventory"]')).toBeNull();
      expect(moreMenu.querySelector('[data-view="Reports"]')).toBeNull();
      expect(moreMenu.querySelector("#downloadDataButton")).toBeNull();
      expect(moreMenu.querySelector('[data-view="Sales"]')).not.toBeNull();
      expect(moreMenu.querySelector('[data-view="Purchases"]')).not.toBeNull();
    });

    it("places the Pages link inside the welcome More menu", () => {
      const doc = new JSDOM(INDEX_PAGE_SOURCE).window.document;
      const welcomeNav = doc.querySelector("#welcomeView .site-nav");
      const moreMenu = welcomeNav?.querySelector("#navMoreMenu");
      const pagesLink = moreMenu?.querySelector('a[href="main.html"]');

      expect(welcomeNav?.querySelector(":scope > .nav-more > a[href='main.html']")).toBeNull();
      expect(pagesLink?.textContent.trim()).toBe("Pages");
    });

    it("offers an optional admin setup guide connected to store settings", () => {
      const doc = new JSDOM(INDEX_PAGE_SOURCE).window.document;
      expect(doc.getElementById("adminSetupGuideButton")?.textContent).toContain(
        "Optional store setup guide",
      );
      expect(doc.getElementById("addProductButton")).not.toBeNull();
      expect(doc.getElementById("taxRateInput")).not.toBeNull();
      expect(doc.getElementById("mpesaToggle")).not.toBeNull();
      expect(APP_SOURCE).toContain("#adminSetupGuideButton");
      expect(APP_SOURCE).toContain('data-setup-guide-view="Inventory"');
      expect(APP_SOURCE).toContain('data-setup-guide-focus="#taxRateInput"');
      expect(APP_SOURCE).toContain('data-setup-guide-focus="#mpesaToggle"');
    });

    it("updates the install status when the app is installed", () => {
      const dom = new JSDOM(MAIN_PAGE_SOURCE, {
        runScripts: "dangerously",
        url: "https://pos.example.test/main.html",
      });
      openDoms.add(dom);
      const { document } = dom.window;

      dom.window.dispatchEvent(new dom.window.Event("appinstalled"));

      expect(document.getElementById("installAppButton").hidden).toBe(true);
      expect(document.getElementById("installHelp").hidden).toBe(true);
      expect(document.getElementById("installStatus").textContent).toBe(
        "Tajiri POS is installed on this device.",
      );
    });

    it("does not expose a guest dashboard or guest entry route", () => {
      const dom = new JSDOM(MAIN_PAGE_SOURCE, {
        runScripts: "dangerously",
        url: "https://pos.example.test/main.html?guest=1",
      });
      openDoms.add(dom);
      const { document } = dom.window;
      expect(document.documentElement.classList.contains("guest-dashboard-mode")).toBe(
        false,
      );
      expect(document.getElementById("guestModeButton")).toBeNull();
      expect(document.getElementById("guestDashboard")).toBeNull();
      expect(document.body.textContent).not.toMatch(/guest|read.only/i);
      expect(document.body.textContent || "").not.toMatch(/try the demo/i);
    });

    it("opens sign in when navigating through the generic login page", () => {
      const dom = loadWelcomePage({
        url: "https://pos.example.test/index.html?login=1",
      });
      expect(dom.window.document.getElementById("modal-access").hidden).toBe(
        false,
      );
      expect(
        dom.window.document.querySelector(".modal-head h2").textContent,
      ).toBe("Sign in to Tajiri POS");
    });

    it("auto-opens the access modal for the admin role shell", () => {
      const dom = loadWelcomePage({
        url: "https://pos.example.test/welcome.html?roleShell=admin",
      });
      expect(dom.window.document.getElementById("modal-access").hidden).toBe(
        false,
      );
      expect(
        dom.window.document.querySelector(".modal-head h2").textContent,
      ).toBe("Admin sign in");
    });

    it("auto-opens the access modal for the cashier role shell", () => {
      const dom = loadWelcomePage({
        url: "https://pos.example.test/welcome.html?roleShell=cashier",
      });
      expect(dom.window.document.getElementById("modal-access").hidden).toBe(
        false,
      );
      expect(
        dom.window.document.querySelector(".modal-head h2").textContent,
      ).toBe("Cashier sign in");
    });

    it("blocks admin signup when Supabase is not configured", async () => {
      const dom = loadWelcomePage({
        url: "https://pos.example.test/welcome.html?roleShell=admin",
      });
      await flush();
      expect(textOfError(dom, "adminSetupError").text).toBe(
        "First-time administrator signup requires Supabase Authentication and the Tajiri POS schema.",
      );
    });

    describe("remembered user restore", () => {
      it("pre-fills the login form when the stored signature is valid", () => {
        const dom = new JSDOM(FIXTURE_HTML, {
          url: "https://pos.example.test/welcome.html",
          runScripts: "outside-only",
          pretendToBeVisual: true,
        });
        openDoms.add(dom);
        const win = dom.window;
        win.localStorage.setItem("tajiri-remembered-user", "ada");
        win.localStorage.setItem("tajiri-remembered-role", "admin");
        win.localStorage.setItem(
          "tajiri-remembered-signature",
          sessionSignature("ada", "admin"),
        );
        win.eval(source);
        expect(win.document.getElementById("loginIdentity").value).toBe("ada");
        expect(win.document.getElementById("rememberLogin").checked).toBe(true);
      });

      it("ignores a remembered user whose signature does not match", () => {
        const dom = new JSDOM(FIXTURE_HTML, {
          url: "https://pos.example.test/welcome.html",
          runScripts: "outside-only",
          pretendToBeVisual: true,
        });
        openDoms.add(dom);
        const win = dom.window;
        win.localStorage.setItem("tajiri-remembered-user", "mallory");
        win.localStorage.setItem("tajiri-remembered-role", "admin");
        win.localStorage.setItem("tajiri-remembered-signature", "deadbeef");
        win.eval(source);
        expect(win.document.getElementById("loginIdentity").value).toBe("");
        expect(win.document.getElementById("rememberLogin").checked).toBe(
          false,
        );
      });
    });
  });

  describe("modal and tab interactions", () => {
    it("opens the modal from a [data-modal-open] trigger and switches tabs", () => {
      const dom = loadWelcomePage();
      const doc = dom.window.document;
      const trigger = doc.createElement("button");
      trigger.dataset.modalOpen = "modal-access";
      trigger.dataset.authTab = "login";
      doc.body.appendChild(trigger);
      click(dom, "button[data-modal-open]");
      expect(doc.getElementById("modal-access").hidden).toBe(false);
    });

    it("switches to the signup tab via [data-tab] clicks when cloud auth is ready", () => {
      const dom = loadWelcomePage({
        url: "https://pos.example.test/welcome.html?roleShell=admin",
        stubs: makeFirebaseStubs(),
      });
      const doc = dom.window.document;
      expect(doc.getElementById("tabSignup").hidden).toBe(false);
      doc.getElementById("tabLogin").dataset.tab = "signup";
      click(dom, "#tabLogin");
      expect(
        doc.getElementById("signupForm").classList.contains("active"),
      ).toBe(true);
      expect(doc.querySelector(".modal-head h2").textContent).toBe(
        "Create your shop account",
      );
    });

    it("closes open modals on the Escape key", () => {
      const dom = loadWelcomePage();
      const doc = dom.window.document;
      const modal = doc.getElementById("modal-access");
      modal.hidden = false;
      doc.dispatchEvent(
        new dom.window.KeyboardEvent("keydown", {
          key: "Escape",
          bubbles: true,
        }),
      );
      expect(modal.hidden).toBe(true);
    });

    it("toggles the nav menu on button clicks", () => {
      const dom = loadWelcomePage();
      const doc = dom.window.document;
      const button = doc.getElementById("navMoreBtn");
      const menu = doc.getElementById("navMoreMenu");
      button.dispatchEvent(
        new dom.window.MouseEvent("click", { bubbles: true }),
      );
      expect(menu.hidden).toBe(false);
      expect(button.getAttribute("aria-expanded")).toBe("true");
      button.dispatchEvent(
        new dom.window.MouseEvent("click", { bubbles: true }),
      );
      expect(menu.hidden).toBe(true);
      expect(button.getAttribute("aria-expanded")).toBe("false");
    });

    it("opens the password-reset modal from the forgot link", () => {
      const dom = loadWelcomePage();
      click(dom, "#forgotLink");
      expect(
        dom.window.document.getElementById("modal-password-reset").hidden,
      ).toBe(false);
    });
  });

  describe("local (non-cloud) login", () => {
    it("rejects empty credentials with a local-specific message", () => {
      const dom = loadWelcomePage();
      submitForm(dom, "loginForm");
      expect(textOfError(dom, "loginError").text).toBe(
        "Enter your email address and password.",
      );
    });

    it("rejects an unknown username", async () => {
      const dom = loadWelcomePage();
      const doc = dom.window.document;
      doc.getElementById("loginIdentity").value = "nobody";
      doc.getElementById("loginPassword").value = "hunter22";
      submitForm(dom, "loginForm");
      await flush();
      expect(textOfError(dom, "loginError").text).toBe(
        "That username/email and password combination was not found.",
      );
    });

    it("rejects a wrong password for a known account", async () => {
      const dom = loadWelcomePage();
      const win = dom.window;
      win.localStorage.setItem(
        "tajiri-pos-accounts",
        JSON.stringify([
          {
            username: "ada",
            email: "ada@example.test",
            passwordHash: "nope",
            role: "admin",
          },
        ]),
      );
      docSetup(dom);
      docSetupLogin(dom, "ada", "hunter22");
      submitForm(dom, "loginForm");
      await flush();
      expect(textOfError(dom, "loginError").text).toBe(
        "That username/email and password combination was not found.",
      );
      expect(win.__location.reload).not.toHaveBeenCalled();
    });

    it("rejects accounts without an authorized POS role", async () => {
      const dom = loadWelcomePage();
      const win = dom.window;
      win.localStorage.setItem(
        "tajiri-pos-accounts",
        JSON.stringify([
          {
            username: "ada",
            passwordHash: expectedPasswordHash(win, "s3cret!"),
            role: "manager",
          },
        ]),
      );
      docSetupLogin(dom, "ada", "s3cret!");
      submitForm(dom, "loginForm");
      await flush();

      expect(textOfError(dom, "loginError").text).toBe(
        "That username/email and password combination was not found.",
      );
      expect(win.sessionStorage.getItem("tajiri-session-user")).toBeNull();
      expect(win.__location.reload).not.toHaveBeenCalled();
    });

    it("fails closed when cloud auth is configured but unavailable", async () => {
      const dom = loadWelcomePage({
        stubs: {
          TAJIRI_SUPABASE_CONFIG: {
            url: "https://pos.example.test",
          },
        },
      });
      const win = dom.window;
      win.localStorage.setItem(
        "tajiri-pos-accounts",
        JSON.stringify([
          {
            username: "ada",
            passwordHash: expectedPasswordHash(win, "s3cret!"),
            role: "admin",
          },
        ]),
      );
      docSetupLogin(dom, "ada", "s3cret!");
      submitForm(dom, "loginForm");
      await flush();

      expect(textOfError(dom, "loginError").text).toBe(
        "Cloud authentication could not be verified. Check your connection and try again.",
      );
      expect(win.sessionStorage.getItem("tajiri-session-user")).toBeNull();
      expect(win.__location.reload).not.toHaveBeenCalled();
    });

    it("accepts matching credentials and starts a session", async () => {
      const dom = loadWelcomePage();
      const win = dom.window;
      const passwordHash = expectedPasswordHash(win, "s3cret!");
      win.localStorage.setItem(
        "tajiri-pos-accounts",
        JSON.stringify([
          {
            username: "ada",
            email: "ada@example.test",
            passwordHash,
            role: "admin",
          },
        ]),
      );
      const doc = win.document;
      doc.getElementById("loginIdentity").value = "  Ada  "; // case/trim tolerant
      doc.getElementById("loginPassword").value = "s3cret!";
      doc.getElementById("rememberLogin").checked = true;
      submitForm(dom, "loginForm");
      await flush();

      expect(win.sessionStorage.getItem("tajiri-session-user")).toBe("ada");
      expect(win.sessionStorage.getItem("tajiri-session-role")).toBe("admin");
      expect(win.sessionStorage.getItem("tajiri-session-signature")).toBe(
        sessionSignature("ada", "admin"),
      );
      // Remembered credentials persist beyond the session.
      expect(win.localStorage.getItem("tajiri-remembered-user")).toBe("ada");
    });

    it("clears remembered credentials when 'remember me' is unchecked", async () => {
      const dom = loadWelcomePage();
      const win = dom.window;
      win.localStorage.setItem("tajiri-remembered-user", "stale-user");
      win.localStorage.setItem(
        "tajiri-pos-accounts",
        JSON.stringify([
          {
            username: "ada",
            passwordHash: expectedPasswordHash(win, "s3cret!"),
            role: "cashier",
          },
        ]),
      );
      const doc = win.document;
      doc.getElementById("loginIdentity").value = "ada";
      doc.getElementById("loginPassword").value = "s3cret!";
      submitForm(dom, "loginForm");
      await flush();

      expect(win.localStorage.getItem("tajiri-remembered-user")).toBeNull();
      expect(win.sessionStorage.getItem("tajiri-session-role")).toBe("cashier");
    });

    it("matches login identity against email and name fields too", async () => {
      const dom = loadWelcomePage();
      const win = dom.window;
      win.localStorage.setItem(
        "tajiri-pos-accounts",
        JSON.stringify([
          {
            name: "Grace Ochieng",
            email: "grace@example.test",
            passwordHash: expectedPasswordHash(win, "pass123"),
            role: "cashier",
          },
        ]),
      );
      const doc = win.document;
      doc.getElementById("loginIdentity").value = "grace@example.test";
      doc.getElementById("loginPassword").value = "pass123";
      submitForm(dom, "loginForm");
      await flush();

      expect(win.sessionStorage.getItem("tajiri-session-user")).toBe(
        "grace@example.test",
      );
    });
  });

  describe("signup validation (cloud required)", () => {
    it("blocks signup entirely when Supabase is unavailable", async () => {
      const dom = loadWelcomePage({
        url: "https://pos.example.test/welcome.html?roleShell=admin",
      });
      submitForm(dom, "signupForm");
      await flush();
      expect(textOfError(dom, "signupError").text).toBe(
        "Cloud account setup is unavailable. Check Supabase Authentication and the Tajiri POS schema, then refresh.",
      );
    });

    it("requires every field", async () => {
      const dom = loadWelcomePage({
        url: "https://pos.example.test/welcome.html?roleShell=admin",
        stubs: makeFirebaseStubs(),
      });
      submitForm(dom, "signupForm");
      await flush();
      expect(textOfError(dom, "signupError").text).toBe(
        "Enter your shop name and complete all required fields.",
      );
    });

    it("derives a safe username from the account email without confirmation", async () => {
      const stubs = makeFirebaseStubs();
      const dom = loadWelcomePage({
        url: "https://pos.example.test/welcome.html?roleShell=admin",
        stubs,
      });
      await flush();
      fillSignup(dom, { email: "ada+shop@example.test" });
      submitForm(dom, "signupForm");
      await flush();
      expect(stubs.firebaseDb.createShopForCurrentUser).toHaveBeenCalledWith(
        expect.objectContaining({
          username: expect.stringMatching(/^adashop-/),
          email: "ada+shop@example.test",
        }),
      );
    });

    it("rejects malformed emails", async () => {
      const dom = loadWelcomePage({
        url: "https://pos.example.test/welcome.html?roleShell=admin",
        stubs: makeFirebaseStubs(),
      });
      fillSignup(dom, { email: "not-an-email" });
      submitForm(dom, "signupForm");
      await flush();
      expect(textOfError(dom, "signupError").text).toBe(
        "Enter a valid contact email address.",
      );
    });

    it("creates an email-auth account and shop when Supabase returns a session", async () => {
      const stubs = makeFirebaseStubs();
      const dom = loadWelcomePage({
        url: "https://pos.example.test/welcome.html?roleShell=admin",
        stubs,
      });
      await flush();
      fillSignup(dom);
      submitForm(dom, "signupForm");
      await flush();

      expect(stubs.firebaseAuth.createUserWithEmailAndPassword).toHaveBeenCalledWith(
        "ada@example.test",
        "longenough",
        { display_name: "Ada Admin", shop_name: "Amina's Market" },
      );
      expect(stubs.firebaseDb.createShopForCurrentUser).toHaveBeenCalled();
      expect(dom.window.sessionStorage.getItem("tajiri-session-role")).toBe("admin");
    });

    it("rejects passwords shorter than 6 characters", async () => {
      const dom = loadWelcomePage({
        url: "https://pos.example.test/welcome.html?roleShell=admin",
        stubs: makeFirebaseStubs(),
      });
      fillSignup(dom, { password: "abc12" });
      submitForm(dom, "signupForm");
      await flush();
      expect(textOfError(dom, "signupError").text).toBe(
        "Use a password with at least 6 characters.",
      );
    });

    it("rejects mismatched password confirmation", async () => {
      const dom = loadWelcomePage({
        url: "https://pos.example.test/welcome.html?roleShell=admin",
        stubs: makeFirebaseStubs(),
      });
      fillSignup(dom, { password: "longenough", confirmation: "longenough2" });
      submitForm(dom, "signupForm");
      await flush();
      expect(textOfError(dom, "signupError").text).toBe(
        "The passwords do not match.",
      );
    });

  });

  describe("signup with Supabase", () => {
    it("creates the owner profile without confirmation when legacy admin bootstrap exists", async () => {
      const stubs = makeFirebaseStubs();
      // The boot-time check reads system/bootstrap: report that it exists.
      stubs.firebaseDb.collection = () => ({
        doc: () => ({
          get: async () => ({ exists: true, data: () => ({}) }),
          set: vi.fn(),
        }),
      });
      const dom = loadWelcomePage({
        url: "https://pos.example.test/welcome.html?roleShell=admin",
        stubs,
      });
      await flush();
      fillSignup(dom, {});
      submitForm(dom, "signupForm");
      await flush();
      expect(stubs.firebaseAuth.createUserWithEmailAndPassword).toHaveBeenCalled();
      expect(stubs.firebaseDb.createShopForCurrentUser).toHaveBeenCalled();
      expect(dom.window.sessionStorage.getItem("tajiri-session-role")).toBe("admin");
    });

    it("stores a pending profile if immediate shop creation fails", async () => {
      const stubs = makeFirebaseStubs();
      stubs.firebaseDb.createShopForCurrentUser = vi
        .fn()
        .mockRejectedValue(new Error("cloud unavailable"));
      const dom = loadWelcomePage({
        url: "https://pos.example.test/welcome.html?roleShell=admin",
        stubs,
      });
      await flush(); // let the bootstrap check allow signup
      const doc = dom.window.document;
      expect(doc.getElementById("tabSignup").hidden).toBe(false);

      fillSignup(dom, { password: "longenough", confirmation: "longenough" });
      submitForm(dom, "signupForm");
      await flush();

      expect(stubs.firebaseAuth.createUserWithEmailAndPassword).toHaveBeenCalledWith(
        "ada@example.test",
        "longenough",
        {
          display_name: "Ada Admin",
          shop_name: "Amina's Market",
        },
      );
      expect(stubs.firebaseDb.createShopForCurrentUser).toHaveBeenCalled();
      expect(
        dom.window.localStorage.getItem("tajiri-pending-admin-profile"),
      ).not.toBeNull();
      expect(textOfError(dom, "signupError").text).toContain(
        "Your Supabase account was created, but shop setup did not finish",
      );
    });

    it("asks the owner to confirm email before creating the shop", async () => {
      const stubs = makeFirebaseStubs();
      stubs.firebaseAuth.createUserWithEmailAndPassword = vi.fn().mockResolvedValue({
        user: { uid: "uid-new", email: "ada@example.test" },
        confirmationRequired: true,
      });
      const dom = loadWelcomePage({
        url: "https://pos.example.test/admin.html?roleShell=admin",
        stubs,
      });
      await flush();
      fillSignup(dom);
      submitForm(dom, "signupForm");
      await flush();

      const doc = dom.window.document;
      expect(stubs.firebaseAuth.createUserWithEmailAndPassword).toHaveBeenCalledWith(
        "ada@example.test",
        "longenough",
        { display_name: "Ada Admin", shop_name: "Amina's Market" },
      );
      expect(doc.getElementById("signupConfirmationNotice").hidden).toBe(false);
      expect(doc.getElementById("signupConfirmationEmail").textContent).toBe(
        "ada@example.test",
      );
      expect(stubs.firebaseDb.createShopForCurrentUser).not.toHaveBeenCalled();
      expect(dom.window.sessionStorage.getItem("tajiri-session-role")).toBeNull();
      expect(
        JSON.parse(
          dom.window.localStorage.getItem("tajiri-pending-admin-profile"),
        ),
      ).toMatchObject({
        shopName: "Amina's Market",
        email: "ada@example.test",
      });
    });

    it("explains when shop setup still expects phone authentication", async () => {
      const stubs = makeFirebaseStubs();
      stubs.firebaseDb.createShopForCurrentUser = vi
        .fn()
        .mockRejectedValue(
          new Error("A signed-in phone account is required to create a shop."),
        );
      const dom = loadWelcomePage({
        url: "https://pos.example.test/welcome.html?roleShell=admin",
        stubs,
      });
      await flush();
      fillSignup(dom, { password: "longenough", confirmation: "longenough" });
      submitForm(dom, "signupForm");
      await flush();

      expect(textOfError(dom, "signupError").text).toContain(
        "Apply supabase-email-auth-migration.sql",
      );
      expect(textOfError(dom, "signupError").text).toContain(
        "Do not create another account",
      );
    });

    it("explains when Supabase email sign-ups are disabled", async () => {
      const stubs = makeFirebaseStubs();
      stubs.firebaseAuth.createUserWithEmailAndPassword = vi
        .fn()
        .mockRejectedValue(
          Object.assign(new Error("signup disabled"), {
            code: "auth/signup-disabled",
          }),
        );
      const dom = loadWelcomePage({
        url: "https://pos.example.test/welcome.html?roleShell=admin",
        stubs,
      });
      await flush();
      fillSignup(dom, { password: "longenough", confirmation: "longenough" });
      submitForm(dom, "signupForm");
      await flush();

      expect(textOfError(dom, "signupError").text).toContain(
        "Email sign-up is disabled in Supabase Authentication",
      );
    });

    it("explains when the signup email is already registered", async () => {
      const stubs = makeFirebaseStubs();
      stubs.firebaseAuth.createUserWithEmailAndPassword = vi
        .fn()
        .mockRejectedValue(
          Object.assign(new Error("already used"), {
            code: "auth/email-already-in-use",
          }),
        );
      const dom = loadWelcomePage({
        url: "https://pos.example.test/welcome.html?roleShell=admin",
        stubs,
      });
      await flush();
      fillSignup(dom);
      submitForm(dom, "signupForm");
      await flush();

      expect(textOfError(dom, "signupError").text).toBe(
        "An account already exists for this email. Use a different contact email.",
      );
    });
  });

  describe("Supabase login", () => {
    it("requires a valid email for cloud sign-in", async () => {
      const stubs = makeFirebaseStubs();
      const dom = loadWelcomePage({ stubs });
      const doc = dom.window.document;
      doc.getElementById("loginIdentity").value = "not-an-email";
      doc.getElementById("loginPassword").value = "whatever";
      submitForm(dom, "loginForm");
      await flush();
      expect(textOfError(dom, "loginError").text).toBe(
        "Sign in with the email address set by your administrator.",
      );
      expect(doc.getElementById("loginSubmit").disabled).toBe(false);
    });

    it("signs out accounts that have no Tajiri POS role", async () => {
      const stubs = makeFirebaseStubs();
      // No profile exists for the signed-in user.
      stubs.firebaseDb.collection = () => ({
        doc: () => ({
          get: async () => ({ exists: false, data: () => ({}) }),
          set: vi.fn(),
        }),
      });
      const dom = loadWelcomePage({ stubs });
      const doc = dom.window.document;
      doc.getElementById("loginIdentity").value = "ada@example.test";
      doc.getElementById("loginPassword").value = "longenough";
      submitForm(dom, "loginForm");
      await flush();

      expect(stubs.firebaseAuth.signOut).toHaveBeenCalled();
      expect(textOfError(dom, "loginError").text).toBe(
        "This cloud account has no Tajiri POS role. Ask your administrator to create or repair the account.",
      );
      expect(dom.window.__location.reload).not.toHaveBeenCalled();
    });

    it("maps Supabase auth error codes to a friendly message", async () => {
      const stubs = makeFirebaseStubs();
      stubs.firebaseAuth.signInWithEmailAndPassword = vi
        .fn()
        .mockRejectedValue(
          Object.assign(new Error("bad"), { code: "auth/wrong-password" }),
        );
      const dom = loadWelcomePage({ stubs });
      const doc = dom.window.document;
      doc.getElementById("loginIdentity").value = "ada@example.test";
      doc.getElementById("loginPassword").value = "nope";
      submitForm(dom, "loginForm");
      await flush();
      expect(textOfError(dom, "loginError").text).toBe(
        "The email address or password is incorrect.",
      );
    });

    it("explains when Supabase still requires email confirmation", async () => {
      const stubs = makeFirebaseStubs();
      stubs.firebaseAuth.signInWithEmailAndPassword = vi
        .fn()
        .mockRejectedValue(
          Object.assign(new Error("email not confirmed"), {
            code: "auth/email-not-confirmed",
          }),
        );
      const dom = loadWelcomePage({ stubs });
      const doc = dom.window.document;
      doc.getElementById("loginIdentity").value = "ada@example.test";
      doc.getElementById("loginPassword").value = "longenough";
      submitForm(dom, "loginForm");
      await flush();

      expect(textOfError(dom, "loginError").text).toBe(
        "Confirm your email address using the link we sent before signing in.",
      );
    });

    it("does not add a client-side confirmation block to password login", async () => {
      const stubs = makeFirebaseStubs();
      stubs.firebaseAuth.signInWithEmailAndPassword = vi.fn().mockResolvedValue({
        user: {
          uid: "uid-1",
          email: "ada@example.test",
          emailVerified: false,
        },
      });
      stubs.firebaseDb.collection = () => ({
        doc: () => ({
          get: async () => ({
            exists: true,
            data: () => ({
              name: "Ada",
              role: "admin",
              email: "ada@example.test",
              tenant_id: "shop-1",
            }),
          }),
          set: vi.fn(),
        }),
      });
      const dom = loadWelcomePage({ stubs });
      const doc = dom.window.document;
      doc.getElementById("loginIdentity").value = "ada@example.test";
      doc.getElementById("loginPassword").value = "longenough";
      submitForm(dom, "loginForm");
      await flush();

      expect(stubs.firebaseAuth.signOut).not.toHaveBeenCalled();
      expect(dom.window.sessionStorage.getItem("tajiri-session-role")).toBe("admin");
    });

    it("starts a session for a verified admin profile", async () => {
      const stubs = makeFirebaseStubs();
      stubs.firebaseDb.collection = () => ({
        doc: () => ({
          get: async () => ({
            exists: true,
            data: () => ({
              name: "Ada",
              role: "admin",
              email: "ada@example.test",
              tenant_id: "shop-1",
            }),
          }),
          set: vi.fn(),
        }),
      });
      const dom = loadWelcomePage({ stubs });
      const doc = dom.window.document;
      doc.getElementById("loginIdentity").value = "ada@example.test";
      doc.getElementById("loginPassword").value = "longenough";
      submitForm(dom, "loginForm");
      await flush();

      expect(dom.window.sessionStorage.getItem("tajiri-session-role")).toBe(
        "admin",
      );
      expect(
        dom.window.sessionStorage.getItem("tajiri-session-signature"),
      ).toBe(sessionSignature("ada@example.test", "admin"));
    });

    it("creates a tenant when the email-confirmed owner logs in", async () => {
      const stubs = makeFirebaseStubs();
      stubs.firebaseAuth.signInWithEmailAndPassword = vi.fn().mockResolvedValue({
        user: {
          uid: "uid-1",
          email: "ada@example.test",
          emailVerified: true,
          displayName: "Ada",
        },
      });
      stubs.firebaseDb.collection = () => ({
        doc: () => ({
          get: async () => ({ exists: false, data: () => ({}) }),
        }),
      });
      const dom = loadWelcomePage({
        url: "https://pos.example.test/admin.html?roleShell=admin",
        stubs,
      });
      const win = dom.window;
      win.localStorage.setItem(
        "tajiri-pending-admin-profile",
        JSON.stringify({
          shopName: "Amina's Market",
          name: "Ada Admin",
          username: "ada-uid-1",
          email: "ada@example.test",
          phone: "",
        }),
      );
      win.document.getElementById("loginIdentity").value = "ada@example.test";
      win.document.getElementById("loginPassword").value = "longenough";
      submitForm(dom, "loginForm");
      await flush();

      expect(stubs.firebaseDb.createShopForCurrentUser).toHaveBeenCalledWith({
        shopName: "Amina's Market",
        name: "Ada Admin",
        username: "ada-uid-1",
        email: "ada@example.test",
        phone: "",
      });
      expect(
        win.localStorage.getItem("tajiri-pos-accounts:shop-new"),
      ).toContain('"tenant_id":"shop-new"');
      expect(win.localStorage.getItem("tajiri-pending-admin-profile")).toBeNull();
      expect(win.sessionStorage.getItem("tajiri-session-role")).toBe("admin");
    });
  });

  describe("password reset", () => {
    it("reports that reset delivery is not configured without Supabase", async () => {
      const dom = loadWelcomePage();
      submitForm(dom, "passwordResetForm");
      await flush();
      expect(textOfError(dom, "passwordResetError").text).toBe(
        "Password reset delivery is not configured. Contact your store administrator.",
      );
    });

    describe("email password setup", () => {
      it("sets a password only from an authenticated and confirmed email link", async () => {
        const stubs = makeFirebaseStubs();
        stubs.firebaseAuth.currentUser = {
          uid: "uid-1",
          email: "ada@example.test",
          emailVerified: true,
        };
        const dom = loadWelcomePage({
          url: "https://pos.example.test/index.html?roleShell=cashier&setPassword=1&login=1",
          stubs,
        });
        await flush();
        const doc = dom.window.document;
        doc.getElementById("setPasswordInput").value = "newsecurepass";
        doc.getElementById("setPasswordConfirmation").value = "newsecurepass";
        submitForm(dom, "setPasswordForm");
        await flush();

        expect(stubs.firebaseAuth.updatePassword).toHaveBeenCalledWith(
          "newsecurepass",
        );
        expect(stubs.firebaseAuth.signOut).toHaveBeenCalled();
        expect(doc.getElementById("loginIdentity").value).toBe("ada@example.test");
        expect(new URL(dom.window.location.href).searchParams.has("setPassword"))
          .toBe(false);
      });
    });

    it("sends a password reset email link", async () => {
      const stubs = makeFirebaseStubs();
      const dom = loadWelcomePage({ stubs });
      const doc = dom.window.document;
      doc.getElementById("modal-password-reset").hidden = false;
      doc.getElementById("passwordResetIdentity").value = "ada@example.test";
      submitForm(dom, "passwordResetForm");
      await flush();
      expect(stubs.firebaseAuth.sendPasswordResetEmail).toHaveBeenCalledWith(
        "ada@example.test",
      );
      expect(textOfError(dom, "passwordResetError").text).toContain(
        "Supabase will send a password reset link.",
      );
    });

    it("shows an error when reset email delivery fails", async () => {
      const stubs = makeFirebaseStubs();
      stubs.firebaseAuth.sendPasswordResetEmail = vi
        .fn()
        .mockRejectedValue(new Error("network unavailable"));
      const dom = loadWelcomePage({ stubs });
      docSetup(dom);
      dom.window.document.getElementById("passwordResetIdentity").value =
        "ada@example.test";
      submitForm(dom, "passwordResetForm");
      await flush();
      expect(textOfError(dom, "passwordResetError").text).toBe(
        "Could not reach Supabase. Check your internet connection and try again.",
      );
    });

  });

  describe("password strength meter", () => {
    function meterFor(dom, password) {
      const doc = dom.window.document;
      const input = doc.getElementById("signupPassword");
      input.value = password;
      input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
      return {
        hidden: doc.getElementById("passwordStrength").hidden,
        width: doc.getElementById("strengthFill").style.width,
        label: doc.getElementById("strengthLabel").textContent,
      };
    }

    it("hides the meter for an empty password", () => {
      const dom = loadWelcomePage();
      expect(meterFor(dom, "").hidden).toBe(true);
    });

    it("scores an all-lowercase short password as 'Very weak'", () => {
      const dom = loadWelcomePage();
      const meter = meterFor(dom, "abc");
      expect(meter.label).toBe("Very weak");
      expect(meter.width).toBe("0%");
    });

    it("scores a strong password at the top level", () => {
      const dom = loadWelcomePage();
      const meter = meterFor(dom, "Sup3r$ecret");
      expect(meter.label).toBe("Strong");
      expect(meter.width).toBe("100%");
    });

    it("caps the score at 4 levels", () => {
      const dom = loadWelcomePage();
      const meter = meterFor(dom, "Abcdefgh1!@#$");
      expect(meter.label).toBe("Strong");
      expect(meter.width).toBe("100%");
    });

    it("gives a medium password an intermediate level and color", () => {
      const dom = loadWelcomePage();
      const meter = meterFor(dom, "abcdefgh1");
      expect(meter.label).toBe("Fair");
      expect(meter.width).toBe("50%");
    });
  });

  describe("admin setup status messaging", () => {
    it("allows admin signup when cloud auth is ready without a legacy bootstrap check", async () => {
      const stubs = makeFirebaseStubs();
      stubs.firebaseDb.collection = vi.fn(stubs.firebaseDb.collection);
      const dom = loadWelcomePage({
        url: "https://pos.example.test/welcome.html?roleShell=admin",
        stubs,
      });
      await flush();
      expect(dom.window.document.getElementById("tabSignup").hidden).toBe(
        false,
      );
      expect(textOfError(dom, "adminSetupError").hidden).toBe(true);
      expect(stubs.firebaseDb.collection).not.toHaveBeenCalled();
    });
  });
});

/* ---------- test-only utilities ---------- */

function docSetup(dom) {
  // Placeholder kept for readability; nothing to do — jsdom forms dispatch fine.
}

function docSetupLogin(dom, identity, password) {
  const doc = dom.window.document;
  doc.getElementById("loginIdentity").value = identity;
  doc.getElementById("loginPassword").value = password;
}

function fillSignup(
  dom,
  {
    shopName = "Amina's Market",
    name = "Ada Admin",
    email = "ada@example.test",
    password = "longenough",
    confirmation = "longenough",
  } = {},
) {
  const doc = dom.window.document;
  doc.getElementById("signupShopName").value = shopName;
  doc.getElementById("signupName").value = name;
  doc.getElementById("signupEmail").value = email;
  doc.getElementById("signupPassword").value = password;
  doc.getElementById("signupConfirmPassword").value = confirmation;
}
