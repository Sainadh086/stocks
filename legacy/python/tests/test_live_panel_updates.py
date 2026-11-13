"""Panel callbacks must refresh state without requesting a whole-page rerun."""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import unittest
from unittest.mock import patch

from brokers.robinhood import ui as ui


class PanelUpdates(unittest.TestCase):
    def test_submit_invalidates_snapshot_without_page_rerun(self):
        state = {"live_snapshot_checked": "old"}
        with (
            patch.object(ui.st, "session_state", state),
            patch.object(ui.st, "rerun") as rerun,
            patch.object(ui.orders, "submit_reviewed_order") as submit,
        ):
            ui.submit_ticket("ticket", "account")
            submit.assert_called_once_with("ticket", acknowledged=True)
            self.assertNotIn("live_snapshot_checked", state)
            rerun.assert_not_called()

    def test_reconcile_and_saved_ticket_update_panel_state(self):
        state = {"live_snapshot_checked": "old"}
        with (
            patch.object(ui.st, "session_state", state),
            patch.object(ui.st, "rerun") as rerun,
            patch.object(ui.orders, "reconcile_ticket") as reconcile,
        ):
            ui.reconcile_ticket("ticket", "account")
            ui.open_ticket("ticket")
            reconcile.assert_called_once_with("ticket")
            self.assertEqual(state["live_ticket_id"], "ticket")
            self.assertNotIn("live_snapshot_checked", state)
            rerun.assert_not_called()

    def test_errors_preserve_snapshot_and_do_not_retry_submission(self):
        state = {"live_snapshot_checked": "old"}
        with (
            patch.object(ui.st, "session_state", state),
            patch.object(
                ui.orders, "submit_reviewed_order", side_effect=ValueError("Failed")
            ) as submit,
        ):
            ui.submit_ticket("ticket", "account")
            submit.assert_called_once()
            self.assertEqual(state["live_snapshot_checked"], "old")
            self.assertEqual(state["live_action_error"], "Failed")


class HoldingDisplay(unittest.TestCase):
    def test_green_gain_red_loss_and_neutral_zero(self):
        from streamlit.testing.v1 import AppTest

        app = AppTest.from_string("""
from brokers.robinhood import ui as ui
for pnl in [10,-10,0]:
    ui.display_performance({'side':None,'performance':{'invested':100,'value':100+pnl,'pnl':pnl,'return_pct':pnl}})
""").run()
        self.assertFalse(app.exception)
        self.assertEqual(
            [m.delta for m in app.metric],
            ["+$10.00 (+10.00%)", "-$10.00 (-10.00%)", "0"],
        )
        # Positive/negative/flat deltas retain native Streamlit direction/color handling.
        self.assertNotEqual(app.metric[0].proto.color, app.metric[1].proto.color)
        self.assertNotEqual(app.metric[1].proto.color, app.metric[2].proto.color)

    def test_live_view_with_nested_stock_fragment(self):
        import threading
        from types import SimpleNamespace

        from streamlit.testing.v1 import AppTest
        from test_live_strategy import setup_signal, snapshot

        from brokers.robinhood import strategy as live_strategy

        now, signals = setup_signal()
        account = snapshot(now)
        account["quotes"]["A"]["last_trade_price"] = "100"
        account["positions"] = [
            dict(
                symbol="A",
                quantity="2",
                average_buy_price="80",
                shares_available_for_sells="2",
            )
        ]
        monitor = SimpleNamespace(snapshot=lambda: signals, wake=threading.Event())
        with (
            patch.object(
                ui.account_roles,
                "load_roles",
                return_value={"long_term": "INVEST", "trading": "TEST1234"},
            ),
            patch.object(ui.alerts, "_COMPONENT"),
            patch.object(ui, "signal_monitor", return_value=monitor),
            patch.object(live_strategy, "saved_budget", return_value=(1000, 10)),
            patch.object(
                ui.orders,
                "list_trading_accounts",
                return_value=[dict(account_number="TEST1234", agentic_allowed=True)],
            ),
            patch.object(ui.orders, "account_snapshot", return_value=account) as fetch,
            patch.object(ui.orders, "list_tickets", return_value=[]),
            patch.object(
                ui.st, "rerun", side_effect=AssertionError("Must not reload page")
            ),
        ):
            app = AppTest.from_string(
                "from brokers.robinhood import ui as live_trading_ui\nlive_trading_ui.render()"
            ).run()
            self.assertFalse(app.exception)
            app.session_state["live_snapshot_pending"][0].result(timeout=2)
            app.run()
            self.assertTrue(any(m.delta == "+$40.00 (+25.00%)" for m in app.metric))
            next(
                b for b in app.button if b.label == "Refresh stock signals"
            ).click().run()
            app.session_state["live_snapshot_pending"][0].result(timeout=2)
            app.run()
            self.assertFalse(app.exception)
            self.assertEqual(fetch.call_count, 2)


if __name__ == "__main__":
    unittest.main()
