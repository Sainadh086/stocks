import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage, MAGIC } from "../src/shared/storage.js";
import { Vault } from "../src/vault.js";
import { createUnlockApp } from "../src/unlock-app.js";
import type { RememberedKey } from "../src/remembered-key.js";

const password = "my chosen test password 🔐";
function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "varshan password "));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

test("one-time setup remembers the encryption key and restarts without a password", async (t) => {
  const root = fixture(t);
  let remembered: Buffer | undefined;
  const credentials: RememberedKey = {
    read: () => remembered && Buffer.from(remembered),
    write: (key) => {
      remembered = Buffer.from(key);
    },
  };
  const storage = new Storage(root, () => Buffer.alloc(32, 6));
  const vault = new Vault(storage, credentials);
  assert.equal(vault.tryAutoUnlock(), false);
  await vault.setup(password, password);
  const file = join(root, "us_stocks", "private.json");
  storage.save(file, { secret: "still encrypted" });
  const original = readFileSync(file);
  const restarted = new Storage(root);
  assert.equal(new Vault(restarted, credentials).tryAutoUnlock(), true);
  assert.deepEqual(restarted.json(file, null), { secret: "still encrypted" });
  assert.deepEqual(readFileSync(file), original);
  assert.equal(new Vault(new Storage(root)).tryAutoUnlock(), false);
  remembered = Buffer.alloc(32, 8);
  const wrong = new Storage(root);
  assert.equal(new Vault(wrong, credentials).tryAutoUnlock(), false);
  assert.throws(() => wrong.read(file), /Unlock Varshan/);
  remembered = undefined;
  const recovered = new Storage(root);
  await new Vault(recovered, credentials).unlock(password);
  assert.ok(remembered);
  assert.equal(new Vault(new Storage(root), credentials).tryAutoUnlock(), true);
});

test("existing password setup reuses its original remembered key after verifying encrypted data", async (t) => {
  const root = fixture(t);
  const key = Buffer.alloc(32, 5);
  const storage = new Storage(root, () => key);
  const file = join(root, "us_stocks", "private.json");
  storage.save(file, { original: true });
  const vault = new Vault(storage);
  await vault.setup(password, password);
  const saved = JSON.parse(readFileSync(vault.path, "utf8"));
  delete saved.key_check;
  writeFileSync(vault.path, JSON.stringify(saved));
  const credentials = {
    read: () => Buffer.from(key),
    write: () => assert.fail("do not rewrite the key"),
  };
  const restarted = new Storage(root);
  assert.equal(new Vault(restarted, credentials).tryAutoUnlock(), true);
  assert.deepEqual(restarted.json(file, null), { original: true });
  assert.equal(
    new Vault(new Storage(root), {
      ...credentials,
      read: () => Buffer.alloc(32, 2),
    }).tryAutoUnlock(),
    false,
  );
});

test("password setup preserves encrypted files, reopens after restart and never saves the password or raw key", async (t) => {
  const root = fixture(t);
  const key = Buffer.alloc(32, 7);
  const storage = new Storage(root, () => key);
  const file = join(root, "us_stocks", "private.json");
  storage.save(file, { value: "saved account" });
  const original = readFileSync(file);
  const vault = new Vault(storage);
  await assert.rejects(vault.setup("short", "short"), /12 characters/);
  await assert.rejects(vault.setup(password, "a different password"), /match/);
  assert.equal(vault.configured(), false);
  await vault.setup(password, password);
  assert.deepEqual(readFileSync(file), original);
  const saved = readFileSync(vault.path, "utf8");
  assert.ok(!saved.includes(password));
  assert.ok(!saved.includes(key.toString("base64")));
  if (process.platform !== "win32")
    assert.equal(statSync(vault.path).mode & 0o777, 0o600);
  await assert.rejects(vault.setup(password, password), /already configured/);
  const restarted = new Storage(root);
  assert.throws(() => restarted.read(file), /Unlock Varshan/);
  const reopened = new Vault(restarted);
  await assert.rejects(
    reopened.unlock("incorrect password"),
    /Incorrect password/,
  );
  assert.throws(() => restarted.read(file), /Unlock Varshan/);
  assert.equal(readFileSync(vault.path, "utf8"), saved);
  await reopened.unlock(password);
  assert.deepEqual(restarted.json(file, null), { value: "saved account" });
  restarted.save(file, { value: "updated" });
  assert.ok(readFileSync(file).subarray(0, MAGIC.length).equals(MAGIC));
  const another = new Storage(root);
  await new Vault(another).unlock(password);
  assert.deepEqual(another.json(file, null), { value: "updated" });
});

test("first-time setup creates a fresh key without Keychain and migration rejects an incorrect original key", async (t) => {
  const root = fixture(t);
  const previous = process.env.VARSHAN_ENCRYPTION_KEY;
  delete process.env.VARSHAN_ENCRYPTION_KEY;
  try {
    const storage = new Storage(root);
    await new Vault(storage).setup(password, password);
    const file = join(root, "us_stocks", "new.json");
    storage.save(file, { saved: true });
    const restarted = new Storage(root);
    await new Vault(restarted).unlock(password);
    assert.deepEqual(restarted.json(file, null), { saved: true });
    const wrongRoot = fixture(t);
    const privateFile = join(wrongRoot, "us_stocks", "existing.json");
    new Storage(wrongRoot, () => Buffer.alloc(32, 1)).save(privateFile, {
      secret: true,
    });
    const wrong = new Vault(new Storage(wrongRoot, () => Buffer.alloc(32, 2)));
    await assert.rejects(wrong.setup(password, password), /authenticated/);
    assert.equal(wrong.configured(), false);
  } finally {
    if (previous === undefined) delete process.env.VARSHAN_ENCRYPTION_KEY;
    else process.env.VARSHAN_ENCRYPTION_KEY = previous;
  }
});

test("a tampered vault cannot unlock or overwrite saved data", async (t) => {
  const root = fixture(t);
  const vault = new Vault(new Storage(root, () => Buffer.alloc(32, 3)));
  await vault.setup(password, password);
  const saved = JSON.parse(readFileSync(vault.path, "utf8"));
  saved.wrapped = "A".repeat(saved.wrapped.length);
  writeFileSync(vault.path, JSON.stringify(saved));
  await assert.rejects(
    new Vault(new Storage(root)).unlock(password),
    /Incorrect password/,
  );
});

test("locked API blocks account access, cross-site requests, missing tokens and concurrent setup", async (t) => {
  const root = fixture(t);
  let opened = 0;
  const app = createUnlockApp(
    new Vault(new Storage(root, () => Buffer.alloc(32, 9))),
    () => {
      opened++;
    },
  );
  t.after(() => app.close());
  const headers = { host: "127.0.0.1:8000" };
  assert.equal(
    (await app.inject({ url: "/api/accounts", headers })).statusCode,
    423,
  );
  assert.equal(
    (await app.inject({ url: "/", headers: { host: "evil.test" } })).statusCode,
    400,
  );
  const page = await app.inject({ url: "/", headers });
  assert.match(page.body, /Confirm password/);
  assert.equal(page.headers["cache-control"], "no-store");
  const status = (
    await app.inject({ url: "/api/vault/status", headers })
  ).json();
  assert.equal(status.configured, false);
  const payload = { password, confirmation: password };
  assert.equal(
    (
      await app.inject({
        url: "/api/vault/open",
        method: "POST",
        headers,
        payload,
      })
    ).statusCode,
    403,
  );
  const authenticated = { ...headers, "x-varshan-token": status.token };
  assert.equal(
    (
      await app.inject({
        url: "/api/vault/open",
        method: "POST",
        headers: { ...authenticated, origin: "https://evil.test" },
        payload,
      })
    ).statusCode,
    403,
  );
  const results = await Promise.all(
    [1, 2].map(() =>
      app.inject({
        url: "/api/vault/open",
        method: "POST",
        headers: authenticated,
        payload,
      }),
    ),
  );
  assert.deepEqual(
    results.map((result) => result.statusCode).sort(),
    [200, 429],
  );
  assert.equal(opened, 1);
  assert.equal(
    (await app.inject({ url: "/api/health", headers })).json().locked,
    true,
  );
});

test("unlock failures are throttled and leave the server locked", async (t) => {
  const root = fixture(t);
  await new Vault(new Storage(root, () => Buffer.alloc(32, 4))).setup(
    password,
    password,
  );
  const app = createUnlockApp(new Vault(new Storage(root)), () =>
    assert.fail("must stay locked"),
  );
  t.after(() => app.close());
  const headers = { host: "127.0.0.1:8000" };
  const status = (
    await app.inject({ url: "/api/vault/status", headers })
  ).json();
  assert.equal(status.configured, true);
  assert.doesNotMatch(
    (await app.inject({ url: "/", headers })).body,
    /Confirm password/,
  );
  const options = {
    url: "/api/vault/open",
    method: "POST" as const,
    headers: { ...headers, "x-varshan-token": status.token },
    payload: { password: "wrong long password" },
  };
  assert.equal((await app.inject(options)).statusCode, 400);
  assert.equal((await app.inject(options)).statusCode, 429);
});
