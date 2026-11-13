import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import unittest
from copy import deepcopy
from datetime import timedelta
from unittest.mock import patch

import pandas as pd
from test_paper_orb import fixture

from brokers.robinhood import strategy as strategy


def setup_signal():
    frame = fixture()
    day = str(frame.index.tz_convert("America/New_York").date[-78])
    now = strategy.paper_orb.session(day)[0] + pd.Timedelta(minutes=20)
    bars = {"A": frame.loc[frame.index <= now]}
    picks = strategy.paper_orb.shortlist(bars, day)
    return now.to_pydatetime(), dict(
        strategy=strategy.STRATEGY,
        ranked=pd.DataFrame(picks),
        bars=bars,
        fresh=True,
        asof=now.isoformat(),
        message="Current intraday signals",
    )


def snapshot(now):
    return dict(
        account_number="TEST",
        updated_at=now.isoformat(),
        portfolio=dict(
            total_value="10000",
            equity_value="0",
            cash="10000",
            currency="USD",
            buying_power=dict(buying_power="20000", unleveraged_buying_power="10000"),
        ),
        positions=[],
        orders=[],
        quotes={
            "A": dict(
                last_trade_price="102",
                venue_last_trade_time=now.isoformat(),
                state="active",
                has_traded=True,
            )
        },
    )


class StrategyTests(unittest.TestCase):
    def setUp(self):
        self.now, self.signals = setup_signal()
        self.account = snapshot(self.now)
        patcher = patch.object(
            strategy, "day_start_equity", return_value=strategy.Decimal("10000")
        )
        patcher.start()
        self.addCleanup(patcher.stop)

    def model(self, **kw):
        return strategy.build_actions(
            self.account, self.signals, 10000, 10, now=self.now, **kw
        )

    def test_reused_decisions_only_compute_projected_buys_and_preserve_inputs(self):
        current = {
            "actions": [
                dict(symbol="OLD", side="sell", enabled=True, quantity="2", price="100")
            ]
        }
        original = deepcopy(current)
        original_account = deepcopy(self.account)
        projected = {
            "actions": [dict(symbol="A", side="buy", enabled=True, dollar_amount="100")]
        }
        with patch.object(strategy, "build_actions", return_value=projected) as build:
            plan = strategy.rebalance_plan(
                self.account, self.signals, 10000, 10, now=self.now, current=current
            )
        build.assert_called_once()
        self.assertEqual(current, original)
        self.assertEqual(self.account, original_account)
        self.assertTrue(plan["actions"][-1]["after_sell_fills"])

    def test_reused_decisions_without_sells_skip_recalculation(self):
        current = {"actions": [dict(symbol="A", side="buy", enabled=True)]}
        with patch.object(strategy, "build_actions") as build:
            plan = strategy.rebalance_plan(
                self.account, self.signals, 10000, 10, current=current
            )
        self.assertEqual(plan, current)
        self.assertIsNot(plan, current)
        build.assert_not_called()

    def test_breakout_uses_risk_size_not_long_term_equal_weight(self):
        action = self.model()["actions"][0]
        self.assertEqual(action["action"], "BUY")
        self.assertLess(float(action["dollar_amount"]), 2250)
        quantity = float(action["dollar_amount"]) / 102
        self.assertLessEqual(quantity * (102 - float(action["stop"])), 25)
        self.assertAlmostEqual(
            float(action["target"]) - 102, 2 * (102 - float(action["stop"]))
        )

    def test_long_term_scan_cannot_enable_trades(self):
        self.signals.pop("strategy")
        self.assertFalse(self.model()["shortlist"])
        self.assertFalse(any(a["enabled"] for a in self.model()["actions"]))

    def test_daily_loss_blocks_entries_but_keeps_exits(self):
        self.account["portfolio"]["total_value"] = "9899"
        self.assertFalse(self.model()["actions"][0]["enabled"])
        self.account["positions"] = [
            dict(symbol="A", quantity="2", shares_available_for_sells="2")
        ]
        self.assertEqual(self.model()["actions"][0]["action"], "EXIT")

    def test_one_entry_per_day_and_pending_prevent_duplicate(self):
        self.account["orders"] = [
            dict(
                symbol="A", side="buy", state="filled", created_at=self.now.isoformat()
            )
        ]
        self.assertFalse(self.model()["actions"][0]["enabled"])
        self.account["orders"] = [dict(symbol="A", state="queued")]
        self.assertFalse(self.model()["actions"][0]["enabled"])

    def test_no_chasing_late_breakout_and_stale_data(self):
        self.now += timedelta(minutes=2)
        self.account = snapshot(self.now)
        self.assertFalse(self.model()["actions"][0]["enabled"])
        self.now -= timedelta(minutes=2)
        self.account = snapshot(self.now)
        self.signals["fresh"] = False
        self.assertFalse(self.model()["actions"][0]["enabled"])

    def test_stop_target_and_session_close_exit_held_stock(self):
        self.account["positions"] = [
            dict(
                symbol="A",
                quantity="2",
                average_buy_price="102",
                shares_available_for_sells="1",
            )
        ]
        ticket = dict(
            id="t",
            strategy=strategy.STRATEGY,
            status="submitted",
            reviewed_at=self.now.isoformat(),
            stop="99",
            target="108",
            arguments=dict(symbol="A", side="buy"),
            result={"order": {"id": "b"}},
        )
        self.account["orders"] = [dict(id="b", state="filled")]
        self.assertEqual(self.model(tickets=[ticket])["actions"][0]["action"], "HOLD")
        for price, reason in [("98", "stop"), ("109", "target")]:
            self.account["quotes"]["A"]["last_trade_price"] = price
            action = self.model(tickets=[ticket])["actions"][0]
            self.assertEqual(action["action"], "EXIT")
            self.assertIn(reason, action["reason"])
            self.assertEqual(action["quantity"], "1")
        self.now = (
            strategy.paper_orb.session(str(pd.Timestamp(self.now).date()))[1]
            - pd.Timedelta(minutes=5)
        ).to_pydatetime()
        self.account["updated_at"] = self.now.isoformat()
        self.account["quotes"]["A"].update(
            last_trade_price="102", venue_last_trade_time=self.now.isoformat()
        )
        self.assertIn("Scheduled", self.model(tickets=[ticket])["actions"][0]["reason"])

    def test_four_position_cap_and_no_margin(self):
        self.account["orders"] = [
            dict(symbol=s, state="queued") for s in ["B", "C", "D", "E"]
        ]
        self.assertFalse(self.model()["actions"][0]["enabled"])
        self.account["orders"] = []
        self.account["portfolio"]["cash"] = "20"
        self.assertLessEqual(float(self.model()["actions"][0]["dollar_amount"]), 20)

    def test_unknown_holdings_in_agentic_account_exit_without_long_term_scan(self):
        self.signals["fresh"] = False
        self.account["positions"] = [
            dict(symbol="A", quantity="2", shares_available_for_sells="2")
        ]
        self.assertEqual(self.model()["actions"][0]["action"], "EXIT")

    def test_performance_uses_broker_purchase_cost(self):
        self.assertEqual(
            strategy.holding_performance(
                dict(quantity="2", average_buy_price="80"), dict(last_trade_price="100")
            )["pnl"],
            40,
        )
        self.assertIsNone(
            strategy.holding_performance(
                dict(quantity="2"), dict(last_trade_price="100")
            )
        )

    def test_recommendations_use_regular_account_file(self):
        from brokers.robinhood import analysis

        with patch.object(
            analysis.accounts,
            "load_roles",
            return_value={"long_term": None, "trading": None},
        ):
            self.assertEqual(analysis.holdings_source(), analysis.HOLDINGS_CSV)


if __name__ == "__main__":
    unittest.main()
