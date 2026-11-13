import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import json
import unittest
from unittest.mock import Mock, patch

import pandas as pd
from streamlit.testing.v1 import AppTest

from brokers.robinhood import performance
from shared import prices


def history():
    return pd.DataFrame(
        {
            "Open": [100, 110],
            "High": [101, 111],
            "Low": [99, 109],
            "Close": [100, 110],
            "Volume": [1000, 1200],
        },
        index=pd.date_range(end=pd.Timestamp.now(tz="UTC").normalize(), periods=2),
    )


class BenchmarkPriceTests(unittest.TestCase):
    def test_monitored_quantities_update_comparison_without_downloading_again(self):
        index = pd.date_range("2026-10-01", periods=2)
        data = {
            "A": pd.Series([100, 110], index=index),
            "B": pd.Series([100, 90], index=index),
            "^GSPC": pd.Series([100, 105], index=index),
        }
        with patch.object(
            performance,
            "comparison_prices",
            side_effect=lambda symbol, period: (data[symbol], "TradingView"),
        ) as read:
            app = AppTest.from_string(
                "import streamlit as st\nfrom brokers.robinhood import performance\n"
                "st.session_state.setdefault('basket',[('A',1),('B',1)])\n"
                "st.session_state.setdefault('identity','trading-a')\n"
                "performance.render_benchmark([], 'US', None, provider=lambda: (st.session_state['basket'], 'US', st.session_state['identity'], 'Monitored holdings'))"
            ).run()
            next(b for b in app.button if b.label == "Compare holdings").click().run()
            self.assertFalse(app.exception)
            self.assertEqual(app.metric[0].value, "+0.00%")
            app.session_state["basket"] = [("A", 3), ("B", 1)]
            app.run()
            self.assertFalse(app.exception)
            self.assertEqual(app.metric[0].value, "+5.00%")
            self.assertEqual(read.call_count, 3)
            app.session_state["basket"] = []
            app.run()
            self.assertEqual(app.metric[0].value, "+5.00%")
            self.assertTrue(
                any(
                    "Showing the saved comparison" in item.value for item in app.warning
                )
            )
            app.session_state["basket"] = [("A", 3), ("B", 1)]
            app.run()
            self.assertEqual(read.call_count, 3)
            app.session_state["identity"] = "trading-b"
            app.run()
            self.assertFalse(app.metric)

    def test_share_weighted_curve_uses_common_dates_and_starts_at_100(self):
        dates = pd.date_range("2026-10-01", periods=3)
        frame = performance.basket_comparison(
            [("A", 2), ("B", 1)],
            {
                "A": pd.Series([100, 110, 120], index=dates),
                "B": pd.Series([100, 90, 100], index=dates),
            },
            "Index",
            pd.Series([100, 105], index=dates[:2]),
        )
        self.assertEqual(len(frame), 2)
        self.assertEqual(frame.iloc[0].tolist(), [100, 100])
        self.assertAlmostEqual(frame.iloc[-1, 0], 310 / 300 * 100)
        self.assertEqual(frame.iloc[-1, 1], 105)

    def test_missing_holdings_or_insufficient_dates_block_entire_curve(self):
        series = pd.Series([100, 110], index=pd.date_range("2026-10-01", periods=2))
        with self.assertRaisesRegex(ValueError, "B"):
            performance.basket_comparison(
                [("A", 1), ("B", 1)], {"A": series}, "Index", series
            )
        with self.assertRaisesRegex(ValueError, "common"):
            performance.basket_comparison(
                [("A", 1)], {"A": series.iloc[:1]}, "Index", series
            )
        for quantity in (0, -1, float("nan"), float("inf")):
            with self.assertRaises(ValueError):
                performance.basket_comparison(
                    [("A", quantity)], {"A": series}, "Index", series
                )

    def test_fallback_for_empty_or_failed_yahoo_and_preserves_source(self):
        fallback = history()
        fallback.attrs["source"] = "TradingView"
        for yahoo in (pd.DataFrame(), OSError("Yahoo unavailable")):
            ticker = Mock()
            if isinstance(yahoo, Exception):
                ticker.history.side_effect = yahoo
            else:
                ticker.history.return_value = yahoo
            with (
                patch.object(prices.yf, "Ticker", return_value=ticker),
                patch.object(prices, "tradingview_history", return_value=fallback),
            ):
                result = prices.history("AAPL", auto_adjust=False)
                self.assertEqual(result.attrs["source"], "TradingView")
                self.assertEqual(len(result), 2)

    def test_valid_yahoo_does_not_contact_fallback_and_both_fail_is_explicit(self):
        ticker = Mock()
        ticker.history.return_value = history()
        with (
            patch.object(prices.yf, "Ticker", return_value=ticker),
            patch.object(prices, "tradingview_history") as fallback,
        ):
            self.assertEqual(
                prices.history("AAPL", period="3m").attrs["source"], "Yahoo Finance"
            )
            self.assertEqual(ticker.history.call_args.kwargs["period"], "3mo")
            fallback.assert_not_called()
        ticker.history.side_effect = OSError("No Yahoo")
        with (
            patch.object(prices.yf, "Ticker", return_value=ticker),
            patch.object(
                prices, "tradingview_history", side_effect=ValueError("No TradingView")
            ),
        ):
            with self.assertRaisesRegex(ValueError, "Yahoo Finance and TradingView"):
                prices.history("AAPL")

    def test_tradingview_packet_fragment_heartbeat_and_ohlcv(self):
        packet = prices.wire_message("symbol_resolved", ["India ₹"])
        decoded, pending = prices.decode_messages(packet[:10])
        self.assertFalse(decoded)
        decoded, pending = prices.decode_messages(pending + packet[10:] + "~m~4~m~~h~1")
        self.assertEqual(json.loads(decoded[0])["p"], ["India ₹"])
        self.assertEqual(decoded[1], "~h~1")
        self.assertFalse(pending)
        socket = Mock()
        socket.__enter__ = Mock(return_value=socket)
        socket.__exit__ = Mock(return_value=False)
        socket.recv.side_effect = [
            prices.wire_message(
                "timescale_update",
                [
                    "session",
                    {"s1": {"s": [{"v": [1791576000, 100, 101, 99, 100, 1000]}]}},
                ],
            ),
            prices.wire_message("series_completed", ["session", "s1"]),
        ]
        with patch.object(prices, "connect", return_value=socket):
            result = prices.tradingview_history("^GSPC", bars=1)
        self.assertEqual(result.attrs["source"], "TradingView")
        self.assertEqual(result.Close.iloc[0], 100)
        self.assertEqual(
            result.index.tz.zone
            if hasattr(result.index.tz, "zone")
            else str(result.index.tz),
            "America/New_York",
        )

    def test_comparisons_are_separate_for_accounts_and_restore_on_return(self):
        series = pd.Series([100, 110], index=pd.date_range("2026-10-01", periods=2))
        with patch.object(
            performance, "comparison_prices", return_value=(series, "TradingView")
        ) as fetch:
            source = (
                "import streamlit as st\nfrom brokers.robinhood import performance\n"
                "st.session_state.setdefault('account','account-a')\n"
                "performance.render_benchmark([('AAPL',1)],'US', st.session_state['account'])"
            )
            app = AppTest.from_string(source).run()
            next(b for b in app.button if b.label == "Compare holdings").click().run()
            self.assertFalse(app.exception)
            self.assertEqual(len(app.metric), 3)
            self.assertEqual(app.metric[0].value, "+10.00%")
            app.session_state["account"] = "account-b"
            app.run()
            self.assertEqual(len(app.metric), 0)
            next(b for b in app.button if b.label == "Compare holdings").click().run()
            app.session_state["account"] = "account-a"
            app.run()
            self.assertEqual(len(app.metric), 3)
            self.assertEqual(fetch.call_count, 4)

    def test_navigation_restores_nondefault_settings_and_chart_without_refetch(self):
        series = pd.Series([100, 110], index=pd.date_range("2026-10-01", periods=2))
        source = (
            "import streamlit as st\nfrom brokers.robinhood import performance\n"
            "view=st.segmented_control('View',['Comparison','Other'],default='Comparison',key='view')\n"
            "if view=='Comparison':\n"
            "    performance.render_benchmark([('AAPL',1)],'US','account-a')\n"
            "else:\n    st.info('Another tab')"
        )
        with patch.object(
            performance, "comparison_prices", return_value=(series, "Yahoo Finance")
        ) as fetch:
            app = AppTest.from_string(source).run()
            app.selectbox[0].set_value("Nasdaq-100")
            app.selectbox[1].set_value("6m")
            next(b for b in app.button if b.label == "Compare holdings").click().run()
            self.assertFalse(app.exception)
            self.assertEqual(len(app.metric), 3)
            app.segmented_control[0].set_value("Other").run()
            self.assertFalse(app.selectbox)
            app.run()  # Also survive full reruns while the comparison widgets are absent.
            app.segmented_control[0].set_value("Comparison").run()
            self.assertFalse(app.exception)
            self.assertEqual(app.selectbox[0].value, "Nasdaq-100")
            self.assertEqual(app.selectbox[1].value, "6m")
            self.assertEqual(len(app.metric), 3)
            self.assertEqual(fetch.call_count, 2)

    def test_existing_session_comparison_migrates_without_refetching(self):
        series = pd.Series([100, 110], index=pd.date_range("2026-10-01", periods=2))
        curve = pd.DataFrame({"Current holdings basket": series, "Nasdaq-100": series})
        source = "from brokers.robinhood import performance\nperformance.render_benchmark([('AAPL',1)],'US','account-a')"
        app = AppTest.from_string(source)
        app.session_state["benchmark_result"] = (
            ("account-a", (("AAPL", 1),), "Nasdaq-100", "6m"),
            curve,
            [],
        )
        app.session_state["benchmark_history"] = (
            "account-a",
            "Nasdaq-100",
            "6m",
            {"AAPL": series},
            series,
            [],
        )
        with patch.object(performance, "comparison_prices") as fetch:
            app.run()
            self.assertFalse(app.exception)
            self.assertEqual(app.selectbox[0].value, "Nasdaq-100")
            self.assertEqual(app.selectbox[1].value, "6m")
            self.assertEqual(len(app.metric), 3)
            fetch.assert_not_called()

    def test_editing_settings_or_failed_refresh_preserves_completed_comparison(self):
        series = pd.Series([100, 110], index=pd.date_range("2026-10-01", periods=2))
        source = "from brokers.robinhood import performance\nperformance.render_benchmark([('AAPL',1)],'US','account-a')"
        with patch.object(
            performance, "comparison_prices", return_value=(series, "Yahoo Finance")
        ) as fetch:
            app = AppTest.from_string(source).run()
            next(b for b in app.button if b.label == "Compare holdings").click().run()
            app.selectbox[0].set_value("Nasdaq-100").run()
            self.assertEqual(len(app.metric), 3)
            self.assertEqual(app.metric[1].label, "S&P 500 price return")
            fetch.side_effect = ValueError("Temporary provider outage")
            next(b for b in app.button if b.label == "Compare holdings").click().run()
            self.assertFalse(app.exception)
            self.assertEqual(len(app.metric), 3)
            self.assertTrue(
                any(
                    "Temporary provider outage" in warning.value
                    for warning in app.warning
                )
            )
            self.assertEqual(app.metric[1].label, "S&P 500 price return")


if __name__ == "__main__":
    unittest.main()
