import test, { mock } from "node:test";
import assert from "node:assert/strict";
import { Service } from "../src/service.js";
import { store, type Row } from "../src/shared/storage.js";
import { rolesFile } from "../src/brokers/accounts.js";
import {
  connected,
  McpConnectionError,
  ticketsFile,
} from "../src/brokers/robinhood.js";
import { session } from "../src/shared/calendar.js";

for (const delayed of [false, true])
  for (const automatic of delayed ? [true] : [false, true])
    for (const carried of [false, true])
      test(`${automatic ? "automatic" : "manual"} ${carried ? "stop-triggered sell then buy" : "buy"} ${delayed ? "with delayed signals " : ""}flow submits only with consent and reuses its MCP session`, async () => {
        const now = session("2026-10-12")![0] + 1230000;
        mock.timers.enable({ apis: ["Date"], now });
        const records = new Map<string, Row>([
          [rolesFile, { long_term: "LONG", trading: "TRADE" }],
        ]);
        mock.method(store, "json", (path: string, fallback: Row) =>
          path.includes("live_trading_settings_")
            ? {
                version: 1,
                account_number: "TRADE",
                budget: 1000,
                reserve_pct: 10,
              }
            : structuredClone(records.get(path) ?? fallback),
        );
        mock.method(store, "save", (path: string, value: Row) => {
          records.set(path, structuredClone(value));
        });
        let positions: Row[] = carried
          ? [
              {
                symbol: "A",
                quantity: "9",
                shares_available_for_sells: "9",
                average_buy_price: "100",
              },
            ]
          : [];
        if (carried)
          records.set(ticketsFile, {
            entry: {
              id: "entry",
              status: "submitted",
              strategy: "orb_15m_v1",
              reviewed_at: new Date(now - 600000).toISOString(),
              stop: "101",
              target: "110",
              arguments: { account_number: "TRADE", symbol: "A", side: "buy" },
              result: { order: { id: "entry", state: "filled" } },
            },
          });
        let cash = carried ? 100 : 1000;
        const orders: Row[] = [],
          placements: string[] = [];
        let connections = 0;
        let unavailable = false;
        const broker: typeof connected = async (action) => {
          connections++;
          if (unavailable)
            throw new McpConnectionError(
              "Robinhood MCP get_portfolio timed out after one retry.",
            );
          return action({
            async call(name, args) {
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
              if (name === "get_portfolio")
                return {
                  total_value: 1000,
                  equity_value: 1000 - cash,
                  cash,
                  currency: "USD",
                  buying_power: {
                    buying_power: cash,
                    unleveraged_buying_power: cash,
                  },
                };
              if (name === "get_equity_quotes")
                return {
                  results: args.symbols.map((symbol: string) => ({
                    quote: {
                      symbol,
                      state: "active",
                      has_traded: true,
                      last_trade_price: symbol === "A" ? 100 : 102,
                      venue_last_trade_time: new Date(now).toISOString(),
                    },
                  })),
                };
              if (name === "review_equity_order")
                return {
                  symbol: args.symbol,
                  side: args.side,
                  type: args.type,
                };
              if (name === "place_equity_order") {
                placements.push(`${args.side}:${args.symbol}`);
                if (args.side === "sell") {
                  cash = 1000;
                  positions = [];
                }
                const order = {
                  id: args.ref_id,
                  ref_id: args.ref_id,
                  symbol: args.symbol,
                  side: args.side,
                  state: "filled",
                  created_at: new Date(now).toISOString(),
                };
                orders.push(order);
                return { order };
              }
              throw new Error(`Unexpected MCP call ${name}`);
            },
            async rows(name) {
              return structuredClone(
                name === "get_equity_positions" ? positions : orders,
              );
            },
          });
        };
        const service = new Service(
          false,
          { comparisons: {}, batch: null },
          broker,
        );
        const signals = {
          strategy: "orb_15m_v1",
          fresh: true,
          asof: new Date(now).toISOString(),
          message: "Ready",
          ranked: [
            { symbol: "B", range_high: 101, range_low: 99, relative_volume: 2 },
          ],
          bars: {
            B: [
              {
                time: now - 330000,
                date: "2026-10-12",
                open: 100,
                high: 103,
                low: 100,
                close: 102,
                volume: 100,
              },
              {
                kind: "quote",
                time: now - 1000,
                date: "2026-10-12",
                open: 102,
                high: 102,
                low: 102,
                close: 102,
                volume: 0,
              },
            ],
          },
        };
        let ready = !delayed;
        let release: () => void = () => {};
        const loaded = new Promise<void>((resolve) => {
          release = resolve;
        });
        mock.method((service as any).feed, "snapshot", () =>
          ready
            ? signals
            : {
                ...signals,
                fresh: false,
                ranked: [],
                bars: {},
              },
        );
        let refreshes = 0;
        mock.method((service as any).feed, "refresh", async () => {
          refreshes++;
          if (delayed) await loaded;
          ready = true;
          return signals;
        });
        try {
          if (automatic) {
            service.touch("fixture", true);
            // Enabling must bypass the previous account-check cooldown.
            (service as any).lastLive = now;
            await service.setAuto(true, "fixture", true, true);
            unavailable = true;
            await (service as any).tick();
            assert.equal(
              service.liveView().auto.enabled,
              true,
              "a read outage must not revoke the session",
            );
            assert.match(service.liveView().error, /get_portfolio timed out/);
            assert.deepEqual(placements, []);
            unavailable = false;
            (service as any).liveRequested = true;
            await (service as any).tick();
            assert.deepEqual(
              placements,
              [],
              "signal requests must respect read backoff",
            );
            mock.timers.setTime(now + 2000);
            await (service as any).tick();
            if (delayed) {
              // A recorded stop can exit a holding while entry signals are loading.
              assert.deepEqual(placements, carried ? ["sell:A"] : []);
              release();
              await (service as any).feedWork;
              await (service as any).tick();
              assert.equal(
                refreshes,
                1,
                "completed signals must not restart the scan",
              );
            }
            const result = service.liveView();
            assert.equal(result.batch.status, "completed", result.batch.error);
            assert.deepEqual(
              placements,
              carried ? ["sell:A", "buy:B"] : ["buy:B"],
            );
            assert.equal(connections, (delayed ? 2 : 1) + (automatic ? 1 : 0));
            await service.setAuto(false, "fixture", false);
            await assert.rejects(
              service.confirmLive(result.batch.id, true),
              /Automatic rebalances do not require manual confirmation/,
            );
            assert.equal(connections, (delayed ? 2 : 1) + (automatic ? 1 : 0));
            (service as any).connections.clear();
            (service as any).lastLive = 0;
            await (service as any).tick();
            assert.equal(placements.length, carried ? 2 : 1);
            return;
          }
          const preview = await service.previewLive();
          assert.equal(preview.batch.status, "preview");
          assert.equal(placements.length, 0);
          assert.equal(connections, (delayed ? 2 : 1) + (automatic ? 1 : 0));
          const result = await service.confirmLive(preview.batch.id, true);
          assert.equal(result.batch.status, "completed", result.batch.error);
          assert.deepEqual(
            placements,
            carried ? ["sell:A", "buy:B"] : ["buy:B"],
          );
          assert.equal(connections, 2);
          await assert.rejects(
            service.confirmLive(preview.batch.id, true),
            /already confirmed/,
          );
          assert.equal(placements.length, carried ? 2 : 1);
        } finally {
          mock.restoreAll();
          mock.timers.reset();
        }
      });
