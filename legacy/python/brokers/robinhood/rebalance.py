"""User-confirmed batches of existing strategy orders; no automatic retries."""

import threading
from datetime import datetime, timedelta, timezone
from uuid import uuid4

from brokers.robinhood import orders
from brokers.robinhood import strategy as live_strategy

_SUBMIT_LOCK = threading.Lock()


def eligible_actions(model):
    actions = [
        a for a in model["actions"] if a["enabled"] and a["action"] in {"BUY", "EXIT"}
    ]
    if len({a["symbol"] for a in actions}) != len(actions):
        raise ValueError("Duplicate stock decisions; refresh the monitor.")
    return sorted(actions, key=lambda a: (a["side"] != "sell", a["symbol"]))


def prepare(account, model, signals):
    actions = eligible_actions(model)
    if not actions:
        raise ValueError("No eligible buys or sells at this time.")
    batch = dict(id=str(uuid4()), account=account, ticket_ids=[], status="preview")
    for action in actions:
        ticket = orders.preview_order(live_strategy.prepared_arguments(account, action))
        ticket.update(
            origin="strategy", signal_time=signals.get("asof"), rebalance_id=batch["id"]
        )
        ticket.update(
            strategy=live_strategy.STRATEGY,
            stop=action.get("stop"),
            target=action.get("target"),
        )
        orders.save_ticket(ticket)
        batch["ticket_ids"].append(ticket["id"])
    return batch


def validate(batch, model, now=None):
    now = now or datetime.now(timezone.utc)
    if batch["status"] != "preview":
        raise ValueError("This rebalance has already been confirmed.")
    actions = {(a["symbol"], a["side"]): a for a in eligible_actions(model)}
    tickets = []
    for ticket_id in batch["ticket_ids"]:
        ticket = orders.get_ticket(ticket_id)
        if (
            not ticket
            or ticket["status"] != "preview"
            or ticket.get("rebalance_id") != batch["id"]
        ):
            raise ValueError("A rebalance ticket is unavailable or already submitted.")
        args = ticket["arguments"]
        if args["account_number"] != batch["account"]:
            raise ValueError("Rebalance account changed.")
        age = now - datetime.fromisoformat(ticket["reviewed_at"])
        if age.total_seconds() < 0 or age > orders.PREVIEW_TTL:
            raise ValueError(
                "Rebalance quotes expired. Close this popup and click Rebalance again."
            )
        action = actions.get((args["symbol"], args["side"]))
        field = "dollar_amount" if args["side"] == "buy" else "quantity"
        if not action or live_strategy.amount(args[field]) > live_strategy.amount(
            action[field]
        ):
            raise ValueError(
                "Funds, holdings or strategy decisions changed. Review a new rebalance."
            )
        tickets.append(ticket)
    if not tickets:
        raise ValueError("Empty rebalance.")
    return tickets


ACTIVE = {"running", "waiting_sales", "waiting_buys", "waiting_funds"}


def submit(batch, model, acknowledged=False, model_provider=None, on_progress=None):
    if acknowledged is not True:
        raise ValueError("Confirm the rebalance before submitting.")
    with _SUBMIT_LOCK:
        tickets = sorted(
            validate(batch, model),
            key=lambda t: (t["arguments"]["side"] != "sell", t["arguments"]["symbol"]),
        )
        batch.update(
            status="running",
            results=[],
            ordered_ids=[t["id"] for t in tickets],
            confirmed_at=datetime.now(timezone.utc).isoformat(),
            progress="Starting confirmed rebalance…",
        )
        return _advance(batch, model_provider, on_progress)


def advance(batch, model_provider=None, on_progress=None):
    """Resume the already-confirmed sequence; reconcile submitted orders, never resend."""
    with _SUBMIT_LOCK:
        if batch["status"] not in ACTIVE:
            return batch
        return _advance(batch, model_provider, on_progress)


def _advance(batch, model_provider, on_progress=None):
    def notify():
        if on_progress:
            on_progress(batch)

    try:
        notify()
        # An existing order can remain pending for minutes. Keep checking its fill.
        if batch["results"] and batch["results"][-1]["status"] == "pending":
            row = batch["results"][-1]
            receipt = orders.reconcile_ticket(row["id"])
            state = (receipt.get("result", {}).get("order") or {}).get("state")
            row["broker_state"] = state
            if state in {"rejected", "failed", "cancelled"}:
                batch.update(
                    status="stopped",
                    error=f"{row['symbol']} order {state}. Remaining orders were not sent.",
                )
                return batch
            if state != "filled":
                batch.update(
                    status="waiting_sales" if row["side"] == "sell" else "waiting_buys",
                    progress=f"Waiting for {row['side'].upper()} {row['symbol']} to fill ({state or 'status pending'})…",
                )
                return batch
            row["status"] = "filled"
            notify()
        while len(batch["results"]) < len(batch["ordered_ids"]):
            ticket_id = batch["ordered_ids"][len(batch["results"])]
            ticket = orders.get_ticket(ticket_id)
            if not ticket or ticket["status"] != "preview":
                raise ValueError(
                    "An unsent order is no longer available for this confirmed rebalance."
                )
            age = datetime.now(timezone.utc) - datetime.fromisoformat(
                ticket["reviewed_at"]
            )
            if not timedelta(0) <= age <= orders.PREVIEW_TTL:
                raise ValueError(
                    "An unsent quote expired while waiting. Remaining orders were not sent; review new quotes."
                )
            args = ticket["arguments"]
            if args["side"] == "buy" and model_provider:
                batch["progress"] = f"Checking buying power for {args['symbol']}…"
                notify()
                actual = model_provider()
                action = next(
                    (
                        a
                        for a in actual["actions"]
                        if a["symbol"] == args["symbol"] and a["side"] == "buy"
                    ),
                    None,
                )
                if (
                    not action
                    or not action["enabled"]
                    or live_strategy.amount(action.get("dollar_amount"))
                    < live_strategy.amount(args["dollar_amount"])
                ):
                    batch.update(
                        status="waiting_funds",
                        progress=f"Waiting to buy {args['symbol']}: {action.get('reason', 'available amount is below the reviewed buy') if action and not action['enabled'] else 'available amount is below the reviewed buy'}",
                    )
                    return batch
            batch.update(
                status="running",
                progress=f"Submitting {args['side'].upper()} {args['symbol']}…",
            )
            notify()
            # Existing per-ticket persistence marks placement before contacting the broker.
            receipt = orders.submit_reviewed_order(ticket_id, acknowledged=True)
            state = (receipt.get("result", {}).get("order") or {}).get("state")
            row = dict(
                id=ticket_id,
                symbol=args["symbol"],
                side=args["side"],
                status="filled" if state == "filled" else "pending",
                broker_state=state,
            )
            batch["results"].append(row)
            notify()
            if receipt["status"] != "submitted" or state in {
                "rejected",
                "failed",
                "cancelled",
            }:
                row["status"] = receipt["status"]
                batch.update(
                    status="stopped",
                    error=receipt.get(
                        "error",
                        "Order failed or is unresolved. Remaining orders were not sent.",
                    ),
                )
                return batch
            if state != "filled":
                batch.update(
                    status="waiting_sales"
                    if args["side"] == "sell"
                    else "waiting_buys",
                    progress=f"Waiting for {args['side'].upper()} {args['symbol']} to fill…",
                )
                return batch
        batch.update(status="completed", progress="Orders are successfully executed.")
    except Exception as exc:
        batch.update(status="stopped", error=str(exc))
    notify()
    return batch


def refresh(batch):
    """Check existing orders only; never resume or retry unsent orders."""
    for row in batch.get("results", []):
        if row["status"] == "filled":
            continue
        ticket = orders.reconcile_ticket(row["id"])
        state = (ticket.get("result", {}).get("order") or {}).get("state")
        row["broker_state"] = state
        if state == "filled":
            row["status"] = "filled"
    if len(batch.get("results", [])) == len(batch["ticket_ids"]) and all(
        r["status"] == "filled" for r in batch["results"]
    ):
        batch["status"] = "completed"
    return batch


def new_auto_state(account):
    return dict(account=account, enabled=False, last_check=None, error=None)


def disable_auto(state, batch=None):
    state["enabled"] = False
    if batch and batch.get("automatic") and batch["status"] in ACTIVE:
        batch.update(
            status="stopped",
            error="Auto rebalance switched off. Remaining orders were not sent; orders already submitted stay with Robinhood.",
        )


def tick_auto(state, account, decisions, batch=None, now=None):
    """Use fresh decisions and existing broker validation for every automatic batch."""
    if not state.get("enabled") or state["account"] != account:
        return batch
    now = now or datetime.now(timezone.utc)
    checked = state.get("last_check")
    if checked and now - datetime.fromisoformat(checked) < timedelta(seconds=15):
        return batch
    state["last_check"] = now.isoformat()
    try:
        if batch and batch["account"] == account and batch["status"] in ACTIVE:
            # Manual batches continue through their own confirmation/progress flow.
            if not batch.get("automatic"):
                return batch
            advance(batch, model_provider=lambda: decisions(account)[0])
        else:
            model, signals = decisions(account)
            if not eligible_actions(model):
                return batch
            batch = prepare(account, model, signals)
            batch["automatic"] = True
            state["batch"] = batch
            current, _ = decisions(account)
            submit(
                batch,
                current,
                acknowledged=True,
                model_provider=lambda: decisions(account)[0],
            )
        if batch["status"] == "stopped":
            state["error"] = batch.get(
                "error", "Automatic rebalance stopped. Review order status."
            )
            disable_auto(state)
    except Exception as exc:
        state["error"] = str(exc)
        disable_auto(state)
        if batch and batch.get("automatic") and batch["status"] == "preview":
            batch.update(status="stopped", error=str(exc))
    return batch
