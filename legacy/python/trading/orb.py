"""Frozen long-only ORB rules shared by monitoring and historical replay."""

import math
from functools import lru_cache

import pandas as pd
import pandas_market_calendars as mcal

from trading import journal

STRATEGY = "orb_15m_v1"
RULES = dict(
    opening_minutes=15,
    risk_pct=0.25,
    daily_loss_pct=1.0,
    reward_multiple=2.0,
    max_picks=4,
    min_relative_volume=1.5,
    baseline_days=20,
    min_baseline_days=10,
)


@lru_cache(maxsize=400)
def session(day):
    schedule = mcal.get_calendar("NYSE").schedule(start_date=day, end_date=day)
    if schedule.empty:
        return None
    return schedule.iloc[0].market_open, schedule.iloc[0].market_close


def normalize(frame):
    frame = frame.copy()
    frame.columns = [str(c).lower() for c in frame.columns]
    frame.index = pd.to_datetime(frame.index, utc=True)
    frame = frame.sort_index()
    if frame.index.has_duplicates:
        raise ValueError("Duplicate intraday timestamps.")
    required = ["open", "high", "low", "close", "volume"]
    frame = frame[required].apply(pd.to_numeric, errors="raise")
    if (
        not frame.map(math.isfinite).all().all()
        or (frame[["open", "high", "low", "close"]] <= 0).any().any()
    ):
        raise ValueError("Invalid intraday prices.")
    if (
        (frame.high < frame[["open", "close", "low"]].max(axis=1))
        | (frame.low > frame[["open", "close", "high"]].min(axis=1))
        | (frame.volume < 0)
    ).any():
        raise ValueError("Invalid intraday OHLCV.")
    return frame


def shortlist(bars, day):
    hours = session(day)
    if not hours:
        return []
    opened, _ = hours
    rows = []
    for symbol, frame in bars.items():
        opening = frame.loc[
            (frame.index >= opened) & (frame.index < opened + pd.Timedelta(minutes=15))
        ]
        expected = pd.date_range(opened, periods=3, freq="5min")
        if not opening.index.equals(expected):
            continue
        prior = frame.loc[frame.index < opened].copy()
        local = prior.index.tz_convert("America/New_York")
        prior = prior[(local.hour == 9) & (local.minute >= 30) & (local.minute < 45)]
        volumes = []
        for date, group in prior.groupby(
            prior.index.tz_convert("America/New_York").date
        ):
            prior_hours = session(str(date))
            if prior_hours and group.index.equals(
                pd.date_range(prior_hours[0], periods=3, freq="5min")
            ):
                volumes.append(float(group.volume.sum()))
        if len(volumes) < RULES["min_baseline_days"]:
            continue
        baseline = sum(volumes[-20:]) / len(volumes[-20:])
        relative = float(opening.volume.sum()) / baseline if baseline else 0
        if (
            relative >= RULES["min_relative_volume"]
            and opening.low.min() < opening.high.max()
        ):
            rows.append(
                dict(
                    symbol=symbol,
                    range_high=float(opening.high.max()),
                    range_low=float(opening.low.min()),
                    relative_volume=relative,
                )
            )
    return sorted(rows, key=lambda r: (-r["relative_volume"], r["symbol"]))[:4]


def step(account, bars, now, allow_entry=True):
    """Use only completed 5m candles; breakout fills at the next observed open.

    Monitoring never replays missed entries. Replay must invoke this at each bar.
    Stop wins when stop and target occur in the same candle.
    """
    state = journal.upgrade(account)
    if state["status"] != "Running":
        return state
    now = pd.Timestamp(now).tz_convert("UTC")
    day = str(now.tz_convert("America/New_York").date())
    hours = session(day)
    if not hours:
        state["message"] = "Market closed. Waiting for the next US trading session."
        state["last_check"] = now.isoformat()
        return state
    opened, closed = hours
    cutoff = closed - pd.Timedelta(minutes=5)
    if now < opened or now >= closed:
        state["message"] = (
            "Market closed; any unclosed holdings await the next available session price."
        )
        state["last_check"] = now.isoformat()
        return state
    stamp = now.isoformat()
    if state.get("session_day") != day:
        state.update(
            session_day=day,
            day_start_equity=journal.equity(state),
            traded_today=[],
            shortlist=[],
        )
    if (
        now >= opened + pd.Timedelta(minutes=15)
        and not state.get("shortlist_fixed") == day
    ):
        state["shortlist"] = shortlist(bars, day)
        state["shortlist_fixed"] = day
    for symbol in list(state["positions"]):
        frame = bars.get(symbol)
        if frame is None:
            continue
        current = frame.loc[(frame.index >= opened) & (frame.index <= now)]
        if current.empty:
            continue
        position = state["positions"][symbol]
        # Legacy/overnight holdings exit using an observed session open, never invented risk history.
        if position.get("session_day") != day or position.get("stop") is None:
            journal.sell(
                state,
                symbol,
                float(current.iloc[-1].open),
                stamp,
                "Flatten carried/legacy holding",
            )
            continue
        completed = current.loc[
            (current.index + pd.Timedelta(minutes=5) <= now)
            & (current.index >= pd.Timestamp(position["entry_time"]))
        ]
        last = position.get("processed_bar")
        if last:
            completed = completed.loc[completed.index > pd.Timestamp(last)]
        for time, row in completed.iterrows():
            position["price"] = float(row.close)
            position["quote_time"] = (time + pd.Timedelta(minutes=5)).isoformat()
            position["processed_bar"] = time.isoformat()
            stop, target = position["stop"], position["target"]
            if row.low <= stop:
                journal.sell(
                    state,
                    symbol,
                    min(float(row.open), stop),
                    (time + pd.Timedelta(minutes=5)).isoformat(),
                    "Stop hit (stop first if ambiguous)",
                )
                break
            if row.high >= target:
                journal.sell(
                    state,
                    symbol,
                    target,
                    (time + pd.Timedelta(minutes=5)).isoformat(),
                    "2R target hit",
                )
                break
        if symbol in state["positions"] and now >= cutoff:
            # Require an actual cutoff candle. No use of a stale earlier open to claim EOD execution.
            if current.index[-1] >= cutoff and now - current.index[-1] < pd.Timedelta(
                minutes=5
            ):
                journal.sell(
                    state,
                    symbol,
                    float(current.iloc[-1].open),
                    stamp,
                    "Scheduled end-of-day exit",
                )
    equity = journal.equity(state)
    loss = state["day_start_equity"] - equity
    blocked = loss >= state["day_start_equity"] * RULES["daily_loss_pct"] / 100
    if (
        allow_entry
        and not blocked
        and opened + pd.Timedelta(minutes=20) <= now < cutoff
    ):
        for pick in state["shortlist"]:
            symbol = pick["symbol"]
            if symbol in state["positions"] or symbol in state["traded_today"]:
                continue
            frame = bars.get(symbol)
            if frame is None:
                continue
            # Entry only in first minute of a new 5m candle, with contiguous completed predecessor.
            current = frame.loc[(frame.index >= opened) & (frame.index <= now)]
            if len(current) < 2:
                continue
            time = current.index[-1]
            if now - time >= pd.Timedelta(minutes=1):
                continue
            prior_time = time - pd.Timedelta(minutes=5)
            if prior_time not in current.index:
                continue
            prior = current.loc[prior_time]
            if (
                prior_time < opened + pd.Timedelta(minutes=15)
                or prior.close <= pick["range_high"]
            ):
                continue
            # First breakout only, rather than chasing an already extended breakout.
            older = current.loc[
                (current.index >= opened + pd.Timedelta(minutes=15))
                & (current.index < prior_time)
            ]
            if (older.close > pick["range_high"]).any():
                continue
            reference = float(current.loc[time].open)
            entry = journal.execution(reference, 1, "BUY", state["cost_model"])
            stop = pick["range_low"]
            if entry["price"] <= stop:
                continue
            available = max(0, state["cash"] - equity * state["reserve_pct"] / 100)
            # Risk includes adverse stop execution and fees on both legs.
            exit_fill = journal.execution(stop, 1, "SELL", state["cost_model"])
            unit_risk = (
                entry["value"] + entry["fee"] - exit_fill["value"] + exit_fill["fee"]
            )
            qty = (
                math.floor(
                    min(
                        equity * 0.0025 / unit_risk,
                        available / (entry["value"] + entry["fee"]),
                        equity
                        * (1 - state["reserve_pct"] / 100)
                        / 4
                        / (entry["value"] + entry["fee"]),
                    )
                    * 1000
                )
                / 1000
            )
            if qty <= 0:
                continue
            target = entry["price"] + 2 * (entry["price"] - stop)
            reason = f"15m ORB: completed close {prior.close:.4f} > range {pick['range_high']:.4f}; opening relative volume {pick['relative_volume']:.2f}x"
            journal.buy(
                state,
                symbol,
                reference,
                qty,
                time.isoformat(),
                reason,
                stop,
                target,
                session_day=day,
            )
            state["traded_today"].append(symbol)
    journal.mark(state, stamp)
    state["last_check"] = stamp
    state["strategy"] = STRATEGY
    state["message"] = (
        "Daily loss limit reached; no new entries."
        if blocked
        else "Monitoring opening-range breakouts, stops, targets and end-of-day exits."
    )
    return state
