"""Editable India recommendation quantities and explicit Kite confirmation."""

from datetime import datetime, timezone
from pathlib import Path
from uuid import uuid4

import pandas as pd
import streamlit as st

from brokers.kite import assessment as assessment_rules
from brokers.kite import rebalance
from shared import dialogs


def show_assessment(assessment):
    colour = {
        "Rebalance": "green",
        "Rebalance needed": "red",
        "Watch": "orange",
        "Hold": "gray",
    }[assessment["decision"]]
    st.markdown(f":{colour}[**Rebalance assessment: {assessment['decision']}**]")
    st.write(
        "Suitable to review and execute now"
        if assessment["good_day"]
        else "Prefer to wait or reassess before execution"
    )
    for reason in assessment["reasons"]:
        st.write(reason)
    if assessment["next_review"]:
        date = datetime.fromisoformat(assessment["next_review"])
        st.info(f"Suggested next rebalance review: {date:%A, %d %B %Y at %H:%M} IST")
    st.caption(
        f"Strategy: {assessment['strategy']} · Scan: {assessment['scan_date'] or 'unavailable'} · "
        f"Market breadth: {assessment['theme']}. Rules: confirmed two-scan exits take priority; "
        "routine allocation changes use a 5 percentage-point drift threshold. "
        "Hold reviews follow the next Friday trading session; Watch reviews use the next session. "
        "The suggested date is a reassessment date, not a prediction of a favourable market."
    )


@st.fragment
def render_button(
    view, client_factory, snapshot=None, strategy="momentum", insight=None
):
    if st.button("Rebalance in Kite", type="primary", key="india_rebalance"):
        try:
            assessment = assessment_rules.assess(view, snapshot, strategy, insight)
            show_assessment(assessment)
            with st.spinner("Loading Kite holdings and Yahoo Finance prices…"):
                client = client_factory()
                state = rebalance.account_state(client)
                rows = rebalance.editor_rows(view, state)
                keys = [f"{r.exchange}:{r.symbol}" for r in rows.itertuples()]
                quotes = rebalance.live_quotes(keys)
                rows["price_inr"] = [
                    float(rebalance.number(quotes[k]["last_price"])) for k in keys
                ]
                rows["price_as_of"] = [quotes[k]["quoted_at"] for k in keys]
                draft = dict(
                    id=uuid4().hex,
                    user=state["user"],
                    rows=rows,
                    opened_at=datetime.now(timezone.utc),
                    batch_id=None,
                    assessment=assessment,
                )
                st.session_state["kite_rebalance_draft"] = draft
            rebalance_dialog(draft, client_factory)
        except Exception as exc:
            st.error(f"Could not prepare Kite rebalance: {exc}")


@st.fragment
def show_result(batch, client_factory):
    unresolved = any(
        r["status"] in {"pending", "unknown", "submitting", "submitted"}
        for r in batch["results"]
    )
    check = st.button("Check Kite order status", key=f"kite_status_{batch['id']}")
    if unresolved or check:
        try:
            batch.update(rebalance.refresh_status(client_factory(), batch["id"]))
        except Exception as exc:
            st.warning(f"Execution status check will retry: {exc}")
    if batch["status"] == "completed":
        dialogs.finish(batch["id"])
        return
    elif batch["status"] in {"submitting", "unknown"}:
        st.warning("Order status needs checking in Kite. Do not repeat this rebalance.")
    else:
        st.warning(batch.get("error", "Some orders were not sent or have not filled."))
    if batch.get("results"):
        st.dataframe(
            pd.DataFrame(batch["results"]),
            hide_index=True,
            width="stretch",
            key=f"kite_results_{batch['id']}",
            alt="Kite rebalance order results",
        )
    remaining = len(batch["orders"]) - len(batch["results"])
    if remaining:
        st.caption(f"{remaining} remaining orders were not sent.")
    st.link_button("Open Kite orders", "https://kite.zerodha.com/orders")
    if any(
        r["status"] in {"pending", "unknown", "submitting", "submitted"}
        for r in batch["results"]
    ):
        dialogs.poll(batch["id"])


@st.dialog("Review and apply Kite rebalance", width="large")
def rebalance_dialog(draft, client_factory):
    if draft.get("batch_id"):
        batch = rebalance.get(draft["batch_id"])
        if batch and batch["status"] != "review":
            show_result(batch, client_factory)
            return
    if draft.get("assessment"):
        show_assessment(draft["assessment"])
    st.write("**1. Customise changes → 2. Review basket → 3. Apply rebalance**")
    st.caption(
        "Edit Sell shares and Buy shares, then review the basket. Set a quantity to zero to skip an order."
    )
    st.caption(
        "Real-money CNC delivery market orders · NSE/BSE · day validity · sells first. "
        "Buys wait for confirmed fills and sufficient funds. Final prices and charges can vary."
    )
    st.caption(
        "Indicative prices from Yahoo Finance may be delayed. Outside trading hours, "
        "the latest available session price is shown. Prices refresh when you confirm."
    )
    with st.form(f"kite_editor_form_{draft['id']}"):
        edited = st.data_editor(
            draft["rows"],
            hide_index=True,
            width="stretch",
            num_rows="fixed",
            disabled=[
                "symbol",
                "exchange",
                "status",
                "current_shares",
                "target_shares",
                "price_inr",
                "price_as_of",
            ],
            key=f"kite_rebalance_editor_{draft['id']}",
            alt="Editable recommended stock buy and sell quantities",
            column_config={
                "symbol": st.column_config.TextColumn("Stock"),
                "exchange": st.column_config.TextColumn("Exchange"),
                "status": st.column_config.TextColumn("Recommendation"),
                "current_shares": st.column_config.NumberColumn(
                    "Available shares", format="%d"
                ),
                "target_shares": st.column_config.NumberColumn(
                    "Recommended target", format="%d"
                ),
                "sell_shares": st.column_config.NumberColumn(
                    "Sell shares", min_value=0, step=1, required=True, format="%d"
                ),
                "buy_shares": st.column_config.NumberColumn(
                    "Buy shares", min_value=0, step=1, required=True, format="%d"
                ),
                "price_inr": st.column_config.NumberColumn(
                    "Yahoo price (₹)", format="₹%.2f"
                ),
                "price_as_of": st.column_config.TextColumn("Yahoo quote time"),
            },
        )
        reviewed = st.form_submit_button("Review rebalance", type="primary")
    if reviewed:
        try:
            draft["batch_id"] = None
            if datetime.now(timezone.utc) - draft["opened_at"] > rebalance.TTL:
                raise ValueError(
                    "Holdings preview expired. Close this popup and reopen Rebalance."
                )
            with st.spinner("Checking quantities, prices and funds for the basket…"):
                client = client_factory()
                if client.profile()["user_id"] != draft["user"]:
                    raise ValueError(
                        "Connected Kite account changed. Reopen Rebalance."
                    )
                batch = rebalance.review(client, edited, draft["rows"])
                draft["changes"] = rebalance.basket_changes(edited, batch["quotes"])
                draft["batch_id"] = batch["id"]
        except Exception as exc:
            st.error(f"Kite rebalance: {exc}")
    if draft.get("batch_id"):
        batch = rebalance.get(draft["batch_id"])
        if batch and batch["status"] == "review":
            st.markdown("**Basket ready for your confirmation**")
            changes = draft["changes"]
            for label, values in [
                ("Additions", ["Add"]),
                ("Removals", ["Remove"]),
                ("Quantity changes", ["Increase", "Reduce"]),
                ("Unchanged", ["Keep"]),
            ]:
                stocks = changes[changes["change"].isin(values)]["stock"].tolist()
                st.write(f"**{label}:** {', '.join(stocks) if stocks else 'None'}")
            st.dataframe(
                changes.round(2),
                hide_index=True,
                width="stretch",
                alt="Reviewed basket additions removals quantities and target weights",
            )
            metrics = st.columns(3)
            metrics[0].metric("Estimated sells", f"₹{batch['estimated_sells']:,.2f}")
            metrics[1].metric("Estimated buys", f"₹{batch['estimated_buys']:,.2f}")
            metrics[2].metric(
                "Additional cash estimate",
                f"₹{max(0, batch['required_buy_margin'] - batch['estimated_sells'] * 0.99):,.2f}",
            )
            st.caption(
                f"Available Kite funds: ₹{batch['available_funds']:,.2f} · "
                f"Buy margin including estimated charges: ₹{batch['required_buy_margin']:,.2f}. "
                "Estimates can change at execution. Apply uses the basket shown above; "
                "submit Review rebalance again to apply any quantity edits."
            )
            if st.button(
                "Confirm and rebalance in Kite",
                type="primary",
                key=f"apply_{batch['id']}",
            ):
                try:
                    with st.spinner(
                        "Applying rebalance: sells first, then funded buys…"
                    ):
                        result = rebalance.submit(
                            client_factory(), batch["id"], acknowledged=True
                        )
                    show_result(result, client_factory)
                except Exception as exc:
                    st.error(f"Kite rebalance: {exc}")
    st.caption(
        "Close this popup to cancel without placing orders. If Kite requests holdings authorisation, "
        "complete it in Kite before reviewing a new rebalance."
    )


try:
    from streamlit.components.v2 import component
except ModuleNotFoundError as exc:
    if exc.name not in {"streamlit.components.v2", "streamlit.components"}:
        raise
    component = None

_COMPONENT = (
    component(
        "kite_login_handoff",
        html='<button type="button">Open Kite login</button><p role="status"></p>',
        js=(Path(__file__).parent / "assets" / "login.js").read_text(),
    )
    if component is not None
    else None
)


def automatic_handoff_available():
    return _COMPONENT is not None


def login_button(login_url, redirect_url, on_connected):
    if _COMPONENT is None:
        st.link_button("Open Kite login", login_url)
        st.caption(
            "After logging in, return to this tab and click Check Kite connection. "
            "Automatic tab return requires the project Streamlit environment."
        )
        st.button(
            "Check Kite connection", key="kite_login_check", on_click=on_connected
        )
        return
    _COMPONENT(
        key="kite_login_button",
        data={"mode": "login", "loginUrl": login_url, "redirectUrl": redirect_url},
        on_connected_change=on_connected,
    )


def return_to_dashboard():
    if _COMPONENT is None:
        st.success(
            "Kite connected. Return to your original dashboard tab and check the connection."
        )
        return
    _COMPONENT(key="kite_login_return", data={"mode": "complete"})
