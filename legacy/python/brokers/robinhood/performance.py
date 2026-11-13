"""Investment comparisons using actual holding cost and paper account equity."""

import hashlib

import altair as alt
import pandas as pd
import streamlit as st

from brokers.robinhood.strategy import amount, holding_performance
from shared.comparison import BENCHMARKS, basket_comparison
from shared.comparison import comparison_prices as load_comparison_prices


@st.cache_data(ttl=900, max_entries=512, show_spinner=False)
def comparison_prices(symbol, period):
    return load_comparison_prices(symbol, period)


@st.fragment(run_every="5s")
def render_benchmark(holdings, market, identity, provider=None):
    if provider is not None:
        try:
            holdings, market, identity, label = provider()
            st.caption(label)
        except Exception as exc:
            st.warning(f"Current holdings could not be loaded: {exc}")
            return
    st.subheader("Holdings vs benchmark", icon=":material/compare_arrows:")
    st.caption(
        "How today's holdings basket would have moved over the selected period. Both series start at 100; this is a hypothetical price comparison, not your account's actual historical return."
    )
    scope = hashlib.sha256(repr((market, identity)).encode()).hexdigest()[:20]
    workspaces = st.session_state.setdefault("benchmark_workspaces", {})
    if scope not in workspaces:
        if len(workspaces) >= 30:
            workspaces.pop(next(iter(workspaces)))
        workspaces[scope] = {}
        # Carry an already completed comparison through this state-layout upgrade.
        legacy = st.session_state.get("benchmark_result")
        if legacy and legacy[0][0] == identity and legacy[0][2] in BENCHMARKS[market]:
            workspaces[scope]["result"] = st.session_state.pop("benchmark_result")
            workspaces[scope]["history"] = st.session_state.pop(
                "benchmark_history", None
            )
            st.session_state.setdefault(f"comparison_benchmark_{scope}", legacy[0][2])
            st.session_state.setdefault(f"comparison_period_{scope}", legacy[0][3])
    workspace = workspaces[scope]
    with st.form(f"benchmark_comparison_form_{scope}"):
        left, right = st.columns(2)
        benchmark = left.selectbox(
            "Benchmark",
            list(BENCHMARKS[market]),
            key=f"comparison_benchmark_{scope}",
            persist_state="session",
        )
        period = right.selectbox(
            "Period",
            ["1m", "3m", "6m", "1y", "2y"],
            index=3,
            key=f"comparison_period_{scope}",
            persist_state="session",
            format_func=lambda value: {
                "1m": "1 month",
                "3m": "3 months",
                "6m": "6 months",
                "1y": "1 year",
                "2y": "2 years",
            }[value],
        )
        load = st.form_submit_button("Compare holdings", type="primary")
    fingerprint = (identity, tuple(sorted(holdings)), benchmark, period)
    if load:
        try:
            if not holdings:
                raise ValueError(
                    "No holdings loaded. Sync the selected account or run India analysis first."
                )
            with st.spinner("Loading stock and benchmark history…"):
                histories, sources = {}, []
                for symbol, _ in holdings:
                    histories[symbol], source = comparison_prices(symbol, period)
                    sources.append({"Symbol": symbol, "Source": source})
                benchmark_prices, source = comparison_prices(
                    BENCHMARKS[market][benchmark], period
                )
                sources.append({"Symbol": benchmark, "Source": source})
                curve = basket_comparison(
                    holdings, histories, benchmark, benchmark_prices
                )
            workspace["result"] = (fingerprint, curve, sources)
            workspace["history"] = (
                identity,
                benchmark,
                period,
                histories,
                benchmark_prices,
                sources,
            )
            workspace.pop("error", None)
        except Exception as exc:
            workspace["error"] = (fingerprint, str(exc))
    error = workspace.get("error")
    if error and error[0] == fingerprint:
        st.warning(error[1])
    result = workspace.get("result")
    # Quantity updates can reuse the same public prices, without another download.
    cached = workspace.get("history")
    applied = result[0] if result else None
    current_fingerprint = (
        (identity, tuple(sorted(holdings)), *applied[2:]) if applied else None
    )
    if (
        result
        and applied != current_fingerprint
        and result[0][0] == identity
        and cached
        and cached[:3] == (identity, *applied[2:])
    ):
        try:
            curve = basket_comparison(holdings, cached[3], applied[2], cached[4])
            result = (current_fingerprint, curve, cached[5])
            workspace["result"] = result
        except ValueError as exc:
            st.warning(
                f"Showing the saved comparison. Current holdings could not be recalculated: {exc}. Compare again when holdings and history are available."
            )
    if not result:
        st.info("Select a benchmark and period, then compare your current holdings.")
        return
    saved_fingerprint, curve, sources = result
    benchmark, period = saved_fingerprint[2:]
    st.caption(
        f"Saved comparison · {benchmark} · {period}. Settings take effect when you select Compare holdings."
    )
    basket_return, benchmark_return = curve.iloc[-1] - 100
    cols = st.columns(3)
    cols[0].metric("Holdings price return", f"{basket_return:+.2f}%", border=True)
    cols[1].metric(
        f"{benchmark} price return", f"{benchmark_return:+.2f}%", border=True
    )
    cols[2].metric(
        "Difference", f"{basket_return - benchmark_return:+.2f} pp", border=True
    )
    st.line_chart(
        curve,
        height=360,
        color=["#0F766E", "#2563EB"],
        alt="Current holdings basket compared with the selected benchmark, both starting at 100",
    )
    st.caption(
        f"Common price dates: {curve.index[0]:%d %b %Y} – {curve.index[-1]:%d %b %Y} · {'INR' if market == 'India' else 'USD'} · {len(curve)} observations"
    )
    if (pd.Timestamp.now().normalize() - curve.index[-1]).days > 5:
        st.warning(
            "The comparison ends on an older date because newer common data is unavailable."
        )
    with st.expander("Method & data sources"):
        st.write(
            "The basket holds today's share quantities constant throughout the period. It excludes cash, deposits, withdrawals, sold positions, taxes, fees and dividends. All series use the same common dates; missing holdings block the comparison rather than being silently excluded. Each benchmark uses the same market currency. Yahoo Finance is tried first, then TradingView's public chart feed, which can be delayed or unavailable."
        )
        st.dataframe(pd.DataFrame(sources), hide_index=True, key="benchmark_sources")


def holdings_frame(snapshot):
    rows, missing = [], []
    for position in snapshot.get("positions", []):
        quantity = amount(position.get("quantity"))
        if quantity is None or quantity <= 0:
            continue
        symbol = position["symbol"]
        performance = holding_performance(
            position, snapshot.get("quotes", {}).get(symbol)
        )
        if performance is None:
            missing.append(symbol)
        else:
            rows.append({"Stock": symbol, **performance})
    return pd.DataFrame(rows), missing


def render_live(snapshot):
    st.markdown("### Live investment profit/loss")
    frame, missing = holdings_frame(snapshot)
    if missing:
        st.caption(
            "Purchase cost or price unavailable for: "
            + ", ".join(missing)
            + ". These holdings are excluded from the chart and totals."
        )
    if frame.empty:
        st.info(
            "The profit/loss graph appears when holdings have a purchase cost and a market price."
        )
        return
    invested, value = frame.invested.sum(), frame.value.sum()
    pnl = value - invested
    cols = st.columns(3)
    cols[0].metric("Invested in shown holdings", f"${invested:,.2f}")
    cols[1].metric("Current holding value", f"${value:,.2f}")
    cols[2].metric(
        "Unrealized profit/loss",
        f"${pnl:,.2f}",
        delta=0 if round(pnl, 2) == 0 else f"{pnl / invested * 100:+.2f}%",
    )
    bars = (
        alt.Chart(frame)
        .mark_bar()
        .encode(
            x=alt.X("Stock:N", sort=None),
            y=alt.Y("pnl:Q", title="Profit/loss ($)"),
            color=alt.condition(
                alt.datum.pnl >= 0, alt.value("#15803d"), alt.value("#dc2626")
            ),
            tooltip=[
                alt.Tooltip("Stock:N"),
                alt.Tooltip("invested:Q", title="Invested ($)", format=",.2f"),
                alt.Tooltip("value:Q", title="Current value ($)", format=",.2f"),
                alt.Tooltip("pnl:Q", title="Profit/loss ($)", format="+,.2f"),
                alt.Tooltip("return_pct:Q", title="Return (%)", format="+.2f"),
            ],
        )
    )
    zero = (
        alt.Chart(pd.DataFrame({"zero": [0]}))
        .mark_rule(color="#64748b")
        .encode(y="zero:Q")
    )
    st.altair_chart(
        (bars + zero).properties(height=260),
        width="stretch",
        alt="Profit or loss by stock compared with its actual purchase cost",
    )
    comparison = frame.rename(
        columns={"invested": "Invested ($)", "value": "Current value ($)"}
    )
    st.bar_chart(
        comparison,
        x="Stock",
        y=["Invested ($)", "Current value ($)"],
        stack=False,
        color=["#64748b", "#2563eb"],
        height=230,
        alt="Purchase cost compared with current value for each holding",
    )
    st.caption(
        "Open stock holdings only; unrealized P&L excludes completed trades and trading fees. "
        "Values use the latest available broker quotes and update with the stock monitor."
    )


def paper_curve(state):
    frame = pd.DataFrame(state.get("equity_history", []))
    if frame.empty:
        return frame
    frame["Time"] = pd.to_datetime(
        frame["timestamp"], utc=True, errors="coerce"
    ).dt.tz_convert("America/Chicago")
    frame["Investment ($)"] = float(state["budget"])
    frame["Account value ($)"] = pd.to_numeric(frame["equity"], errors="coerce")
    frame["Profit/loss ($)"] = frame["Account value ($)"] - frame["Investment ($)"]
    return frame.dropna(subset=["Time", "Account value ($)"]).sort_values("Time")


def render_paper(state):
    curve = paper_curve(state)
    if curve.empty:
        return
    st.markdown("### Paper investment performance")
    st.line_chart(
        curve,
        x="Time",
        y=["Investment ($)", "Account value ($)"],
        color=["#64748b", "#2563eb"],
        alt="Paper account value over time compared with the initial investment",
    )
    points = (
        alt.Chart(curve)
        .mark_circle(size=20)
        .encode(
            x=alt.X("Time:T", title="Time (Chicago)"),
            y=alt.Y("Profit/loss ($):Q"),
            color=alt.condition(
                alt.datum["Profit/loss ($)"] >= 0,
                alt.value("#15803d"),
                alt.value("#dc2626"),
            ),
            tooltip=[
                alt.Tooltip("Time:T"),
                alt.Tooltip("Profit/loss ($):Q", format="+,.2f"),
            ],
        )
    )
    line = (
        alt.Chart(curve)
        .mark_line(color="#64748b")
        .encode(x="Time:T", y="Profit/loss ($):Q")
    )
    zero = (
        alt.Chart(pd.DataFrame({"zero": [0]}))
        .mark_rule(color="#64748b")
        .encode(y="zero:Q")
    )
    st.altair_chart(
        (line + points + zero).properties(height=220),
        width="stretch",
        alt="Total paper profit or loss over time, green above zero and red below zero",
    )
    st.caption(
        "Total paper P&L includes realized and unrealized returns after simulated trading costs; "
        "investment is the initial paper session amount."
    )
