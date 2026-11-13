import test, { mock } from "node:test";
import assert from "node:assert/strict";
import {
  mkdirSync,
  writeFileSync,
  existsSync,
  unlinkSync,
  statSync,
} from "node:fs";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { store, type Row } from "../src/shared/storage.js";
import {
  connected,
  closeConnection,
  durableOAuthPath,
} from "../src/brokers/robinhood.js";

// Fake credentials and SDK boundaries: no network, Keychain access or real tokens.
test("broker workflows reuse their helper and checkpoint only durable OAuth credentials, including invalidation", async () => {
  const previousKey = process.env.VARSHAN_ENCRYPTION_KEY;
  process.env.VARSHAN_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");
  let connections = 0,
    closes = 0,
    directory = "";
  let cache: Row = {};
  const saved: Row[] = [];
  mock.method(store, "json", () => structuredClone(cache));
  mock.method(store, "save", (_path: string, value: Row) => {
    cache = structuredClone(value);
    saved.push(cache);
  });
  mock.method(Client.prototype, "connect", async (transport: any) => {
    assert.equal(transport._serverParams.env.VARSHAN_ENCRYPTION_KEY, undefined);
    connections++;
    directory = transport._serverParams.env.MCP_REMOTE_CONFIG_DIR;
    const root = join(directory, "mcp-remote-fixture");
    mkdirSync(root);
    writeFileSync(
      join(root, "hash_tokens.json"),
      JSON.stringify({
        access_token: "fake-access",
        refresh_token: "fake-refresh",
      }),
    );
    writeFileSync(
      join(root, "hash_client_info.json"),
      JSON.stringify({ client_id: "fake-client" }),
    );
    writeFileSync(join(root, "hash_lock.json"), JSON.stringify({ pid: 123 }));
    writeFileSync(join(root, "hash_code_verifier_123.txt"), "fake-verifier");
  });
  mock.method(Client.prototype, "listTools", async () => ({ tools: [] }));
  mock.method(Client.prototype, "close", async function (this: Client) {
    closes++;
    this.onclose?.();
  });
  try {
    await connected(async () => "first");
    const initialWrites = saved.length;
    await connected(async () => "unchanged");
    assert.equal(
      saved.length,
      initialWrites,
      "unchanged credentials must not be encrypted and fsynced on every broker poll",
    );
    await connected(async () => {
      assert.equal(existsSync(directory), true);
      assert.equal(statSync(directory).mode & 0o777, 0o700);
      writeFileSync(
        join(directory, "mcp-remote-fixture/hash_tokens.json"),
        JSON.stringify({ access_token: "fake-refreshed" }),
      );
    });
    assert.equal(connections, 1);
    assert.equal(closes, 0);
    assert.equal(Object.keys(cache).length, 2);
    assert.ok(Object.keys(cache).every(durableOAuthPath));
    assert.equal(
      JSON.parse(
        Buffer.from(
          cache["mcp-remote-fixture/hash_tokens.json"],
          "base64",
        ).toString(),
      ).access_token,
      "fake-refreshed",
    );
    await connected(async () => {
      unlinkSync(join(directory, "mcp-remote-fixture/hash_tokens.json"));
      unlinkSync(join(directory, "mcp-remote-fixture/hash_client_info.json"));
    });
    assert.deepEqual(
      cache,
      {},
      "deleted credentials must replace the encrypted cache rather than resurrecting old tokens",
    );
    await closeConnection();
    assert.equal(closes, 1);
    assert.equal(existsSync(directory), false);
    assert.deepEqual(saved.at(-1), {});
  } finally {
    await closeConnection();
    mock.restoreAll();
    if (previousKey === undefined) delete process.env.VARSHAN_ENCRYPTION_KEY;
    else process.env.VARSHAN_ENCRYPTION_KEY = previousKey;
  }
});

test("OAuth process locks, logs and PKCE verifiers are never restored as credentials", () => {
  for (const path of [
    "mcp-remote-v/hash_tokens.json",
    "mcp-remote-v/hash_client_info.json",
    "mcp-remote-v\\hash_tokens.json",
    "mcp-remote-v\\hash_client_info.json",
  ])
    assert.equal(durableOAuthPath(path), true);
  for (const path of [
    "mcp-remote-v/hash_lock.json",
    "mcp-remote-v/hash_code_verifier_123.txt",
    "debug.log",
  ])
    assert.equal(durableOAuthPath(path), false);
});
