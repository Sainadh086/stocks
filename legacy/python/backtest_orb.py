"""Replay frozen ORB rules; independent development/held-out accounts and cost stress.
CSV columns: timestamp,symbol,open,high,low,close,volume (timestamps include UTC offsets).
No live brokerage calls. python backtest_orb.py --data intraday.csv --output backtests/orb
"""

import argparse
import hashlib
import json
from pathlib import Path

import pandas as pd

from trading import agent as paper_agent
from trading import journal as journal
from trading import orb as orb


def replay(bars, days, cost_multiplier=1):
    state = paper_agent.new_account(10000, 10)
    state["cost_model"] = {
        k: v * cost_multiplier for k, v in state["cost_model"].items()
    }
    incomplete = []
    for day in days:
        opened, closed = orb.session(day)
        for now in pd.date_range(opened, closed - pd.Timedelta(minutes=5), freq="5min"):
            # Restrict all visible data to the current timestamp. No future bars exposed.
            visible = {s: f.loc[f.index <= now] for s, f in bars.items() if s != "QQQ"}
            state = orb.step(state, visible, now)
        if state["positions"]:
            incomplete.append(day)
    return state, incomplete


def evaluate(bars):
    dates = sorted(
        set(
            str(d)
            for f in bars.values()
            for d in f.index.tz_convert("America/New_York").date
        )
    )
    dates = [d for d in dates if orb.session(d)]
    coverage = bars.get("QQQ", next(iter(bars.values())))
    incomplete_dates = [
        d
        for d in dates
        if coverage.loc[
            (coverage.index >= orb.session(d)[0]) & (coverage.index < orb.session(d)[1])
        ].empty
        or coverage.loc[
            (coverage.index >= orb.session(d)[0]) & (coverage.index < orb.session(d)[1])
        ].index[-1]
        < orb.session(d)[1] - pd.Timedelta(minutes=5)
    ]
    dates = [d for d in dates if d not in incomplete_dates]
    # Initial sessions exclusively establish prior opening-volume baselines.
    dates = dates[orb.RULES["baseline_days"] :]
    if len(dates) < 10:
        raise ValueError(
            "Need at least 30 market sessions: 20 warmup and 10 evaluation sessions."
        )
    split = int(len(dates) * 0.7)
    report = dict(
        strategy=orb.STRATEGY,
        rules=orb.RULES,
        costs=journal.DEFAULT_COSTS,
        universe=sorted(s for s in bars if s != "QQQ"),
        excluded_incomplete_sessions=incomplete_dates,
        live_ready=False,
        limitations=[
            "Current-universe survivorship bias unless input uses a historical universe.",
            "Five-minute OHLC cannot reveal intrabar order; ambiguous exits use stop first.",
            "No tuning or strategy selection is permitted using held-out results.",
            "Regime coverage and small samples may be insufficient for live use.",
            "Evaluation applies only to the supplied universe, not all Nasdaq-100 stocks.",
        ],
        results={},
    )
    states = {}
    for label, days in [("development", dates[:split]), ("held_out", dates[split:])]:
        for stress in [1, 2]:
            key = f"{label}_cost_{stress}x"
            state, incomplete = replay(bars, days, stress)
            states[key] = state
            report["results"][key] = dict(
                start=days[0],
                end=days[-1],
                sessions=len(days),
                incomplete_exit_sessions=incomplete,
                **journal.summary(state),
            )
    # Regime diagnostics use the prior session benchmark return, never the same-day close.
    benchmark = bars.get("QQQ")
    report["regimes"] = {}
    if benchmark is not None:
        closes = benchmark.close.groupby(
            benchmark.index.tz_convert("America/New_York").date
        ).last()
        changes = closes.pct_change().shift(1)
        mapping = {
            str(d): ("rising" if r > 0.005 else "falling" if r < -0.005 else "sideways")
            for d, r in changes.items()
            if pd.notna(r)
        }
        trades = states["held_out_cost_1x"]["closed_trades"]
        for regime in ["rising", "falling", "sideways"]:
            values = [
                t["realized_pnl"]
                for t in trades
                if mapping.get(
                    str(
                        pd.Timestamp(t["entry_time"])
                        .tz_convert("America/New_York")
                        .date()
                    )
                )
                == regime
            ]
            report["regimes"][regime] = dict(
                sessions=sum(mapping.get(d) == regime for d in dates[split:]),
                trades=len(values),
                net_pnl=sum(values),
            )
    else:
        report["limitations"].append(
            "QQQ missing: prior-session market-regime coverage unavailable."
        )
    return report, states


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--data", type=Path, required=True)
    parser.add_argument("--output", type=Path, default=Path("backtests/orb"))
    args = parser.parse_args()
    raw = pd.read_csv(args.data)
    bars = {
        str(symbol): orb.normalize(frame.drop(columns="symbol").set_index("timestamp"))
        for symbol, frame in raw.groupby("symbol")
    }
    report, states = evaluate(bars)
    report["data_sha256"] = hashlib.sha256(args.data.read_bytes()).hexdigest()
    args.output.mkdir(parents=True, exist_ok=True)
    (args.output / "report.json").write_text(
        json.dumps(report, indent=2, allow_nan=False)
    )
    for key, state in states.items():
        pd.DataFrame(state["closed_trades"]).to_csv(
            args.output / f"{key}_trades.csv", index=False
        )
        pd.DataFrame(state["equity_history"]).to_csv(
            args.output / f"{key}_equity.csv", index=False
        )
    print(json.dumps(report, indent=2, allow_nan=False))


if __name__ == "__main__":
    main()
