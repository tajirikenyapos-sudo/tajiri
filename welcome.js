(() => {
  const welcomeView = document.querySelector("#welcomeView");
  const accessModal = document.querySelector("#modal-access");
  const toast = document.querySelector("#toast");
  if (!welcomeView || !accessModal) return;

  const normalize = value => String(value || "").trim().toLowerCase();
  let toastTimer;
  let lastFocusedElement = null;
  let adminSignupAllowed = false;
  let emailConfirmationPending = false;
  let pendingSignupEmail = "";

  function showToast(message) {
    if (!toast) return;
    toast.textContent = message;
    toast.classList.add("visible");
    window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => toast.classList.remove("visible"), 3200);
  }

  function readAccounts() {
    try {
      const savedAccounts = localStorage.getItem("tajiri-pos-accounts");
      if (savedAccounts !== null) {
        const accounts = JSON.parse(savedAccounts);
        return Array.isArray(accounts) ? accounts : [];
      }
      const savedState = JSON.parse(localStorage.getItem("tajiri-pos") || "null");
      return Array.isArray(savedState?.users) ? savedState.users : [];
    } catch (error) {
      console.error("Could not read Tajiri POS accounts:", error);
      showToast("Saved account data could not be read on this device.");
      return [];
    }
  }

  function saveAccounts(accounts) {
    try {
      const tenantId = String(window.__tajiriAuthProfile?.tenant_id || "");
      const accountsKey = tenantId
        ? `tajiri-pos-accounts:${tenantId}`
        : "tajiri-pos-accounts";
      const stateKey = tenantId ? `tajiri-pos:${tenantId}` : "tajiri-pos";
      localStorage.setItem(accountsKey, JSON.stringify(accounts));
      const savedState = JSON.parse(localStorage.getItem(stateKey) || "{}");
      localStorage.setItem(stateKey, JSON.stringify({ ...savedState, users: accounts }));
      return true;
    } catch (error) {
      console.error("Could not save Tajiri POS accounts:", error);
      showToast("Could not save the account on this device.");
      return false;
    }
  }

  async function hashPassword(password) {
    if (globalThis.crypto?.subtle) {
      try {
        const bytes = new TextEncoder().encode(password);
        const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
        return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
      } catch (error) {
        console.warn("Web Crypto is unavailable; using the local compatibility hash.", error);
      }
    }
    let hash = 2166136261;
    for (const character of password) hash = Math.imul(hash ^ character.charCodeAt(0), 16777619);
    return `fallback-${(hash >>> 0).toString(16)}`;
  }

  function sessionSignature(user, role) {
    const value = `${String(user || "").trim()}|${String(role || "").trim()}|tajiri-pos-session-v1`;
    let hash = 2166136261;
    for (let index = 0; index < value.length; index += 1) {
      hash = Math.imul(hash ^ value.charCodeAt(index), 16777619);
    }
    return (hash >>> 0).toString(16).padStart(8, "0");
  }

  function startSession(account, remember) {
    const identity = normalize(account.username || account.email || String(account.name || "").replace(/\s+/g, "."));
    const role = normalize(account.role);
    const signature = sessionSignature(identity, role);
    sessionStorage.setItem("tajiri-session-user", identity);
    sessionStorage.setItem("tajiri-session-role", role);
    sessionStorage.setItem("tajiri-session-signature", signature);

    if (remember) {
      localStorage.setItem("tajiri-remembered-user", identity);
      localStorage.setItem("tajiri-remembered-role", role);
      localStorage.setItem("tajiri-remembered-signature", signature);
    } else {
      localStorage.removeItem("tajiri-remembered-user");
      localStorage.removeItem("tajiri-remembered-role");
      localStorage.removeItem("tajiri-remembered-signature");
    }

    window.location.reload();
  }

  function setActiveTab(tabName) {
    if (tabName === "signup" && !adminSignupAllowed) tabName = "login";
    const waitingForConfirmation =
      tabName === "signup" && emailConfirmationPending;
    document.querySelectorAll("#modal-access [data-tab]").forEach(tab => {
      const active = tab.dataset.tab === tabName;
      tab.classList.toggle("active", active);
      tab.setAttribute("aria-selected", String(active));
    });
    document.querySelectorAll("#modal-access .auth-form").forEach(form => {
      const active =
        form.id === `${tabName}Form` &&
        !(form.id === "signupForm" && waitingForConfirmation);
      form.classList.toggle("active", active);
      if (form.id === "signupForm") {
        form.hidden = tabName !== "signup" || waitingForConfirmation;
      }
    });
    const confirmationNotice = document.querySelector(
      "#signupConfirmationNotice",
    );
    if (confirmationNotice) {
      confirmationNotice.hidden = !waitingForConfirmation;
      const email = confirmationNotice.querySelector(
        "#signupConfirmationEmail",
      );
      if (email) email.textContent = pendingSignupEmail;
    }
    const heading = accessModal.querySelector(".modal-head h2");
    if (heading)
      heading.textContent =
        waitingForConfirmation
          ? "Check your email"
          : tabName === "signup"
            ? "Create your shop account"
            : "Sign in to Tajiri POS";
  }

  function openModal(modal, trigger = document.activeElement) {
    if (!modal) return;
    lastFocusedElement = trigger instanceof HTMLElement ? trigger : null;
    modal.hidden = false;
    const firstInput = modal.querySelector("input:not([type=hidden])");
    (firstInput || modal.querySelector("button, a"))?.focus();
  }

  function closeModal(modal) {
    if (!modal) return;
    modal.hidden = true;
    lastFocusedElement?.focus();
  }

  function showError(id, message) {
    const element = document.getElementById(id);
    if (!element) return;
    element.textContent = message;
    element.hidden = false;
  }

  function clearError(id) {
    const element = document.getElementById(id);
    if (element) {
      element.textContent = "";
      element.hidden = true;
    }
  }

  function firebaseAuthErrorMessage(error, action) {
    const backendMessage = String(error?.message || "").toLowerCase();
    const backendCode = String(error?.code || "").toLowerCase();
    if (
      backendMessage.includes("create_shop_for_current_user") ||
      backendMessage.includes("save_shop_state") ||
      backendMessage.includes("current_tenant_id") ||
      backendMessage.includes("shop_state")
    ) {
      return "Shop cloud services are not installed yet. Run the current Tajiri POS Supabase migrations before signing up.";
    }
    if (
      backendMessage.includes("network") ||
      backendMessage.includes("failed to fetch")
    ) {
      return "Could not reach Supabase. Check your internet connection and try again.";
    }
    if (
      error?.code === "PGRST205" ||
      error?.code === "42P01" ||
      backendMessage.includes("schema cache") ||
      backendMessage.includes("does not exist") ||
      backendMessage.includes("could not find the function")
    ) {
      return "The Tajiri POS cloud database is missing. Run the current Tajiri POS Supabase migrations in the Supabase SQL Editor, then refresh.";
    }
    if (backendMessage.includes("first two administrator accounts")) {
      return "The first two administrator accounts have already been created. Sign in with an administrator account.";
    }
    if (
      backendMessage.includes("signed-in phone account is required") ||
      backendMessage.includes("phone auth account is required")
    ) {
      return "Shop setup still uses phone authentication. Apply supabase-email-auth-migration.sql, then sign in with the same email address.";
    }
    if (
      backendCode === "auth/server-error" ||
      backendCode === "database_error" ||
      backendCode === "unexpected_failure" ||
      backendMessage.includes("database error saving new user") ||
      Number(error?.status) >= 500
    ) {
      return "Supabase could not finish account creation because of a server or database error. Check the Supabase Auth logs and database triggers.";
    }
    switch (backendCode) {
      case "auth/invalid-credential":
      case "auth/wrong-password":
      case "auth/user-not-found":
        return "The email address or password is incorrect.";
      case "auth/email-not-confirmed":
        return "Confirm your email address using the link we sent before signing in.";
      case "auth/email-already-in-use":
        return "An account already exists for this email. Use a different contact email.";
      case "auth/invalid-email":
      case "email_address_invalid":
        return "Supabase rejected this email address. Use a valid email address from a supported domain.";
      case "auth/weak-password":
        return "Choose a stronger password with at least 6 characters.";
      case "auth/email-confirmation-required":
        return "Check your email for a confirmation link before signing in.";
      case "auth/email-delivery-not-configured":
        return "Email delivery is not configured. Set up Supabase SMTP before creating accounts.";
      case "auth/too-many-requests":
        return "Supabase has reached its email sending limit. Wait before trying again.";
      case "auth/network-request-failed":
        return "Could not reach Supabase. Check your internet connection and try again.";
      case "auth/operation-not-allowed":
        return "Email sign-in is disabled in Supabase Authentication.";
      case "auth/signup-disabled":
        return "Email sign-up is disabled in Supabase Authentication. Enable email sign-ups, then try again.";
      case "permission-denied":
      case "firestore/permission-denied":
        return action === "signup"
          ? "Could not verify administrator setup. Publish the current Supabase policies, then try again."
          : "Could not verify your account role. Check the Supabase policies and try again.";
      default:
        return action === "signup"
          ? "The account could not be created. Check Supabase Authentication and try again."
          : "Sign-in could not be completed. Check your connection and Supabase setup, then try again.";
    }
  }

  const savedState = (() => {
    try {
      return JSON.parse(localStorage.getItem("tajiri-pos") || "null");
    } catch (error) {
      console.error("Could not read Tajiri POS settings:", error);
      return null;
    }
  })();
  const settings = savedState?.settings || {};
  const searchParams = new URLSearchParams(window.location.search);
  const roleShell = searchParams.get("roleShell")?.toLowerCase();
  const loginRequested = searchParams.get("login") === "1";
  const setPasswordRequested = searchParams.get("setPassword") === "1";
  function setAdminSignupAllowed(allowed) {
    adminSignupAllowed = Boolean(allowed && roleShell === "admin");
    accessModal
      .querySelector(".auth-card")
      ?.classList.toggle("signup-unavailable", !adminSignupAllowed);
    const signupTab = document.querySelector("#tabSignup");
    const signupForm = document.querySelector("#signupForm");
    const signupSwitch = document.querySelector("#signupSwitch");
    const signupRole = document.querySelector("#signupRole");
    const adminSetupButton = document.querySelector("#adminSetupButton");
    if (adminSetupButton) adminSetupButton.hidden = !adminSignupAllowed;
    if (signupTab) {
      signupTab.hidden = !adminSignupAllowed;
      if (adminSignupAllowed) signupTab.textContent = "Create account";
    }
    if (signupForm) signupForm.hidden = !adminSignupAllowed;
    if (signupSwitch) signupSwitch.hidden = !adminSignupAllowed;
    const signupSwitchButton = signupSwitch?.querySelector("button");
    if (signupSwitchButton) {
      signupSwitchButton.textContent = "Create a shop account";
    }
    if (adminSetupButton && adminSignupAllowed) {
      adminSetupButton.textContent = "Create a shop account";
    }
    const signupHeading = signupForm?.querySelector("h2");
    const signupDescription = signupForm?.querySelector(".auth-sub");
    if (adminSignupAllowed) {
      if (signupHeading) signupHeading.textContent = "Create your shop account";
      if (signupDescription) {
        signupDescription.textContent =
          "Create a private shop workspace and sign in with your email and password.";
      }
    }
    if (signupRole) {
      signupRole.value = "admin";
      signupRole.closest("label")?.setAttribute("hidden", "");
    }
  }
  let firebaseEnabled = Boolean(window.firebaseAuth && window.firebaseDb);

  function checkAdminBootstrap() {
    setAdminSignupAllowed(true);
    clearError("adminSetupError");
  }

  function updateBackendAvailability() {
    firebaseEnabled = Boolean(window.firebaseAuth && window.firebaseDb);
    if (firebaseEnabled) {
      checkAdminBootstrap();
      return;
    }
    setAdminSignupAllowed(false);
    if (roleShell === "admin" && !window.__tajiriFirebaseError) {
      showError(
        "adminSetupError",
        "First-time administrator signup requires Supabase Authentication and the Tajiri POS schema.",
      );
    }
  }

  async function waitForBackend() {
    if (firebaseEnabled || !window.__tajiriBackendReady) return firebaseEnabled;
    const initialized = await Promise.race([
      window.__tajiriBackendReady,
      new Promise(resolve => window.setTimeout(() => resolve(null), 8000)),
    ]);
    if (initialized === null) return null;
    updateBackendAvailability();
    return firebaseEnabled;
  }

  if (firebaseEnabled) {
    checkAdminBootstrap();
  } else if (window.__tajiriBackendReady) {
    window.__tajiriBackendReady
      .then(() => {
        updateBackendAvailability();
        if (!firebaseEnabled && window.__tajiriFirebaseError) {
          showToast(window.__tajiriFirebaseError);
        }
      })
      .catch(error => {
        console.error("Could not initialize the sign-in backend:", error);
        updateBackendAvailability();
      });
  } else {
    updateBackendAvailability();
  }
  setActiveTab("login");
  if (roleShell === "admin") {
    const heroTitle = document.querySelector("#welcomeHeroTitle");
    if (heroTitle) heroTitle.textContent = "Admin sign in";
    const welcomeTagline = document.querySelector("#welcomeTagline");
    if (welcomeTagline) {
      welcomeTagline.textContent =
        "Secure access to your store, staff, inventory, and reports.";
    }
    const modalHeading = accessModal.querySelector(".modal-head h2");
    if (modalHeading) modalHeading.textContent = "Admin sign in";
    accessModal.setAttribute("aria-label", "Administrator sign in");
    accessModal
      .querySelector('[role="dialog"]')
      ?.setAttribute("aria-label", "Administrator sign in");
    const loginHeading = document.querySelector("#loginForm h2");
    if (loginHeading) loginHeading.textContent = "Welcome back";
    const loginDescription = document.querySelector("#loginForm .auth-sub");
    if (loginDescription) {
      loginDescription.textContent =
        "Sign in with your administrator email and password.";
    }
    const loginTrigger = document.querySelector(
      '[data-modal-open="modal-access"][data-auth-tab="login"]',
    );
    if (loginTrigger) loginTrigger.textContent = "Admin sign in";
    const signupEmail = document.querySelector("#signupEmail");
    if (signupEmail) signupEmail.placeholder = "you@example.com";
  }
  if (roleShell === "cashier") {
    const heroTitle = document.querySelector("#welcomeHeroTitle");
    if (heroTitle) heroTitle.textContent = "Cashier sign in";
    const modalHeading = accessModal.querySelector(".modal-head h2");
    if (modalHeading) modalHeading.textContent = "Cashier sign in";
    accessModal.setAttribute("aria-label", "Cashier sign in");
    accessModal
      .querySelector('[role="dialog"]')
      ?.setAttribute("aria-label", "Cashier sign in");
    const loginHeading = document.querySelector("#loginForm h2");
    if (loginHeading) loginHeading.textContent = "Ready for your shift?";
    const loginDescription = document.querySelector("#loginForm .auth-sub");
    if (loginDescription)
      loginDescription.textContent =
      "Use the email address and password provided by your administrator.";
  }
  if (setPasswordRequested) {
    const passwordForm = document.querySelector("#setPasswordForm");
    if (passwordForm) {
      document.querySelectorAll("#modal-access .auth-form").forEach(form => {
        form.hidden = true;
        form.classList.remove("active");
      });
      passwordForm.hidden = false;
      passwordForm.classList.add("active");
      openModal(accessModal);
      (async () => {
        try {
          if (!(await waitForBackend())) {
            return showError(
              "setPasswordError",
              "Password setup is unavailable. Check your connection and Supabase configuration.",
            );
          }
          const user = await new Promise((resolve, reject) => {
            let unsubscribe = () => {};
            const timeout = window.setTimeout(() => {
              unsubscribe();
              reject(new Error("Timed out while checking the invited account."));
            }, 10000);
            unsubscribe = window.firebaseAuth.onAuthStateChanged(
              authenticatedUser => {
                window.clearTimeout(timeout);
                unsubscribe();
                resolve(authenticatedUser);
              },
              error => {
                window.clearTimeout(timeout);
                unsubscribe();
                reject(error);
              },
            );
          });
          if (!user?.email) {
            showError(
              "setPasswordError",
              "Open a password reset link or sign in before changing your password.",
            );
            return;
          }
          passwordForm.dataset.email = user.email;
        } catch (error) {
          console.error("Could not verify the password setup link:", error);
          showError(
            "setPasswordError",
            "Could not verify this link. Open a fresh password reset email.",
          );
        }
      })();
    }
  }
  if (window.__tajiriFirebaseError) showToast(window.__tajiriFirebaseError);
  const backendStillLoading = Boolean(
    !firebaseEnabled &&
      window.TAJIRI_SUPABASE_CONFIG?.url &&
      window.__tajiriBackendReady,
  );
  if (!firebaseEnabled && !window.__tajiriFirebaseError && !backendStillLoading) {
    showToast(
      "Cloud sign-in is unavailable. Local accounts only work on this browser.",
    );
  }
  const brand = settings.receiptShopName || settings.storeName || "Tajiri POS";
  const tagline = settings.welcomeTagline || "Smart POS Solutions for Modern Shops";
  document.querySelector("#welcomeBrandName")?.replaceChildren(document.createTextNode(brand));
  document.querySelector("#welcomeFooterBrand")?.replaceChildren(document.createTextNode(brand));
  document.querySelector("#welcomeTagline")?.replaceChildren(document.createTextNode(tagline));
  if (roleShell === "admin") {
    const welcomeTagline = document.querySelector("#welcomeTagline");
    if (welcomeTagline) {
      welcomeTagline.textContent =
        "Secure access to your store, staff, inventory, and reports.";
    }
  } else if (roleShell === "cashier") {
    const welcomeTagline = document.querySelector("#welcomeTagline");
    if (welcomeTagline)
      welcomeTagline.textContent = "Sign in to start your shift and process sales.";
  }
  const heroYear = document.querySelector("#heroYear");
  if (heroYear) heroYear.textContent = String(new Date().getFullYear());
  const heroAccounts = document.querySelector("#heroAccounts");
  if (heroAccounts) {
    heroAccounts.textContent = "";
    heroAccounts.hidden = true;
  }
  if (roleShell === "admin" || roleShell === "cashier" || loginRequested) {
    openModal(accessModal);
  }
  document.addEventListener("click", event => {
    const target = event.target;
    if (!(target instanceof Element)) return;

    const openTrigger = target.closest("[data-modal-open]");
    if (openTrigger) {
      const modal = document.getElementById(openTrigger.dataset.modalOpen);
      if (modal) {
        openModal(modal, openTrigger);
        const tab = openTrigger.dataset.authTab;
        if (tab === "login" || tab === "signup") setActiveTab(tab);
      }
    }

    const tab = target.closest("[data-tab]");
    if (tab && accessModal.contains(tab)) setActiveTab(tab.dataset.tab);

    const switchButton = target.closest("[data-switch]");
    if (switchButton) setActiveTab(switchButton.dataset.switch);

    const passwordToggle = target.closest("[data-password-toggle]");
    if (passwordToggle) {
      const input = document.getElementById(passwordToggle.dataset.passwordToggle);
      if (input instanceof HTMLInputElement) {
        const showPassword = input.type === "password";
        input.type = showPassword ? "text" : "password";
        passwordToggle.textContent = showPassword ? "Hide" : "Show";
        passwordToggle.setAttribute(
          "aria-label",
          `${showPassword ? "Hide" : "Show"} ${input.id === "signupConfirmPassword" ? "confirm password" : "password"}`,
        );
        passwordToggle.setAttribute("aria-pressed", String(showPassword));
      }
    }

    const closeTrigger = target.closest("[data-modal-close]");
    if (closeTrigger) closeModal(closeTrigger.closest(".modal-layer"));

    if (target.classList.contains("modal-layer")) closeModal(target);

    const navButton = target.closest("#navMoreBtn");
    const menu = document.querySelector("#navMoreMenu");
    if (navButton && menu) {
      menu.hidden = !menu.hidden;
      navButton.setAttribute("aria-expanded", String(!menu.hidden));
    } else if (menu && !target.closest("#navMoreMenu")) {
      menu.hidden = true;
      document.querySelector("#navMoreBtn")?.setAttribute("aria-expanded", "false");
    }

    if (target.closest("#forgotLink")) {
      const resetModal = document.querySelector("#modal-password-reset");
      if (resetModal) openModal(resetModal, target.closest("#forgotLink"));
    }

    if (target.closest("#passwordResetResend")) {
      event.preventDefault();
      showToast("Password reset delivery is not configured. Contact your store administrator.");
    }

    if (target.closest("[data-installer-download]")) {
      const downloadsModal = document.querySelector("#modal-downloads");
      if (downloadsModal) {
        event.preventDefault();
        openModal(downloadsModal, target.closest("[data-installer-download]"));
      }
    }
  });

  document.addEventListener("keydown", event => {
    if (event.key === "Escape") {
      document.querySelectorAll(".modal-layer:not([hidden])").forEach(closeModal);
      const menu = document.querySelector("#navMoreMenu");
      if (menu) menu.hidden = true;
      document.querySelector("#navMoreBtn")?.setAttribute("aria-expanded", "false");
    }
  });

  document.querySelector("#loginForm")?.addEventListener("submit", async event => {
    event.preventDefault();
    clearError("loginError");
    const identity = normalize(document.querySelector("#loginIdentity")?.value);
    const password = document.querySelector("#loginPassword")?.value || "";
    if (!identity || !password) {
      return showError(
        "loginError",
        "Enter your email address and password.",
      );
    }

    const submit = document.querySelector("#loginSubmit");
    if (submit) {
      submit.disabled = true;
      submit.textContent = "Checking account…";
    }
    try {
      const backendAvailable = await waitForBackend();
      if (backendAvailable === null) {
        showError(
          "loginError",
          "The sign-in service is still loading. Check your connection and try again.",
        );
        return;
      }
      const cloudUrl = String(window.TAJIRI_SUPABASE_CONFIG?.url || "");
      if (!firebaseEnabled && cloudUrl && !cloudUrl.startsWith("REPLACE_")) {
        showError(
          "loginError",
          "Cloud authentication could not be verified. Check your connection and try again.",
        );
        return;
      }
      if (firebaseEnabled) {
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(identity)) {
          showError("loginError", "Sign in with the email address set by your administrator.");
          return;
        }
        const remember = Boolean(document.querySelector("#rememberLogin")?.checked);
        await window.firebaseAuth.setPersistence(
          remember
            ? firebase.auth.Auth.Persistence.LOCAL
            : firebase.auth.Auth.Persistence.SESSION,
        );
        const credential = await window.firebaseAuth.signInWithEmailAndPassword(
          identity,
          password,
        );
        const profileSnapshot = await window.firebaseDb
          .collection("users")
          .doc(credential.user.uid)
          .get();
        let profile = profileSnapshot.exists
          ? { ...profileSnapshot.data(), uid: credential.user.uid }
          : null;
        if (!profile && roleShell === "admin") {
          let pendingProfile = null;
          try {
            pendingProfile = JSON.parse(
              localStorage.getItem("tajiri-pending-admin-profile") || "null",
            );
          } catch (error) {
            console.error("Could not read pending shop signup details:", error);
          }
          if (
            pendingProfile &&
            normalize(pendingProfile.email) !== normalize(credential.user.email)
          ) {
            pendingProfile = null;
          }
          if (!pendingProfile) {
            pendingProfile =
              window.firebaseDb.profileFromAuthUser?.(credential.user) || null;
          }
          if (pendingProfile) {
            profile = await window.firebaseDb.createShopForCurrentUser(
              pendingProfile,
            );
            localStorage.removeItem("tajiri-pending-admin-profile");
          }
        }
        if (
          !profile ||
          !profile.tenant_id ||
          !["admin", "cashier"].includes(profile.role)
        ) {
          await window.firebaseAuth.signOut();
          showError(
            "loginError",
            "This cloud account has no Tajiri POS role. Ask your administrator to create or repair the account.",
          );
          return;
        }
        window.__tajiriAuthProfile = profile;
        saveAccounts([profile]);
        startSession(profile, remember);
        return;
      }
      const accounts = readAccounts();
      const account = accounts.find(candidate =>
        [candidate.username, candidate.email, candidate.name]
          .filter(Boolean)
          .some(value => normalize(value) === identity)
      );
      if (
        !account ||
        !["admin", "cashier"].includes(normalize(account.role)) ||
        !account.passwordHash ||
        account.passwordHash !== await hashPassword(password)
      ) {
        showError("loginError", "That username/email and password combination was not found.");
        return;
      }
      startSession(account, Boolean(document.querySelector("#rememberLogin")?.checked));
    } catch (error) {
      console.error("Tajiri POS sign-in failed:", error);
      if (firebaseEnabled && window.firebaseAuth.currentUser) {
        try {
          await window.firebaseAuth.signOut();
        } catch (signOutError) {
          console.error("Could not close the failed Firebase sign-in:", signOutError);
        }
      }
      showError("loginError", firebaseAuthErrorMessage(error, "login"));
    } finally {
      if (submit) {
        submit.disabled = false;
        submit.textContent = "Sign in →";
      }
    }
  });

  document.querySelector("#signupForm")?.addEventListener("submit", async event => {
    event.preventDefault();
    clearError("signupError");
    const backendAvailable = await waitForBackend();
    if (backendAvailable === null) {
      showError(
        "signupError",
        "The sign-in service is still loading. Check your connection and try again.",
      );
      return;
    }
    if (!firebaseEnabled) {
      showError(
        "signupError",
        "Cloud account setup is unavailable. Check Supabase Authentication and the Tajiri POS schema, then refresh.",
      );
      return;
    }
    if (roleShell !== "admin" || !adminSignupAllowed) {
      showError("signupError", "Shop registration is unavailable. Sign in or check the cloud setup.");
      return;
    }

    const shopName = document.querySelector("#signupShopName")?.value.trim() || "";
    const name = document.querySelector("#signupName")?.value.trim() || "";
    const email = normalize(document.querySelector("#signupEmail")?.value);
    const password = document.querySelector("#signupPassword")?.value || "";
    const confirmation = document.querySelector("#signupConfirmPassword")?.value || "";
    if (!shopName || !name || !email || !password || !confirmation) {
      return showError("signupError", "Enter your shop name and complete all required fields.");
    }
    if (shopName.length < 2 || shopName.length > 100) {
      return showError("signupError", "Shop name must be between 2 and 100 characters.");
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return showError("signupError", "Enter a valid contact email address.");
    }
    if (password.length < 6) {
      const passwordError = document.querySelector("#passwordValidationError");
      if (passwordError) passwordError.hidden = false;
      document.querySelector("#signupPassword")?.setAttribute("aria-invalid", "true");
      return showError("signupError", "Use a password with at least 6 characters.");
    }
    if (password !== confirmation) return showError("signupError", "The passwords do not match.");
    const usernameBase =
      email
        .split("@")[0]
        .toLowerCase()
        .replace(/[^a-z0-9._-]/g, "")
        .slice(0, 50) || "owner";

    const submit = document.querySelector("#signupSubmit");
    if (submit) {
      submit.disabled = true;
      submit.textContent = "Creating account…";
    }
    let authAccountCreated = false;
    try {
      await window.firebaseAuth.setPersistence(
        firebase.auth.Auth.Persistence.SESSION,
      );
      const credential = await window.firebaseAuth.createUserWithEmailAndPassword(
        email,
        password,
        { display_name: name, shop_name: shopName },
      );
      authAccountCreated = true;
      const username = `${usernameBase}-${credential.user.uid.slice(0, 8)}`;
      const pendingProfile = { shopName, name, username, email, phone: "" };
      localStorage.setItem(
        "tajiri-pending-admin-profile",
        JSON.stringify(pendingProfile),
      );
      if (credential.confirmationRequired) {
        emailConfirmationPending = true;
        pendingSignupEmail = email;
        setActiveTab("signup");
        return;
      }
      const profile = await window.firebaseDb.createShopForCurrentUser(
        pendingProfile,
      );
      window.__tajiriAuthProfile = profile;
      saveAccounts([profile]);
      localStorage.removeItem("tajiri-pending-admin-profile");
      startSession(profile, false);
    } catch (error) {
      console.error("Tajiri POS account creation failed:", error);
      const backendMessage = String(error?.message || "").toLowerCase();
      const setupMessage = backendMessage.includes(
        "signed-in phone account is required",
      )
        ? "Your Supabase account was created, but shop setup still uses phone authentication. Apply supabase-email-auth-migration.sql, then sign in with the same email address. Do not create another account."
        : "Your Supabase account was created, but shop setup did not finish. Sign in with the same email address to retry setup. If it continues, check the Supabase migrations and Auth logs.";
      showError(
        "signupError",
        authAccountCreated
          ? setupMessage
          : firebaseAuthErrorMessage(error, "signup"),
      );
    } finally {
      if (submit) {
        submit.disabled = false;
        submit.textContent = "Create account →";
      }
    }
  });

  document.querySelector("#passwordResetForm")?.addEventListener("submit", async event => {
    event.preventDefault();
    const backendAvailable = await waitForBackend();
    if (backendAvailable === null) {
      showError(
        "passwordResetError",
        "The sign-in service is still loading. Check your connection and try again.",
      );
      return;
    }
    if (!firebaseEnabled) {
      showError("passwordResetError", "Password reset delivery is not configured. Contact your store administrator.");
      return;
    }
    const email = normalize(
      document.querySelector("#passwordResetIdentity")?.value,
    );
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      showError("passwordResetError", "Enter the email address on your account.");
      return;
    }
    try {
      await window.firebaseAuth.sendPasswordResetEmail(email);
      showError(
        "passwordResetError",
        "If an account exists for that email, Supabase will send a password reset link.",
      );
    } catch (error) {
      console.error("Tajiri POS password reset failed:", error);
      showError("passwordResetError", firebaseAuthErrorMessage(error, "reset"));
    }
  });

  document.querySelector("#setPasswordForm")?.addEventListener("submit", async event => {
    event.preventDefault();
    clearError("setPasswordError");
    const passwordForm = document.querySelector("#setPasswordForm");
    const user = window.firebaseAuth?.currentUser;
    const password = document.querySelector("#setPasswordInput")?.value || "";
    const confirmation =
      document.querySelector("#setPasswordConfirmation")?.value || "";
    if (!user?.email) {
      return showError(
        "setPasswordError",
        "Open a password reset link or sign in before changing your password.",
      );
    }
    if (password.length < 6) {
      return showError("setPasswordError", "Use a password with at least 6 characters.");
    }
    if (password !== confirmation) {
      return showError("setPasswordError", "The passwords do not match.");
    }
    const submit = document.querySelector("#setPasswordSubmit");
    if (submit) {
      submit.disabled = true;
      submit.textContent = "Saving…";
    }
    try {
      await window.firebaseAuth.updatePassword(password);
      await window.firebaseAuth.signOut();
      const loginIdentity = document.querySelector("#loginIdentity");
      if (loginIdentity) loginIdentity.value = user.email;
      if (passwordForm) passwordForm.hidden = true;
      setActiveTab("login");
      searchParams.delete("setPassword");
      searchParams.set("login", "1");
      window.history.replaceState(
        null,
        "",
        `${window.location.pathname}?${searchParams.toString()}`,
      );
      showToast("Password saved. Sign in with your email and new password.");
    } catch (error) {
      console.error("Could not save the account password:", error);
      showError(
        "setPasswordError",
        firebaseAuthErrorMessage(error, "reset"),
      );
    } finally {
      if (submit) {
        submit.disabled = false;
        submit.textContent = "Save password";
      }
    }
  });

  document.querySelector("#signupPassword")?.addEventListener("input", event => {
    const meter = document.querySelector("#passwordStrength");
    const fill = document.querySelector("#strengthFill");
    const label = document.querySelector("#strengthLabel");
    const value = event.target.value;
    if (!meter || !fill || !label) return;
    meter.hidden = !value;
    const validationError = document.querySelector("#passwordValidationError");
    const passwordInput = event.target;
    if (value.length >= 6) {
      if (validationError) validationError.hidden = true;
      passwordInput.removeAttribute("aria-invalid");
      clearError("signupError");
    } else if (validationError && !validationError.hidden) {
      passwordInput.setAttribute("aria-invalid", "true");
    }
    const score = Math.min(
      4,
      Number(value.length >= 8) +
        Number(/[A-Z]/.test(value)) +
        Number(/[0-9]/.test(value)) +
        Number(/[^a-zA-Z0-9]/.test(value)),
    );
    const levels = ["Very weak", "Weak", "Fair", "Good", "Strong"];
    const width = value ? (score === 0 ? 0 : Math.max(18, score * 25)) : 0;
    fill.style.width = `${width}%`;
    fill.style.background =
      score < 2 ? "#f08c8c" : score < 4 ? "#e5bd70" : "#79e2ae";
    label.textContent = value ? levels[score] : "Password strength";
  });
  document.querySelector("#signupPassword")?.addEventListener("blur", event => {
    const value = event.target.value;
    const validationError = document.querySelector("#passwordValidationError");
    if (validationError) validationError.hidden = !value || value.length >= 6;
    event.target.toggleAttribute("aria-invalid", Boolean(value && value.length < 6));
  });

  const rememberedIdentity = localStorage.getItem("tajiri-remembered-user");
  const rememberedRole = localStorage.getItem("tajiri-remembered-role");
  const rememberedSignature = localStorage.getItem("tajiri-remembered-signature");
  if (
    rememberedIdentity &&
    rememberedRole &&
    rememberedSignature === sessionSignature(rememberedIdentity, rememberedRole)
  ) {
    const identityField = document.querySelector("#loginIdentity");
    const rememberField = document.querySelector("#rememberLogin");
    if (identityField) identityField.value = rememberedIdentity;
    if (rememberField) rememberField.checked = true;
  }
})();
