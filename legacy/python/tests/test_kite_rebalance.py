import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from unittest.mock import patch

import pandas as pd

from brokers.kite import rebalance as rb


class Broker:
    def __init__(self):
        self.user = "USER"
        self.funds = 50
        self.placed = []
        self.pending = False
        self.fail = False
        self.held = [
            dict(exchange="NSE", tradingsymbol="OLD", quantity=10, used_quantity=0)
        ]

    def profile(self):
        return {"user_id": self.user}

    def holdings(self):
        return self.held

    def orders(self):
        return []

    def margins(self, segment):
        return {"net": self.funds}

    def ltp(self, keys):
        return {k: {"last_price": 100} for k in keys}

    def order_margins(self, orders):
        return [{"total": 100 * o["quantity"], "charges": {"total": 1}} for o in orders]

    def place_order(self, **args):
        self.placed.append(args)
        if self.fail:
            raise TimeoutError("Response lost")
        if not self.pending:
            self.funds += (
                (1 if args["transaction_type"] == "SELL" else -1)
                * 100
                * args["quantity"]
            )
        return str(len(self.placed))

    def order_history(self, order_id):
        return [{"status": "OPEN" if self.pending else "COMPLETE"}]


class KiteRebalanceTests(unittest.TestCase):
    def test_missing_rebalance_has_a_clear_status_error(self):
        with patch.object(rb, "get", return_value=None):
            with self.assertRaisesRegex(ValueError, "record is missing"):
                rb.refresh_status(self.broker, "missing")

    def test_status_reconciliation_does_not_match_missing_order_ids(self):
        batch = dict(
            id="test",
            user="USER",
            status="unknown",
            orders=[{}],
            results=[dict(tag="expected", status="unknown")],
        )
        broker_orders = [dict(tag="different", status="COMPLETE")]
        with (
            patch.object(rb, "get", return_value=batch),
            patch.object(rb, "save"),
            patch.object(self.broker, "orders", return_value=broker_orders),
        ):
            result = rb.refresh_status(self.broker, "test")
        self.assertEqual(result["status"], "unknown")
        self.assertEqual(result["results"][0]["status"], "unknown")

    def test_pending_popup_updates_one_table_then_closes_on_completion(self):
        from streamlit.testing.v1 import AppTest

        from brokers.kite import ui

        batch = dict(
            id="test",
            user="USER",
            status="stopped",
            orders=[{}],
            results=[dict(tag="expected", status="pending")],
        )
        filled = dict(
            batch, status="completed", results=[dict(tag="expected", status="filled")]
        )
        with (
            patch.object(
                ui.rebalance, "refresh_status", side_effect=[dict(batch), filled]
            ),
            patch.object(ui.dialogs, "_POLL") as poll,
            patch.object(ui.dialogs, "finish") as finish,
            patch.object(ui, "test_client", create=True, return_value=self.broker),
        ):
            app = AppTest.from_string("""
import streamlit as st
from brokers.kite import ui
ui.show_result(st.session_state['batch'], ui.test_client)
""")
            app.session_state["batch"] = batch
            app.run()
            self.assertFalse(app.exception)
            self.assertEqual(len(app.dataframe), 1)
            self.assertEqual(app.dataframe[0].value["status"].tolist(), ["pending"])
            poll.assert_called_once()
            finish.assert_not_called()
            app.run()
            self.assertFalse(app.exception)
            self.assertEqual(batch["status"], "completed")
            finish.assert_called_once_with("test")

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        patches = [
            patch.object(rb, "JOURNAL", Path(self.tmp.name) / "journal.json"),
            patch.object(rb.yf, "Ticker"),
            patch.object(
                rb.secure_storage,
                "read_text",
                side_effect=lambda p: Path(p).read_text(),
            ),
            patch.object(
                rb.secure_storage,
                "write_text",
                side_effect=lambda p, s: Path(p).write_text(s),
            ),
        ]
        for p in patches:
            p.start()
            self.addCleanup(p.stop)
        rb.yf.Ticker.return_value.history.return_value = pd.DataFrame(
            {"Close": [100.0]},
            index=pd.DatetimeIndex([datetime.now(timezone.utc) - timedelta(minutes=1)]),
        )
        self.broker = Broker()
        self.view = pd.DataFrame(
            [
                dict(symbol="OLD", exchange="NSE", status="Exit", target_shares=0),
                dict(symbol="NEW", exchange="NSE", status="New", target_shares=5),
            ]
        )
        self.rows = rb.editor_rows(self.view, rb.account_state(self.broker))

    def test_edited_quantity_and_confirmed_sells_before_new_buys(self):
        self.rows.loc[self.rows.symbol == "OLD", "sell_shares"] = 4
        self.rows.loc[self.rows.symbol == "NEW", "buy_shares"] = 3
        batch = rb.review(self.broker, self.rows, self.rows)
        self.assertFalse(self.broker.placed)
        with self.assertRaises(ValueError):
            rb.submit(self.broker, batch["id"])
        result = rb.submit(self.broker, batch["id"], acknowledged=True)
        self.assertEqual(result["status"], "completed")
        self.assertEqual(
            [(o["transaction_type"], o["quantity"]) for o in self.broker.placed],
            [("SELL", 4), ("BUY", 3)],
        )
        self.assertTrue(
            all(
                o["product"] == "CNC" and o["variety"] == "regular"
                for o in self.broker.placed
            )
        )
        with self.assertRaises(ValueError):
            rb.submit(self.broker, batch["id"], acknowledged=True)
        self.assertEqual(len(self.broker.placed), 2)

    def test_yahoo_prices_allow_review_without_kite_market_data(self):
        from kiteconnect.exceptions import PermissionException

        with patch.object(
            self.broker,
            "ltp",
            side_effect=PermissionException("Insufficient permission for that call."),
        ):
            batch = rb.review(self.broker, self.rows, self.rows)
        self.assertEqual(batch["price_source"], "Yahoo Finance")
        self.assertEqual(batch["estimated_sells"], 1000)
        self.assertFalse(self.broker.placed)

    def test_yahoo_exchange_mapping_and_unadjusted_intraday_prices(self):
        quotes = rb.live_quotes(["NSE:INFY", "BSE:INFY", "NSE:INFY"])
        self.assertEqual(
            [c.args[0] for c in rb.yf.Ticker.call_args_list], ["INFY.NS", "INFY.BO"]
        )
        self.assertEqual(quotes["BSE:INFY"]["last_price"], 100)
        rb.yf.Ticker.return_value.history.assert_called_with(
            period="5d", interval="1m", auto_adjust=False, actions=False, timeout=10
        )

    def test_missing_invalid_and_outdated_yahoo_prices_block_review(self):
        for price in [0, -1, float("nan"), float("inf")]:
            rb.yf.Ticker.return_value.history.return_value = pd.DataFrame(
                {"Close": [price]},
                index=pd.DatetimeIndex(
                    [datetime.now(timezone.utc) - timedelta(minutes=1)]
                ),
            )
            with self.assertRaisesRegex(ValueError, "Yahoo Finance price unavailable"):
                rb.review(self.broker, self.rows, self.rows)
        for data in [
            pd.DataFrame(),
            pd.DataFrame(
                {"Close": [100]},
                index=pd.DatetimeIndex(
                    [datetime.now(timezone.utc) - timedelta(days=8)]
                ),
            ),
        ]:
            rb.yf.Ticker.return_value.history.return_value = data
            with self.assertRaisesRegex(ValueError, "Yahoo Finance price unavailable"):
                rb.review(self.broker, self.rows, self.rows)
        self.assertFalse(self.broker.placed)
        self.assertFalse(rb.JOURNAL.exists())

    def test_holdings_permission_denial_identifies_call(self):
        from kiteconnect.exceptions import PermissionException

        with patch.object(
            self.broker,
            "holdings",
            side_effect=PermissionException("Insufficient permission for that call."),
        ):
            with self.assertRaisesRegex(ValueError, "Kite denied access to holdings"):
                rb.account_state(self.broker)

    def test_basket_summary_uses_edited_quantities_and_review_prices(self):
        edited = pd.DataFrame(
            [
                dict(
                    symbol="ADD",
                    exchange="NSE",
                    current_shares=0,
                    sell_shares=0,
                    buy_shares=3,
                ),
                dict(
                    symbol="REMOVE",
                    exchange="NSE",
                    current_shares=5,
                    sell_shares=5,
                    buy_shares=0,
                ),
                dict(
                    symbol="REDUCE",
                    exchange="NSE",
                    current_shares=5,
                    sell_shares=2,
                    buy_shares=0,
                ),
                dict(
                    symbol="INCREASE",
                    exchange="NSE",
                    current_shares=5,
                    sell_shares=0,
                    buy_shares=2,
                ),
                dict(
                    symbol="KEEP",
                    exchange="NSE",
                    current_shares=5,
                    sell_shares=0,
                    buy_shares=0,
                ),
            ]
        )
        quotes = {f"NSE:{s}": {"last_price": 100} for s in edited.symbol}
        changes = rb.basket_changes(edited, quotes)
        self.assertEqual(
            changes.change.tolist(), ["Add", "Remove", "Reduce", "Increase", "Keep"]
        )
        self.assertEqual(changes.target_shares.tolist(), [3, 0, 3, 7, 5])
        self.assertAlmostEqual(changes.target_weight_pct.sum(), 100)
        self.assertEqual(changes.estimated_value_inr.sum(), 1800)

    def test_fractional_negative_nan_and_conflicting_quantities_rejected(self):
        for value in [-1, 1.5, float("nan")]:
            edited = self.rows.astype({"sell_shares": object})
            edited.loc[0, "sell_shares"] = value
            with self.assertRaises(ValueError):
                rb.orders_from_editor(edited, self.rows)
        edited = self.rows.copy()
        edited.loc[0, "buy_shares"] = 1
        with self.assertRaises(ValueError):
            rb.orders_from_editor(edited, self.rows)

    def test_unapproved_stock_or_changed_list_rejected(self):
        edited = self.rows.copy()
        edited.loc[0, "symbol"] = "INJECTED"
        with self.assertRaises(ValueError):
            rb.orders_from_editor(edited, self.rows)
        with self.assertRaises(ValueError):
            rb.orders_from_editor(self.rows.iloc[:1], self.rows)

    def test_oversell_pending_orders_and_insufficient_funds_rejected(self):
        edited = self.rows.copy()
        edited.loc[0, "sell_shares"] = 11
        with self.assertRaises(ValueError):
            rb.review(self.broker, edited, self.rows)
        edited = self.rows.copy()
        edited.loc[1, "buy_shares"] = 100
        with self.assertRaises(ValueError):
            rb.review(self.broker, edited, self.rows)
        with patch.object(
            self.broker,
            "orders",
            return_value=[dict(exchange="NSE", tradingsymbol="OLD", status="OPEN")],
        ):
            with self.assertRaises(ValueError):
                rb.review(self.broker, self.rows, self.rows)
        self.assertFalse(self.broker.placed)

    def test_pending_sell_never_funds_buy_and_unknown_is_not_retried(self):
        batch = rb.review(self.broker, self.rows, self.rows)
        self.broker.pending = True
        with patch.object(rb.time, "sleep"):
            result = rb.submit(self.broker, batch["id"], True)
        self.assertEqual(result["status"], "stopped")
        self.assertEqual(len(self.broker.placed), 1)
        self.assertEqual(result["results"][0]["status"], "pending")
        self.broker.pending = False
        self.broker.fail = True
        batch = rb.review(self.broker, self.rows, self.rows)
        result = rb.submit(self.broker, batch["id"], True)
        self.assertEqual(result["status"], "unknown")
        with self.assertRaises(ValueError):
            rb.submit(self.broker, batch["id"], True)
        another = rb.review(self.broker, self.rows, self.rows)
        with self.assertRaises(ValueError):
            rb.submit(self.broker, another["id"], True)
        self.assertEqual(len(self.broker.placed), 2)

    def test_expiry_account_change_and_fresh_holdings_rechecked(self):
        batch = rb.review(self.broker, self.rows, self.rows)
        self.broker.user = "OTHER"
        with self.assertRaises(ValueError):
            rb.submit(self.broker, batch["id"], True)
        self.broker.user = "USER"
        self.broker.held[0]["quantity"] = 2
        with self.assertRaises(ValueError):
            rb.submit(self.broker, batch["id"], True)
        self.broker.held[0]["quantity"] = 10
        batch["reviewed_at"] = (
            datetime.now(timezone.utc) - timedelta(minutes=3)
        ).isoformat()
        rb.save(batch)
        with self.assertRaises(ValueError):
            rb.submit(self.broker, batch["id"], True)
        self.assertFalse(self.broker.placed)

    def test_broker_authorisation_rejection_is_recorded_without_retry(self):
        from kiteconnect.exceptions import InputException

        batch = rb.review(self.broker, self.rows, self.rows)
        with patch.object(
            self.broker,
            "place_order",
            side_effect=InputException("Authorise holdings in Kite"),
        ) as place:
            result = rb.submit(self.broker, batch["id"], True)
            self.assertEqual(result["status"], "stopped")
            self.assertEqual(result["results"][0]["status"], "rejected")
            place.assert_called_once()

    def test_actual_funds_checked_after_sell_fills(self):
        batch = rb.review(self.broker, self.rows, self.rows)

        # A completed sale does not justify assuming its proceeds are available.
        def place(**args):
            self.broker.placed.append(args)
            return "1"

        with patch.object(self.broker, "place_order", side_effect=place):
            result = rb.submit(self.broker, batch["id"], True)
        self.assertEqual(result["status"], "stopped")
        self.assertEqual(len(self.broker.placed), 1)
        self.assertEqual(self.broker.placed[0]["transaction_type"], "SELL")
        self.assertIn("funds", result["error"])

    def test_editable_popup_requires_confirmation_before_orders(self):
        from uuid import uuid4

        from streamlit.testing.v1 import AppTest

        from brokers.kite import ui as ui

        draft = dict(
            id=uuid4().hex,
            user="USER",
            rows=self.rows.assign(price_inr=100.0),
            opened_at=datetime.now(timezone.utc),
            batch_id=None,
        )
        with (
            patch.object(ui.dialogs, "finish") as finish,
            patch.object(ui, "test_client", create=True, return_value=self.broker),
        ):
            app = AppTest.from_string(
                "import streamlit as st\nfrom brokers.kite import ui as ui\nui.rebalance_dialog(st.session_state['draft'],ui.test_client)",
                default_timeout=10,
            )
            app.session_state["draft"] = draft
            app.run()
            self.assertFalse(app.exception)
            self.assertFalse(self.broker.placed)
            self.assertEqual(len(app.dataframe), 1)
            self.assertIn("buy_shares", app.dataframe[0].value.columns)
            self.assertIn("sell_shares", app.dataframe[0].value.columns)
            self.assertFalse(
                any(b.label == "Confirm and rebalance in Kite" for b in app.button)
            )
            next(b for b in app.button if b.label == "Review rebalance").click().run()
            self.assertFalse(app.exception)
            self.assertFalse(self.broker.placed)
            self.assertEqual(len(app.dataframe), 2)
            next(
                b for b in app.button if b.label == "Confirm and rebalance in Kite"
            ).click().run()
            self.assertFalse(app.exception)
            self.assertEqual(len(self.broker.placed), 2)
            finish.assert_called_once()
            app.run()
            self.assertFalse(
                any(b.label == "Confirm and rebalance in Kite" for b in app.button)
            )
            self.assertEqual(len(self.broker.placed), 2)


if __name__ == "__main__":
    unittest.main()
