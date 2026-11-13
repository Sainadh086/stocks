"""Daily public-market data must stay dated, nonblocking and independent of trades."""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import unittest
from datetime import datetime, timedelta
from threading import Event
from unittest.mock import patch
from zoneinfo import ZoneInfo

import pandas as pd
from streamlit.testing.v1 import AppTest

from shared import market, market_data


class DailyMarketTests(unittest.TestCase):
    def setUp(self):
        self.spec = market.MARKETS[1]
        self.now = datetime(2026, 10, 6, 17, tzinfo=ZoneInfo(self.spec.zone))
        self.sessions = pd.DataFrame(
            {
                "market_close": pd.to_datetime(
                    ["2026-10-05T20:00Z", "2026-10-06T20:00Z"]
                )
            },
            index=pd.to_datetime(["2026-10-05", "2026-10-06"]),
        )
        self.history = pd.DataFrame(
            {"Close": list(range(100, 160))},
            index=pd.bdate_range(end="2026-10-06", periods=60, tz=self.spec.zone),
        )

    def report(self, now=None, history=None):
        return market.benchmark_report(
            self.history if history is None else history,
            self.spec,
            now or self.now,
            self.sessions,
        )

    def test_direction_is_trend_not_one_session_return(self):
        report = self.report()
        self.assertEqual(report["theme"], "bullish")
        self.assertAlmostEqual(report["sma50"], sum(range(110, 160)) / 50)
        history = self.history.copy()
        history.iloc[-1, 0] = 150
        report = self.report(history=history)
        self.assertLess(report["change_pct"], 0)
        self.assertEqual(report["theme"], "bullish")
        history.iloc[-1, 0] = 90
        self.assertEqual(self.report(history=history)["theme"], "bearish")
        history["Close"] = 100
        self.assertEqual(self.report(history=history)["theme"], "mixed")

    def test_incomplete_today_and_future_bars_are_excluded(self):
        before_close = self.now.replace(hour=15)
        report = self.report(now=before_close)
        self.assertEqual(report["date"].isoformat(), "2026-10-05")
        self.assertEqual(report["price"], 158)
        future = pd.DataFrame(
            {"Close": [10000]},
            index=pd.to_datetime(["2026-10-07"]).tz_localize(self.spec.zone),
        )
        self.assertEqual(
            self.report(history=pd.concat([self.history, future]))["price"], 159
        )

    def test_exchange_holiday_is_not_stale_but_missing_session_is(self):
        holiday = self.now + timedelta(days=1)
        report = self.report(now=holiday)
        self.assertFalse(report["stale"])
        self.assertEqual(market.report_theme(report, holiday), "bullish")
        older = self.report(history=self.history.iloc[:-1])
        self.assertTrue(older["stale"])
        self.assertEqual(market.report_theme(older, self.now), "stale")
        self.assertEqual(
            market.report_theme(report, holiday + timedelta(days=1)), "stale"
        )
        self.assertEqual(market.report_theme(None, self.now), "unavailable")

    def test_invalid_and_short_history_cannot_produce_a_color(self):
        with self.assertRaisesRegex(ValueError, "50 completed"):
            self.report(history=self.history.iloc[-49:])
        bad = self.history.copy()
        bad["Close"] = float("nan")
        with self.assertRaises(ValueError):
            self.report(history=bad)

    def test_background_fetch_is_shared_and_refreshes_on_next_day(self):
        loader = market.DailyMarkets()
        started, release = Event(), Event()

        def fetch(spec, now):
            started.set()
            if not release.wait(2):
                raise TimeoutError("Test worker did not release")
            return self.report(now=now)

        with patch.object(
            market_data, "fetch_daily_report", side_effect=fetch
        ) as download:
            first = loader.snapshot(self.spec, self.now, "After market close")
            self.assertEqual(first, (None, None, True))
            self.assertTrue(started.wait(1))
            loader.snapshot(self.spec, self.now, "After market close")
            self.assertEqual(download.call_count, 1)
            pending = loader.states["US"].pending
            release.set()
            pending.result(timeout=2)
            report, error, running = loader.snapshot(
                self.spec, self.now, "After market close"
            )
            self.assertEqual(report["briefing_date"], self.now.date())
            self.assertIsNone(error)
            self.assertFalse(running)
            next_day = self.now + timedelta(days=1)
            loader.snapshot(self.spec, next_day, "After market close")
            loader.states["US"].pending.result(timeout=2)
            report, _, _ = loader.snapshot(self.spec, next_day, "After market close")
            self.assertEqual(report["briefing_date"], next_day.date())
            self.assertEqual(download.call_count, 2)

    def test_after_close_refresh_and_error_preserve_previous_report(self):
        loader = market.DailyMarkets()
        before = self.now.replace(hour=15)
        with patch.object(
            market_data, "fetch_daily_report", return_value=self.report(now=before)
        ):
            loader.snapshot(self.spec, before, "Market open")
            loader.states["US"].pending.result(timeout=2)
            previous, _, _ = loader.snapshot(self.spec, before, "Market open")
        with patch.object(
            market_data, "fetch_daily_report", side_effect=OSError("Feed down")
        ) as download:
            loader.snapshot(self.spec, self.now, "After market close")
            pending = loader.states["US"].pending
            with self.assertRaises(OSError):
                pending.result(timeout=2)
            report, error, running = loader.snapshot(
                self.spec, self.now, "After market close"
            )
            self.assertEqual(report["price"], previous["price"])
            self.assertTrue(report["stale"])
            self.assertIn("Feed down", error)
            self.assertFalse(running)
            loader.snapshot(self.spec, self.now, "After market close")
            self.assertEqual(download.call_count, 1)
            with patch.object(
                market_data,
                "monotonic",
                return_value=loader.states["US"].attempted_at + 301,
            ):
                loader.snapshot(self.spec, self.now, "After market close")
                with self.assertRaises(OSError):
                    loader.states["US"].pending.result(timeout=2)
            self.assertEqual(download.call_count, 2)

    def test_header_and_learning_render_for_both_markets_without_network(self):
        report = self.report()
        with (
            patch.object(
                market,
                "daily_snapshot",
                return_value=(self.now, "After market close", report, None, False),
            ),
            patch.object(market, "latest_insight", return_value=None),
        ):
            app = AppTest.from_string(
                "from shared import market, market_data\nmarket.render_header()\nmarket.render_learning('/tmp/india', '/tmp/us')"
            ).run()
        self.assertFalse(app.exception)
        self.assertEqual(len(app.metric), 2)
        self.assertTrue(any("India market" in item.value for item in app.subheader))
        self.assertTrue(any("US market" in item.value for item in app.subheader))
        with (
            patch.object(
                market,
                "daily_snapshot",
                return_value=(self.now, "Market closed", None, "Feed down", False),
            ),
            patch.object(market, "latest_insight", return_value=None),
        ):
            app.run()
        self.assertFalse(app.exception)
        self.assertEqual(len(app.metric), 0)


if __name__ == "__main__":
    unittest.main()
