import test, { mock } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, copyFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, request } from "node:https";
import { mobileTlsOptions, mobileIdentityPackage } from "../src/mobile-tls.js";
import { projectRoot, store } from "../src/shared/storage.js";
import { MobileAccess } from "../src/mobile-access.js";
import { createApp } from "../src/app.js";
import { Service } from "../src/service.js";

function certificates() {
  const root = mkdtempSync(join(tmpdir(), "varshan-cert-test-"));
  mkdirSync(join(root, "scripts"));
  const script = join(root, "scripts/mobile-tls.mjs");
  copyFileSync(join(projectRoot, "scripts/mobile-tls.mjs"), script);
  execFileSync(process.execPath, [script], { stdio: "ignore" });
  return join(root, ".local/mobile-tls");
}

test("mobile TLS rejects missing and untrusted certificates before any HTTP request", async () => {
  const directory = certificates();
  const other = certificates();
  let handled = 0;
  const server = createServer(mobileTlsOptions(directory), (_req, res) => {
    handled++;
    res.end("verified");
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const connect = (identity?: string, bypassServerTrust = false) =>
    new Promise<string>((resolve, reject) => {
      const req = request(
        {
          host: "127.0.0.1",
          port: address.port,
          path: "/",
          agent: false,
          ca: readFileSync(join(directory, "root-ca.pem")),
          rejectUnauthorized: !bypassServerTrust,
          ...(identity
            ? {
                key: readFileSync(join(identity, "phone-key.pem")),
                cert: readFileSync(join(identity, "phone-cert.pem")),
              }
            : {}),
        },
        (res) => {
          let body = "";
          res.on("data", (chunk) => (body += chunk));
          res.on("end", () => resolve(body));
        },
      );
      req.setTimeout(3000, () =>
        req.destroy(new Error("TLS request timed out")),
      );
      req.on("error", reject);
      req.end();
    });
  try {
    await assert.rejects(connect());
    await assert.rejects(connect(undefined, true));
    await assert.rejects(connect(other));
    assert.equal(handled, 0);
    assert.equal(await connect(directory), "verified");
    assert.equal(handled, 1);
    // Verify the export can be imported with the stored password.
    execFileSync(
      "openssl",
      [
        "pkcs12",
        "-in",
        join(directory, "phone-identity.p12"),
        "-passin",
        "file:" + join(directory, "phone-identity-password"),
        "-noout",
      ],
      { stdio: "ignore" },
    );
    const exported = mobileIdentityPackage(directory);
    assert.ok(Buffer.from(exported.package, "base64").length > 0);
    assert.ok(exported.password.length >= 32);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("certificate export is desktop-only and Touch ID protected; uncertified phones cannot consume a code", async () => {
  mock.method(store, "json", (_path: string, fallback: unknown) => fallback);
  mock.method(store, "save", () => {});
  mock.method(store, "csv", () => []);
  const access = new MobileAccess();
  mock.method(access, "addresses", () => ["10.1.2.3"]);
  let approved = false;
  let exports = 0;
  const app = await createApp(new Service(false, { comparisons: {} }), {
    access,
    biometrics: {
      async verify() {
        if (!approved) throw new Error("Touch ID cancelled");
      },
    },
    mobileIdentity: () => {
      exports++;
      return { package: "fixture", password: "fixture" };
    },
  });
  const desktop = { host: "127.0.0.1:8000" };
  const csrf = (
    await app.inject({ headers: desktop, url: "/api/bootstrap" })
  ).json().token;
  const exportIdentity = () =>
    app.inject({
      headers: { ...desktop, "x-varshan-token": csrf },
      method: "POST",
      url: "/api/mobile/identity",
      payload: {},
    });
  try {
    assert.equal((await exportIdentity()).statusCode, 400);
    assert.equal(exports, 0);
    approved = true;
    assert.equal((await exportIdentity()).statusCode, 200);
    assert.equal(exports, 1);
    const code = access.issuePairing().code;
    const paired = mock.method(access, "pair");
    for (const url of [
      "/",
      "/api/health",
      "/api/access/status",
      "/api/access/pair",
      "/api/mobile/identity",
    ]) {
      const res = await app.inject({
        headers: { host: "10.1.2.3:8443", "x-varshan-token": csrf },
        remoteAddress: "10.1.2.4",
        url,
        ...(url.endsWith("pair") || url.endsWith("identity")
          ? { method: "POST", payload: { code } }
          : {}),
      });
      assert.equal(res.statusCode, 403);
    }
    assert.equal(paired.mock.callCount(), 0);
    assert.equal(exports, 1);
  } finally {
    await app.close();
    mock.restoreAll();
  }
});
