"""Close a successfully completed dialog without rerunning the dashboard."""

from pathlib import Path
from time import monotonic_ns

import streamlit as st

try:
    from streamlit.components.v2 import component
except ModuleNotFoundError as exc:
    if exc.name != "streamlit.components.v2":
        raise
    component = None

_CLOSE = (
    component(
        "completed_rebalance_dialog",
        html='<span role="status">Orders are successfully executed.</span>',
        js=(Path(__file__).parent / "assets" / "complete.js").read_text(),
    )
    if component
    else None
)


def finish(batch_id):
    completed = st.session_state.setdefault("rebalance_completion_notices", set())
    if batch_id not in completed:
        completed.add(batch_id)
        st.toast("Orders are successfully executed.", icon=":material/check_circle:")
    if _CLOSE is None:
        st.success("Orders are successfully executed. You can close this popup.")
        return
    _CLOSE(key=f"rebalance_completed_{batch_id}")


_POLL = (
    component(
        "rebalance_dialog_poll",
        html='<span role="status">Monitoring order execution…</span>',
        js=(Path(__file__).parent / "assets" / "poll.js").read_text(),
    )
    if component
    else None
)


def poll(batch_id):
    if _POLL is None:
        st.info("Check order execution in your broker account.")
        return
    _POLL(
        key=f"rebalance_poll_{batch_id}",
        data={"revision": monotonic_ns()},
        on_tick_change=lambda: None,
    )
