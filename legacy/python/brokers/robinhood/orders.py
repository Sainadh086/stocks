"""Live equity tickets submitted only by an explicit dashboard button click.

The paper worker never imports or calls this module. Live submission requires
manual confirmation or the user's explicit auto-rebalance toggle for the session.
"""

import asyncio
import fcntl
import json
import re
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from decimal import Decimal, InvalidOperation
from uuid import uuid4

from jsonschema import validate

from brokers.robinhood import analysis as us_stocks
from brokers.robinhood import client as robinhood_mcp
from shared import storage as secure_storage

TICKETS_FILE = us_stocks.US_STOCKS_DIR / "live_order_tickets.json"
PREVIEW_TTL = timedelta(minutes=2)
ALLOWED = {
    "get_accounts",
    "get_portfolio",
    "get_equity_orders",
    "get_equity_positions",
    "get_equity_quotes",
    "review_equity_order",
    "place_equity_order",
}


class BrokerError(RuntimeError):
    """The broker explicitly rejected a request."""


class BrokerSession:
    def __init__(self, session, tools):
        self.session, self.tools = session, tools

    async def call(self, name, arguments):
        if name not in ALLOWED or name not in self.tools:
            raise ValueError(f"Robinhood tool {name} is unavailable.")
        validate(arguments, self.tools[name].inputSchema)
        result = await self.session.call_tool(name, arguments)
        if result.structuredContent is not None:
            payload = result.structuredContent
        else:
            blocks = [b.text for b in result.content if b.type == "text"]
            if len(blocks) != 1:
                raise RuntimeError("Robinhood returned an unreadable response.")
            try:
                payload = json.loads(blocks[0])
            except ValueError as exc:
                if result.isError:
                    raise BrokerError(blocks[0]) from exc
                raise RuntimeError(
                    "Robinhood returned an unreadable response; verify order status."
                ) from exc
        if result.isError or (isinstance(payload, dict) and payload.get("error")):
            raise BrokerError(json.dumps(payload))
        if not isinstance(payload, dict) or not isinstance(payload.get("data"), dict):
            raise RuntimeError("Robinhood returned no result data.")
        return payload

    async def rows(self, name, account, key):
        rows, seen = [], set()
        args = {"account_number": account}
        while True:
            payload = await self.call(name, args)
            page = payload["data"].get(key) or []
            if not isinstance(page, list):
                raise RuntimeError("Robinhood returned an invalid list.")
            rows.extend(row for row in page if row is not None)
            cursor = payload["data"].get("next")
            if not cursor:
                return rows
            if cursor in seen:
                raise RuntimeError("Robinhood repeated a pagination cursor.")
            seen.add(cursor)
            args["cursor"] = cursor


async def _connected(operation):
    from mcp import ClientSession, StdioServerParameters
    from mcp.client.stdio import stdio_client

    command, environment = robinhood_mcp.node_runtime()
    with secure_storage.oauth_environment(environment) as env:
        params = StdioServerParameters(
            command=command,
            env=env,
            args=[
                "-y",
                "mcp-remote",
                robinhood_mcp.ENDPOINT,
                "--transport",
                "http-only",
                "--silent",
            ],
        )
        async with stdio_client(params) as (read, write):
            async with ClientSession(read, write) as session:
                await session.initialize()
                tools, cursor = {}, None
                while True:
                    page = await session.list_tools(cursor=cursor)
                    tools.update(
                        {tool.name: tool for tool in page.tools if tool.name in ALLOWED}
                    )
                    cursor = page.nextCursor
                    if not cursor:
                        break
                return await operation(BrokerSession(session, tools))


def exception_leaves(error):
    if isinstance(error, BaseExceptionGroup):
        return [leaf for child in error.exceptions for leaf in exception_leaves(child)]
    return [error]


def run(operation):
    try:
        return asyncio.run(asyncio.wait_for(_connected(operation), timeout=90))
    except ExceptionGroup as exc:
        # MCP's async context managers wrap even ordinary application errors.
        # Preserve a single leaf's type, including definitive broker rejections.
        leaves = exception_leaves(exc)
        if len(leaves) == 1:
            raise leaves[0] from exc
        details = "; ".join(f"{type(leaf).__name__}: {leaf}" for leaf in leaves)
        raise RuntimeError(f"Robinhood connection failed: {details}") from exc
    except TimeoutError as exc:
        raise TimeoutError("Robinhood refresh timed out after 90 seconds.") from exc


async def trading_account(session, number):
    from brokers.robinhood.accounts import require_trading_role

    require_trading_role(number)
    payload = await session.call("get_accounts", {})
    account = next(
        (
            a
            for a in payload["data"].get("accounts", []) or []
            if a and a.get("account_number") == number
        ),
        None,
    )
    if not account or account.get("agentic_allowed") is not True:
        raise ValueError(
            "This account is not accessible for trading through this connection."
        )
    if (
        account.get("state") != "active"
        or account.get("deactivated")
        or account.get("permanently_deactivated")
    ):
        raise ValueError("This Robinhood account is not active.")
    return account


def list_trading_accounts():
    async def operation(session):
        payload = await session.call("get_accounts", {})
        return [
            a
            for a in payload["data"].get("accounts", []) or []
            if a
            and a.get("agentic_allowed") is True
            and a.get("state") == "active"
            and not a.get("deactivated")
            and not a.get("permanently_deactivated")
        ]

    return run(operation)


async def read_snapshot(session, number, symbols=()):
    portfolio = await session.call("get_portfolio", {"account_number": number})
    positions = await session.rows("get_equity_positions", number, "positions")
    equity_orders = await session.rows("get_equity_orders", number, "orders")
    wanted = list(dict.fromkeys([*symbols, *(p["symbol"] for p in positions)]))
    quotes = {}
    for start in range(0, len(wanted), 20):
        response = await session.call(
            "get_equity_quotes", {"symbols": wanted[start : start + 20]}
        )
        for result in response["data"].get("results", []) or []:
            if result and result.get("quote"):
                quote = result["quote"]
                # Robinhood results contain {quote: {symbol: ...}, close: ...}.
                symbol = quote.get("symbol") or result.get("symbol")
                if not symbol:
                    raise ValueError(
                        "Robinhood returned a quote without a ticker symbol."
                    )
                quotes[symbol] = quote
    return dict(
        portfolio=portfolio["data"],
        positions=positions,
        orders=equity_orders,
        quotes=quotes,
        account_number=number,
        updated_at=datetime.now(timezone.utc).isoformat(),
    )


def account_snapshot(number, symbols=()):
    async def operation(session):
        await trading_account(session, number)
        return await read_snapshot(session, number, symbols)

    return run(operation)


async def validate_strategy_ticket(session, ticket):
    if ticket.get("origin") != "strategy":
        return
    from brokers.robinhood import strategy as live_strategy

    if ticket.get("strategy") != live_strategy.STRATEGY:
        raise ValueError(
            "This preview uses an older strategy. Review a new intraday trade."
        )
    signals = live_strategy.signal_snapshot()
    account = ticket["arguments"]["account_number"]
    budget, reserve = live_strategy.saved_budget(account)
    ranked = live_strategy.selected_signals(signals)
    symbols = ranked.symbol.tolist() if not ranked.empty else []
    snapshot = await read_snapshot(session, account, symbols)
    others = [t for t in list_tickets(account) if t["id"] != ticket["id"]]
    model = live_strategy.build_actions(snapshot, signals, budget, reserve, others)
    args = ticket["arguments"]
    action = next(
        (
            a
            for a in model["actions"]
            if a["symbol"] == args["symbol"] and a["side"] == args["side"]
        ),
        None,
    )
    if not action or not action["enabled"]:
        raise ValueError(
            "This strategy action changed. Refresh the monitor and review the current decision."
        )
    field = "dollar_amount" if args["side"] == "buy" else "quantity"
    if live_strategy.amount(args[field]) > live_strategy.amount(action[field]):
        raise ValueError(
            "Available funds or sellable shares changed. Review the refreshed action."
        )


def positive_decimal(raw, label, places=6):
    try:
        value = Decimal(str(raw).strip())
    except InvalidOperation as exc:
        raise ValueError(f"Enter a positive {label}.") from exc
    if not value.is_finite() or value <= 0 or value.as_tuple().exponent < -places:
        raise ValueError(
            f"{label} must be positive with at most {places} decimal places."
        )
    return format(value, "f")


def order_arguments(
    account,
    symbol,
    side,
    order_type,
    amount_mode,
    amount,
    limit_price="",
    stop_price="",
    time_in_force="gfd",
):
    symbol = symbol.strip().upper()
    if not account or not re.fullmatch(r"[A-Z][A-Z0-9.-]{0,14}", symbol):
        raise ValueError("Choose an account and enter a valid ticker symbol.")
    if side not in {"buy", "sell"} or order_type not in {
        "market",
        "limit",
        "stop_market",
        "stop_limit",
    }:
        raise ValueError("Choose buy or sell and an order type.")
    if time_in_force not in {"gfd", "gtc"} or amount_mode not in {"Shares", "USD"}:
        raise ValueError("Choose a valid amount unit and time in force.")
    args = dict(
        account_number=account,
        symbol=symbol,
        side=side,
        type=order_type,
        time_in_force=time_in_force,
        market_hours="regular_hours",
    )
    if amount_mode == "USD":
        if order_type != "market" or side != "buy":
            raise ValueError(
                "USD amounts are supported here for market buys. Use shares for sells."
            )
        args["dollar_amount"] = positive_decimal(amount, "USD amount", 2)
    else:
        args["quantity"] = positive_decimal(amount, "share quantity")
        if order_type != "market" and Decimal(args["quantity"]) % 1:
            raise ValueError("Fractional shares require a market order.")
    if order_type in {"limit", "stop_limit"}:
        args["limit_price"] = positive_decimal(limit_price, "limit price", 2)
    if order_type in {"stop_market", "stop_limit"}:
        args["stop_price"] = positive_decimal(stop_price, "stop price", 2)
    return args


@contextmanager
def ticket_lock():
    TICKETS_FILE.parent.mkdir(parents=True, exist_ok=True)
    with TICKETS_FILE.with_suffix(".lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        try:
            yield
        finally:
            fcntl.flock(lock, fcntl.LOCK_UN)


def _tickets():
    return (
        json.loads(secure_storage.read_text(TICKETS_FILE))
        if TICKETS_FILE.exists()
        else {}
    )


def save_ticket(ticket):
    with ticket_lock():
        tickets = _tickets()
        tickets[ticket["id"]] = ticket
        secure_storage.write_text(TICKETS_FILE, json.dumps(tickets, allow_nan=False))


def get_ticket(ticket_id):
    with ticket_lock():
        return _tickets().get(ticket_id)


def get_tickets(ticket_ids):
    """Read a basket from one consistent snapshot of the encrypted ticket store."""
    with ticket_lock():
        tickets = _tickets()
        return {
            ticket_id: tickets[ticket_id]
            for ticket_id in ticket_ids
            if ticket_id in tickets
        }


async def check_sell_quantity(session, arguments):
    if arguments["side"] == "sell":
        positions = await session.rows(
            "get_equity_positions", arguments["account_number"], "positions"
        )
        held = sum(
            Decimal(str(p.get("shares_available_for_sells", p.get("quantity", "0"))))
            for p in positions
            if p.get("symbol") == arguments["symbol"]
        )
        if Decimal(arguments["quantity"]) > held:
            raise ValueError(
                "Sell quantity exceeds your current holdings. Short selling is not supported here."
            )


def preview_order(arguments):
    async def operation(session):
        await trading_account(session, arguments["account_number"])
        await check_sell_quantity(session, arguments)
        return await session.call("review_equity_order", arguments)

    result = run(operation)
    data = result["data"]
    if (
        data.get("symbol") != arguments["symbol"]
        or data.get("side") != arguments["side"]
        or data.get("type") != arguments["type"]
    ):
        raise ValueError("The broker preview does not match this order.")
    ticket = dict(
        id=str(uuid4()),
        arguments=dict(arguments),
        preview=data,
        reviewed_at=datetime.now(timezone.utc).isoformat(),
        status="preview",
    )
    save_ticket(ticket)
    return ticket


def submit_reviewed_order(ticket_id, acknowledged=False):
    """Submit after manual confirmation or explicit session auto-rebalance consent."""
    if acknowledged is not True:
        raise ValueError("Review and acknowledge the order before submitting.")
    with ticket_lock():
        tickets = _tickets()
        ticket = tickets[ticket_id]
        if ticket["status"] != "preview":
            raise ValueError(
                "This ticket has already been submitted. Check its status instead of submitting again."
            )
        reviewed = datetime.fromisoformat(ticket["reviewed_at"])
        age = datetime.now(timezone.utc) - reviewed
        if age < timedelta(0) or age > PREVIEW_TTL:
            raise ValueError(
                "This preview expired. Preview the order again before submitting."
            )
        if any(
            t["id"] != ticket_id
            and t["status"] in {"submitting", "unknown"}
            and t["arguments"]["account_number"]
            == ticket["arguments"]["account_number"]
            for t in tickets.values()
        ):
            raise ValueError(
                "Another order has an unresolved status. Check Robinhood before submitting a new order."
            )
        ticket["status"] = "submitting"
        tickets[ticket_id] = ticket
        secure_storage.write_text(TICKETS_FILE, json.dumps(tickets))
    placement_started = False

    async def operation(session):
        nonlocal placement_started
        await trading_account(session, ticket["arguments"]["account_number"])
        await check_sell_quantity(session, ticket["arguments"])
        await validate_strategy_ticket(session, ticket)
        age = datetime.now(timezone.utc) - datetime.fromisoformat(ticket["reviewed_at"])
        if age < timedelta(0) or age > PREVIEW_TTL:
            raise ValueError(
                "Preview expired while connecting. Preview the order again."
            )
        placement_started = True
        return await session.call(
            "place_equity_order", {**ticket["arguments"], "ref_id": ticket_id}
        )

    try:
        result = run(operation)
        ticket.update(status="submitted", result=result["data"])
    except BrokerError as exc:
        ticket.update(status="rejected", error=str(exc))
    except Exception as exc:
        # An interrupted response may still have created an order. Never retry automatically.
        ticket.update(
            status="unknown" if placement_started else "not_submitted",
            error=f"{type(exc).__name__}: {exc}",
        )
    save_ticket(ticket)
    return ticket


def reconcile_ticket(ticket_id):
    ticket = get_ticket(ticket_id)
    if not ticket:
        raise ValueError("Order ticket was not found.")

    async def operation(session):
        return await session.rows(
            "get_equity_orders", ticket["arguments"]["account_number"], "orders"
        )

    orders = run(operation)
    broker_id = (ticket.get("result", {}).get("order") or {}).get("id")
    match = next(
        (
            order
            for order in orders
            if (broker_id and order.get("id") == broker_id)
            or order.get("ref_id") == ticket_id
        ),
        None,
    )
    if match:
        ticket.update(status="submitted", result={"order": match})
        ticket.pop("error", None)
        save_ticket(ticket)
    return ticket


def mask(value, account):
    """Keep full account identifiers out of displayed broker responses."""
    if isinstance(value, dict):
        return {
            k: (
                "••••" + str(v)[-4:]
                if "account_number" in k and v
                else mask(v, account)
            )
            for k, v in value.items()
        }
    if isinstance(value, list):
        return [mask(v, account) for v in value]
    return (
        value.replace(account, "••••" + account[-4:])
        if isinstance(value, str) and account
        else value
    )


def list_tickets(account):
    with ticket_lock():
        return sorted(
            (
                t
                for t in _tickets().values()
                if t["arguments"]["account_number"] == account
            ),
            key=lambda t: t["reviewed_at"],
            reverse=True,
        )
