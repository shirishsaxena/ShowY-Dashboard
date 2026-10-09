// Service worker: lets the dashboard install as an app and open its shell offline.
// Network-first for the app files; API responses are never cached.

const CACHE_PREFIX = "showy-dashboard-";
const CACHE = `${CACHE_PREFIX}v2`;
// Keep the complete module graph here: first-visit requests may precede worker control.
const SHELL = [
  "/",
  "/app.css",
  "/favicon.svg",
  "/manifest.webmanifest",
  "/icons/apple-touch-icon.png",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
  "/icons/icon-maskable-512.png",
  "/js/actions.js",
  "/js/api.js",
  "/js/clip.js",
  "/js/dom.js",
  "/js/edit-api.js",
  "/js/loading.js",
  "/js/main.js",
  "/js/qr.js",
  "/js/refresh.js",
  "/js/sortable.js",
  "/js/state.js",
  "/js/status.js",
  "/js/theme.js",
  "/js/utils.js",
  "/js/dialogs/ask.js",
  "/js/dialogs/availability.js",
  "/js/dialogs/common.js",
  "/js/dialogs/icon-picker.js",
  "/js/dialogs/link.js",
  "/js/dialogs/login.js",
  "/js/dialogs/qr.js",
  "/js/dialogs/server.js",
  "/js/dialogs/serverinfo.js",
  "/js/dialogs/service.js",
  "/js/dialogs/settings.js",
  "/js/view/cards.js",
  "/js/view/containers.js",
  "/js/view/favorites.js",
  "/js/view/groups.js",
  "/js/view/links.js",
  "/js/view/loading.js",
  "/js/view/notes.js",
  "/js/view/render.js",
  "/js/view/search.js",
  "/js/view/server.js",
  "/js/view/stats.js",
  "/js/view/switcher.js",
  "/js/view/usage.js",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(SHELL))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter(
              (k) =>
                k === "dashboard-v1" ||
                (k.startsWith(CACHE_PREFIX) && k !== CACHE),
            )
            .map((k) => caches.delete(k)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  const url = new URL(request.url);
  if (
    request.method !== "GET" ||
    url.origin !== location.origin ||
    url.pathname.startsWith("/api/")
  )
    return;

  const network = fetch(request);
  event.waitUntil(
    network
      .then((response) => {
        if (!response.ok) return;
        const copy = response.clone();
        return caches.open(CACHE).then((cache) => cache.put(request, copy));
      })
      .catch(() => {}),
  ); // Cache failures must not discard a successful network response.

  event.respondWith(
    network.catch(async () => {
      try {
        const cache = await caches.open(CACHE);
        return (
          (await cache.match(request)) ||
          (request.mode === "navigate" && (await cache.match("/"))) ||
          Response.error()
        );
      } catch {
        return Response.error();
      }
    }),
  );
});
