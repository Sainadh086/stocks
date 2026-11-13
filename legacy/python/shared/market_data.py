"""UI-independent daily market readings and exchange sessions."""

from concurrent.futures import Future
from dataclasses import dataclass, field
from datetime import timedelta
from threading import Lock, Thread
from time import monotonic

import pandas as pd
import pandas_market_calendars as calendars

from shared import prices


@dataclass(frozen=True)
class Market:
    code: str
    name: str
    ticker: str
    benchmark: str
    calendar: str
    zone: str
    scan_pattern: str
    education_url: str


MARKETS = (
    Market(
        "IND",
        "India",
        "^NSEI",
        "Nifty 50",
        "NSE",
        "Asia/Kolkata",
        "nifty_midsmallcap_400_momentum_ranked_*.csv",
        "https://investor.sebi.gov.in/investment_risk_managment.html",
    ),
    Market(
        "US",
        "US",
        "^GSPC",
        "S&P 500",
        "NYSE",
        "America/New_York",
        "us_nasdaq_100_momentum_ranked_*.csv",
        "https://www.investor.gov/introduction-investing/getting-started/asset-allocation",
    ),
)


def benchmark_report(history, market, now, sessions):
    """Use completed sessions only; daily movement and trend are different signals."""
    completed = sessions[sessions.market_close <= pd.Timestamp(now)]
    if completed.empty:
        raise ValueError("No completed exchange session available")
    expected = completed.index[-1].date()
    close = pd.to_numeric(history.get("Close", pd.Series(dtype=float)), errors="coerce")
    close = close[close.gt(0)].dropna().sort_index()
    close = close[~close.index.duplicated(keep="last")]
    dates = pd.to_datetime(close.index)
    if dates.tz is not None:
        dates = dates.tz_convert(market.zone)
    close.index = dates
    close = close[dates.date <= expected]
    if len(close) < 50:
        raise ValueError("At least 50 completed daily prices are required")
    price, previous = float(close.iloc[-1]), float(close.iloc[-2])
    average = float(close.iloc[-50:].mean())
    source_date = close.index[-1].date()
    theme = "bullish" if price > average else "bearish" if price < average else "mixed"
    return {
        "theme": theme,
        "price": price,
        "change_pct": (price / previous - 1) * 100,
        "sma50": average,
        "distance_pct": (price / average - 1) * 100,
        "date": source_date,
        "expected_date": expected,
        "generated_at": now.isoformat(),
        "briefing_date": now.date(),
        "stale": source_date < expected,
        "history": close.tail(60).rename(market.benchmark),
    }


def fetch_daily_report(market, now):
    sessions = calendars.get_calendar(market.calendar).schedule(
        start_date=now.date() - timedelta(days=14), end_date=now.date()
    )
    history = prices.history(market.ticker, period="1y")
    report = benchmark_report(history, market, now, sessions)
    report["source"] = history.attrs.get("source", "Unknown")
    return report


@dataclass
class DailyState:
    key: tuple | None = None
    report_key: tuple | None = None
    report: dict | None = None
    pending: Future | None = None
    error: str | None = None
    attempted_at: float = 0
    lock: Lock = field(default_factory=Lock)


class DailyMarkets:
    """Share public daily data across viewers without blocking the app or trading UI."""

    def __init__(self):
        self.states = {market.code: DailyState() for market in MARKETS}

    def snapshot(self, market, now, phase):
        state = self.states[market.code]
        # Refresh on each local day and again after the exchange closes.
        key = (now.date(), phase == "After market close")
        with state.lock:
            pending = state.pending
            if pending is not None and pending.done():
                try:
                    state.report = pending.result()
                    state.report_key = state.key
                    state.error = None
                except Exception as exc:
                    state.error = f"{type(exc).__name__}: {exc}"
                state.pending = None
            retry = 300 if state.error else 3600
            elapsed = monotonic() - state.attempted_at
            stale = state.report is not None and state.report["stale"]
            due = state.key != key or ((state.error or stale) and elapsed >= retry)
            if state.pending is None and due:
                future = Future()
                state.pending = future
                state.key = key
                state.attempted_at = monotonic()

                def load():
                    try:
                        future.set_result(fetch_daily_report(market, now))
                    except Exception as exc:
                        future.set_exception(exc)

                Thread(
                    target=load, daemon=True, name=f"daily-market-{market.code}"
                ).start()
            report = state.report
            if report is not None and state.report_key != key:
                report = {**report, "stale": True}
            return report, state.error, state.pending is not None


def report_theme(report, now):
    if report is None:
        return "unavailable"
    if report["stale"] or report["briefing_date"] != now.date():
        return "stale"
    return report["theme"]


MESSAGES = {
    "bullish": (
        "Strength sets the stage; patience chooses the entry. Let the opening confirm the momentum.",
        "A rising market rewards discipline. Carry the lessons forward, not the urge to chase.",
    ),
    "bearish": (
        "When the market feels heavy, a clear plan is an advantage. Protect your patience and your capital.",
        "A difficult session can still be a useful one. Review the risk, reset the plan, and leave the pressure behind.",
    ),
    "mixed": (
        "A mixed market calls for a steady mind. Wait for clarity before committing conviction.",
        "When signals disagree, reflection matters more than reaction. Keep what worked and question what did not.",
    ),
    "neutral": (
        "Begin with a plan and an open mind. Let the market reveal its direction before you decide yours.",
        "Close the day with perspective. One session is a lesson, not the whole journey.",
    ),
}


def messages(insight):
    theme = (insight or {}).get("theme", "neutral")
    opening, closing = MESSAGES.get(theme, MESSAGES["neutral"])
    return dict(theme=theme, opening=opening, closing=closing)


def session_phase(schedule, now):
    """Respect holidays and early closes using the exchange schedule."""
    if schedule.empty:
        return "Market closed"
    row = schedule.iloc[0]
    current = pd.Timestamp(now)
    if current < row.market_open:
        return "Before market open"
    if current >= row.market_close:
        return "After market close"
    return "Market open"


def market_schedule(calendar, day):
    return calendars.get_calendar(calendar).schedule(start_date=day, end_date=day)
