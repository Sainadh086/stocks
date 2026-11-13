"""Read holdings through Robinhood MCP, using mcp-remote for browser OAuth."""

import asyncio
import json
import math
import os
import re
import shutil
from datetime import datetime, timezone

import pandas as pd

from brokers.robinhood import accounts
from brokers.robinhood import analysis as us_stocks
from shared import storage as secure_storage
from shared.paths import NODE_BIN

ENDPOINT = "https://agent.robinhood.com/mcp/trading"
CONNECTION_FILE = us_stocks.ROBINHOOD_CONNECTION_FILE
HOLDINGS_FILE = us_stocks.ROBINHOOD_HOLDINGS_CSV


def node_runtime():
    """Find project Node before PATH, including for an already running dashboard."""
    local_bin = NODE_BIN
    environment = os.environ.copy()
    environment["PATH"] = os.pathsep.join((str(local_bin), environment.get("PATH", "")))
    command = shutil.which("npx", path=environment["PATH"])
    if not command or not shutil.which("node", path=environment["PATH"]):
        raise RuntimeError("Install Node.js (with npx) to connect to Robinhood.")
    return command, environment


def private_write(path, content):
    secure_storage.write_text(path, content)


def connection():
    try:
        saved = json.loads(secure_storage.read_text(CONNECTION_FILE))
        return (
            saved if saved.get("endpoint") == ENDPOINT and saved.get("tool") else None
        )
    except (OSError, ValueError, AttributeError):
        return None


def sync_due(now=None):
    saved = connection()
    if not saved or saved.get("tool") != "get_equity_positions":
        return False
    try:
        previous = datetime.fromisoformat(saved["last_synced_at"])
        return (
            previous.astimezone(us_stocks.MARKET_TIMEZONE).date()
            < (now or datetime.now(timezone.utc))
            .astimezone(us_stocks.MARKET_TIMEZONE)
            .date()
        )
    except (KeyError, TypeError, ValueError):
        return True


async def _request(saved=None):
    from jsonschema import validate
    from mcp import ClientSession, StdioServerParameters
    from mcp.client.stdio import stdio_client

    command, environment = node_runtime()
    with secure_storage.oauth_environment(environment) as environment:
        parameters = StdioServerParameters(
            command=command,
            env=environment,
            args=["-y", "mcp-remote", ENDPOINT, "--transport", "http-only", "--silent"],
        )
        async with stdio_client(parameters) as (read, write):
            async with ClientSession(read, write) as session:
                await session.initialize()
                available = []
                cursor = None
                while True:
                    page = await session.list_tools(cursor=cursor)
                    available.extend(page.tools)
                    cursor = page.nextCursor
                    if not cursor:
                        break
                # The dashboard never invokes unannotated or mutating tools.
                readable = [
                    tool
                    for tool in available
                    if tool.annotations and tool.annotations.readOnlyHint is True
                ]
                if saved is None:
                    if not readable:
                        raise RuntimeError(
                            "Robinhood advertised no read-only tools. Holdings sync is unavailable."
                        )
                    return [tool.model_dump(mode="json") for tool in readable]
                tool = next(
                    (tool for tool in readable if tool.name == saved["tool"]), None
                )
                if tool is None:
                    raise RuntimeError(
                        "Saved holdings tool is unavailable or no longer marked read-only. Reconnect."
                    )
                validate(saved["arguments"], tool.inputSchema)
                arguments = dict(saved["arguments"])
                positions = []
                seen_cursors = set()
                while True:
                    result = await session.call_tool(tool.name, arguments)
                    if result.isError:
                        raise RuntimeError(
                            "Robinhood tool returned an error; existing holdings preserved."
                        )
                    if result.structuredContent is not None:
                        payload = result.structuredContent
                    else:
                        blocks = [
                            block.text
                            for block in result.content
                            if block.type == "text"
                        ]
                        if len(blocks) != 1:
                            raise ValueError(
                                "Expected structured data or one JSON text block."
                            )
                        payload = json.loads(blocks[0])
                    if tool.name != "get_equity_positions":
                        return payload
                    page = payload["data"].get("positions") or []
                    if not isinstance(page, list):
                        raise ValueError(
                            "Robinhood returned an invalid positions list."
                        )
                    positions.extend(page)
                    cursor = payload["data"].get("next")
                    if not cursor:
                        payload["data"]["positions"] = positions
                        return payload
                    if cursor in seen_cursors:
                        raise ValueError(
                            "Robinhood repeated a pagination cursor; sync stopped."
                        )
                    seen_cursors.add(cursor)
                    arguments["cursor"] = cursor


def discover_tools():
    return asyncio.run(_request())


def list_accounts():
    payload = asyncio.run(_request({"tool": "get_accounts", "arguments": {}}))
    return [
        account
        for account in payload["data"]["accounts"]
        if not account.get("deactivated") and not account.get("permanently_deactivated")
    ]


def connect_account(account_number):
    if not isinstance(account_number, str) or not account_number:
        raise ValueError("Select a Robinhood account first.")
    saved = dict(
        endpoint=ENDPOINT,
        tool="get_equity_positions",
        arguments={"account_number": account_number},
        positions_path="data.positions",
        symbol_path="symbol",
        quantity_path="quantity",
    )
    return sync_holdings(saved)


def configure(tool, arguments, positions_path, symbol_path, quantity_path):
    parsed = json.loads(arguments)
    if not isinstance(parsed, dict) or not tool or not symbol_path or not quantity_path:
        raise ValueError(
            "Provide a tool, a JSON arguments object, and ticker/quantity field paths."
        )
    private_write(
        CONNECTION_FILE,
        json.dumps(
            dict(
                endpoint=ENDPOINT,
                tool=tool,
                arguments=parsed,
                positions_path=positions_path.strip(),
                symbol_path=symbol_path.strip(),
                quantity_path=quantity_path.strip(),
            )
        ),
    )


def field(data, path):
    for part in path.split(".") if path else []:
        data = data[part]
    return data


def normalize_holdings(response, saved):
    rows = field(response, saved["positions_path"])
    if not isinstance(rows, list):
        raise ValueError(
            "Positions path must point to a list; existing holdings preserved."
        )
    amounts = {}
    omitted = 0
    for row in rows:
        try:
            symbol = us_stocks.normalize_symbol(field(row, saved["symbol_path"]))
            quantity = float(field(row, saved["quantity_path"]))
        except (KeyError, TypeError, ValueError) as exc:
            raise ValueError(
                "Position field mapping is invalid; existing holdings preserved."
            ) from exc
        if (
            not re.fullmatch(r"[A-Z0-9-]+", symbol)
            or not math.isfinite(quantity)
            or quantity <= 0
        ):
            omitted += 1
            continue
        amounts[symbol] = amounts.get(symbol, 0) + quantity
    return pd.DataFrame(
        sorted(amounts.items()), columns=["symbol", "quantity"]
    ), omitted


def sync_holdings(saved=None):
    saved = saved or connection()
    if not saved:
        raise RuntimeError(
            "Connect Robinhood and select its stock holdings tool first."
        )
    if saved["tool"] != "get_equity_positions":
        raise RuntimeError("Choose a Robinhood account to sync equity holdings.")
    response = asyncio.run(_request(saved))
    holdings, omitted = normalize_holdings(response, saved)
    if holdings.empty and omitted:
        raise ValueError("No usable holdings returned; existing holdings preserved.")
    private_write(HOLDINGS_FILE, holdings.to_csv(index=False))
    saved.update(
        last_synced_at=datetime.now(timezone.utc).isoformat(),
        holdings_count=len(holdings),
        omitted_positions=omitted,
    )
    private_write(CONNECTION_FILE, json.dumps(saved))
    return len(holdings), omitted


def sync_long_term_holdings():
    number = accounts.load_roles()["long_term"]
    if not number:
        raise ValueError("Select and save a long-term account first.")
    saved = dict(
        tool="get_equity_positions",
        arguments={"account_number": number},
        positions_path="data.positions",
        symbol_path="symbol",
        quantity_path="quantity",
    )
    response = asyncio.run(_request(saved))
    holdings, omitted = normalize_holdings(response, saved)
    if holdings.empty and omitted:
        raise ValueError(
            "No usable stock holdings returned; existing holdings preserved."
        )
    secure_storage.write_csv(holdings, accounts.holdings_path(number), index=False)
    return len(holdings), omitted
