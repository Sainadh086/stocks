import test, { mock } from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/app.js";
import { MobileAccess } from "../src/mobile-access.js";
import { Service } from "../src/service.js";
import { store } from "../src/shared/storage.js";

test("Touch ID gates privacy reveal and pairing; cancellation preserves private state and issues no code", async () => {
  const saved = new Map<string, unknown>();
  mock.method(store, "json", (path: string, fallback: unknown) =>
    structuredClone(saved.get(path) ?? fallback),
  );
  mock.method(store, "save", (path: string, data: unknown) =>
    saved.set(path, structuredClone(data)),
  );
  mock.method(store, "csv", () => []);
  const service = new Service(false, { comparisons: {}, privacy_mode: true });
  const access = new MobileAccess();
  mock.method(access, "addresses", () => ["10.1.2.3"]);
  let approved = false;
  const checks: string[] = [];
  const biometrics = {
    async verify(action: string) {
      checks.push(action);
      if (!approved) throw new Error("Touch ID cancelled");
    },
  };
  const issued = mock.method(access, "issuePairing");
  const app = await createApp(service, { access, biometrics });
  const headers = {
    host: "127.0.0.1:8000",
    "x-varshan-token": (
      await app.inject({
        url: "/api/bootstrap",
        headers: { host: "127.0.0.1:8000" },
      })
    ).json().token,
  };
  const send = (url: string, payload: unknown) =>
    app.inject({ url, method: "POST", headers, payload: payload as object });
  try {
    assert.equal(
      (await send("/api/preferences", { privacy_mode: false, theme: "forest" }))
        .statusCode,
      400,
    );
    assert.equal(service.preferences().privacy_mode, true);
    assert.notEqual(service.preferences().theme, "forest");
    assert.equal((await send("/api/mobile/pairing", {})).statusCode, 400);
    assert.equal(issued.mock.callCount(), 0);
    assert.deepEqual(checks, ["privacy", "pair"]);
    assert.equal(
      (await send("/api/preferences", { theme: "midnight" })).statusCode,
      200,
    );
    assert.equal(checks.length, 2);
    approved = true;
    assert.equal(
      (await send("/api/preferences", { privacy_mode: false })).statusCode,
      200,
    );
    assert.equal(service.preferences().privacy_mode, false);
    assert.match(
      (await send("/api/mobile/pairing", {})).json().code,
      /^\d{6}$/,
    );
    assert.equal(issued.mock.callCount(), 1);
    assert.equal(
      (await send("/api/preferences", { privacy_mode: true })).statusCode,
      200,
    );
    assert.deepEqual(checks, ["privacy", "pair", "privacy", "pair"]);
    // A phone cannot cause a new pairing prompt, even when it knows the CSRF token.
    assert.equal(
      (
        await app.inject({
          url: "/api/mobile/pairing",
          method: "POST",
          headers: { ...headers, host: "10.1.2.3:8443" },
          remoteAddress: "10.1.2.4",
          payload: {},
        })
      ).statusCode,
      403,
    );
    assert.equal(checks.length, 4);
  } finally {
    await app.close();
    mock.restoreAll();
  }
});
