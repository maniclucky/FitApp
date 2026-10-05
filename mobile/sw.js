// Service worker for the home-screen (iPhone/iPad) web app: keeps every file of the app on
// the phone so it starts with no connection. The build (vite.config.ts) fills in FILES and
// VERSION and writes the result to dist/sw.js. Never registered in the Android app.
const FILES = __FILES__;
const CACHE = "fitapp-" + __VERSION__;

// Download the whole app before this version takes over. "reload" skips the browser's
// HTTP cache, so a new version never stores stale files.
self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(FILES.map((f) => new Request(f, { cache: "reload" })))),
  );
});

// A new version takes over once every window of the old one has closed (the next app launch),
// so a running app never loses files it may still load. Older versions' files are then removed.
self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k.startsWith("fitapp-") && k !== CACHE).map((k) => caches.delete(k))),
    ),
  );
});

// Serve from the phone; only fall back to the network for something not stored.
// Opening the app (any page load) gets index.html; routes live in the # part of the URL.
self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET" || new URL(request.url).origin !== location.origin) return;
  event.respondWith(
    caches.open(CACHE).then(async (cache) => {
      const hit = request.mode === "navigate"
        ? await cache.match("./index.html")
        : await cache.match(request, { ignoreSearch: true });
      return hit ?? fetch(request);
    }),
  );
});
