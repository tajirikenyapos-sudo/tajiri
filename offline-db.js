/* Tajiri POS — IndexedDB offline queue and local cache.
 *
 * A tiny promise wrapper around IndexedDB. Exposes window.TajiriIdb with:
 *   enqueueSync(entry)  — append a pending cloud-state snapshot.
 *   dequeueSync()       — remove and return all queued entries (oldest first).
 *   cacheCatalog(rows)  — cache the product catalogue for offline browsing.
 *   loadCatalog()       — read the cached product catalogue.
 *
 * Designed to survive app restarts, which localStorage alone may not in
 * every environment (and which is limited to ~5 MB).
 */
(function () {
  "use strict";

  const DB_NAME = "tajiri-pos";
  const DB_VERSION = 1;
  const STORE_SYNC_QUEUE = "syncQueue";
  const STORE_CATALOG = "catalog";
  const STORE_SALES = "sales";
  const STORE_CUSTOMERS = "customers";
  const STORE_STAFF = "staff";
  const STORE_SETTINGS = "settings";

  let dbPromise = null;

  function openDb() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      if (!("indexedDB" in self)) {
        reject(new Error("IndexedDB is not available in this environment."));
        return;
      }
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(STORE_SYNC_QUEUE)) {
          db.createObjectStore(STORE_SYNC_QUEUE, { autoIncrement: true });
        }
        if (!db.objectStoreNames.contains(STORE_CATALOG)) {
          db.createObjectStore(STORE_CATALOG, { keyPath: "id" });
        }
        if (!db.objectStoreNames.contains(STORE_SALES)) {
          db.createObjectStore(STORE_SALES, { keyPath: "id" });
        }
        if (!db.objectStoreNames.contains(STORE_CUSTOMERS)) {
          db.createObjectStore(STORE_CUSTOMERS, { keyPath: "id" });
        }
        if (!db.objectStoreNames.contains(STORE_STAFF)) {
          db.createObjectStore(STORE_STAFF, { keyPath: "id" });
        }
        if (!db.objectStoreNames.contains(STORE_SETTINGS)) {
          db.createObjectStore(STORE_SETTINGS, { keyPath: "key" });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
      request.onblocked = () =>
        reject(new Error("IndexedDB upgrade blocked by another tab."));
    });
    return dbPromise;
  }

  function withStore(name, mode, callback) {
    return openDb().then(
      (db) =>
        new Promise((resolve, reject) => {
          const tx = db.transaction(name, mode);
          const store = tx.objectStore(name);
          let result;
          try {
            result = callback(store);
          } catch (error) {
            reject(error);
            return;
          }
          tx.oncomplete = () => resolve(result);
          tx.onerror = () => reject(tx.error);
          tx.onabort = () => reject(tx.error);
        }),
    );
  }

  async function enqueueSync(entry) {
    await withStore(STORE_SYNC_QUEUE, "readwrite", (store) => {
      store.add(entry);
    });
  }

  async function dequeueSync() {
    const entries = [];
    await withStore(STORE_SYNC_QUEUE, "readwrite", (store) => {
      store.openCursor().onsuccess = () => {
        const cursor = store.result;
        if (!cursor) return;
        entries.push(cursor.value);
        cursor.delete();
        cursor.continue();
      };
    });
    return entries;
  }

  async function cacheCatalog(products) {
    if (!Array.isArray(products)) return;
    await withStore(STORE_CATALOG, "readwrite", (store) => {
      store.clear();
      products.forEach((product) => store.put(product));
    });
  }

  async function loadCatalog() {
    return withStore(STORE_CATALOG, "readonly", (store) => store.getAll());
  }

  function putAll(name, rows) {
    if (!Array.isArray(rows)) return Promise.resolve();
    return withStore(name, "readwrite", (store) => {
      store.clear();
      rows.forEach((row) => store.put(row));
    });
  }

  async function saveSales(rows) {
    await putAll(STORE_SALES, rows);
  }
  async function loadSales() {
    return withStore(STORE_SALES, "readonly", (store) => store.getAll());
  }
  async function saveCustomers(rows) {
    await putAll(STORE_CUSTOMERS, rows);
  }
  async function loadCustomers() {
    return withStore(STORE_CUSTOMERS, "readonly", (store) => store.getAll());
  }
  async function saveStaff(rows) {
    await putAll(STORE_STAFF, rows);
  }
  async function loadStaff() {
    return withStore(STORE_STAFF, "readonly", (store) => store.getAll());
  }
  async function saveSettings(value) {
    await withStore(STORE_SETTINGS, "readwrite", (store) => {
      store.put({ key: "settings", value });
    });
  }
  async function loadSettings() {
    const rows = await withStore(STORE_SETTINGS, "readonly", (store) =>
      store.getAll(),
    );
    return rows && rows.length ? rows[0].value : null;
  }

  function clearAll() {
    return openDb().then((db) =>
      Promise.all(
        [
          STORE_SYNC_QUEUE,
          STORE_CATALOG,
          STORE_SALES,
          STORE_CUSTOMERS,
          STORE_STAFF,
          STORE_SETTINGS,
        ].map(
          (name) =>
            new Promise((resolve) => {
              const tx = db.transaction(name, "readwrite");
              tx.objectStore(name).clear();
              tx.oncomplete = resolve;
              tx.onerror = resolve;
            }),
        ),
      ),
    );
  }

  window.TajiriIdb = {
    enqueueSync,
    dequeueSync,
    cacheCatalog,
    loadCatalog,
    saveSales,
    loadSales,
    saveCustomers,
    loadCustomers,
    saveStaff,
    loadStaff,
    saveSettings,
    loadSettings,
    clearAll,
  };
})();
