import test from "node:test";
import assert from "node:assert/strict";
import { PersistentSession } from "../src/brokers/persistent-session.js";

function fixture() {
  let opens = 0;
  const resources: {
    value: { id: number };
    alive: boolean;
    persists: number;
    closes: number;
  }[] = [];
  const pool = new PersistentSession(
    async () => {
      const resource = {
        value: { id: ++opens },
        alive: true,
        persists: 0,
        closes: 0,
      };
      resources.push(resource);
      return {
        value: resource.value,
        isOpen: () => resource.alive,
        persist: () => {
          resource.persists++;
        },
        close: async () => {
          resource.closes++;
          resource.alive = false;
        },
      };
    },
    (e) => e instanceof Error && e.message === "connection lost",
  );
  return { pool, resources, opens: () => opens };
}

test("successive and concurrent refreshes reuse one serialized authenticated session", async () => {
  const f = fixture();
  let active = 0;
  try {
    const ids = await Promise.all(
      Array.from({ length: 10 }, () =>
        f.pool.run(async (session) => {
          assert.equal(++active, 1);
          await Promise.resolve();
          active--;
          return session.id;
        }),
      ),
    );
    assert.deepEqual(ids, Array(10).fill(1));
    assert.equal(f.opens(), 1);
    assert.equal(f.resources[0].persists, 10);
    assert.equal(f.resources[0].closes, 0);
  } finally {
    await f.pool.close();
  }
  assert.equal(f.resources[0].closes, 1);
});

test("business errors do not discard a valid session or replay its workflow", async () => {
  const f = fixture();
  let calls = 0;
  try {
    await assert.rejects(
      f.pool.run(async () => {
        calls++;
        throw new Error("trade no longer qualifies");
      }),
    );
    assert.equal(await f.pool.run(async (s) => s.id), 1);
    assert.equal(calls, 1);
    assert.equal(f.resources[0].closes, 0);
  } finally {
    await f.pool.close();
  }
});

test("a broken connection is retired and the next workflow reconnects without replaying a possible placement", async () => {
  const f = fixture();
  let placements = 0;
  try {
    await assert.rejects(
      f.pool.run(async () => {
        placements++;
        throw new Error("connection lost");
      }),
    );
    assert.equal(placements, 1);
    assert.equal(f.resources[0].closes, 1);
    assert.equal(await f.pool.run(async (s) => s.id), 2);
    assert.equal(placements, 1);
    f.resources[1].alive = false;
    assert.equal(await f.pool.run(async (s) => s.id), 3);
  } finally {
    await f.pool.close();
  }
});

test("shutdown waits for active work and closes its session once", async () => {
  const f = fixture();
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const action = f.pool.run(async () => {
    await gate;
    return 1;
  });
  await new Promise((r) => setImmediate(r));
  const close = f.pool.close();
  await Promise.resolve();
  assert.equal(f.resources[0].closes, 0);
  release();
  assert.equal(await action, 1);
  await close;
  await f.pool.close();
  assert.equal(f.resources[0].closes, 1);
  await assert.rejects(
    f.pool.run(async () => 2),
    /shutting down/,
  );
  assert.equal(
    f.opens(),
    1,
    "late work must not create another login during shutdown",
  );
});

test("a failed connection setup never invokes the broker workflow", async () => {
  let calls = 0;
  const pool = new PersistentSession(
    async () => {
      throw new Error("authentication required");
    },
    () => true,
  );
  await assert.rejects(
    pool.run(async () => {
      calls++;
    }),
    /authentication required/,
  );
  assert.equal(calls, 0);
  await pool.close();
});
