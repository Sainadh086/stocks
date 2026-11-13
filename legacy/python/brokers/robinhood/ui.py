"""Four-stock live strategy monitor with prepared, user-confirmed orders."""

from datetime import datetime, timezone
from zoneinfo import ZoneInfo

import pandas as pd
import streamlit as st

from brokers.robinhood import (
    accounts as account_roles,
)
from brokers.robinhood import (
    alerts,
    client,
    orders,
    performance,
    rebalance,
    snapshots,
    strategy,
)
from brokers.robinhood import history as trade_history
from shared import dialogs


@st.cache_resource
def signal_monitor():
    # This resource uses the intraday feed, independent of recommendation scans.
    return strategy.SignalMonitor()


def clear_account_view():
    auto = st.session_state.get("live_auto_rebalance")
    if auto:
        rebalance.disable_auto(auto, st.session_state.get("live_rebalance"))
    snapshots.invalidate()
    for key in (
        "live_snapshot",
        "live_snapshot_checked",
        "live_snapshot_requested_symbols",
        "live_quote_symbols",
        "live_ticket_id",
        "live_error",
        "live_action_error",
        "live_rebalance",
    ):
        st.session_state.pop(key, None)


def render_account_settings():
    try:
        roles = account_roles.load_roles()
    except Exception as exc:
        st.error(f"Account settings could not be read: {exc}")
        return
    configured = all(roles.values())
    editing = st.session_state.get("edit_robinhood_accounts", False)
    if configured:
        st.caption("Robinhood · accounts configured")
        st.button(
            "Done" if editing else "Account settings",
            key="edit_robinhood_accounts_button",
            on_click=st.session_state.update,
            args=({"edit_robinhood_accounts": not editing},),
            width="stretch",
        )
    if not configured or editing:
        render_account_picker(roles)
    if roles["long_term"] and st.button(
        "Sync long-term holdings", width="stretch", key="sync_long_term_roles"
    ):
        try:
            with st.spinner("Reading selected long-term holdings…"):
                count, omitted = client.sync_long_term_holdings()
            st.success(f"Synced {count} holdings; {omitted} other positions excluded.")
        except Exception as exc:
            st.error(f"Long-term holdings sync failed: {exc}")


def render_account_picker(roles):
    st.markdown("**Robinhood accounts**")
    for role, label in (("long_term", "Long-term"), ("trading", "Trading")):
        number = roles[role]
        st.caption(
            f"{label}: "
            + (f"account ending {number[-4:]}" if number else "not selected")
        )
    if st.button(
        "Load Robinhood accounts", width="stretch", key="load_robinhood_roles"
    ):
        try:
            with st.spinner("Reading available accounts…"):
                available = client.list_accounts()
            st.session_state["robinhood_role_accounts"] = available
            st.session_state["live_accounts"] = [
                a for a in available if a.get("agentic_allowed") is True
            ]
        except Exception as exc:
            st.error(f"Robinhood account discovery failed: {exc}")
    available = st.session_state.get("robinhood_role_accounts")
    if available is not None:
        current = [a for a in available if account_roles.eligible(a)]
        choices = [a["account_number"] for a in current]
        trading_choices = [
            a["account_number"] for a in current if a.get("agentic_allowed") is True
        ]

        def initial(options, saved):
            return options.index(saved) if saved in options else None

        def label(number):
            return f"Account ending {number[-4:]}"

        for role, options in (("long_term", choices), ("trading", trading_choices)):
            if roles[role] and roles[role] not in options:
                st.warning(
                    f"Saved {role.replace('_', '-')} account is unavailable in this connection. Selection is retained."
                )
        with st.form("robinhood_account_roles"):
            long_term = st.selectbox(
                "Long-term investing account",
                choices,
                index=initial(choices, roles["long_term"]),
                format_func=label,
            )
            trading = st.selectbox(
                "Daily trading account",
                trading_choices,
                index=initial(trading_choices, roles["trading"]),
                format_func=label,
            )
            save = st.form_submit_button("Save account selections", width="stretch")
        if save:
            try:
                account_roles.save_roles(long_term, trading, current)
                clear_account_view()
                st.session_state["live_account_number"] = trading
                st.session_state["edit_robinhood_accounts"] = False
                st.session_state["notice"] = (
                    "Robinhood account selections saved. Sync long-term holdings to load the investing account."
                )
                st.rerun()
            except Exception as exc:
                st.error(f"Account selections were not saved: {exc}")
    with st.expander("Account access"):
        st.caption(
            "Selections are saved locally in encrypted storage and change only when you save new choices. Daily trading requires an Agentic-enabled account. If the connected service does not expose your regular account, it cannot be selected here; reconnect with access to that account."
        )


def display_ticket(ticket, account, permitted=True):
    args = ticket["arguments"]
    verb = "Buy" if args["side"] == "buy" else "Sell"
    size = (
        f"${args['dollar_amount']}"
        if "dollar_amount" in args
        else f"{args['quantity']} shares"
    )
    st.markdown(f"**Review: {verb} {args['symbol']} · {size}**")
    kind = args["type"].replace("_", " ").capitalize()
    st.caption(
        f"Account ending {account[-4:]} · {kind} order · Regular hours · Good for day"
    )
    if args.get("limit_price"):
        st.caption(f"Limit price: ${args['limit_price']}")
    if args.get("stop_price"):
        st.caption(f"Stop price: ${args['stop_price']}")
    preview = ticket["preview"]
    disclosure = preview.get("market_data_disclosure")
    if disclosure:
        st.text(disclosure)
    quote = preview.get("quote_data") or {}
    if quote:
        with st.expander("Quote details"):
            st.json(orders.mask(quote, account))
    alerts = preview.get("order_checks") or {}
    if alerts:
        st.warning("Read Robinhood’s pre-trade alerts before confirming.")
        st.json(orders.mask(alerts, account))
    status = ticket["status"]
    if status == "preview":
        age = datetime.now(timezone.utc) - datetime.fromisoformat(ticket["reviewed_at"])
        expired = age > orders.PREVIEW_TTL or age.total_seconds() < 0
        if expired:
            st.info("Quote expired. Click the stock’s action again for a new review.")
        elif not permitted:
            st.info(
                "This action has changed or current data is unavailable. Refresh the monitor before deciding."
            )
        st.caption("Confirming sends this order to Robinhood using real money.")
        st.button(
            f"Confirm {verb.lower()} {args['symbol']} · {size}",
            type="primary",
            disabled=expired or not permitted,
            key=f"live_submit_{ticket['id']}",
            on_click=submit_ticket,
            args=(ticket["id"], account),
        )
    elif status == "submitted":
        result = ticket.get("result", {})
        broker_order = result.get("order") or {}
        state = broker_order.get("state")
        st.success(
            f"Robinhood order status: {state}."
            if state
            else "Robinhood returned a response. Check for any approval required in the Robinhood app."
        )
        st.caption(
            "Submitted orders may remain queued or partially filled. Check the live order status."
        )
        with st.expander("Broker response"):
            st.json(orders.mask(result, account))
    elif status in {"not_submitted", "rejected"}:
        st.error(
            "Order was not sent."
            if status == "not_submitted"
            else "Robinhood rejected the order."
        )
        st.text(orders.mask(ticket.get("error", ""), account))
    else:
        st.warning(
            "Order status is unresolved. Check Robinhood activity before another trade. "
            "This dashboard does not automatically retry submissions."
        )
        if ticket.get("error"):
            st.text(orders.mask(ticket["error"], account))
    if status in {"submitted", "submitting", "unknown"}:
        st.button(
            "Check order status",
            key=f"live_check_{ticket['id']}",
            on_click=reconcile_ticket,
            args=(ticket["id"], account),
        )


def submit_ticket(ticket_id, account):
    try:
        orders.submit_reviewed_order(ticket_id, acknowledged=True)
        snapshots.invalidate()
    except Exception as exc:
        st.session_state["live_action_error"] = orders.mask(str(exc), account)


def reconcile_ticket(ticket_id, account):
    try:
        orders.reconcile_ticket(ticket_id)
        snapshots.invalidate()
    except Exception as exc:
        st.session_state["live_action_error"] = orders.mask(str(exc), account)


def open_ticket(ticket_id):
    st.session_state["live_ticket_id"] = ticket_id


def ticket_still_applies(ticket, model):
    if ticket.get("origin") != "strategy":
        return False
    args = ticket["arguments"]
    for action in model["actions"]:
        if (
            action["symbol"] == args["symbol"]
            and action["side"] == args["side"]
            and action["enabled"]
        ):
            field = "dollar_amount" if args["side"] == "buy" else "quantity"
            return strategy.amount(args[field]) <= strategy.amount(action[field])
    return False


@st.fragment
def render():
    st.subheader("Agentic intraday trading")
    st.write(
        "Opening-range breakout signals for your separate Agentic trading account. "
        "Review orders manually with Rebalance, or enable auto rebalance below."
    )
    st.caption(
        "15-minute opening range · opening volume ≥1.5× baseline · completed 5-minute breakout · "
        "0.25% equity risk per trade · opening-range stop · 2R target · 1% daily loss limit · "
        "up to four positions · one entry per stock per day · exit five minutes before exchange close. "
        "Manual mode requires confirmation for each basket. Auto mode submits eligible entries and exits while this dashboard session is open."
    )
    if error := st.session_state.pop("live_action_error", None):
        st.error(error)
    load = st.button("Refresh live monitor", key="live_load_accounts")
    accounts = st.session_state.get("live_accounts")
    if load:
        snapshots.invalidate()
        signal_monitor().wake.set()
    if accounts is None or load:
        try:
            with st.spinner("Loading your connected trading account…"):
                accounts = orders.list_trading_accounts()
            st.session_state["live_accounts"] = accounts
        except Exception as exc:
            st.error(f"Could not load Robinhood: {exc}")
            return
    if not accounts:
        clear_account_view()
        st.session_state.pop("live_account_number", None)
        st.info(
            "No trading account is accessible through this connection. Reconnect Robinhood from the sidebar."
        )
        return
    try:
        account = account_roles.selected_trading(accounts)
    except Exception as exc:
        st.error(f"Saved account selection could not be read: {exc}")
        return
    if not account:
        clear_account_view()
        st.session_state.pop("live_account_number", None)
        st.info(
            "Choose and save a trading account in the sidebar. An unavailable saved account is never replaced automatically."
        )
        return
    if st.session_state.get("live_account_number") != account:
        clear_account_view()
        st.session_state["live_account_number"] = account
    st.caption(f"Selected trading account · ending {account[-4:]}")
    try:
        render_live_settings(account)
        budget, reserve = strategy.saved_budget(account)
        if budget is not None:
            st.caption(
                f"Saved live budget: ${budget:,.2f} · cash reserve: {reserve:g}%"
            )
        else:
            st.info("Save your live budget and cash reserve above to prepare new buys.")
    except Exception as exc:
        st.error(f"Could not load strategy settings: {exc}")
        return
    render_stocks(account)
    run_auto_rebalance(account)


def render_live_settings(account):
    try:
        budget, reserve = strategy.saved_budget(account)
    except (ValueError, OSError) as exc:
        budget, reserve = None, None
        st.warning(f"Live settings need correction: {orders.mask(str(exc), account)}")
    scope = account_roles.trading_settings_path(account).stem
    budget_key, reserve_key = f"{scope}_budget", f"{scope}_reserve"
    st.session_state.setdefault(budget_key, budget if budget is not None else 1000.0)
    st.session_state.setdefault(
        reserve_key, int(reserve) if reserve is not None else 10
    )
    batch = st.session_state.get("live_rebalance")
    running = bool(
        batch
        and batch.get("account") == account
        and batch["status"] in rebalance.ACTIVE
    )
    with st.container(border=True):
        st.markdown("**Live trading settings**")
        st.caption(
            "Budget limits deployed capital in this real-money account. Saving settings prepares the strategy; use Rebalance to confirm orders or explicitly enable Auto rebalance."
        )
        with st.form(f"{scope}_form"):
            st.number_input(
                "Live trading budget (USD)",
                min_value=1.0,
                step=100.0,
                key=budget_key,
                persist_state="session",
            )
            st.slider(
                "Live cash reserve (%)",
                0,
                100,
                key=reserve_key,
                persist_state="session",
            )
            save = st.form_submit_button("Save live trading settings", disabled=running)
        if running:
            st.caption("Finish the active rebalance before changing live settings.")
        if save:
            try:
                current = st.session_state.get("live_rebalance")
                if (
                    current
                    and current.get("account") == account
                    and current["status"] in rebalance.ACTIVE
                ):
                    raise ValueError(
                        "Finish the active rebalance before changing live settings."
                    )
                account_roles.save_trading_settings(
                    account, st.session_state[budget_key], st.session_state[reserve_key]
                )
                auto = st.session_state.get("live_auto_rebalance")
                if auto and auto["account"] == account:
                    rebalance.disable_auto(auto, current)
                st.success(
                    "Live settings saved for this account. Automatic trading is off; enable it explicitly when ready."
                )
            except Exception as exc:
                st.error(orders.mask(str(exc), account))


def set_auto_rebalance(account):
    state = st.session_state["live_auto_rebalance"]
    enabled = st.session_state[f"live_auto_enabled_{account}"]
    if state["account"] != account:
        return
    if enabled:
        state.update(enabled=True, last_check=None, error=None)
    else:
        rebalance.disable_auto(state, st.session_state.get("live_rebalance"))


def render_auto_controls(account, budget, reserve):
    state = st.session_state.get("live_auto_rebalance")
    if not state or state["account"] != account:
        state = rebalance.new_auto_state(account)
        st.session_state["live_auto_rebalance"] = state
    if state["enabled"] and (budget is None or reserve is None):
        rebalance.disable_auto(state, st.session_state.get("live_rebalance"))
    key = f"live_auto_enabled_{account}"
    st.session_state[key] = state["enabled"]
    with st.container(border=True):
        st.toggle(
            "Auto rebalance · real-money US trades",
            key=key,
            disabled=budget is None or reserve is None,
            on_change=set_auto_rebalance,
            args=(account,),
            help="Enabling authorizes eligible intraday market buys and sells for this Agentic account without confirming each basket. Off by default in each new dashboard session.",
        )
        st.caption(
            f"Account ending {account[-4:]} · uses the saved trading budget and reserve · checks every 15 seconds. "
            "Keep this dashboard session open. Switching accounts disables auto mode. "
            "Turning it off stops new submissions; orders already sent stay with Robinhood."
        )


@st.fragment(run_every="15s")
def run_auto_rebalance(account):
    state = st.session_state.get("live_auto_rebalance")
    if (
        not state
        or state["account"] != account
        or st.session_state.get("live_account_number") != account
    ):
        return
    if state["enabled"]:
        try:
            budget, reserve = strategy.saved_budget(account)
            if budget is None or reserve is None:
                raise ValueError(
                    "Save live trading settings for this account before enabling automatic trades."
                )
        except Exception as exc:
            rebalance.disable_auto(state, st.session_state.get("live_rebalance"))
            state["error"] = orders.mask(str(exc), account)
    if state["enabled"]:
        previous = st.session_state.get("live_rebalance")
        batch = rebalance.tick_auto(state, account, fresh_decisions, previous)
        if batch:
            st.session_state["live_rebalance"] = batch
        if (
            batch is not previous
            or batch
            and batch.get("automatic")
            and batch["status"] in rebalance.ACTIVE
        ):
            snapshots.invalidate()
    if state.get("error"):
        st.error("Auto rebalance paused: " + orders.mask(state["error"], account))
    elif state["enabled"]:
        st.info(
            "Auto rebalance is enabled. Eligible intraday orders are submitted automatically."
        )
    batch = st.session_state.get("live_rebalance")
    if batch and batch.get("automatic") and batch["account"] == account:
        st.markdown("**Automatic rebalance results**")
        progress_view()(batch)
        if batch["status"] == "completed":
            st.success("Automatic rebalance completed. All orders filled.")
        elif batch["status"] == "stopped":
            st.caption(
                orders.mask(batch.get("error", "Automatic rebalance stopped."), account)
            )
            if st.button(
                "Check automatic order status", key=f"auto_check_{batch['id']}"
            ):
                try:
                    rebalance.refresh(batch)
                except Exception as exc:
                    st.error(orders.mask(str(exc), account))


@st.fragment(run_every="2s")
def render_stocks(account):
    load = st.button("Refresh stock signals", key="live_refresh_stocks")
    if load:
        snapshots.invalidate()
    if error := st.session_state.pop("live_action_error", None):
        st.error(error)
    monitor = signal_monitor()
    if load:
        monitor.wake.set()
    try:
        signals = monitor.snapshot()
        budget, reserve = strategy.saved_budget(account)
    except Exception as exc:
        st.error(f"Could not load strategy settings: {exc}")
        return
    render_auto_controls(account, budget, reserve)
    selected = strategy.selected_signals(signals)
    symbols = selected.symbol.tolist() if not selected.empty else []
    snapshots.update(account, symbols)
    if st.session_state.get("live_error"):
        st.warning("Live refresh failed: " + st.session_state["live_error"])
    snapshot = st.session_state.get("live_snapshot")
    if not snapshot:
        st.info("Loading live holdings, prices, and orders…")
        return
    try:
        tickets = orders.list_tickets(account)
        model = strategy.build_actions(snapshot, signals, budget, reserve, tickets)
        plan = strategy.rebalance_plan(
            snapshot, signals, budget, reserve, tickets, current=model
        )
    except Exception as exc:
        st.error(
            f"Could not prepare strategy decisions: {orders.mask(str(exc), account)}"
        )
        return
    alerts.render(account, plan)
    checked = datetime.fromisoformat(snapshot["updated_at"]).astimezone(
        ZoneInfo("America/Chicago")
    )
    caption = (
        f"Live prices and orders: {checked:%H:%M:%S %Z} · refresh every 30 seconds"
    )
    if signals.get("asof"):
        scan = datetime.fromisoformat(signals["asof"]).astimezone(
            ZoneInfo("America/Chicago")
        )
        caption += f" · intraday scan: {scan:%b %d, %H:%M:%S %Z}"
    st.caption(caption)
    performance.render_live(snapshot)
    st.info(model["message"])
    if len(model["shortlist"]) < 4:
        st.caption(
            "Only stocks passing the strategy filters are included. Empty slots stay in cash."
        )
    eligible = rebalance.eligible_actions(plan)
    alert_key = "us_rebalance_opportunity_" + account[-4:]
    opportunity = tuple(sorted((a["symbol"], a["side"]) for a in eligible))
    if opportunity and st.session_state.get(alert_key) != opportunity:
        st.toast(
            "Rebalance ready: "
            + ", ".join(f"{a['side'].upper()} {a['symbol']}" for a in eligible),
            icon=":material/notifications:",
        )
    st.session_state[alert_key] = opportunity
    if eligible:
        st.warning(
            f"Rebalance ready · {sum(a['side'] == 'sell' for a in eligible)} sells · "
            f"{sum(a['side'] == 'buy' for a in eligible)} buys. Enable browser alerts and use Test alert to verify delivery."
        )
    active = st.session_state.get("live_rebalance")
    running = bool(
        active
        and active.get("account") == account
        and active["status"] in rebalance.ACTIVE
    )
    if running and st.button("View rebalance progress", key="live_rebalance_progress"):
        rebalance_dialog(active)
    auto = st.session_state.get("live_auto_rebalance", {})
    auto_enabled = auto.get("enabled", False) and auto.get("account") == account
    if st.button(
        "Rebalance",
        type="primary",
        disabled=not eligible or running or auto_enabled,
        key="live_rebalance_button",
    ):
        try:
            with st.spinner("Preparing eligible buys and sells…"):
                fresh, fresh_signals = fresh_decisions(account, planning=True)
                batch = rebalance.prepare(account, fresh, fresh_signals)
                st.session_state["live_rebalance"] = batch
            rebalance_dialog(batch)
        except Exception as exc:
            st.error(orders.mask(str(exc), account))
    st.caption(
        "Only currently eligible orders are included. HOLD and WAIT stocks stay unchanged."
    )
    by_symbol = {a["symbol"]: a for a in model["actions"]}
    if model["shortlist"]:
        st.markdown("**Your four-stock shortlist**")
        columns = st.columns(4)
        for column, pick in zip(columns, model["shortlist"]):
            action = by_symbol[pick["symbol"]]
            with column, st.container(border=True):
                st.subheader(pick["symbol"])
                st.write(
                    f"**{action['action']}** · Opening volume {pick['relative_volume']:.2f}×"
                )
                display_performance(action)
                if action.get("price"):
                    st.caption(f"Latest trade: ${float(action['price']):,.2f}")
                st.caption(action["reason"])
                if action["side"] == "buy":
                    st.write(f"Prepared buy: ${action.get('dollar_amount', '0')}")
    exits = [a for a in model["actions"] if a["side"] == "sell"]
    if exits:
        st.markdown("**Holdings to review for exit**")
        for action in exits:
            with st.container(border=True):
                st.write(
                    f"**{action['symbol']} · {'SELL' if action['action'] == 'EXIT' else action['action']}**"
                )
                display_performance(action)
                st.caption(action["reason"])
                st.write(f"Prepared sale: {action['quantity']} shares")
    ticket_id = st.session_state.get("live_ticket_id")
    if ticket_id:
        try:
            ticket = orders.get_ticket(ticket_id)
            if ticket and ticket["arguments"]["account_number"] == account:
                display_ticket(
                    ticket, account, permitted=ticket_still_applies(ticket, model)
                )
        except Exception as exc:
            st.error(orders.mask(str(exc), account))
    history = trade_history.table(snapshot["orders"], tickets)
    if not history.empty:
        st.markdown("**US trade history**")
        st.dataframe(
            history.style.map(trade_history.pnl_style, subset=["Profit/loss ($)"]),
            hide_index=True,
            width="stretch",
            key=f"live_trade_history_{account}",
            column_config={
                name: st.column_config.NumberColumn(name, format="$%.2f")
                for name in ["Buy price ($)", "Sell price ($)", "Profit/loss ($)"]
            },
        )
        st.caption(
            "One row per buy order, with FIFO-matched sells. Times are Chicago time. "
            "Profit/loss is realized before fees; unknown entry prices stay blank. "
            "Partial exits show realized profit/loss for shares sold so far."
        )
    if model["actions"]:
        with st.expander("All holding and entry signals"):
            st.dataframe(
                pd.DataFrame(model["actions"])[["symbol", "action", "reason"]],
                hide_index=True,
                width="stretch",
                key=f"live_signals_{account}",
            )
    with st.expander("Saved order tickets"):
        if tickets:
            chosen = st.selectbox(
                "Saved ticket",
                [t["id"] for t in tickets],
                index=None,
                key="live_saved_ticket",
                format_func=lambda value: next(
                    f"{t['arguments']['side'].upper()} {t['arguments']['symbol']} · {t['status']}"
                    for t in tickets
                    if t["id"] == value
                ),
            )
            if chosen:
                st.button(
                    "Open saved ticket",
                    key="live_open_saved",
                    on_click=open_ticket,
                    args=(chosen,),
                )


def fresh_decisions(account, planning=False):
    signals = signal_monitor().snapshot()
    budget, reserve = strategy.saved_budget(account)
    selected = strategy.selected_signals(signals)
    symbols = selected.symbol.tolist() if not selected.empty else []
    snapshot = orders.account_snapshot(account, symbols=symbols)
    snapshots.publish(snapshot, symbols)
    builder = strategy.rebalance_plan if planning else strategy.build_actions
    return builder(
        snapshot, signals, budget, reserve, orders.list_tickets(account)
    ), signals


@st.dialog("Confirm rebalance", width="large")
def rebalance_dialog(batch):
    account = batch["account"]
    if st.session_state.get("live_account_number") != account:
        st.error("Account changed. Close this popup and review again.")
        return
    st.caption(
        f"Account ending {account[-4:]} · real-money market orders · regular hours"
    )
    if batch["status"] != "preview":
        render_rebalance_progress(batch)
        return
    update = progress_view()
    update(batch)
    if batch.pop("confirmation_requested", False):
        confirm_rebalance(batch, update)
        if batch["status"] != "preview":
            rebalance_progress(batch, update)
            return
    st.write(
        "Confirm once to send the orders below. Sells go first; orders are separate and may partially complete."
    )
    try:
        for ticket_id in batch["ticket_ids"]:
            ticket = orders.get_ticket(ticket_id)
            if not ticket:
                raise ValueError("A preview is missing. Review a new rebalance.")
            args = ticket["arguments"]
            preview = ticket["preview"]
            with st.expander(
                f"{args['side'].upper()} {args['symbol']} · broker quote and alerts"
            ):
                if preview.get("market_data_disclosure"):
                    st.text(preview["market_data_disclosure"])
                if preview.get("quote_data"):
                    st.json(orders.mask(preview["quote_data"], account))
                if preview.get("order_checks"):
                    st.warning("Robinhood pre-trade alerts")
                    st.json(orders.mask(preview["order_checks"], account))
        st.caption(
            "Confirmed sells run first. Conditional buys wait for sell fills and actual available buying power; reviewed buy amounts will not be increased."
        )
        if batch.get("confirmation_error"):
            st.error(batch["confirmation_error"])
        st.button(
            "Confirm rebalance",
            type="primary",
            key=f"confirm_rebalance_{batch['id']}",
            on_click=request_rebalance_confirmation,
            args=(batch,),
        )
    except Exception as exc:
        st.error(orders.mask(str(exc), account))


def request_rebalance_confirmation(batch):
    if batch["status"] == "preview":
        batch["confirmation_requested"] = True


def confirm_rebalance(batch, view=None):
    account = batch["account"]
    view = view or progress_view()
    try:
        if st.session_state.get("live_account_number") != account:
            raise ValueError("Connected account changed. Review a new rebalance.")
        if batch["status"] != "preview":
            return
        with st.spinner("Checking the confirmed rebalance…"):
            model, _ = fresh_decisions(account, planning=True)
            rebalance.submit(
                batch,
                model,
                acknowledged=True,
                model_provider=lambda: fresh_decisions(account)[0],
                on_progress=view,
            )
        snapshots.invalidate()
        batch.pop("confirmation_error", None)
    except Exception as exc:
        batch["confirmation_error"] = orders.mask(str(exc), account)


def progress_view():
    bar = st.empty()
    details = st.empty()
    phase = st.empty()

    def update(batch):
        filled = sum(row["status"] == "filled" for row in batch.get("results", []))
        total = len(batch["ticket_ids"])
        bar.progress(
            filled / total if total else 0, text=f"{filled} of {total} orders filled"
        )
        rows = []
        indexed = {row["id"]: row for row in batch.get("results", [])}
        ticket_ids = batch.get("ordered_ids", batch["ticket_ids"])
        tickets = orders.get_tickets(ticket_ids)
        for ticket_id in ticket_ids:
            ticket = tickets.get(ticket_id)
            if not ticket:
                rows.append(
                    {
                        "Stock": "Unavailable",
                        "Action": "Unknown",
                        "Buy amount (USD)": None,
                        "Sell shares": None,
                        "Progress": "Ticket missing; check Robinhood",
                    }
                )
                continue
            args = ticket["arguments"]
            result = indexed.get(ticket_id)
            rows.append(
                {
                    "Stock": args["symbol"],
                    "Action": args["side"].upper(),
                    "Buy amount (USD)": float(args["dollar_amount"])
                    if args["side"] == "buy"
                    else None,
                    "Sell shares": float(args["quantity"])
                    if args["side"] == "sell"
                    else None,
                    "Progress": order_progress_label(
                        batch["status"], args["side"], result
                    ),
                }
            )
        if rows:
            details.dataframe(
                pd.DataFrame(rows),
                hide_index=True,
                width="stretch",
                key=f"rebalance_orders_{batch['id']}",
                alt="Rebalance buys sells and order execution status",
                column_config={
                    "Buy amount (USD)": st.column_config.NumberColumn(format="$%.2f"),
                    "Sell shares": st.column_config.NumberColumn(format="%.6f"),
                },
            )
        phase.info(
            batch.get(
                "progress",
                "Review the complete buy and sell basket above before confirming.",
            )
        )

    return update


def order_progress_label(batch_status, side, result):
    """Describe one order without mixing status rules into table rendering."""
    if result:
        return (
            "Filled"
            if result["status"] == "filled"
            else result.get("broker_state") or result["status"]
        )
    if batch_status == "stopped":
        return "Not sent"
    if batch_status == "preview":
        return "Awaiting confirmation"
    return "Waiting for sells / buying power" if side == "buy" else "Queued"


def rebalance_progress(batch, update=None):
    update = update or progress_view()
    update(batch)
    if batch["status"] in rebalance.ACTIVE:
        with st.spinner(batch.get("progress", "Processing rebalance…")):
            rebalance.advance(
                batch,
                model_provider=lambda: fresh_decisions(batch["account"])[0],
                on_progress=update,
            )
        snapshots.invalidate()
        update(batch)
    if batch["status"] == "completed":
        results = batch.get("results", [])
        buys = sum(
            row["side"] == "buy" and row["status"] == "filled" for row in results
        )
        sells = sum(
            row["side"] == "sell" and row["status"] == "filled" for row in results
        )
        st.success(
            f"Rebalance completed: {buys} buy orders and {sells} sell orders filled."
        )
        dialogs.finish(batch["id"])
    elif batch["status"] == "stopped":
        st.error(
            orders.mask(batch.get("error", "Rebalance stopped."), batch["account"])
        )
    else:
        dialogs.poll(batch["id"])
        st.caption(
            "Keep this popup open. Buys continue automatically after sells fill and funds become available. Do not start a second rebalance."
        )


@st.fragment
def render_rebalance_progress(batch):
    # Poll events belong to this fragment, so the popup itself stays mounted.
    rebalance_progress(batch)


def display_performance(action):
    performance = action.get("performance")
    if performance is None:
        if action.get("side") != "buy":
            st.caption(
                "Return vs invested amount unavailable: waiting for purchase cost and price."
            )
        return
    pnl = performance["pnl"]
    percentage = performance["return_pct"]
    delta = (
        0
        if round(pnl, 2) == 0
        else f"{'+' if pnl > 0 else '-'}${abs(pnl):,.2f} ({percentage:+.2f}%)"
    )
    st.metric(
        "Holding value",
        f"${performance['value']:,.2f}",
        delta=delta,
        delta_color="normal",
    )
    st.caption(
        f"Invested: ${performance['invested']:,.2f} · unrealized return before fees"
    )


def prepare_action(account, action, signals):
    try:
        with st.spinner(f"Preparing {action['symbol']} for your review…"):
            arguments = strategy.prepared_arguments(account, action)
            ticket = orders.preview_order(arguments)
            ticket.update(origin="strategy", signal_time=signals.get("asof"))
            orders.save_ticket(ticket)
        st.session_state["live_ticket_id"] = ticket["id"]
    except Exception as exc:
        st.error(orders.mask(str(exc), account))
