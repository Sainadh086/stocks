import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import unittest

import pandas as pd

from backtest_orb import evaluate
from trading import agent as paper_agent
from trading import journal as journal
from trading import orb as orb


def fixture(condition="rising", sessions=35):
    schedule = (
        orb.mcal.get_calendar("NYSE")
        .schedule("2026-07-01", "2026-09-30")
        .iloc[:sessions]
    )
    rows = []
    for number, day in enumerate(schedule.itertuples()):
        for i, t in enumerate(
            pd.date_range(
                day.market_open, day.market_close - pd.Timedelta(minutes=5), freq="5min"
            )
        ):
            op = 100 if i < 3 else 102
            close = 100 if i < 3 else 103
            high, low = max(op, close) + 0.2, min(op, close) - 0.2
            if i >= 5:
                if condition == "rising":
                    op, close, high, low = 108, 108, 109, 107
                elif condition == "falling":
                    op, close, high, low = 98, 98, 99, 97
                else:
                    op, close, high, low = 102, 102, 110, 98
            rows.append(
                dict(
                    timestamp=t,
                    open=op,
                    high=high,
                    low=low,
                    close=close,
                    volume=100 if number < 20 else 200 * 1.6 ** (number - 20),
                )
            )
    return pd.DataFrame(rows).set_index("timestamp")


class ORBTests(unittest.TestCase):
    def setUp(self):
        self.bars = {"A": fixture()}
        self.day = str(self.bars["A"].index.tz_convert("America/New_York").date[-78])
        self.open = orb.session(self.day)[0]

    def step(self, state, minutes, bars=None):
        now = self.open + pd.Timedelta(minutes=minutes)
        data = bars or self.bars
        return orb.step(state, {s: f.loc[f.index <= now] for s, f in data.items()}, now)

    def test_breakout_next_open_costs_reserve_and_target(self):
        state = paper_agent.new_account(10000, 10)
        state = self.step(state, 15)
        self.assertFalse(state["fills"])
        state = self.step(state, 20)
        self.assertEqual(len(state["fills"]), 1)
        self.assertGreater(state["simulated_costs"], 0)
        self.assertGreaterEqual(state["cash"], 1000)
        p = state["positions"]["A"]
        self.assertAlmostEqual(
            p["target"] - p["entry_price"], 2 * (p["entry_price"] - p["stop"])
        )
        self.assertIn("completed close", p["entry_reason"])
        state = self.step(state, 30)
        self.assertFalse(state["positions"])
        trade = state["closed_trades"][0]
        self.assertAlmostEqual(
            trade["gross_pnl"] - trade["simulated_costs"], trade["realized_pnl"]
        )
        self.assertGreater(trade["realized_pnl"], 0)
        self.assertEqual(len(self.step(state, 35)["fills"]), 2)

    def test_ambiguous_stop_first_and_drawdown(self):
        state = self.step(
            paper_agent.new_account(10000, 10), 20, {"A": fixture("sideways")}
        )
        state = self.step(state, 30, {"A": fixture("sideways")})
        self.assertLess(state["realized_pnl"], 0)
        self.assertGreater(state["max_drawdown_pct"], 0)
        self.assertIn("Stop", state["closed_trades"][0]["exit_reason"])

    def test_no_chasing_stale_entry_or_future_candles(self):
        state = self.step(paper_agent.new_account(10000, 10), 25)
        self.assertFalse(state["fills"])
        now = self.open + pd.Timedelta(minutes=20, seconds=70)
        self.assertFalse(
            orb.step(paper_agent.new_account(10000, 10), self.bars, now)["fills"]
        )

    def test_calendar_holiday_and_early_close(self):
        self.assertIsNone(orb.session("2026-12-25"))
        self.assertEqual(
            orb.session("2026-11-27")[1].tz_convert("America/New_York").hour, 13
        )

    def test_heldout_separate_accounts_all_conditions(self):
        for condition in ["rising", "falling", "sideways"]:
            report, states = evaluate(
                {"A": fixture(condition), "QQQ": fixture(condition)}
            )
            self.assertFalse(report["live_ready"])
            self.assertLess(
                report["results"]["development_cost_1x"]["end"],
                report["results"]["held_out_cost_1x"]["start"],
            )
            self.assertEqual(states["held_out_cost_1x"]["budget"], 10000)
            self.assertGreater(
                report["results"]["held_out_cost_1x"]["closed_trades"], 0
            )
            self.assertEqual(
                states["held_out_cost_2x"]["cost_model"]["slippage_bps"], 4
            )
            self.assertGreater(
                report["results"]["held_out_cost_2x"]["simulated_costs"], 0
            )

    def test_end_of_day_exit_and_daily_loss_block(self):
        data = fixture()
        # Keep the post-breakout price between stop and target until cutoff.
        mask = (data.index >= self.open + pd.Timedelta(minutes=25)) & (
            data.index < orb.session(self.day)[1]
        )
        data.loc[mask, ["open", "high", "low", "close"]] = [102, 103, 101, 102]
        state = self.step(paper_agent.new_account(10000, 10), 20, {"A": data})
        cutoff = orb.session(self.day)[1] - pd.Timedelta(minutes=5)
        state = orb.step(state, {"A": data.loc[data.index <= cutoff]}, cutoff)
        self.assertFalse(state["positions"])
        self.assertIn("end-of-day", state["closed_trades"][0]["exit_reason"])
        blocked = paper_agent.new_account(10000, 10)
        blocked.update(
            session_day=self.day, day_start_equity=10000, cash=9800, traded_today=[]
        )
        blocked = self.step(blocked, 20)
        self.assertFalse(blocked["fills"])
        self.assertIn("loss limit", blocked["message"])

    def test_prefix_only_replay_does_not_use_future_target(self):
        state = self.step(paper_agent.new_account(10000, 10), 20)
        full = orb.step(state, self.bars, self.open + pd.Timedelta(minutes=21))
        self.assertTrue(full["positions"])
        self.assertEqual(len(full["fills"]), 1)

    def test_legacy_history_remains_explicitly_incomplete(self):
        state = dict(
            budget=1000,
            cash=900,
            positions={"A": dict(quantity=1, cost=100, price=100)},
            fills=[],
            status="Running",
            realized_pnl=0,
        )
        state = journal.upgrade(state)
        self.assertIsNone(state["positions"]["A"]["stop"])
        journal.sell(state, "A", 100, self.open.isoformat(), "Migration exit")
        self.assertTrue(state["closed_trades"][0]["history_incomplete"])


if __name__ == "__main__":
    unittest.main()
