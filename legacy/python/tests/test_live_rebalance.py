import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import unittest
from copy import deepcopy
from datetime import datetime, timedelta, timezone
from unittest.mock import patch

from brokers.robinhood import rebalance as rebalance


class RebalanceTests(unittest.TestCase):
    def setUp(self):
        self.model = {
            "actions": [
                dict(
                    symbol="BUY",
                    action="BUY",
                    side="buy",
                    enabled=True,
                    dollar_amount="100",
                ),
                dict(
                    symbol="SELL",
                    action="EXIT",
                    side="sell",
                    enabled=True,
                    quantity="2",
                ),
                dict(symbol="HOLD", action="HOLD", side=None, enabled=False),
            ]
        }
        self.tickets = {}

        def preview(args):
            ticket = dict(
                id=args["symbol"],
                arguments=args,
                preview={},
                reviewed_at=datetime.now(timezone.utc).isoformat(),
                status="preview",
            )
            self.tickets[ticket["id"]] = ticket
            return ticket

        self.patches = [
            patch.object(rebalance.orders, "preview_order", side_effect=preview),
            patch.object(
                rebalance.orders,
                "save_ticket",
                side_effect=lambda t: self.tickets.update({t["id"]: t}),
            ),
            patch.object(
                rebalance.orders,
                "get_ticket",
                side_effect=lambda i: self.tickets.get(i),
            ),
            patch.object(
                rebalance.orders,
                "get_tickets",
                side_effect=lambda ids: {
                    i: self.tickets[i] for i in ids if i in self.tickets
                },
            ),
        ]
        for p in self.patches:
            p.start()
            self.addCleanup(p.stop)
        self.batch = rebalance.prepare("ACCOUNT", self.model, {"asof": "signal"})

    def test_preview_only_and_sells_first_with_single_confirmation(self):
        self.assertEqual(self.batch["ticket_ids"], ["SELL", "BUY"])
        with patch.object(
            rebalance.orders,
            "submit_reviewed_order",
            return_value={
                "status": "submitted",
                "result": {"order": {"state": "filled"}},
            },
        ) as submit:
            with self.assertRaises(ValueError):
                rebalance.submit(self.batch, self.model)
            submit.assert_not_called()
            result = rebalance.submit(self.batch, self.model, acknowledged=True)
            self.assertEqual(result["status"], "completed")
            self.assertEqual(
                [c.args[0] for c in submit.call_args_list], ["SELL", "BUY"]
            )
            with self.assertRaises(ValueError):
                rebalance.submit(self.batch, self.model, acknowledged=True)
            self.assertEqual(submit.call_count, 2)

    def test_expired_or_changed_batch_submits_nothing(self):
        self.tickets["BUY"]["reviewed_at"] = (
            datetime.now(timezone.utc) - timedelta(minutes=3)
        ).isoformat()
        with patch.object(rebalance.orders, "submit_reviewed_order") as submit:
            with self.assertRaises(ValueError):
                rebalance.submit(self.batch, self.model, acknowledged=True)
            submit.assert_not_called()
        self.tickets["BUY"]["reviewed_at"] = datetime.now(timezone.utc).isoformat()
        changed = deepcopy(self.model)
        changed["actions"][0]["dollar_amount"] = "50"
        with patch.object(rebalance.orders, "submit_reviewed_order") as submit:
            with self.assertRaises(ValueError):
                rebalance.submit(self.batch, changed, acknowledged=True)
            submit.assert_not_called()

    def test_partial_failure_stops_and_does_not_retry(self):
        for failure in ["rejected", "unknown", "not_submitted"]:
            batch = deepcopy(self.batch)
            with patch.object(
                rebalance.orders,
                "submit_reviewed_order",
                return_value={"status": failure},
            ) as submit:
                rebalance.submit(batch, self.model, acknowledged=True)
                self.assertEqual(batch["status"], "stopped")
                submit.assert_called_once_with("SELL", acknowledged=True)

    def test_buy_waits_for_sell_fill(self):
        sequence = []

        def submit(ticket_id, acknowledged):
            sequence.append("submit:" + ticket_id)
            return {
                "status": "submitted",
                "result": {
                    "order": {"state": "queued" if ticket_id == "SELL" else "filled"}
                },
            }

        def reconcile(ticket_id):
            sequence.append("fill:" + ticket_id)
            return {"status": "submitted", "result": {"order": {"state": "filled"}}}

        with (
            patch.object(rebalance.orders, "submit_reviewed_order", side_effect=submit),
            patch.object(rebalance.orders, "reconcile_ticket", side_effect=reconcile),
        ):
            result = rebalance.submit(self.batch, self.model, True)
            self.assertEqual(result["status"], "waiting_sales")
            result = rebalance.advance(self.batch)
        self.assertEqual(sequence, ["submit:SELL", "fill:SELL", "submit:BUY"])
        self.assertEqual(result["status"], "completed")

    def test_pending_or_partial_sell_blocks_buys_and_success(self):
        for state in ["queued", "partially_filled", "cancelled", "rejected"]:
            batch = deepcopy(self.batch)
            receipt = {"status": "submitted", "result": {"order": {"state": state}}}
            with (
                patch.object(
                    rebalance.orders, "submit_reviewed_order", return_value=receipt
                ) as submit,
                patch.object(
                    rebalance.orders, "reconcile_ticket", return_value=receipt
                ),
            ):
                result = rebalance.submit(batch, self.model, True)
                submit.assert_called_once_with("SELL", acknowledged=True)
                self.assertEqual(
                    result["status"],
                    "stopped"
                    if state in {"cancelled", "rejected"}
                    else "waiting_sales",
                )

    def test_long_wait_then_automatic_buy_without_second_confirmation(self):
        receipt = {
            "status": "submitted",
            "result": {"order": {"state": "partially_filled"}},
        }
        with (
            patch.object(
                rebalance.orders,
                "submit_reviewed_order",
                side_effect=[
                    receipt,
                    {"status": "submitted", "result": {"order": {"state": "filled"}}},
                ],
            ) as submit,
            patch.object(
                rebalance.orders,
                "reconcile_ticket",
                side_effect=[receipt] * 8
                + [{"status": "submitted", "result": {"order": {"state": "filled"}}}],
            ),
        ):
            rebalance.submit(self.batch, self.model, True)
            for _ in range(8):
                rebalance.advance(self.batch)
                self.assertEqual(self.batch["status"], "waiting_sales")
                self.assertEqual(submit.call_count, 1)
            rebalance.advance(self.batch)
            self.assertEqual(self.batch["status"], "completed")
            self.assertEqual(
                [c.args[0] for c in submit.call_args_list], ["SELL", "BUY"]
            )

    def test_wait_for_actual_funds_and_do_not_resubmit_sell(self):
        blocked = deepcopy(self.model)
        blocked["actions"][0]["enabled"] = False
        models = [blocked, self.model]

        def provider():
            return models.pop(0)

        with patch.object(
            rebalance.orders,
            "submit_reviewed_order",
            return_value={
                "status": "submitted",
                "result": {"order": {"state": "filled"}},
            },
        ) as submit:
            rebalance.submit(self.batch, self.model, True, model_provider=provider)
            self.assertEqual(self.batch["status"], "waiting_funds")
            submit.assert_called_once_with("SELL", acknowledged=True)
            rebalance.advance(self.batch, model_provider=provider)
            self.assertEqual(self.batch["status"], "completed")
            self.assertEqual(submit.call_count, 2)

    def test_waiting_quote_expiry_does_not_place_buy(self):
        blocked = deepcopy(self.model)
        blocked["actions"][0]["enabled"] = False
        with patch.object(
            rebalance.orders,
            "submit_reviewed_order",
            return_value={
                "status": "submitted",
                "result": {"order": {"state": "filled"}},
            },
        ) as submit:
            rebalance.submit(
                self.batch, self.model, True, model_provider=lambda: blocked
            )
            self.tickets["BUY"]["reviewed_at"] = (
                datetime.now(timezone.utc) - timedelta(minutes=3)
            ).isoformat()
            rebalance.advance(self.batch, model_provider=lambda: self.model)
            self.assertEqual(self.batch["status"], "stopped")
            submit.assert_called_once()

    def test_late_fill_completes_only_if_all_orders_were_sent(self):
        batch = deepcopy(self.batch)
        batch.update(
            status="stopped",
            results=[
                dict(id="SELL", status="filled"),
                dict(id="BUY", status="pending"),
            ],
        )
        with (
            patch.object(
                rebalance.orders,
                "reconcile_ticket",
                return_value={"result": {"order": {"state": "filled"}}},
            ) as check,
            patch.object(rebalance.orders, "submit_reviewed_order") as submit,
        ):
            self.assertEqual(rebalance.refresh(batch)["status"], "completed")
            check.assert_called_once_with("BUY")
            submit.assert_not_called()
            batch.update(status="stopped", results=[dict(id="SELL", status="filled")])
            self.assertEqual(rebalance.refresh(batch)["status"], "stopped")
            submit.assert_not_called()

    def test_missing_ticket_or_account_change_rejected(self):
        self.tickets["BUY"]["arguments"]["account_number"] = "OTHER"
        with self.assertRaises(ValueError):
            rebalance.validate(self.batch, self.model)
        del self.tickets["BUY"]
        with self.assertRaises(ValueError):
            rebalance.validate(self.batch, self.model)

    def test_popup_continues_delayed_sell_to_buy_without_clicking_again(self):
        from streamlit.testing.v1 import AppTest

        from brokers.robinhood import ui as ui

        pending = {"status": "submitted", "result": {"order": {"state": "queued"}}}
        filled = {"status": "submitted", "result": {"order": {"state": "filled"}}}
        from shared import dialogs as rebalance_complete_ui

        with (
            patch.object(rebalance_complete_ui, "_CLOSE") as close,
            patch.object(ui.dialogs, "_POLL") as poll,
            patch.object(ui, "fresh_decisions", return_value=(self.model, {})),
            patch.object(
                rebalance.orders, "submit_reviewed_order", side_effect=[pending, filled]
            ) as submit,
            patch.object(
                rebalance.orders,
                "reconcile_ticket",
                side_effect=[pending, pending, filled],
            ),
        ):
            app = AppTest.from_string(
                "import streamlit as st\nfrom brokers.robinhood import ui as ui\nui.rebalance_dialog(st.session_state['live_rebalance'])"
            )
            app.session_state["live_rebalance"] = self.batch
            app.session_state["live_account_number"] = "ACCOUNT"
            app.run()
            next(b for b in app.button if b.label == "Confirm rebalance").click().run()
            self.assertFalse(app.exception)
            self.assertEqual(submit.call_count, 1)
            self.assertFalse(any(b.label == "Confirm rebalance" for b in app.button))
            self.assertTrue(any("Progress" in d.value.columns for d in app.dataframe))
            table = app.dataframe[0].value
            self.assertEqual(set(table["Action"]), {"SELL", "BUY"})
            self.assertEqual(len(table), 2)
            self.assertTrue(poll.called)
            close.assert_not_called()
            app.run()
            self.assertEqual(submit.call_count, 1)
            app.run()
            self.assertFalse(app.exception)
            self.assertEqual(submit.call_count, 2)
            self.assertEqual(self.batch["status"], "completed")
            close.assert_called_once()
            self.assertTrue(
                any(
                    "Rebalance completed: 1 buy orders and 1 sell orders filled."
                    in s.value
                    for s in app.success
                )
            )
            self.assertTrue(
                all((d.value["Progress"] == "Filled").all() for d in app.dataframe)
            )
            app.run()
            self.assertFalse(app.exception)
            self.assertTrue(app.success)
            self.assertEqual(submit.call_count, 2)
            self.assertEqual(close.call_count, 2)

    def test_review_popup_shows_both_sides_in_one_table_before_submit(self):
        from streamlit.testing.v1 import AppTest

        from brokers.robinhood import ui as ui

        with (
            patch.object(ui.dialogs, "_POLL") as poll,
            patch.object(ui.orders, "submit_reviewed_order") as submit,
        ):
            app = AppTest.from_string(
                "import streamlit as st\nfrom brokers.robinhood import ui as ui\nui.rebalance_dialog(st.session_state['live_rebalance'])"
            )
            app.session_state["live_rebalance"] = self.batch
            app.session_state["live_account_number"] = "ACCOUNT"
            app.run()
            self.assertFalse(app.exception)
            self.assertEqual(len(app.dataframe), 1)
            table = app.dataframe[0].value
            self.assertEqual(set(table["Action"]), {"SELL", "BUY"})
            self.assertEqual(set(table["Progress"]), {"Awaiting confirmation"})
            buy = table.loc[table["Action"] == "BUY"].iloc[0]
            sell = table.loc[table["Action"] == "SELL"].iloc[0]
            self.assertEqual(buy["Buy amount (USD)"], 100)
            self.assertEqual(sell["Sell shares"], 2)
            submit.assert_not_called()
            poll.assert_not_called()

    def test_confirmation_popup_submits_only_after_click(self):
        from streamlit.testing.v1 import AppTest

        from brokers.robinhood import ui as ui

        with (
            patch.object(ui.dialogs, "_CLOSE"),
            patch.object(ui, "fresh_decisions", return_value=(self.model, {})),
            patch.object(
                rebalance.orders,
                "submit_reviewed_order",
                return_value={
                    "status": "submitted",
                    "result": {"order": {"state": "filled"}},
                },
            ) as submit,
        ):
            app = AppTest.from_string("""
import streamlit as st
from brokers.robinhood import ui as ui
ui.rebalance_dialog(st.session_state['live_rebalance'])
""")
            app.session_state["live_rebalance"] = self.batch
            app.session_state["live_account_number"] = "ACCOUNT"
            app.run()
            self.assertFalse(app.exception)
            submit.assert_not_called()
            next(b for b in app.button if b.label == "Confirm rebalance").click().run()
            self.assertFalse(app.exception)
            self.assertEqual(submit.call_count, 2)

    def test_filled_sell_keeps_pending_buy_in_popup_until_both_fill(self):
        from streamlit.testing.v1 import AppTest

        from brokers.robinhood import ui as ui

        pending = {"status": "submitted", "result": {"order": {"state": "queued"}}}
        filled = {"status": "submitted", "result": {"order": {"state": "filled"}}}
        with (
            patch.object(ui.dialogs, "_POLL") as poll,
            patch.object(ui.dialogs, "_CLOSE") as close,
            patch.object(
                ui.st, "rerun", side_effect=AssertionError("Must stay on the page")
            ),
            patch.object(ui, "fresh_decisions", return_value=(self.model, {})),
            patch.object(
                ui.orders, "submit_reviewed_order", side_effect=[pending, pending]
            ) as submit,
            patch.object(
                ui.orders, "reconcile_ticket", side_effect=[filled, pending, filled]
            ),
        ):
            app = AppTest.from_string(
                "import streamlit as st\nfrom brokers.robinhood import ui as ui\nui.rebalance_dialog(st.session_state['live_rebalance'])"
            )
            app.session_state["live_rebalance"] = self.batch
            app.session_state["live_account_number"] = "ACCOUNT"
            app.run()
            next(b for b in app.button if b.label == "Confirm rebalance").click().run()
            self.assertFalse(app.exception)
            table = app.dataframe[0].value.set_index("Action")
            self.assertEqual(table.loc["SELL", "Progress"], "Filled")
            self.assertEqual(table.loc["BUY", "Progress"], "queued")
            self.assertEqual(len(app.dataframe), 1)
            close.assert_not_called()
            self.assertTrue(poll.called)
            app.run()
            self.assertFalse(app.exception)
            close.assert_not_called()
            app.run()
            self.assertFalse(app.exception)
            self.assertTrue((app.dataframe[0].value["Progress"] == "Filled").all())
            close.assert_called_once()
            self.assertEqual(submit.call_count, 2)
            app.run()
            self.assertFalse(any(b.label == "Confirm rebalance" for b in app.button))
            self.assertEqual(submit.call_count, 2)


if __name__ == "__main__":
    unittest.main()
