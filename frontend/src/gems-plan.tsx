import { useEffect, useState } from "react";
import { request, useAction, useData } from "./api";
import { Card, Failure, Metric, Notice, Table, money } from "./components";
import { PrivateInput } from "./preferences";
import type { Row } from "./types";

interface Review {
  policy_notes: string;
  management_notes: string;
  vision_notes: string;
  source_urls: string[];
}
interface Plan {
  scope: string;
  budget: number;
  reserve_pct: number;
  saved: boolean;
  picks: Row[];
  target_cash_usd: number;
  ready_initial_usd: number;
  schedule: Row[];
  message: string;
  review_policy: string;
  reviews: Record<string, Review>;
}
const emptyReview: Review = {
  policy_notes: "",
  management_notes: "",
  vision_notes: "",
  source_urls: [],
};
export function USGemsPlan() {
  const data = useData<Plan>("gems-plan", "/us/gems/plan");
  const [budget, setBudget] = useState(10000),
    [reserve, setReserve] = useState(10);
  const [symbol, setSymbol] = useState("");
  const [review, setReview] = useState<Review>(emptyReview);
  const [sources, setSources] = useState("");
  const [acknowledged, setAcknowledged] = useState(false);
  const save = useAction(
    () => request<Plan>("/us/gems/plan", { budget, reserve_pct: reserve }),
    ["gems-plan"],
  );
  const record = useAction(
    () =>
      request<Plan>("/us/gems/reviews", {
        symbol,
        policy_notes: review.policy_notes,
        management_notes: review.management_notes,
        vision_notes: review.vision_notes,
        source_urls: sources
          .split(/\n/)
          .map((s) => s.trim())
          .filter(Boolean),
        acknowledged,
      }),
    ["gems-plan"],
  );
  const plan = data.data;
  useEffect(() => {
    if (data.data) {
      setBudget(data.data.budget);
      setReserve(data.data.reserve_pct);
    }
    setSymbol("");
    setReview(emptyReview);
    setSources("");
    setAcknowledged(false);
  }, [data.data?.scope]);
  return (
    <Card
      title="US Gems long-term plan"
      subtitle="3–5 year model allocation · Saved separately from daily trading"
    >
      <Notice>
        Set the total budget for a dedicated Gems allocation. These are model
        targets; compare them with existing holdings before investing. The plan
        creates no broker orders.
      </Notice>
      <div className="form-row">
        <label>
          Gems portfolio budget ($)
          <PrivateInput
            type="number"
            min="1"
            value={budget}
            onChange={(e) => setBudget(Number(e.target.value))}
          />
        </label>
        <label>
          Gems cash reserve (%)
          <PrivateInput
            type="number"
            min="0"
            max="100"
            value={reserve}
            onChange={(e) => setReserve(Number(e.target.value))}
          />
        </label>
        <button
          className="primary"
          disabled={
            save.isPending || !(budget > 0) || reserve < 0 || reserve > 100
          }
          onClick={() => save.mutate()}
        >
          {save.isPending ? "Saving…" : "Build and save Gems plan"}
        </button>
      </div>
      <Failure error={data.error || save.error || record.error} />
      {save.isSuccess && <p className="success">Gems plan saved</p>}
      <p className="footnote">
        Up to 8 stocks, at most 12.5% of the portfolio per stock and 30% per
        sector. Fewer candidates leave more cash. Enter in 40% / 30% / 30%
        stages, with fresh evidence before each addition.
      </p>
      {plan && (
        <>
          <Notice>{plan.message}</Notice>
          <div className="metrics">
            <Metric
              title="Model budget"
              value={money(plan.budget)}
              detail={
                plan.saved ? "Saved plan" : "Preview; save to fix the schedule"
              }
            />
            <Metric
              title="Target cash"
              value={money(plan.target_cash_usd)}
              detail="Reserve plus unallocated slots"
            />
            <Metric
              title="Reviewed initial allocation"
              value={money(plan.ready_initial_usd)}
              detail="Research quantities; not submitted orders"
            />
          </div>
          <Table
            name="US Gems allocation"
            rows={plan.picks}
            columns={[
              "symbol",
              "sector",
              "target_weight_pct",
              "target_usd",
              "suggested_shares",
              "initial_usd",
              "after_30_days_usd",
              "after_60_days_usd",
              "ready_initial_usd",
              "qualitative_status",
              "review_due",
            ]}
          />
          <Table
            name="Gems entry schedule"
            rows={plan.schedule}
            columns={["stage", "earliest", "condition"]}
          />
          <p>{plan.review_policy}</p>
          <details>
            <summary>
              Record policy, management and long-term vision review
            </summary>
            <p>
              Use dated company filings, investor-relations material and
              government sources. Your attestation lasts 90 days; this is your
              recorded review, not an automated verification.
            </p>
            <label>
              Gems company to review
              <select
                value={symbol}
                onChange={(e) => {
                  const selected = e.target.value,
                    saved = plan.reviews[selected] ?? emptyReview;
                  setSymbol(selected);
                  setReview(saved);
                  setSources(saved.source_urls.join("\n"));
                  setAcknowledged(false);
                  record.reset();
                }}
              >
                <option value="">Select a candidate</option>
                {plan.picks.map((row) => (
                  <option key={String(row.symbol)} value={String(row.symbol)}>
                    {String(row.symbol)}
                  </option>
                ))}
              </select>
            </label>
            {symbol && (
              <div className="form-grid">
                {(
                  [
                    [
                      "policy_notes",
                      "Government-policy fit and regulatory risks",
                    ],
                    [
                      "management_notes",
                      "Management, governance and capital-allocation decisions",
                    ],
                    ["vision_notes", "3–5 year growth vision and thesis risks"],
                  ] as const
                ).map(([key, label]) => (
                  <label key={key}>
                    {label}
                    <textarea
                      minLength={20}
                      maxLength={4000}
                      rows={3}
                      value={review[key]}
                      onChange={(e) =>
                        setReview({ ...review, [key]: e.target.value })
                      }
                    />
                  </label>
                ))}
                <label>
                  Dated source links (HTTPS, one per line)
                  <textarea
                    rows={3}
                    value={sources}
                    onChange={(e) => setSources(e.target.value)}
                  />
                </label>
                <label className="check">
                  <input
                    type="checkbox"
                    checked={acknowledged}
                    onChange={(e) => setAcknowledged(e.target.checked)}
                  />
                  I reviewed these dated sources and accept the recorded
                  investment thesis.
                </label>
                <button
                  disabled={
                    record.isPending ||
                    !acknowledged ||
                    !sources.trim() ||
                    [
                      review.policy_notes,
                      review.management_notes,
                      review.vision_notes,
                    ].some((s) => s.trim().length < 20)
                  }
                  onClick={() => record.mutate()}
                >
                  {record.isPending
                    ? "Saving review…"
                    : "Save dated Gems review"}
                </button>
                {record.isSuccess && (
                  <p className="success">Dated review saved</p>
                )}
              </div>
            )}
          </details>
        </>
      )}
    </Card>
  );
}
