"""Persistent, automatic paper trading. Never submits brokerage orders."""

import fcntl
import json
import math
import threading
from contextlib import contextmanager
from copy import deepcopy
from datetime import datetime, timedelta, timezone

import pandas as pd
import yfinance as yf

from shared import storage as secure_storage
from shared.paths import US_DIR
from trading import data as orb_data
from trading import journal as paper_journal
from trading import orb as paper_orb

ACCOUNT_FILE = US_DIR / "paper_account.json"


def new_account(budget, reserve_pct):
    if not math.isfinite(budget) or budget <= 0 or not 0 <= reserve_pct <= 100:
        raise ValueError("Enter a positive budget and a reserve between 0 and 100%.")
    return paper_journal.upgrade(
        dict(
            strategy=paper_orb.STRATEGY,
            budget=budget,
            cash=budget,
            reserve_pct=reserve_pct,
            positions={},
            fills=[],
            status="Running",
            realized_pnl=0,
            revision=0,
            message="Waiting for the opening-range breakout check.",
            last_check=None,
        )
    )


def eligible(picks):
    required = [
        "price",
        "sma50",
        "sma200",
        "rsi",
        "return_1m_pct",
        "return_3m_pct",
        "return_6m_pct",
        "momentum_score",
    ]
    if not {"symbol", "action", *required}.issubset(picks.columns):
        raise ValueError("Momentum scan is incomplete; trades are waiting.")
    frame = picks.copy()
    for col in required:
        frame[col] = pd.to_numeric(frame[col], errors="coerce")
    frame = frame.dropna(subset=required)
    frame = frame[frame[required].map(math.isfinite).all(axis=1)]
    return (
        frame[
            frame.action.isin(["HOLD", "STRONG HOLD"])
            & (frame.price > frame.sma50)
            & (frame.sma50 > frame.sma200)
            & (frame.return_1m_pct > 0)
            & (frame.return_3m_pct > 0)
            & (frame.return_6m_pct > 0)
            & frame.rsi.between(45, 70)
            & (frame.price > 0)
        ]
        .drop_duplicates("symbol")
        .sort_values("momentum_score", ascending=False)
        .head(paper_orb.RULES["max_picks"])
    )


def advance(account, ranked, quotes, now):
    """Legacy momentum replay helper; the running agent uses paper_orb.step."""
    state = deepcopy(account)
    if state["status"] != "Running":
        return state
    selected = eligible(ranked)
    wanted = set(selected.symbol)
    held = set(state["positions"])
    signal_columns = [
        "price",
        "sma50",
        "sma200",
        "rsi",
        "return_1m_pct",
        "return_3m_pct",
        "return_6m_pct",
        "momentum_score",
    ]
    numeric = ranked[signal_columns].apply(pd.to_numeric, errors="coerce")
    usable = numeric.map(lambda value: pd.notna(value) and math.isfinite(value)).all(
        axis=1
    )
    known = set(
        ranked.loc[
            usable & ranked.action.isin(["HOLD", "STRONG HOLD", "WATCH", "REPLACE"]),
            "symbol",
        ]
    )
    if held - known:
        raise ValueError("Signals unavailable for a held stock; trades are waiting.")
    for symbol in wanted | held:
        quote = quotes.get(symbol)
        if not quote or not math.isfinite(quote["price"]) or quote["price"] <= 0:
            raise ValueError(f"Price unavailable for {symbol}; trades are waiting.")
        age = now - datetime.fromisoformat(quote["timestamp"])
        if age < timedelta(minutes=-1) or age > timedelta(minutes=15):
            raise ValueError(f"Price for {symbol} is stale; trades are waiting.")
    stamp = now.isoformat()
    for symbol in held:
        state["positions"][symbol]["price"] = quotes[symbol]["price"]
        state["positions"][symbol]["quote_time"] = quotes[symbol]["timestamp"]
    # Exit stocks that leave the top eligible selections; keep existing selections.
    for symbol in sorted(held - wanted):
        position = state["positions"].pop(symbol)
        proceeds = position["quantity"] * quotes[symbol]["price"]
        pnl = proceeds - position["cost"]
        state["cash"] += proceeds
        state["realized_pnl"] += pnl
        state["fills"].append(
            dict(
                timestamp=stamp,
                symbol=symbol,
                side="SELL",
                quantity=position["quantity"],
                price=quotes[symbol]["price"],
                value=proceeds,
                realized_pnl=pnl,
                reason="Left momentum selections",
            )
        )
    equity = state["cash"] + sum(
        p["quantity"] * p["price"] for p in state["positions"].values()
    )
    reserve = equity * state["reserve_pct"] / 100
    target = equity * (1 - state["reserve_pct"] / 100) / len(wanted) if wanted else 0
    for symbol in selected.symbol:
        if symbol in state["positions"]:
            continue  # Repeated monitoring never pyramids the same position.
        price = quotes[symbol]["price"]
        allocation = min(target, max(0, state["cash"] - reserve))
        quantity = math.floor(allocation / price * 1000) / 1000
        if quantity <= 0:
            continue
        cost = quantity * price
        state["cash"] -= cost
        state["positions"][symbol] = dict(
            quantity=quantity,
            cost=cost,
            price=price,
            quote_time=quotes[symbol]["timestamp"],
        )
        state["fills"].append(
            dict(
                timestamp=stamp,
                symbol=symbol,
                side="BUY",
                quantity=quantity,
                price=price,
                value=cost,
                reason="Entered momentum selections",
            )
        )
    state["last_check"] = stamp
    state["message"] = "Monitoring holdings and momentum selections."
    return state


def market_quotes(symbols):
    if not symbols:
        return {}
    bars = yf.download(
        sorted(symbols),
        period="1d",
        interval="1m",
        auto_adjust=True,
        progress=False,
        threads=True,
        timeout=15,
        multi_level_index=True,
    )
    result = {}
    if bars is None or bars.empty:
        return result
    for symbol in symbols:
        try:
            prices = bars["Close"][symbol].dropna()
            if prices.empty:
                continue
            stamp = prices.index[-1]
            if stamp.tzinfo is None:
                stamp = stamp.tz_localize("America/New_York")
            result[symbol] = dict(
                price=float(prices.iloc[-1]), timestamp=stamp.isoformat()
            )
        except (KeyError, TypeError):
            continue
    return result


class PaperAgent:
    def __init__(self, path=ACCOUNT_FILE, start_worker=True):
        self.path = path
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.wake = threading.Event()
        self.feed = orb_data.Feed()
        self.ranked = None
        self.scanned_at = None
        if start_worker:
            threading.Thread(target=self._run, daemon=True, name="paper-agent").start()

    @contextmanager
    def _lock(self, suffix=".lock", nonblocking=False):
        with self.path.with_suffix(suffix).open("a") as file:
            fcntl.flock(file, fcntl.LOCK_EX | (fcntl.LOCK_NB if nonblocking else 0))
            try:
                yield
            finally:
                fcntl.flock(file, fcntl.LOCK_UN)

    def _read(self):
        if not self.path.exists():
            return None
        return json.loads(secure_storage.read_text(self.path))

    def snapshot(self):
        with self._lock():
            return self._read()

    def control(self, action, account=None):
        with self._lock():
            state = self._read()
            if state:
                state = paper_journal.upgrade(state)
            if action == "start":
                if state and state["status"] != "Ended":
                    return state
                state = deepcopy(account)
            elif state:
                state["status"] = {
                    "pause": "Paused",
                    "resume": "Running",
                    "end": "Ended",
                }[action]
            if state:
                state["revision"] = state.get("revision", 0) + 1
                secure_storage.write_text(self.path, json.dumps(state, allow_nan=False))
        self.wake.set()
        return state

    def cycle(self, now=None):
        supplied_now = now is not None
        now = now or datetime.now(timezone.utc)
        # One worker across dashboard processes/ports; UI controls remain responsive.
        with self._lock(".worker.lock", nonblocking=True):
            state = self.snapshot()
            if not state or state["status"] != "Running":
                return
            try:
                hours = paper_orb.session(
                    str(pd.Timestamp(now).tz_convert("America/New_York").date())
                )
                if not hours or not hours[0] <= pd.Timestamp(now) < hours[1]:
                    state = paper_orb.step(state, {}, now)
                else:
                    bars = self.feed.fetch(now, state["positions"])
                    checked_at = now if supplied_now else datetime.now(timezone.utc)
                    state = paper_orb.step(state, bars, checked_at)
            except Exception as exc:
                state["message"] = f"Monitoring will retry: {type(exc).__name__}: {exc}"
                state["last_check"] = now.isoformat()
            with self._lock():
                current = self._read()
                if (
                    current
                    and current["revision"] == state["revision"]
                    and current["status"] == "Running"
                ):
                    state["revision"] += 1
                    secure_storage.write_text(
                        self.path, json.dumps(state, allow_nan=False)
                    )

    def _run(self):
        while True:
            self.wake.clear()
            try:
                self.cycle()
            except Exception:
                # Storage/worker lock failures cannot terminate future monitoring.
                pass
            self.wake.wait(60)
