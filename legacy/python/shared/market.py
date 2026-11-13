"""Daily benchmark briefings, market status, and saved breadth explanations."""

from datetime import datetime
from zoneinfo import ZoneInfo

import streamlit as st

from shared import portfolio as portfolio_insights
from shared.market_data import (
    MARKETS,
    DailyMarkets,
    market_schedule,
    messages,
    report_theme,
    session_phase,
)  # noqa: F401
from shared.market_data import (
    MESSAGES as MESSAGES,
)
from shared.market_data import (
    Market as Market,
)
from shared.market_data import (
    benchmark_report as benchmark_report,
)
from shared.market_data import (
    fetch_daily_report as fetch_daily_report,
)


@st.cache_resource
def daily_markets():
    return DailyMarkets()


def daily_snapshot(market):
    now = datetime.now(ZoneInfo(market.zone))
    try:
        phase = session_phase(schedule(market.calendar, now.date()), now)
    except Exception:
        phase = "Session timing unavailable"
    report, error, pending = daily_markets().snapshot(market, now, phase)
    return now, phase, report, error, pending


@st.fragment(run_every="5s")
def render_header():
    with st.container(horizontal=True, vertical_alignment="center", gap="medium"):
        for market in MARKETS:
            now, phase, report, error, pending = daily_snapshot(market)
            theme = report_theme(report, now)
            color = {"bullish": "green", "bearish": "red", "mixed": "orange"}.get(
                theme, "gray"
            )
            with st.container(border=True):
                st.badge(f"{market.code} ({theme.capitalize()})", color=color)
                if report:
                    st.markdown(
                        f"**{market.benchmark} {report['price']:,.2f}** · {report['change_pct']:+.2f}%"
                    )
                    st.caption(f"{phase} · Close {report['date']:%d %b %Y}")
                else:
                    st.caption(
                        f"{market.benchmark} · {'Loading daily data…' if pending else 'Daily data unavailable'}"
                    )
                if error:
                    st.caption("Price feed unavailable · retrying automatically")


@st.fragment(run_every="5s")
def render_learning(india_dir, us_dir):
    st.subheader("Market learning", icon=":material/school:")
    st.caption(
        "Daily briefings refresh automatically while this app is open and on the next launch. Based on completed sessions; intraday quotes remain in the trading view."
    )
    with st.container(horizontal=True, gap="medium"):
        for market, directory in zip(MARKETS, (india_dir, us_dir)):
            now, phase, report, error, pending = daily_snapshot(market)
            theme = report_theme(report, now)
            color = {"bullish": "green", "bearish": "red", "mixed": "orange"}.get(
                theme, "gray"
            )
            with st.container(border=True):
                st.subheader(f"{market.name} market")
                st.badge(theme.capitalize(), color=color)
                st.caption(f"Briefing for {now:%d %b %Y} · {phase}")
                if report:
                    st.metric(
                        market.benchmark,
                        f"{report['price']:,.2f}",
                        f"{report['change_pct']:+.2f}% last session",
                        border=True,
                    )
                    st.markdown(
                        f"**Trend:** {report['distance_pct']:+.2f}% from the 50-session average ({report['sma50']:,.2f})."
                    )
                    st.line_chart(report["history"], height=180)
                    updated = datetime.fromisoformat(report["generated_at"])
                    st.caption(
                        f"Close: {report['date']:%d %b %Y} · Refreshed: {updated:%d %b, %H:%M %Z}"
                    )
                    if theme == "stale":
                        st.warning(
                            "Showing an older reading. Wait for a current briefing before interpreting today's conditions."
                        )
                elif pending:
                    st.info("Preparing today's benchmark analysis…")
                else:
                    st.info(
                        "Benchmark data is unavailable. Learning material remains available."
                    )
                if error:
                    st.caption(
                        "The price feed could not be updated. An automatic retry is scheduled."
                    )
                st.markdown("**What to follow today**")
                if theme == "bullish":
                    st.write(
                        "The benchmark closed above its 50-session average. Check whether strength extends across sectors and whether your holdings confirm the trend; avoid chasing a large opening move."
                    )
                elif theme == "bearish":
                    st.write(
                        "The benchmark closed below its 50-session average. Review position sizes, liquidity and your preplanned risk limits; a weak benchmark alone does not settle a long-term investment decision."
                    )
                else:
                    st.write(
                        "Confirm the latest benchmark and stock-specific data before drawing a directional conclusion. Mixed or older readings call for patience."
                    )
                insight = latest_insight(
                    str(directory), market.scan_pattern, market.name
                )
                with st.expander("Stock-universe breadth"):
                    if insight:
                        st.write(insight["quote"])
                        st.caption(
                            f"Saved scan: {insight['date']:%d %b %Y}. These selected-stock scans differ from benchmark returns. Refresh the corresponding analysis to update breadth."
                        )
                    else:
                        st.caption(
                            "Run the corresponding portfolio analysis to create a stock-universe scan."
                        )
                st.markdown("**Long-term account**")
                st.write(
                    "Start with your goals, time horizon and diversified allocation. Review concentration and rebalance against your plan; daily price moves need not trigger trades."
                )
                st.markdown("**Daily trading account**")
                st.write(
                    "Keep its capital and results separate. Define entry, invalidation, position size and a daily loss limit before trading. Test opening-range rules in paper trading and include fees and slippage; skipping a session is a valid choice."
                )
                lessons = (
                    (
                        "Trend versus daily return",
                        "A positive session can occur below the 50-session average. Daily return measures one session; the average measures a longer price trend.",
                    ),
                    (
                        "Diversification",
                        "Holding several stocks in one sector can leave shared risks. Review exposure across sectors and asset classes against your investment goals.",
                    ),
                    (
                        "Position sizing",
                        "A position's capital allocation and its loss at an exit level are different. Account for gaps, liquidity and execution costs when reviewing risk.",
                    ),
                    (
                        "Rebalancing",
                        "Rebalancing restores a planned allocation. Review taxes, costs and available cash before changing holdings.",
                    ),
                    (
                        "Breadth",
                        "An index can rise while many constituents fall. Compare broad participation with the benchmark rather than relying on one leading stock.",
                    ),
                )
                title, lesson = lessons[now.date().toordinal() % len(lessons)]
                st.markdown(f"**Today's lesson · {title}**")
                st.write(lesson)
                with st.expander("Before & after the bell"):
                    reflection = messages({"theme": theme})
                    st.markdown("**Before the bell**")
                    st.write(reflection["opening"])
                    st.markdown("**After the bell**")
                    st.write(reflection["closing"])
                    st.caption("Original reflections for the day's market theme.")
                source = (report or {}).get("source", "Unknown")
                st.caption(f"Benchmark source: {source}")
                st.markdown(
                    f"[Investor education · {'SEBI' if market.code == 'IND' else 'Investor.gov'}]({market.education_url})"
                )
    with st.expander("How market colors are calculated"):
        st.write(
            "Bullish = latest completed benchmark close above its 50-session simple moving average; bearish = below it; mixed = equal. Nifty 50 represents India and S&P 500 represents the US. These are descriptive trend labels, not predictions or order instructions. Weekends and exchange holidays use the latest completed session. Stale or missing data is shown in gray. Public data may be delayed."
        )


@st.cache_data(ttl=60, max_entries=4, show_spinner=False)
def latest_insight(directory, pattern, label):
    return portfolio_insights.market_insight(directory, pattern, label)


@st.cache_data(ttl=3600, max_entries=8, show_spinner=False)
def schedule(calendar, day):
    return market_schedule(calendar, day)
