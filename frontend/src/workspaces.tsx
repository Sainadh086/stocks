import { PrivateInput, PrivateValue } from "./preferences";
import { useEffect, useState } from "react";
import { BookOpen, RefreshCw } from "lucide-react";
import {
  Card,
  Chart,
  Empty,
  Failure,
  Metric,
  Notice,
  Table,
  money,
  num,
  Badge,
} from "./components";
import { request, runJob, useAction, useData } from "./api";
import type {
  Accounts,
  Comparison,
  IndiaPlan,
  Market,
  Portfolios,
  Role,
  Strategy,
  Preferences,
  Row,
} from "./types";
import { IndiaBrokerPicker, type IndiaLive } from "./india-trading";
import { KiteHistory, KiteRebalance } from "./trading";
import { BenchmarkInsights } from "./benchmark-insights";
import { WeeklyDashboard } from "./weekly-events";
import { USGemsPlan } from "./gems-plan";
import { TradeLearning } from "./trade-learning";

const regionNames = { India: "India", US: "US long term" };
function RegionPicker({
  value,
  onChange,
}: {
  value: "India" | "US";
  onChange: (value: "India" | "US") => void;
}) {
  return (
    <div className="segments" aria-label="Market">
      {(["India", "US"] as const).map((key) => (
        <button
          key={key}
          aria-pressed={value === key}
          className={value === key ? "active" : ""}
          onClick={() => onChange(key)}
        >
          {regionNames[key]}
        </button>
      ))}
    </div>
  );
}
export function Refresh({
  market,
  gems = false,
}: {
  market: "India" | "US";
  gems?: boolean;
}) {
  const action = useAction(() =>
    runJob(`/analysis/${market}${gems ? "/gems" : ""}`),
  );
  return (
    <div>
      <button disabled={action.isPending} onClick={() => action.mutate()}>
        <RefreshCw size={15} className={action.isPending ? "spinning" : ""} />
        {action.isPending ? "Analyzing…" : "Refresh analysis"}
      </button>
      <Failure error={action.error} />
      {action.isSuccess && <small className="success">Analysis updated</small>}
    </div>
  );
}
export function Holdings() {
  const [region, setRegion] = useState<"India" | "US">("India");
  const data = useData<Portfolios>("portfolios", "/portfolios");
  const accounts = useData<Accounts>("accounts", "/accounts");
  const sync = useAction(() => runJob("/accounts/sync"));
  const india = useData<IndiaLive>(["india-trading"], "/india/trading");
  const currentIndia = data.data?.india.scope === india.data?.investment_scope;
  const us = data.data?.us;
  const currentUS =
    !us?.scope || us.scope === accounts.data?.roles.long_term.scope;
  const workspace =
    region === "India"
      ? currentIndia
        ? data.data?.india
        : undefined
      : currentUS
        ? us
        : undefined;
  const rows = workspace?.holdings || [];
  const values = rows.map((row) =>
    num(row.market_value_inr ?? row.market_value ?? row.value),
  );
  const total =
    values.length && values.every((v) => v !== undefined)
      ? values.reduce<number>((sum, v) => sum + (v || 0), 0)
      : undefined;
  return (
    <>
      <div className="workspace-toolbar">
        <RegionPicker value={region} onChange={setRegion} />
        <div className="actions">
          {region === "US" && (
            <button disabled={sync.isPending} onClick={() => sync.mutate()}>
              {sync.isPending ? "Syncing…" : "Sync Robinhood holdings"}
            </button>
          )}
          <Refresh market={region} />
        </div>
      </div>
      {region === "India" && <IndiaBrokerPicker />}
      <Failure error={data.error || sync.error || workspace?.error} />
      <div className="metrics">
        <Metric
          title="Positions"
          value={rows.length}
          detail="Saved account holdings"
        />
        <Metric
          title="Stock value"
          value={money(total, region === "India" ? "INR" : "USD")}
          detail={
            total === undefined
              ? "Current valuation unavailable"
              : "Cash excluded"
          }
        />
        <Metric
          title="Strategy"
          value={region === "India" ? "Momentum" : "Business growth"}
          detail={
            region === "India"
              ? "Confirmed signals & allocation"
              : "Earnings, cash flow & growth"
          }
        />
        <Metric
          title="Account focus"
          value={regionNames[region]}
          detail={
            workspace?.as_of
              ? `Snapshot · ${workspace.as_of}`
              : "Separate from daily trading"
          }
        />
      </div>
      {data.isPending ? (
        <Notice>Loading your saved holdings…</Notice>
      ) : (
        <Card
          title="Current holdings"
          subtitle="The same saved holdings power recommendations and benchmark comparisons."
        >
          <Table
            rows={rows}
            columns={
              region === "India"
                ? [
                    "symbol",
                    "exchange",
                    "shares",
                    "price",
                    "market_value_inr",
                    "action",
                    "portfolio_plan",
                    "plan_reason",
                  ]
                : ["symbol", "quantity", "price", "market_value"]
            }
          />
        </Card>
      )}
      {region === "US" && (
        <>
          <Card
            title="Long-term health review"
            subtitle="Earnings and cash flow are reviewed alongside business growth and price underperformance."
          >
            {workspace?.report_current ? (
              <Table
                rows={workspace.report}
                columns={[
                  "symbol",
                  "long_term_action",
                  "long_term_reasons",
                  "price",
                  "return_6m_pct",
                  "revenue_growth_pct",
                  "earnings_growth_pct",
                  "operating_cash_flow",
                  "free_cash_flow",
                ]}
                name="Long-term health"
              />
            ) : (
              <Notice>
                Refresh US analysis to produce a current review for the selected
                long-term account.
              </Notice>
            )}
          </Card>
          <Card
            title="Proposed long-term rebalance"
            subtitle="Research review only. Missing financial evidence does not become a sell instruction."
          >
            <Table rows={workspace?.review} name="Long-term rebalance" />
          </Card>
        </>
      )}
    </>
  );
}
function Gems({ rows, market }: { rows: Row[]; market: "India" | "US" }) {
  const age = Date.now() - Date.parse(String(rows[0]?.scanned_at ?? ""));
  const fresh = age >= 0 && age < 86400000;
  const candidates = fresh ? rows.filter((r) => r.gems_candidate === true) : [];
  const [showAudit, setShowAudit] = useState(false);
  return (
    <Card
      title="Gems"
      subtitle={`${market} · Quality growth at a reasonable valuation · Research candidates`}
    >
      <Notice>
        Review government-policy fit and regulatory exposure, management's
        governance and capital-allocation decisions, and the company's 3–5 year
        growth vision in current filings before investing. These qualitative
        checks require evidence; financial ratios alone do not verify them.
      </Notice>
      <details>
        <summary>Gems screening rules</summary>
        <ul>
          <li>
            Score at least 70/100 across valuation (25), growth (25), cash flow
            (25), capital efficiency (10) and price risk (15). Lower P/E and
            growth multiples earn more points; sector comparison adds up to five
            valuation points when at least five peers have data.
          </li>
          <li>
            Eligibility requires RSI below 70, volatility at most 50%, ATR at
            most 5% of price, and price at least 80% of its 200-day average.
            Lower volatility, balanced RSI and a stronger long-term trend score
            better.
          </li>
          <li>
            Revenue and earnings must grow across at least two comparable annual
            statements. Sustained higher growth earns more points; three years
            remain preferred.
          </li>
          <li>
            Latest earnings, operating cash flow and free cash flow must be
            positive. Cash conversion, free-cash-flow margin and consistency
            earn additional points.
          </li>
          <li>
            Trailing P/E must be positive and at most 50; known debt/equity must
            be at most 3. Cheaper valuation, lower debt and stronger return on
            equity score better. These upper eligibility limits do not mean a
            stock is cheap or low risk.
          </li>
          <li>
            Missing or stale evidence fails the screen. Financial and
            real-estate businesses require separate sector analysis.
          </li>
        </ul>
        <p className="footnote">
          These are screening heuristics, not forecasts or a tested return
          model. Volatility uses 126 daily log returns and 252 sessions per
          year. The growth multiple uses historical earnings growth, not analyst
          PEG. P/E needs peer context. RSI must remain below the usual{" "}
          <a
            href="https://www.fidelity.com/learning-center/trading-investing/technical-analysis/technical-indicator-guide/RSI"
            target="_blank"
            rel="noreferrer"
          >
            70 overbought level
          </a>
          .
        </p>
      </details>
      <p>
        {rows.length
          ? `${candidates.length} candidates · ${rows.length} stocks scanned · ${String(rows[0].scanned_at)}`
          : "Choose Refresh analysis to run the first Gems scan."}
      </p>
      {rows.length > 0 && !fresh && (
        <Notice>
          Saved Gems results are stale. Refresh analysis before reviewing
          candidates.
        </Notice>
      )}
      {fresh && candidates.length === 0 && (
        <Notice>
          No stocks meet every quantitative Gems rule in this scan.
        </Notice>
      )}
      <Table
        rows={candidates}
        columns={[
          "symbol",
          "gems_score",
          "learning_suggestion",
          "price",
          "price_date",
          "trailing_pe",
          "historical_growth_pe_ratio",
          "rsi",
          "volatility_6m_pct",
          "revenue_cagr_pct",
          "earnings_cagr_pct",
          "operating_cash_flow",
          "free_cash_flow",
          "financial_currency",
          "return_on_equity_pct",
          "debt_to_equity",
          "financial_period",
          "gems_status",
          "qualitative_review",
        ]}
        name="Gems candidates"
      />
      {rows.length > 0 && (
        <>
          <button
            aria-expanded={showAudit}
            onClick={() => setShowAudit(!showAudit)}
          >
            {showAudit ? "Hide" : "Show"} Gems screening details
          </button>
          {showAudit && (
            <Table
              rows={rows}
              columns={[
                "symbol",
                "gems_status",
                "gems_reasons",
                "valuation_score",
                "growth_score",
                "cash_score",
                "capital_score",
                "risk_score",
                "sector_median_pe",
                "financial_source",
                "financial_fetched_at",
                "scanned_at",
              ]}
              name="Gems screening details"
            />
          )}
        </>
      )}
      <p className="footnote">
        Gems produces a research shortlist. It does not submit orders.
      </p>
    </Card>
  );
}
export function Recommendations() {
  const [region, setRegion] = useState<"India" | "US">("India");
  const [strategy, setStrategy] = useState<Strategy | "gems">("momentum");
  const india = useData<IndiaLive>(["india-trading"], "/india/trading");
  const broker = india.data?.brokers?.find((b) => b.id === india.data?.broker);
  const identity = `${india.data?.broker ?? ""}:${india.data?.investment_scope ?? ""}`;
  const [planIdentity, setPlanIdentity] = useState("");
  const [savedPlan, setPlan] = useState<IndiaPlan | null>(null);
  const plan = planIdentity === identity ? savedPlan : null;
  const [selected, setSelected] = useState<string[]>([]);
  const [exits, setExits] = useState<string[]>([]);
  const [kite, setKite] = useState(false);
  const [budget, setBudget] = useState(10000);
  const data = useData<Portfolios>("portfolios", "/portfolios");
  const action = useAction(
    (custom: boolean) =>
      request<IndiaPlan>("/india/plan", {
        strategy,
        ...(custom ? { selected, exits } : {}),
      }).then((plan) => ({ plan, identity })),
    [],
  );
  useEffect(() => {
    if (action.data) {
      setPlan(action.data.plan);
      setPlanIdentity(action.data.identity);
      setSelected(action.data.plan.selected);
      setExits(action.data.plan.exits);
    }
  }, [action.data]);
  const picks = data.data?.us.picks || [];
  const usRows = picks.slice(0, 4).map((row) => {
    const allocation = budget * Math.min(0.25, 1 / Math.max(1, picks.length));
    const price = num(row.price);
    return {
      ...row,
      allocation_usd: allocation,
      suggested_shares:
        price && price > 0
          ? Math.floor((allocation / price) * 1000) / 1000
          : null,
    };
  });
  return (
    <>
      <div className="workspace-toolbar recommendations-toolbar">
        <div className="recommendation-controls">
          <RegionPicker
            value={region}
            onChange={(value) => {
              setRegion(value);
              if (value === "US" && strategy !== "gems")
                setStrategy("momentum");
              setPlan(null);
            }}
          />
          <label>
            Strategy
            <select
              value={strategy}
              onChange={(e) => {
                setStrategy(e.target.value as Strategy | "gems");
                setPlan(null);
                setKite(false);
              }}
            >
              <option value="momentum">
                {region === "India" ? "Momentum" : "Business growth"}
              </option>
              {region === "India" && (
                <>
                  <option value="weekend_style">Weekend style</option>
                  <option value="naked_style">Price action</option>
                </>
              )}
              <option value="gems">Gems</option>
            </select>
          </label>
        </div>
        <Refresh market={region} gems={strategy === "gems"} />
      </div>
      {region === "India" && <IndiaBrokerPicker />}
      <Failure error={data.error} />
      {strategy === "gems" ? (
        <>
          <Gems
            key={region}
            rows={data.data?.[region === "India" ? "india" : "us"].gems ?? []}
            market={region}
          />
          {region === "US" && <USGemsPlan />}
        </>
      ) : region === "India" ? (
        <>
          <Card
            title="Build your India allocation"
            subtitle="Choose a strategy, review vetted candidates, then edit shares before broker confirmation."
          >
            <div className="form-row">
              <button
                className="primary"
                disabled={action.isPending || !india.data?.broker}
                onClick={() => action.mutate(false)}
              >
                {action.isPending ? "Preparing…" : "Load recommendation plan"}
              </button>
            </div>
            <Failure error={action.error} />
            {plan && (
              <>
                <div className="selection-grid">
                  <div>
                    <h3>Holdings to replace</h3>
                    {plan.holdings.map((h) => {
                      const key = `${String(h.exchange || "NSE")}:${String(h.symbol)}`;
                      return (
                        <label className="check" key={key}>
                          <input
                            type="checkbox"
                            checked={exits.includes(key)}
                            onChange={(e) =>
                              setExits(
                                e.target.checked
                                  ? [...exits, key]
                                  : exits.filter((v) => v !== key),
                              )
                            }
                          />
                          {String(h.symbol)}
                          <Badge>{String(h.action || "Review")}</Badge>
                        </label>
                      );
                    })}
                  </div>
                  <div>
                    <h3>Vetted new stocks</h3>
                    {plan.choices.map((h) => (
                      <label className="check" key={String(h.buy)}>
                        <input
                          type="checkbox"
                          checked={selected.includes(String(h.buy))}
                          onChange={(e) =>
                            setSelected(
                              e.target.checked
                                ? [...selected, String(h.buy)]
                                : selected.filter((v) => v !== h.buy),
                            )
                          }
                        />
                        {String(h.buy)}
                        <small>
                          <PrivateValue>
                            {money(h.buy_price, "INR")}
                          </PrivateValue>
                        </small>
                      </label>
                    ))}
                    {!plan.choices.length && (
                      <p>No vetted candidates with available prices.</p>
                    )}
                  </div>
                </div>
                <button
                  disabled={action.isPending}
                  onClick={() => action.mutate(true)}
                >
                  Update allocation with selections
                </button>
              </>
            )}
          </Card>
          {plan && (
            <Card
              title="Recommended allocation"
              subtitle={plan.assessment.decision}
              action={
                <button
                  className="primary"
                  onClick={() => setKite(true)}
                  disabled={
                    action.isPending ||
                    JSON.stringify(selected) !==
                      JSON.stringify(plan.selected) ||
                    JSON.stringify(exits) !== JSON.stringify(plan.exits)
                  }
                >
                  Review in {broker?.name ?? "selected broker"}
                </button>
              }
            >
              <Notice>{plan.assessment.reasons.join(" ")}</Notice>
              <Table
                rows={plan.view}
                columns={[
                  "symbol",
                  "status",
                  "current_shares",
                  "price_inr",
                  "target_shares",
                  "shares_to_sell",
                  "shares_to_buy",
                  "target_allocation_pct",
                ]}
                name="India allocation"
              />
              {plan.assessment.next_review && (
                <p className="footnote">
                  Next review ·{" "}
                  {new Date(plan.assessment.next_review).toLocaleString()}
                </p>
              )}
            </Card>
          )}
          {kite && plan && (
            <KiteRebalance
              key={identity}
              brokerName={broker?.name ?? "India broker"}
              plan={{ strategy, selected: plan.selected, exits: plan.exits }}
              onClose={() => setKite(false)}
            />
          )}
          <KiteHistory />
        </>
      ) : (
        <>
          <Card
            title="Long-term growth candidates"
            subtitle="The existing business-quality screen favors earnings, cash generation, and growth; a price trend alone is insufficient."
          >
            <div className="form-row">
              <label>
                Research allocation budget ($)
                <PrivateInput
                  type="number"
                  min="1"
                  value={budget}
                  onChange={(e) => setBudget(Number(e.target.value))}
                />
              </label>
              <Badge>Maximum 4 picks · 25% per stock</Badge>
            </div>
            <Table
              rows={usRows}
              columns={[
                "symbol",
                "price",
                "allocation_usd",
                "suggested_shares",
                "long_term_action",
                "long_term_reasons",
                "momentum_score",
              ]}
              name="US recommendations"
            />
            <p className="footnote">
              Unused allocation stays in cash. These research quantities do not
              send orders.
            </p>
          </Card>
          <Card title="Screened stock universe">
            <Table rows={data.data?.us.ranked} name="US universe" />
          </Card>
        </>
      )}
    </>
  );
}
export function Replacements() {
  const data = useData<Portfolios>("portfolios", "/portfolios");
  return (
    <>
      <div className="workspace-toolbar">
        <p>Research candidates for holdings that need review.</p>
        <Refresh market="India" />
      </div>
      <Failure error={data.error || data.data?.india.error} />
      <Card title="India replacement candidates">
        <Table
          rows={data.data?.india.replacements}
          name="Replacement candidates"
        />
      </Card>
      <Card title="Saved target plans">
        <Table rows={data.data?.india.plan} name="Target plans" />
      </Card>
    </>
  );
}
export function Weekly() {
  return <WeeklyDashboard />;
}

const benchmarks = {
  India: ["Nifty 50", "Nifty Bank", "Sensex"],
  long_term: ["S&P 500", "Nasdaq-100", "Dow Jones", "Russell 2000"],
  trading: ["S&P 500", "Nasdaq-100", "Dow Jones", "Russell 2000"],
};
export function Benchmarks() {
  const [role, setRole] = useState<Role>("long_term");
  const [benchmark, setBenchmark] = useState("S&P 500");
  const [period, setPeriod] = useState("1y");
  const [additional, setAdditional] = useState<string[]>([]);
  const preferences = useData<Preferences>("preferences", "/preferences");
  const available =
    preferences.data?.catalog
      ?.filter((index) => index.region === (role === "India" ? "India" : "US"))
      .map((index) => index.name) || benchmarks[role];
  const accounts = useData<Accounts>("accounts", "/accounts");
  const india = useData<IndiaLive>(["india-trading"], "/india/trading");
  const scope =
    role === "India"
      ? (india.data?.investment_scope ?? "unselected")
      : accounts.data?.roles[role].scope ||
        accounts.data?.roles[role].ending ||
        "local";
  const result = useData<Comparison | null>(
    ["comparisons", role, scope],
    `/comparisons/${role}`,
  );
  const action = useAction(
    () =>
      runJob<Comparison>("/comparisons", {
        role,
        benchmarks: [
          benchmark,
          ...additional.filter((name) => name !== benchmark),
        ],
        period,
      }),
    ["comparisons"],
  );
  const saved =
    result.data && (!result.data.scope || result.data.scope === scope)
      ? result.data
      : null;
  const last = saved?.curve.at(-1);
  const basket = num(last?.["Current holdings basket"]);
  const index = saved ? num(last?.[saved.benchmark]) : undefined;
  const returns = (v: number | undefined) =>
    v === undefined ? "—" : `${(v - 100).toFixed(2)}%`;
  return (
    <>
      <Card
        title="Holdings vs benchmark"
        subtitle="Compare how today’s holdings basket would have moved. Both series start at 100."
      >
        <div className="form-row">
          <label>
            Portfolio
            <select
              value={role}
              onChange={(e) => {
                const next = e.target.value as Role;
                setRole(next);
                setBenchmark(benchmarks[next][0]);
                setAdditional([]);
              }}
            >
              <option value="long_term">US long term</option>
              <option value="trading">US daily trading</option>
              <option value="India">India</option>
            </select>
          </label>
          <label>
            Benchmark
            <select
              value={benchmark}
              onChange={(e) => {
                setBenchmark(e.target.value);
                setAdditional((names) =>
                  names.filter((name) => name !== e.target.value),
                );
              }}
            >
              {available.map((v) => (
                <option key={v}>{v}</option>
              ))}
            </select>
          </label>
          <label>
            Period
            <select value={period} onChange={(e) => setPeriod(e.target.value)}>
              {["1m", "3m", "6m", "1y", "2y"].map((v) => (
                <option key={v}>{v}</option>
              ))}
            </select>
          </label>
          <button
            className="primary"
            disabled={action.isPending}
            onClick={() => action.mutate()}
          >
            {action.isPending ? "Comparing…" : "Compare holdings"}
          </button>
        </div>
        <fieldset className="benchmark-choices">
          <legend>Additional indices on the graph</legend>
          <div className="actions">
            {available
              .filter((name) => name !== benchmark)
              .map((name) => (
                <label className="check benchmark-choice" key={name}>
                  <input
                    type="checkbox"
                    checked={additional.includes(name)}
                    onChange={(event) =>
                      setAdditional(
                        event.target.checked
                          ? [...additional, name]
                          : additional.filter((item) => item !== name),
                      )
                    }
                  />
                  {name}
                </label>
              ))}
          </div>
        </fieldset>
        <Failure error={action.error || result.error} />
        <p className="footnote">
          Saved comparisons survive tab changes and app restarts. A failed
          refresh keeps the last completed graph.
        </p>
      </Card>
      {saved ? (
        <>
          <div className="metrics">
            <Metric
              title="Holdings basket"
              value={returns(basket)}
              detail="Hypothetical price return"
            />
            <Metric
              title={saved.benchmark}
              value={returns(index)}
              detail={`Saved period · ${saved.period}`}
            />
            <Metric
              title="Relative performance"
              value={
                basket !== undefined && index !== undefined
                  ? `${(basket - index).toFixed(2)} pp`
                  : "—"
              }
              detail="Basket minus benchmark"
            />
          </div>
          <Card
            title={`${(saved.benchmarks || [saved.benchmark]).join(" · ")} comparison`}
            subtitle={`Updated ${new Date(saved.updated_at).toLocaleString()}`}
          >
            {saved.holdings_changed && (
              <Notice>
                Holdings changed or are unavailable. This is your saved
                comparison; refresh it to compare the current basket.
              </Notice>
            )}
            <Chart
              rows={saved.curve}
              lines={[
                "Current holdings basket",
                ...(saved.benchmarks || [saved.benchmark]),
              ]}
              title="Current holdings basket versus the selected benchmark"
            />
            <p className="footnote">
              This reconstructs today’s share quantities across historical
              prices. It is not your actual account return. Cash flows, cash,
              dividends, taxes, and fees are excluded.
            </p>
            <Table rows={saved.sources} name="Price sources" />
          </Card>
          <BenchmarkInsights saved={saved} role={role} />
        </>
      ) : (
        <Empty title="See your portfolio in context">
          Select a portfolio and benchmark, then compare your holdings.
        </Empty>
      )}
    </>
  );
}
export function Learning() {
  const data = useData<Market[]>("markets", "/markets", 30_000);
  const lessons = [
    [
      "Trend versus daily return",
      "A positive session can occur below the 50-session average. One measures a single session; the other describes a longer trend.",
    ],
    [
      "Diversification",
      "Several stocks in one sector can share the same risks. Review exposures across sectors and asset classes against your goals.",
    ],
    [
      "Position sizing",
      "Capital allocation and loss at an exit level are different. Account for gaps, liquidity and execution costs.",
    ],
    [
      "Rebalancing",
      "Restore a planned allocation after reviewing costs, taxes and available cash. A price change alone need not trigger a long-term sale.",
    ],
    [
      "Breadth",
      "An index can rise while many constituents fall. Compare participation across stocks with the benchmark.",
    ],
  ];
  const lesson = lessons[Math.floor(Date.now() / 86_400_000) % lessons.length];
  return (
    <>
      <Failure error={data.error} />
      <TradeLearning />
      <div className="learning-grid">
        {data.data?.map((market) => (
          <Card
            key={market.code}
            title={`${market.name} market`}
            subtitle={`${market.benchmark} · ${market.phase}`}
            action={<Badge tone={market.theme}>{market.theme}</Badge>}
          >
            <Metric
              privateData={false}
              title="Latest completed close"
              value={market.report.price?.toLocaleString() || "—"}
              detail={
                market.report.change_pct !== undefined
                  ? `${market.report.change_pct.toFixed(2)}% last session · ${market.report.date}`
                  : market.pending
                    ? "Preparing today’s briefing…"
                    : "Data unavailable"
              }
            />
            {market.history.length > 0 && (
              <Chart
                privateData={false}
                rows={market.history}
                lines={["value"]}
                title={`${market.benchmark} completed session prices`}
              />
            )}
            <h3>What to follow today</h3>
            <p>
              {market.theme === "bullish"
                ? "The benchmark is above its 50-session average. Check participation across sectors and whether your stocks confirm the trend. Avoid chasing a large opening move."
                : market.theme === "bearish"
                  ? "The benchmark is below its 50-session average. Review concentration, liquidity and planned risk limits. Review long-term business evidence separately."
                  : "Confirm current market and stock data before drawing a directional conclusion. Older or missing readings call for patience."}
            </p>
            <h3>Before the bell</h3>
            <p>{market.reflection.opening}</p>
            <h3>After the bell</h3>
            <p>{market.reflection.closing}</p>
            <a href={market.education_url} target="_blank" rel="noreferrer">
              Official investor education ↗
            </a>
            <p className="footnote">
              Source · {market.report.source || "Unavailable"} · Daily briefings
              refresh on each local market day and after close.
            </p>
          </Card>
        ))}
      </div>
      <Card
        title={`Today’s lesson · ${lesson[0]}`}
        action={<BookOpen size={20} />}
      >
        <p>{lesson[1]}</p>
        <div className="learning-grid">
          <div>
            <h3>Long-term account</h3>
            <p>
              Start with your goals, investment horizon and diversified
              allocation. Review earnings, cash flow, business growth and
              concentration before rebalancing.
            </p>
          </div>
          <div>
            <h3>Daily trading account</h3>
            <p>
              Keep its capital and performance separate. Define entry,
              invalidation, position size and daily loss limit before placing a
              trade. Paper trading is an independent simulation.
            </p>
          </div>
        </div>
        <p className="footnote">
          Bullish and bearish labels compare the completed close with its
          50-session average. They describe a trend and do not predict a price
          or instruct an order. Stale readings are gray; public data may be
          delayed.
        </p>
      </Card>
    </>
  );
}

export function AccountSummary() {
  const data = useData<Accounts>("accounts", "/accounts");
  const india = useData<IndiaLive>(["india-trading"], "/india/trading");
  const broker = india.data?.brokers?.find((b) => b.id === india.data?.broker);
  const connected =
    data.data?.roles.long_term.selected && data.data?.roles.trading.selected;
  return (
    <Badge tone={connected ? "bullish" : ""}>
      {connected ? "Robinhood configured" : "Set up accounts"} ·{" "}
      {broker
        ? `${broker.name} · ${broker.connected ? "Connected" : "Connect account"}`
        : "Choose India broker"}
    </Badge>
  );
}
