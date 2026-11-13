import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import asyncio
import tempfile
import unittest
from copy import deepcopy
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

from brokers.robinhood import accounts
from brokers.robinhood import orders as orders

ACCOUNT = "TEST12345678"


def args():
    return orders.order_arguments(ACCOUNT, "AAPL", "buy", "limit", "Shares", "2", "100")


class FakeBroker:
    def __init__(self):
        self.calls = []
        self.allowed = True
        self.failed = False
        self.positions = [dict(symbol="AAPL", quantity="3")]
        self.history = []

    async def call(self, name, arguments):
        self.calls.append((name, deepcopy(arguments)))
        if name == "get_accounts":
            return {
                "data": {
                    "accounts": [
                        dict(
                            account_number=ACCOUNT,
                            agentic_allowed=self.allowed,
                            state="active",
                            deactivated=False,
                            permanently_deactivated=False,
                        )
                    ]
                }
            }
        if name == "review_equity_order":
            return {
                "data": {
                    "symbol": arguments["symbol"],
                    "side": arguments["side"],
                    "type": arguments["type"],
                    "order_checks": {},
                    "quote_data": {"last_trade_price": "100", "ask_price": "101"},
                    "market_data_disclosure": "Bid $100 · Ask $101. Updated 10:00 AM ET.",
                }
            }
        if name == "place_equity_order":
            if self.failed:
                raise TimeoutError("Response interrupted")
            order = dict(
                id="broker-order-id",
                ref_id=arguments["ref_id"],
                state="filled"
                if getattr(self, "fill_immediately", False)
                else "queued",
                symbol=arguments["symbol"],
                side=arguments["side"],
            )
            self.history.append(order)
            return {"data": {"order": order}}
        if name == "get_portfolio":
            equity = sum(float(p["quantity"]) * 100 for p in self.positions)
            return {
                "data": {
                    "total_value": str(1000 + equity),
                    "equity_value": str(equity),
                    "cash": "1000",
                    "currency": "USD",
                    "buying_power": {
                        "buying_power": "1000",
                        "unleveraged_buying_power": "1000",
                        "display_currency": "USD",
                    },
                }
            }
        if name == "get_equity_quotes":
            return {
                "data": {
                    "results": [
                        {
                            "quote": {
                                "symbol": symbol,
                                "state": "active",
                                "has_traded": True,
                                "last_trade_price": "100",
                                "venue_last_trade_time": datetime.now(
                                    timezone.utc
                                ).isoformat(),
                            }
                        }
                        for symbol in arguments["symbols"]
                    ]
                }
            }
        if name == "get_equity_orders":
            return {"data": {"orders": self.history}}
        raise AssertionError(name)

    async def rows(self, name, account, key):
        self.calls.append((name, {"account_number": account}))
        return deepcopy(
            self.positions if name == "get_equity_positions" else self.history
        )


class TicketTests(unittest.TestCase):
    def test_basket_reads_ticket_store_once_and_handles_missing_tickets(self):
        with patch.object(
            orders, "_tickets", return_value={"A": {"id": "A"}, "B": {"id": "B"}}
        ) as read:
            result = orders.get_tickets(["A", "B", "missing"])
        self.assertEqual(set(result), {"A", "B"})
        read.assert_called_once()

    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.broker = FakeBroker()
        patches = [
            patch.object(
                accounts,
                "load_roles",
                return_value={"long_term": "INVEST", "trading": ACCOUNT},
            ),
            patch.object(
                orders, "TICKETS_FILE", Path(self.directory.name) / "tickets.json"
            ),
            patch.object(
                orders.secure_storage,
                "read_text",
                side_effect=lambda p: Path(p).read_text(),
            ),
            patch.object(
                orders.secure_storage,
                "write_text",
                side_effect=lambda p, s: Path(p).write_text(s),
            ),
            patch.object(
                orders, "run", side_effect=lambda op: asyncio.run(op(self.broker))
            ),
        ]
        for p in patches:
            p.start()
            self.addCleanup(p.stop)

    def test_preview_never_places_order(self):
        ticket = orders.preview_order(args())
        self.assertEqual(ticket["status"], "preview")
        self.assertNotIn("place_equity_order", [n for n, _ in self.broker.calls])
        self.assertEqual(ticket, orders.get_ticket(ticket["id"]))

    def test_submit_requires_ack_and_is_once_with_uuid(self):
        ticket = orders.preview_order(args())
        with self.assertRaises(ValueError):
            orders.submit_reviewed_order(ticket["id"])
        self.assertNotIn("place_equity_order", [n for n, _ in self.broker.calls])
        result = orders.submit_reviewed_order(ticket["id"], acknowledged=True)
        self.assertEqual(result["status"], "submitted")
        placed = [a for n, a in self.broker.calls if n == "place_equity_order"]
        self.assertEqual(placed[0], {**args(), "ref_id": ticket["id"]})
        with self.assertRaises(ValueError):
            orders.submit_reviewed_order(ticket["id"], True)
        self.assertEqual(
            len([n for n, _ in self.broker.calls if n == "place_equity_order"]), 1
        )

    def test_expired_preview_does_not_submit(self):
        ticket = orders.preview_order(args())
        ticket["reviewed_at"] = (
            datetime.now(timezone.utc) - timedelta(minutes=3)
        ).isoformat()
        orders.save_ticket(ticket)
        with self.assertRaises(ValueError):
            orders.submit_reviewed_order(ticket["id"], True)
        self.assertNotIn("place_equity_order", [n for n, _ in self.broker.calls])

    def test_unknown_not_retried_and_reconciled(self):
        ticket = orders.preview_order(args())
        self.broker.failed = True
        result = orders.submit_reviewed_order(ticket["id"], True)
        self.assertEqual(result["status"], "unknown")
        with self.assertRaises(ValueError):
            orders.submit_reviewed_order(ticket["id"], True)
        other = orders.preview_order(args())
        with self.assertRaises(ValueError):
            orders.submit_reviewed_order(other["id"], True)
        self.broker.history = [dict(ref_id=ticket["id"], id="existing", state="filled")]
        self.assertEqual(orders.reconcile_ticket(ticket["id"])["status"], "submitted")
        self.assertEqual(
            len([n for n, _ in self.broker.calls if n == "place_equity_order"]), 1
        )

    def test_inaccessible_account_cannot_preview(self):
        self.broker.allowed = False
        with self.assertRaises(ValueError):
            orders.preview_order(args())
        self.assertNotIn("review_equity_order", [n for n, _ in self.broker.calls])

    def test_fill_reconciles_by_broker_id_without_reference(self):
        ticket = orders.preview_order(args())
        orders.submit_reviewed_order(ticket["id"], True)
        self.broker.history = [
            dict(id="broker-order-id", state="filled", symbol="AAPL", side="buy")
        ]
        result = orders.reconcile_ticket(ticket["id"])
        self.assertEqual(result["result"]["order"]["state"], "filled")
        self.assertEqual(
            orders.get_ticket(ticket["id"])["result"]["order"]["state"], "filled"
        )
        self.assertEqual(
            len([n for n, _ in self.broker.calls if n == "place_equity_order"]), 1
        )

    def test_short_sales_blocked(self):
        request = orders.order_arguments(
            ACCOUNT, "AAPL", "sell", "market", "Shares", "4"
        )
        with self.assertRaises(ValueError):
            orders.preview_order(request)
        self.assertNotIn("review_equity_order", [n for n, _ in self.broker.calls])

    def test_validation_and_masking(self):
        for amount in ("", "0", "-1", "nan", "inf", "0.0000001"):
            with self.assertRaises(ValueError):
                orders.order_arguments(
                    ACCOUNT, "AAPL", "buy", "market", "Shares", amount
                )
        with self.assertRaises(ValueError):
            orders.order_arguments(
                ACCOUNT, "AAPL", "buy", "limit", "Shares", "1.5", "100"
            )
        with self.assertRaises(ValueError):
            orders.order_arguments(ACCOUNT, "AAPL", "sell", "market", "USD", "100")
        masked = orders.mask(
            {"account_number": ACCOUNT, "nested": f"account {ACCOUNT}"}, ACCOUNT
        )
        self.assertNotIn(ACCOUNT, str(masked))

    def test_changed_strategy_blocks_confirmation_at_server(self):
        import pandas as pd

        from brokers.robinhood import strategy as live_strategy

        self.broker.positions = []
        ticket = orders.preview_order(
            orders.order_arguments(ACCOUNT, "AAPL", "buy", "market", "USD", "225")
        )
        ticket["origin"] = "strategy"
        orders.save_ticket(ticket)
        ranked = pd.DataFrame(
            [
                dict(
                    symbol="AAPL",
                    price=100,
                    sma50=90,
                    sma200=80,
                    rsi=55,
                    action="REPLACE",
                    return_1m_pct=3,
                    return_3m_pct=6,
                    return_6m_pct=12,
                    momentum_score=100,
                )
            ]
        )
        signals = {
            "ranked": ranked,
            "fresh": True,
            "asof": datetime.now(timezone.utc).isoformat(),
            "message": "Current",
        }
        with (
            patch.object(live_strategy, "signal_snapshot", return_value=signals),
            patch.object(live_strategy, "saved_budget", return_value=(1000, 10)),
        ):
            result = orders.submit_reviewed_order(ticket["id"], True)
        self.assertEqual(result["status"], "not_submitted")
        self.assertNotIn("place_equity_order", [name for name, _ in self.broker.calls])

    def test_sell_reserved_shares_are_not_available(self):
        self.broker.positions = [
            dict(symbol="AAPL", quantity="3", shares_available_for_sells="1")
        ]
        request = orders.order_arguments(
            ACCOUNT, "AAPL", "sell", "market", "Shares", "2"
        )
        with self.assertRaises(ValueError):
            orders.preview_order(request)
        self.assertNotIn("review_equity_order", [name for name, _ in self.broker.calls])

    def test_ui_prepared_actions_and_submit_only_when_user_clicks(self):
        from streamlit.testing.v1 import AppTest

        from brokers.robinhood import strategy as live_strategy
        from brokers.robinhood import ui as live_trading_ui

        self.broker.positions = []
        self.broker.fill_immediately = True
        from test_live_strategy import setup_signal

        now, signals = setup_signal()
        self.broker.call_original = self.broker.call

        async def call(name, arguments):
            payload = await self.broker.call_original(name, arguments)
            if name == "get_equity_quotes":
                for row in payload["data"]["results"]:
                    row["quote"].update(
                        last_trade_price="102", venue_last_trade_time=now.isoformat()
                    )
            return payload

        self.broker.call = call
        monitor = SimpleNamespace(
            snapshot=lambda: signals, wake=SimpleNamespace(set=lambda: None)
        )
        with (
            patch.object(
                live_trading_ui.account_roles,
                "load_roles",
                return_value={"long_term": "INVEST", "trading": ACCOUNT},
            ),
            patch.object(live_trading_ui.dialogs, "finish"),
            patch.object(live_trading_ui.alerts, "_COMPONENT"),
            patch.object(live_trading_ui, "signal_monitor", return_value=monitor),
            patch.object(live_strategy, "saved_budget", return_value=(1000, 10)),
            patch.object(
                live_strategy,
                "day_start_equity",
                return_value=live_strategy.Decimal("1000"),
            ),
            patch.object(live_strategy, "datetime") as clock,
            patch.object(live_strategy, "signal_snapshot", return_value=signals),
        ):
            clock.now.return_value = now
            clock.fromisoformat.side_effect = lambda value: (
                now if value != now.isoformat() else datetime.fromisoformat(value)
            )
            app = AppTest.from_string(
                "from brokers.robinhood import ui as live_trading_ui\nlive_trading_ui.render()"
            ).run()
            self.assertFalse(app.exception)
            app.session_state["live_snapshot_pending"][0].result(timeout=2)
            app.run()
            self.assertFalse(app.exception)
            self.assertFalse(app.text_input)
            self.assertNotIn("place_equity_order", [n for n, _ in self.broker.calls])
            self.assertFalse(any(b.label.startswith("Buy ") for b in app.button))
            app.button(key="live_rebalance_button").click().run()
            self.assertFalse(app.exception)
            self.assertNotIn("place_equity_order", [n for n, _ in self.broker.calls])
            batch = app.session_state["live_rebalance"]
            self.assertEqual(len(batch["ticket_ids"]), 1)
            for ticket_id in batch["ticket_ids"]:
                ticket = orders.get_ticket(ticket_id)
                self.assertLess(float(ticket["arguments"]["dollar_amount"]), 225)
                self.assertEqual(ticket["arguments"]["type"], "market")
            # AppTest executes whole scripts; render the open dialog directly to
            # exercise its independent confirmation event without a browser.
            dialog = AppTest.from_string(
                "import streamlit as st\nfrom brokers.robinhood import ui as live_trading_ui\nlive_trading_ui.rebalance_dialog(st.session_state['live_rebalance'])"
            )
            dialog.session_state["live_account_number"] = ACCOUNT
            dialog.session_state["live_rebalance"] = batch
            dialog.run()
            next(
                b for b in dialog.button if b.label == "Confirm rebalance"
            ).click().run()
            self.assertFalse(dialog.exception)
            self.assertEqual(
                len([n for n, _ in self.broker.calls if n == "place_equity_order"]), 1
            )
            dialog.run()
            self.assertFalse(any(b.label == "Confirm rebalance" for b in dialog.button))
            self.assertEqual(
                len([n for n, _ in self.broker.calls if n == "place_equity_order"]), 1
            )


class TransportTests(unittest.TestCase):
    def test_unreadable_success_response_is_unknown_not_rejected(self):
        session = SimpleNamespace(
            call_tool=AsyncMock(
                return_value=SimpleNamespace(
                    structuredContent=None,
                    content=[SimpleNamespace(type="text", text="unexpected")],
                    isError=False,
                )
            )
        )
        transport = orders.BrokerSession(
            session,
            {"place_equity_order": SimpleNamespace(inputSchema={"type": "object"})},
        )
        with self.assertRaises(RuntimeError) as error:
            asyncio.run(transport.call("place_equity_order", {}))
        self.assertNotIsInstance(error.exception, orders.BrokerError)


if __name__ == "__main__":
    unittest.main()


class RefreshRegressionTests(unittest.TestCase):
    def test_real_quote_response_ticker_is_nested(self):
        broker = FakeBroker()
        result = asyncio.run(orders.read_snapshot(broker, ACCOUNT, ["AAPL", "MSFT"]))
        self.assertEqual(set(result["quotes"]), {"AAPL", "MSFT"})
        self.assertEqual(result["quotes"]["AAPL"]["symbol"], "AAPL")
        self.assertEqual(result["quotes"]["MSFT"]["last_trade_price"], "100")

    def test_grouped_error_reveals_original_exception(self):
        async def failed(operation):
            raise ExceptionGroup(
                "unhandled errors in a TaskGroup",
                [ExceptionGroup("nested", [ValueError("Quote lookup failed")])],
            )

        with patch.object(orders, "_connected", side_effect=failed):
            with self.assertRaisesRegex(ValueError, "Quote lookup failed"):
                orders.run(None)

    def test_grouped_broker_rejection_preserves_error_class(self):
        async def failed(operation):
            raise ExceptionGroup(
                "unhandled errors in a TaskGroup", [orders.BrokerError("Rejected")]
            )

        with patch.object(orders, "_connected", side_effect=failed):
            with self.assertRaises(orders.BrokerError):
                orders.run(None)

    def test_multiple_errors_show_each_cause(self):
        async def failed(operation):
            raise ExceptionGroup(
                "unhandled errors in a TaskGroup",
                [ValueError("bad quote"), OSError("disconnected")],
            )

        with patch.object(orders, "_connected", side_effect=failed):
            with self.assertRaisesRegex(RuntimeError, "bad quote.*disconnected"):
                orders.run(None)
