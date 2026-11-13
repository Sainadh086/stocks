"""Explicit, encrypted account roles; unavailable accounts never replace saved choices."""

import hashlib
import json
import math
from datetime import datetime, timezone

from shared import storage
from shared.paths import US_DIR

ROLES_FILE = US_DIR / "account_roles.json"


def load_roles():
    try:
        roles = json.loads(storage.read_text(ROLES_FILE))
    except FileNotFoundError:
        return {"long_term": None, "trading": None}
    if not isinstance(roles, dict):
        raise ValueError("Saved account roles are invalid. Review account settings.")
    result = {role: roles.get(role) for role in ("long_term", "trading")}
    if any(
        number is not None and (not isinstance(number, str) or not number)
        for number in result.values()
    ):
        raise ValueError("Saved account identifiers are invalid.")
    if result["trading"] and result["trading"] == result["long_term"]:
        raise ValueError("Saved investing and trading accounts must be different.")
    return result


def eligible(account):
    return (
        bool(account.get("account_number"))
        and not (account.get("deactivated") or account.get("permanently_deactivated"))
        and account.get("state", "active") == "active"
    )


def save_roles(long_term, trading, available):
    choices = {a["account_number"]: a for a in available if eligible(a)}
    if not long_term or not trading:
        raise ValueError("Select both a long-term account and a trading account.")
    if long_term == trading:
        raise ValueError("Choose different accounts for investing and trading.")
    if long_term not in choices or trading not in choices:
        raise ValueError(
            "A selected account is unavailable. Reload accounts and try again."
        )
    if choices[trading].get("agentic_allowed") is not True:
        raise ValueError("The trading account must support Robinhood Agentic trading.")
    storage.write_text(
        ROLES_FILE,
        json.dumps(
            {
                "long_term": long_term,
                "trading": trading,
                "updated_at": datetime.now(timezone.utc).isoformat(),
            }
        ),
    )


def holdings_path(number):
    token = hashlib.sha256(number.encode()).hexdigest()[:20]
    return ROLES_FILE.parent / f"long_term_holdings_{token}.csv"


def selected_trading(available):
    number = load_roles()["trading"]
    return (
        number
        if number
        and any(
            a.get("account_number") == number
            and eligible(a)
            and a.get("agentic_allowed") is True
            for a in available
        )
        else None
    )


def require_trading_role(number):
    roles = load_roles()
    if roles["long_term"] == number:
        raise ValueError("The long-term account cannot be used for intraday trading.")
    if roles["trading"] and roles["trading"] != number:
        raise ValueError(
            "Trading account selection changed. Review the selected account."
        )


def trading_settings_path(number):
    token = hashlib.sha256(number.encode()).hexdigest()[:20]
    return ROLES_FILE.parent / f"live_trading_settings_{token}.json"


def validate_trading_settings(budget, reserve):
    try:
        budget, reserve = float(budget), float(reserve)
    except (TypeError, ValueError) as exc:
        raise ValueError("Enter a valid live budget and cash reserve.") from exc
    if (
        not math.isfinite(budget)
        or budget <= 0
        or not math.isfinite(reserve)
        or not 0 <= reserve <= 100
    ):
        raise ValueError(
            "Live budget must be positive and reserve must be between 0% and 100%."
        )
    return budget, reserve


def load_trading_settings(number):
    """Live settings belong to this account; never read or import paper settings."""
    try:
        record = json.loads(storage.read_text(trading_settings_path(number)))
    except FileNotFoundError:
        return None, None
    if (
        not isinstance(record, dict)
        or record.get("account_number") != number
        or record.get("version") != 1
    ):
        raise ValueError(
            "Saved live settings are invalid for this account. Save them again."
        )
    return validate_trading_settings(record.get("budget"), record.get("reserve_pct"))


def save_trading_settings(number, budget, reserve):
    if load_roles()["trading"] != number:
        raise ValueError(
            "Select and save this daily trading account before saving live settings."
        )
    require_trading_role(number)
    budget, reserve = validate_trading_settings(budget, reserve)
    storage.write_text(
        trading_settings_path(number),
        json.dumps(
            dict(
                version=1,
                account_number=number,
                budget=budget,
                reserve_pct=reserve,
                updated_at=datetime.now(timezone.utc).isoformat(),
            ),
            allow_nan=False,
        ),
    )
