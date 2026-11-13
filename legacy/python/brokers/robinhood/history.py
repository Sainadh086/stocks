"""One row per buy order, with FIFO-linked exits and realized gross P&L."""

import math
from collections import defaultdict, deque

import pandas as pd

COLUMNS = [
    "Stock",
    "Status",
    "Shares bought",
    "Shares sold",
    "Shares remaining",
    "Buy time",
    "Sell time",
    "Buy price ($)",
    "Sell price ($)",
    "Profit/loss ($)",
]


def positive(raw):
    try:
        value = float(raw)
    except (TypeError, ValueError):
        return None
    return value if math.isfinite(value) and value > 0 else None


def fills(order):
    executions = order.get("executions") or []
    if executions:
        return [
            dict(
                quantity=positive(e.get("quantity")),
                price=positive(e.get("price")),
                time=e.get("timestamp") or e.get("settlement_date"),
            )
            for e in executions
        ]
    quantity = positive(order.get("cumulative_quantity"))
    # Use order quantity only when the broker confirms a full fill.
    if quantity is None and order.get("state") == "filled":
        quantity = positive(order.get("quantity"))
    return [
        dict(
            quantity=quantity,
            price=positive(order.get("average_price")),
            time=order.get("last_transaction_at") or order.get("updated_at"),
        )
    ]


def table(broker_orders, tickets=()):
    orders = {}
    for ticket in tickets:
        order = (ticket.get("result") or {}).get("order") or {}
        if order.get("id"):
            orders[order["id"]] = order
    for order in broker_orders:
        if order.get("id"):
            orders[order["id"]] = {**orders.get(order["id"], {}), **order}
    events = []
    pending = []
    for identifier, order in orders.items():
        valid = [f for f in fills(order) if f["quantity"] and f["price"]]
        if not valid:
            pending.append(
                dict(
                    Stock=order.get("symbol"),
                    Status=order.get("state", "Unknown"),
                    **{"Shares bought": 0, "Shares sold": 0, "Shares remaining": 0},
                )
            )
        for fill in valid:
            events.append(
                dict(
                    id=identifier,
                    symbol=order.get("symbol"),
                    side=order.get("side"),
                    **fill,
                )
            )
    events.sort(key=lambda e: (str(e["time"] or ""), e["side"] != "buy", e["id"]))
    rows = {}
    queues = defaultdict(deque)
    unmatched = {}
    for event in events:
        symbol = event["symbol"]
        qty = event["quantity"]
        price = event["price"]
        if event["side"] == "buy":
            row = rows.setdefault(
                event["id"],
                dict(
                    Stock=symbol,
                    Status="Holding",
                    **{
                        "Shares bought": 0.0,
                        "Shares sold": 0.0,
                        "Shares remaining": 0.0,
                        "Buy time": event["time"],
                        "Sell time": None,
                        "Buy price ($)": 0.0,
                        "Sell price ($)": None,
                        "Profit/loss ($)": None,
                    },
                    _cost=0.0,
                    _proceeds=0.0,
                    _basis=0.0,
                ),
            )
            row["Shares bought"] += qty
            row["Shares remaining"] += qty
            row["_cost"] += qty * price
            row["Buy price ($)"] = row["_cost"] / row["Shares bought"]
            queues[symbol].append(dict(row=row, remaining=qty, price=price))
        elif event["side"] == "sell":
            while qty > 1e-9 and queues[symbol]:
                lot = queues[symbol][0]
                matched = min(qty, lot["remaining"])
                row = lot["row"]
                row["Shares sold"] += matched
                row["Shares remaining"] -= matched
                row["_proceeds"] += matched * price
                row["_basis"] += matched * lot["price"]
                row["Sell price ($)"] = row["_proceeds"] / row["Shares sold"]
                row["Sell time"] = event["time"]
                row["Profit/loss ($)"] = row["_proceeds"] - row["_basis"]
                row["Status"] = (
                    "Closed" if row["Shares remaining"] < 1e-9 else "Partially sold"
                )
                lot["remaining"] -= matched
                qty -= matched
                if lot["remaining"] < 1e-9:
                    queues[symbol].popleft()
            if qty > 1e-9:
                row = unmatched.setdefault(
                    event["id"],
                    dict(
                        Stock=symbol,
                        Status="Sell · entry unavailable",
                        **{
                            "Shares bought": None,
                            "Shares sold": 0.0,
                            "Shares remaining": None,
                            "Buy time": None,
                            "Sell time": None,
                            "Buy price ($)": None,
                            "Sell price ($)": None,
                            "Profit/loss ($)": None,
                        },
                        _proceeds=0.0,
                    ),
                )
                row["Shares sold"] += qty
                row["_proceeds"] += qty * price
                row["Sell price ($)"] = row["_proceeds"] / row["Shares sold"]
                row["Sell time"] = event["time"]
    frame = pd.DataFrame(
        [*rows.values(), *unmatched.values(), *pending], columns=COLUMNS
    )
    for column in ["Buy time", "Sell time"]:
        times = pd.to_datetime(frame[column], utc=True, errors="coerce")
        frame[column] = (
            times.dt.tz_convert("America/Chicago")
            .dt.strftime("%b %d, %Y %I:%M:%S %p %Z")
            .fillna("—")
        )
    return frame.iloc[::-1].reset_index(drop=True)


def pnl_style(value):
    if pd.isna(value) or value == 0:
        return ""
    return "color: #15803d" if value > 0 else "color: #dc2626"


def paper_table(state):
    rows = []
    for trade in state.get("closed_trades", []):
        qty = trade["quantity"]
        rows.append(
            dict(
                Stock=trade["symbol"],
                Status="Closed",
                **{
                    "Shares bought": qty,
                    "Shares sold": qty,
                    "Shares remaining": 0,
                    "Buy time": trade.get("entry_time"),
                    "Sell time": trade.get("exit_time"),
                    "Buy price ($)": trade.get("entry_price"),
                    "Sell price ($)": trade.get("exit_price"),
                    "Profit/loss ($)": trade.get("realized_pnl"),
                },
            )
        )
    for symbol, position in state.get("positions", {}).items():
        qty = position["quantity"]
        rows.append(
            dict(
                Stock=symbol,
                Status="Holding · unrealized",
                **{
                    "Shares bought": qty,
                    "Shares sold": 0,
                    "Shares remaining": qty,
                    "Buy time": position.get("entry_time"),
                    "Sell time": None,
                    "Buy price ($)": position.get(
                        "entry_price", position["cost"] / qty
                    ),
                    "Sell price ($)": None,
                    "Profit/loss ($)": qty * position["price"] - position["cost"],
                },
            )
        )
    if not rows:
        legacy = [
            dict(
                id=str(i),
                symbol=f["symbol"],
                side=f["side"].lower(),
                state="filled",
                quantity=f["quantity"],
                average_price=f["price"],
                last_transaction_at=f["timestamp"],
            )
            for i, f in enumerate(state.get("fills", []))
        ]
        return table(legacy)
    frame = pd.DataFrame(rows, columns=COLUMNS)
    for column in ["Buy time", "Sell time"]:
        times = pd.to_datetime(frame[column], utc=True, errors="coerce")
        frame[column] = (
            times.dt.tz_convert("America/Chicago")
            .dt.strftime("%b %d, %Y %I:%M:%S %p %Z")
            .fillna("—")
        )
    return frame.iloc[::-1].reset_index(drop=True)
