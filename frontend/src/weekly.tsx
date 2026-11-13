import { usePreferences } from "./preferences";
import { Fragment } from "react";
import {
  Card,
  Chart,
  Empty,
  Metric,
  Notice,
  Table,
  money,
  num,
} from "./components";
import type { Region, Row } from "./types";

const identity = (row: Row) =>
  `${row.exchange || ""}:${row.symbol || row.stock || ""}`;
const finite = (input: unknown) => {
  const result = num(input);
  return result !== undefined && Number.isFinite(result) ? result : undefined;
};
const value = (row: Row) => finite(row.market_value_inr);
const totalValue = (rows: Row[]) =>
  rows.length &&
  rows.every((row) => value(row) !== undefined && value(row)! >= 0)
    ? rows.reduce((sum, row) => sum + value(row)!, 0)
    : undefined;
const dated = (row: Row) =>
  typeof row.date === "string" &&
  /^\d{4}-\d{2}-\d{2}$/.test(row.date) &&
  Number.isFinite(Date.parse(row.date));

export function weeklyAssessment(region: Region) {
  const rows = region.holdings || [];
  const history = (region.history || [])
    .filter(dated)
    .sort((a, b) => String(a.date).localeCompare(String(b.date)));
  const savedDate = region.as_of?.slice(0, 10);
  const date =
    savedDate && dated({ date: savedDate })
      ? savedDate
      : String(history.at(-1)?.date || "");
  const prior = history.filter((item) => String(item.date) < date);
  const weekStart = date
    ? new Date(Date.parse(date) - 7 * 86400000).toISOString().slice(0, 10)
    : "";
  // Prefer a snapshot at the start of the review window; otherwise use the earliest available within it.
  const baseline =
    prior.filter((item) => String(item.date) <= weekStart).at(-1) || prior[0];
  const previous: Row[] = Array.isArray(baseline?.holdings)
    ? baseline.holdings
    : [];
  const total = totalValue(rows);
  const ranked: (Row & { weight_pct: number })[] =
    total && total > 0
      ? rows
          .map((row) => ({ ...row, weight_pct: (value(row)! / total) * 100 }))
          .sort((a, b) => b.weight_pct - a.weight_pct)
      : [];
  const covered = rows.filter(
    (row) => finite(row.momentum_score) !== undefined,
  );
  const missing = rows.filter(
    (row) =>
      finite(row.momentum_score) === undefined || row.action === "NO DATA",
  );
  const watch = rows.filter((row) => row.action === "WATCH");
  const replace = rows.filter((row) => row.action === "REPLACE");
  const confirmed = replace.filter(
    (row) => String(row.confirmed).toLowerCase() === "true",
  );
  const attention = rows
    .filter(
      (row) =>
        missing.includes(row) ||
        watch.includes(row) ||
        replace.includes(row) ||
        row.portfolio_plan === "SELL",
    )
    .map((row) => ({
      symbol: row.symbol,
      signal: row.action || "Not available",
      weight_pct:
        total && total > 0
          ? Math.round((value(row)! / total) * 1000) / 10
          : undefined,
      review_priority: missing.includes(row)
        ? "Verify data"
        : confirmed.includes(row)
          ? "Confirmed signal review"
          : row.action === "REPLACE"
            ? "Await confirmation"
            : row.portfolio_plan === "SELL"
              ? "Allocation review"
              : "Monitor trend",
      plan_reason:
        row.plan_reason ||
        (missing.includes(row)
          ? "Trend evidence is incomplete. Verify prices before reviewing an allocation change."
          : "Review the current trend and your allocation plan."),
    }));
  const changes: Row[] = [];
  if (previous.length) {
    for (const row of rows) {
      const old = previous.find((item) => identity(item) === identity(row));
      if (!old)
        changes.push({
          symbol: row.symbol,
          change: "Added position",
          previous_signal: "—",
          current_signal: row.action || "—",
        });
      else if (old.action !== row.action)
        changes.push({
          symbol: row.symbol,
          change: "Signal changed",
          previous_signal: old.action || "—",
          current_signal: row.action || "—",
        });
    }
    for (const row of previous)
      if (!rows.some((item) => identity(item) === identity(row)))
        changes.push({
          symbol: row.symbol,
          change: "Removed position",
          previous_signal: row.action || "—",
          current_signal: "—",
        });
  }
  const curve = history
    .flatMap((snapshot) => {
      const snapshotRows = Array.isArray(snapshot.holdings)
        ? (snapshot.holdings as Row[])
        : [];
      const amount = totalValue(snapshotRows);
      return amount === undefined
        ? []
        : [{ date: snapshot.date, "Stock value (INR)": amount }];
    })
    .slice(-12);
  return {
    rows,
    date,
    baseline,
    total,
    ranked,
    covered,
    missing,
    watch,
    replace,
    confirmed,
    attention,
    changes,
    curve,
  };
}

// Render saved reports as React text nodes. Never interpret report content as HTML.
function SavedNotes({ text }: { text: string }) {
  const blocks = text.trim().split(/\n\s*\n/);
  const inline = (line: string) =>
    line
      .split(/(\*\*[^*]+\*\*)/g)
      .map((part, index) =>
        part.startsWith("**") ? (
          <strong key={index}>{part.slice(2, -2)}</strong>
        ) : (
          part
        ),
      );
  return (
    <div className="saved-review">
      {blocks.map((block, i) => {
        const lines = block.split("\n");
        if (lines.length > 1 && /^\s*\|?\s*:?-{3,}/.test(lines[1])) {
          const cells = (line: string) =>
            line
              .trim()
              .replace(/^\||\|$/g, "")
              .split("|")
              .map((cell) => cell.trim());
          return (
            <div className="table-scroll" key={i}>
              <table>
                <thead>
                  <tr>
                    {cells(lines[0]).map((cell, j) => (
                      <th key={j}>{inline(cell)}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {lines.slice(2).map((line, j) => (
                    <tr key={j}>
                      {cells(line).map((cell, k) => (
                        <td key={k}>{inline(cell)}</td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          );
        }
        return (
          <Fragment key={i}>
            {lines.map((line, j) => {
              if (/^#{1,6}\s/.test(line))
                return (
                  <h3 key={j}>{inline(line.replace(/^#{1,6}\s+/, ""))}</h3>
                );
              if (/^\s*([-*]|\d+\.)\s/.test(line))
                return (
                  <p className="review-bullet" key={j}>
                    {inline(line.replace(/^\s*([-*]|\d+\.)\s+/, ""))}
                  </p>
                );
              if (/^[-*_]{3,}$/.test(line.trim())) return <hr key={j} />;
              return <p key={j}>{inline(line)}</p>;
            })}
          </Fragment>
        );
      })}
    </div>
  );
}

export function WeeklyReview({ region }: { region: Region }) {
  const { privacy } = usePreferences();
  const review = weeklyAssessment(region);
  if (privacy) return <Notice>Portfolio review hidden in privacy mode.</Notice>;
  if (!review.rows.length)
    return (
      <Card title="Your weekly portfolio review">
        <Empty title="No holdings to review yet">
          Refresh India analysis to load holdings, trend signals and dated
          portfolio snapshots.
        </Empty>
        {region.weekly && (
          <details className="review-notes">
            <summary>Saved review notes</summary>
            <SavedNotes text={region.weekly} />
          </details>
        )}
      </Card>
    );
  const top = review.ranked[0];
  const topThree = review.ranked
    .slice(0, 3)
    .reduce((sum, row) => sum + row.weight_pct, 0);
  return (
    <>
      <Card
        title="Your portfolio at a glance"
        subtitle={
          review.date
            ? `India · Latest saved analysis: ${review.date}`
            : "India · Saved holdings; analysis date unavailable"
        }
      >
        <p className="review-lead">
          {review.rows.length} positions in your India portfolio.{" "}
          {review.replace.length
            ? `${review.replace.length} have replacement signals; ${review.confirmed.length} are confirmed across two dated scans.`
            : "No saved replacement signals."}{" "}
          {review.missing.length
            ? `${review.missing.length} positions need data verification.`
            : "Momentum scores are available for every position."}
        </p>
        <div className="metrics review-metrics">
          <Metric
            title="Stock value"
            value={money(review.total, "INR")}
            detail="Cash excluded · saved valuation"
          />
          <Metric
            title="Largest position"
            value={top ? `${top.weight_pct.toFixed(1)}%` : "—"}
            detail={top ? String(top.symbol) : "Complete valuations needed"}
          />
          <Metric
            title="Needs attention"
            value={review.attention.length}
            detail={`${review.watch.length} watch · ${review.replace.length} replacement signals`}
          />
          <Metric
            title="Score coverage"
            value={`${Math.round((review.covered.length / review.rows.length) * 100)}%`}
            detail={`${review.covered.length} of ${review.rows.length} positions scored`}
          />
        </div>
      </Card>
      <div className="review-grid">
        <Card
          title="Concentration & exposure"
          subtitle="Understand which positions have the most influence on your portfolio."
        >
          {top ? (
            <>
              <p>
                Your largest position is <strong>{String(top.symbol)}</strong>{" "}
                at <strong>{top.weight_pct.toFixed(1)}%</strong> of stock value.
                Your top three positions account for{" "}
                <strong>{topThree.toFixed(1)}%</strong>.
              </p>
              <div className="exposure-list">
                {review.ranked.slice(0, 5).map((row) => (
                  <div className="exposure-row" key={identity(row)}>
                    <div>
                      <strong>{String(row.symbol)}</strong>
                      <span>{row.weight_pct.toFixed(1)}%</span>
                    </div>
                    <div className="exposure-track">
                      <span style={{ width: `${row.weight_pct}%` }} />
                    </div>
                  </div>
                ))}
              </div>
              <p className="footnote">
                Position weights use saved stock values. Sector exposure and
                total account exposure cannot be inferred without sector and
                cash data.
              </p>
            </>
          ) : (
            <Notice>
              One or more valuations are missing. Refresh prices to calculate
              reliable position weights.
            </Notice>
          )}
        </Card>
        <Card
          title="Focus for your next review"
          subtitle="Review evidence before making any allocation changes."
        >
          <ol className="review-checklist">
            <li>
              <strong>Validate the evidence</strong>
              <p>
                {review.missing.length
                  ? `Verify missing trend data for ${review.missing.map((row) => String(row.symbol)).join(", ")}. Missing data alone is not an exit signal.`
                  : "All positions have saved momentum scores. Check the analysis date before relying on the signals."}
              </p>
            </li>
            <li>
              <strong>Review deteriorating trends</strong>
              <p>
                {review.confirmed.length
                  ? `${review.confirmed.map((row) => String(row.symbol)).join(", ")} have confirmed replacement signals. Review the business thesis, liquidity, costs and taxes before an exit.`
                  : review.replace.length
                    ? "Replacement signals are awaiting confirmation. Compare the next dated scan before deciding on an exit."
                    : "No confirmed replacement signals are saved. Monitor watch-list positions for changes."}
              </p>
            </li>
            <li>
              <strong>Check your allocation</strong>
              <p>
                {top
                  ? `Review whether ${String(top.symbol)} at ${top.weight_pct.toFixed(1)}% matches your intended allocation and risk tolerance.`
                  : "Obtain complete valuations before reviewing allocation sizes."}{" "}
                Replacement candidates remain research ideas until their quality
                checks and sizing are reviewed.
              </p>
            </li>
          </ol>
        </Card>
      </div>
      <Card
        title="Positions needing attention"
        subtitle="Watch signals, confirmed deterioration, allocation flags and gaps in the evidence."
      >
        {review.attention.length ? (
          <Table rows={review.attention} name="Weekly attention" />
        ) : (
          <Notice>
            No positions are currently flagged in the saved analysis.
          </Notice>
        )}
      </Card>
      <Card
        title="What changed"
        subtitle={
          review.baseline
            ? `Latest holdings compared with the snapshot from ${String(review.baseline.date)}.`
            : "A second dated holdings snapshot is needed to identify changes."
        }
      >
        {review.baseline &&
        Array.isArray(review.baseline.holdings) &&
        review.baseline.holdings.length ? (
          review.changes.length ? (
            <Table rows={review.changes} name="Weekly changes" />
          ) : (
            <Notice>
              No position additions, removals or signal changes in the available
              snapshots.
            </Notice>
          )
        ) : (
          <Notice>
            There is not enough comparable history yet. Refresh analysis on
            another trading day to build the review history.
          </Notice>
        )}
        <p className="footnote">
          Changes describe saved positions and signals, not executed trades. The
          comparison period is shown above and may differ from one week.
        </p>
      </Card>
      <Card
        title="Portfolio value history"
        subtitle="Up to 12 saved snapshots · stock value in INR"
      >
        {review.curve.length > 1 ? (
          <Chart
            rows={review.curve}
            lines={["Stock value (INR)"]}
            title="Saved India stock value history"
          />
        ) : (
          <Notice>
            At least two snapshots with complete valuations are needed to draw a
            history chart.
          </Notice>
        )}
        <p className="footnote">
          Stock value changes include changes in share quantities. This is not a
          cash-flow-adjusted investment return; cash, dividends, taxes and fees
          are excluded.
        </p>
      </Card>
      {region.weekly && (
        <Card
          title="Saved review notes"
          subtitle="The archived report is kept alongside the current portfolio assessment."
        >
          <details className="review-notes">
            <summary>Read the saved report</summary>
            <SavedNotes text={region.weekly} />
          </details>
        </Card>
      )}
    </>
  );
}
