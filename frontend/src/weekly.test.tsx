import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { WeeklyReview, weeklyAssessment } from "./weekly";

describe("weekly portfolio assessment", () => {
  it("calculates exposure and distinguishes confirmed deterioration from incomplete evidence", () => {
    const result = weeklyAssessment({
      holdings: [
        {
          symbol: "A",
          market_value_inr: 750,
          momentum_score: 20,
          action: "REPLACE",
          confirmed: true,
        },
        { symbol: "B", market_value_inr: 250, action: "NO DATA" },
      ],
    });
    expect(result.total).toBe(1000);
    expect(result.ranked[0].weight_pct).toBe(75);
    expect(result.confirmed).toHaveLength(1);
    expect(result.missing).toHaveLength(1);
    expect(result.attention.map((row) => row.review_priority)).toEqual([
      "Confirmed signal review",
      "Verify data",
    ]);
  });
  it("withholds weights and incomplete history values rather than treating missing valuations as zero", () => {
    const result = weeklyAssessment({
      holdings: [{ symbol: "A", market_value_inr: 500 }, { symbol: "B" }],
      history: [{ date: "2026-10-01", holdings: [{ symbol: "B" }] }],
    });
    expect(result.total).toBeUndefined();
    expect(result.ranked).toEqual([]);
    expect(result.curve).toEqual([]);
  });
  it("compares dated holdings by exchange and symbol and identifies added, removed and changed signals", () => {
    const result = weeklyAssessment({
      as_of: "2026-10-09",
      holdings: [
        { symbol: "A", exchange: "NSE", action: "WATCH" },
        { symbol: "NEW", exchange: "NSE", action: "HOLD" },
      ],
      history: [
        {
          date: "2026-10-08",
          holdings: [{ symbol: "A", exchange: "NSE", action: "WATCH" }],
        },
        {
          date: "2026-10-02",
          holdings: [
            { symbol: "A", exchange: "NSE", action: "HOLD" },
            { symbol: "OLD", exchange: "NSE", action: "HOLD" },
          ],
        },
      ],
    });
    expect(result.baseline?.date).toBe("2026-10-02");
    expect(result.changes.map((row) => row.change)).toEqual([
      "Signal changed",
      "Added position",
      "Removed position",
    ]);
  });
  it("shows missing-history explanations and renders saved report headings without interpreting HTML", () => {
    render(
      <WeeklyReview
        region={{
          holdings: [
            {
              symbol: "A",
              market_value_inr: 100,
              momentum_score: 80,
              action: "HOLD",
            },
          ],
          weekly: "# Archived report\n\n**Review** <script>alert(1)</script>",
        }}
      />,
    );
    expect(
      screen.getByText(/not enough comparable history/),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "Archived report" }),
    ).toBeInTheDocument();
    expect(document.querySelector("script")).toBeNull();
  });
});
