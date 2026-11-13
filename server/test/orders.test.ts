import test, { mock } from "node:test";
import assert from "node:assert/strict";
import { store, type Row } from "../src/shared/storage.js";
import { rolesFile } from "../src/brokers/accounts.js";
import {
  submit,
  ticketsFile,
  type BrokerSession,
  BrokerError,
  connected,
  argumentsFor,
  review,
} from "../src/brokers/robinhood.js";
import { TradeDecisionChanged } from "../src/trading/rotation.js";
function setup() {
  const records = new Map<string, Row>([
    [rolesFile, { long_term: "LONG", trading: "TRADE" }],
    [
      ticketsFile,
      {
        ticket: {
          id: "ticket",
          arguments: {
            account_number: "TRADE",
            symbol: "A",
            side: "sell",
            quantity: "1",
            type: "market",
          },
          reviewed_at: new Date().toISOString(),
          status: "preview",
        },
      },
    ],
  ]);
  const statuses: string[] = [];
  mock.method(store, "json", (p: string, fallback: Row) =>
    structuredClone(records.get(p) ?? fallback),
  );
  mock.method(store, "save", (p: string, data: Row) => {
    records.set(p, structuredClone(data));
    if (p === ticketsFile) statuses.push(data.ticket.status);
  });
  return { records, statuses };
}
function connection(place: () => Promise<Row>): typeof connected {
  return (async (action: (s: BrokerSession) => Promise<unknown>) =>
    action({
      async call(name: string) {
        if (name === "get_accounts")
          return {
            accounts: [
              {
                account_number: "TRADE",
                state: "active",
                agentic_allowed: true,
              },
            ],
          };
        if (name === "place_equity_order") return place();
        throw new Error("unexpected broker call");
      },
      async rows() {
        return [
          { symbol: "A", quantity: "3", shares_available_for_sells: "3" },
        ];
      },
    })) as typeof connected;
}
test("sub-dollar buys are blocked before argument creation or broker preview", async () => {
  setup();
  let connections = 0;
  const broker = (async () => {
    connections++;
    throw new Error("Must not connect");
  }) as typeof connected;
  const action = {
    enabled: true,
    action: "BUY",
    side: "buy",
    symbol: "A",
    dollar_amount: "0.99",
  };
  try {
    assert.throws(() => argumentsFor("TRADE", action), /\$1 minimum/);
    await assert.rejects(
      review({ ...action, account_number: "TRADE" }, broker),
      /\$1 minimum/,
    );
    assert.equal(connections, 0);
    assert.equal(
      argumentsFor("TRADE", { ...action, dollar_amount: "1.00" }).dollar_amount,
      "1.00",
    );
  } finally {
    mock.restoreAll();
  }
});
for (const shrink of [false, true]) {
  test(`submission blocks ${shrink ? "revalidated" : "saved"} sub-dollar buys without placement`, async () => {
    const { records } = setup();
    records.get(ticketsFile)!.ticket.arguments = {
      account_number: "TRADE",
      symbol: "A",
      side: "buy",
      type: "market",
      dollar_amount: shrink ? "2.00" : "0.99",
    };
    let placements = 0;
    try {
      const ticket = await submit(
        "ticket",
        true,
        async (t) => {
          if (shrink) t.arguments.dollar_amount = "0.99";
        },
        () => {},
        connection(async () => {
          placements++;
          return { order: { id: "order", state: "filled" } };
        }),
      );
      assert.equal(placements, 0);
      assert.equal(ticket.status, "not_submitted");
      assert.equal(ticket.decision_changed, true);
      assert.match(ticket.error, /\$1 minimum/);
    } finally {
      mock.restoreAll();
    }
  });
}
test("exactly one dollar buys and fractional quantity sells remain valid", async () => {
  for (const args of [
    { side: "buy", dollar_amount: "1.00" },
    { side: "sell", quantity: "0.01" },
  ]) {
    const { records } = setup();
    Object.assign(records.get(ticketsFile)!.ticket.arguments, args);
    let placements = 0;
    try {
      const ticket = await submit(
        "ticket",
        true,
        async () => {},
        () => {},
        connection(async () => {
          placements++;
          return { order: { id: "order", state: "filled" } };
        }),
      );
      assert.equal(ticket.status, "submitted");
      assert.equal(placements, 1);
    } finally {
      mock.restoreAll();
    }
  }
});

test("invalid sellable balances and order quantities never reach broker placement", async () => {
  const { records } = setup();
  let placements = 0;
  let available: unknown = "3";
  const broker: typeof connected = async (action) =>
    action({
      async call(name) {
        if (name === "get_accounts")
          return {
            accounts: [
              {
                account_number: "TRADE",
                state: "active",
                agentic_allowed: true,
              },
            ],
          };
        assert.equal(name, "place_equity_order");
        placements++;
        return { order: { id: "unexpected" } };
      },
      async rows() {
        return [{ symbol: "A", shares_available_for_sells: available }];
      },
    });
  try {
    for (const invalid of [
      "NaN",
      NaN,
      "Infinity",
      Infinity,
      "-1",
      true,
      [3],
      {},
      "",
      null,
      undefined,
    ]) {
      available = invalid;
      records.get(ticketsFile)!.ticket.status = "preview";
      const result = await submit(
        "ticket",
        true,
        async () => {},
        () => {},
        broker,
      );
      assert.equal(result.status, "not_submitted");
      assert.match(result.error, /sellable quantity/);
    }
    available = "3";
    for (const invalid of ["NaN", "Infinity", "-1", "0", "4"]) {
      const ticket = records.get(ticketsFile)!.ticket;
      ticket.status = "preview";
      ticket.arguments.quantity = invalid;
      const result = await submit(
        "ticket",
        true,
        async () => {},
        () => {},
        broker,
      );
      assert.equal(result.status, "not_submitted");
    }
    assert.equal(placements, 0);
  } finally {
    mock.restoreAll();
  }
});
test("authorized order saves submitting before placement and can never be submitted twice", async () => {
  const { records, statuses } = setup();
  let calls = 0;
  try {
    const broker = connection(async () => {
      calls++;
      assert.equal(records.get(ticketsFile)!.ticket.status, "submitting");
      return { order: { id: "order", state: "filled" } };
    });
    const t = await submit(
      "ticket",
      true,
      async () => {},
      () => {},
      broker,
    );
    assert.equal(t.status, "submitted");
    assert.deepEqual(statuses, ["submitting", "submitting", "submitted"]);
    assert.ok(Number.isFinite(Date.parse(t.submitted_at)));
    await assert.rejects(
      submit(
        "ticket",
        true,
        async () => {},
        () => {},
        broker,
      ),
      /already submitted/,
    );
    assert.equal(calls, 1);
  } finally {
    mock.restoreAll();
  }
});
test("a sell preview expiring during validation stays unsent and can be reevaluated", async () => {
  const now = Date.now();
  mock.timers.enable({ apis: ["Date"], now });
  const { records } = setup();
  let placements = 0;
  try {
    const result = await submit(
      "ticket",
      true,
      async () => {
        mock.timers.setTime(now + 17 * 60000);
      },
      () => {},
      connection(async () => {
        placements++;
        return { order: { id: "unexpected" } };
      }),
    );
    assert.equal(result.status, "not_submitted");
    assert.equal(result.decision_changed, true);
    assert.match(result.error, /Preview expired while connecting/);
    assert.equal(result.submitted_at, undefined);
    assert.equal(records.get(ticketsFile)!.ticket.status, "not_submitted");
    assert.equal(placements, 0);
    const all = records.get(ticketsFile)!;
    all.ticket.status = "preview";
    await assert.rejects(
      submit(
        "ticket",
        true,
        async () => {},
        () => {},
        connection(async () => {
          placements++;
          return {};
        }),
      ),
      TradeDecisionChanged,
    );
    assert.equal(
      placements,
      0,
      "expiry before validation must also remain unsent",
    );
  } finally {
    mock.restoreAll();
    mock.timers.reset();
  }
});
test("ambiguous network response becomes unknown and is never retried", async () => {
  const { records } = setup();
  let calls = 0;
  try {
    const broker = connection(async () => {
      calls++;
      throw new Error("connection interrupted");
    });
    const t = await submit(
      "ticket",
      true,
      async () => {},
      () => {},
      broker,
    );
    assert.equal(t.status, "unknown");
    await assert.rejects(
      submit(
        "ticket",
        true,
        async () => {},
        () => {},
        broker,
      ),
    );
    const second = structuredClone(records.get(ticketsFile)!.ticket);
    second.id = "second";
    second.status = "preview";
    records.get(ticketsFile)!.second = second;
    await assert.rejects(
      submit(
        "second",
        true,
        async () => {},
        () => {},
        broker,
      ),
      /unresolved/,
    );
    assert.equal(calls, 1);
  } finally {
    mock.restoreAll();
  }
});
test("an error after placement remains uncertain; a connection failure before placement was not submitted", async () => {
  setup();
  try {
    const t = await submit(
      "ticket",
      true,
      async () => {},
      () => {},
      connection(async () => {
        throw new BrokerError("rejected");
      }),
    );
    assert.equal(t.status, "unknown");
  } finally {
    mock.restoreAll();
  }
  setup();
  try {
    const broker = (async () => {
      throw new Error("connect failed");
    }) as typeof connected;
    const t = await submit(
      "ticket",
      true,
      async () => {},
      () => {},
      broker,
    );
    assert.equal(t.status, "not_submitted");
  } finally {
    mock.restoreAll();
  }
});

test("malformed placement receipts and broker server errors block further orders", async () => {
  for (const response of [
    {},
    { order: {} },
    new BrokerError("API error 503", "place_equity_order"),
  ]) {
    const { records } = setup();
    try {
      const result = await submit(
        "ticket",
        true,
        async () => {},
        () => {},
        connection(async () => {
          if (response instanceof Error) throw response;
          return response;
        }),
      );
      assert.equal(result.status, "unknown");
      records.get(ticketsFile)!.second = {
        ...records.get(ticketsFile)!.ticket,
        id: "second",
        status: "preview",
      };
      await assert.rejects(
        submit(
          "second",
          true,
          async () => {},
          () => {},
          connection(async () => {
            assert.fail("Must not send another order");
          }),
        ),
        /unresolved/,
      );
    } finally {
      mock.restoreAll();
    }
  }
});

test("a confirmed receipt survives broker cleanup failure", async () => {
  const { records } = setup();
  const receipt = {
    order: { id: "broker-order", ref_id: "broker-reference", state: "filled" },
  };
  try {
    const broker: typeof connected = async (action) => {
      await connection(async () => receipt)(action);
      assert.equal(
        records.get(ticketsFile)!.ticket.result?.order.id,
        "broker-order",
        "Save the receipt before broker cleanup",
      );
      throw new Error("Could not persist OAuth cache");
    };
    const result = await submit(
      "ticket",
      true,
      async () => {},
      () => {},
      broker,
    );
    assert.equal(result.status, "submitted");
    assert.deepEqual(result.result, receipt);
  } finally {
    mock.restoreAll();
  }
});
test("confirmation, account role, fresh preview and consent revocation are rechecked before placement", async () => {
  const { records } = setup();
  let placed = 0;
  const broker = connection(async () => {
    placed++;
    return {};
  });
  try {
    await assert.rejects(
      submit(
        "ticket",
        false,
        async () => {},
        () => {},
        broker,
      ),
      /confirmation/,
    );
    assert.equal(records.get(ticketsFile)!.ticket.status, "preview");
    let consent = true;
    const t = await submit(
      "ticket",
      true,
      async () => {
        consent = false;
      },
      () => {
        if (!consent) throw new Error("session revoked");
      },
      broker,
    );
    assert.equal(t.status, "not_submitted");
    assert.equal(placed, 0);
  } finally {
    mock.restoreAll();
  }
  const next = setup();
  try {
    next.records.get(rolesFile)!.long_term = "TRADE";
    const t = await submit(
      "ticket",
      true,
      async () => {},
      () => {},
      broker,
    );
    assert.equal(t.status, "not_submitted");
    assert.equal(placed, 0);
  } finally {
    mock.restoreAll();
  }
});
