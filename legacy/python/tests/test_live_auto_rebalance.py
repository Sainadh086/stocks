import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import unittest
from datetime import datetime, timedelta, timezone
from unittest.mock import Mock, patch

from brokers.robinhood import rebalance as auto

NOW = datetime(2026, 10, 8, 15, tzinfo=timezone.utc)


class AutoRebalanceTests(unittest.TestCase):
    def setUp(self):
        self.state = auto.new_auto_state("TEST")
        self.model = {
            "actions": [dict(symbol="A", action="BUY", side="buy", enabled=True)]
        }
        self.decisions = Mock(return_value=(self.model, {"fresh": True}))
        self.batch = dict(
            id="batch", account="TEST", ticket_ids=["ticket"], status="preview"
        )

    def test_off_by_default_and_account_scoped(self):
        auto.tick_auto(self.state, "TEST", self.decisions, now=NOW)
        self.state["enabled"] = True
        auto.tick_auto(self.state, "OTHER", self.decisions, now=NOW)
        self.decisions.assert_not_called()

    def test_enabled_prepares_and_submits_once_with_fresh_revalidation(self):
        self.state["enabled"] = True

        def submit(batch, *args, **kwargs):
            batch["status"] = "waiting_buys"

        with (
            patch.object(auto, "prepare", return_value=self.batch) as prepare,
            patch.object(auto, "submit", side_effect=submit) as send,
            patch.object(auto, "advance") as advance,
        ):
            result = auto.tick_auto(self.state, "TEST", self.decisions, now=NOW)
            self.assertTrue(result["automatic"])
            self.assertEqual(self.decisions.call_count, 2)
            self.assertTrue(send.call_args.kwargs["acknowledged"])
            auto.tick_auto(
                self.state,
                "TEST",
                self.decisions,
                result,
                now=NOW + timedelta(seconds=1),
            )
            advance.assert_not_called()
            auto.tick_auto(
                self.state,
                "TEST",
                self.decisions,
                result,
                now=NOW + timedelta(seconds=16),
            )
            advance.assert_called_once()
            prepare.assert_called_once()
            send.assert_called_once()

    def test_no_eligible_actions_and_manual_batch_never_submit(self):
        self.state["enabled"] = True
        self.decisions.return_value = ({"actions": []}, {})
        with patch.object(auto, "submit") as send:
            auto.tick_auto(self.state, "TEST", self.decisions, now=NOW)
            self.batch["status"] = "waiting_sales"
            auto.tick_auto(
                self.state,
                "TEST",
                self.decisions,
                self.batch,
                now=NOW + timedelta(seconds=16),
            )
            send.assert_not_called()

    def test_error_pauses_without_retries(self):
        self.state["enabled"] = True
        with (
            patch.object(auto, "prepare", return_value=self.batch),
            patch.object(
                auto, "submit", side_effect=ValueError("Quote expired")
            ) as send,
        ):
            auto.tick_auto(self.state, "TEST", self.decisions, now=NOW)
            self.assertFalse(self.state["enabled"])
            self.assertEqual(self.state["error"], "Quote expired")
            auto.tick_auto(
                self.state,
                "TEST",
                self.decisions,
                self.batch,
                now=NOW + timedelta(seconds=16),
            )
            send.assert_called_once()

    def test_switching_off_stops_unsent_orders_without_cancel_or_submit(self):
        self.state["enabled"] = True
        self.batch.update(status="waiting_sales", automatic=True)
        with patch.object(auto, "advance") as advance:
            auto.disable_auto(self.state, self.batch)
            auto.tick_auto(self.state, "TEST", self.decisions, self.batch, now=NOW)
            self.assertEqual(self.batch["status"], "stopped")
            advance.assert_not_called()
            self.decisions.assert_not_called()

    def test_rejected_batch_pauses_auto_mode(self):
        self.state["enabled"] = True
        self.batch.update(status="waiting_sales", automatic=True)

        def advance(batch, **kwargs):
            batch.update(status="stopped", error="Order rejected")

        with patch.object(auto, "advance", side_effect=advance):
            auto.tick_auto(self.state, "TEST", self.decisions, self.batch, now=NOW)
        self.assertFalse(self.state["enabled"])
        self.assertEqual(self.state["error"], "Order rejected")

    def test_ui_toggle_authorizes_auto_mode_and_switches_it_off(self):
        from streamlit.testing.v1 import AppTest

        from brokers.robinhood import ui as ui

        def submit(batch, *args, **kwargs):
            batch.update(status="waiting_buys", results=[])

        with (
            patch.object(ui.strategy, "saved_budget", return_value=(1000, 10)),
            patch.object(ui, "fresh_decisions", self.decisions),
            patch.object(ui, "progress_view", return_value=Mock()),
            patch.object(auto, "prepare", return_value=self.batch),
            patch.object(auto, "submit", side_effect=submit) as send,
        ):
            app = AppTest.from_string(
                "from brokers.robinhood import ui as ui\nui.render_auto_controls('TEST',1000,10)\nui.run_auto_rebalance('TEST')"
            )
            app.session_state["live_account_number"] = "TEST"
            app.run()
            self.assertFalse(app.exception)
            self.assertFalse(app.toggle[0].value)
            send.assert_not_called()
            app.toggle[0].set_value(True).run()
            self.assertFalse(app.exception)
            self.assertTrue(app.session_state["live_auto_rebalance"]["enabled"])
            send.assert_called_once()
            app.toggle[0].set_value(False).run()
            self.assertFalse(app.exception)
            self.assertFalse(app.session_state["live_auto_rebalance"]["enabled"])
            self.assertEqual(self.batch["status"], "stopped")
            send.assert_called_once()


if __name__ == "__main__":
    unittest.main()
