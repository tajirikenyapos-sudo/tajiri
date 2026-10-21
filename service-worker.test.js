// @vitest-environment node

const fs = require("node:fs");
const vm = require("node:vm");
const { describe, expect, it, vi } = await import("vitest");

function loadServiceWorker(fetchImpl) {
  const listeners = {};
  const entries = new Map();
  const cache = {
    async addAll(urls) {
      urls.forEach(url => entries.set(url, { url, cached: true }));
    },
    async put(request, response) {
      entries.set(request.url, response);
    },
    async match(request, options = {}) {
      const url = new URL(typeof request === "string" ? request : request.url);
      for (const [key, value] of entries) {
        const cachedUrl = new URL(key);
        if (
          cachedUrl.origin === url.origin &&
          cachedUrl.pathname === url.pathname &&
          (options.ignoreSearch || cachedUrl.search === url.search)
        ) {
          return value;
        }
      }
      return undefined;
    },
  };
  const caches = {
    open: vi.fn(async () => cache),
    match: (request, options) => cache.match(request, options),
    keys: async () => ["tajiri-pos-shell-v2"],
    delete: vi.fn(async () => true),
  };
  const self = {
    location: new URL("https://pos.example.test/"),
    registration: { scope: "https://pos.example.test/" },
    clients: { claim: vi.fn(async () => {}) },
    addEventListener(type, callback) {
      listeners[type] = callback;
    },
    skipWaiting: vi.fn(async () => {}),
  };

  vm.runInNewContext(
    fs.readFileSync("service-worker.js", "utf8"),
    { caches, console, fetch: fetchImpl, self, URL },
  );
  return { cache, entries, listeners };
}

describe("Tajiri POS offline app shell", () => {
  it("pre-caches the app shell and serves the main page when navigation is offline", async () => {
    const { cache, entries, listeners } = loadServiceWorker(
      vi.fn(async () => {
        throw new Error("offline");
      }),
    );
    let installation;
    listeners.install({
      waitUntil(promise) {
        installation = promise;
      },
    });
    await installation;

    expect(entries.has("https://pos.example.test/main.html")).toBe(true);
    expect(entries.has("https://pos.example.test/app.js")).toBe(true);

    let navigation;
    listeners.fetch({
      request: {
        method: "GET",
        mode: "navigate",
        url: "https://pos.example.test/not-cached.html",
      },
      respondWith(promise) {
        navigation = promise;
      },
    });
    expect(await navigation).toBe(
      await cache.match("https://pos.example.test/main.html"),
    );
  });

  it("serves a cached page for navigation URLs with query parameters while offline", async () => {
    const { cache, listeners } = loadServiceWorker(
      vi.fn(async () => {
        throw new Error("offline");
      }),
    );
    let installation;
    listeners.install({
      waitUntil(promise) {
        installation = promise;
      },
    });
    await installation;

    let navigation;
    listeners.fetch({
      request: {
        method: "GET",
        mode: "navigate",
        url: "https://pos.example.test/admin.html?workspace=admin",
      },
      respondWith(promise) {
        navigation = promise;
      },
    });
    expect(await navigation).toBe(
      await cache.match("https://pos.example.test/admin.html"),
    );
  });
});
