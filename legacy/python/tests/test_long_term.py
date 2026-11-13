import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import os
import tempfile
import unittest
from copy import deepcopy
from datetime import datetime, timedelta, timezone
from unittest.mock import MagicMock, patch

import pandas as pd
from cryptography.fernet import Fernet

from brokers.robinhood import analysis, long_term
from shared import storage

NOW = datetime(2026, 10, 10, tzinfo=timezone.utc)


def business(weak=False):
    periods = []
    for year, revenue, income in [(2025, 120, 24), (2024, 100, 20), (2023, 80, 16)]:
        if weak:
            revenue, income = 200 - revenue, 40 - income
        periods.append(
            dict(
                date=f"{year}-12-31",
                revenue=revenue,
                earnings=income,
                operating_cash_flow=income * (0.4 if weak else 1.2),
                free_cash_flow=income * (0.2 if weak else 0.9),
            )
        )
    return dict(
        periods=periods,
        data_status="CURRENT",
        sector="Technology",
        quote_type="EQUITY",
        currency="USD",
        fetched_at=NOW.isoformat(),
    )


def technical(weak=False):
    return dict(
        symbol="TEST",
        action="REPLACE" if weak else "HOLD",
        price=80 if weak else 120,
        sma200=100,
        sma50=110,
        return_6m_pct=-15 if weak else 20,
        return_1m_pct=5,
        return_3m_pct=10,
        rsi=60,
        momentum_score=80,
        warnings="",
        strengths="",
    )


class LongTermTests(unittest.TestCase):
    def assess(self, facts=None, weak=False, benchmark=5):
        return long_term.assess(facts or business(), technical(weak), benchmark, NOW)

    def test_healthy_growing_cash_generating_business_can_be_a_pick(self):
        result = self.assess()
        self.assertEqual(result["long_term_action"], "HOLD")
        self.assertTrue(result["long_term_eligible"])
        self.assertEqual(result["long_term_score"], 100)
        self.assertAlmostEqual(result["revenue_growth_pct"], 20)

    def test_price_weakness_alone_never_exits_a_healthy_business(self):
        result = self.assess(weak=True)
        self.assertEqual(result["long_term_action"], "WATCH")
        self.assertFalse(result["long_term_eligible"])

    def test_persistent_growth_and_cash_weakness_with_underperformance_exits(self):
        result = self.assess(business(True), weak=True)
        self.assertEqual(result["long_term_action"], "EXIT REVIEW")
        self.assertEqual(result["relative_return_6m_pp"], -20)
        self.assertIn("Two annual growth declines", result["long_term_reasons"])

    def test_one_weak_year_or_unavailable_benchmark_does_not_force_exit(self):
        facts = business(True)
        facts["periods"][2]["revenue"] = 70
        self.assertEqual(self.assess(facts, weak=True)["long_term_action"], "WATCH")
        self.assertEqual(
            self.assess(business(True), weak=True, benchmark=None)["long_term_action"],
            "WATCH",
        )

    def test_two_years_of_losses_and_cash_burn_trigger_review_without_price_data(self):
        facts = business()
        for period in facts["periods"][:2]:
            period.update(earnings=-10, operating_cash_flow=-5, free_cash_flow=-8)
        result = long_term.assess(facts, {}, now=NOW)
        self.assertEqual(result["long_term_action"], "EXIT REVIEW")

    def test_missing_stale_invalid_or_sector_data_blocks_automatic_decisions(self):
        cases = []
        for key, value in [
            ("data_status", "UNAVAILABLE"),
            ("quote_type", "ETF"),
            ("sector", "Financial Services"),
            ("sector", "Real Estate"),
            ("sector", None),
            ("statements_aligned", False),
        ]:
            facts = business(True)
            facts[key] = value
            cases.append(facts)
        for value in [None, float("nan"), float("inf")]:
            facts = business(True)
            facts["periods"][0]["operating_cash_flow"] = value
            cases.append(facts)
        facts = business(True)
        facts["periods"][0]["date"] = "2023-12-31"
        cases.append(facts)
        for facts in cases:
            with self.subTest(facts=facts):
                result = self.assess(facts, weak=True)
                self.assertEqual(result["long_term_action"], "REVIEW")
                self.assertFalse(result["long_term_eligible"])

    def test_forecasts_are_optional_and_negative_consensus_blocks_buys_not_exits(self):
        facts = business()
        facts["next_year_earnings"] = dict(growth_pct=-5, analysts=12)
        result = self.assess(facts)
        self.assertEqual(result["long_term_action"], "WATCH")
        self.assertIn("estimate, not a guarantee", result["long_term_reasons"])
        facts["next_year_earnings"]["analysts"] = 1
        self.assertTrue(self.assess(facts)["long_term_eligible"])

    def test_recovery_from_losses_does_not_invent_earnings_growth(self):
        facts = business()
        facts["periods"][1]["earnings"] = -10
        result = self.assess(facts)
        self.assertIsNone(result["earnings_growth_pct"])
        self.assertEqual(result["long_term_action"], "WATCH")

    def test_matched_statements_capex_sign_and_missing_values(self):
        dates = pd.to_datetime(["2025-12-31", "2024-12-31"])
        income = pd.DataFrame(
            [[100, 90], [10, 9]], index=["Total Revenue", "Net Income"], columns=dates
        )
        for capex in (-5, 5):
            cash = pd.DataFrame(
                [[20, 18], [capex, capex]],
                index=["Operating Cash Flow", "Capital Expenditure"],
                columns=dates,
            )
            facts = long_term.annual_facts(income, cash, {})
            self.assertEqual(facts["periods"][0]["free_cash_flow"], 15)
            self.assertTrue(facts["statements_aligned"])
        facts = long_term.annual_facts(income, cash.iloc[:, 1:], {})
        self.assertFalse(facts["statements_aligned"])
        self.assertEqual(len(facts["periods"]), 1)

    def test_review_only_sells_flagged_known_positive_quantities(self):
        holdings = pd.DataFrame(
            dict(
                symbol=["BAD", "GOOD", "UNKNOWN", "SHORT"], quantity=[3.25, 2, None, -1]
            )
        )
        report = pd.DataFrame(
            dict(
                symbol=holdings.symbol,
                long_term_action=["EXIT REVIEW", "HOLD", "EXIT REVIEW", "EXIT REVIEW"],
            )
        )
        original = deepcopy(holdings)
        plan = long_term.rebalance_review(holdings, report)
        self.assertEqual(plan.iloc[0].proposed_sell_quantity, 3.25)
        self.assertEqual(plan.iloc[0].proposed_target_quantity, 0)
        self.assertEqual(plan.iloc[1].proposed_sell_quantity, 0)
        self.assertTrue(pd.isna(plan.iloc[2].proposed_sell_quantity))
        self.assertTrue(pd.isna(plan.iloc[3].proposed_sell_quantity))
        pd.testing.assert_frame_equal(original, holdings)

    def test_daily_cache_and_failed_refresh_never_turn_missing_data_into_exit(self):
        with (
            tempfile.TemporaryDirectory() as folder,
            patch.object(storage, "cipher", return_value=Fernet(Fernet.generate_key())),
        ):
            path = Path(folder) / "facts.json"
            provider = long_term.Fundamentals(NOW, path)
            provider.cache["TEST"] = business()
            provider.save()
            self.assertTrue(path.read_bytes().startswith(storage.MAGIC))
            with patch.object(
                long_term.yf, "Ticker", side_effect=RuntimeError("Unavailable")
            ) as fetch:
                cached = long_term.Fundamentals(NOW, path)
                self.assertEqual(cached.get("TEST")["data_status"], "CURRENT")
                fetch.assert_not_called()
                expired = long_term.Fundamentals(NOW + timedelta(days=2), path)
                result = expired.get("TEST")
                self.assertEqual(result["data_status"], "UNAVAILABLE")
                self.assertEqual(
                    long_term.assess(result, technical(True), 5, NOW)[
                        "long_term_action"
                    ],
                    "REVIEW",
                )
                expired.get("TEST")
                self.assertEqual(fetch.call_count, 1)

    def test_report_invalidates_after_account_holdings_policy_or_day_changes(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            source, output, roles = (
                root / name for name in ("holdings.csv", "report.csv", "roles.json")
            )
            for file in (source, output, roles):
                file.touch()
                os.utime(file, (NOW.timestamp(), NOW.timestamp()))
            report = pd.DataFrame(
                dict(
                    long_term_action=["HOLD"],
                    policy_version=[long_term.POLICY_VERSION],
                    holdings_source=[str(source.resolve())],
                )
            )

            def current():
                return long_term.report_is_current(report, output, source, roles, NOW)

            self.assertTrue(current())
            report.loc[0, "holdings_source"] = str(root / "other.csv")
            self.assertFalse(current())
            report.loc[0, "holdings_source"] = str(source.resolve())
            report.loc[0, "policy_version"] = 0
            self.assertFalse(current())
            report.loc[0, "policy_version"] = long_term.POLICY_VERSION
            for file in (source, roles):
                os.utime(file, (NOW.timestamp() + 1, NOW.timestamp() + 1))
                self.assertFalse(current())
                os.utime(file, (NOW.timestamp(), NOW.timestamp()))
            self.assertFalse(
                long_term.report_is_current(
                    report, output, source, roles, NOW + timedelta(days=2)
                )
            )

    def test_fewer_qualified_stocks_keep_budget_unallocated_and_reject_bad_prices(self):
        picks = pd.DataFrame(
            dict(symbol=["GOOD", "ZERO", "UNKNOWN"], price=[100, 0, None])
        )
        plan = analysis.recommended_portfolio(picks, 10000)
        self.assertEqual(plan.symbol.tolist(), ["GOOD"])
        self.assertEqual(plan.iloc[0].target_weight_pct, 25)
        self.assertEqual(plan.iloc[0].target_usd, 2500)
        self.assertEqual(plan.iloc[0].estimated_shares, 25)

    def test_provider_populates_matched_statements_and_forecasts_once(self):
        dates = pd.to_datetime(["2025-12-31", "2024-12-31"])
        ticker = MagicMock()
        ticker.get_info.return_value = dict(
            sector="Technology", quoteType="EQUITY", financialCurrency="USD"
        )
        ticker.income_stmt = pd.DataFrame(
            [[120, 100], [24, 20]], index=["Total Revenue", "Net Income"], columns=dates
        )
        ticker.cashflow = pd.DataFrame(
            [[30, 25], [20, 18]],
            index=["Operating Cash Flow", "Free Cash Flow"],
            columns=dates,
        )
        ticker.get_earnings_estimate.return_value = pd.DataFrame(
            dict(growth=[0.1], numberOfAnalysts=[12]), index=["+1y"]
        )
        ticker.get_revenue_estimate.side_effect = RuntimeError("No estimate")
        with (
            tempfile.TemporaryDirectory() as folder,
            patch.object(long_term.yf, "Ticker", return_value=ticker) as fetch,
        ):
            provider = long_term.Fundamentals(NOW, Path(folder) / "cache.json")
            result = provider.get("GOOD")
            self.assertEqual(result["next_year_earnings"]["growth_pct"], 10)
            self.assertIsNone(result["next_year_revenue"]["growth_pct"])
            self.assertTrue(
                long_term.assess(result, technical(), 5, NOW)["long_term_eligible"]
            )
            provider.get("GOOD")
            self.assertEqual(fetch.call_count, 1)

    def test_screen_and_report_use_business_quality_and_do_not_place_orders(self):
        with (
            tempfile.TemporaryDirectory() as folder,
            patch.object(storage, "cipher", return_value=Fernet(Fernet.generate_key())),
        ):
            root = Path(folder)
            source = root / "holdings.csv"
            storage.write_text(source, "symbol,quantity\nBAD,3\n")
            fundamentals = MagicMock(now=NOW)

            def facts(symbol):
                return business(symbol == "BAD")

            fundamentals.get.side_effect = facts
            with (
                patch.object(analysis, "US_STOCKS_DIR", root),
                patch.object(
                    analysis, "load_index_symbols", return_value=["GOOD", "BAD"]
                ),
                patch.object(analysis, "holdings_source", return_value=source),
                patch.object(long_term, "Fundamentals", return_value=fundamentals),
                patch.object(
                    analysis.momentum,
                    "analyze_stock",
                    side_effect=lambda symbol, market: dict(
                        technical(symbol == "BAD"), symbol=symbol
                    ),
                ),
            ):
                ranked = analysis.screen_index(now=NOW)
                picks = storage.read_csv(next(root.glob("*picks*.csv")))
                self.assertEqual(picks.symbol.tolist(), ["GOOD"])
                report = analysis.report_portfolio(ranked)
                self.assertEqual(report.iloc[0].action, "EXIT REVIEW")
                self.assertEqual(report.iloc[0].replace_with, "GOOD")
                self.assertEqual(report.iloc[0].technical_action, "REPLACE")


if __name__ == "__main__":
    unittest.main()
