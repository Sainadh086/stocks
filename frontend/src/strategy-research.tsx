import { Card, Table } from "./components";

export function TradingStrategyResearch({
  market,
}: {
  market: "US" | "India";
}) {
  return (
    <Card
      title="Trading research and market fit"
      subtitle={`${market} · Shared signals with market-specific execution`}
    >
      <details className="broker-help">
        <summary>BloombergGPT reference and US / India comparison</summary>
        <p>
          <a
            href="https://arxiv.org/html/2303.17564v3"
            target="_blank"
            rel="noreferrer"
          >
            BloombergGPT research
          </a>{" "}
          evaluates financial sentiment, information extraction and question
          answering. It does not establish a profitable trading system. No
          BloombergGPT model or Bloomberg data feed is connected here. Dated
          headlines in Weekly review provide research context; sentiment alone
          cannot authorize a trade.
        </p>
        <p>
          Both live markets use completed opening-range breakouts, relative
          volume, VWAP/EMA confirmation and ATR-based risk protection. New buys
          and US top-ups now require estimated net reward at least equal to
          estimated risk, with positive target reward even at doubled estimated
          costs. A 2R price target is a scenario, not a forecast.
        </p>
        <Table
          name="Trading market comparison"
          rows={[
            {
              rule: "Regular session",
              US: "09:30–16:00 New York; early closes vary",
              India: "09:15–15:30 Kolkata; NSE calendar",
            },
            {
              rule: "Sizing",
              US: "Fractional dollar buys; equity-based 0.25% planned risk",
              India: "Whole shares; budget-based 0.25% planned risk",
            },
            {
              rule: "Entry cutoff / scheduled exit",
              US: "15 / 5 minutes before close",
              India: "30 / 20 minutes before close, ahead of usual square-off",
            },
            {
              rule: "Estimated round-trip costs",
              US: "Existing fee/spread/slippage model; observed spread can raise estimate",
              India: "At least 0.4% estimate; observed spread can raise it",
            },
            {
              rule: "Position changes",
              US: "Top-ups and stronger-stock replacements, with fresh checks",
              India:
                "One entry per stock per session; managed intraday shares only",
            },
            {
              rule: "Applicability",
              US: "Framework supported; profitability not established",
              India:
                "Framework supported; costs, liquidity and broker rules require separate validation",
            },
          ]}
          columns={["rule", "US", "India"]}
        />
        <p className="footnote">
          The same signal framework can operate in both markets. Equal returns
          or win rates have not been demonstrated. Validate each market out of
          sample with actual costs, slippage, rejected orders and drawdowns
          before increasing capital. Protective exits continue independently of
          entry-quality checks.
        </p>
        <p className="footnote">
          Sources:{" "}
          <a
            href="https://www.nyse.com/trade/hours-calendars"
            target="_blank"
            rel="noreferrer"
          >
            NYSE sessions
          </a>
          ,{" "}
          <a
            href="https://www.nseindia.com/static/market-data/market-timings"
            target="_blank"
            rel="noreferrer"
          >
            NSE sessions
          </a>
          ,{" "}
          <a
            href="https://robinhood.com/us/en/support/articles/day-trading/"
            target="_blank"
            rel="noreferrer"
          >
            Robinhood intraday account rules
          </a>
          . Cost and risk limits above are app heuristics, not exchange
          guarantees.
        </p>
      </details>
    </Card>
  );
}
