import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import unittest

import pandas as pd

from shared import market as messages


class MarketMessageTests(unittest.TestCase):
    def test_messages_available_without_reports_and_for_each_theme(self):
        self.assertEqual(messages.messages(None)["theme"], "neutral")
        for theme in messages.MESSAGES:
            result = messages.messages({"theme": theme})
            self.assertTrue(result["opening"])
            self.assertTrue(result["closing"])
        self.assertNotEqual(
            messages.messages({"theme": "bullish"})["opening"],
            messages.messages({"theme": "bearish"})["opening"],
        )

    def test_session_boundaries_holiday_and_early_close(self):
        schedule = pd.DataFrame(
            {
                "market_open": [pd.Timestamp("2026-10-06T13:30:00Z")],
                "market_close": [pd.Timestamp("2026-10-06T17:00:00Z")],
            }
        )
        for time, expected in [
            ("13:29", "Before market open"),
            ("13:30", "Market open"),
            ("16:59", "Market open"),
            ("17:00", "After market close"),
        ]:
            self.assertEqual(
                messages.session_phase(
                    schedule, pd.Timestamp(f"2026-10-06T{time}:00Z")
                ),
                expected,
            )
        self.assertEqual(
            messages.session_phase(
                pd.DataFrame(), pd.Timestamp("2026-10-06T12:00:00Z")
            ),
            "Market closed",
        )


if __name__ == "__main__":
    unittest.main()
