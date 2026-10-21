const CACHE_NAME = "tajiri-pos-shell-v8";
const APP_SHELL = [
  "./main.html",
  "./index.html",
  "./admin.html",
  "./cashier.html",
  "./login.html",
  "./styles.css",
  "./welcome.css",
  "./app.js",
  "./welcome.js",
  "./supabase-shim.js",
  "./offline-db.js",
  "./manifest.webmanifest",
  "./icons/tajiri-pos-192.png",
  "./icons/tajiri-pos-512.png",
  "./icons/tajiri-pos.svg",
];

async function cacheResponse(request, response) {
  if (!response.ok || response.type !== "basic") return;
  try {
    const cache = await caches.open(CACHE_NAME);
    await cache.put(request, response.clone());
  } catch (error) {
    console.warn("Could not update the offline cache:", error);
  }
}

self.addEventListener("message", event => {
  if (event.data === "SKIP_WAITING") self.skipWaiting();
});

self.addEventListener("install", event => {
  event.waitUntil(
    Promise.all([
      caches.open(CACHE_NAME).then(cache =>
        cache.addAll(
          APP_SHELL.map(path => new URL(path, self.registration.scope).href),
        ),
      ),
      self.skipWaiting(),
    ]),
  );
});

self.addEventListener("activate", event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys
          .filter(key => key.startsWith("tajiri-pos-shell-") && key !== CACHE_NAME)
          .map(key => caches.delete(key)),
      ),
    ).then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", event => {
  const request = event.request;
  const url = new URL(request.url);
  if (
    request.method !== "GET" ||
    url.origin !== self.location.origin ||
    url.pathname.includes("/api/")
  ) {
    return;
  }

  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request).then(async response => {
        await cacheResponse(request, response);
        return response;
      })
        .catch(async () =>
          (await caches.match(request, { ignoreSearch: true })) ||
          (await caches.match(new URL("./main.html", self.registration.scope).href)),
        ),
    );
    return;
  }

  event.respondWith(
    fetch(request).then(async response => {
      await cacheResponse(request, response);
      return response;
    })
      .catch(() => caches.match(request, { ignoreSearch: true })),
  );
});
