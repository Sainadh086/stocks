import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import json
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from unittest.mock import Mock, patch

import pandas as pd

from brokers.robinhood import analysis
from trading import agent as agent

NOW = datetime(2026, 10, 5, 15, 0, tzinfo=timezone.utc)


def scan(*symbols):
    return pd.DataFrame(
        [
            dict(
                symbol=s,
                price=100,
                sma50=90,
                sma200=80,
                rsi=55,
                action="HOLD",
                return_1m_pct=3,
                return_3m_pct=6,
                return_6m_pct=12,
                momentum_score=10 - i,
            )
            for i, s in enumerate(symbols)
        ]
    )


def quotes(*symbols, price=100, when=NOW):
    return {s: dict(price=price, timestamp=when.isoformat()) for s in symbols}


class PaperTests(unittest.TestCase):
    def test_buy_reserve_and_repeated_checks(self):
        state = agent.advance(
            agent.new_account(1000, 10), scan("A", "B"), quotes("A", "B"), NOW
        )
        self.assertAlmostEqual(state["cash"], 100)
        self.assertEqual(len(state["fills"]), 2)
        again = agent.advance(state, scan("A", "B"), quotes("A", "B", price=110), NOW)
        self.assertEqual(len(again["fills"]), 2)
        self.assertEqual(again["positions"]["A"]["quantity"], 4.5)
        self.assertEqual(again["positions"]["A"]["price"], 110)

    def test_sell_and_replace_with_realized_profit(self):
        state = agent.advance(agent.new_account(1000, 10), scan("A"), quotes("A"), NOW)
        ranked = scan("A", "B")
        ranked.loc[0, "action"] = "REPLACE"
        next_state = agent.advance(state, ranked, quotes("A", "B", price=110), NOW)
        self.assertEqual(set(next_state["positions"]), {"B"})
        self.assertAlmostEqual(next_state["realized_pnl"], 90)
        self.assertGreaterEqual(next_state["cash"], 109)
        self.assertEqual(
            [f["side"] for f in next_state["fills"]], ["BUY", "SELL", "BUY"]
        )

    def test_bad_quotes_or_missing_signals_leave_account_untouched(self):
        state = agent.advance(agent.new_account(1000, 10), scan("A"), quotes("A"), NOW)
        original = json.dumps(state)
        for bad in (
            {},
            quotes("A", when=NOW - timedelta(minutes=16)),
            quotes("A", price=float("nan")),
        ):
            with self.assertRaises(ValueError):
                agent.advance(state, scan("A"), bad, NOW)
        with self.assertRaises(ValueError):
            agent.advance(state, scan("B"), quotes("A", "B"), NOW)
        ranked = scan("A")
        ranked.loc[0, "rsi"] = float("nan")
        with self.assertRaises(ValueError):
            agent.advance(state, ranked, quotes("A"), NOW)
        self.assertEqual(json.dumps(state), original)

    def test_pause_end_and_full_reserve(self):
        state = agent.new_account(1000, 100)
        self.assertEqual(agent.advance(state, scan("A"), quotes("A"), NOW)["fills"], [])
        for status in ("Paused", "Ended"):
            state["status"] = status
            self.assertEqual(agent.advance(state, scan("A"), quotes("A"), NOW), state)

    def test_persist_controls_restart_and_duplicate_start(self):
        with (
            tempfile.TemporaryDirectory() as directory,
            patch.object(
                agent.secure_storage,
                "read_text",
                side_effect=lambda p: Path(p).read_text(),
            ),
            patch.object(
                agent.secure_storage,
                "write_text",
                side_effect=lambda p, s: Path(p).write_text(s),
            ),
        ):
            path = Path(directory) / "account.json"
            worker = agent.PaperAgent(path, start_worker=False)
            worker.control("start", agent.new_account(1000, 10))
            worker.control("start", agent.new_account(2000, 20))
            self.assertEqual(worker.snapshot()["budget"], 1000)
            worker.control("pause")
            restarted = agent.PaperAgent(path, start_worker=False)
            self.assertEqual(restarted.snapshot()["status"], "Paused")
            worker.control("resume")
            worker.control("end")
            self.assertEqual(worker.snapshot()["status"], "Ended")

    def test_closed_market_does_not_fetch_or_trade(self):
        with (
            tempfile.TemporaryDirectory() as directory,
            patch.object(
                agent.secure_storage,
                "read_text",
                side_effect=lambda p: Path(p).read_text(),
            ),
            patch.object(
                agent.secure_storage,
                "write_text",
                side_effect=lambda p, s: Path(p).write_text(s),
            ),
            patch.object(analysis, "screen_index") as screen,
        ):
            worker = agent.PaperAgent(
                Path(directory) / "account.json", start_worker=False
            )
            worker.control("start", agent.new_account(1000, 10))
            worker.cycle(datetime(2026, 10, 4, 15, tzinfo=timezone.utc))
            screen.assert_not_called()
            self.assertEqual(worker.snapshot()["fills"], [])
            self.assertIn("Market closed", worker.snapshot()["message"])

    def test_pause_during_fetch_prevents_commit(self):
        with (
            tempfile.TemporaryDirectory() as directory,
            patch.object(
                agent.secure_storage,
                "read_text",
                side_effect=lambda p: Path(p).read_text(),
            ),
            patch.object(
                agent.secure_storage,
                "write_text",
                side_effect=lambda p, s: Path(p).write_text(s),
            ),
        ):
            worker = agent.PaperAgent(
                Path(directory) / "account.json", start_worker=False
            )
            worker.control("start", agent.new_account(1000, 10))
            worker.ranked = scan("A")
            worker.scanned_at = NOW

            def fetch(symbols):
                worker.control("pause")
                return quotes("A")

            with patch.object(
                worker.feed, "fetch", side_effect=lambda now, held: fetch(held)
            ):
                worker.cycle(NOW)
            self.assertEqual(worker.snapshot()["status"], "Paused")
            self.assertEqual(worker.snapshot()["fills"], [])


class PaperUITests(unittest.TestCase):
    def test_legacy_paper_import_uses_its_fills_without_long_term_scan(self):
        from trading import ui

        worker = Mock()
        worker.snapshot.return_value = None
        old = dict(
            budget=1000,
            reserve_pct=10,
            cash=800,
            status="Paused",
            positions={"A": 2},
            fills=[dict(symbol="A", side="BUY", quantity=2, price=100, value=200)],
        )
        state = {"us_paper_account": old}
        with (
            patch.object(ui.st, "session_state", state),
            patch.object(ui.prices, "history") as prices,
            patch.object(agent.secure_storage, "read_csv") as scan,
        ):
            ui.migrate_browser_session(worker)
        imported = worker.control.call_args.args[1]
        self.assertEqual(imported["positions"]["A"]["price"], 100)
        self.assertEqual(imported["positions"]["A"]["cost"], 200)
        self.assertEqual(imported["status"], "Paused")
        self.assertNotIn("us_paper_account", state)
        scan.assert_not_called()
        prices.assert_not_called()

    def test_start_pause_resume_end_and_monitoring_display(self):
        from streamlit.testing.v1 import AppTest

        from trading import ui as us_trading_lab

        with (
            tempfile.TemporaryDirectory() as directory,
            patch.object(
                agent.secure_storage,
                "read_text",
                side_effect=lambda p: Path(p).read_text(),
            ),
            patch.object(
                agent.secure_storage,
                "write_text",
                side_effect=lambda p, s: Path(p).write_text(s),
            ),
        ):
            worker = agent.PaperAgent(
                Path(directory) / "account.json", start_worker=False
            )
            us_trading_lab.agent.clear()
            with (
                patch.object(agent, "PaperAgent", return_value=worker),
                patch(
                    "streamlit.rerun",
                    side_effect=AssertionError(
                        "Trading controls must not rerun the app"
                    ),
                ),
            ):
                app = AppTest.from_string(
                    "from trading import ui as us_trading_lab\nus_trading_lab.render()"
                ).run()
                self.assertFalse(app.exception)
                next(
                    b for b in app.button if b.label == "Start paper session"
                ).click().run()
                self.assertFalse(app.exception)
                self.assertEqual(worker.snapshot()["status"], "Running")
                state = agent.advance(worker.snapshot(), scan("A"), quotes("A"), NOW)
                agent.secure_storage.write_text(worker.path, json.dumps(state))
                app.run()
                self.assertEqual(app.metric[0].value, "$1,000.00")
                self.assertTrue(
                    any(
                        "symbol" in item.value.columns
                        and "quantity" in item.value.columns
                        for item in app.dataframe
                    )
                )
                for label, expected in [
                    ("Pause paper session", "Paused"),
                    ("Resume paper session", "Running"),
                    ("End paper session", "Ended"),
                ]:
                    next(b for b in app.button if b.label == label).click().run()
                    self.assertFalse(app.exception)
                    self.assertEqual(worker.snapshot()["status"], expected)
                self.assertEqual(len(worker.snapshot()["fills"]), 1)
            us_trading_lab.agent.clear()


if __name__ == "__main__":
    unittest.main()
