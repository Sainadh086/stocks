"""
Zerodha Weekly Momentum Portfolio Monitor
==========================================

Purpose:
    1. Connect to your Zerodha account.
    2. Read current holdings automatically.
    3. Download NSE/BSE historical prices through Yahoo Finance.
    4. Calculate momentum for holdings with enough price history.
    5. Generate:
          STRONG HOLD
          HOLD
          WATCH
          REPLACE
    6. Identify deterioration before large trend breakdowns.
    7. Export weekly report to CSV.
    8. Cache the INDEX_NAME screen hourly during market hours.
    9. Rank index stocks and save the top momentum picks.
    10. Vet replacement candidates using market cap, liquidity, financials,
        debt, and ATR risk; save a separate audit CSV.
    11. Build alternative target portfolios capped at MAX_PORTFOLIO_SIZE using
        pooled proceeds from planned exits and whole-share buy estimates.
    12. Show additional vetted potential replacements for manual selection,
        even when the target portfolio has no open slots.
    13. Include today's filled Kite buys and unsettled T1 shares when counting
        current stocks toward the eight-stock target.
    14. Save a daily portfolio score and memory; generate a weekly review when
        the script runs on Friday in the India market timezone.

Reports and the access token are stored in india_stocks/.

This version DOES NOT place orders.

Install:
    pip install kiteconnect pandas numpy yfinance

Run only the index screen (no Zerodha login):
    python -m brokers.kite.analysis --index-only
"""

import argparse
import io
import json
import math
import os
import re
from collections import Counter
from datetime import datetime, time, timedelta
from urllib.request import Request, urlopen
from zoneinfo import ZoneInfo

import numpy as np
import pandas as pd
import yfinance as yf

from shared import storage as secure_storage
from shared.momentum import (
    analyze_stock,
    assess_potential,
    unscored_holding,
)
from shared.paths import INDIA_DIR
from shared.storage import require_setting as get_credential

# ============================================================
# CONFIGURATION
# ============================================================


INDIA_STOCKS_DIR = str(INDIA_DIR)
TOKEN_FILE = os.path.join(INDIA_STOCKS_DIR, "kite_access_token.json")

# Momentum thresholds

# Portfolio strategy
MAX_PORTFOLIO_SIZE = 8
MIN_CORE_STOCKS = 4

# Transparent rotational-momentum proxy, not Weekend Investing's private formula.
WEEKEND_STYLE_6M_WEIGHT = 0.6
WEEKEND_STYLE_3M_WEIGHT = 0.4

# Replacement eligibility. One crore INR is 10,000,000 rupees.
MIN_MARKET_CAP_INR = 10_000_000_000  # 1,000 crore
MIN_DAILY_TURNOVER_INR = 10_000_000  # 1 crore
MAX_DEBT_TO_EQUITY = 2.0
MIN_FINANCIAL_ROE = 0.05
MAX_ATR_PCT = 8.0
FUNDAMENTALS_CACHE_HOURS = 24
NAKED_STYLE_MAX_PE = 40.0
NAKED_STYLE_CANDIDATE_LIMIT = 40
POTENTIAL_REPLACEMENT_LIMIT = 12
POTENTIAL_CANDIDATE_SCAN_LIMIT = 40

# Change this to the NSE index you want to screen, e.g. "NIFTY 50".
INDEX_NAME = "Nifty MidSmallCap 400"
# Set a CSV URL here only if NSE uses a different filename for your index.
INDEX_CSV_URL = None
MARKET_TIMEZONE = ZoneInfo("Asia/Kolkata")
MARKET_OPEN = time(9, 15)
MARKET_CLOSE = time(15, 30)
INDEX_CACHE_HOURS = 1
PORTFOLIO_HISTORY_FILE = os.path.join(INDIA_STOCKS_DIR, "portfolio_history.json")
PORTFOLIO_MEMORY_FILE = os.path.join(INDIA_STOCKS_DIR, "portfolio_memory.md")


# ============================================================
# AUTHENTICATION
# ============================================================


def create_kite_session():
    from kiteconnect import KiteConnect

    kite = KiteConnect(api_key=get_credential("KITE_API_KEY"))

    print("\nOpen this URL in your browser:")
    print(kite.login_url())

    print(
        "\nAfter logging into Zerodha, copy the request_token from the redirected URL."
    )

    request_token = input("\nEnter request_token: ").strip()

    session = kite.generate_session(
        request_token, api_secret=get_credential("KITE_API_SECRET")
    )

    access_token = session["access_token"]

    kite.set_access_token(access_token)

    # Store today's token locally
    token_data = {
        "date": datetime.now(MARKET_TIMEZONE).strftime("%Y-%m-%d"),
        "access_token": access_token,
    }

    os.makedirs(INDIA_STOCKS_DIR, exist_ok=True)
    with secure_storage.open_text(TOKEN_FILE, "w") as f:
        json.dump(token_data, f)

    return kite


def connect_kite():
    from kiteconnect import KiteConnect

    kite = KiteConnect(api_key=get_credential("KITE_API_KEY"))

    # Try existing token first
    if os.path.exists(TOKEN_FILE):
        try:
            with secure_storage.open_text(TOKEN_FILE) as f:
                data = json.load(f)

            if data.get("date") == datetime.now(MARKET_TIMEZONE).strftime("%Y-%m-%d"):
                kite.set_access_token(data["access_token"])

                # Verify session
                kite.profile()

                print("Connected using saved token.")

                return kite

        except Exception:
            pass

    # Otherwise login again
    return create_kite_session()


# ============================================================
# GET YOUR ZERODHA HOLDINGS
# ============================================================


def get_holdings(kite):

    holdings = kite.holdings()

    df = pd.DataFrame(holdings)

    if df.empty:
        print("No holdings found.")
        return df

    return df


def get_executed_orders(kite):
    """Summarize today's filled delivery orders; pending quantities do not count."""
    try:
        orders = pd.DataFrame(kite.orders())
    except Exception as exc:
        print(f"Could not read today's Kite orders: {type(exc).__name__}")
        return pd.DataFrame(
            columns=[
                "exchange",
                "tradingsymbol",
                "buy_shares",
                "sell_shares",
                "buy_price",
            ]
        )
    if orders.empty:
        return pd.DataFrame(
            columns=[
                "exchange",
                "tradingsymbol",
                "buy_shares",
                "sell_shares",
                "buy_price",
            ]
        )
    required = {
        "exchange",
        "tradingsymbol",
        "product",
        "transaction_type",
        "filled_quantity",
        "average_price",
    }
    if not required.issubset(orders.columns):
        print(
            "Kite orders response is missing expected fields; ignoring order activity."
        )
        return pd.DataFrame(
            columns=[
                "exchange",
                "tradingsymbol",
                "buy_shares",
                "sell_shares",
                "buy_price",
            ]
        )
    orders["filled_quantity"] = pd.to_numeric(
        orders["filled_quantity"], errors="coerce"
    ).fillna(0)
    orders["average_price"] = pd.to_numeric(orders["average_price"], errors="coerce")
    orders = orders[
        orders["exchange"].isin(["NSE", "BSE"])
        & orders["product"].isin(["CNC", "MTF"])
        & orders["transaction_type"].isin(["BUY", "SELL"])
        & orders["filled_quantity"].gt(0)
    ]
    activity = []
    for (exchange, symbol), group in orders.groupby(["exchange", "tradingsymbol"]):
        buys = group[group["transaction_type"] == "BUY"]
        sells = group[group["transaction_type"] == "SELL"]
        buy_shares = int(buys["filled_quantity"].sum())
        sell_shares = int(sells["filled_quantity"].sum())
        buy_value = (buys["filled_quantity"] * buys["average_price"]).sum()
        activity.append(
            {
                "exchange": exchange,
                "tradingsymbol": symbol,
                "buy_shares": buy_shares,
                "sell_shares": sell_shares,
                "buy_price": buy_value / buy_shares if buy_shares else np.nan,
            }
        )
    return pd.DataFrame(
        activity,
        columns=["exchange", "tradingsymbol", "buy_shares", "sell_shares", "buy_price"],
    )


def include_incoming_holdings(holdings, activity):
    """Add net new buys absent from holdings without counting visible T1 twice."""
    holdings = holdings.copy()
    if holdings.empty:
        holdings = pd.DataFrame(
            columns=[
                "exchange",
                "tradingsymbol",
                "quantity",
                "t1_quantity",
                "average_price",
                "last_price",
            ]
        )
    if "t1_quantity" not in holdings:
        holdings["t1_quantity"] = 0
    holdings["incoming"] = (
        pd.to_numeric(holdings["t1_quantity"], errors="coerce").fillna(0).gt(0)
    )
    holdings["quantity"] = pd.to_numeric(holdings["quantity"], errors="coerce").fillna(
        0
    )
    holdings["t1_quantity"] = pd.to_numeric(
        holdings["t1_quantity"], errors="coerce"
    ).fillna(0)
    existing = set(zip(holdings["exchange"], holdings["tradingsymbol"]))
    additions = []
    for row in activity.itertuples(index=False):
        key = (row.exchange, row.tradingsymbol)
        if key not in existing and row.buy_shares > row.sell_shares:
            additions.append(
                {
                    "exchange": row.exchange,
                    "tradingsymbol": row.tradingsymbol,
                    "quantity": 0,
                    "t1_quantity": row.buy_shares - row.sell_shares,
                    "average_price": row.buy_price,
                    "last_price": row.buy_price,
                    "incoming": True,
                }
            )
            existing.add(key)
        elif key in existing and row.buy_shares > row.sell_shares:
            mask = holdings["exchange"].eq(row.exchange) & holdings["tradingsymbol"].eq(
                row.tradingsymbol
            )
            holdings.loc[mask, "incoming"] = True
            empty_position = mask & holdings["quantity"].add(
                holdings["t1_quantity"]
            ).le(0)
            holdings.loc[empty_position, "t1_quantity"] = (
                row.buy_shares - row.sell_shares
            )
    if additions:
        holdings = pd.concat([holdings, pd.DataFrame(additions)], ignore_index=True)
    return holdings[
        holdings["quantity"].add(holdings["t1_quantity"]).gt(0)
    ].reset_index(drop=True)


# ============================================================
# DOWNLOAD HISTORICAL DATA
# ============================================================


# ============================================================
# SCREEN AN NSE INDEX
# ============================================================


def get_index_symbols():
    slug = re.sub(r"[^a-z0-9]", "", INDEX_NAME.lower())
    if not slug.startswith("nifty"):
        raise ValueError("INDEX_NAME must be an NSE Nifty index name.")

    url = INDEX_CSV_URL or (
        f"https://nsearchives.nseindia.com/content/indices/ind_{slug}list.csv"
    )
    request = Request(url, headers={"User-Agent": "Mozilla/5.0"})
    try:
        with urlopen(request, timeout=20) as response:
            constituents = pd.read_csv(io.BytesIO(response.read()))
    except Exception as exc:
        raise RuntimeError(
            f"Could not load constituents for {INDEX_NAME} from {url}. "
            "Check INDEX_NAME or set INDEX_CSV_URL to the index's NSE CSV."
        ) from exc

    constituents.columns = constituents.columns.str.strip()
    if "Symbol" not in constituents.columns:
        raise ValueError(f"NSE constituent CSV has no Symbol column: {url}")

    symbols = constituents["Symbol"].dropna().astype(str).str.strip()
    symbols = symbols[symbols.str.fullmatch(r"[A-Za-z0-9&.-]+")]
    if symbols.empty:
        raise ValueError(f"No stock symbols found in {url}")
    return symbols.drop_duplicates().tolist()


def market_is_open(now):
    local = now.astimezone(MARKET_TIMEZONE)
    return local.weekday() < 5 and MARKET_OPEN <= local.time() < MARKET_CLOSE


def index_cache_is_fresh(cached_at, now):
    local_cached = cached_at.astimezone(MARKET_TIMEZONE)
    local_now = now.astimezone(MARKET_TIMEZONE)
    if local_cached.date() != local_now.date():
        return False
    if not market_is_open(now):
        return True
    return local_cached.time() >= MARKET_OPEN and local_now - local_cached < timedelta(
        hours=INDEX_CACHE_HOURS
    )


def screen_index(now=None):
    now = now or datetime.now(MARKET_TIMEZONE)
    slug = re.sub(r"[^a-z0-9]+", "_", INDEX_NAME.lower()).strip("_")
    output_dir = INDIA_STOCKS_DIR
    os.makedirs(output_dir, exist_ok=True)
    cache_file = os.path.join(output_dir, f"{slug}_momentum_cache.csv")

    ranked = None
    if os.path.exists(cache_file):
        cached_at = datetime.fromtimestamp(
            os.path.getmtime(cache_file), MARKET_TIMEZONE
        )
        if index_cache_is_fresh(cached_at, now):
            try:
                ranked = secure_storage.read_csv(cache_file).fillna(
                    {"warnings": "", "strengths": ""}
                )
                required = {"symbol", "momentum_score", "return_6m_pct", "action"}
                if ranked.empty or not required.issubset(ranked.columns):
                    ranked = None
                else:
                    print(
                        f"\nUsing cached {INDEX_NAME} screen from {cached_at:%Y-%m-%d %H:%M} IST."
                    )
            except (OSError, pd.errors.ParserError, pd.errors.EmptyDataError):
                ranked = None

    refreshed = ranked is None
    if refreshed:
        symbols = get_index_symbols()
        print(f"\nScreening {len(symbols)} stocks in {INDEX_NAME}...")
        results = []
        for symbol in symbols:
            print(f"Analyzing {symbol}...")
            result = analyze_stock(symbol)
            if result:
                results.append(result)

        if not results:
            print(f"No stocks could be scored for {INDEX_NAME}.")
            return pd.DataFrame()

        ranked = pd.DataFrame(results).sort_values(
            ["momentum_score", "return_6m_pct"], ascending=False
        )

    potential = ranked.apply(assess_potential, axis=1, result_type="expand")
    ranked["potential"] = potential[0]
    ranked["potential_reasons"] = potential[1]
    if refreshed:
        secure_storage.write_csv(ranked, cache_file, index=False)

    picks = (
        ranked[ranked["action"].isin(["STRONG HOLD", "HOLD"])]
        .head(MAX_PORTFOLIO_SIZE)
        .copy()
    )
    picks["fundamentals_status"] = "NOT CHECKED"

    print(f"\nTECHNICAL MOMENTUM SHORTLIST: {INDEX_NAME}")
    print("Fundamentals are checked later for portfolio replacement recommendations.")
    print("Potential is based on current trend signals, not a future return forecast.")
    if picks.empty:
        print("No stocks meet the HOLD threshold today.")
    else:
        print(
            picks[
                [
                    "symbol",
                    "price",
                    "momentum_score",
                    "action",
                    "potential",
                    "return_6m_pct",
                    "potential_reasons",
                ]
            ]
            .round(2)
            .to_string(index=False)
        )

    date = now.astimezone(MARKET_TIMEZONE).strftime("%Y_%m_%d")
    ranked_file = os.path.join(output_dir, f"{slug}_momentum_ranked_{date}.csv")
    picks_file = os.path.join(output_dir, f"{slug}_momentum_picks_{date}.csv")
    secure_storage.write_csv(ranked, ranked_file, index=False)
    secure_storage.write_csv(picks, picks_file, index=False)
    print(f"Ranked index: {ranked_file}")
    print(f"Selected stocks: {picks_file}")
    return ranked


def weekend_style_candidates(index_ranked, excluded_symbols):
    """Rank unowned index stocks by a simple 6M/3M momentum blend."""
    required = {"symbol", "action", "price", "sma200", "return_3m_pct", "return_6m_pct"}
    if index_ranked.empty or not required.issubset(index_ranked.columns):
        return pd.DataFrame()

    candidates = index_ranked.copy()
    for column in ("price", "sma200", "return_3m_pct", "return_6m_pct"):
        candidates[column] = pd.to_numeric(candidates[column], errors="coerce")
    candidates = (
        candidates[
            candidates["action"].isin(["STRONG HOLD", "HOLD"])
            & ~candidates["symbol"].isin(excluded_symbols)
            & (candidates["price"] > candidates["sma200"])
            & (candidates["return_3m_pct"] > 0)
            & (candidates["return_6m_pct"] > 0)
        ]
        .drop_duplicates("symbol")
        .copy()
    )
    candidates["weekend_style_score"] = (
        WEEKEND_STYLE_6M_WEIGHT * candidates["return_6m_pct"]
        + WEEKEND_STYLE_3M_WEIGHT * candidates["return_3m_pct"]
    )
    return candidates.sort_values("weekend_style_score", ascending=False)


def next_approved_candidate(candidate_rows, reviewer):
    for candidate in candidate_rows:
        audit = reviewer.check(candidate._asdict())
        if audit["status"] == "PASS":
            return candidate, audit
    return None, None


def portfolio_slots(report):
    """Reserve slots while requiring a second dated REPLACE signal for an exit."""
    today = datetime.now(MARKET_TIMEZONE).date().isoformat()
    try:
        with secure_storage.open_text(PORTFOLIO_HISTORY_FILE) as file:
            snapshots = json.load(file).get("snapshots", [])
        previous = next(
            (item for item in reversed(snapshots) if item.get("date", "") < today), None
        )
    except (OSError, ValueError, TypeError):
        previous = None
    prior_actions = {
        (item.get("exchange"), item.get("symbol")): item.get("action")
        for item in (previous or {}).get("holdings", [])
    }
    confirmed = report.apply(
        lambda row: (
            row["action"] == "REPLACE"
            and prior_actions.get((row["exchange"], row["symbol"])) == "REPLACE"
        ),
        axis=1,
    )
    priority = {"STRONG HOLD": 0, "HOLD": 1, "WATCH": 2, "REPLACE": 3, "NO DATA": 4}
    eligible = report[~confirmed | report["incoming"]].copy()
    eligible["priority"] = eligible["action"].map(priority).fillna(4)
    eligible.loc[eligible["incoming"], "priority"] = -1
    eligible = eligible.sort_values(
        ["priority", "momentum_score"], ascending=[True, False], na_position="last"
    )
    keep_indices = set(eligible.head(MAX_PORTFOLIO_SIZE).index)
    report["portfolio_plan"] = "SELL"
    report.loc[list(keep_indices), "portfolio_plan"] = "KEEP"
    report["plan_reason"] = ""
    for index, row in report.iterrows():
        if row["portfolio_plan"] == "SELL":
            reason = (
                "REPLACE on two dated scans; verify price, thesis, costs and taxes"
                if confirmed.loc[index]
                else "Capacity limit; review signals, price, costs and taxes before exit"
            )
            if row["action"] == "NO DATA":
                reason += "; price history unavailable"
            if row["incoming"]:
                reason += "; recent buy/T1 may be unsettled"
        elif row["action"] == "REPLACE":
            reason = (
                "Recent buy/T1; verify settlement and reassess the REPLACE signal"
                if row["incoming"]
                else "First REPLACE scan; reassess on the next trading day"
            )
        elif row["action"] == "WATCH":
            reason = "Watch trend and recheck before changing the position"
        elif row["action"] == "NO DATA":
            reason = "Price history unavailable; verify manually"
        else:
            reason = "Trend intact; review weight and investment thesis"
        report.at[index, "plan_reason"] = reason
    slots = MAX_PORTFOLIO_SIZE - len(keep_indices)
    return slots


def pooled_sale_value(report):
    """Return estimated proceeds, or None if any planned sale lacks a usable quote."""
    sales = report[report["portfolio_plan"] == "SELL"]
    if sales.empty:
        return 0.0
    total = 0.0
    for row in sales.itertuples():
        quantity = pd.to_numeric(row.sell_quantity, errors="coerce")
        price = pd.to_numeric(row.sell_price, errors="coerce")
        if (
            pd.isna(quantity)
            or pd.isna(price)
            or not math.isfinite(float(quantity))
            or not math.isfinite(float(price))
            or quantity <= 0
            or price <= 0
            or int(quantity) != quantity
        ):
            return None
        total += int(quantity) * float(price)
    return round(total, 2)


def build_buy_plan(report, candidates, slots, proceeds, strategy):
    """Split pooled sale proceeds equally across new names, using whole shares."""
    if slots <= 0 or proceeds is None or proceeds <= 0:
        return []
    chosen = candidates[:slots]
    if not chosen:
        return []
    sell_names = ", ".join(report.loc[report["portfolio_plan"] == "SELL", "symbol"])
    budget = proceeds / len(chosen)
    plan = []
    for candidate in chosen:
        price = pd.to_numeric(candidate.price, errors="coerce")
        if pd.isna(price) or not math.isfinite(float(price)) or price <= 0:
            continue
        rounded_price = round(float(price), 2)
        if rounded_price <= 0:
            continue
        buy_shares = math.floor((budget + 1e-9) / rounded_price)
        if buy_shares > 0:
            plan.append(
                {
                    "strategy": strategy,
                    "sell": sell_names,
                    "buy": candidate.symbol,
                    "buy_shares": buy_shares,
                    "buy_exchange": candidate.exchange,
                    "buy_price": rounded_price,
                }
            )
    return plan


def print_buy_plan(plan):
    if plan:
        print(pd.DataFrame(plan)[["sell", "buy", "buy_shares"]].to_string(index=False))
    else:
        print(
            "No affordable, eligible new stock for the available slots and sale proceeds."
        )


def potential_replacement_table(candidate_groups):
    """List vetted unowned choices, including choices outside the eight-stock plan."""
    choices = {}
    for strategy, candidates in candidate_groups.items():
        for candidate in candidates:
            symbol = candidate.symbol
            if symbol not in choices:
                potential, reason = assess_potential(pd.Series(candidate._asdict()))
                choices[symbol] = {
                    "stock": symbol,
                    "momentum_score": candidate.momentum_score,
                    "potential": potential,
                    "reason": reason,
                    "strategies": [],
                }
            choices[symbol]["strategies"].append(strategy)
    for choice in choices.values():
        choice["strategies"] = ", ".join(choice["strategies"])
    return pd.DataFrame(
        choices.values(),
        columns=["stock", "momentum_score", "potential", "strategies", "reason"],
    ).sort_values("momentum_score", ascending=False)


def score_portfolio(report, holdings, activity, now=None):
    """Score current holdings from value-weighted momentum and portfolio shape."""
    now = now or datetime.now(MARKET_TIMEZONE)
    positions = []
    for index, row in report.iterrows():
        holding = holdings.loc[index]
        shares = float(holding["quantity"]) + float(holding["t1_quantity"])
        last_price = pd.to_numeric(holding.get("last_price"), errors="coerce")
        if pd.isna(last_price) or last_price <= 0:
            last_price = pd.to_numeric(row.get("price"), errors="coerce")
        value = (
            shares * float(last_price)
            if pd.notna(last_price) and last_price > 0
            else None
        )
        momentum = pd.to_numeric(row.get("momentum_score"), errors="coerce")
        positions.append(
            {
                "symbol": str(row["symbol"]),
                "exchange": str(row["exchange"]),
                "shares": shares,
                "market_value_inr": round(value, 2) if value is not None else None,
                "momentum_score": float(momentum) if pd.notna(momentum) else None,
                "action": str(row["action"]),
                "incoming": bool(row["incoming"]),
                "portfolio_plan": str(row["portfolio_plan"]),
                "plan_reason": str(row["plan_reason"]),
            }
        )
    valid_values = [position["market_value_inr"] for position in positions]
    score = None
    components = {}
    if positions and all(value is not None and value > 0 for value in valid_values):
        total = sum(valid_values)
        weights = [value / total for value in valid_values]
        for position, weight in zip(positions, weights):
            position["weight_pct"] = round(weight * 100, 1)
        weighted_momentum = sum(
            weight * (position["momentum_score"] or 0)
            for weight, position in zip(weights, positions)
        )
        coverage = 100 * sum(
            weight
            for weight, position in zip(weights, positions)
            if position["momentum_score"] is not None
        )
        effective_count = 1 / sum(weight * weight for weight in weights)
        diversification = 100 * min(effective_count / MAX_PORTFOLIO_SIZE, 1)
        if len(positions) > MAX_PORTFOLIO_SIZE:
            diversification *= MAX_PORTFOLIO_SIZE / len(positions)
        score = round(
            0.8 * weighted_momentum + 0.1 * coverage + 0.1 * diversification, 1
        )
        components = {
            "weighted_momentum": round(weighted_momentum, 1),
            "data_coverage_pct": round(coverage, 1),
            "diversification_score": round(diversification, 1),
            "portfolio_value_inr": round(total, 2),
        }
    return {
        "date": now.date().isoformat(),
        "as_of": now.isoformat(),
        "score": score,
        "components": components,
        "holdings": positions,
        "orders": activity.to_dict("records"),
    }


def snapshot_changes(previous, current):
    before = {
        item["exchange"] + ":" + item["symbol"]: item
        for item in (previous or {}).get("holdings", [])
    }
    after = {
        item["exchange"] + ":" + item["symbol"]: item for item in current["holdings"]
    }
    return {
        "added": sorted(after.keys() - before.keys()),
        "removed": sorted(before.keys() - after.keys()),
        "share_changes": [
            f"{key}: {before[key]['shares']:g} → {after[key]['shares']:g}"
            for key in sorted(before.keys() & after.keys())
            if before[key]["shares"] != after[key]["shares"]
        ],
    }


def update_portfolio_memory(snapshot):
    """Keep one snapshot per India trading date and write a short readable memory."""
    try:
        with secure_storage.open_text(PORTFOLIO_HISTORY_FILE) as file:
            history = json.load(file)
        snapshots = history.get("snapshots", [])
    except (OSError, ValueError, TypeError):
        snapshots = []
    previous = next(
        (item for item in reversed(snapshots) if item["date"] < snapshot["date"]), None
    )
    snapshots = [item for item in snapshots if item["date"] != snapshot["date"]]
    snapshots.append(snapshot)
    snapshots.sort(key=lambda item: item["date"])
    os.makedirs(INDIA_STOCKS_DIR, exist_ok=True)
    temp_file = PORTFOLIO_HISTORY_FILE + ".tmp"
    with secure_storage.open_text(temp_file, "w") as file:
        json.dump({"version": 1, "snapshots": snapshots}, file, indent=2)
    os.replace(temp_file, PORTFOLIO_HISTORY_FILE)

    changes = snapshot_changes(previous, snapshot)
    score_text = (
        "unavailable" if snapshot["score"] is None else f"{snapshot['score']:.1f}/100"
    )
    score_change = (
        round(snapshot["score"] - previous["score"], 1)
        if previous and snapshot["score"] is not None and previous["score"] is not None
        else None
    )
    lines = [
        "# India portfolio memory",
        "",
        f"Updated: {snapshot['as_of']}",
        f"Portfolio score: {score_text}",
        f"Score change: {score_change:+.1f} points since {previous['date']}"
        if score_change is not None
        else "Score change: baseline not available",
        f"Current stocks: {len(snapshot['holdings'])} (target: at most {MAX_PORTFOLIO_SIZE})",
        "",
        "## Current holdings",
        ", ".join(item["symbol"] for item in snapshot["holdings"]) or "None",
        "",
        "## Changes since the prior snapshot",
        f"Added: {', '.join(changes['added']) or 'None'}",
        f"Removed: {', '.join(changes['removed']) or 'None'}",
        f"Share changes: {', '.join(changes['share_changes']) or 'None'}",
        "Today's filled orders: "
        + (
            "; ".join(
                f"{item['tradingsymbol']} buy {item['buy_shares']}, sell {item['sell_shares']}"
                for item in snapshot["orders"]
            )
            or "None"
        ),
        "",
        "## Strategy memory",
        f"Index: {INDEX_NAME}; target: {MAX_PORTFOLIO_SIZE} stocks.",
        "Momentum ranks holdings; replacement candidates also pass market cap, liquidity, financial and ATR checks.",
        "Weekend Investing and Naked Trader lists are independent, rule-based approximations.",
        "The score is a monitoring measure, not a return forecast or a fundamental rating.",
        "History: portfolio_history.json. Friday reviews: weekly_review_YYYY_MM_DD.md.",
        "",
    ]
    with secure_storage.open_text(PORTFOLIO_MEMORY_FILE, "w") as file:
        file.write("\n".join(lines))
    return snapshots, changes


def write_friday_review(snapshots, current):
    """Write a weekly review when the portfolio run occurs on Friday in India."""
    current_date = datetime.fromisoformat(current["as_of"])
    if current_date.weekday() != 4:
        return None
    week_start = (current_date.date() - timedelta(days=4)).isoformat()
    previous = next(
        (item for item in reversed(snapshots) if item["date"] < week_start), None
    )
    if previous is None:
        previous = next(
            (item for item in snapshots if item["date"] < current["date"]), None
        )
    changes = snapshot_changes(previous, current)
    score = current["score"]
    previous_score = previous["score"] if previous else None
    delta = (
        round(score - previous_score, 1)
        if score is not None and previous_score is not None
        else None
    )
    counts = Counter(item["action"] for item in current["holdings"])
    lines = [
        f"# India portfolio weekly review — {current['date']}",
        "",
        f"Score: {f'{score:.1f}/100' if score is not None else 'unavailable'}",
        f"Change from {previous['date'] if previous else 'prior week'}: "
        f"{f'{delta:+.1f} points' if delta is not None else 'baseline not available'}",
        f"Stocks held: {len(current['holdings'])}; target: at most {MAX_PORTFOLIO_SIZE}",
        "",
        "## Holdings changes",
        "",
        f"Added: {', '.join(changes['added']) or 'None'}",
        f"Removed: {', '.join(changes['removed']) or 'None'}",
        f"Share changes: {', '.join(changes['share_changes']) or 'None'}",
        "",
        "## Current signals",
        "",
        ", ".join(f"{action}: {count}" for action, count in sorted(counts.items()))
        or "None",
        (
            f"Data coverage: {current['components']['data_coverage_pct']:.1f}%"
            if current["components"]
            else "Data coverage: unavailable"
        ),
        "",
        "## Attention",
        "",
    ]
    attention = [
        item["symbol"]
        for item in current["holdings"]
        if item["action"] in ("WATCH", "REPLACE", "NO DATA")
    ]
    lines.append(
        "Review: " + (", ".join(attention) if attention else "No holdings flagged.")
    )
    lines.extend(
        [
            "",
            "## Holdings",
            "",
            "| Stock | Shares | Weight | Momentum | Signal |",
            "| --- | ---: | ---: | ---: | --- |",
        ]
    )
    for item in sorted(
        current["holdings"],
        key=lambda holding: holding.get("weight_pct", 0),
        reverse=True,
    ):
        momentum = (
            f"{item['momentum_score']:.0f}"
            if item["momentum_score"] is not None
            else "N/A"
        )
        weight = f"{item['weight_pct']:.1f}%" if "weight_pct" in item else "N/A"
        lines.append(
            f"| {item['symbol']} | {item['shares']:g} | {weight} | "
            f"{momentum} | {item['action']} |"
        )
    lines.extend(
        [
            "",
            "Score = 80% value-weighted momentum + 10% data coverage + "
            "10% diversification. It is a monitoring measure, not a return forecast.",
            "",
        ]
    )
    path = os.path.join(
        INDIA_STOCKS_DIR, "weekly_review_" + current_date.strftime("%Y_%m_%d") + ".md"
    )
    with secure_storage.open_text(path, "w") as file:
        file.write("\n".join(lines))
    return path


def latest_statement_value(statement, names):
    if statement is None or statement.empty:
        return None
    for name in names:
        if name in statement.index:
            values = statement.loc[name].dropna()
            if not values.empty:
                return float(values.iloc[0])
    return None


class FundamentalsReviewer:
    """Cache public company data and explain each replacement eligibility decision."""

    def __init__(self):
        self.cache_file = os.path.join(INDIA_STOCKS_DIR, "fundamentals_cache.json")
        try:
            with secure_storage.open_text(self.cache_file) as file:
                self.cache = json.load(file)
        except (OSError, ValueError):
            self.cache = {}
        self.audit = {}

    def fetch(self, symbol):
        entry = self.cache.get(symbol, {})
        try:
            checked_at = datetime.fromisoformat(entry["checked_at"])
            if entry.get("version") == 2 and datetime.now(
                MARKET_TIMEZONE
            ) - checked_at < timedelta(hours=FUNDAMENTALS_CACHE_HOURS):
                return entry["data"]
        except (KeyError, TypeError, ValueError):
            pass

        print(f"Checking market cap and financials for {symbol}...")
        try:
            ticker = yf.Ticker(f"{symbol}.NS")
            info = ticker.get_info()
            data = {
                "market_cap_inr": info.get("marketCap"),
                "average_volume": info.get("averageVolume"),
                "revenue_inr": info.get("totalRevenue"),
                "net_income_inr": info.get("netIncomeToCommon"),
                "operating_margin": info.get("operatingMargins"),
                "sector": info.get("sector"),
                "currency": info.get("financialCurrency"),
                "revenue_growth": info.get("revenueGrowth"),
                "earnings_growth": info.get("earningsGrowth"),
                "trailing_pe": info.get("trailingPE"),
            }
            balance = ticker.get_balance_sheet()
            data["equity_inr"] = latest_statement_value(
                balance, ("CommonStockEquity", "StockholdersEquity")
            )
            data["total_debt_inr"] = latest_statement_value(balance, ("TotalDebt",))
            if data["net_income_inr"] is None:
                income = ticker.get_income_stmt()
                data["net_income_inr"] = latest_statement_value(
                    income,
                    (
                        "NetIncome",
                        "NetIncomeFromContinuingOperationNetMinorityInterest",
                    ),
                )
            if data["sector"] != "Financial Services":
                cashflow = ticker.get_cashflow()
                data["operating_cash_flow_inr"] = latest_statement_value(
                    cashflow, ("OperatingCashFlow",)
                )
        except Exception as exc:
            data = {"error": f"Yahoo financial data unavailable: {type(exc).__name__}"}

        self.cache[symbol] = {
            "version": 2,
            "checked_at": datetime.now(MARKET_TIMEZONE).isoformat(),
            "data": data,
        }
        os.makedirs(INDIA_STOCKS_DIR, exist_ok=True)
        with secure_storage.open_text(self.cache_file, "w") as file:
            json.dump(self.cache, file)
        return data

    def check(self, row):
        symbol = row["symbol"]
        price = pd.to_numeric(row.get("price"), errors="coerce")
        atr = pd.to_numeric(row.get("atr"), errors="coerce")
        data = self.fetch(symbol)
        reasons = []
        metrics = {}
        if "error" in data:
            reasons.append(data["error"])
        else:

            def number(name):
                value = pd.to_numeric(data.get(name), errors="coerce")
                return None if pd.isna(value) else float(value)

            market_cap = number("market_cap_inr")
            volume = number("average_volume")
            revenue = number("revenue_inr")
            net_income = number("net_income_inr")
            equity = number("equity_inr")
            debt = number("total_debt_inr")
            operating_margin = number("operating_margin")
            operating_cash_flow = number("operating_cash_flow_inr")
            sector = data.get("sector")
            turnover = (
                volume * price if volume is not None and pd.notna(price) else None
            )
            debt_ratio = (
                debt / equity if debt is not None and equity and equity > 0 else None
            )
            roe = (
                net_income / equity
                if net_income is not None and equity and equity > 0
                else None
            )
            metrics = {
                "market_cap_crore": market_cap / 10_000_000
                if market_cap is not None
                else None,
                "daily_turnover_crore": turnover / 10_000_000
                if turnover is not None
                else None,
                "net_income_crore": net_income / 10_000_000
                if net_income is not None
                else None,
                "operating_cash_flow_crore": operating_cash_flow / 10_000_000
                if operating_cash_flow is not None
                else None,
                "debt_to_equity": debt_ratio,
                "roe": roe,
                "sector": sector,
            }
            if data.get("currency") != "INR":
                reasons.append("financial currency missing or not INR")
            if market_cap is None or market_cap < MIN_MARKET_CAP_INR:
                reasons.append(
                    f"market cap missing or below {MIN_MARKET_CAP_INR / 10_000_000:,.0f} crore"
                )
            if turnover is None or turnover < MIN_DAILY_TURNOVER_INR:
                reasons.append(
                    f"daily traded value missing or below {MIN_DAILY_TURNOVER_INR / 10_000_000:,.0f} crore"
                )
            if revenue is None or revenue <= 0:
                reasons.append("revenue missing or nonpositive")
            if net_income is None or net_income <= 0:
                reasons.append("net income missing or nonpositive")
            if not sector:
                reasons.append("sector missing")
            elif sector == "Financial Services":
                if roe is None or roe < MIN_FINANCIAL_ROE:
                    reasons.append(
                        f"financial-company ROE missing or below {MIN_FINANCIAL_ROE:.0%}"
                    )
            else:
                if operating_margin is None or operating_margin <= 0:
                    reasons.append("operating margin missing or nonpositive")
                if operating_cash_flow is None or operating_cash_flow <= 0:
                    reasons.append("operating cash flow missing or nonpositive")
                if debt_ratio is None or debt_ratio > MAX_DEBT_TO_EQUITY:
                    reasons.append(
                        f"debt/equity missing or above {MAX_DEBT_TO_EQUITY:g}"
                    )

        atr_pct = (
            atr / price * 100
            if pd.notna(atr) and pd.notna(price) and price > 0
            else None
        )
        metrics["atr_pct"] = atr_pct
        if atr_pct is None or atr_pct > MAX_ATR_PCT:
            reasons.append(f"ATR risk missing or above {MAX_ATR_PCT:g}% of price")
        result = {
            "symbol": symbol,
            "status": "PASS" if not reasons else "REJECT",
            "reason": " | ".join(reasons),
            **metrics,
        }
        self.audit[symbol] = result
        return result

    def check_naked_style(self, row):
        """Additional growth/value screen; the thresholds are our own proxy."""
        audit = self.audit.get(row["symbol"]) or self.check(row)
        data = self.fetch(row["symbol"])
        reasons = []
        if audit["status"] != "PASS":
            reasons.append("baseline fundamentals/risk check failed")

        def number(name):
            value = pd.to_numeric(data.get(name), errors="coerce")
            return None if pd.isna(value) else float(value)

        revenue_growth = number("revenue_growth")
        earnings_growth = number("earnings_growth")
        pe = number("trailing_pe")
        if revenue_growth is None or revenue_growth <= 0:
            reasons.append("revenue growth missing or nonpositive")
        if earnings_growth is None or earnings_growth <= 0:
            reasons.append("earnings growth missing or nonpositive")
        if pe is None or not 0 < pe <= NAKED_STYLE_MAX_PE:
            reasons.append(f"P/E missing or outside 0-{NAKED_STYLE_MAX_PE:g}")
        result = {
            "status": "PASS" if not reasons else "REJECT",
            "revenue_growth_pct": revenue_growth * 100
            if revenue_growth is not None
            else None,
            "earnings_growth_pct": earnings_growth * 100
            if earnings_growth is not None
            else None,
            "pe": pe,
            "reason": " | ".join(reasons),
        }
        audit.update({f"naked_style_{key}": value for key, value in result.items()})
        return result

    def save_audit(self):
        if self.audit:
            date = datetime.now(MARKET_TIMEZONE).strftime("%Y_%m_%d")
            path = os.path.join(INDIA_STOCKS_DIR, f"fundamentals_audit_{date}.csv")
            secure_storage.write_csv(
                pd.DataFrame(self.audit.values()), path, index=False
            )
            print(f"Fundamentals audit: {path}")


# ============================================================
# ANALYZE ENTIRE ZERODHA PORTFOLIO
# ============================================================


def monitor_portfolio(index_ranked, kite_client=None):

    print("\nConnecting to Zerodha...")

    kite = kite_client if kite_client is not None else connect_kite()

    activity = get_executed_orders(kite)
    holdings = include_incoming_holdings(get_holdings(kite), activity)

    if holdings.empty:
        return

    if not activity.empty:
        print("\nToday's filled delivery orders (shares):")
        print(
            activity[["tradingsymbol", "buy_shares", "sell_shares"]].to_string(
                index=False
            )
        )

    print("\nCurrent Zerodha holdings:")

    print(
        holdings[
            ["tradingsymbol", "quantity", "t1_quantity", "average_price", "last_price"]
        ].to_string(index=False)
    )

    results = []

    for _, holding in holdings.iterrows():
        symbol = holding["tradingsymbol"]
        exchange = holding["exchange"]
        print(f"\nAnalyzing {exchange}:{symbol}...")
        result = analyze_stock(symbol, exchange)
        results.append(result if result else unscored_holding(holding))

    report = pd.DataFrame(results)

    if report.empty:
        return

    # Rank strongest first
    report = report.sort_values("momentum_score", ascending=False)
    report["sell_quantity"] = pd.to_numeric(holdings["quantity"], errors="coerce")
    report["sell_price"] = pd.to_numeric(holdings["last_price"], errors="coerce")
    report["incoming"] = holdings["incoming"].astype(bool)
    slots = portfolio_slots(report)
    proceeds = pooled_sale_value(report)

    reviewer = FundamentalsReviewer()
    primary_candidates = []
    if not index_ranked.empty:
        held_symbols = set(holdings["tradingsymbol"].astype(str))
        candidates = (
            index_ranked[
                index_ranked["action"].isin(["STRONG HOLD", "HOLD"])
                & ~index_ranked["symbol"].isin(held_symbols)
            ]
            .drop_duplicates("symbol")
            .head(POTENTIAL_CANDIDATE_SCAN_LIMIT)
        )
        candidate_rows = iter(candidates.itertuples(index=False))
        for _ in range(POTENTIAL_REPLACEMENT_LIMIT):
            candidate, audit = next_approved_candidate(candidate_rows, reviewer)
            if candidate is None:
                break
            primary_candidates.append(candidate)

    weekend_candidates_approved = []
    if not index_ranked.empty:
        excluded = set(holdings["tradingsymbol"].astype(str))
        weekend_candidates = weekend_style_candidates(index_ranked, excluded).head(
            POTENTIAL_CANDIDATE_SCAN_LIMIT
        )
        candidate_rows = iter(weekend_candidates.itertuples(index=False))
        for _ in range(POTENTIAL_REPLACEMENT_LIMIT):
            candidate, audit = next_approved_candidate(candidate_rows, reviewer)
            if candidate is None:
                break
            weekend_candidates_approved.append(candidate)

    # Combine our momentum ranking and baseline risk gate with an independent
    # growth/value screen inspired by the published Naked Trader adaptation.
    naked_candidates_approved = []
    if not index_ranked.empty:
        excluded = set(holdings["tradingsymbol"].astype(str))
        candidates = (
            index_ranked[
                index_ranked["action"].isin(["STRONG HOLD", "HOLD"])
                & ~index_ranked["symbol"].isin(excluded)
            ]
            .drop_duplicates("symbol")
            .head(NAKED_STYLE_CANDIDATE_LIMIT)
        )
        qualified = []
        for candidate in candidates.itertuples(index=False):
            result = reviewer.check_naked_style(candidate._asdict())
            if result["status"] == "PASS":
                # Momentum remains the dominant input; growth and valuation
                # break ties among stocks that pass the same baseline gate.
                score = (
                    float(candidate.momentum_score)
                    + min(result["revenue_growth_pct"], 50) * 0.1
                    + min(result["earnings_growth_pct"], 50) * 0.1
                    - result["pe"] * 0.1
                )
                qualified.append((score, candidate, result))
        qualified.sort(key=lambda item: item[0], reverse=True)
        naked_candidates_approved = [
            candidate for _, candidate, _ in qualified[:POTENTIAL_REPLACEMENT_LIMIT]
        ]

    plans = {
        "momentum": build_buy_plan(
            report, primary_candidates, slots, proceeds, "momentum"
        ),
        "weekend_style": build_buy_plan(
            report, weekend_candidates_approved, slots, proceeds, "weekend_style"
        ),
        "naked_style": build_buy_plan(
            report, naked_candidates_approved, slots, proceeds, "naked_style"
        ),
    }
    potential_replacements = potential_replacement_table(
        {
            "momentum": primary_candidates,
            "weekend_style": weekend_candidates_approved,
            "naked_style": naked_candidates_approved,
        }
    )

    print("\n")
    print("=" * 110)
    print("ZERODHA WEEKLY MOMENTUM REPORT")
    print("=" * 110)

    display_columns = [
        "symbol",
        "exchange",
        "price",
        "momentum_score",
        "action",
        "return_1m_pct",
        "return_3m_pct",
        "return_6m_pct",
        "rsi",
        "sma50",
        "sma200",
        "risk_level",
        "warnings",
    ]

    print(report[display_columns].round(2).to_string(index=False))

    # --------------------------------------------------------
    # Portfolio summary
    # --------------------------------------------------------

    print("\n\nPORTFOLIO SUMMARY")
    print("-" * 50)

    for action in ["STRONG HOLD", "HOLD", "WATCH", "REPLACE", "NO DATA"]:
        stocks = report[report["action"] == action]["symbol"].tolist()

        print(f"{action:12}: {', '.join(stocks) if stocks else '-'}")

    print(f"\nTARGET PORTFOLIO: at most {MAX_PORTFOLIO_SIZE} stocks")
    kept = report.loc[report["portfolio_plan"] == "KEEP", "symbol"].tolist()
    sold = report.loc[report["portfolio_plan"] == "SELL", "symbol"].tolist()
    print(f"Keep ({len(kept)}): {', '.join(kept) if kept else '-'}")
    print(f"Planned exits ({len(sold)}): {', '.join(sold) if sold else '-'}")
    for row in report.loc[
        report["portfolio_plan"] == "SELL", ["symbol", "plan_reason"]
    ].itertuples(index=False):
        print(f"  {row.symbol}: {row.plan_reason}")
    first_signals = report.loc[
        report["action"].eq("REPLACE") & report["portfolio_plan"].eq("KEEP"), "symbol"
    ].tolist()
    if first_signals:
        print(f"REPLACE signals kept for review: {', '.join(first_signals)}")
    incoming = report.loc[report["incoming"], "symbol"].tolist()
    print(
        f"Recent buys/T1 holdings ({len(incoming)}): {', '.join(incoming) if incoming else '-'}"
    )
    print(
        f"Open slots: {slots}; estimated sale proceeds: "
        f"{'unavailable' if proceeds is None else f'₹{proceeds:,.2f}'}"
    )
    if any(report.loc[report["portfolio_plan"] == "SELL", "action"] == "NO DATA"):
        print(
            "Review NO DATA exits manually; price history was insufficient to rank them."
        )
    if any(report.loc[report["portfolio_plan"] == "SELL", "incoming"]):
        print(
            "Review recent-buy/T1 exits manually; those shares may not be settled yet."
        )

    print(f"\nPOTENTIAL REPLACEMENTS FROM {INDEX_NAME}")
    print(
        "Unowned, vetted choices for your own eight-stock selection; "
        "potential describes current trend signals."
    )
    if potential_replacements.empty:
        print("No eligible candidates in the current index screen.")
    else:
        print(potential_replacements.round(2).to_string(index=False))

    if sold:
        print(
            "Buy shares use pooled estimated sale proceeds, split across the selected new stocks."
        )
        print(
            "Each strategy is an alternative plan; actual proceeds and prices may differ."
        )
        print(f"\nREPLACEMENTS FROM {INDEX_NAME}")
        print(
            "Only stocks passing market cap, liquidity, financial, debt, and ATR checks are shown."
        )
        print_buy_plan(plans["momentum"])

        print(f"\nWEEKEND INVESTING-INSPIRED ALTERNATIVES FROM {INDEX_NAME}")
        print(
            "Independent 60% 6M + 40% 3M return score; not Weekend Investing's official picks."
        )
        print("Uses the same market cap, liquidity, financial, debt, and ATR checks.")
        print_buy_plan(plans["weekend_style"])

        print(f"\nNAKED TRADER-INSPIRED + MOMENTUM ALTERNATIVES FROM {INDEX_NAME}")
        print("Own proxy: positive revenue and earnings growth, P/E <= 40, existing")
        print("fundamentals/risk gate; momentum-led score. Not official model picks.")
        print_buy_plan(plans["naked_style"])

    for strategy, plan in plans.items():
        if plan:
            target_count = len(kept) + len(plan)
            assert target_count <= MAX_PORTFOLIO_SIZE
            print(f"{strategy} target: {target_count} stocks")

    snapshot = score_portfolio(report, holdings, activity)
    snapshots, changes = update_portfolio_memory(snapshot)
    print("\nPORTFOLIO SCORE")
    if snapshot["score"] is None:
        print("Unavailable: one or more held positions lack a usable market price.")
    else:
        parts = snapshot["components"]
        print(
            f"{snapshot['score']:.1f}/100 (momentum {parts['weighted_momentum']:.1f}, "
            f"coverage {parts['data_coverage_pct']:.1f}%, "
            f"diversification {parts['diversification_score']:.1f})"
        )
    print(
        f"Since prior snapshot: +{len(changes['added'])} stocks, "
        f"-{len(changes['removed'])} stocks, "
        f"{len(changes['share_changes'])} share-count changes."
    )
    print(f"Portfolio memory: {PORTFOLIO_MEMORY_FILE}")
    friday_review = write_friday_review(snapshots, snapshot)
    if friday_review:
        print(f"Friday review: {friday_review}")

    reviewer.save_audit()

    # --------------------------------------------------------
    # Save report
    # --------------------------------------------------------

    os.makedirs(INDIA_STOCKS_DIR, exist_ok=True)
    filename = os.path.join(
        INDIA_STOCKS_DIR,
        "zerodha_momentum_"
        + datetime.now(MARKET_TIMEZONE).strftime("%Y_%m_%d")
        + ".csv",
    )

    secure_storage.write_csv(report, filename, index=False)

    plan_file = os.path.join(
        INDIA_STOCKS_DIR,
        "zerodha_target_plan_"
        + datetime.now(MARKET_TIMEZONE).strftime("%Y_%m_%d")
        + ".csv",
    )
    plan_frame = pd.DataFrame(
        [row for plan in plans.values() for row in plan],
        columns=["strategy", "sell", "buy", "buy_shares", "buy_exchange", "buy_price"],
    )
    secure_storage.write_csv(plan_frame, plan_file, index=False)

    potential_file = os.path.join(
        INDIA_STOCKS_DIR,
        "zerodha_potential_replacements_"
        + datetime.now(MARKET_TIMEZONE).strftime("%Y_%m_%d")
        + ".csv",
    )
    secure_storage.write_csv(potential_replacements, potential_file, index=False)

    print(
        f"\nReport saved to {filename}\nTarget plans saved to {plan_file}"
        f"\nPotential replacements saved to {potential_file}"
    )


# ============================================================
# RUN
# ============================================================


def main():
    parser = argparse.ArgumentParser(description="Kite India momentum analysis")
    parser.add_argument(
        "--index-only",
        action="store_true",
        help="Screen the index without connecting to Kite",
    )
    args = parser.parse_args()
    index_ranked = screen_index()
    if not args.index_only:
        monitor_portfolio(index_ranked)


if __name__ == "__main__":
    main()
