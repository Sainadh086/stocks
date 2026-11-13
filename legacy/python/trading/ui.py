"""Automatic paper trading UI for the local Nasdaq-100 momentum agent."""

import json
import threading
from datetime import datetime
from zoneinfo import ZoneInfo

import pandas as pd
import streamlit as st

from brokers.robinhood import history as us_trade_history
from brokers.robinhood import performance as trading_performance_ui
from shared import prices
from shared.paths import BACKTESTS_DIR
from trading import agent as paper_agent
from trading import data as orb_data
from trading import journal as paper_journal


@st.cache_resource
def agent():
    # Reuse the running resource after a source reload; keep one worker thread.
    for thread in threading.enumerate():
        target = getattr(thread, "_target", None)
        prior = getattr(target, "__self__", None)
        if (
            thread.name == "paper-agent"
            and getattr(prior, "path", None) == paper_agent.ACCOUNT_FILE
        ):
            with prior._lock(".worker.lock"):
                prior.__class__ = paper_agent.PaperAgent
                if not hasattr(prior, "feed"):
                    prior.feed = orb_data.Feed()
            prior.wake.set()
            return prior
    return paper_agent.PaperAgent()


def migrate_browser_session(worker):
    """Import legacy paper data without requiring a long-term recommendation scan."""
    old = st.session_state.get("us_paper_account")
    if not old or worker.snapshot() is not None:
        return
    state = paper_agent.new_account(old["budget"], old["reserve_pct"])
    state.update(cash=old["cash"], status=old["status"], fills=old["fills"])
    quantities = old["positions"]
    if quantities:
        reference_prices = {}
        for symbol in quantities:
            for fill in reversed(old["fills"]):
                price = pd.to_numeric(fill.get("price"), errors="coerce")
                if (
                    fill.get("symbol") == symbol
                    and pd.notna(price)
                    and 0 < price < float("inf")
                ):
                    reference_prices[symbol] = float(price)
                    break
            if symbol not in reference_prices:
                history = prices.history(symbol, period="5d")
                if history.empty:
                    raise ValueError(
                        f"Price unavailable for legacy paper holding {symbol}; retry the paper import when market data is available."
                    )
                reference_prices[symbol] = float(history.Close.iloc[-1])
        market_value = sum(q * reference_prices[s] for s, q in quantities.items())
        if market_value <= 0:
            raise ValueError("Existing paper holdings have invalid prices.")
        spent = old["budget"] - old["cash"]
        state["positions"] = {
            s: dict(
                quantity=q,
                price=reference_prices[s],
                cost=spent * q * reference_prices[s] / market_value,
            )
            for s, q in quantities.items()
        }
        state["message"] = (
            "Imported paper holdings; opening costs allocated using paper-fill or public price references. Original per-stock cost basis is unavailable."
        )
    state.pop("journal_version", None)
    worker.control("start", paper_journal.upgrade(state))
    st.session_state.pop("us_paper_account", None)


def start_session(worker):
    worker.control(
        "start",
        paper_agent.new_account(
            st.session_state["paper_budget"], st.session_state["paper_reserve"]
        ),
    )


@st.fragment
def render():
    st.subheader("Paper trading")
    st.caption("Automatic paper trading · simulated USD · no live orders")
    st.write(
        "The paper agent selects up to four stocks with opening volume at least 1.5× "
        "their prior-session baseline. After the first 15 minutes, a completed 5-minute "
        "close above the opening range can trigger a buy at the next observed open."
    )
    st.caption(
        "Risk: 0.25% of equity per trade · stop: opening-range low · target: 2R · "
        "no new entries after a 1% daily loss · exit five minutes before the exchange close. "
        "One entry per symbol per day. Monitoring requires the dashboard server to stay running."
    )
    st.caption(
        "Simulated costs per side: 1 bp fee, half of a 5 bp spread, and 2 bp slippage. "
        "Data outages can delay exits; missed entries are never replayed as live paper fills."
    )
    try:
        worker = agent()
        migrate_browser_session(worker)
        state = worker.snapshot()
    except Exception as exc:
        st.error(f"Paper account could not be loaded: {exc}")
        return
    active = state is not None and state["status"] != "Ended"
    st.session_state.setdefault(
        "paper_budget", float(state["budget"]) if state else 1000.0
    )
    st.session_state.setdefault(
        "paper_reserve", int(state["reserve_pct"]) if state else 10
    )
    with st.form("us_paper_setup"):
        st.number_input(
            "Paper trading amount (USD)",
            min_value=1.0,
            step=100.0,
            key="paper_budget",
            disabled=active,
            persist_state="session",
        )
        st.slider(
            "Paper cash reserve (%)",
            0,
            100,
            key="paper_reserve",
            disabled=active,
            persist_state="session",
        )
        st.form_submit_button(
            "Start paper session",
            disabled=active,
            on_click=start_session,
            args=(worker,),
        )
    st.caption(
        "These settings affect simulated trades only. Live trading has its own budget and reserve in Live account."
    )
    if active:
        st.caption(
            f"Saved paper budget: ${state['budget']:,.2f} · reserve: {state['reserve_pct']:g}%. End this session before starting one with different settings."
        )
    if state is None:
        st.info(
            "Start a paper session to enable automatic buying, selling, and monitoring."
        )
        return
    if state["status"] != "Ended":
        st.button(
            "Pause paper session"
            if state["status"] == "Running"
            else "Resume paper session",
            on_click=worker.control,
            args=("pause" if state["status"] == "Running" else "resume",),
        )
        st.button("End paper session", on_click=worker.control, args=("end",))
    render_positions(worker)


@st.fragment(run_every="2s")
def render_positions(worker):
    try:
        state = worker.snapshot()
    except Exception as exc:
        st.error(f"Paper account could not be loaded: {exc}")
        return
    if state is None:
        return
    state = paper_journal.upgrade(state)
    positions = state["positions"]
    value = sum(p["quantity"] * p["price"] for p in positions.values())
    equity = state["cash"] + value
    cols = st.columns(4)
    cols[0].metric("Paper equity", f"${equity:,.2f}")
    cols[1].metric("Paper cash", f"${state['cash']:,.2f}")
    total_pnl = equity - state["budget"]
    delta = 0 if round(total_pnl, 2) == 0 else f"{total_pnl:+,.2f} USD"
    cols[2].metric("Total paper P&L", f"${total_pnl:,.2f}", delta=delta)
    cols[3].metric("Session status", state["status"])
    if state["status"] == "Ended":
        st.info(
            "Session ended. Automatic trading stopped; holdings and history are preserved."
        )
    elif state["status"] == "Paused":
        st.info("Session paused. Resume to continue monitoring and automatic trading.")
    else:
        st.info(state["message"])
    if state.get("last_check"):
        checked = datetime.fromisoformat(state["last_check"]).astimezone(
            ZoneInfo("America/New_York")
        )
        st.caption(
            f"Last check: {checked:%Y-%m-%d %H:%M:%S} ET · "
            f"Realized paper P&L: ${state.get('realized_pnl', 0):,.2f}"
        )
    costs = st.columns(3)
    costs[0].metric("Realized P&L (net)", f"${state.get('realized_pnl', 0):,.2f}")
    costs[1].metric("Simulated trading costs", f"${state['simulated_costs']:,.2f}")
    costs[2].metric("Maximum drawdown", f"{state['max_drawdown_pct']:.2f}%")
    if state.get("shortlist"):
        st.dataframe(
            pd.DataFrame(state["shortlist"]),
            hide_index=True,
            width="stretch",
            key="paper_shortlist",
        )
    trading_performance_ui.render_paper(state)
    if state.get("closed_trades"):
        trades = pd.DataFrame(state["closed_trades"])
        with st.expander("Full trade journal · reasons, stops, targets and costs"):
            st.dataframe(
                trades.iloc[::-1], hide_index=True, width="stretch", key="paper_journal"
            )
        st.download_button(
            "Download closed trades",
            trades.to_csv(index=False),
            "paper_trades.csv",
            "text/csv",
            on_click="ignore",
        )
    report_path = BACKTESTS_DIR / "orb" / "report.json"
    if report_path.exists():
        with st.expander("Historical paper evaluation"):
            report = json.loads(report_path.read_text())
            st.dataframe(pd.DataFrame(report["results"]).T, width="stretch")
            if report.get("regimes"):
                st.dataframe(pd.DataFrame(report["regimes"]).T, width="stretch")
            st.caption(
                "Pilot history only. Rules were frozen before chronological held-out evaluation; "
                "these results do not establish readiness for live use."
            )
            for limitation in report["limitations"]:
                st.caption(limitation)
    else:
        st.caption(
            "Run backtest_orb.py with historical intraday CSV data for held-out evaluation."
        )
    if positions:
        st.markdown("**Simulated holdings · HOLD**")
        for symbol, position in positions.items():
            with st.container(border=True):
                st.markdown(f"**{symbol} · HOLD**")
                value = position["quantity"] * position["price"]
                invested = position["cost"]
                pnl = value - invested
                pct = pnl / invested * 100 if invested > 0 else 0
                delta = (
                    0
                    if round(pnl, 2) == 0
                    else f"{'+' if pnl > 0 else '-'}${abs(pnl):,.2f} ({pct:+.2f}%)"
                )
                st.metric(
                    "Paper holding value",
                    f"${value:,.2f}",
                    delta=delta,
                    delta_color="normal",
                )
                st.caption(
                    f"Invested: ${invested:,.2f} · includes simulated entry costs"
                )
                if position.get("stop") is not None:
                    st.caption(
                        f"Stop: ${position['stop']:,.2f} · target: ${position['target']:,.2f}"
                    )

        rows = [
            dict(
                symbol=s,
                quantity=p["quantity"],
                average_cost=p["cost"] / p["quantity"],
                entry_reason=p.get("entry_reason"),
                stop=p.get("stop"),
                target=p.get("target"),
                last_price=p["price"],
                market_value=p["quantity"] * p["price"],
                unrealized_pnl=p["quantity"] * p["price"] - p["cost"],
                quote_time=p.get("quote_time", "Imported scan"),
            )
            for s, p in positions.items()
        ]
        st.dataframe(
            pd.DataFrame(rows), hide_index=True, width="stretch", key="paper_holdings"
        )
    if state["fills"]:
        st.markdown("**Paper trade history**")
        history = us_trade_history.paper_table(state)
        st.dataframe(
            history.style.map(us_trade_history.pnl_style, subset=["Profit/loss ($)"]),
            hide_index=True,
            width="stretch",
            key="paper_trade_history",
            column_config={
                name: st.column_config.NumberColumn(name, format="$%.2f")
                for name in ["Buy price ($)", "Sell price ($)", "Profit/loss ($)"]
            },
        )
        st.caption(
            "One row per paper trade. Closed profit/loss includes simulated costs; holding profit/loss is unrealized. Times are Chicago time."
        )
        activity = pd.DataFrame(state["fills"])
        with st.expander("Individual paper fills"):
            st.dataframe(
                activity.tail(200).iloc[::-1],
                hide_index=True,
                width="stretch",
                key="paper_fills",
            )
        st.download_button(
            "Download paper activity",
            activity.to_csv(index=False),
            "paper_activity.csv",
            "text/csv",
            on_click="ignore",
        )
