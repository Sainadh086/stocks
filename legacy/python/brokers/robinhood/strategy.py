"""Intraday opening-range signals for the separate Robinhood Agentic account."""

import json
import threading
from copy import deepcopy
from datetime import datetime, timedelta, timezone
from decimal import ROUND_DOWN, Decimal, InvalidOperation

import pandas as pd

from brokers.robinhood import accounts
from shared import storage as secure_storage
from shared.paths import US_DIR
from trading import data as orb_data
from trading import orb as paper_orb

STRATEGY = paper_orb.STRATEGY
OPEN_ORDER_STATES = {
    "new",
    "queued",
    "confirmed",
    "unconfirmed",
    "partially_filled",
    "pending_cancelled",
    "locating",
}
_SIGNAL_LOCK = threading.Lock()
_SIGNALS = None
_RISK_LOCK = threading.Lock()
RISK_FILE = US_DIR / "live_intraday_risk.json"


def selected_signals(signals):
    return (
        signals.get("ranked", pd.DataFrame())
        if signals.get("strategy") == STRATEGY
        else pd.DataFrame()
    )


def day_start_equity(snapshot, day):
    """Persist a per-account session baseline; page refreshes cannot reset the loss limit."""
    account = snapshot.get("account_number")
    equity = amount(snapshot.get("portfolio", {}).get("total_value"))
    if not account or equity is None or equity <= 0:
        return None
    with _RISK_LOCK:
        records = (
            json.loads(secure_storage.read_text(RISK_FILE))
            if RISK_FILE.exists()
            else {}
        )
        record = records.get(account)
        if not record or record["day"] != day:
            record = dict(day=day, equity=str(equity))
            records[account] = record
            secure_storage.write_text(RISK_FILE, json.dumps(records))
        return amount(record["equity"])


def amount(value):
    try:
        result = Decimal(str(value))
    except (InvalidOperation, TypeError):
        return None
    return result if result.is_finite() else None


def buying_power(portfolio):
    power = portfolio.get("buying_power")
    if not isinstance(power, dict):
        return None
    values = [
        amount(power.get("buying_power")),
        amount(power.get("unleveraged_buying_power")),
        amount(portfolio.get("cash")),
    ]
    if any(v is None for v in values) or portfolio.get("currency") != "USD":
        return None
    return max(Decimal(0), min(values))


def saved_budget(account):
    return accounts.load_trading_settings(account)


def signal_snapshot(now=None):
    now = now or datetime.now(timezone.utc)
    with _SIGNAL_LOCK:
        signals = deepcopy(_SIGNALS)
    if signals is None:
        return dict(
            strategy=STRATEGY,
            ranked=pd.DataFrame(),
            bars={},
            asof=None,
            fresh=False,
            message="Preparing intraday opening-range signals…",
        )
    stamp = datetime.fromisoformat(signals["asof"])
    signals["fresh"] = timedelta(0) <= now - stamp <= timedelta(seconds=90)
    if not signals["fresh"]:
        signals["message"] = "Waiting for current intraday data."
    return signals


class SignalMonitor:
    """Independent intraday feed; never reads the long-term recommendation cache."""

    def __init__(self, stop_event=None):
        self.stop = stop_event or threading.Event()
        self.wake = threading.Event()
        self.lock = threading.Lock()
        self.error = None
        self.feed = orb_data.Feed()
        threading.Thread(
            target=self._run, daemon=True, name="live-intraday-signals"
        ).start()

    def _run(self):
        global _SIGNALS
        while not self.stop.is_set():
            self.wake.clear()
            try:
                now = datetime.now(timezone.utc)
                day = str(pd.Timestamp(now).tz_convert("America/New_York").date())
                hours = paper_orb.session(day)
                if hours and hours[0] <= pd.Timestamp(now) < hours[1]:
                    bars = self.feed.fetch(now)
                    # Exclude future bars before computing the opening range.
                    bars = {
                        symbol: frame.loc[frame.index <= pd.Timestamp(now)]
                        for symbol, frame in bars.items()
                    }
                    picks = paper_orb.shortlist(bars, day)
                    with _SIGNAL_LOCK:
                        _SIGNALS = dict(
                            strategy=STRATEGY,
                            ranked=pd.DataFrame(picks),
                            bars=bars,
                            asof=now.isoformat(),
                            fresh=True,
                            message="Monitoring intraday breakouts, stops, targets and session exits.",
                        )
                with self.lock:
                    self.error = None
            except Exception as exc:
                with self.lock:
                    self.error = f"{type(exc).__name__}: {exc}"
            self.wake.wait(30)

    def snapshot(self):
        snapshot = signal_snapshot()
        with self.lock:
            if self.error:
                snapshot["message"] = "Intraday refresh will retry: " + self.error
                snapshot["fresh"] = False
        return snapshot


def quote_is_current(quote, now):
    if (
        not quote
        or quote.get("state") != "active"
        or quote.get("has_traded") is not True
    ):
        return False
    try:
        age = now - datetime.fromisoformat(
            quote["venue_last_trade_time"].replace("Z", "+00:00")
        )
    except (KeyError, ValueError, TypeError):
        return False
    price = amount(quote.get("last_trade_price"))
    return (
        price is not None
        and price > 0
        and timedelta(minutes=-1) <= age <= timedelta(minutes=15)
    )


def pending_symbols(snapshot, tickets):
    broker_orders = snapshot.get("orders", [])
    indexed = {o.get("id"): o for o in broker_orders if o.get("id")}
    pending = {
        o["symbol"]
        for o in broker_orders
        if o.get("symbol") and o.get("state") in OPEN_ORDER_STATES
    }
    unresolved = False
    for ticket in tickets:
        if ticket["status"] in {"unknown", "submitting"}:
            unresolved = True
        if ticket["status"] == "submitted":
            receipt = ticket.get("result", {}).get("order") or {}
            current = indexed.get(receipt.get("id"))
            if current is None or current.get("state") in OPEN_ORDER_STATES:
                pending.add(ticket["arguments"]["symbol"])
    return pending, unresolved


def holding_performance(position, quote):
    """Unrealized return against broker average purchase cost; never invent a basis."""
    quantity = amount(position.get("quantity"))
    average = amount(position.get("average_buy_price"))
    price = amount((quote or {}).get("last_trade_price"))
    if any(v is None or v <= 0 for v in (quantity, average, price)):
        return None
    invested = quantity * average
    value = quantity * price
    gain = value - invested
    return dict(
        invested=float(invested),
        value=float(value),
        pnl=float(gain),
        return_pct=float(gain / invested * 100),
    )


def build_actions(snapshot, signals, budget, reserve_pct, tickets=(), now=None):
    """Propose intraday orders for the dedicated Agentic account; never place them."""
    now = now or datetime.now(timezone.utc)
    clock = pd.Timestamp(now)
    day = str(clock.tz_convert("America/New_York").date())
    hours = paper_orb.session(day)
    picks = selected_signals(signals)
    selected = picks.to_dict("records") if not picks.empty else []
    positions = {
        p["symbol"]: p
        for p in snapshot.get("positions", [])
        if amount(p.get("quantity")) is not None and amount(p["quantity"]) > 0
    }
    quotes = snapshot.get("quotes", {})
    pending, unresolved = pending_symbols(snapshot, tickets)
    try:
        age = now - datetime.fromisoformat(snapshot["updated_at"])
        account_fresh = timedelta(0) <= age <= timedelta(seconds=90)
    except (KeyError, TypeError, ValueError):
        account_fresh = False
    wait = (
        "An order has an unresolved status. Check it before another trade."
        if unresolved
        else "Waiting for current account data."
        if not account_fresh
        else "Market closed."
        if not hours or not hours[0] <= clock < hours[1]
        else None
    )
    entry_wait = wait or (
        None
        if signals.get("fresh") and signals.get("strategy") == STRATEGY
        else "Waiting for current intraday signals."
    )
    portfolio = snapshot.get("portfolio", {})
    equity, budget_value, reserve = (
        amount(portfolio.get("total_value")),
        amount(budget),
        amount(reserve_pct),
    )
    power = buying_power(portfolio)
    valid = (
        all(v is not None for v in (equity, budget_value, reserve, power))
        and equity > 0
        and budget_value > 0
        and 0 <= reserve <= 100
    )
    deployable = (
        min(equity, budget_value) * (1 - reserve / 100) if valid else Decimal(0)
    )
    held_value = amount(portfolio.get("equity_value"))
    remaining = (
        min(power, max(Decimal(0), deployable - held_value))
        if valid and held_value is not None
        else Decimal(0)
    )
    baseline = (
        day_start_equity(snapshot, day)
        if valid
        and signals.get("strategy") == STRATEGY
        and account_fresh
        and hours
        and hours[0] <= clock < hours[1]
        else None
    )
    loss_blocked = (
        baseline is None or equity is None or equity <= baseline * Decimal(".99")
    )
    # Saved strategy tickets supply stops/targets independently of paper holdings.
    entries = {}
    traded = set()
    for ticket in sorted(tickets, key=lambda t: t.get("reviewed_at", "")):
        args = ticket["arguments"]
        if args["side"] != "buy" or ticket["status"] not in {
            "submitted",
            "unknown",
            "submitting",
        }:
            continue
        stamp = pd.Timestamp(ticket["reviewed_at"])
        if str(stamp.tz_convert("America/New_York").date()) == day:
            traded.add(args["symbol"])
        if ticket.get("strategy") == STRATEGY:
            entries[args["symbol"]] = ticket
    for order in snapshot.get("orders", []):
        stamp = order.get("created_at")
        if (
            stamp
            and order.get("side") == "buy"
            and str(pd.Timestamp(stamp).tz_convert("America/New_York").date()) == day
        ):
            traded.add(order.get("symbol"))
    actions = []
    for symbol, position in positions.items():
        quote = quotes.get(symbol)
        reason = None
        ticket = entries.get(symbol)
        if (
            not ticket
            or str(
                pd.Timestamp(ticket["reviewed_at"])
                .tz_convert("America/New_York")
                .date()
            )
            != day
        ):
            reason = "Flatten carried or legacy holding in the Agentic trading account."
        elif hours and clock >= hours[1] - pd.Timedelta(minutes=5):
            reason = "Scheduled exit five minutes before exchange close."
        else:
            price = amount((quote or {}).get("last_trade_price"))
            stop, target = amount(ticket.get("stop")), amount(ticket.get("target"))
            entry = amount(position.get("average_buy_price"))
            if entry is not None and stop is not None and entry > stop:
                target = entry + 2 * (entry - stop)
            if stop is None or target is None:
                reason = "Exit holding with missing intraday risk levels."
            elif price is not None and price <= stop:
                reason = "Opening-range stop hit."
            elif price is not None and price >= target:
                reason = "2R target hit."
        available = amount(position.get("shares_available_for_sells"))
        blocked = wait or (
            "Order already pending for this stock."
            if symbol in pending
            else "Waiting for a recent broker quote."
            if not quote_is_current(quote, now)
            else "No shares available to sell."
            if available is None or available <= 0
            else None
        )
        actions.append(
            dict(
                symbol=symbol,
                action="WAIT" if blocked else "EXIT" if reason else "HOLD",
                side="sell" if reason else None,
                enabled=bool(reason and not blocked),
                reason=blocked
                or reason
                or "Monitoring opening-range stop and 2R target.",
                quantity=format(
                    min(available or Decimal(0), amount(position["quantity"])), "f"
                ),
                price=(quote or {}).get("last_trade_price"),
                performance=holding_performance(position, quote),
            )
        )
    occupied = len(set(positions) | pending)
    for pick in selected:
        symbol = pick["symbol"]
        if symbol in positions:
            continue
        quote = quotes.get(symbol, {})
        blocked = entry_wait
        if not blocked and symbol in pending:
            blocked = "Order already pending for this stock."
        if not blocked and occupied >= 4:
            blocked = "Four-position trading limit reached."
        if not blocked and symbol in traded:
            blocked = "One entry per symbol per session; already traded today."
        if not blocked and not quote_is_current(quote, now):
            blocked = "Waiting for a recent broker quote."
        if not blocked and not valid:
            blocked = "Trading budget or buying power unavailable."
        if not blocked and loss_blocked:
            blocked = "Daily loss limit reached or session equity baseline unavailable."
        if not blocked and not (
            hours[0] + pd.Timedelta(minutes=20)
            <= clock
            < hours[1] - pd.Timedelta(minutes=5)
        ):
            blocked = "Waiting for the intraday entry window."
        frame = signals.get("bars", {}).get(symbol)
        if not blocked:
            current = (
                frame.loc[(frame.index >= hours[0]) & (frame.index <= clock)]
                if frame is not None
                else pd.DataFrame()
            )
            if len(current) < 2 or not pd.Timedelta(0) <= clock - current.index[
                -1
            ] < pd.Timedelta(minutes=1):
                blocked = "Waiting for a fresh 5-minute entry candle."
            else:
                prior_time = current.index[-1] - pd.Timedelta(minutes=5)
                older = current.loc[
                    (current.index >= hours[0] + pd.Timedelta(minutes=15))
                    & (current.index < prior_time)
                ]
                if (
                    prior_time not in current.index
                    or current.loc[prior_time, "close"] <= pick["range_high"]
                ):
                    blocked = "Waiting for a completed close above the opening range."
                elif (older.close > pick["range_high"]).any():
                    blocked = (
                        "First breakout passed; no chasing or replaying missed entries."
                    )
        price, stop = amount(quote.get("last_trade_price")), amount(pick["range_low"])
        allocation = Decimal(0)
        target = None
        if not blocked:
            if price <= stop:
                blocked = "Entry price is below the opening-range stop."
            else:
                # Include the shared paper cost model in the risk estimate.
                exit_cost = paper_orb.journal.execution(
                    float(stop), 1, "SELL", paper_orb.journal.DEFAULT_COSTS
                )
                entry_cost = paper_orb.journal.execution(
                    float(price), 1, "BUY", paper_orb.journal.DEFAULT_COSTS
                )
                risk = Decimal(
                    str(
                        entry_cost["value"]
                        + entry_cost["fee"]
                        - exit_cost["value"]
                        + exit_cost["fee"]
                    )
                )
                units = min(
                    equity * Decimal(".0025") / risk,
                    remaining / price,
                    deployable / 4 / price,
                )
                allocation = (units * price).quantize(
                    Decimal(".01"), rounding=ROUND_DOWN
                )
                target = price + 2 * (price - stop)
                if allocation <= 0:
                    blocked = "No cash available within the trading budget and reserve."
                else:
                    remaining -= allocation
                    occupied += 1
        actions.append(
            dict(
                symbol=symbol,
                action="WAIT" if blocked else "BUY",
                side="buy",
                enabled=not blocked,
                reason=blocked
                or "15-minute opening-range breakout; risk capped at 0.25% of equity.",
                dollar_amount=format(allocation, "f"),
                price=quote.get("last_trade_price"),
                stop=str(stop),
                target=str(target) if target is not None else None,
                relative_volume=pick["relative_volume"],
            )
        )
    return dict(
        actions=actions,
        shortlist=selected,
        target_usd=float(deployable / 4),
        buying_power=float(power) if power is not None else None,
        budget=float(budget_value) if budget_value is not None else None,
        reserve_pct=float(reserve) if reserve is not None else None,
        message=entry_wait or signals["message"],
    )


def prepared_arguments(account, action):
    if not action["enabled"] or action["action"] not in {"BUY", "EXIT"}:
        raise ValueError(
            "This action is waiting or no longer applies. Refresh the monitor."
        )
    from brokers.robinhood import orders as robinhood_orders

    return robinhood_orders.order_arguments(
        account,
        action["symbol"],
        action["side"],
        "market",
        "USD" if action["side"] == "buy" else "Shares",
        action["dollar_amount"] if action["side"] == "buy" else action["quantity"],
    )


def rebalance_plan(
    snapshot, signals, budget, reserve_pct, tickets=(), now=None, *, current=None
):
    """Plan contingent buys; optionally reuse decisions from the same inputs.

    Copy reused decisions before adding conditional buys. Execution still
    revalidates actual buying power and signals against a fresh broker snapshot.
    """
    current = (
        deepcopy(current)
        if current is not None
        else build_actions(snapshot, signals, budget, reserve_pct, tickets, now)
    )
    sells = [a for a in current["actions"] if a["enabled"] and a["side"] == "sell"]
    if not sells:
        return current
    proceeds = sum(amount(a["quantity"]) * amount(a["price"]) for a in sells)
    projected = deepcopy(snapshot)
    portfolio = projected["portfolio"]
    cash = amount(portfolio.get("cash"))
    equity = amount(portfolio.get("equity_value"))
    power = portfolio.get("buying_power") or {}
    if (
        cash is None
        or equity is None
        or any(
            amount(power.get(k)) is None
            for k in ["buying_power", "unleveraged_buying_power"]
        )
    ):
        return current
    sold = {a["symbol"]: amount(a["quantity"]) for a in sells}
    positions = []
    for p in projected["positions"]:
        remaining = amount(p["quantity"]) - sold.get(p["symbol"], 0)
        if remaining > 0:
            p["quantity"] = format(remaining, "f")
            positions.append(p)
    projected["positions"] = positions
    buffered_proceeds = proceeds * Decimal(".99")
    portfolio["cash"] = format(cash + buffered_proceeds, "f")
    total = amount(portfolio.get("total_value"))
    if total is not None:
        portfolio["total_value"] = format(
            max(Decimal(0), total - proceeds * Decimal(".01")), "f"
        )
    portfolio["equity_value"] = format(max(0, equity - proceeds), "f")
    for key in ["buying_power", "unleveraged_buying_power"]:
        power[key] = format(amount(power[key]) + buffered_proceeds, "f")
    planned = build_actions(projected, signals, budget, reserve_pct, tickets, now)
    conditional = []
    for action in planned["actions"]:
        if action["side"] == "buy" and action["enabled"]:
            action["after_sell_fills"] = True
            action["reason"] = (
                "Planned buy after confirmed sells and refreshed available buying power."
            )
            conditional.append(action)
    replacements = {a["symbol"] for a in conditional}
    current["actions"] = [
        a for a in current["actions"] if a["symbol"] not in replacements
    ] + conditional
    return current
