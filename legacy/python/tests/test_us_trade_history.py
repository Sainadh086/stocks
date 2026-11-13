import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import unittest

import pandas as pd

from brokers.robinhood import history as history


def order(identifier, side, quantity, price, time, symbol="AAPL"):
    return dict(
        id=identifier,
        symbol=symbol,
        side=side,
        state="filled",
        quantity=str(quantity),
        cumulative_quantity=str(quantity),
        average_price=str(price),
        last_transaction_at=time,
    )


class HistoryTests(unittest.TestCase):
    def test_round_trip_one_row_actual_prices_times_and_pnl(self):
        orders = [
            order("buy", "buy", 2, 100, "2026-10-06T14:00:00Z"),
            order("sell", "sell", 2, 110, "2026-10-06T15:00:00Z"),
        ]
        frame = history.table(orders)
        self.assertEqual(len(frame), 1)
        row = frame.iloc[0]
        self.assertEqual(row["Profit/loss ($)"], 20)
        self.assertEqual(row["Status"], "Closed")
        self.assertIn("09:00:00 AM CDT", row["Buy time"])
        self.assertIn("10:00:00 AM CDT", row["Sell time"])
        self.assertEqual(history.pnl_style(20), "color: #15803d")
        self.assertEqual(history.pnl_style(-20), "color: #dc2626")
        self.assertEqual(history.pnl_style(float("nan")), "")

    def test_partial_sells_weighted_prices_and_loss(self):
        frame = history.table(
            [
                order("buy", "buy", 4, 100, "2026-10-06T14:00:00Z"),
                order("sell1", "sell", 1, 90, "2026-10-06T15:00:00Z"),
                order("sell2", "sell", 1, 80, "2026-10-06T16:00:00Z"),
            ]
        )
        self.assertEqual(len(frame), 1)
        row = frame.iloc[0]
        self.assertEqual(row["Shares remaining"], 2)
        self.assertEqual(row["Sell price ($)"], 85)
        self.assertEqual(row["Profit/loss ($)"], -30)
        self.assertEqual(row["Status"], "Partially sold")

    def test_multiple_executions_same_buy_order_and_dedup_tickets(self):
        buy = order("buy", "buy", 2, 105, "2026-10-06T14:05:00Z")
        buy["executions"] = [
            dict(quantity="1", price="100", timestamp="2026-10-06T14:00:00Z"),
            dict(quantity="1", price="110", timestamp="2026-10-06T14:05:00Z"),
        ]
        frame = history.table(
            [buy, order("sell", "sell", 2, 120, "2026-10-06T15:00:00Z")],
            [dict(result=dict(order=buy))],
        )
        self.assertEqual(len(frame), 1)
        self.assertEqual(frame.iloc[0]["Buy price ($)"], 105)
        self.assertEqual(frame.iloc[0]["Profit/loss ($)"], 30)

    def test_missing_entry_is_unknown_not_invented_profit(self):
        sell = order("sell", "sell", 2, 110, "2026-10-06T15:00:00Z")
        sell["executions"] = [
            dict(quantity="1", price="100", timestamp="2026-10-06T15:00:00Z"),
            dict(quantity="1", price="120", timestamp="2026-10-06T15:01:00Z"),
        ]
        frame = history.table([sell])
        self.assertEqual(len(frame), 1)
        self.assertTrue(pd.isna(frame.iloc[0]["Profit/loss ($)"]))
        self.assertEqual(frame.iloc[0]["Buy time"], "—")
        self.assertEqual(frame.iloc[0]["Sell price ($)"], 110)

    def test_paper_rows_keep_net_cost_accounting_and_unrealized_labels(self):
        frame = history.paper_table(
            dict(
                closed_trades=[
                    dict(
                        symbol="AAPL",
                        quantity=2,
                        entry_time="2026-10-06T14:00:00Z",
                        exit_time="2026-10-06T15:00:00Z",
                        entry_price=100.1,
                        exit_price=110,
                        realized_pnl=19.5,
                    )
                ],
                positions={
                    "MSFT": dict(
                        quantity=1,
                        cost=100.5,
                        price=95,
                        entry_price=100,
                        entry_time="2026-10-06T14:05:00Z",
                    )
                },
            )
        )
        self.assertEqual(len(frame), 2)
        indexed = frame.set_index("Stock")
        self.assertEqual(indexed.loc["AAPL", "Profit/loss ($)"], 19.5)
        self.assertEqual(indexed.loc["MSFT", "Profit/loss ($)"], -5.5)
        self.assertEqual(indexed.loc["MSFT", "Status"], "Holding · unrealized")

    def test_queued_order_is_not_a_fill(self):
        frame = history.table(
            [
                dict(
                    id="pending",
                    symbol="AAPL",
                    side="buy",
                    state="queued",
                    quantity="10",
                    average_price="100",
                )
            ]
        )
        self.assertEqual(frame.iloc[0]["Status"], "queued")
        self.assertTrue(pd.isna(frame.iloc[0]["Profit/loss ($)"]))


if __name__ == "__main__":
    unittest.main()
