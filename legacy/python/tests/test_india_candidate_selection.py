import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import unittest

import pandas as pd

from brokers.kite import selection as selection


class IndiaCandidateSelectionTests(unittest.TestCase):
    def setUp(self):
        self.snapshot = {
            "date": "2026-10-06",
            "holdings": [
                {
                    "symbol": "OLD",
                    "exchange": "NSE",
                    "portfolio_plan": "KEEP",
                    "shares": 10,
                }
            ],
        }
        self.potential = pd.DataFrame(
            [
                {
                    "stock": "NEW",
                    "strategies": "momentum, weekend_style",
                    "momentum_score": 90,
                },
                {"stock": "OTHER", "strategies": "naked_style", "momentum_score": 85},
                {"stock": "OLD", "strategies": "momentum", "momentum_score": 70},
            ]
        )
        self.ranked = pd.DataFrame(
            [
                {"symbol": s, "exchange": "NSE", "price": 100}
                for s in ["NEW", "OTHER", "OLD"]
            ]
        )
        self.choices = selection.candidates(
            self.snapshot, self.potential, self.ranked, pd.DataFrame(), "momentum"
        )

    def test_vetted_new_candidates_available_without_saved_buys(self):
        self.assertEqual(self.choices["buy"].tolist(), ["NEW"])
        result, buys = selection.selected_plan(
            self.snapshot, self.choices, ["NEW"], ["NSE:OLD"], 1
        )
        self.assertEqual(result["holdings"][0]["portfolio_plan"], "SELL")
        self.assertEqual(buys["buy"].tolist(), ["NEW"])
        self.assertEqual(self.snapshot["holdings"][0]["portfolio_plan"], "KEEP")

    def test_capacity_and_unvetted_selection_rejected(self):
        with self.assertRaisesRegex(ValueError, "limited to 1"):
            selection.selected_plan(self.snapshot, self.choices, ["NEW"], [], 1)
        with self.assertRaisesRegex(ValueError, "selection changed"):
            selection.selected_plan(
                self.snapshot, self.choices, ["OTHER"], ["NSE:OLD"], 1
            )

    def test_missing_prices_exclude_candidates(self):
        self.ranked["price"] = float("nan")
        self.assertTrue(
            selection.candidates(
                self.snapshot, self.potential, self.ranked, pd.DataFrame(), "momentum"
            ).empty
        )

    def test_selected_replacement_reaches_kite_editor(self):
        from brokers.kite import rebalance as rb

        self.snapshot["holdings"][0]["market_value_inr"] = 1000
        self.snapshot["holdings"][0]["action"] = "HOLD"
        snapshot, buys = selection.selected_plan(
            self.snapshot, self.choices, ["NEW"], ["NSE:OLD"], 1
        )
        view = selection.recommended_india_view(snapshot, buys, self.ranked)
        rows = rb.editor_rows(
            view,
            {"holdings": [{"exchange": "NSE", "tradingsymbol": "OLD", "quantity": 10}]},
        )
        orders = rb.orders_from_editor(rows, rows)
        self.assertEqual(
            [
                (o["tradingsymbol"], o["transaction_type"], o["quantity"])
                for o in orders
            ],
            [("OLD", "SELL", 10), ("NEW", "BUY", 10)],
        )

    def test_picker_changes_selected_buy_and_exit_without_orders(self):
        from streamlit.testing.v1 import AppTest

        app = AppTest.from_string("""import streamlit as st
from brokers.kite import selection as ui
import pandas as pd
snapshot,buys=ui.render(st.session_state['snapshot'],st.session_state['potential'],
    st.session_state['ranked'],pd.DataFrame(),'momentum',1)
st.session_state['result']=(snapshot,buys)
""")
        app.session_state["snapshot"] = self.snapshot
        app.session_state["potential"] = self.potential
        app.session_state["ranked"] = self.ranked
        app.run()
        self.assertFalse(app.exception)
        app.multiselect[0].select("NSE:OLD").run()
        app.multiselect[1].select("NEW").run()
        self.assertFalse(app.exception)
        snapshot, buys = app.session_state["result"]
        self.assertEqual(snapshot["holdings"][0]["portfolio_plan"], "SELL")
        self.assertEqual(buys["buy"].tolist(), ["NEW"])
        app.multiselect[0].unselect("NSE:OLD").run()
        self.assertEqual(app.multiselect[1].value, ["NEW"])
        self.assertIsNone(app.session_state["result"][0])
        app.multiselect[0].select("NSE:OLD").run()
        self.assertEqual(app.session_state["result"][1]["buy"].tolist(), ["NEW"])


if __name__ == "__main__":
    unittest.main()
