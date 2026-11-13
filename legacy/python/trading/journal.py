"""Shared paper-only fills, trade journal, trading costs, and equity accounting."""

import math
from copy import deepcopy
from datetime import datetime, timezone
from uuid import uuid4

DEFAULT_COSTS = {"fee_bps": 1.0, "spread_bps": 5.0, "slippage_bps": 2.0}


def upgrade(account):
    state = deepcopy(account)
    if state.get("journal_version") == 2:
        return state
    state.update(
        journal_version=2,
        closed_trades=state.get("closed_trades", []),
        equity_history=state.get("equity_history", []),
        simulated_costs=state.get("simulated_costs", 0.0),
        cost_model=state.get("cost_model", dict(DEFAULT_COSTS)),
    )
    state.setdefault("journal_started_at", datetime.now(timezone.utc).isoformat())
    state.setdefault("equity_peak", float(state["budget"]))
    state.setdefault("max_drawdown_usd", 0.0)
    state.setdefault("max_drawdown_pct", 0.0)
    for symbol, position in state["positions"].items():
        position.setdefault("trade_id", str(uuid4()))
        position.setdefault(
            "entry_reason", "Imported holding; original entry rationale unavailable"
        )
        position.setdefault("entry_time", None)
        position.setdefault(
            "entry_reference_price", position["cost"] / position["quantity"]
        )
        position.setdefault("entry_price", position["cost"] / position["quantity"])
        position.setdefault("entry_costs", 0.0)
        position.setdefault("entry_fees", 0.0)
        position.setdefault("stop", None)
        position.setdefault("target", None)
        position.setdefault("history_incomplete", True)
    return state


def execution(reference, quantity, side, costs):
    if (
        not math.isfinite(reference)
        or reference <= 0
        or not math.isfinite(quantity)
        or quantity <= 0
    ):
        raise ValueError("Paper fills need finite, positive prices and quantities.")
    if side not in {"BUY", "SELL"}:
        raise ValueError("Unknown paper fill side.")
    for value in costs.values():
        if not math.isfinite(value) or value < 0 or value >= 1000:
            raise ValueError(
                "Simulated costs must be finite and between 0 and 1000 basis points."
            )
    direction = 1 if side == "BUY" else -1
    spread = reference * quantity * costs["spread_bps"] / 20000
    slip = reference * quantity * costs["slippage_bps"] / 10000
    price = reference * (
        1 + direction * (costs["spread_bps"] / 2 + costs["slippage_bps"]) / 10000
    )
    value = price * quantity
    fee = value * costs["fee_bps"] / 10000
    return dict(
        price=price,
        value=value,
        fee=fee,
        spread_cost=spread,
        slippage_cost=slip,
        total_cost=fee + spread + slip,
        reference_price=reference,
    )


def equity(state):
    return state["cash"] + sum(
        p["quantity"] * p["price"] for p in state["positions"].values()
    )


def mark(state, timestamp):
    value = equity(state)
    peak = max(state.get("equity_peak", state["budget"]), value)
    drawdown = max(0.0, peak - value)
    pct = drawdown / peak * 100 if peak > 0 else 0.0
    state.update(
        equity_peak=peak,
        drawdown_usd=drawdown,
        drawdown_pct=pct,
        max_drawdown_usd=max(state.get("max_drawdown_usd", 0), drawdown),
        max_drawdown_pct=max(state.get("max_drawdown_pct", 0), pct),
    )
    point = dict(
        timestamp=timestamp,
        equity=value,
        cash=state["cash"],
        drawdown_usd=drawdown,
        drawdown_pct=pct,
        realized_pnl=state.get("realized_pnl", 0),
        simulated_costs=state["simulated_costs"],
    )
    history = state["equity_history"]
    if history and history[-1]["timestamp"] == timestamp:
        history[-1] = point
    else:
        history.append(point)
    return state


def buy(
    state, symbol, reference, quantity, timestamp, reason, stop, target, **metadata
):
    if symbol in state["positions"]:
        raise ValueError("A paper position already exists for this symbol.")
    fill = execution(reference, quantity, "BUY", state["cost_model"])
    cost = fill["value"] + fill["fee"]
    if cost > state["cash"] + 1e-8:
        raise ValueError("Paper order including costs exceeds cash.")
    if not (0 < stop < fill["price"] < target):
        raise ValueError("A long paper trade requires stop < entry < target.")
    trade_id = str(uuid4())
    state["cash"] -= cost
    state["simulated_costs"] += fill["total_cost"]
    state["positions"][symbol] = dict(
        quantity=quantity,
        cost=cost,
        price=reference,
        entry_time=timestamp,
        entry_reason=reason,
        entry_price=fill["price"],
        entry_reference_price=reference,
        entry_costs=fill["total_cost"],
        entry_fees=fill["fee"],
        stop=stop,
        target=target,
        trade_id=trade_id,
        quote_time=timestamp,
        planned_risk_usd=quantity * (fill["price"] - stop),
        **metadata,
    )
    state["fills"].append(
        dict(
            timestamp=timestamp,
            symbol=symbol,
            side="BUY",
            quantity=quantity,
            price=fill["price"],
            reference_price=reference,
            value=fill["value"],
            fees=fill["fee"],
            spread_cost=fill["spread_cost"],
            slippage_cost=fill["slippage_cost"],
            simulated_cost=fill["total_cost"],
            reason=reason,
            entry_reason=reason,
            stop=stop,
            target=target,
            trade_id=trade_id,
            realized_pnl=None,
        )
    )
    return state


def sell(state, symbol, reference, timestamp, reason):
    position = state["positions"][symbol]
    fill = execution(reference, position["quantity"], "SELL", state["cost_model"])
    proceeds = fill["value"] - fill["fee"]
    net = proceeds - position["cost"]
    gross = position["quantity"] * (reference - position["entry_reference_price"])
    total_cost = position["entry_costs"] + fill["total_cost"]
    state["cash"] += proceeds
    state["realized_pnl"] = state.get("realized_pnl", 0) + net
    state["simulated_costs"] += fill["total_cost"]
    risk = position.get("planned_risk_usd")
    trade = dict(
        trade_id=position["trade_id"],
        symbol=symbol,
        quantity=position["quantity"],
        entry_time=position["entry_time"],
        exit_time=timestamp,
        entry_reason=position["entry_reason"],
        exit_reason=reason,
        entry_price=position["entry_price"],
        exit_price=fill["price"],
        entry_reference_price=position["entry_reference_price"],
        exit_reference_price=reference,
        stop=position["stop"],
        target=position["target"],
        gross_pnl=gross,
        realized_pnl=net,
        entry_costs=position["entry_costs"],
        exit_costs=fill["total_cost"],
        simulated_costs=total_cost,
        risk_usd=risk,
        r_multiple=net / risk if risk and risk > 0 else None,
        history_incomplete=position.get("history_incomplete", False),
    )
    state["closed_trades"].append(trade)
    state["fills"].append(
        dict(
            timestamp=timestamp,
            symbol=symbol,
            side="SELL",
            quantity=position["quantity"],
            price=fill["price"],
            reference_price=reference,
            value=fill["value"],
            realized_pnl=net,
            gross_pnl=gross,
            fees=fill["fee"],
            spread_cost=fill["spread_cost"],
            slippage_cost=fill["slippage_cost"],
            simulated_cost=fill["total_cost"],
            reason=reason,
            entry_reason=position["entry_reason"],
            stop=position["stop"],
            target=position["target"],
            trade_id=position["trade_id"],
        )
    )
    del state["positions"][symbol]
    return state


def summary(state):
    trades = state["closed_trades"]
    wins = [t["realized_pnl"] for t in trades if t["realized_pnl"] > 0]
    losses = [t["realized_pnl"] for t in trades if t["realized_pnl"] < 0]
    value = equity(state)
    return dict(
        initial_equity=state["budget"],
        final_equity=value,
        net_pnl=value - state["budget"],
        realized_pnl=state.get("realized_pnl", 0),
        simulated_costs=state["simulated_costs"],
        max_drawdown_usd=state["max_drawdown_usd"],
        max_drawdown_pct=state["max_drawdown_pct"],
        closed_trades=len(trades),
        win_rate_pct=len(wins) / len(trades) * 100 if trades else None,
        profit_factor=sum(wins) / abs(sum(losses)) if losses else None,
        average_net_trade=sum(t["realized_pnl"] for t in trades) / len(trades)
        if trades
        else None,
    )
