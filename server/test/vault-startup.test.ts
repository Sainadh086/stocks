import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";

test(
  "real entry point requires first-time setup and opens automatically after restart with a remembered key",
  { timeout: 20000 },
  async (t) => {
    const root = mkdtempSync(join(tmpdir(), "varshan startup "));
    const source = fileURLToPath(new URL("../src/", import.meta.url));
    const target = join(root, "server/dist/src");
    mkdirSync(join(target, "shared"), { recursive: true });
    writeFileSync(join(root, "package.json"), '{"type":"module"}');
    symlinkSync(
      fileURLToPath(new URL("../../node_modules", import.meta.url)),
      join(root, "server/node_modules"),
      process.platform === "win32" ? "junction" : "dir",
    );
    for (const file of [
      "index.js",
      "vault.js",
      "remembered-key.js",
      "unlock-app.js",
      "shared/storage.js",
    ])
      copyFileSync(join(source, file), join(target, file));
    writeFileSync(
      join(target, "runtime.js"),
      `
    import Fastify from 'fastify';
    import { writeFileSync } from 'node:fs';
    import { join } from 'node:path';
    import { store, US, processLock } from './shared/storage.js';
    const file=join(US,'fixture.json');
    const value=store.json(file,{secret:'kept across restarts'});
    store.save(file,value);
    writeFileSync(join(store.root,'runtime-started'),'yes');
    const release=processLock(join(US,'.varshan-node.lock'));
    const app=Fastify();
    app.get('/api/health',()=>({status:'ok',app:'varshan'}));
    app.get('/api/fixture',()=>value);
    process.once('SIGTERM',()=>{void app.close().then(()=>{release();process.exit(0)})});
    await app.listen({host:'127.0.0.1',port:Number(process.env.PORT)});
  `,
    );
    const probe = createServer();
    await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
    const address = probe.address();
    assert.ok(address && typeof address !== "string");
    const port = address.port;
    await new Promise<void>((resolve) => probe.close(() => resolve()));
    let child: ReturnType<typeof spawn> | undefined;
    let output = "";
    async function stop() {
      if (!child || child.exitCode !== null) return;
      const exited = new Promise<void>((resolve) =>
        child!.once("exit", () => resolve()),
      );
      child.kill("SIGTERM");
      await exited;
    }
    t.after(async () => {
      await stop();
      rmSync(root, { recursive: true, force: true });
    });
    function launch() {
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        PORT: String(port),
        VARSHAN_MOBILE: "0",
        VARSHAN_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
      };
      child = spawn(process.execPath, [join(target, "index.js")], {
        env,
        stdio: ["ignore", "pipe", "pipe"],
      });
      child.stdout!.on("data", (data) => {
        output += data;
      });
      child.stderr!.on("data", (data) => {
        output += data;
      });
    }
    async function get(path: string) {
      return fetch(`http://127.0.0.1:${port}${path}`, {
        signal: AbortSignal.timeout(1000),
      });
    }
    async function waitFor(locked: boolean) {
      for (let i = 0; i < 100; i++) {
        assert.equal(child?.exitCode, null, output);
        try {
          const response = await get("/api/health");
          if (response.ok && Boolean((await response.json()).locked) === locked)
            return;
        } catch {}
        await new Promise((resolve) => setTimeout(resolve, 30));
      }
      assert.fail(
        `Server never became ${locked ? "locked" : "unlocked"}: ${output}`,
      );
    }
    const password = "chosen startup password";
    async function unlock(setup: boolean) {
      const { token } = await (await get("/api/vault/status")).json();
      const response = await fetch(`http://127.0.0.1:${port}/api/vault/open`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Varshan-Token": token,
        },
        body: JSON.stringify({
          password,
          ...(setup ? { confirmation: password } : {}),
        }),
      });
      assert.equal(response.status, 200, await response.text());
      await waitFor(false);
    }
    launch();
    await waitFor(true);
    assert.equal(existsSync(join(root, "runtime-started")), false);
    assert.equal((await get("/api/fixture")).status, 423);
    await unlock(true);
    assert.deepEqual(await (await get("/api/fixture")).json(), {
      secret: "kept across restarts",
    });
    const encrypted = readFileSync(join(root, "us_stocks/fixture.json"));
    await stop();
    launch();
    await waitFor(false);
    assert.deepEqual(await (await get("/api/fixture")).json(), {
      secret: "kept across restarts",
    });
    assert.ok(encrypted.toString().startsWith("STOCKS-ENCRYPTED-v1"));
  },
);
