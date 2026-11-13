"""US stock entry watchlist and optional portfolio report.

Install: pip install pandas numpy yfinance beautifulsoup4
Edit us_stocks/us_holdings.csv to list your current stocks (symbol,quantity).
Run: python -m brokers.robinhood.analysis
Run only the index screen: python -m brokers.robinhood.analysis --index-only

This script reads a local holdings list. It does not log in to Robinhood or place orders.
"""

import argparse
import fcntl
import re
from datetime import datetime, time, timedelta
from urllib.request import Request, urlopen
from zoneinfo import ZoneInfo

import pandas as pd
from bs4 import BeautifulSoup

from brokers.robinhood import accounts, long_term
from shared import momentum
from shared import storage as secure_storage
from shared.paths import US_DIR

# Edit these settings for your US stock universe and portfolio.
INDEX_NAME = "Nasdaq-100"
INDEX_URL = "https://en.wikipedia.org/wiki/List_of_NASDAQ-100_companies"
# To use your own index/watchlist, set this to a CSV path with a symbol column.
INDEX_SYMBOLS_CSV = None
US_STOCKS_DIR = US_DIR
HOLDINGS_CSV = US_STOCKS_DIR / "us_holdings.csv"
ROBINHOOD_HOLDINGS_CSV = US_STOCKS_DIR / "robinhood_holdings.csv"
ROBINHOOD_CONNECTION_FILE = US_STOCKS_DIR / "robinhood_connection.json"
MAX_PICKS = 4
MAX_POSITION_WEIGHT_PCT = 25.0
DEFAULT_US_BUDGET = 10_000

MARKET_TIMEZONE = ZoneInfo("America/New_York")
MARKET_OPEN = time(9, 30)
MARKET_CLOSE = time(16, 0)
CACHE_HOURS = 1


def normalize_symbol(symbol):
    """Yahoo Finance uses a hyphen for US share-class symbols."""
    return str(symbol).strip().upper().replace(".", "-")


def load_index_symbols():
    if INDEX_SYMBOLS_CSV:
        universe = secure_storage.read_csv(INDEX_SYMBOLS_CSV)
        column = next((c for c in universe if c.lower().strip() == "symbol"), None)
        if column is None:
            raise ValueError("INDEX_SYMBOLS_CSV needs a symbol column.")
        raw_symbols = universe[column].dropna().tolist()
    else:
        request = Request(INDEX_URL, headers={"User-Agent": "Mozilla/5.0"})
        with urlopen(request, timeout=30) as response:
            soup = BeautifulSoup(response.read(), "html.parser")
        table = soup.find("table", id="constituents")
        if table is None:
            raise ValueError("Could not find the Nasdaq-100 constituent table.")
        raw_symbols = [
            row.find("td").get_text(strip=True)
            for row in table.find_all("tr")
            if row.find("td") is not None
        ]

    symbols = [normalize_symbol(s) for s in raw_symbols]
    symbols = [s for s in symbols if re.fullmatch(r"[A-Z0-9-]+", s)]
    if not symbols:
        raise ValueError("The index list contains no usable stock symbols.")
    return list(dict.fromkeys(symbols))


def holdings_source():
    number = accounts.load_roles()["long_term"]
    if number:
        return accounts.holdings_path(number)
    return HOLDINGS_CSV


def load_holdings(source=None):
    source = source if source is not None else holdings_source()
    if not source.exists():
        raise FileNotFoundError(
            f"Create {HOLDINGS_CSV} with a symbol column and your current stock tickers."
        )
    holdings = secure_storage.read_csv(source)
    if "symbol" not in holdings.columns:
        raise ValueError(f"{source} needs a symbol column.")
    holdings = holdings.dropna(subset=["symbol"]).copy()
    holdings["symbol"] = holdings["symbol"].map(normalize_symbol)
    holdings = holdings[holdings["symbol"].str.fullmatch(r"[A-Z0-9-]+")]
    if "quantity" in holdings:
        holdings["quantity"] = pd.to_numeric(holdings["quantity"], errors="coerce")
        holdings = holdings.dropna(subset=["quantity"])
        return holdings.groupby("symbol", as_index=False)["quantity"].sum()
    return holdings.drop_duplicates("symbol")


def market_is_open(now):
    local = now.astimezone(MARKET_TIMEZONE)
    return local.weekday() < 5 and MARKET_OPEN <= local.time() < MARKET_CLOSE


def cache_is_fresh(cached_at, now):
    cached = cached_at.astimezone(MARKET_TIMEZONE)
    current = now.astimezone(MARKET_TIMEZONE)
    if cached.date() != current.date():
        return False
    if not market_is_open(now):
        return True
    return cached.time() >= MARKET_OPEN and current - cached < timedelta(
        hours=CACHE_HOURS
    )


def recommended_portfolio(picks, budget=DEFAULT_US_BUDGET):
    """Equal-weight with a per-stock cap; unallocated example budget stays in cash."""
    if budget <= 0:
        raise ValueError("US portfolio budget must be positive.")
    plan = picks.copy()
    if plan.empty:
        return plan
    prices = pd.to_numeric(plan["price"], errors="coerce")
    plan = plan.loc[prices.gt(0) & prices.notna()].copy()
    if plan.empty:
        return plan
    weight = min(100 / len(plan), MAX_POSITION_WEIGHT_PCT)
    dollars = budget * weight / 100
    plan["target_weight_pct"] = weight
    plan["target_usd"] = dollars
    plan["estimated_shares"] = (dollars / pd.to_numeric(plan["price"])).round(3)
    return plan


def screen_index(now=None, budget=DEFAULT_US_BUDGET):
    """Serialize scan writers across the paper worker, live monitor, and CLI."""
    US_STOCKS_DIR.mkdir(parents=True, exist_ok=True)
    with (US_STOCKS_DIR / "strategy_scan.lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        try:
            return _screen_index(now=now, budget=budget)
        finally:
            fcntl.flock(lock, fcntl.LOCK_UN)


def _screen_index(now=None, budget=DEFAULT_US_BUDGET):
    now = now or datetime.now(MARKET_TIMEZONE)
    slug = re.sub(r"[^a-z0-9]+", "_", INDEX_NAME.lower()).strip("_")
    output_dir = US_STOCKS_DIR
    output_dir.mkdir(parents=True, exist_ok=True)
    # Versioned to avoid reusing the older cache populated from the S&P 500 page.
    cache_file = output_dir / f"us_{slug}_momentum_v2_cache.csv"
    ranked = None

    if cache_file.exists():
        cached_at = datetime.fromtimestamp(cache_file.stat().st_mtime, MARKET_TIMEZONE)
        if cache_is_fresh(cached_at, now):
            try:
                ranked = secure_storage.read_csv(cache_file).fillna(
                    {"warnings": "", "strengths": ""}
                )
                if ranked.empty or not {"symbol", "action", "momentum_score"}.issubset(
                    ranked
                ):
                    ranked = None
                else:
                    print(
                        f"Using cached {INDEX_NAME} screen from {cached_at:%Y-%m-%d %H:%M} ET."
                    )
            except (OSError, pd.errors.ParserError, pd.errors.EmptyDataError):
                ranked = None

    refreshed = ranked is None
    if refreshed:
        symbols = load_index_symbols()
        print(f"Screening {len(symbols)} stocks in {INDEX_NAME}...")
        results = []
        for number, symbol in enumerate(symbols, start=1):
            print(f"[{number}/{len(symbols)}] {symbol}")
            result = momentum.analyze_stock(symbol, "US")
            if result:
                results.append(result)
        if not results:
            print("No index stocks had enough usable price history.")
            empty = pd.DataFrame(columns=["symbol", "price", "long_term_eligible"])
            date = now.strftime("%Y_%m_%d")
            secure_storage.write_csv(
                empty, output_dir / f"us_{slug}_momentum_picks_{date}.csv", index=False
            )
            return pd.DataFrame()
        ranked = pd.DataFrame(results).sort_values(
            ["momentum_score", "return_6m_pct"], ascending=False
        )

    potential = ranked.apply(momentum.assess_potential, axis=1, result_type="expand")
    ranked["potential"] = potential[0]
    ranked["potential_reasons"] = potential[1]
    if refreshed:
        secure_storage.write_csv(ranked, cache_file, index=False)

    # Entry watchlist: trend is up, recent returns are positive, and RSI is not stretched.
    entry_candidates = ranked[
        ranked["action"].isin(["STRONG HOLD", "HOLD"])
        & (ranked["price"] > ranked["sma50"])
        & (ranked["sma50"] > ranked["sma200"])
        & (ranked["return_1m_pct"] > 0)
        & (ranked["return_3m_pct"] > 0)
        & (ranked["return_6m_pct"] > 0)
        & ranked["rsi"].between(45, 70)
    ]
    fundamentals = long_term.Fundamentals()
    benchmark = momentum.analyze_stock("^GSPC", "US")
    benchmark_return = benchmark.get("return_6m_pct") if benchmark else None
    qualified = long_term.enrich(entry_candidates, fundamentals, benchmark_return)
    fundamentals.save()
    # Never recycle technical-only picks when statement data is unavailable.
    if not qualified.empty:
        qualified = qualified[qualified["long_term_eligible"]].sort_values(
            ["long_term_score", "momentum_score"], ascending=False
        )
    picks = recommended_portfolio(qualified.head(MAX_PICKS), budget)
    ranked = (
        ranked.merge(
            qualified[
                ["symbol"] + [column for column in qualified if column not in ranked]
            ],
            on="symbol",
            how="left",
            validate="one_to_one",
        )
        if not qualified.empty
        else ranked
    )
    if "long_term_eligible" not in ranked:
        ranked["long_term_eligible"] = False
    else:
        ranked["long_term_eligible"] = ranked["long_term_eligible"].eq(True)
    ranked.attrs["benchmark_return_6m_pct"] = benchmark_return
    date = now.strftime("%Y_%m_%d")
    ranked_file = output_dir / f"us_{slug}_momentum_ranked_{date}.csv"
    picks_file = output_dir / f"us_{slug}_momentum_picks_{date}.csv"
    secure_storage.write_csv(ranked, ranked_file, index=False)
    secure_storage.write_csv(picks, picks_file, index=False)
    print(f"\nRECOMMENDED US LONG-TERM STOCK PORTFOLIO: {INDEX_NAME}")
    if picks.empty:
        print(
            "No stocks pass both the business-quality and trend entry filters. Cash is an option."
        )
    else:
        print(
            picks[
                [
                    "symbol",
                    "price",
                    "target_weight_pct",
                    "target_usd",
                    "estimated_shares",
                    "momentum_score",
                    "return_3m_pct",
                    "return_6m_pct",
                    "rsi",
                    "potential",
                    "potential_reasons",
                ]
            ]
            .round(2)
            .to_string(index=False)
        )
        print(
            f"Equal weights capped at {MAX_POSITION_WEIGHT_PCT:g}% per stock; "
            f"${budget - picks['target_usd'].sum():,.2f} of the example budget remains unallocated."
        )
    print(
        "This Nasdaq-100 momentum portfolio remains concentrated in US large-cap stocks. Prices and share estimates can change."
    )
    print(f"Ranked index: {ranked_file}")
    print(f"Selected stocks: {picks_file}")
    return ranked


def report_portfolio(index_ranked):
    source = holdings_source()
    holdings = load_holdings(source)
    if holdings.empty:
        print("\nNo US holdings yet. The entry watchlist above is ready to use.")
        print(f"Add symbols to {HOLDINGS_CSV} when you want a portfolio report.")
        return

    results = []
    for symbol in holdings["symbol"]:
        print(f"Analyzing holding {symbol}...")
        result = momentum.analyze_stock(symbol, "US")
        if result is None:
            result = momentum.unscored_holding(
                {"tradingsymbol": symbol, "exchange": "US"}
            )
        results.append(result)
    fundamentals = long_term.Fundamentals()
    report = long_term.enrich(
        pd.DataFrame(results).sort_values("momentum_score", ascending=False),
        fundamentals,
        index_ranked.attrs.get("benchmark_return_6m_pct"),
    )
    fundamentals.save()
    report["technical_action"] = report["action"]
    report["action"] = report["long_term_action"]
    report["holdings_source"] = str(source.resolve())
    report["replace_with"] = ""
    report["replacement_potential"] = ""
    report["replacement_reasons"] = ""

    pairs = []
    if not index_ranked.empty:
        candidates = index_ranked[
            index_ranked.get(
                "long_term_eligible", pd.Series(False, index=index_ranked.index)
            ).eq(True)
            & ~index_ranked["symbol"].isin(set(holdings["symbol"]))
        ].drop_duplicates("symbol")
        candidate_rows = iter(candidates.itertuples(index=False))
        to_replace = report[report["action"] == "EXIT REVIEW"].sort_values(
            "momentum_score"
        )
        for row_index, row in to_replace.iterrows():
            candidate = next(candidate_rows, None)
            if candidate is None:
                break
            potential, reason = momentum.assess_potential(
                pd.Series(candidate._asdict())
            )
            report.at[row_index, "replace_with"] = candidate.symbol
            report.at[row_index, "replacement_potential"] = potential
            report.at[row_index, "replacement_reasons"] = reason
            pairs.append((row["symbol"], candidate.symbol, potential, reason))

    print("\nUS LONG-TERM BUSINESS AND MOMENTUM REPORT")
    columns = [
        "symbol",
        "price",
        "momentum_score",
        "action",
        "return_1m_pct",
        "return_3m_pct",
        "return_6m_pct",
        "warnings",
        "long_term_score",
        "long_term_reasons",
    ]
    print(report[columns].round(2).to_string(index=False))
    print("\nPORTFOLIO SUMMARY")
    for action in ["HOLD", "WATCH", "EXIT REVIEW", "REVIEW"]:
        symbols = report.loc[report["action"] == action, "symbol"].tolist()
        print(f"{action:12}: {', '.join(symbols) if symbols else '-'}")

    if (report["action"] == "EXIT REVIEW").any():
        print(f"\nREPLACEMENTS FROM {INDEX_NAME}")
        for old, new, _, _ in pairs:
            print(f"  {old} -> {new}")
        if len(pairs) < (report["action"] == "EXIT REVIEW").sum():
            print(
                "  No qualified replacement for the remaining exit reviews; proceeds may stay in cash."
            )
        if pairs:
            table = pd.DataFrame(
                [(new, potential, reason) for _, new, potential, reason in pairs],
                columns=["stock", "potential", "reason"],
            )
            print("\nPOTENTIAL PICKS")
            print(table.to_string(index=False))
            print("Potential reflects current trend signals, not a return forecast.")

    US_STOCKS_DIR.mkdir(parents=True, exist_ok=True)
    output = (
        US_STOCKS_DIR
        / f"us_portfolio_momentum_{datetime.now(MARKET_TIMEZONE):%Y_%m_%d}.csv"
    )
    secure_storage.write_csv(report, output, index=False)
    print(f"\nReport saved to {output}")
    return report


if __name__ == "__main__":
    parser = argparse.ArgumentParser(
        description="US stock recommendations and portfolio report"
    )
    parser.add_argument("--index-only", action="store_true")
    parser.add_argument(
        "--budget",
        type=float,
        default=DEFAULT_US_BUDGET,
        help="USD amount used to estimate recommended share counts",
    )
    args = parser.parse_args()
    index_ranked = screen_index(budget=args.budget)
    if not args.index_only:
        report_portfolio(index_ranked)
