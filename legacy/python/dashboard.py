"""Local dashboard for the India and US stock analysis scripts.

Run: streamlit run stocks/dashboard.py --server.address 127.0.0.1
"""

import json
import re
from contextlib import redirect_stdout
from datetime import datetime, time, timedelta
from html import escape
from io import StringIO
from pathlib import Path
from urllib.parse import parse_qs, quote, urlparse

import pandas as pd
import streamlit as st
from kiteconnect import KiteConnect
from kiteconnect.exceptions import TokenException

from brokers.kite import analysis as kite
from brokers.kite import selection as india_candidate_selection
from brokers.kite import ui as kite_ui
from brokers.kite.selection import recommended_india_view
from brokers.robinhood import accounts as account_roles
from brokers.robinhood import analysis as us_stocks
from brokers.robinhood import client as robinhood_mcp
from brokers.robinhood import long_term, performance
from brokers.robinhood import ui as live_trading_ui
from shared import market as market_ui
from shared import portfolio as portfolio_insights
from shared import storage as secure_storage
from trading import ui as us_trading_lab

st.set_page_config(page_title="varshan", page_icon=":material/finance:", layout="wide")

INDIA_DIR = Path(kite.INDIA_STOCKS_DIR)
US_DIR = us_stocks.US_STOCKS_DIR
KITE_REDIRECT_URL = "http://127.0.0.1:8501/"
LOGO_FILE = Path(__file__).resolve().parent / "assets" / "varshan-logo.svg"


def latest_file(directory, pattern):
    return max(directory.glob(pattern), key=lambda path: path.name, default=None)


def read_csv(path):
    if path is None:
        return pd.DataFrame()
    try:
        return portfolio_insights.saved_data(
            st.session_state, path, secure_storage.read_csv, pd.DataFrame()
        )
    except (OSError, pd.errors.EmptyDataError, pd.errors.ParserError):
        return pd.DataFrame()


def load_history():
    try:
        return portfolio_insights.saved_data(
            st.session_state,
            kite.PORTFOLIO_HISTORY_FILE,
            lambda path: json.loads(secure_storage.read_text(path)).get(
                "snapshots", []
            ),
            [],
        )
    except (OSError, ValueError, TypeError):
        return []


def saved_token_is_current():
    try:
        with secure_storage.open_text(kite.TOKEN_FILE) as file:
            data = json.load(file)
        token_date = datetime.strptime(data["date"], "%Y-%m-%d").date()
        now = datetime.now(kite.MARKET_TIMEZONE)
        valid_date = (
            now.date() if now.time() >= time(6) else now.date() - timedelta(days=1)
        )
        return token_date >= valid_date and bool(data.get("access_token"))
    except (OSError, ValueError, KeyError, TypeError):
        return False


def kite_client():
    """Use the saved session without invoking the CLI's interactive login."""
    if not saved_token_is_current():
        raise TokenException("Kite session needs renewal")
    client = KiteConnect(api_key=kite.get_credential("KITE_API_KEY"))
    with secure_storage.open_text(kite.TOKEN_FILE) as file:
        client.set_access_token(json.load(file)["access_token"])
    client.profile()
    return client


def request_token_from_input(value):
    value = value.strip()
    if "request_token=" in value:
        parsed = parse_qs(urlparse(value).query)
        return parsed.get("request_token", [""])[0].strip()
    return value


def connect_with_request_token(client, request_token):
    """Exchange a one-time request token and save the resulting session locally."""
    session = client.generate_session(
        request_token, api_secret=kite.get_credential("KITE_API_SECRET")
    )
    client.set_access_token(session["access_token"])
    token_data = {
        "date": datetime.now(kite.MARKET_TIMEZONE).date().isoformat(),
        "access_token": session["access_token"],
    }
    INDIA_DIR.mkdir(parents=True, exist_ok=True)
    secure_storage.write_text(kite.TOKEN_FILE, json.dumps(token_data))
    st.session_state["kite_needs_login"] = False
    st.session_state["notice"] = "Kite connected. You can run the India analysis."


def handle_kite_redirect():
    """Complete login when Kite returns to this dashboard with a request token."""
    request_token = st.query_params.get("request_token")
    if not request_token:
        return
    status = st.query_params.get("status")
    st.query_params.clear()
    if status not in (None, "success"):
        st.session_state["kite_login_error"] = (
            "Kite login did not succeed. Please try again."
        )
        st.session_state["kite_needs_login"] = True
        return
    try:
        client = KiteConnect(api_key=kite.get_credential("KITE_API_KEY"))
        connect_with_request_token(client, request_token)
        st.session_state["kite_return_to_dashboard"] = True
    except Exception as exc:
        st.session_state["kite_login_error"] = (
            f"Kite could not accept the redirected token ({type(exc).__name__}). Please log in again."
        )
        st.session_state["kite_needs_login"] = True
    st.rerun()


def kite_login_completed():
    if saved_token_is_current():
        st.session_state["kite_needs_login"] = False
        st.session_state.pop("kite_login_error", None)
        st.session_state["notice"] = "Kite connected. You can run the India analysis."
        st.rerun(scope="app")


@st.dialog("Connect your Kite account")
def kite_login_dialog():
    try:
        client = KiteConnect(api_key=kite.get_credential("KITE_API_KEY"))
        login_url = client.login_url()
    except Exception:
        st.error("Set KITE_API_KEY and KITE_API_SECRET in stocks/.env first.")
        return
    if "kite_login_error" in st.session_state:
        st.error(st.session_state.pop("kite_login_error"))
    st.write(
        "Open Kite and log in. You will return to this tab automatically."
        if kite_ui.automatic_handoff_available()
        else "Open Kite and log in, then return to this tab."
    )
    st.caption(f"Set the Kite app redirect URL to {KITE_REDIRECT_URL}")
    kite_ui.login_button(login_url, KITE_REDIRECT_URL, kite_login_completed)
    st.caption(
        "If Kite redirects elsewhere, paste the request token or full redirect URL below."
    )
    with st.form("kite_token_form"):
        raw_token = st.text_input("Request token or full redirect URL", type="password")
        submitted = st.form_submit_button("Save and connect", type="primary")
    if submitted:
        request_token = request_token_from_input(raw_token)
        if not request_token:
            st.error("Enter the request token from the redirect URL.")
            return
        try:
            connect_with_request_token(client, request_token)
            st.rerun()
        except Exception as exc:
            st.error(
                f"Kite could not accept that token ({type(exc).__name__}). Please log in again."
            )


def run_india_analysis():
    client = kite_client()
    output = StringIO()
    with redirect_stdout(output):
        ranked = kite.screen_index()
        kite.monitor_portfolio(ranked, kite_client=client)
    return output.getvalue()


def run_us_analysis():
    output = StringIO()
    with redirect_stdout(output):
        ranked = us_stocks.screen_index()
        if us_stocks.holdings_source().exists():
            us_stocks.report_portfolio(ranked)
    return output.getvalue()


def refresh_reports(market):
    """One refresh action shared by each workspace and the sidebar."""
    try:
        with st.spinner(f"Refreshing {market} analysis…"):
            if market == "India":
                st.session_state["india_log"] = run_india_analysis()
            else:
                st.session_state["us_log"] = run_us_analysis()
        st.session_state["notice"] = f"{market} analysis updated."
        st.session_state.pop("analysis_refresh_error", None)
    except TokenException:
        st.session_state["kite_needs_login"] = True
    except Exception as exc:
        st.session_state["analysis_refresh_error"] = (
            f"{market} analysis failed: {type(exc).__name__}: {exc}"
        )


def show_download(path, label, key):
    if path is not None:
        st.download_button(
            label,
            secure_storage.read_bytes(path),
            file_name=path.name,
            mime="text/csv",
            key=key,
        )


def stock_urls(symbol, exchange):
    """Build quote pages for a known exchange and a plain ticker symbol."""
    if pd.isna(symbol):
        return None, None
    symbol = str(symbol).strip().upper()
    if not re.fullmatch(r"[A-Z0-9._-]+", symbol):
        return None, None
    exchange = str(exchange).strip().upper()
    yahoo_suffix = {"NSE": ".NS", "BSE": ".BO", "NASDAQ": "", "US": ""}.get(exchange)
    tradingview_exchange = {
        "NSE": "NSE",
        "BSE": "BSE",
        "NASDAQ": "NASDAQ",
        "US": "NASDAQ",
    }.get(exchange)
    if yahoo_suffix is None or tradingview_exchange is None:
        return None, None
    yahoo = (
        "https://finance.yahoo.com/quote/"
        + quote(symbol + yahoo_suffix, safe=".-")
        + "/"
    )
    tradingview = (
        "https://www.tradingview.com/symbols/"
        + quote(tradingview_exchange + "-" + symbol, safe=".-")
        + "/"
    )
    return yahoo, tradingview


def linked_stock_table(
    frame, stock_column, columns, exchange_column=None, default_exchange="NSE"
):
    """Render a compact report table with links that open in a new browser tab."""
    headers = columns + ["Yahoo Finance", "TradingView"]
    head = "".join(
        f"<th>{escape(column.replace('_', ' ').title())}</th>" for column in headers
    )
    rows = []
    for _, item in frame.iterrows():
        cells = []
        for column in columns:
            value = item.get(column)
            text = "—" if pd.isna(value) else str(value)
            cells.append(f"<td>{escape(text)}</td>")
        exchange = (
            item.get(exchange_column, default_exchange)
            if exchange_column
            else default_exchange
        )
        yahoo, tradingview = stock_urls(item[stock_column], exchange)
        for url, label in ((yahoo, "Yahoo ↗"), (tradingview, "TradingView ↗")):
            link = (
                f'<a href="{escape(url, quote=True)}" target="_blank" '
                f'rel="noopener noreferrer">{label}</a>'
                if url
                else "—"
            )
            cells.append(f"<td>{link}</td>")
        rows.append("<tr>" + "".join(cells) + "</tr>")
    st.html(
        '<div style="overflow-x:auto"><table style="width:100%;border-collapse:collapse">'
        f"<thead><tr>{head}</tr></thead><tbody>{''.join(rows)}</tbody></table></div>"
        "<style>th,td{padding:9px 12px;border-bottom:1px solid #8884;text-align:left;white-space:nowrap}"
        "th{font-weight:600}td a{color:#2d78c4;text-decoration:none}td a:hover{text-decoration:underline}</style>"
    )


def history_chart_data(history):
    return pd.DataFrame(
        [
            {
                "date": item["date"],
                "score": item.get("score"),
                "stocks": len(item.get("holdings", [])),
                "flagged": sum(
                    holding.get("action") in ("WATCH", "REPLACE", "NO DATA")
                    for holding in item.get("holdings", [])
                ),
            }
            for item in history
        ]
    )


def current_risk_table(holdings, report):
    """Display observed concentration, trend, and volatility indicators."""
    if holdings.empty:
        return pd.DataFrame()
    details = report.copy()
    if not details.empty and {"symbol", "exchange"}.issubset(details.columns):
        details = details.drop_duplicates(["symbol", "exchange"])
        details = details[
            [
                column
                for column in (
                    "symbol",
                    "exchange",
                    "price",
                    "atr",
                    "rsi",
                    "sma50",
                    "sma200",
                    "return_1m_pct",
                    "warnings",
                )
                if column in details.columns
            ]
        ]
        view = holdings.merge(details, on=["symbol", "exchange"], how="left")
    else:
        view = holdings.copy()
    for column in ("price", "atr", "rsi", "sma200", "weight_pct"):
        if column not in view:
            view[column] = float("nan")
        view[column] = pd.to_numeric(view[column], errors="coerce")
    view["atr_pct"] = view["atr"].div(view["price"]).mul(100).round(1)

    def flags(row):
        found = []
        if pd.notna(row["weight_pct"]) and row["weight_pct"] > 20:
            found.append("weight >20%")
        if row["action"] in ("WATCH", "REPLACE", "NO DATA"):
            found.append(row["action"].lower())
        if pd.notna(row["atr_pct"]) and row["atr_pct"] > kite.MAX_ATR_PCT:
            found.append(f"ATR >{kite.MAX_ATR_PCT:g}%")
        if pd.notna(row["rsi"]) and row["rsi"] > 75:
            found.append("RSI >75")
        if (
            pd.notna(row["price"])
            and pd.notna(row["sma200"])
            and row["price"] < row["sma200"]
        ):
            found.append("below 200 SMA")
        return ", ".join(found) or "—"

    view["risk_flags"] = view.apply(flags, axis=1)
    return view


def weekly_baseline(history):
    if len(history) < 2:
        return None
    latest = history[-1]
    current_date = datetime.fromisoformat(latest["date"]).date()
    week_start = (current_date - timedelta(days=current_date.weekday())).isoformat()
    return (
        next(
            (item for item in reversed(history[:-1]) if item["date"] < week_start), None
        )
        or history[0]
    )


def report_for_snapshot(snapshot):
    path = INDIA_DIR / f"zerodha_momentum_{snapshot['date'].replace('-', '_')}.csv"
    if path.exists():
        return read_csv(path)
    return pd.DataFrame()


def holding_weights(holdings):
    result = holdings.copy()
    values = pd.to_numeric(
        result.get("market_value_inr", pd.Series(float("nan"), index=result.index)),
        errors="coerce",
    )
    if "weight_pct" not in result or result["weight_pct"].isna().all():
        result["weight_pct"] = values.div(values.sum()).mul(100)
    return result


def technical_flags(frame):
    result = frame.copy()
    for column in ("price", "atr", "rsi", "sma200"):
        result[column] = pd.to_numeric(result.get(column), errors="coerce")
    result["atr_pct"] = result["atr"].div(result["price"]).mul(100).round(1)
    result["risk_flags"] = result.apply(
        lambda row: (
            ", ".join(
                flag
                for flag, present in (
                    (f"ATR >{kite.MAX_ATR_PCT:g}%", row["atr_pct"] > kite.MAX_ATR_PCT),
                    ("RSI >75", row["rsi"] > 75),
                    ("below 200 SMA", row["price"] < row["sma200"]),
                )
                if present
            )
            or "—"
        ),
        axis=1,
    )
    return result


def long_term_holdings():
    empty = pd.DataFrame(columns=["symbol", "quantity"])
    try:
        source = us_stocks.holdings_source()
        holdings = portfolio_insights.saved_data(
            st.session_state, source, us_stocks.load_holdings, empty
        )
        st.session_state.pop("us_holdings_error", None)
        return holdings
    except (OSError, ValueError, RuntimeError) as exc:
        st.session_state["us_holdings_error"] = str(exc)
        return empty


def benchmark_holdings(choice):
    holdings = []
    if choice == "India":
        history = load_history()
        snapshot = history[-1] if history else {}
        for position in snapshot.get("holdings", []):
            quantity = pd.to_numeric(position.get("shares"), errors="coerce")
            if pd.isna(quantity) or quantity < 0:
                raise ValueError(
                    f"Share quantity unavailable for {position.get('symbol', 'a holding')}."
                )
            if quantity > 0:
                suffix = ".BO" if position.get("exchange") == "BSE" else ".NS"
                holdings.append((position["symbol"] + suffix, float(quantity)))
        return (
            holdings,
            "India",
            ("India", str(Path(kite.PORTFOLIO_HISTORY_FILE).resolve())),
            "India · saved holdings snapshot",
        )
    role = "trading" if choice == "US trading" else "long_term"
    number = account_roles.load_roles()[role]
    identity = (role, number)
    label = f"{choice} · " + (
        f"account ending {number[-4:]}"
        if number
        else "local holdings"
        if role == "long_term"
        else "select an account in Account settings"
    )
    if role == "long_term":
        positions = long_term_holdings().to_dict("records")
    else:
        snapshot = st.session_state.get("live_snapshot") or {}
        positions = (
            snapshot.get("positions", [])
            if number and snapshot.get("account_number") == number
            else []
        )
        if not positions:
            label += " · waiting for current monitored positions"
    for position in positions:
        quantity = pd.to_numeric(position.get("quantity"), errors="coerce")
        if pd.isna(quantity) or quantity < 0:
            raise ValueError(
                f"Share quantity unavailable for {position.get('symbol', 'a holding')}."
            )
        if quantity > 0:
            holdings.append((position["symbol"], float(quantity)))
    return holdings, "US", identity, label


def show_us_holdings(actual):
    st.markdown("**Your US holdings**")
    if error := st.session_state.get("us_holdings_error"):
        st.warning(f"US holdings are unavailable: {error}")
        return
    source = us_stocks.holdings_source()
    if source.exists():
        actual = actual.copy()
        report_file = latest_file(US_DIR, "us_portfolio_momentum_*.csv")
        report = read_csv(report_file)
        report_is_current = long_term.report_is_current(
            report, report_file, source, account_roles.ROLES_FILE
        )
        if (
            not actual.empty
            and report_is_current
            and not report.empty
            and "symbol" in report
            and "long_term_action" in report
        ):
            actual = actual.merge(
                report[
                    [
                        column
                        for column in (
                            "symbol",
                            "action",
                            "momentum_score",
                            "return_1m_pct",
                            "warnings",
                            "replace_with",
                            "long_term_score",
                            "long_term_reasons",
                        )
                        if column in report
                    ]
                ],
                on="symbol",
                how="left",
            )
        if actual.empty:
            st.info("No US stock or ETF positions were found in the linked account.")
        else:
            linked_stock_table(
                actual,
                "symbol",
                [
                    column
                    for column in (
                        "symbol",
                        "quantity",
                        "action",
                        "momentum_score",
                        "return_1m_pct",
                        "warnings",
                        "replace_with",
                        "long_term_score",
                        "long_term_reasons",
                    )
                    if column in actual
                ],
                default_exchange="US",
            )
        if source == us_stocks.ROBINHOOD_HOLDINGS_CSV:
            linked = robinhood_mcp.connection()
            st.caption(
                f"Robinhood positions · synced {linked.get('last_synced_at', 'unknown')} "
                f"· {linked.get('omitted_positions', 0)} other positions excluded"
            )
        else:
            selected = account_roles.load_roles()["long_term"]
            st.caption(
                f"Selected long-term account · ending {selected[-4:]}"
                if selected
                else "Local long-term holdings. Select Robinhood accounts in the sidebar to link an account."
            )
        if report_file and report_is_current:
            st.caption(f"Analysis signals: {report_file.name}.")
        elif report_file:
            st.caption(
                "Refresh US recommendations for current long-term signals for these holdings."
            )
    else:
        st.info(
            "Select a long-term account in the sidebar and sync its holdings, or add local holdings before linking an account."
        )


def show_us_long_term_review(holdings):
    st.subheader("Long-term rebalance review")
    st.caption(
        "Business quality determines exit reviews; daily trading continues to use its separate intraday strategy. "
        "Review company filings and tax effects before acting. This plan does not submit orders."
    )
    with st.expander("Long-term rules and financial data"):
        st.markdown(
            "**New stock picks:** positive annual earnings, operating and free cash flow, growing revenue "
            "and earnings, operating cash flow of at least 70% of earnings, and a supportive price trend.\n\n"
            "**Growth outlook:** available next-fiscal-year analyst earnings and revenue estimates are shown "
            "separately. Non-growing consensus from at least three analysts blocks a new pick and prompts "
            "monitoring. Missing forecasts are unknown; forecasts alone cannot trigger an exit.\n\n"
            "**Exit review:** non-positive earnings and operating cash flow in two consecutive annual periods; or revenue "
            "and earnings declines over two annual comparisons, weak cash generation in both years, "
            "and a six-month return at least 10 percentage points below the S&P 500 while below the "
            "200-day average. Price weakness alone leads to monitoring.\n\n"
            "These are configurable code defaults for a growth-stock screen, not a valuation model. "
            "Banks, real estate companies and funds need separate analysis. Missing, unmatched or stale "
            "financial statements block exit and buy recommendations. Earnings growth uses a positive "
            "prior-year base; recovery from losses requires review. Monetary figures use each company's "
            "reported financial currency. Annual statements can lag recent developments; the financial "
            "period and retrieval time are shown. Data is cached for 24 hours and checked on recommendation refresh. "
            "TradingView chart prices cannot replace unavailable financial statements.\n\n"
            "Future growth cannot be established from these metrics: inspect business outlook, valuation, "
            "debt and management's discussion in the latest filings before approving a change. "
            "[Read company reports](https://www.investor.gov/introduction-investing/general-resources/"
            "news-alerts/alerts-bulletins/investor-bulletins/how-read) · "
            "[Understand cash flow](https://www.sec.gov/investor/pubs/begfinstmtguide.htm)"
        )
    if error := st.session_state.get("us_holdings_error"):
        st.warning(f"US holdings are unavailable: {error}")
        return
    source = us_stocks.holdings_source()
    report_file = latest_file(US_DIR, "us_portfolio_momentum_*.csv")
    report = read_csv(report_file)
    if not long_term.report_is_current(
        report, report_file, source, account_roles.ROLES_FILE
    ):
        st.info(
            "Refresh US recommendations to build the long-term business-quality review for your current holdings."
        )
        return
    plan = long_term.rebalance_review(holdings, report)
    if plan.empty:
        st.info(
            "Sync the selected long-term account's holdings to create a rebalance review."
        )
        return
    with st.container(horizontal=True):
        st.metric("Exit reviews", int(plan["long_term_action"].eq("EXIT REVIEW").sum()))
        st.metric("Hold", int(plan["long_term_action"].eq("HOLD").sum()))
        st.metric(
            "Monitor / inspect",
            int(plan["long_term_action"].isin(["WATCH", "REVIEW"]).sum()),
        )
    columns = [
        "symbol",
        "quantity",
        "long_term_action",
        "proposed_sell_quantity",
        "proposed_target_quantity",
        "replace_with",
        "long_term_score",
        "revenue_growth_pct",
        "earnings_growth_pct",
        "net_income",
        "operating_cash_flow",
        "free_cash_flow",
        "cash_conversion",
        "next_year_earnings_growth_pct",
        "earnings_forecast_analysts",
        "next_year_revenue_growth_pct",
        "revenue_forecast_analysts",
        "relative_return_6m_pp",
        "financial_period",
        "financial_currency",
        "financial_fetched_at",
        "financial_source",
        "long_term_reasons",
        "review_instruction",
    ]
    display = plan[[column for column in columns if column in plan]]
    st.dataframe(
        display,
        hide_index=True,
        width="stretch",
        alt="Long-term holdings, financial quality evidence and proposed reductions for manual review",
        column_config={
            "long_term_action": "Long-term decision",
            "proposed_sell_quantity": st.column_config.NumberColumn(
                "Proposed sell shares", format="%.3f"
            ),
            "proposed_target_quantity": st.column_config.NumberColumn(
                "Proposed remaining shares", format="%.3f"
            ),
            "long_term_score": "Business quality / 100",
            "revenue_growth_pct": st.column_config.NumberColumn(
                "Annual revenue growth %", format="%.1f"
            ),
            "earnings_growth_pct": st.column_config.NumberColumn(
                "Annual earnings growth %", format="%.1f"
            ),
            "cash_conversion": st.column_config.NumberColumn(
                "Operating cash / earnings", format="%.2f"
            ),
            "relative_return_6m_pp": st.column_config.NumberColumn(
                "6M vs S&P 500 (pp)", format="%.1f"
            ),
            "financial_period": "Fiscal year ended",
            "next_year_earnings_growth_pct": st.column_config.NumberColumn(
                "Next-year earnings growth estimate %", format="%.1f"
            ),
            "next_year_revenue_growth_pct": st.column_config.NumberColumn(
                "Next-year revenue growth estimate %", format="%.1f"
            ),
            "earnings_forecast_analysts": "Earnings estimate analyst count",
            "revenue_forecast_analysts": "Revenue estimate analyst count",
            "financial_currency": "Financial currency",
            "financial_fetched_at": "Financial data retrieved",
            "replace_with": "Qualified replacement to research",
            "long_term_reasons": "Evidence / reasons",
        },
    )
    st.download_button(
        "Download long-term rebalance review",
        display.to_csv(index=False).encode(),
        file_name="varshan_long_term_rebalance_review.csv",
        mime="text/csv",
        key="download_long_term_review",
    )
    st.caption(
        "Replacements are research candidates; sale proceeds are not automatically reinvested. Unknown quantities produce no sell estimate."
    )


st.logo(str(LOGO_FILE), size="large", icon_image=str(LOGO_FILE))
with st.container(horizontal=True, vertical_alignment="center", gap="small"):
    st.image(
        str(LOGO_FILE), width=68, alt="varshan: white V on an orange V-shaped mark"
    )
    with st.container(width="content"):
        st.title("varshan")
st.caption("Portfolio overview · market research · trading")
market_ui.render_header()

handle_kite_redirect()

if st.session_state.get("kite_return_to_dashboard"):
    kite_ui.return_to_dashboard()
    st.stop()

if "kite_needs_login" not in st.session_state:
    st.session_state["kite_needs_login"] = not saved_token_is_current()
elif not saved_token_is_current():
    st.session_state["kite_needs_login"] = True

if "notice" in st.session_state:
    st.success(st.session_state.pop("notice"))
if "analysis_refresh_error" in st.session_state:
    st.error(st.session_state.pop("analysis_refresh_error"))
if "robinhood_sync_error" in st.session_state:
    st.warning(
        "Automatic Robinhood holdings sync failed: "
        + st.session_state.pop("robinhood_sync_error")
    )

with st.sidebar:
    st.header("Accounts & analysis")
    with st.expander("Kite account settings", expanded=not saved_token_is_current()):
        st.caption(
            "Kite: " + ("connected" if saved_token_is_current() else "login needed")
        )
        if st.button("Reconnect Kite", width="stretch"):
            st.session_state["kite_needs_login"] = True
    st.button(
        "Run India analysis",
        type="primary",
        width="stretch",
        on_click=refresh_reports,
        args=("India",),
    )
    st.button(
        "Refresh US recommendations",
        width="stretch",
        on_click=refresh_reports,
        args=("US",),
    )
    st.divider()
    live_trading_ui.render_account_settings()
    st.caption(
        "Friday reviews are created when India analysis runs on Friday (India time)."
    )

us_holdings_snapshot = long_term_holdings()

tabs = st.tabs(
    [
        "Current holdings",
        "Potential replacements",
        "Recommended stocks",
        "Weekly review",
        "US recommendations",
        "US trading",
        "Market learning",
        "Benchmark comparison",
    ],
    default="US trading"
    if st.query_params.get("view") == "trading"
    else "Current holdings",
)

with tabs[0]:
    st.subheader("Portfolio overview", icon=":material/account_balance_wallet:")
    portfolio_market = st.segmented_control(
        "Market",
        ["India", "US"],
        default="India",
        key="holdings_market",
        persist_state="session",
    )
    if portfolio_market == "US":
        st.button(
            "Refresh long-term analysis",
            key="us_holdings_refresh",
            on_click=refresh_reports,
            args=("US",),
        )
        with st.container(border=True):
            st.subheader("US · long-term holdings")
            show_us_holdings(us_holdings_snapshot)
    else:
        st.button(
            "Refresh India analysis",
            key="india_holdings_refresh",
            on_click=refresh_reports,
            args=("India",),
        )
        st.caption(
            "India · saved portfolio signals. Run India analysis to update the snapshot."
        )
        history = load_history()
        if history:
            latest = history[-1]
            score = latest.get("score")
            holdings = holding_weights(pd.DataFrame(latest.get("holdings", [])))
            risk = current_risk_table(holdings, report_for_snapshot(latest))
            direction = portfolio_insights.holding_direction(risk)
            flagged = int((risk["risk_flags"] != "—").sum()) if not risk.empty else 0
            cols = st.columns(4)
            cols[0].metric(
                "Portfolio score",
                f"{score:.1f}/100" if score is not None else "N/A",
                border=True,
            )
            cols[1].metric(
                "Stocks held",
                len(holdings),
                help=f"Target: at most {kite.MAX_PORTFOLIO_SIZE}",
                border=True,
            )
            cols[2].metric("Holdings with risk flags", flagged, border=True)
            coverage = latest.get("components", {}).get("data_coverage_pct")
            cols[3].metric(
                "Data coverage",
                f"{coverage:.0f}%" if coverage is not None else "N/A",
                border=True,
            )
            st.caption(
                f"Snapshot: {latest['as_of']} · score tracks momentum, data coverage and diversification"
            )
            if not holdings.empty:
                columns = [
                    "symbol",
                    "exchange",
                    "shares",
                    "weight_pct",
                    "momentum_score",
                    "action",
                    "incoming",
                    "portfolio_plan",
                ]
                linked_stock_table(
                    holdings,
                    "symbol",
                    [column for column in columns if column in holdings],
                    exchange_column="exchange",
                )
                st.markdown("**Which holdings are improving or at risk**")
                good = direction[direction["direction"] == "Improving"]
                at_risk = direction[direction["direction"] == "At risk"]
                summary_left, summary_right = st.columns(2)
                with summary_left:
                    st.write(
                        "**Improving:** "
                        + (
                            ", ".join(good["symbol"].astype(str))
                            if not good.empty
                            else "None meet all trend checks"
                        )
                    )
                with summary_right:
                    st.write(
                        "**At risk:** "
                        + (
                            ", ".join(at_risk["symbol"].astype(str))
                            if not at_risk.empty
                            else "None flagged"
                        )
                    )
                chart_left, chart_right = st.columns(2)
                with chart_left:
                    st.markdown("**Portfolio allocation (%)**")
                    allocation = (
                        holdings[["symbol", "weight_pct"]]
                        .dropna()
                        .sort_values("weight_pct", ascending=False)
                    )
                    st.bar_chart(allocation.set_index("symbol"))
                with chart_right:
                    st.markdown("**Holding signals**")
                    signals = (
                        holdings["action"]
                        .fillna("Unknown")
                        .value_counts()
                        .rename_axis("signal")
                        .reset_index(name="stocks")
                    )
                    st.bar_chart(signals.set_index("signal"))
                with st.expander("Holding trends & risk details"):
                    linked_stock_table(
                        direction,
                        "symbol",
                        [
                            "symbol",
                            "direction",
                            "direction_reason",
                            "return_1m_pct",
                            "action",
                            "portfolio_plan",
                            "plan_reason",
                        ],
                        exchange_column="exchange",
                    )
                    st.caption(
                        "Improving requires a positive 1-month return, price above the 50-day "
                        "average, and the 50-day average above the 200-day average. At risk "
                        "includes a REPLACE signal, a break below "
                        "the 200-day average, weight above 20%, or missing history. "
                        "WATCH and mixed signals need follow-up."
                    )
                    st.markdown("**Risk indicators**")
                    linked_stock_table(
                        risk,
                        "symbol",
                        [
                            "symbol",
                            "weight_pct",
                            "action",
                            "atr_pct",
                            "rsi",
                            "risk_flags",
                        ],
                        exchange_column="exchange",
                    )
                    st.caption(
                        f"Flags: weight >20%, ATR >{kite.MAX_ATR_PCT:g}% of price, RSI >75, below 200 day average, or WATCH/REPLACE/NO DATA. Technical values use the same date's holdings report when available. These are review signals, not forecasts."
                    )
                with st.expander("Exit review checklist"):
                    st.write(
                        "A REPLACE signal enters the planned-exit list after it appears on two dated "
                        "India scans. Capacity can also require a proposed exit. Before selling, "
                        "confirm the latest price and investment thesis, check position size and "
                        "diversification, and account for taxes, fees, liquidity, and unsettled shares. "
                        "Missing data calls for manual review. A price level is a review signal, "
                        "not a guaranteed execution price."
                    )
            scores = history_chart_data(history)[["date", "score"]].dropna()
            if len(scores) > 1:
                st.markdown("**Portfolio score over time**")
                st.line_chart(scores.set_index("date"))
        else:
            st.info("Run India analysis to create the first portfolio snapshot.")
        report_file = latest_file(INDIA_DIR, "zerodha_momentum_*.csv")
        show_download(report_file, "Download holdings report", "download_holdings")

with tabs[1]:
    st.subheader("Potential replacements")
    st.button(
        "Refresh India analysis",
        key="india_replacements_refresh",
        on_click=refresh_reports,
        args=("India",),
    )
    potential_file = latest_file(INDIA_DIR, "zerodha_potential_replacements_*.csv")
    potential = read_csv(potential_file)
    if potential.empty:
        st.info(
            "No potential replacement report yet. Run India analysis to refresh it."
        )
    else:
        st.caption(f"Report: {potential_file.name} · vetted, unowned candidates")
        strategies = st.selectbox(
            "Strategy",
            ["All", "momentum", "weekend_style", "naked_style"],
            key="india_replacement_strategy",
            persist_state="session",
        )
        if strategies != "All":
            potential = potential[
                potential["strategies"].fillna("").str.contains(strategies, regex=False)
            ]
        summary = st.columns(3)
        summary[0].metric("Vetted stocks", len(potential))
        summary[1].metric(
            "High potential", int(potential["potential"].fillna("").eq("HIGH").sum())
        )
        summary[2].metric(
            "Average momentum",
            f"{pd.to_numeric(potential['momentum_score'], errors='coerce').mean():.0f}"
            if not potential.empty
            else "—",
        )
        linked_stock_table(
            potential,
            "stock",
            ["stock", "momentum_score", "potential", "strategies", "reason"],
        )
        if not potential.empty:
            st.markdown("**Candidate momentum scores**")
            st.bar_chart(potential[["stock", "momentum_score"]].set_index("stock"))
        show_download(
            potential_file, "Download potential replacements", "download_potential"
        )

with tabs[2]:
    st.subheader("Recommended stocks and portfolio allocation")
    st.button(
        "Refresh India analysis",
        key="india_recommendations_refresh",
        on_click=refresh_reports,
        args=("India",),
    )
    history = load_history()
    snapshot = history[-1] if history else None
    plan_file = latest_file(INDIA_DIR, "zerodha_target_plan_*.csv")
    plan = read_csv(plan_file)
    if snapshot is None:
        st.info(
            "Run India analysis to create a portfolio snapshot and allocation view."
        )
    else:
        if plan_file and snapshot["date"].replace("-", "_") not in plan_file.stem:
            plan = pd.DataFrame()
        strategy = st.selectbox(
            "Portfolio plan",
            india_candidate_selection.STRATEGIES,
            key="india_portfolio_strategy",
            persist_state="session",
        )
        ranked_file = latest_file(
            INDIA_DIR, "nifty_midsmallcap_400_momentum_ranked_*.csv"
        )
        quotes = (
            read_csv(ranked_file)
            if ranked_file and snapshot["date"].replace("-", "_") in ranked_file.stem
            else pd.DataFrame()
        )
        potential_file = latest_file(INDIA_DIR, "zerodha_potential_replacements_*.csv")
        potential = (
            read_csv(potential_file)
            if potential_file
            and snapshot["date"].replace("-", "_") in potential_file.stem
            else pd.DataFrame()
        )
        selected_snapshot, buys = india_candidate_selection.render(
            snapshot, potential, quotes, plan, strategy, kite.MAX_PORTFOLIO_SIZE
        )
        view = (
            recommended_india_view(selected_snapshot, buys, quotes)
            if selected_snapshot is not None
            else pd.DataFrame()
        )
        if view.empty:
            st.info("Choose a valid portfolio selection to prepare the rebalance.")
        else:
            st.caption(
                f"Snapshot: {snapshot['date']} · equal target value for eligible kept/new stocks"
                + (
                    f" · {strategy.replace('_', ' ')} candidates"
                    if strategy
                    else " · no new buys in the current plan"
                )
            )
            metrics = st.columns(4)
            metrics[0].metric("Current stocks", int(view["status"].ne("New").sum()))
            metrics[1].metric("Target stocks", int(view["status"].ne("Exit").sum()))
            metrics[2].metric("Shares to buy", int(view["shares_to_buy"].sum()))
            metrics[3].metric("Shares to sell", int(view["shares_to_sell"].sum()))
            if view["target_shares"].isna().any():
                st.warning(
                    "One or more prices are missing; target shares for those stocks are unavailable."
                )
            market_context = portfolio_insights.market_insight(
                INDIA_DIR, "nifty_midsmallcap_400_momentum_ranked_*.csv", "India"
            )
            kite_ui.render_button(
                view, kite_client, selected_snapshot, strategy, market_context
            )
            st.markdown("**Current holdings versus target shares**")
            linked_stock_table(
                view.round(2),
                "symbol",
                [
                    "symbol",
                    "exchange",
                    "status",
                    "signal",
                    "plan_reason",
                    "current_shares",
                    "target_shares",
                    "shares_to_buy",
                    "shares_to_sell",
                    "current_allocation_pct",
                    "target_allocation_pct",
                ],
                exchange_column="exchange",
            )
            if view["current_allocation_pct"].notna().all():
                st.markdown("**Current versus target allocation (%)**")
                st.bar_chart(
                    view.set_index("symbol")[
                        ["current_allocation_pct", "target_allocation_pct"]
                    ]
                )
            st.caption(
                "Targets use saved prices and whole shares. First REPLACE signals, WATCH, and NO DATA holdings stay at current shares for review unless the eight-stock capacity limit applies. Confirmed or capacity exits target zero. Eligible holdings and selected new stocks split the remaining value equally. Cash left after rounding, taxes, fees, and changing prices are excluded."
            )
            st.download_button(
                "Download recommended allocation",
                view.to_csv(index=False).encode("utf-8"),
                file_name="recommended_india_allocation.csv",
                mime="text/csv",
                key="download_india_allocation",
            )
        if not plan.empty:
            show_download(plan_file, "Download buy plans", "download_plan")
        potential_file = latest_file(INDIA_DIR, "zerodha_potential_replacements_*.csv")
        potential = read_csv(potential_file)
        if not potential.empty:
            st.markdown("**Other vetted stock candidates**")
            st.caption(
                f"Saved list: {potential_file.name}. These alternatives have no share target until selected in a plan."
            )
            linked_stock_table(
                potential.head(12),
                "stock",
                ["stock", "momentum_score", "potential", "strategies", "reason"],
            )

with tabs[3]:
    st.subheader("Weekly portfolio review")
    st.button(
        "Refresh India analysis",
        key="india_weekly_refresh",
        on_click=refresh_reports,
        args=("India",),
    )
    history = load_history()
    if history:
        current = history[-1]
        baseline = weekly_baseline(history)
        trend = history_chart_data(history)
        current_holdings = current.get("holdings", [])
        current_flagged = int(trend.iloc[-1]["flagged"])
        baseline_flagged = (
            sum(
                item.get("action") in ("WATCH", "REPLACE", "NO DATA")
                for item in baseline.get("holdings", [])
            )
            if baseline
            else None
        )
        metrics = st.columns(4)
        score = current.get("score")
        prior_score = baseline.get("score") if baseline else None
        metrics[0].metric(
            "Portfolio score",
            f"{score:.1f}/100" if score is not None else "N/A",
            f"{score - prior_score:+.1f}"
            if score is not None and prior_score is not None
            else None,
        )
        metrics[1].metric(
            "Stocks held",
            len(current_holdings),
            len(current_holdings) - len(baseline["holdings"]) if baseline else None,
        )
        metrics[2].metric(
            "Holdings needing review",
            current_flagged,
            current_flagged - baseline_flagged if baseline else None,
            delta_color="inverse",
        )
        coverage = current.get("components", {}).get("data_coverage_pct")
        metrics[3].metric(
            "Data coverage", f"{coverage:.0f}%" if coverage is not None else "N/A"
        )
        st.caption(
            f"Latest snapshot: {current['date']} · comparison: {baseline['date'] if baseline else 'first snapshot'}"
        )
        if len(trend) > 1:
            left, right = st.columns(2)
            with left:
                st.markdown("**Score history**")
                st.line_chart(trend.set_index("date")[["score"]])
            with right:
                st.markdown("**Holdings and review signals**")
                st.line_chart(trend.set_index("date")[["stocks", "flagged"]])
        else:
            st.info(
                "This is the first saved snapshot. Trend charts will appear after another India analysis day."
            )
        changes = kite.snapshot_changes(baseline, current)
        st.markdown("**Changes since comparison snapshot**")
        left, middle, right = st.columns(3)
        left.write("**Added**")
        left.write(", ".join(changes["added"]) or "None")
        middle.write("**Removed**")
        middle.write(", ".join(changes["removed"]) or "None")
        right.write("**Share changes**")
        right.write("; ".join(changes["share_changes"]) or "None")
        signals = pd.Series(
            [item.get("action", "Unknown") for item in current_holdings]
        ).value_counts()
        if not signals.empty:
            st.markdown("**Current holding signals**")
            st.bar_chart(
                signals.rename_axis("signal")
                .reset_index(name="stocks")
                .set_index("signal")
            )
        st.caption(
            "The score tracks value weighted momentum, data coverage, and diversification; it is not a return forecast."
        )
    else:
        st.info("Run India analysis to create the first portfolio snapshot.")
    review_file = latest_file(INDIA_DIR, "weekly_review_*.md")
    if review_file:
        with st.expander(
            f"Saved Friday report · {review_file.stem.removeprefix('weekly_review_')}"
        ):
            st.markdown(secure_storage.read_text(review_file))
    else:
        st.caption(
            "A saved Friday report appears after an India analysis run on Friday."
        )
    if Path(kite.PORTFOLIO_MEMORY_FILE).exists():
        with st.expander("Portfolio memory"):
            st.markdown(secure_storage.read_text(kite.PORTFOLIO_MEMORY_FILE))

with tabs[4]:
    st.subheader("Recommended US long-term stock portfolio")
    st.button(
        "Refresh long-term analysis",
        key="us_long_term_refresh",
        on_click=refresh_reports,
        args=("US",),
    )
    st.caption(
        "Nasdaq-100 picks that pass annual business-quality and trend checks. Enter a USD budget to estimate shares."
    )
    us_budget = st.number_input(
        "Example portfolio budget (USD)",
        min_value=1.0,
        value=float(us_stocks.DEFAULT_US_BUDGET),
        step=1000.0,
        key="us_portfolio_budget",
        persist_state="session",
    )
    us_picks = latest_file(US_DIR, "us_*_momentum_picks_*.csv")
    picks = read_csv(us_picks)
    picks_are_current = (
        us_picks is not None
        and 0 <= datetime.now().timestamp() - us_picks.stat().st_mtime < 24 * 3600
        and "policy_version" in picks
        and picks["policy_version"].eq(long_term.POLICY_VERSION).all()
    )
    if picks.empty or not picks_are_current or "long_term_eligible" not in picks:
        st.info(
            "Refresh US recommendations to check business quality. If no stock qualifies, keep the budget unallocated."
        )
    else:
        picks = us_stocks.recommended_portfolio(picks, us_budget)
        current = us_holdings_snapshot.copy()
        picks["currently_held"] = (
            pd.NA
            if st.session_state.get("us_holdings_error")
            else picks["symbol"].isin(current["symbol"])
        )
        st.caption(
            f"Picks: {us_picks.name} · maximum {us_stocks.MAX_POSITION_WEIGHT_PCT:g}% per stock · "
            f"${us_budget - picks['target_usd'].sum():,.2f} example budget unallocated."
        )
        picks = technical_flags(picks)
        top = st.columns(4)
        top[0].metric("Recommended stocks", len(picks))
        top[1].metric(
            "Average momentum score",
            f"{pd.to_numeric(picks['momentum_score'], errors='coerce').mean():.0f}",
        )
        top[2].metric(
            "High potential",
            int(picks["potential"].fillna("").astype(str).str.lower().eq("high").sum()),
        )
        top[3].metric("Technical risk flags", int((picks["risk_flags"] != "—").sum()))
        columns = [
            "symbol",
            "currently_held",
            "price",
            "target_weight_pct",
            "target_usd",
            "estimated_shares",
            "momentum_score",
            "action",
            "potential",
            "return_1m_pct",
            "return_3m_pct",
            "return_6m_pct",
            "rsi",
            "atr_pct",
            "risk_flags",
            "potential_reasons",
            "long_term_score",
            "revenue_growth_pct",
            "earnings_growth_pct",
            "cash_conversion",
            "financial_period",
            "long_term_reasons",
        ]
        linked_stock_table(
            picks,
            "symbol",
            [column for column in columns if column in picks],
            default_exchange="NASDAQ",
        )
        st.caption(
            "Share counts are estimates at saved prices, rounded to 0.001 share; fractional share availability varies by broker. This US large-cap stock list can still be concentrated by sector and is not a complete diversified portfolio."
        )
        st.caption(
            f"Technical flags use ATR >{kite.MAX_ATR_PCT:g}% of price, RSI >75, and price below the 200 day average. Open Yahoo Finance or TradingView in a new tab for each stock."
        )
        left, right = st.columns(2)
        with left:
            st.markdown("**Momentum scores**")
            st.bar_chart(picks[["symbol", "momentum_score"]].set_index("symbol"))
        with right:
            st.markdown("**Recent returns (%)**")
            st.bar_chart(
                picks[["symbol", "return_3m_pct", "return_6m_pct"]].set_index("symbol")
            )
        st.download_button(
            "Download recommended US portfolio",
            picks.to_csv(index=False).encode("utf-8"),
            file_name="recommended_us_portfolio.csv",
            mime="text/csv",
            key="download_us",
        )
    show_us_long_term_review(us_holdings_snapshot)

if "india_log" in st.session_state or "us_log" in st.session_state:
    with st.sidebar.expander("Latest run details"):
        st.text(
            st.session_state.get("india_log", st.session_state.get("us_log", ""))[
                -16000:
            ]
        )

if st.session_state["kite_needs_login"]:
    kite_login_dialog()


with tabs[5]:
    trading_tabs = st.tabs(["Live account", "Paper trading"])
    with trading_tabs[0]:
        with st.container(border=True):
            live_trading_ui.render()
    with trading_tabs[1]:
        with st.container(border=True):
            us_trading_lab.render()

with tabs[6]:
    market_ui.render_learning(INDIA_DIR, US_DIR)

with tabs[7]:
    comparison_portfolio = st.segmented_control(
        "Portfolio to compare",
        ["US long-term", "US trading", "India"],
        default="US long-term",
        key="comparison_portfolio",
        persist_state="session",
    )
    performance.render_benchmark(
        [],
        "India" if comparison_portfolio == "India" else "US",
        None,
        provider=lambda: benchmark_holdings(comparison_portfolio),
    )
