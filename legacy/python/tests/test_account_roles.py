import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import tempfile
import unittest
from unittest.mock import AsyncMock, patch

from cryptography.fernet import Fernet
from streamlit.testing.v1 import AppTest

from brokers.robinhood import accounts, analysis, client, orders, rebalance, strategy
from shared import portfolio, storage
from trading import agent as paper_agent


class AccountRoleTests(unittest.TestCase):
    def setUp(self):
        self.folder = tempfile.TemporaryDirectory()
        self.addCleanup(self.folder.cleanup)
        self.file = Path(self.folder.name) / "roles.json"
        self.patch = patch.object(accounts, "ROLES_FILE", self.file)
        self.patch.start()
        self.addCleanup(self.patch.stop)
        cipher = patch.object(
            storage, "cipher", return_value=Fernet(Fernet.generate_key())
        )
        cipher.start()
        self.addCleanup(cipher.stop)
        self.available = [
            dict(account_number="LONG1234", state="active", agentic_allowed=False),
            dict(account_number="TRADE5678", state="active", agentic_allowed=True),
            dict(account_number="OTHER9999", state="active", agentic_allowed=True),
        ]

    def test_persistent_roles_are_encrypted_and_account_order_cannot_change_them(self):
        accounts.save_roles("LONG1234", "TRADE5678", self.available)
        self.assertTrue(self.file.read_bytes().startswith(storage.MAGIC))
        self.assertNotIn(b"LONG1234", self.file.read_bytes())
        self.assertEqual(
            accounts.load_roles(), {"long_term": "LONG1234", "trading": "TRADE5678"}
        )
        self.assertEqual(
            accounts.selected_trading(list(reversed(self.available))), "TRADE5678"
        )
        self.assertEqual(analysis.holdings_source(), accounts.holdings_path("LONG1234"))
        self.assertIsNone(accounts.selected_trading([self.available[2]]))
        self.assertEqual(accounts.load_roles()["trading"], "TRADE5678")

    def test_invalid_change_preserves_existing_roles_and_guards_long_term_account(self):
        accounts.save_roles("LONG1234", "TRADE5678", self.available)
        for long_term, trading in (
            ("LONG1234", "LONG1234"),
            ("TRADE5678", "LONG1234"),
            ("LONG1234", "GONE"),
            (None, "TRADE5678"),
        ):
            with self.assertRaises(ValueError):
                accounts.save_roles(long_term, trading, self.available)
            self.assertEqual(accounts.load_roles()["trading"], "TRADE5678")
        with self.assertRaisesRegex(ValueError, "long-term"):
            accounts.require_trading_role("LONG1234")
        with self.assertRaisesRegex(ValueError, "changed"):
            accounts.require_trading_role("OTHER9999")
        accounts.require_trading_role("TRADE5678")

    def test_sync_writes_only_selected_long_term_holdings(self):
        accounts.save_roles("LONG1234", "TRADE5678", self.available)
        response = {"data": {"positions": [dict(symbol="AAPL", quantity="2")]}}
        with patch.object(
            client, "_request", new=AsyncMock(return_value=response)
        ) as read:
            client.sync_long_term_holdings()
        self.assertEqual(
            read.call_args.args[0]["arguments"]["account_number"], "LONG1234"
        )
        self.assertTrue(accounts.holdings_path("LONG1234").exists())
        self.assertFalse(accounts.holdings_path("TRADE5678").exists())
        self.assertEqual(analysis.load_holdings().iloc[0].quantity, 2)

    def test_tabs_share_normalized_holdings_without_mutating_the_snapshot(self):
        accounts.save_roles("LONG1234", "TRADE5678", self.available)
        source = accounts.holdings_path("LONG1234")
        storage.write_text(source, "symbol,quantity\naapl,2\nAAPL,3\n")
        state = {}
        first = portfolio.saved_data(state, source, analysis.load_holdings, None)
        self.assertEqual(first.iloc[0].quantity, 5)
        first.loc[0, "quantity"] = 999
        other_tab = portfolio.saved_data(state, source, analysis.load_holdings, None)
        self.assertEqual(other_tab.iloc[0].quantity, 5)
        storage.write_text(source, "symbol,quantity\nAAPL,4\n")
        updated = portfolio.saved_data(state, source, analysis.load_holdings, None)
        self.assertEqual(updated.iloc[0].quantity, 4)
        self.assertEqual(other_tab.iloc[0].quantity, 5)
        accounts.save_roles("OTHER9999", "TRADE5678", self.available)
        new_source = analysis.holdings_source()
        self.assertIsNone(
            portfolio.saved_data(state, new_source, analysis.load_holdings, None)
        )

    def test_live_settings_are_encrypted_account_specific_and_independent_of_paper(
        self,
    ):
        accounts.save_roles("LONG1234", "TRADE5678", self.available)
        self.assertEqual(strategy.saved_budget("TRADE5678"), (None, None))
        worker = paper_agent.PaperAgent(
            Path(self.folder.name) / "paper.json", start_worker=False
        )
        worker.control("start", paper_agent.new_account(50000, 80))
        self.assertEqual(strategy.saved_budget("TRADE5678"), (None, None))
        accounts.save_trading_settings("TRADE5678", 2500, 20)
        saved = accounts.trading_settings_path("TRADE5678").read_bytes()
        self.assertTrue(saved.startswith(storage.MAGIC))
        self.assertEqual(strategy.saved_budget("TRADE5678"), (2500, 20))
        for action in ("pause", "resume", "end"):
            worker.control(action)
        worker.control("start", paper_agent.new_account(100000, 90))
        self.assertEqual(strategy.saved_budget("TRADE5678"), (2500, 20))
        self.assertEqual(
            accounts.trading_settings_path("TRADE5678").read_bytes(), saved
        )
        accounts.save_roles("LONG1234", "OTHER9999", self.available)
        self.assertEqual(strategy.saved_budget("OTHER9999"), (None, None))
        accounts.save_trading_settings("OTHER9999", 700, 30)
        self.assertEqual(strategy.saved_budget("OTHER9999"), (700, 30))
        self.assertEqual(strategy.saved_budget("TRADE5678"), (2500, 20))
        self.assertEqual(worker.snapshot()["budget"], 100000)

    def test_invalid_live_settings_do_not_replace_existing_configuration(self):
        accounts.save_roles("LONG1234", "TRADE5678", self.available)
        accounts.save_trading_settings("TRADE5678", 2500, 20)
        for budget, reserve in (
            (0, 10),
            (-10, 10),
            (float("nan"), 10),
            (float("inf"), 10),
            (1000, -1),
            (1000, 101),
            (1000, float("nan")),
        ):
            with self.assertRaises(ValueError):
                accounts.save_trading_settings("TRADE5678", budget, reserve)
            self.assertEqual(strategy.saved_budget("TRADE5678"), (2500, 20))
        with self.assertRaises(ValueError):
            accounts.save_trading_settings("LONG1234", 1000, 10)
        with self.assertRaises(ValueError):
            accounts.save_trading_settings("OTHER9999", 1000, 10)

    def test_live_settings_ui_saves_without_trading_and_restores_after_navigation(self):
        accounts.save_roles("LONG1234", "TRADE5678", self.available)
        source = (
            "import streamlit as st\nfrom brokers.robinhood import ui\n"
            "view=st.segmented_control('View',['Live','Other'],default='Live',key='view')\n"
            "if view=='Live':\n    ui.render_live_settings('TRADE5678')"
        )
        with (
            patch.object(orders, "submit_reviewed_order") as submit,
            patch.object(rebalance, "submit") as send,
        ):
            app = AppTest.from_string(source).run()
            self.assertFalse(app.exception)
            self.assertEqual(strategy.saved_budget("TRADE5678"), (None, None))
            app.number_input[0].set_value(3500)
            app.slider[0].set_value(25)
            app.session_state["live_auto_rebalance"] = dict(
                rebalance.new_auto_state("TRADE5678"), enabled=True
            )
            next(
                b for b in app.button if b.label == "Save live trading settings"
            ).click().run()
            self.assertFalse(app.exception)
            self.assertEqual(strategy.saved_budget("TRADE5678"), (3500, 25))
            self.assertFalse(app.session_state["live_auto_rebalance"]["enabled"])
            app.segmented_control[0].set_value("Other").run()
            app.run()
            app.segmented_control[0].set_value("Live").run()
            self.assertEqual(app.number_input[0].value, 3500)
            fresh = AppTest.from_string(source).run()
            self.assertEqual(fresh.number_input[0].value, 3500)
            self.assertEqual(fresh.slider[0].value, 25)
            submit.assert_not_called()
            send.assert_not_called()

    def test_live_automation_stops_if_account_has_no_saved_live_settings(self):
        from brokers.robinhood import ui

        accounts.save_roles("LONG1234", "TRADE5678", self.available)
        app = AppTest.from_string(
            "from brokers.robinhood import ui\nui.run_auto_rebalance('TRADE5678')"
        )
        app.session_state["live_account_number"] = "TRADE5678"
        app.session_state["live_auto_rebalance"] = dict(
            rebalance.new_auto_state("TRADE5678"), enabled=True
        )
        with (
            patch.object(ui, "fresh_decisions") as decisions,
            patch.object(rebalance, "submit") as send,
        ):
            app.run()
            self.assertFalse(app.exception)
            self.assertFalse(app.session_state["live_auto_rebalance"]["enabled"])
            self.assertTrue(
                any("Save live trading settings" in e.value for e in app.error)
            )
            decisions.assert_not_called()
            send.assert_not_called()

    def test_ui_saves_explicit_choices_and_restores_them_in_a_new_session(self):
        with patch.object(client, "list_accounts", return_value=self.available):
            source = "from brokers.robinhood.ui import render_account_settings\nrender_account_settings()"
            app = AppTest.from_string(source).run()
            app.button(key="load_robinhood_roles").click().run()
            self.assertIsNone(app.selectbox[0].value)
            self.assertIsNone(app.selectbox[1].value)
            app.selectbox[0].set_value("LONG1234")
            app.selectbox[1].set_value("TRADE5678")
            next(
                b for b in app.button if b.label == "Save account selections"
            ).click().run()
            self.assertFalse(app.exception)
            self.assertEqual(accounts.load_roles()["trading"], "TRADE5678")
            self.assertFalse(app.selectbox)
            self.assertFalse(
                any(b.label == "Load Robinhood accounts" for b in app.button)
            )
            # A fresh browser session starts from the saved choices, not first options.
            fresh = AppTest.from_string(source).run()
            self.assertFalse(fresh.selectbox)
            fresh.button(key="edit_robinhood_accounts_button").click().run()
            fresh.button(key="load_robinhood_roles").click().run()
            self.assertEqual(fresh.selectbox[0].value, "LONG1234")
            self.assertEqual(fresh.selectbox[1].value, "TRADE5678")
            fresh.selectbox[1].set_value("OTHER9999").run()
            self.assertEqual(accounts.load_roles()["trading"], "TRADE5678")


if __name__ == "__main__":
    unittest.main()
