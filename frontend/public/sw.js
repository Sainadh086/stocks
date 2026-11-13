self.addEventListener("install", event => event.waitUntil(self.skipWaiting()));
self.addEventListener("activate", event => event.waitUntil(self.clients.claim()));
self.addEventListener("push", event => {
  let data = {};
  try { data = event.data?.json() ?? {}; } catch { /* Always show a visible notification. */ }
  event.waitUntil(self.registration.showNotification(typeof data.title === "string" ? data.title : "Varshan trading alert", {
    body: typeof data.body === "string" ? data.body : "Open Varshan to review your trading session.",
    icon: "/icons/varshan-192.png", badge: "/icons/varshan-192.png", tag: data.id ?? "varshan-alert", data: {url:"/?workspace=trading"},
  }));
});
self.addEventListener("notificationclick", event => {
  event.notification.close();
  event.waitUntil((async () => {
    const target = new URL("/?workspace=trading", self.location.origin).href;
    const windows = await self.clients.matchAll({type:"window",includeUncontrolled:true});
    const existing = windows.find(client => new URL(client.url).origin === self.location.origin);
    if (existing) { await existing.navigate(target); await existing.focus(); }
    else await self.clients.openWindow(target);
  })());
});
// No portfolio data, authentication responses or trading requests are cached.
