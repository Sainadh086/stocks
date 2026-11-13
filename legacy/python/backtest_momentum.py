"""Monthly India technical-shortlist backtest; current constituents, not PIT data.

Run with the stocks virtual environment. All cached data and results are encrypted.
"""

import argparse
import json
from concurrent.futures import ThreadPoolExecutor, as_completed

import numpy as np
import pandas as pd
import yfinance as yf

from brokers.kite import analysis as kite
from shared import momentum, storage
from shared.paths import BACKTESTS_DIR

DIRECTORY = BACKTESTS_DIR
START = pd.Timestamp("2016-10-04")
END = "2026-10-05"
INITIAL = 100_000.0


def load_prices(symbol):
    path = DIRECTORY / "prices" / f"{symbol.replace('&', '_')}.csv"
    if path.exists():
        frame = storage.read_csv(path, index_col=0, parse_dates=True)
        return symbol, frame
    ticker = symbol if symbol.startswith("^") else symbol + ".NS"
    frame = yf.Ticker(ticker).history(
        start="2015-07-01", end=END, auto_adjust=True, interval="1d", timeout=30
    )
    if frame.empty:
        return symbol, pd.DataFrame()
    frame.index = frame.index.tz_localize(None).normalize()
    frame = frame.rename(columns=str.lower)[["open", "high", "low", "close", "volume"]]
    frame = frame[~frame.index.duplicated()].sort_index().dropna()
    frame = frame[(frame[["open", "high", "low", "close"]] > 0).all(axis=1)]
    storage.write_csv(frame, path, index=True)
    return symbol, frame


def select(prepared, signal, execution):
    ranked = []
    for symbol, frame in prepared.items():
        if signal not in frame.index or execution not in frame.index:
            continue
        index = frame.index.get_loc(signal)
        if index < 199:
            continue
        history = frame.iloc[: index + 1]
        latest = history.iloc[-1]
        if not np.isfinite(
            latest[["SMA200", "RSI", "RETURN_126D"]].astype(float)
        ).all():
            continue
        score, _ = momentum.calculate_momentum_score(history)
        action = momentum.classify_stock(score, momentum.detect_deterioration(history))
        if action in ("HOLD", "STRONG HOLD"):
            ranked.append((symbol, score, float(latest["RETURN_126D"])))
    # Deterministic alphabetical tie-break after the production score and 6M return.
    ranked.sort(key=lambda row: (-row[1], -row[2], row[0]))
    return ranked[: kite.MAX_PORTFOLIO_SIZE]


def simulate(prices, benchmark, cost_bps=0):
    prepared = {
        symbol: momentum.calculate_indicators(frame) for symbol, frame in prices.items()
    }
    calendar = benchmark.index[benchmark.index >= START]
    if len(calendar) < 2:
        raise ValueError("Insufficient benchmark dates.")
    opens = pd.DataFrame(
        {symbol: frame.open for symbol, frame in prices.items()}
    ).reindex(calendar)
    closes = pd.DataFrame(
        {symbol: frame.close for symbol, frame in prices.items()}
    ).reindex(calendar)
    # Forward fill valuations only, never prices used to execute orders.
    values = closes.ffill()
    units = {}
    cash = INITIAL
    trades = []
    curve = []
    last_month = None
    cost_rate = cost_bps / 10_000
    total_cost = 0
    selected_dates = []
    for date in calendar:
        month = date.to_period("M")
        if month != last_month:
            prior_dates = benchmark.index[benchmark.index < date]
            if prior_dates.empty:
                raise ValueError("No prior trading day for the initial signal.")
            signal = prior_dates[-1]
            chosen = select(prepared, signal, date)
            symbols = [row[0] for row in chosen]
            scores = {row[0]: row[1] for row in chosen}
            # Do not invent an execution price for a suspended/missing held position.
            locked = {symbol for symbol in units if pd.isna(opens.at[date, symbol])}
            tradable_wealth = cash + sum(
                quantity * opens.at[date, symbol]
                for symbol, quantity in units.items()
                if symbol not in locked
            )
            symbols = [symbol for symbol in symbols if symbol not in locked]
            target = tradable_wealth / len(symbols) if symbols else 0
            # Solve the equal-weight allocation after costs on both buys and sells.
            current = {
                symbol: units.get(symbol, 0) * opens.at[date, symbol]
                for symbol in set(units) | set(symbols)
                if symbol not in locked
            }
            for _ in range(100):
                turnover = sum(
                    abs((target if symbol in symbols else 0) - value)
                    for symbol, value in current.items()
                )
                new_target = (
                    max(0, tradable_wealth - turnover * cost_rate) / len(symbols)
                    if symbols
                    else 0
                )
                if abs(new_target - target) < 1e-9:
                    target = new_target
                    break
                target = new_target
            new_units = {symbol: units[symbol] for symbol in locked}
            traded = 0
            for symbol, old_value in sorted(current.items()):
                new_value = target if symbol in symbols else 0
                difference = new_value - old_value
                traded += abs(difference)
                if abs(difference) > 1e-7:
                    trades.append(
                        dict(
                            date=str(date.date()),
                            signal_date=str(signal.date()),
                            symbol=symbol,
                            side="BUY" if difference > 0 else "SELL",
                            traded_inr=abs(difference),
                            cost_inr=abs(difference) * cost_rate,
                            score=scores.get(symbol),
                            adjusted_open=float(opens.at[date, symbol]),
                        )
                    )
                if symbol in symbols:
                    new_units[symbol] = new_value / opens.at[date, symbol]
            expense = traded * cost_rate
            total_cost += expense
            cash = max(0, tradable_wealth - target * len(symbols) - expense)
            units = new_units
            last_month = month
            selected_dates.append(
                dict(
                    date=str(date.date()),
                    signal_date=str(signal.date()),
                    selected="|".join(symbols),
                    locked="|".join(sorted(locked)),
                    eligible_count=len(chosen),
                )
            )
        holding_values = [
            quantity * values.at[date, symbol] for symbol, quantity in units.items()
        ]
        if not np.isfinite(holding_values).all():
            raise ValueError("Missing valuation for a held stock.")
        curve.append(
            dict(
                date=str(date.date()),
                value_inr=cash + sum(holding_values),
                cash_inr=cash,
                positions=len(units),
            )
        )
    frame = pd.DataFrame(curve)
    years = (calendar[-1] - calendar[0]).days / 365.25
    # Include initial wealth so first-day losses contribute to drawdown.
    equity = pd.Series([INITIAL] + frame.value_inr.tolist())
    drawdown = equity / equity.cummax() - 1
    benchmark_value = (
        INITIAL
        * benchmark.loc[calendar[-1], "close"]
        / benchmark.loc[calendar[0], "open"]
    )
    summary = dict(
        initial_inr=INITIAL,
        final_inr=float(frame.value_inr.iloc[-1]),
        profit_inr=float(frame.value_inr.iloc[-1] - INITIAL),
        cagr_pct=float(((frame.value_inr.iloc[-1] / INITIAL) ** (1 / years) - 1) * 100),
        max_drawdown_pct=float(drawdown.min() * 100),
        trading_costs_inr=total_cost,
        cost_bps_per_side=cost_bps,
        rebalances=len(selected_dates),
        start=str(calendar[0].date()),
        end=str(calendar[-1].date()),
        nifty50_price_benchmark_final_inr=float(benchmark_value),
        locked_rebalances=sum(bool(item["locked"]) for item in selected_dates),
    )
    return summary, frame, pd.DataFrame(trades), pd.DataFrame(selected_dates)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.parse_args()
    DIRECTORY.mkdir(parents=True, exist_ok=True)
    universe_path = DIRECTORY / "universe.json"
    if universe_path.exists():
        symbols = json.loads(storage.read_text(universe_path))["symbols"]
    else:
        symbols = sorted(kite.get_index_symbols())
        storage.write_text(
            universe_path, json.dumps({"retrieved": "2026-10-04", "symbols": symbols})
        )
    prices = {}
    failures = []
    with ThreadPoolExecutor(max_workers=4) as pool:
        futures = {
            pool.submit(load_prices, symbol): symbol for symbol in symbols + ["^NSEI"]
        }
        for index, future in enumerate(as_completed(futures), 1):
            try:
                symbol, frame = future.result()
                if frame.empty:
                    failures.append(futures[future])
                else:
                    prices[symbol] = frame
            except Exception:
                failures.append(futures[future])
            if index % 25 == 0:
                print(f"Downloaded/cached {index}/{len(futures)} symbols", flush=True)
    benchmark = prices.pop("^NSEI", None)
    if benchmark is None:
        raise RuntimeError(
            "Benchmark history unavailable; cannot establish the trading calendar."
        )
    report = dict(
        universe_count=len(symbols),
        usable_count=len(prices),
        missing_symbols=sorted(failures),
        assumptions=[
            "Current constituents: survivorship and future-membership bias",
            "Technical shortlist only; no historical fundamentals gates",
            "Top eight HOLD/STRONG HOLD; score then six-month return",
            "Monthly first-session open execution using prior-session signals",
            "Fractional adjusted units, dividends implicitly reinvested; no whole-share constraints",
            "No contributions, taxes, slippage beyond stated cost, cash interest or intramonth stop",
            "Missing held execution quotes lock the position; last close used for valuation",
            "Nifty 50 benchmark is price-only and is a different universe",
        ],
    )
    for cost in (0, 10, 25, 50):
        summary, curve, trades, allocations = simulate(prices, benchmark, cost)
        report[f"cost_{cost}_bps"] = summary
        for name, frame in (
            ("equity", curve),
            ("trades", trades),
            ("allocations", allocations),
        ):
            storage.write_csv(frame, DIRECTORY / f"{name}_{cost}bps.csv", index=False)
        print(json.dumps(summary), flush=True)
    storage.write_text(DIRECTORY / "summary.json", json.dumps(report, indent=2))
    print(f"Saved encrypted results to {DIRECTORY}", flush=True)


if __name__ == "__main__":
    main()
