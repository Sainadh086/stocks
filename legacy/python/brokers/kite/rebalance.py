"""Reviewed CNC equity rebalances; all placement requires explicit UI confirmation."""

import fcntl
import json
import re
import time
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from decimal import Decimal, InvalidOperation
from pathlib import Path
from uuid import uuid4

import pandas as pd
import yfinance as yf
from kiteconnect.exceptions import (
    InputException,
    OrderException,
    PermissionException,
    TokenException,
)

from brokers.kite import analysis as kite
from shared import storage as secure_storage

JOURNAL = Path(kite.INDIA_STOCKS_DIR) / "kite_rebalances.json"
TERMINAL = {"COMPLETE", "REJECTED", "CANCELLED"}
TTL = timedelta(minutes=2)


def number(value):
    try:
        result = Decimal(str(value))
    except InvalidOperation:
        raise ValueError("Invalid number in rebalance.")
    if not result.is_finite():
        raise ValueError("Quantities and amounts must be finite.")
    return result


def quantity(value):
    result = number(value)
    if result < 0 or result != result.to_integral_value():
        raise ValueError("Enter non-negative whole-share quantities.")
    return int(result)


@contextmanager
def lock():
    JOURNAL.parent.mkdir(parents=True, exist_ok=True)
    with JOURNAL.with_suffix(".lock").open("a") as file:
        fcntl.flock(file, fcntl.LOCK_EX)
        try:
            yield
        finally:
            fcntl.flock(file, fcntl.LOCK_UN)


def records():
    return json.loads(secure_storage.read_text(JOURNAL)) if JOURNAL.exists() else {}


def save(batch):
    with lock():
        all_batches = records()
        all_batches[batch["id"]] = batch
        secure_storage.write_text(JOURNAL, json.dumps(all_batches, allow_nan=False))


def get(batch_id):
    with lock():
        return records().get(batch_id)


def permitted_call(label, call, *args):
    try:
        return call(*args)
    except PermissionException as exc:
        guidance = "Check the Kite app permissions and API credentials, then reconnect to Kite."
        raise ValueError(f"Kite denied access to {label}. {guidance}") from exc


def live_quotes(keys):
    """Latest unadjusted Yahoo intraday prices; never requires Kite market data."""
    quotes = {}
    for key in dict.fromkeys(keys):
        exchange, symbol = key.split(":", 1)
        suffix = {"NSE": ".NS", "BSE": ".BO"}.get(exchange)
        if suffix is None:
            raise ValueError(f"No Yahoo Finance mapping for {key}.")
        try:
            history = yf.Ticker(f"{symbol}{suffix}").history(
                period="5d", interval="1m", auto_adjust=False, actions=False, timeout=10
            )
            if history.empty:
                raise ValueError("No intraday prices returned.")
            history = history.sort_index()
            price = float(number(history["Close"].iloc[-1]))
            quoted_at = pd.Timestamp(history.index[-1])
            if quoted_at.tzinfo is None:
                raise ValueError("Quote timestamp has no timezone.")
            age = datetime.now(timezone.utc) - quoted_at.to_pydatetime()
            if price <= 0 or not timedelta(0) <= age <= timedelta(days=7):
                raise ValueError("Price is invalid or quote is outdated.")
        except Exception as exc:
            raise ValueError(
                f"Yahoo Finance price unavailable for {key}: {exc}"
            ) from exc
        quotes[key] = dict(
            last_price=price, quoted_at=quoted_at.isoformat(), source="Yahoo Finance"
        )
    return quotes


def account_state(client):
    profile = permitted_call("account profile", client.profile)
    return dict(
        user=profile["user_id"],
        holdings=permitted_call("holdings", client.holdings),
        orders=permitted_call("orders", client.orders),
        funds=float(
            number(permitted_call("equity funds", client.margins, "equity")["net"])
        ),
    )


def holding_map(state):
    result = {}
    for h in state["holdings"]:
        key = (h["exchange"], h["tradingsymbol"])
        result[key] = result.get(key, 0) + max(
            0, quantity(h.get("quantity", 0)) - quantity(h.get("used_quantity", 0))
        )
    return result


def editor_rows(view, state):
    held = holding_map(state)
    rows = []
    for row in view.to_dict("records"):
        key = (str(row["exchange"]), str(row["symbol"]))
        target = row.get("target_shares")
        current = held.get(key, 0)
        target = current if pd.isna(target) else quantity(target)
        rows.append(
            dict(
                symbol=key[1],
                exchange=key[0],
                status="New" if current == 0 else row["status"],
                current_shares=current,
                target_shares=target,
                sell_shares=max(0, current - target),
                buy_shares=max(0, target - current),
            )
        )
    return pd.DataFrame(rows)


def orders_from_editor(edited, original):
    allowed = {(r["exchange"], r["symbol"]) for r in original.to_dict("records")}
    result = []
    seen = set()
    for row in edited.to_dict("records"):
        key = (str(row["exchange"]), str(row["symbol"]))
        if (
            key not in allowed
            or key in seen
            or key[0] not in {"NSE", "BSE"}
            or not re.fullmatch(r"[A-Z0-9&.\-]+", key[1])
        ):
            raise ValueError(
                "Stock list changed or duplicated. Reopen the recommendation plan."
            )
        seen.add(key)
        sell, buy = quantity(row["sell_shares"]), quantity(row["buy_shares"])
        if sell and buy:
            raise ValueError(f"{key[1]} cannot buy and sell in the same rebalance.")
        if not (sell or buy):
            continue
        result.append(
            dict(
                exchange=key[0],
                tradingsymbol=key[1],
                transaction_type="SELL" if sell else "BUY",
                quantity=sell or buy,
                product="CNC",
                order_type="MARKET",
                validity="DAY",
            )
        )
    if seen != allowed:
        raise ValueError("Stocks cannot be added or removed from the editor.")
    if not result:
        raise ValueError("Enter at least one buy or sell quantity.")
    return sorted(
        result, key=lambda o: (o["transaction_type"] != "SELL", o["tradingsymbol"])
    )


def basket_changes(edited, quotes):
    """Describe the reviewed basket using its actual edited quantities and quote snapshot."""
    rows = []
    for row in edited.to_dict("records"):
        current = quantity(row["current_shares"])
        sell, buy = quantity(row["sell_shares"]), quantity(row["buy_shares"])
        after = current - sell + buy
        if after < 0 or (sell and buy):
            raise ValueError("Invalid basket quantities.")
        change = (
            "Add"
            if current == 0 and buy
            else "Remove"
            if current and after == 0
            else "Increase"
            if buy
            else "Reduce"
            if sell
            else "Keep"
        )
        quote = quotes.get(f"{row['exchange']}:{row['symbol']}")
        price = float(number(quote["last_price"] if quote else row.get("price_inr", 0)))
        rows.append(
            dict(
                stock=row["symbol"],
                exchange=row["exchange"],
                change=change,
                current_shares=current,
                target_shares=after,
                sell_shares=sell,
                buy_shares=buy,
                estimated_value_inr=after * price,
            )
        )
    result = pd.DataFrame(rows)
    total = result["estimated_value_inr"].sum()
    result["target_weight_pct"] = (
        result["estimated_value_inr"] / total * 100 if total else 0.0
    )
    return result


def validate_holdings(planned, state):
    held = holding_map(state)
    for order in planned:
        key = (order["exchange"], order["tradingsymbol"])
        if any(
            (o.get("exchange"), o.get("tradingsymbol")) == key
            and o.get("status") not in TERMINAL
            for o in state["orders"]
        ):
            raise ValueError(
                f"An order is already pending for {key[1]}. Check Kite first."
            )
        if order["transaction_type"] == "SELL" and order["quantity"] > held.get(key, 0):
            raise ValueError(
                f"Sell quantity for {key[1]} exceeds available settled holdings."
            )


def buy_margin(client, planned):
    buys = [
        {**o, "variety": "regular"} for o in planned if o["transaction_type"] == "BUY"
    ]
    if not buys:
        return 0.0
    response = client.order_margins(buys)
    if len(response) != len(buys):
        raise ValueError("Kite margin estimate is incomplete.")
    total = 0.0
    for row in response:
        required = number(row["total"])
        if required < 0:
            raise ValueError("Unexpected buy margin estimate.")
        total += float(required) + float(
            number((row.get("charges") or {}).get("total", 0))
        )
    return total


def review(client, edited, original):
    planned = orders_from_editor(edited, original)
    state = account_state(client)
    validate_holdings(planned, state)
    quotes = live_quotes([f"{o['exchange']}:{o['tradingsymbol']}" for o in planned])
    sell_value = buy_value = 0.0
    for order in planned:
        quote = quotes[f"{order['exchange']}:{order['tradingsymbol']}"]
        price = float(number(quote["last_price"]))
        if price <= 0:
            raise ValueError("A current price is unavailable.")
        value = price * order["quantity"]
        if order["transaction_type"] == "SELL":
            sell_value += value
        else:
            buy_value += value
    required = buy_margin(client, planned)
    # This is only an estimate. Actual available funds are checked after sell fills.
    if required > state["funds"] + sell_value * 0.99:
        raise ValueError(
            "Edited buys exceed available funds plus estimated sale proceeds. Reduce buy quantities."
        )
    batch = dict(
        id=uuid4().hex,
        user=state["user"],
        orders=planned,
        status="review",
        results=[],
        reviewed_at=datetime.now(timezone.utc).isoformat(),
        estimated_buys=buy_value,
        estimated_sells=sell_value,
        required_buy_margin=required,
        available_funds=state["funds"],
        price_source="Yahoo Finance",
        quotes=quotes,
    )
    save(batch)
    return batch


def submit(client, batch_id, acknowledged=False):
    if acknowledged is not True:
        raise ValueError("Confirm the edited rebalance first.")
    with lock():
        all_batches = records()
        batch = all_batches[batch_id]
        if batch["status"] != "review":
            raise ValueError(
                "This rebalance was already confirmed; check order status."
            )
        age = datetime.now(timezone.utc) - datetime.fromisoformat(batch["reviewed_at"])
        if not timedelta(0) <= age <= TTL:
            raise ValueError(
                "Rebalance review expired. Review edited quantities again."
            )
        if any(
            b["user"] == batch["user"] and b["status"] in {"submitting", "unknown"}
            for b in all_batches.values()
        ):
            raise ValueError(
                "An earlier rebalance is unresolved. Check Kite before submitting."
            )
        state = account_state(client)
        if state["user"] != batch["user"]:
            raise ValueError("Connected Kite account changed.")
        validate_holdings(batch["orders"], state)
        batch["status"] = "submitting"
        all_batches[batch_id] = batch
        secure_storage.write_text(JOURNAL, json.dumps(all_batches, allow_nan=False))
    for index, order in enumerate(batch["orders"]):
        started = False
        try:
            if order["transaction_type"] == "BUY":
                remaining = [
                    o for o in batch["orders"][index:] if o["transaction_type"] == "BUY"
                ]
                if buy_margin(client, remaining) > float(
                    number(client.margins("equity")["net"])
                ):
                    raise ValueError(
                        "Available Kite funds cannot cover remaining buys; these orders were not sent."
                    )
            tag = "rb" + batch["id"][:14] + str(index)
            result = dict(
                symbol=order["tradingsymbol"],
                side=order["transaction_type"],
                quantity=order["quantity"],
                tag=tag,
                status="submitting",
            )
            batch["results"].append(result)
            save(batch)
            started = True
            order_id = client.place_order(
                variety="regular", market_protection=-1, tag=tag, **order
            )
            if not order_id:
                raise RuntimeError("Kite returned no order identifier.")
            result.update(order_id=str(order_id), status="submitted")
            save(batch)
            # Continue only after each order's fill is confirmed. Pending orders remain in Kite.
            for attempt in range(5):
                history = client.order_history(order_id)
                last = history[-1] if history else {}
                status = last.get("status")
                if status in TERMINAL:
                    break
                if attempt < 4:
                    time.sleep(1)
            result["broker_status"] = status
            if status != "COMPLETE":
                result["status"] = (
                    "rejected"
                    if status == "REJECTED"
                    else "pending"
                    if status not in TERMINAL
                    else "cancelled"
                )
                batch.update(
                    status="stopped",
                    error="Order not fully filled. Remaining orders were not sent. Check Kite before a new rebalance.",
                )
                save(batch)
                break
            result["status"] = "filled"
            save(batch)
        except Exception as exc:
            # Ambiguous placement is never repeated. The tag supports manual reconciliation.
            if (
                started
                and not batch["results"][-1].get("order_id")
                and isinstance(
                    exc,
                    (
                        InputException,
                        OrderException,
                        PermissionException,
                        TokenException,
                    ),
                )
            ):
                batch["results"][-1]["status"] = "rejected"
                batch["status"] = "stopped"
            elif started and not batch["results"][-1].get("order_id"):
                batch["results"][-1]["status"] = "unknown"
                batch["status"] = "unknown"
            else:
                batch["status"] = "stopped"
            batch["error"] = str(exc)
            save(batch)
            break
    else:
        batch["status"] = "completed"
        save(batch)
    return batch


def refresh_status(client, batch_id):
    batch = get(batch_id)
    if batch is None:
        raise ValueError("Rebalance record is missing. Check Kite order activity.")
    if client.profile()["user_id"] != batch["user"]:
        raise ValueError("Connected account changed.")
    broker = client.orders()
    unresolved = False
    for result in batch["results"]:
        match = next(
            (
                o
                for o in broker
                if (result.get("order_id") and o.get("order_id") == result["order_id"])
                or (result.get("tag") and o.get("tag") == result["tag"])
            ),
            None,
        )
        if match:
            result.update(
                order_id=match["order_id"],
                broker_status=match["status"],
                status="filled"
                if match["status"] == "COMPLETE"
                else "rejected"
                if match["status"] == "REJECTED"
                else "cancelled"
                if match["status"] == "CANCELLED"
                else "pending",
            )
        if result["status"] == "unknown":
            unresolved = True
    if batch["status"] == "unknown" and not unresolved:
        batch["status"] = "stopped"
    if len(batch["results"]) == len(batch["orders"]) and all(
        r["status"] == "filled" for r in batch["results"]
    ):
        batch["status"] = "completed"
    save(batch)
    return batch
