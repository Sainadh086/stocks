"""Choose vetted strategy candidates and holdings to replace in an India plan."""

import math
from copy import deepcopy

import numpy as np
import pandas as pd

STRATEGIES = ("momentum", "weekend_style", "naked_style")


def candidates(snapshot, potential, ranked, plan, strategy):
    held = {h["symbol"] for h in snapshot.get("holdings", [])}
    rows = []
    if not potential.empty and {"stock", "strategies"}.issubset(potential.columns):
        for row in potential.to_dict("records"):
            if strategy in [s.strip() for s in str(row["strategies"]).split(",")]:
                quote = (
                    ranked[ranked["symbol"].eq(row["stock"])]
                    if "symbol" in ranked
                    else pd.DataFrame()
                )
                if not quote.empty:
                    rows.append(
                        dict(
                            buy=row["stock"],
                            buy_exchange=quote.iloc[0].get("exchange", "NSE"),
                            buy_price=quote.iloc[0].get("price"),
                            momentum_score=row.get("momentum_score"),
                            reason=row.get("reason", "Vetted candidate"),
                        )
                    )
    if not plan.empty:
        for row in plan[plan["strategy"].eq(strategy)].to_dict("records"):
            rows.append({**row, "reason": "Vetted candidate in saved target plan"})
    choices = pd.DataFrame(
        rows, columns=["buy", "buy_exchange", "buy_price", "momentum_score", "reason"]
    )
    choices["buy_price"] = pd.to_numeric(choices["buy_price"], errors="coerce")
    choices = choices[
        ~choices["buy"].isin(held)
        & choices["buy_price"].gt(0)
        & np.isfinite(choices["buy_price"])
        & choices["buy_exchange"].isin(["NSE", "BSE"])
    ]
    return choices.drop_duplicates("buy").reset_index(drop=True)


def selected_plan(snapshot, choices, selected, exits, limit):
    result = deepcopy(snapshot)
    holding_keys = {
        f"{h.get('exchange', 'NSE')}:{h['symbol']}" for h in result.get("holdings", [])
    }
    if not set(exits).issubset(holding_keys) or not set(selected).issubset(
        set(choices["buy"])
    ):
        raise ValueError("Stock selection changed. Reopen the recommendation plan.")
    if len(selected) != len(set(selected)):
        raise ValueError("New stocks cannot be duplicated.")
    if len(holding_keys - set(exits)) + len(selected) > limit:
        raise ValueError(
            f"The target portfolio is limited to {limit} stocks. Select more holdings to replace."
        )
    for holding in result.get("holdings", []):
        key = f"{holding.get('exchange', 'NSE')}:{holding['symbol']}"
        if key in exits:
            if holding.get("portfolio_plan") != "SELL":
                holding["plan_reason"] = (
                    "Selected for replacement with a vetted strategy candidate"
                )
            holding["portfolio_plan"] = "SELL"
        else:
            if holding.get("portfolio_plan") == "SELL":
                holding["plan_reason"] = (
                    "Retained by your selection; review the saved exit signal"
                )
            holding["portfolio_plan"] = "KEEP"
    buys = (
        choices.set_index("buy").loc[list(selected)].reset_index()
        if selected
        else choices.iloc[:0].copy()
    )
    return result, buys


def render(snapshot, potential, ranked, plan, strategy, limit):
    import streamlit as st

    choices = candidates(snapshot, potential, ranked, plan, strategy)
    held = snapshot.get("holdings", [])
    options = [f"{h.get('exchange', 'NSE')}:{h['symbol']}" for h in held]
    default_exits = [
        key for key, h in zip(options, held) if h.get("portfolio_plan") == "SELL"
    ]
    with st.container(border=True):
        st.markdown("**Choose stocks for the rebalance**")
        st.caption(
            "Select holdings to replace and new stocks vetted for the selected strategy. "
            "Your choices update the allocation and the Kite confirmation popup."
        )
        exits = st.multiselect(
            "Holdings to sell and replace",
            options,
            default=default_exits,
            key=f"india_replacement_exits_{snapshot['date']}_{strategy}",
            persist_state="session",
        )
        slots = max(0, limit - (len(options) - len(exits)))
        defaults = []
        if not plan.empty:
            defaults = [
                s
                for s in plan.loc[
                    plan["strategy"].eq(strategy), "buy"
                ].drop_duplicates()
                if s in set(choices["buy"])
            ][:slots]
        if not defaults:
            defaults = choices["buy"].head(slots).tolist()
        labels = {
            r["buy"]: f"{r['buy']} · {r['buy_exchange']} · ₹{r['buy_price']:.2f}"
            for r in choices.to_dict("records")
        }
        selected = st.multiselect(
            "New stocks from this strategy",
            choices["buy"].tolist(),
            default=defaults,
            format_func=lambda s: labels[s],
            key=f"india_new_candidates_{snapshot['date']}_{strategy}",
            persist_state="session",
        )
        st.caption(f"{slots} available new-stock slots · Target limit: {limit} stocks")
        if not slots:
            st.info(
                "Select a holding to sell and replace to make room for a new stock."
            )
        if choices.empty:
            st.info(
                "No vetted candidates with usable prices for this strategy. Run India analysis to refresh them."
            )
        else:
            st.dataframe(
                choices.rename(
                    columns={
                        "buy": "stock",
                        "buy_price": "price_inr",
                        "buy_exchange": "exchange",
                    }
                ),
                hide_index=True,
                width="stretch",
                alt="Vetted India strategy candidates",
            )
        try:
            return selected_plan(snapshot, choices, selected, exits, limit)
        except ValueError as exc:
            st.warning(str(exc))
            return None, None


def recommended_india_view(snapshot, buys, quotes=None):
    """Compare current shares with an equal-value, whole-share target plan."""
    quotes = quotes if quotes is not None else pd.DataFrame()
    quote_by_symbol = (
        quotes.drop_duplicates("symbol").set_index("symbol")
        if not quotes.empty and "symbol" in quotes
        else pd.DataFrame()
    )
    rows = []
    for holding in snapshot.get("holdings", []):
        if holding.get("portfolio_plan") == "SELL":
            status = "Exit"
        elif holding.get("action") in ("WATCH", "NO DATA", "REPLACE"):
            status = "Review"
        else:
            status = "Keep"
        rows.append(
            {
                "symbol": holding["symbol"],
                "exchange": holding.get("exchange", "NSE"),
                "status": status,
                "signal": holding.get("action"),
                "plan_reason": holding.get("plan_reason"),
                "current_shares": holding.get("shares"),
                "estimated_value_inr": holding.get("market_value_inr"),
            }
        )
    for _, buy in buys.iterrows():
        quote = (
            quote_by_symbol.loc[buy["buy"]]
            if not quote_by_symbol.empty and buy["buy"] in quote_by_symbol.index
            else None
        )
        price = pd.to_numeric(buy.get("buy_price"), errors="coerce")
        if pd.isna(price) and quote is not None:
            price = pd.to_numeric(quote.get("price"), errors="coerce")
        exchange = buy.get("buy_exchange")
        if pd.isna(exchange) or not exchange:
            exchange = quote.get("exchange") if quote is not None else "NSE"
        rows.append(
            {
                "symbol": buy["buy"],
                "exchange": exchange,
                "status": "New",
                "signal": "Candidate",
                "plan_reason": "Vetted replacement candidate",
                "current_shares": 0,
                "estimated_value_inr": None,
                "price_inr": price,
            }
        )
    view = pd.DataFrame(
        rows,
        columns=[
            "symbol",
            "exchange",
            "status",
            "signal",
            "plan_reason",
            "current_shares",
            "price_inr",
            "estimated_value_inr",
        ],
    )
    if view.empty:
        return view
    values = pd.to_numeric(view["estimated_value_inr"], errors="coerce")
    current = pd.to_numeric(view["current_shares"], errors="coerce")
    held = view["status"] != "New"
    total = (
        values[held].sum()
        if values[held].notna().all() and values[held].gt(0).all()
        else None
    )
    view["price_inr"] = pd.to_numeric(view["price_inr"], errors="coerce")
    view.loc[held, "price_inr"] = values[held].div(current[held])
    view["current_allocation_pct"] = (
        (values.fillna(0) / total * 100).round(1) if total else float("nan")
    )
    selected = view["status"].isin(["Keep", "New"])
    review = view["status"] == "Review"
    count = int(selected.sum())
    view["target_allocation_pct"] = 0.0
    view["target_shares"] = 0.0
    view.loc[review, "target_shares"] = current[review]
    if total:
        view.loc[review, "target_allocation_pct"] = (
            values[review] / total * 100
        ).round(1)
    rebalance_budget = total - values[review].sum() if total else None
    if rebalance_budget and count:
        view.loc[selected, "target_allocation_pct"] = round(
            rebalance_budget / total / count * 100, 1
        )
        for index in view.index[selected]:
            price = view.at[index, "price_inr"]
            view.at[index, "target_shares"] = (
                math.floor(rebalance_budget / count / price)
                if pd.notna(price) and price > 0
                else float("nan")
            )
    else:
        view.loc[selected, "target_shares"] = float("nan")
    change = view["target_shares"] - current
    view["shares_to_buy"] = change.where(change > 0, 0)
    view["shares_to_sell"] = (-change).where(change < 0, 0)
    return view.sort_values(["status", "estimated_value_inr"], ascending=[True, False])
