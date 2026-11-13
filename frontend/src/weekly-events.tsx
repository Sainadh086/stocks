import { useEffect, useRef, useState } from "react";
import { useAction, useData, runJob } from "./api";
import { Badge, Card, Empty, Failure, Notice, Table } from "./components";
import { WeeklyReview } from "./weekly";
import type {
  Accounts,
  Headline,
  Live,
  Portfolios,
  Role,
  WeeklyEvents,
} from "./types";

function Headlines({ items }: { items: Headline[] }) {
  return items.length ? (
    <ul className="headline-list">
      {items.map((item) => (
        <li key={item.url}>
          <a href={item.url} target="_blank" rel="noreferrer">
            {item.title} ↗
          </a>
          <small>
            {item.publisher} ·{" "}
            {new Date(item.published_at).toLocaleDateString()}
          </small>
        </li>
      ))}
    </ul>
  ) : (
    <p className="footnote">
      No verified headlines returned for this seven-day window. This does not
      establish that no events occurred.
    </p>
  );
}
export function WeeklyDashboard() {
  const [role, setRole] = useState<Role>("India");
  const accounts = useData<Accounts>("accounts", "/accounts");
  const portfolios = useData<Portfolios>("portfolios", "/portfolios");
  const live = useData<Live>("live", "/live");
  const scope =
    role === "India" ? "India" : accounts.data?.roles[role]?.scope || "local";
  const report = useData<WeeklyEvents | null>(
    ["weekly", role, scope],
    `/weekly/${role}`,
  );
  const refresh = useAction(
    (selected: Role) => runJob<WeeklyEvents>(`/weekly/${selected}`),
    ["weekly", "live"],
  );
  const attempted = useRef(new Set<string>());
  const today = new Date().toISOString().slice(0, 10);
  useEffect(() => {
    const key = `${role}:${scope}:${today}`;
    if (
      report.isPending ||
      refresh.isPending ||
      report.error ||
      attempted.current.has(key)
    )
      return;
    if (!report.data || report.data.generated_at?.slice(0, 10) !== today) {
      attempted.current.add(key);
      refresh.mutate(role);
    }
  }, [
    role,
    scope,
    today,
    report.isPending,
    report.data,
    report.error,
    refresh.isPending,
    refresh.mutate,
  ]);
  const saved =
    report.data && (!report.data.scope || report.data.scope === scope)
      ? report.data
      : null;
  const currentUS =
    !portfolios.data?.us.scope ||
    portfolios.data.us.scope === accounts.data?.roles.long_term.scope;
  const currentTrading =
    !live.data?.scope || live.data.scope === accounts.data?.roles.trading.scope;
  return (
    <>
      <div className="workspace-toolbar">
        <div className="segments" aria-label="Weekly portfolio">
          {(["India", "long_term", "trading"] as const).map((choice) => (
            <button
              key={choice}
              aria-pressed={role === choice}
              className={role === choice ? "active" : ""}
              onClick={() => setRole(choice)}
            >
              {choice === "India"
                ? "India"
                : choice === "long_term"
                  ? "US"
                  : "US trading"}
            </button>
          ))}
        </div>
        <button
          disabled={refresh.isPending}
          onClick={() => refresh.mutate(role)}
        >
          {refresh.isPending ? "Reviewing events…" : "Refresh weekly insights"}
        </button>
      </div>
      <Failure error={report.error || refresh.error || portfolios.error} />
      <Card
        title="This week in markets & your holdings"
        subtitle={
          saved
            ? `${new Date(saved.from).toLocaleDateString()} – ${new Date(saved.to).toLocaleDateString()} · Updated ${new Date(saved.generated_at).toLocaleString()}`
            : "Dated market events and news for the selected portfolio · trailing seven days"
        }
      >
        {saved ? (
          <>
            <p className="review-lead">{saved.summary}</p>
            {saved.holdings_changed && (
              <Notice>
                Holdings have changed or are unavailable. Refresh to review the
                current selected account.
              </Notice>
            )}
          </>
        ) : (
          <Notice>
            {refresh.isPending
              ? "Gathering dated headlines and completed-session prices…"
              : "Refresh weekly insights to load this portfolio’s market and holdings events."}
          </Notice>
        )}
      </Card>
      {saved && (
        <>
          <div className="review-grid">
            {saved.markets.map((market) => (
              <Card
                title={`${market.region} · weekly market events`}
                subtitle={
                  market.price_source
                    ? `Price source: ${market.price_source}`
                    : "Price source unavailable"
                }
                key={market.region}
              >
                <p>{market.summary}</p>
                <Failure error={market.error} />
                <Headlines items={market.headlines} />
              </Card>
            ))}
          </div>
          <Card
            title="Your holdings · weekly moves"
            subtitle="Completed-session price changes; each holding’s dates and price source are shown."
          >
            <Table
              name="Weekly holdings moves"
              rows={saved.holdings.map(({ headlines, error, ...row }) => ({
                ...row,
                dated_headlines: headlines.length,
                news_status:
                  error ||
                  (headlines.length
                    ? "Headlines available"
                    : "No dated headlines returned"),
              }))}
            />
          </Card>
          <Card
            title="Events affecting your holdings"
            subtitle="Reported headlines matched to each ticker. A headline is not proof of why a stock moved."
          >
            {saved.holdings.length ? (
              saved.holdings.map((holding, index) => (
                <details
                  className="holding-news"
                  key={holding.symbol}
                  open={index < 3 && holding.headlines.length > 0}
                >
                  <summary>
                    <strong>{holding.symbol}</strong>
                    <Badge>{holding.headlines.length} headlines</Badge>
                  </summary>
                  <Failure error={holding.error} />
                  <Headlines items={holding.headlines} />
                </details>
              ))
            ) : (
              <Empty title="No holdings in this report" />
            )}
          </Card>
        </>
      )}
      {role === "India" ? (
        <WeeklyReview region={portfolios.data?.india || { holdings: [] }} />
      ) : (
        <>
          <Card
            title={
              role === "long_term"
                ? "US long-term · business quality"
                : "US trading · positions & risk"
            }
            subtitle={
              role === "long_term"
                ? "Review cash generation, earnings and growth alongside trend evidence."
                : "Keep this account’s capital and short-term risk separate from your investing portfolio."
            }
          >
            {role === "long_term" ? (
              currentUS && portfolios.data?.us.report_current ? (
                <Table
                  rows={portfolios.data.us.report}
                  columns={[
                    "symbol",
                    "long_term_action",
                    "long_term_reasons",
                    "revenue_growth_pct",
                    "earnings_growth_pct",
                    "operating_cash_flow",
                    "free_cash_flow",
                    "return_6m_pct",
                  ]}
                  name="Weekly US quality"
                />
              ) : (
                <Notice>
                  Refresh US analysis from Holdings to produce a current
                  financial review for the selected long-term account.
                </Notice>
              )
            ) : currentTrading && live.data?.snapshot ? (
              <Table
                rows={live.data.snapshot.positions}
                name="Weekly trading positions"
              />
            ) : (
              <Notice>
                Refresh weekly insights to load the selected daily trading
                account. Weekly review never starts trading.
              </Notice>
            )}
          </Card>
          <Card title="Next review priorities">
            <ol className="review-checklist">
              <li>
                <strong>
                  {role === "long_term"
                    ? "Check the business evidence"
                    : "Review trade discipline"}
                </strong>
                <p>
                  {role === "long_term"
                    ? "Review earnings, revenue growth and cash flow before treating price weakness as business deterioration."
                    : "Review entries, exits, position sizes and the daily loss limit against your trading plan."}
                </p>
              </li>
              <li>
                <strong>Compare risk and momentum</strong>
                <p>
                  Use Benchmark comparison for annualized volatility, drawdown,
                  beta and three- and six-month momentum against multiple
                  indices.
                </p>
              </li>
              <li>
                <strong>Verify reported events</strong>
                <p>
                  Open the linked sources for earnings and other company events.
                  Recheck filings and dates before changing your allocation.
                </p>
              </li>
            </ol>
          </Card>
        </>
      )}
    </>
  );
}
