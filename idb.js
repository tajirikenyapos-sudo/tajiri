/* Tajiri POS — IndexedDB local database layer.
 *
 * Works as a durable mirror of the POS state so that:
 *  - the product catalogue, sales history, and customer records survive
 *    app restarts and browser storage resets,
 *  - queued offline transactions survive a crash before cloud sync,
 *  - the app can run on a device with limited localStorage quota
 *    (IndexedDB allows hundreds of MB).
 *
 * This file has no dependencies and degrades gracefully: if IndexedDB is
 * unavailable (private mode, old WebView), it reports a null database and
 * the app continues using localStorage as before.
 */
(function (global) {
  "use strict";

  const DB_NAME = "tajiri-pos";
  const DB_VERSION = 1;
  const STORE_SALES = "sales";
  const STORE_PRODUCTS = "products";
  const STORE_CUSTOMERS = "customers";
  const STORE_SYNC_QUEUE = "syncQueue";
  const STORE_STATE = "state";

  let dbPromise = null;

  function openDatabase() {
    if (dbPromise) return dbPromise;
    if (typeof indexedDB === "undefined") {
      dbPromise = Promise.resolve(null);
      return dbPromise;
    }
    dbPromise = new Promise((resolve) => {
      let request;
      try {
        request = indexedDB.open(DB_NAME, DB_VERSION);
      } catch (error) {
        resolve(null);
        return;
      }
      request.onupgradeneeded = (event) => {
        const db = event.target.result;
        if (!db.objectStoreNames.contains(STORE_SALES)) {
          db.createObjectStore(STORE_SALES, { keyPath: "id" });
        }
        if (!db.objectStoreNames.contains(STORE_PRODUCTS)) {
          db.createObjectStore(STORE_PRODUCTS, { keyPath: "id" });
        }
        if (!db.objectStoreNames.contains(STORE_CUSTOMERS)) {
          db.createObjectStore(STORE_CUSTOMERS, { keyPath: "id" });
        }
        if (!db.objectStoreNames.contains(STORE_SYNC_QUEUE)) {
          db.createObjectStore(STORE_SYNC_QUEUE, { autoIncrement: true });
        }
        if (!db.objectStoreNames.contains(STORE_STATE)) {
          db.createObjectStore(STORE_STATE);
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => resolve(null);
      request.onblocked = () => resolve(null);
    });
    return dbPromise;
  }

  function transaction(storeNames, mode) {
    return openDatabase().then((db) => {
      if (!db) return null;
      return db.transaction(storeNames, mode);
    });
  }

  function requestToPromise(request) {
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  function runInStores(storeNames, mode, operations) {
    return transaction(storeNames, mode).then((tx) => {
      if (!tx) return null;
      return new Promise((resolve, reject) => {
        let result;
        try {
          result = operations(tx);
        } catch (error) {
          reject(error);
          return;
        }
        tx.oncomplete = () => resolve(result);
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
      });
    });
  }

  const api = {
    name: "tajiri-pos-idb",
    STORES: {
      SALES: STORE_SALES,
      PRODUCTS: STORE_PRODUCTS,
      CUSTOMERS: STORE_CUSTOMERS,
      SYNC_QUEUE: STORE_SYNC_QUEUE,
      STATE: STORE_STATE,
    },

    /* ---- whole-state persistence (durable mirror of localStorage) ---- */

    async putState(state) {
      return runInStores([STORE_STATE], "readwrite", (tx) => {
        tx.objectStore(STORE_STATE).put(state, "current");
      });
    },

    async getState() {
      const tx = await transaction([STORE_STATE], "readonly");
      if (!tx) return null;
      const value = await requestToPromise(
        tx.objectStore(STORE_STATE).get("current"),
      );
      return value === undefined ? null : value;
    },

    /* ---- product catalogue ---- */

    async replaceProducts(products) {
      return runInStores([STORE_PRODUCTS], "readwrite", (tx) => {
        const store = tx.objectStore(STORE_PRODUCTS);
        store.clear();
        (products || []).forEach((product) => store.put(product));
      });
    },

    async getProducts() {
      const tx = await transaction([STORE_PRODUCTS], "readonly");
      if (!tx) return [];
      return requestToPromise(tx.objectStore(STORE_PRODUCTS).getAll());
    },

    /* ---- customers ---- */

    async replaceCustomers(customers) {
      return runInStores([STORE_CUSTOMERS], "readwrite", (tx) => {
        const store = tx.objectStore(STORE_CUSTOMERS);
        store.clear();
        (customers || []).forEach((customer) => store.put(customer));
      });
    },

    async getCustomers() {
      const tx = await transaction([STORE_CUSTOMERS], "readonly");
      if (!tx) return [];
      return requestToPromise(tx.objectStore(STORE_CUSTOMERS).getAll());
    },

    /* ---- sales history ---- */

    async replaceSales(sales) {
      return runInStores([STORE_SALES], "readwrite", (tx) => {
        const store = tx.objectStore(STORE_SALES);
        store.clear();
        (sales || []).forEach((sale) => store.put(sale));
      });
    },

    async getSales() {
      const tx = await transaction([STORE_SALES], "readonly");
      if (!tx) return [];
      return requestToPromise(tx.objectStore(STORE_SALES).getAll());
    },

    /* ---- offline sync queue ---- */

    async enqueueSync(entry) {
      return runInStores([STORE_SYNC_QUEUE], "readwrite", (tx) => {
        tx.objectStore(STORE_SYNC_QUEUE).put(entry);
      });
    },

    async getSyncQueue() {
      const tx = await transaction([STORE_SYNC_QUEUE], "readonly");
      if (!tx) return [];
      return requestToPromise(tx.objectStore(STORE_SYNC_QUEUE).getAll());
    },

    async clearSyncQueue() {
      return runInStores([STORE_SYNC_QUEUE], "readwrite", (tx) => {
        tx.objectStore(STORE_SYNC_QUEUE).clear();
      });
    },

    /* ---- housekeeping ---- */

    async clearAll() {
      return runInStores(
        [
          STORE_SALES,
          STORE_PRODUCTS,
          STORE_CUSTOMERS,
          STORE_SYNC_QUEUE,
          STORE_STATE,
        ],
        "readwrite",
        (tx) => {
          [
            STORE_SALES,
            STORE_PRODUCTS,
            STORE_CUSTOMERS,
            STORE_SYNC_QUEUE,
            STORE_STATE,
          ].forEach((name) => tx.objectStore(name).clear());
        },
      );
    },
  };
  global.TajiriIdb = api;
})(typeof window !== "undefined" ? window : this);
