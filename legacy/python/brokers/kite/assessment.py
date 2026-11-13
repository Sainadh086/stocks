"""Explain rebalance priority and the next exchange-calendar review date."""

from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

import pandas as pd
import pandas_market_calendars as calendars

ZONE = ZoneInfo("Asia/Kolkata")
DRIFT_THRESHOLD = 5.0


def trading_schedule(day):
    return calendars.get_calendar("NSE").schedule(
        start_date=day, end_date=day + timedelta(days=35)
    )


def assess(view, snapshot, strategy, insight=None, now=None, schedule=None):
    now = now or datetime.now(ZONE)
    now = now.astimezone(ZONE)
    schedule = trading_schedule(now.date()) if schedule is None else schedule
    current = pd.Timestamp(now)
    today = schedule[schedule.index.date == now.date()]
    opened = (
        not today.empty
        and today.iloc[0].market_open <= current < today.iloc[0].market_close
    )
    next_sessions = schedule[schedule.market_open > current]
    next_open = (
        next_sessions.iloc[0].market_open.tz_convert(ZONE)
        if not next_sessions.empty
        else None
    )
    # Use Friday's existing portfolio-review cadence for a stable portfolio.
    days_to_friday = (4 - now.weekday()) % 7
    friday = now.date() + timedelta(days=days_to_friday)
    if days_to_friday == 0 and (today.empty or current >= today.iloc[0].market_open):
        friday += timedelta(days=7)
    weekly = next_sessions[next_sessions.index.date >= friday]
    weekly_open = (
        weekly.iloc[0].market_open.tz_convert(ZONE) if not weekly.empty else next_open
    )
    buys = pd.to_numeric(
        view.get("shares_to_buy", pd.Series(dtype=float)), errors="coerce"
    ).fillna(0)
    sells = pd.to_numeric(
        view.get("shares_to_sell", pd.Series(dtype=float)), errors="coerce"
    ).fillna(0)
    changed = bool(buys.gt(0).any() or sells.gt(0).any())
    signals = view.get("signal", pd.Series(dtype=str)).fillna("")
    holdings = (snapshot or {}).get("holdings", [])
    planned_exits = set(view.loc[view["status"].eq("Exit"), "symbol"])
    urgent = [
        h["symbol"]
        for h in holdings
        if h["symbol"] in planned_exits
        and h.get("action") == "REPLACE"
        and "two dated scans" in str(h.get("plan_reason", ""))
    ]
    stale = (snapshot or {}).get("date") != now.date().isoformat()
    missing = (
        "target_shares" not in view
        or view["target_shares"].isna().any()
        or signals.eq("NO DATA").any()
    )
    before = pd.to_numeric(
        view.get("current_allocation_pct", pd.Series(dtype=float)), errors="coerce"
    )
    after = pd.to_numeric(
        view.get("target_allocation_pct", pd.Series(dtype=float)), errors="coerce"
    )
    drift = (
        float((after - before).abs().max())
        if not before.empty and (after - before).notna().any()
        else None
    )
    theme = (insight or {}).get("theme", "unknown")
    if insight and str(insight.get("date")) != (snapshot or {}).get("date"):
        theme = "unknown"
    structural = bool(view["status"].isin(["New", "Exit"]).any())
    decision = "Hold"
    reasons = []
    good = False
    next_review = weekly_open
    if stale or missing:
        decision = "Watch"
        next_review = next_open
        if stale:
            reasons.append(
                "The strategy scan is not dated today in India. Run India analysis before deciding."
            )
        if missing:
            reasons.append(
                "Some target quantities or holding signals lack usable data."
            )
    elif urgent and changed:
        decision = "Rebalance needed"
        good = opened
        next_review = None if opened else next_open
        reasons.append(
            "Confirmed REPLACE signals on two dated scans: "
            + ", ".join(urgent)
            + ". Prioritise reviewing these exits."
        )
    elif not changed:
        reasons.append("The proposed basket has no buy or sell quantity changes.")
    elif not opened:
        decision = "Watch"
        next_review = next_open
        reasons.append(
            "The regular NSE market session is closed. Reassess at the next trading session."
        )
    elif signals.isin(["WATCH", "REPLACE"]).any():
        decision = "Watch"
        next_review = next_open
        reasons.append(
            "Watch or first-scan REPLACE signals still need a follow-up strategy scan."
        )
    elif theme in ["bearish", "unknown"]:
        decision = "Watch"
        next_review = next_open
        reasons.append(
            "The saved market breadth is bearish or unavailable; confirm conditions with a fresh scan before changing the basket."
        )
    elif structural or (drift is not None and drift >= DRIFT_THRESHOLD):
        decision = "Rebalance"
        good = True
        next_review = None
        reasons.append(
            "The strategy basket contains additions/removals or allocation drift of at least 5 percentage points."
        )
    else:
        reasons.append(
            "Only small allocation adjustments are proposed; no confirmed strategy exit is present."
        )
    if urgent and (stale or missing):
        reasons.append(
            "A confirmed exit exists, but refresh the missing or stale data before acting."
        )
    if not opened and urgent and not stale and not missing:
        reasons.append(
            "Execute only after reviewing fresh prices and available funds in a trading session."
        )
    return dict(
        decision=decision,
        good_day=good,
        reasons=reasons,
        theme=theme,
        next_review=next_review.isoformat() if next_review is not None else None,
        scan_date=(snapshot or {}).get("date"),
        strategy=strategy,
        drift_pct=drift,
        assessed_at=now.isoformat(),
    )
