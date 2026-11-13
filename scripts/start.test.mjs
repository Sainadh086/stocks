import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configuration } from "./start.mjs";

const key = Buffer.alloc(32, 7).toString("base64");
test("preflight supports desktop on all three platforms and rejects invalid configuration", () => {
  for (const platform of ["darwin", "linux", "win32"]) {
    const config = configuration({
      args: [],
      platform,
      version: "22.12.0",
      env: { VARSHAN_ENCRYPTION_KEY: key, PORT: "9123" },
    });
    assert.equal(config.port, 9123);
    assert.equal(config.mobile, false);
  }
  assert.throws(() => configuration({ args: [], version: "22.11.0" }), /22.12/);
  assert.throws(() => configuration({ args: ["--bad"] }), /Unknown option/);
  for (const env of [
    { PORT: "0" },
    { PORT: "NaN" },
    { PORT: "8443" },
    { VARSHAN_ENCRYPTION_KEY: "bad" },
  ])
    assert.throws(() => configuration({ args: [], env }));
  for (const platform of ["linux", "win32"]) {
    assert.throws(
      () => configuration({ args: [], platform, env: {} }),
      /VARSHAN_ENCRYPTION_KEY/,
    );
    assert.throws(
      () =>
        configuration({
          args: ["--mobile"],
          platform,
          env: { VARSHAN_ENCRYPTION_KEY: key },
        }),
      /Touch ID/,
    );
    assert.equal(
      configuration({ args: ["--setup"], platform, env: {} }).setup,
      true,
    );
  }
});

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "varshan launch with spaces "));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "scripts"));
  mkdirSync(join(root, "server", "dist", "src"), { recursive: true });
  copyFileSync(
    new URL("./start.mjs", import.meta.url),
    join(root, "scripts", "start.mjs"),
  );
  writeFileSync(
    join(root, "npm-cli.js"),
    `
    const fs = require('node:fs');
    const path = require('node:path');
    const args = process.argv.slice(2);
    const pathKey = Object.keys(process.env).find(name => name.toLowerCase() === 'path');
    if (process.env[pathKey].split(path.delimiter)[0] !== path.dirname(process.execPath)) process.exit(8);
    fs.appendFileSync('calls.jsonl', JSON.stringify({ args, secret: Object.keys(process.env).some(name => name.toUpperCase() === 'VARSHAN_ENCRYPTION_KEY') }) + '\\n');
    if (args[0] === 'ci') fs.mkdirSync(args[2] + '/node_modules', {recursive: true});
    process.exit(process.env.FAIL_BUILD && args.includes('build') ? 9 : 0);
  `,
  );
  writeFileSync(
    join(root, "server", "dist", "src", "index.js"),
    `
    console.log('fixture API received key: ' + !!process.env.VARSHAN_ENCRYPTION_KEY);
    console.log('fixture mobile: ' + process.env.VARSHAN_MOBILE);
    process.exit(7);
  `,
  );
  const env = {
    ...process.env,
    npm_execpath: join(root, "npm-cli.js"),
    VARSHAN_ENCRYPTION_KEY: key,
    varshan_encryption_key: key,
    VARSHAN_MOBILE: "0",
    PORT: "8000",
    MOBILE_PORT: "8443",
    CERTIFICATE_PORT: "8080",
  };
  delete env.FAIL_BUILD;
  const launch = (args = [], override = {}) =>
    spawnSync(process.execPath, [join(root, "scripts", "start.mjs"), ...args], {
      cwd: tmpdir(),
      env: { ...env, ...override },
      encoding: "utf8",
    });
  const calls = () =>
    readFileSync(join(root, "calls.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map(JSON.parse);
  return { launch, calls };
}

test("setup and launch work outside the workspace and with spaces, without leaking the key to npm", (t) => {
  const { launch, calls } = fixture(t);
  const checked = launch(["--check"]);
  assert.equal(checked.status, 0, checked.stderr);
  assert.match(checked.stdout, /http:\/\/127.0.0.1:8000/);
  const setup = launch(["--setup"]);
  assert.equal(setup.status, 0, setup.stderr);
  assert.match(setup.stdout, /Setup complete/);
  assert.doesNotMatch(setup.stdout, /fixture API/);
  assert.deepEqual(
    calls().map((call) => call.args),
    [
      ["ci", "--prefix", "server"],
      ["ci", "--prefix", "frontend"],
      ["--prefix", "server", "run", "build"],
      ["--prefix", "frontend", "run", "build"],
    ],
  );
  const started = launch();
  assert.equal(started.status, 7, started.stderr);
  assert.match(started.stdout, /fixture API received key: true/);
  assert.match(started.stdout, /fixture mobile: 0/);
  assert.equal(
    calls().length,
    6,
    "installed dependencies are reused on subsequent launches",
  );
  assert.ok(calls().every((call) => !call.secret));
});

test("first launch installs dependencies and a build failure prevents starting the API", (t) => {
  const { launch, calls } = fixture(t);
  const result = launch([], { FAIL_BUILD: "1" });
  assert.equal(result.status, 9, result.stderr);
  assert.doesNotMatch(result.stdout, /fixture API/);
  assert.deepEqual(
    calls().map((call) => call.args),
    [
      ["ci", "--prefix", "server"],
      ["ci", "--prefix", "frontend"],
      ["--prefix", "server", "run", "build"],
    ],
  );
});
