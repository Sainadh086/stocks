import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { MAGIC, projectRoot, Storage } from "../src/shared/storage.js";

test("compiled storage resolves the workspace, including URL-encoded paths", () => {
  assert.equal(
    projectRoot,
    resolve(fileURLToPath(new URL("../../../", import.meta.url))),
  );
});

test("environment encryption key reopens files across instances and rejects invalid or wrong keys without overwriting", () => {
  const root = mkdtempSync(join(tmpdir(), "varshan portable storage "));
  const previous = process.env.VARSHAN_ENCRYPTION_KEY;
  try {
    const file = join(root, "private.json");
    process.env.VARSHAN_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");
    new Storage(root).save(file, { secret: "fixture" });
    const original = readFileSync(file);
    assert.ok(original.subarray(0, MAGIC.length).equals(MAGIC));
    assert.deepEqual(new Storage(root).json(file, null), { secret: "fixture" });
    process.env.VARSHAN_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString(
      "base64url",
    );
    assert.deepEqual(new Storage(root).json(file, null), { secret: "fixture" });
    process.env.VARSHAN_ENCRYPTION_KEY = "bad";
    assert.throws(() => new Storage(root).read(file), /32 random bytes/);
    process.env.VARSHAN_ENCRYPTION_KEY = Buffer.alloc(32, 8).toString("base64");
    assert.throws(() => new Storage(root).read(file), /authenticated/);
    assert.deepEqual(readFileSync(file), original);
  } finally {
    if (previous === undefined) delete process.env.VARSHAN_ENCRYPTION_KEY;
    else process.env.VARSHAN_ENCRYPTION_KEY = previous;
    rmSync(root, { recursive: true, force: true });
  }
});
