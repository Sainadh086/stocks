import { useState } from "react";
import { Card, Failure, Metric, Notice, Table } from "./components";
import { request, useAction, useData } from "./api";
import type { Row } from "./types";

interface LearningData {
  contexts: { bucket: string; label: string }[];
  selected: string | null;
  orders: Row[];
  episodes: Row[];
  insights: Row[];
  policy: {
    ready: boolean;
    validated: boolean;
    train_episodes: number;
    held_out_episodes: number;
    supported_held_out: number;
    held_out_mean_return_pct: number | null;
    double_cost_mean_return_pct: number | null;
    followed_strategy_mean_return_pct: number | null;
    explanation: string;
  } | null;
  coverage: string;
  error: string | null;
}
export function TradeLearning() {
  const [bucket, setBucket] = useState("");
  const data = useData<LearningData>(
    ["learning", bucket],
    `/learning${bucket ? "?bucket=" + encodeURIComponent(bucket) : ""}`,
    30000,
  );
  const [key, setKey] = useState(""),
    [strategy, setStrategy] = useState("gems"),
    [reason, setReason] = useState("");
  const current = Array.isArray(data.data?.contexts) ? data.data : undefined;
  const train = useAction(
    () => request("/learning/train", { bucket: current?.selected }),
    ["learning", "portfolios", "gems-plan", "live", "india-trading"],
  );
  const attribute = useAction(
    () => request("/learning/attribute", { key, strategy, reason }),
    ["learning"],
  );
  return (
    <Card
      title="Strategy learning & trade journal"
      subtitle="Market context, completed outcomes and measured stock-selection guidance"
    >
      <Failure
        error={data.error || train.error || attribute.error || current?.error}
      />
      <Notice>
        The advisor uses one-step Q-learning from completed position cycles. It
        learns select versus wait from downside-penalized outcomes, separately
        by account, market, strategy and horizon. Validated models can adjust
        shortlist order within existing eligibility and risk limits; real trades
        never explore randomly.
      </Notice>
      {current && (
        <>
          <div className="form-row">
            <label>
              Learning account
              <select
                value={current.selected ?? ""}
                onChange={(e) => {
                  setBucket(e.target.value);
                  setKey("");
                }}
              >
                <option value="" disabled>
                  Select a recorded account
                </option>
                {current.contexts.map((ctx) => (
                  <option key={ctx.bucket} value={ctx.bucket}>
                    {ctx.label}
                  </option>
                ))}
              </select>
            </label>
            <button
              disabled={train.isPending || !current.selected}
              onClick={() => train.mutate()}
            >
              {train.isPending ? "Evaluating…" : "Train and evaluate advisor"}
            </button>
          </div>
          {!current.contexts.length && (
            <Notice>
              No trades have been observed yet. Refresh a connected trading
              account or sync investing holdings to collect available broker
              orders. New Gems scans also record dated research context for
              future entries.
            </Notice>
          )}
          <div className="metrics">
            <Metric
              title="Observed orders"
              value={current.orders.length}
              detail="Buys, sells and pending states"
              privateData={false}
            />
            <Metric
              title="Closed position cycles"
              value={current.episodes.length}
              detail="Top-ups count as one position cycle"
              privateData={false}
            />
            <Metric
              title="Learning status"
              value={
                current.policy?.validated
                  ? "Validated ranking"
                  : current.policy?.ready
                    ? "Evaluation pending improvement"
                    : "Collecting evidence"
              }
              detail="20 training, 10 later evaluation cycles; ≥5 examples per state"
              privateData={false}
            />
          </div>
          {current.policy && (
            <>
              <Table
                name="Learning evaluation"
                rows={[current.policy as unknown as Row]}
                columns={[
                  "train_episodes",
                  "held_out_episodes",
                  "supported_held_out",
                  "held_out_mean_return_pct",
                  "double_cost_mean_return_pct",
                  "followed_strategy_mean_return_pct",
                  "validated",
                ]}
              />
              <p className="footnote">{current.policy.explanation}</p>
            </>
          )}
          {current.insights.length ? (
            <Table
              name="Strategy findings"
              rows={current.insights}
              columns={["finding", "evidence"]}
            />
          ) : (
            <Notice>
              No strategy findings are established yet. Completed position
              cycles and their recorded context will supply evidence for the
              review.
            </Notice>
          )}
          <details className="broker-help">
            <summary>Buy / sell journal and strategy attribution</summary>
            <p>{current.coverage}</p>
            {current.orders.length ? (
              <Table
                name="Buy sell learning journal"
                rows={current.orders}
                columns={[
                  "order_id",
                  "symbol",
                  "side",
                  "status",
                  "quantity",
                  "price",
                  "filled_at",
                  "fees",
                  "strategy",
                  "reason",
                ]}
              />
            ) : (
              <Notice>
                No broker orders are recorded in this scope yet. Refresh the
                connected account or sync investing holdings to collect
                available history.
              </Notice>
            )}
            <div className="form-row">
              <label>
                Order to explain
                <select value={key} onChange={(e) => setKey(e.target.value)}>
                  <option value="">Select an observed order</option>
                  {current.orders.map((o) => (
                    <option key={String(o.key)} value={String(o.key)}>
                      {String(o.symbol)} · {String(o.side)} ·{" "}
                      {String(o.order_id)}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Followed strategy
                <select
                  value={strategy}
                  onChange={(e) => setStrategy(e.target.value)}
                >
                  {[
                    "gems",
                    "momentum",
                    "weekend_style",
                    "naked_style",
                    "intraday_rotation_v1",
                    "orb_15m_v1",
                  ].map((s) => (
                    <option key={s} value={s}>
                      {s}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <label>
              Decision reasoning
              <input
                value={reason}
                maxLength={2000}
                onChange={(e) => setReason(e.target.value)}
              />
            </label>
            <button
              disabled={
                !key || reason.trim().length < 10 || attribute.isPending
              }
              onClick={() => attribute.mutate()}
            >
              Save strategy reasoning
            </button>
            <p className="footnote">
              Attributing a historical trade does not fabricate historical
              market features. Only observations saved before entry can support
              training.
            </p>
            {current.episodes.length ? (
              <Table
                name="Learning outcomes"
                rows={current.episodes}
                columns={[
                  "symbol",
                  "strategy",
                  "entry_time",
                  "exit_time",
                  "gross_pnl",
                  "net_pnl",
                  "net_return_pct",
                  "cost_status",
                  "eligible",
                  "reason",
                ]}
              />
            ) : (
              <p className="footnote">
                No completed position cycles yet. Open positions and unresolved
                orders remain in the journal without creating learning rewards.
              </p>
            )}
          </details>
        </>
      )}
    </Card>
  );
}
