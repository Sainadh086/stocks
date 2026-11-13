"""Explain saved portfolio signals and dated stock-universe scans."""

import re
from copy import deepcopy
from datetime import datetime
from pathlib import Path

import pandas as pd

from shared import storage as secure_storage


def saved_data(state, path, loader, default):
    """Share dated reports within a session; callers receive independent copies."""
    path = Path(path)
    try:
        info = path.stat()
        version = (info.st_mtime_ns, info.st_size)
    except FileNotFoundError:
        version = None
    cache = dict(state.get("portfolio_report_cache", {}))
    key = str(path.resolve())
    entry = cache.get(key)
    if entry is None or entry[0] != version:
        value = loader(path) if version is not None else default
        cache[key] = (version, deepcopy(value))
        while len(cache) > 64:
            cache.pop(next(iter(cache)))
        state["portfolio_report_cache"] = cache
    return deepcopy(cache[key][1])


def dated_scans(directory, pattern):
    """Return the two newest reports from distinct scan dates."""
    scans = []
    for path in Path(directory).glob(pattern):
        match = re.search(r"_(\d{4}_\d{2}_\d{2})$", path.stem)
        if match:
            try:
                day = datetime.strptime(match.group(1), "%Y_%m_%d").date()
            except ValueError:
                continue
            scans.append((day, path))
    scans.sort(key=lambda item: item[0], reverse=True)
    return scans[:2]


def market_insight(directory, pattern, market):
    """Write a factual daily line from saved cross-sectional stock prices."""
    scans = dated_scans(directory, pattern)
    if not scans:
        return None
    day, path = scans[0]
    try:
        current = secure_storage.read_csv(path)
    except (OSError, pd.errors.ParserError, pd.errors.EmptyDataError):
        return None
    if not {"symbol", "price"}.issubset(current.columns):
        return None
    current = current[["symbol", "price"]].dropna(subset=["symbol"]).copy()
    current["price"] = pd.to_numeric(current["price"], errors="coerce")
    current = current[current["price"].gt(0)].drop_duplicates("symbol")
    if current.empty:
        return None
    if len(scans) < 2:
        return {
            "date": day,
            "previous_date": None,
            "quote": f"{market}: {len(current)} stocks were scanned; a prior scan is needed to describe their direction.",
        }
    previous_day, previous_path = scans[1]
    try:
        previous = secure_storage.read_csv(previous_path, usecols=["symbol", "price"])
    except (OSError, ValueError, pd.errors.ParserError, pd.errors.EmptyDataError):
        return None
    previous["price"] = pd.to_numeric(previous["price"], errors="coerce")
    previous = previous[previous["price"].gt(0)].drop_duplicates("symbol")
    moves = current.merge(previous, on="symbol", suffixes=("", "_previous"))
    if moves.empty:
        return {
            "date": day,
            "previous_date": previous_day,
            "quote": f"{market}: no common stocks had usable prices across the two scans.",
        }
    moves["change_pct"] = (moves["price"] / moves["price_previous"] - 1) * 100
    if moves["change_pct"].eq(0).all():
        return {
            "date": day,
            "previous_date": previous_day,
            "quote": f"{market}: saved prices were unchanged since {previous_day:%b %d}; "
            "there is no new market move to summarize. Refresh the analysis for new quotes.",
        }
    up = int(moves["change_pct"].gt(0).sum())
    down = int(moves["change_pct"].lt(0).sum())
    median = moves["change_pct"].median()
    leader = moves.loc[moves["change_pct"].idxmax()]
    laggard = moves.loc[moves["change_pct"].idxmin()]
    direction = (
        "gained ground" if up > down else "lost ground" if down > up else "was mixed"
    )
    quote = (
        f"{market} scan {direction}: {up} rose and {down} fell among "
        f"{len(moves)} stocks since {previous_day:%b %d}. Median move {median:+.1f}%; "
        f"{leader['symbol']} led ({leader['change_pct']:+.1f}%), "
        f"while {laggard['symbol']} lagged ({laggard['change_pct']:+.1f}%)."
    )
    return {
        "date": day,
        "previous_date": previous_day,
        "quote": quote,
        "theme": "bullish" if up > down else "bearish" if down > up else "mixed",
    }


def holding_direction(holdings):
    """Label observed trend and risk without treating a single signal as a trade."""
    view = holdings.copy()
    if view.empty:
        return view
    for column in ("price", "sma50", "sma200", "return_1m_pct", "weight_pct"):
        if column not in view:
            view[column] = float("nan")
        view[column] = pd.to_numeric(view[column], errors="coerce")

    def assess(row):
        risk = []
        if row.get("action") == "REPLACE":
            risk.append("REPLACE signal")
        if (
            pd.notna(row["price"])
            and pd.notna(row["sma200"])
            and row["price"] < row["sma200"]
        ):
            risk.append("below 200-day average")
        if pd.notna(row["weight_pct"]) and row["weight_pct"] > 20:
            risk.append("weight above 20%")
        if row.get("action") == "NO DATA":
            risk.append("insufficient price history")
        if risk:
            return pd.Series(["At risk", "; ".join(risk)])
        if (
            row.get("action") in ("HOLD", "STRONG HOLD")
            and pd.notna(row["price"])
            and pd.notna(row["sma50"])
            and pd.notna(row["sma200"])
            and pd.notna(row["return_1m_pct"])
            and row["price"] > row["sma50"] > row["sma200"]
            and row["return_1m_pct"] > 0
        ):
            return pd.Series(
                ["Improving", "above 50/200-day averages; positive 1-month return"]
            )
        if pd.notna(row["return_1m_pct"]) and row["return_1m_pct"] < 0:
            return pd.Series(["Watch", "negative 1-month return"])
        if row.get("action") == "WATCH":
            return pd.Series(["Watch", "momentum needs review"])
        return pd.Series(["Mixed", "no clear positive trend in saved signals"])

    view[["direction", "direction_reason"]] = view.apply(assess, axis=1)
    return view
