"""Data adapters shared by HTTP workspaces; brokerage rules stay in their modules."""

import hashlib
import json
import math
from datetime import date, datetime, time, timedelta
from decimal import Decimal
from pathlib import Path
from urllib.parse import parse_qs, urlparse

import numpy as np
import pandas as pd
from kiteconnect import KiteConnect

from brokers.kite import analysis as kite
from brokers.kite import selection
from brokers.robinhood import accounts, analysis, long_term
from shared import storage
from shared.paths import INDIA_DIR, US_DIR


def clean(value):
    """JSON-safe records, including dates and unavailable numerical values."""
    if isinstance(value, pd.DataFrame):
        return clean(value.to_dict("records"))
    if isinstance(value, pd.Series):
        return clean(value.to_dict())
    if isinstance(value, dict):
        return {str(k): clean(v) for k, v in value.items()}
    if isinstance(value, (list, tuple, set)):
        return [clean(v) for v in value]
    if isinstance(value, (datetime, date, pd.Timestamp)):
        return value.isoformat()
    if isinstance(value, np.generic):
        return clean(value.item())
    if isinstance(value, Decimal):
        return clean(float(value))
    if value is pd.NA or value is pd.NaT:
        return None
    if isinstance(value, float) and not math.isfinite(value):
        return None
    if isinstance(value, Path):
        return str(value)
    return value


def latest(directory, pattern):
    return max(directory.glob(pattern), key=lambda p: p.name, default=None)


def account_scope(number):
    return hashlib.sha256((number or "local").encode()).hexdigest()[:20]


def frame(directory, pattern):
    path = latest(directory, pattern)
    return storage.read_csv(path) if path else pd.DataFrame()


def india_history():
    try:
        return json.loads(storage.read_text(kite.PORTFOLIO_HISTORY_FILE))["snapshots"]
    except FileNotFoundError:
        return []


def india_snapshot():
    history = india_history()
    return history[-1] if history else {}


def token_current():
    try:
        token = json.loads(storage.read_text(kite.TOKEN_FILE))
        now = datetime.now(kite.MARKET_TIMEZONE)
        valid_date = (
            now.date() if now.time() >= time(6) else now.date() - timedelta(days=1)
        )
        return (
            bool(token.get("access_token"))
            and date.fromisoformat(token["date"]) >= valid_date
        )
    except (OSError, ValueError, KeyError, TypeError):
        return False


def kite_client():
    if not token_current():
        raise ValueError("Connect Kite to renew today’s session in Account settings.")
    client = KiteConnect(api_key=kite.get_credential("KITE_API_KEY"))
    client.set_access_token(
        json.loads(storage.read_text(kite.TOKEN_FILE))["access_token"]
    )
    return client


def kite_login():
    return KiteConnect(api_key=kite.get_credential("KITE_API_KEY")).login_url()


def connect_kite(value):
    value = value.strip()
    if "request_token=" in value:
        value = parse_qs(urlparse(value).query).get("request_token", [""])[0]
    if not value:
        raise ValueError("Paste the one-time Kite request token or redirect URL.")
    client = KiteConnect(api_key=kite.get_credential("KITE_API_KEY"))
    session = client.generate_session(
        value, api_secret=kite.get_credential("KITE_API_SECRET")
    )
    storage.write_text(
        kite.TOKEN_FILE,
        json.dumps(
            {
                "date": datetime.now(kite.MARKET_TIMEZONE).date().isoformat(),
                "access_token": session["access_token"],
            }
        ),
    )
    return {"connected": True}


def refresh_analysis(market):
    if market == "India":
        client = kite_client()
        ranked = kite.screen_index()
        kite.monitor_portfolio(ranked, kite_client=client)
    else:
        ranked = analysis.screen_index()
        if analysis.holdings_source().exists():
            analysis.report_portfolio(ranked)
    return {"message": f"{market} analysis updated"}


def portfolios():
    """Each workspace fails independently; missing reports do not fabricate values."""
    result = {}
    try:
        snapshot = india_snapshot()
        result["india"] = {
            "holdings": snapshot.get("holdings", []),
            "as_of": snapshot.get("date"),
            "ranked": frame(INDIA_DIR, "nifty_midsmallcap_400_momentum_ranked_*.csv"),
            "replacements": frame(INDIA_DIR, "zerodha_potential_replacements_*.csv"),
            "plan": frame(INDIA_DIR, "zerodha_target_plan_*.csv"),
            "history": india_history(),
        }
        weekly = latest(INDIA_DIR, "weekly_review_*.md")
        result["india"]["weekly"] = storage.read_text(weekly) if weekly else None
    except Exception as exc:
        result["india"] = {"error": str(exc), "holdings": []}
    try:
        holdings = (
            analysis.load_holdings()
            if analysis.holdings_source().exists()
            else pd.DataFrame()
        )
        report_file = latest(US_DIR, "us_portfolio_momentum_*.csv")
        report = storage.read_csv(report_file) if report_file else pd.DataFrame()
        current = bool(report_file) and long_term.report_is_current(
            report,
            report_file,
            analysis.holdings_source(),
            accounts.ROLES_FILE,
            datetime.now().astimezone(),
        )
        if current and not holdings.empty:
            prices_by_symbol = report.drop_duplicates("symbol").set_index("symbol")[
                "price"
            ]
            holdings["price"] = holdings["symbol"].map(prices_by_symbol)
            holdings["market_value"] = pd.to_numeric(
                holdings["quantity"], errors="coerce"
            ) * pd.to_numeric(holdings["price"], errors="coerce")
        result["us"] = {
            "scope": account_scope(accounts.load_roles()["long_term"]),
            "holdings": holdings,
            "report": report if current else pd.DataFrame(),
            "report_current": current,
            "review": long_term.rebalance_review(holdings, report)
            if current and not holdings.empty
            else [],
            "picks": frame(US_DIR, "us_*_momentum_picks_*.csv"),
            "ranked": frame(US_DIR, "us_nasdaq_100_momentum_ranked_*.csv"),
        }
    except Exception as exc:
        result["us"] = {"error": str(exc), "holdings": []}
    return clean(result)


def india_plan(strategy, selected=None, exits=None):
    snapshot = india_snapshot()
    if not snapshot.get("holdings"):
        raise ValueError("Run India analysis to load your holdings first.")
    ranked = frame(INDIA_DIR, "nifty_midsmallcap_400_momentum_ranked_*.csv")
    saved = frame(INDIA_DIR, "zerodha_target_plan_*.csv")
    potential = frame(INDIA_DIR, "zerodha_potential_replacements_*.csv")
    choices = selection.candidates(snapshot, potential, ranked, saved, strategy)
    if exits is None:
        exits = [
            f"{h.get('exchange', 'NSE')}:{h['symbol']}"
            for h in snapshot["holdings"]
            if h.get("portfolio_plan") == "SELL"
        ]
    if selected is None:
        slots = max(
            0, kite.MAX_PORTFOLIO_SIZE - (len(snapshot["holdings"]) - len(exits))
        )
        selected = choices["buy"].head(slots).tolist()
    picked, buys = selection.selected_plan(
        snapshot, choices, selected, exits, kite.MAX_PORTFOLIO_SIZE
    )
    view = selection.recommended_india_view(picked, buys, ranked)
    return picked, view, choices, selected, exits


def comparison_holdings(role, live=None):
    if role == "India":
        holdings = [
            (
                h["symbol"] + (".BO" if h.get("exchange") == "BSE" else ".NS"),
                h.get("shares"),
            )
            for h in india_snapshot().get("holdings", [])
        ]
        identity = "India"
    else:
        number = accounts.load_roles()[role]
        identity = f"{role}:{number or 'local'}"
        if role == "long_term":
            holdings = [
                (r["symbol"], r.get("quantity"))
                for r in analysis.load_holdings().to_dict("records")
            ]
        else:
            if not number or not live or live.get("account_number") != number:
                raise ValueError("Refresh the saved daily trading account first.")
            holdings = [
                (r["symbol"], r.get("quantity")) for r in live.get("positions", [])
            ]
    valid = []
    for symbol, qty in holdings:
        if qty is None or not math.isfinite(float(qty)) or float(qty) < 0:
            raise ValueError(f"Share quantity unavailable for {symbol}.")
        if float(qty) > 0:
            valid.append((symbol, float(qty)))
    return valid, hashlib.sha256(identity.encode()).hexdigest()[:20]
