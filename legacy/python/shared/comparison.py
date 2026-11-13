"""Pure historical basket comparisons shared by both user interfaces."""

import math

import pandas as pd

from shared import prices

BENCHMARKS = {
    "US": {
        "S&P 500": "^GSPC",
        "Nasdaq-100": "^NDX",
        "Dow Jones": "^DJI",
        "Russell 2000": "^RUT",
    },
    "India": {"Nifty 50": "^NSEI", "Nifty Bank": "^NSEBANK", "Sensex": "^BSESN"},
}


def comparison_prices(symbol, period):
    # Price return uses split-adjusted prices for both providers, excluding dividends.
    frame = prices.history(symbol, period=period, auto_adjust=False)
    close = frame.Close.copy()
    index = pd.to_datetime(close.index)
    if index.tz is not None:
        index = index.tz_localize(None)
    close.index = index.normalize()
    close = close[~close.index.duplicated(keep="last")].sort_index()
    return close, frame.attrs.get("source", "Unknown")


def basket_comparison(holdings, histories, benchmark, benchmark_prices):
    """Reconstruct today's basket; never present it as actual account performance."""
    shares = {}
    for symbol, quantity in holdings:
        quantity = float(quantity)
        if not math.isfinite(quantity) or quantity <= 0:
            raise ValueError("Each holding needs a positive, finite share quantity.")
        shares[symbol] = shares.get(symbol, 0) + quantity
    if not shares:
        raise ValueError("No current stock holdings available.")
    missing = [
        symbol
        for symbol in shares
        if symbol not in histories or histories[symbol].empty
    ]
    if missing:
        raise ValueError("History unavailable for holdings: " + ", ".join(missing))
    columns = {
        symbol: pd.to_numeric(histories[symbol], errors="coerce") for symbol in shares
    }
    columns["__benchmark__"] = pd.to_numeric(benchmark_prices, errors="coerce")
    common = (
        pd.DataFrame(columns)
        .replace([float("inf"), float("-inf")], float("nan"))
        .dropna()
    )
    common = common[(common > 0).all(axis=1)].sort_index()
    if len(common) < 2:
        raise ValueError(
            "At least two common price dates are needed for all holdings and the benchmark."
        )
    value = common[list(shares)].mul(pd.Series(shares)).sum(axis=1)
    return pd.DataFrame(
        {
            "Current holdings basket": value.div(value.iloc[0]).mul(100),
            benchmark: common["__benchmark__"]
            .div(common["__benchmark__"].iloc[0])
            .mul(100),
        }
    )
