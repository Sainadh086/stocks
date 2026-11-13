import test, { mock } from "node:test";
import assert from "node:assert/strict";
import webpush from "web-push";
import { MobileAccess, privateAddress } from "../src/mobile-access.js";
import { Notifications, permittedPushEndpoint } from "../src/notifications.js";
import { createApp } from "../src/app.js";
import { Service } from "../src/service.js";
import { store } from "../src/shared/storage.js";
function storage() {
  const saved = new Map<string, any>();
  mock.method(store, "json", (path: string, fallback: any) =>
    structuredClone(saved.get(path) ?? fallback),
  );
  mock.method(store, "save", (path: string, value: any) =>
    saved.set(path, structuredClone(value)),
  );
  mock.method(store, "csv", () => []);
  return saved;
}
test("LAN pairing protects APIs, uses single-use codes and secure cookies, and rejects untrusted origins", async () => {
  storage();
  const access = new MobileAccess();
  mock.method(access, "addresses", () => ["10.1.2.3"]);
  mock.method(access, "secure", () => true);
  const app = await createApp(new Service(false, { comparisons: {} }), {
    access,
  });
  const phone = {
    headers: { host: "10.1.2.3:8443" },
    remoteAddress: "10.1.2.4",
  };
  const desktop = {
    headers: { host: "127.0.0.1:8000" },
    remoteAddress: "127.0.0.1",
  };
  try {
    assert.equal(
      (await app.inject({ ...phone, url: "/api/portfolios" })).statusCode,
      401,
    );
    assert.equal(
      (await app.inject({ ...phone, url: "/api/bootstrap" })).statusCode,
      401,
    );
    assert.equal(
      (await app.inject({ ...phone, url: "/api/access/status" })).json()
        .authenticated,
      false,
    );
    mock.method(access, "secure", () => false);
    assert.equal(
      (
        await app.inject({
          ...phone,
          method: "POST",
          url: "/api/access/pair",
          payload: { code: "123456" },
        })
      ).statusCode,
      403,
    );
    mock.method(access, "secure", () => true);
    const code = access.issuePairing().code;
    const paired = await app.inject({
      ...phone,
      method: "POST",
      url: "/api/access/pair",
      payload: { code },
    });
    assert.equal(paired.statusCode, 200);
    const setCookie = String(paired.headers["set-cookie"]);
    assert.match(setCookie, /HttpOnly; Secure; SameSite=Strict/);
    assert.match(setCookie, /Max-Age=43200/);
    const cookie = setCookie.split(";")[0];
    const authorized = { ...phone, headers: { ...phone.headers, cookie } };
    const csrf = (
      await app.inject({ ...authorized, url: "/api/bootstrap" })
    ).json().token;
    const unverifiedReveal = await app.inject({
      ...authorized,
      method: "POST",
      url: "/api/preferences",
      headers: { ...authorized.headers, "x-varshan-token": csrf },
      payload: { privacy_mode: false },
    });
    assert.equal(unverifiedReveal.statusCode, 400);
    assert.match(unverifiedReveal.json().detail, /phone’s Face ID/);
    assert.equal(
      (await app.inject({ ...authorized, url: "/api/accounts" })).statusCode,
      200,
    );
    assert.equal(
      (
        await app.inject({
          ...phone,
          method: "POST",
          url: "/api/access/pair",
          payload: { code },
        })
      ).statusCode,
      400,
    );
    assert.equal(
      (
        await app.inject({
          ...authorized,
          headers: { ...authorized.headers, origin: "https://evil.example" },
          url: "/api/accounts",
        })
      ).statusCode,
      403,
    );
    assert.equal(
      (
        await app.inject({
          ...phone,
          url: "/api/access/status",
          headers: { host: "evil.example" },
        })
      ).statusCode,
      400,
    );
    assert.equal(
      (
        await app.inject({
          ...phone,
          url: "/api/access/status",
          remoteAddress: "8.8.8.8",
        })
      ).statusCode,
      403,
    );
    assert.equal(
      (await app.inject({ ...desktop, url: "/api/mobile/setup" })).statusCode,
      200,
    );
    access.revokeAll();
    assert.equal(
      (await app.inject({ ...authorized, url: "/api/accounts" })).statusCode,
      401,
    );
  } finally {
    await app.close();
    mock.restoreAll();
  }
});
test("pairing codes expire and brute-force attempts are limited", () => {
  storage();
  const access = new MobileAccess();
  try {
    const code = access.issuePairing().code;
    const now = Date.now();
    mock.method(Date, "now", () => now + 6 * 60000);
    assert.throws(() => access.pair(code, "10.1.2.4"), /expired/);
    for (let n = 0; n < 4; n++)
      assert.throws(() => access.pair("000000", "10.1.2.4"), /incorrect/);
    assert.throws(() => access.pair("000000", "10.1.2.4"), /Too many/);
    assert.equal(privateAddress("::ffff:192.168.1.1"), true);
    assert.equal(privateAddress("172.32.1.1"), false);
  } finally {
    mock.restoreAll();
  }
});
test("push events are private, deduplicated, durable and remove expired subscriptions", async () => {
  const saved = storage();
  const notifications = new Notifications();
  const delivered: any[] = [];
  mock.method(
    webpush,
    "sendNotification",
    async (_subscription: any, payload: string) => {
      delivered.push(JSON.parse(payload));
      return { statusCode: 201 };
    },
  );
  const subscription = {
    endpoint: "https://fcm.googleapis.com/fcm/send/fixture",
    keys: {
      p256dh: webpush.generateVAPIDKeys().publicKey,
      auth: Buffer.alloc(16).toString("base64url"),
    },
  };
  try {
    notifications.subscribe(subscription, "device");
    notifications.publish(
      "event-1",
      "Automatic trading started",
      "Backend session active.",
    );
    notifications.publish("event-1", "Duplicate", "Never delivered.");
    await notifications.close();
    assert.equal(delivered.length, 1);
    assert.equal(notifications.status().events.length, 1);
    assert.equal(saved.size, 1);
    const restored = new Notifications();
    assert.equal(restored.status().devices, 1);
    assert.equal(permittedPushEndpoint("https://10.1.2.3/secret"), false);
    assert.equal(permittedPushEndpoint("http://fcm.googleapis.com/"), false);
    assert.equal(
      permittedPushEndpoint("https://web.push.apple.com/fixture"),
      true,
    );
    mock.method(webpush, "sendNotification", async () => {
      throw { statusCode: 410 };
    });
    notifications.publish(
      "event-2",
      "Automatic trading paused",
      "Review the app.",
    );
    await notifications.close();
    assert.equal(notifications.status().devices, 0);
  } finally {
    mock.restoreAll();
  }
});
test("push service outages keep alerts in the outbox and retry without blocking trading", async () => {
  storage();
  const notifications = new Notifications();
  let attempts = 0;
  mock.method(webpush, "sendNotification", async () => {
    attempts++;
    throw { statusCode: 503 };
  });
  try {
    notifications.subscribe(
      {
        endpoint: "https://web.push.apple.com/fixture",
        keys: {
          p256dh: webpush.generateVAPIDKeys().publicKey,
          auth: Buffer.alloc(16).toString("base64url"),
        },
      },
      "device",
    );
    notifications.publish(
      "outage",
      "Trading needs attention",
      "Review the app.",
    );
    await notifications.close();
    assert.equal(attempts, 1);
    assert.ok(notifications.status().delivery_error);
    mock.method(webpush, "sendNotification", async () => ({ statusCode: 201 }));
    notifications.retry();
    await notifications.close();
    assert.equal(notifications.status().delivery_error, null);
  } finally {
    mock.restoreAll();
  }
});

test("one phone session expires at twelve hours and legacy sessions obey the new limit", () => {
  const saved = storage();
  const access = new MobileAccess();
  const start = Date.now();
  let now = start;
  mock.method(Date, "now", () => now);
  try {
    access.pair(access.issuePairing().code, "10.1.2.4");
    assert.equal(access.activeSessions().length, 1);
    assert.equal(access.activeSessions()[0].expires, start + 12 * 3600000);
    assert.throws(() => access.issuePairing(), /already connected/);
    now = start + 12 * 3600000;
    assert.equal(access.activeSessions().length, 0);
    access.pair(access.issuePairing().code, "10.1.2.5");
    assert.equal(saved.get(access.path).length, 1);
    saved.set(access.path, [
      {
        hash: "old",
        created_at: new Date(start).toISOString(),
        expires: start + 7 * 86400000,
      },
      {
        hash: "latest",
        created_at: new Date(now).toISOString(),
        expires: now + 7 * 86400000,
      },
    ]);
    assert.deepEqual(
      access.activeSessions().map((s) => s.hash),
      ["latest"],
    );
    assert.equal(access.activeSessions()[0].expires, now + 12 * 3600000);
  } finally {
    mock.restoreAll();
  }
});
