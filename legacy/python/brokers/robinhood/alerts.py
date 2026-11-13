"""Browser alert payloads for eligible US strategy actions; never places orders."""

from datetime import datetime, timezone
from hashlib import sha256
from pathlib import Path
from zoneinfo import ZoneInfo

import streamlit as st


def payload(account, model, now=None):
    now = now or datetime.now(timezone.utc)
    day = now.astimezone(ZoneInfo("America/Chicago")).date().isoformat()
    actions = sorted(
        (
            a
            for a in model["actions"]
            if a.get("enabled") and a["action"] in {"BUY", "EXIT"}
        ),
        key=lambda a: (a["side"] != "sell", a["symbol"]),
    )
    return dict(
        account_key=sha256(account.encode()).hexdigest()[:16],
        day=day,
        actions=[
            dict(
                key=f"{a['side']}:{a['symbol']}",
                symbol=a["symbol"],
                side="SELL" if a["side"] == "sell" else "BUY",
            )
            for a in actions
        ],
    )


try:
    from streamlit.components.v2 import component
except ModuleNotFoundError as exc:
    if exc.name != "streamlit.components.v2":
        raise
    component = None

_COMPONENT = (
    component(
        "us_rebalance_notifications",
        html='<button type="button" data-enable>Enable US rebalance alerts</button> '
        '<button type="button" data-test>Test alert</button> '
        '<button type="button" data-disable>Turn alerts off</button><p role="status"></p>',
        js=(Path(__file__).parent / "assets" / "notifications.js").read_text(),
    )
    if component
    else None
)


def render(account, model):
    if _COMPONENT is None:
        st.caption(
            "Browser notifications require the project Streamlit environment: sh stocks/run_dashboard.sh"
        )
        return
    _COMPONENT(key="us_rebalance_notification_permission", data=payload(account, model))
    st.caption(
        "Browser alerts require this tab and the dashboard server to stay running. "
        "A closed or suspended tab cannot deliver alerts. Alerts only prompt you to review; "
        "orders still need your Rebalance confirmation."
    )
