const fs = require("fs");
const file = "offline-db.js";
let content = fs.readFileSync(file, "utf8");

content = content.replace(
  '  const STORE_CATALOG = "catalog";',
  '  const STORE_CATALOG = "catalog";\n  const STORE_SALES = "sales";\n  const STORE_CUSTOMERS = "customers";\n  const STORE_STAFF = "staff";\n  const STORE_SETTINGS = "settings";',
);

content = content.replace(
  `        if (!db.objectStoreNames.contains(STORE_CATALOG)) {
          db.createObjectStore(STORE_CATALOG, { keyPath: "id" });
        }`,
  `        if (!db.objectStoreNames.contains(STORE_CATALOG)) {
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
        }`,
);

const oldTail = `  async function loadCatalog() {
    return withStore(STORE_CATALOG, "readonly", (store) => store.getAll());
  }

  window.TajiriIdb = {
    enqueueSync,
    dequeueSync,
    cacheCatalog,
    loadCatalog,
  };
})();`;

const newTail = `  async function loadCatalog() {
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
})();`;

if (!content.includes(oldTail)) {
  console.error("TAIL NOT FOUND");
  process.exit(1);
}
content = content.replace(oldTail, newTail);
fs.writeFileSync(file, content, "utf8");
console.log("EXTENDED OK");
