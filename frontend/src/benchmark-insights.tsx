import { Card, Metric, Notice, Table, num } from "./components";
import type { Comparison, Role } from "./types";
const pct = (value: unknown) =>
  num(value) === undefined ? "—" : `${num(value)!.toFixed(2)}%`;
export function BenchmarkInsights({
  saved,
  role,
}: {
  saved: Comparison;
  role: Role;
}) {
  const insights = saved.insights;
  if (!insights)
    return (
      <Notice>
        Run a new comparison to calculate risk, momentum and business-quality
        insights for this saved portfolio.
      </Notice>
    );
  const portfolioVol = num(insights.portfolio.volatility_pct);
  const primaryVol = num(insights.comparisons[0]?.volatility_pct);
  const highVol = insights.stocks
    .filter(
      (stock) =>
        primaryVol !== undefined &&
        (num(stock.volatility_pct) ?? -1) > primaryVol,
    )
    .sort((a, b) => (num(b.weight_pct) || 0) - (num(a.weight_pct) || 0));
  const weak = insights.stocks.filter(
    (stock) => (num(stock.momentum_6m_pct) ?? Infinity) <= 0,
  );
  const gaps = insights.stocks.filter(
    (stock) =>
      stock.quality_status === "Evidence needed" ||
      stock.quality_status === "REVIEW",
  );
  return (
    <>
      <Card
        title="Risk, momentum & diversification"
        subtitle={`${insights.start_date} – ${insights.end_date} · Same aligned price dates for holdings and selected indices`}
      >
        <div className="metrics review-metrics">
          <Metric
            title="Portfolio volatility"
            value={pct(portfolioVol)}
            detail="Annualized daily price volatility"
          />
          <Metric
            title="Maximum drawdown"
            value={pct(insights.portfolio.max_drawdown_pct)}
            detail="Largest peak-to-trough fall"
          />
          <Metric
            title="Effective positions"
            value={insights.effective_positions.toFixed(1)}
            detail="Concentration-adjusted position count"
          />
          <Metric
            title="Top-three exposure"
            value={pct(insights.top_three_weight_pct)}
            detail="Current stock-value weights"
          />
        </div>
        <Table
          name="Benchmark risk and momentum"
          rows={[insights.portfolio, ...insights.comparisons]}
          columns={[
            "name",
            "return_pct",
            "volatility_pct",
            "max_drawdown_pct",
            "beta",
            "momentum_3m_pct",
            "momentum_6m_pct",
            "excess_return_pp",
          ]}
        />
        <details className="review-notes">
          <summary>How these insights are calculated</summary>
          <p className="footnote">
            {insights.methodology} Missing metrics stay blank. Beta is measured
            against {saved.benchmark}. Lower historical volatility does not
            guarantee future stability or growth.
          </p>
        </details>
      </Card>
      <div className="review-grid">
        <Card title="Reduce concentration & volatility">
          <p>
            {portfolioVol !== undefined && primaryVol !== undefined
              ? `Your basket’s volatility is ${portfolioVol.toFixed(2)}% compared with ${primaryVol.toFixed(2)}% for ${saved.benchmark}.`
              : "At least 20 aligned daily returns are needed to estimate volatility."}
          </p>
          <p>
            {highVol.length
              ? `Review the sizing of ${highVol
                  .slice(0, 5)
                  .map((stock) => String(stock.symbol))
                  .join(
                    ", ",
                  )}: these holdings are more volatile than the primary index over this window. Check overlapping sector risks before adding another position.`
              : "Use the individual-stock table to review the relationship between position size, volatility and beta."}
          </p>
          <p className="footnote">
            An effective position count below your actual number of holdings
            indicates uneven weights. It does not measure sector diversity.
          </p>
        </Card>
        <Card
          title={
            role === "trading"
              ? "Strengthen trade selection"
              : "Improve long-term stock selection"
          }
        >
          <ol className="review-checklist">
            <li>
              <strong>Pair momentum with quality</strong>
              <p>
                {weak.length
                  ? `${weak.map((stock) => String(stock.symbol)).join(", ")} have non-positive six-month momentum. Review the trend alongside earnings and cash generation.`
                  : "Compare three- and six-month momentum before treating a short rally as a durable trend."}
              </p>
            </li>
            <li>
              <strong>Verify growth and cash flow</strong>
              <p>
                {gaps.length
                  ? `${gaps.length} holdings lack a complete current quality assessment. Refresh US analysis and review financial filings before treating them as growth candidates.`
                  : "Review the dated earnings, revenue and cash-flow evidence below. Price strength alone does not establish future business growth."}
              </p>
            </li>
            <li>
              <strong>Control position risk</strong>
              <p>
                Review high-weight, high-volatility positions first. Consider
                concentration, liquidity and taxes when evaluating a change;
                there is no automatic trade from this analysis.
              </p>
            </li>
          </ol>
        </Card>
      </div>
      <Card
        title="Your stocks · risk & business quality"
        subtitle="Current weights, price momentum and financial evidence available from the saved quality review."
      >
        <Table
          rows={insights.stocks}
          name="Stock risk and quality"
          columns={[
            "symbol",
            "weight_pct",
            "volatility_pct",
            "beta",
            "momentum_3m_pct",
            "momentum_6m_pct",
            "revenue_growth_pct",
            "earnings_growth_pct",
            "free_cash_flow",
            "financial_period",
            "quality_status",
            "quality_review",
          ]}
        />
      </Card>
      {role === "long_term" && (
        <Card
          title="Long-term growth research shortlist"
          subtitle="Candidates from your saved quality-vetted US scan, enriched with price risk and momentum. Verify current filings before acting."
        >
          {insights.candidates?.length ? (
            <Table
              name="Growth research candidates"
              rows={insights.candidates}
              columns={[
                "symbol",
                "volatility_pct",
                "momentum_3m_pct",
                "momentum_6m_pct",
                "revenue_growth_pct",
                "earnings_growth_pct",
                "free_cash_flow",
                "financial_period",
                "financial_fetched_at",
                "start_date",
                "end_date",
                "quality_review",
              ]}
            />
          ) : (
            <Notice>
              No quality-vetted research candidates are saved. Refresh US
              analysis in Holdings to review earnings, cash flow and growth
              candidates.
            </Notice>
          )}
          <p className="footnote">
            Candidate price-history windows may differ from the aligned
            portfolio window. Saved eligibility is not a fresh buy
            recommendation. Missing sector, valuation, regulatory and
            future-growth data are not inferred.
          </p>
        </Card>
      )}
    </>
  );
}
