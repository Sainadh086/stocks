"""Read broker snapshots off the UI thread; publish in the owning session."""

import threading
from concurrent.futures import Future
from datetime import datetime, timedelta, timezone
from typing import Any, NamedTuple

import streamlit as st

from brokers.robinhood import orders

REFRESH_INTERVAL = timedelta(seconds=30)


class PendingSnapshot(NamedTuple):
    future: Future[dict[str, Any]]
    account: str
    symbols: tuple[str, ...]
    baseline: datetime | None
    revision: int = 0


def invalidate() -> None:
    """Request fresh data and prevent an older in-flight read from publishing."""
    st.session_state["live_snapshot_revision"] = (
        st.session_state.get("live_snapshot_revision", 0) + 1
    )
    st.session_state.pop("live_snapshot_checked", None)


def publish(snapshot: dict[str, Any], symbols: list[str]) -> None:
    """Publish a synchronous order review, superseding background reads."""
    invalidate()
    requested = tuple(sorted(set(symbols)))
    st.session_state.update(
        live_snapshot=snapshot,
        live_snapshot_checked=datetime.now(timezone.utc),
        live_quote_symbols=list(requested),
        live_snapshot_requested_symbols=requested,
    )
    st.session_state.pop("live_error", None)


def _fetch(future: Future, account: str, symbols: tuple[str, ...]) -> None:
    # The worker never reads or writes Streamlit session state.
    if not future.set_running_or_notify_cancel():
        return
    try:
        future.set_result(orders.account_snapshot(account, symbols=list(symbols)))
    except Exception as exc:
        future.set_exception(exc)


def update(account: str, symbols: list[str]) -> None:
    """Retain good values during reads and failures, with one read in flight."""
    requested = tuple(sorted(set(symbols)))
    revision = st.session_state.get("live_snapshot_revision", 0)
    pending = st.session_state.get("live_snapshot_pending")
    if pending is not None:
        if not pending.future.done():
            return
        st.session_state.pop("live_snapshot_pending", None)
        current = (
            pending.account == account
            and pending.symbols == requested
            and pending.revision == revision
            and pending.baseline == st.session_state.get("live_snapshot_checked")
        )
        if current:
            try:
                st.session_state["live_snapshot"] = pending.future.result()
                st.session_state["live_quote_symbols"] = list(requested)
                st.session_state.pop("live_error", None)
            except Exception as exc:
                st.session_state["live_error"] = orders.mask(str(exc), account)
            # Failed reads are throttled too, while the last good data stays visible.
            st.session_state["live_snapshot_requested_symbols"] = requested
            st.session_state["live_snapshot_checked"] = datetime.now(timezone.utc)

    checked = st.session_state.get("live_snapshot_checked")
    age = datetime.now(timezone.utc) - checked if checked is not None else None
    due = age is None or age < timedelta(0) or age >= REFRESH_INTERVAL
    previous = st.session_state.get(
        "live_snapshot_requested_symbols",
        st.session_state.get("live_quote_symbols", ()),
    )
    if not due and tuple(sorted(set(previous))) == requested:
        return

    future = Future()
    st.session_state["live_snapshot_pending"] = PendingSnapshot(
        future, account, requested, checked, revision
    )
    try:
        threading.Thread(
            target=_fetch,
            args=(future, account, requested),
            name="live-snapshot-read",
            daemon=True,
        ).start()
    except RuntimeError as exc:
        # Report thread startup failures through the same throttled error path.
        future.set_exception(exc)
