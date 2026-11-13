import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import unittest
from datetime import date, datetime
from zoneinfo import ZoneInfo

import pandas as pd

from brokers.kite import assessment as ra


class RebalanceAssessmentTests(unittest.TestCase):
    def setUp(self):
        self.now = datetime(2026, 10, 6, 11, tzinfo=ZoneInfo("Asia/Kolkata"))
        days = ["2026-10-06", "2026-10-07", "2026-10-08", "2026-10-09", "2026-10-12"]
        self.schedule = pd.DataFrame(
            {
                "market_open": [pd.Timestamp(d + "T03:45:00Z") for d in days],
                "market_close": [pd.Timestamp(d + "T10:00:00Z") for d in days],
            },
            index=pd.DatetimeIndex(days),
        )
        self.snapshot = {
            "date": "2026-10-06",
            "holdings": [dict(symbol="OLD", action="HOLD")],
        }
        self.insight = {"date": date(2026, 10, 6), "theme": "bullish"}
        self.view = pd.DataFrame(
            [
                dict(
                    symbol="OLD",
                    status="Exit",
                    signal="HOLD",
                    shares_to_buy=0,
                    shares_to_sell=10,
                    target_shares=0,
                    current_allocation_pct=100,
                    target_allocation_pct=0,
                ),
                dict(
                    symbol="NEW",
                    status="New",
                    signal="Candidate",
                    shares_to_buy=10,
                    shares_to_sell=0,
                    target_shares=10,
                    current_allocation_pct=0,
                    target_allocation_pct=100,
                ),
            ]
        )

    def assess(self):
        return ra.assess(
            self.view, self.snapshot, "momentum", self.insight, self.now, self.schedule
        )

    def test_fresh_strategy_changes_in_open_session(self):
        result = self.assess()
        self.assertEqual(result["decision"], "Rebalance")
        self.assertTrue(result["good_day"])
        self.assertIsNone(result["next_review"])

    def test_confirmed_exit_has_priority_over_bearish_breadth(self):
        self.snapshot["holdings"][0].update(
            action="REPLACE", plan_reason="REPLACE on two dated scans"
        )
        self.view.loc[0, "signal"] = "REPLACE"
        self.insight["theme"] = "bearish"
        self.assertEqual(self.assess()["decision"], "Rebalance needed")
        self.now = self.now.replace(hour=18)
        result = self.assess()
        self.assertFalse(result["good_day"])
        self.assertIn("2026-10-07", result["next_review"])

    def test_stale_scan_or_first_replace_watch(self):
        self.snapshot["date"] = "2026-10-05"
        self.assertEqual(self.assess()["decision"], "Watch")
        self.snapshot["date"] = "2026-10-06"
        self.view.loc[0, "signal"] = "REPLACE"
        self.assertEqual(self.assess()["decision"], "Watch")

    def test_closed_session_skips_holiday_and_weekend(self):
        self.now = datetime(2026, 10, 9, 18, tzinfo=ra.ZONE)
        self.snapshot["date"] = "2026-10-09"
        self.insight["date"] = date(2026, 10, 9)
        self.schedule = self.schedule.drop(pd.Timestamp("2026-10-09"))
        result = self.assess()
        self.assertEqual(result["decision"], "Watch")
        self.assertIn("2026-10-12", result["next_review"])

    def test_hold_has_next_weekly_review_and_missing_data_watch(self):
        self.view["shares_to_sell"] = 0
        self.view["shares_to_buy"] = 0
        result = self.assess()
        self.assertEqual(result["decision"], "Hold")
        self.assertIn("2026-10-09", result["next_review"])
        self.view.loc[0, "target_shares"] = float("nan")
        self.assertEqual(self.assess()["decision"], "Watch")

    def test_bearish_or_unknown_breadth_watch(self):
        for theme in ["bearish", "unknown"]:
            self.insight["theme"] = theme
            self.assertEqual(self.assess()["decision"], "Watch")


if __name__ == "__main__":
    unittest.main()
