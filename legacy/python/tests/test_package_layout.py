"""Regression checks for startup, shared paths, and broker separation."""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import ast
import json
import os
import tempfile
import unittest
from contextlib import ExitStack
from io import StringIO
from unittest.mock import Mock, patch

import pandas as pd
from streamlit.testing.v1 import AppTest

import backtest_momentum
from brokers.kite import analysis as kite
from brokers.kite import rebalance as kite_rebalance
from brokers.robinhood import accounts, client, long_term, orders
from brokers.robinhood import analysis as us
from shared import market, paths, storage
from trading import ui as paper_ui


class PackageLayout(unittest.TestCase):
    def test_backtest_help_exits_before_accessing_data_or_network(self):
        with (
            patch.object(sys, "argv", ["backtest_momentum.py", "--help"]),
            patch.object(sys, "stdout", StringIO()),
            patch.object(storage, "read_text") as read,
            patch.object(backtest_momentum, "load_prices") as download,
        ):
            with self.assertRaises(SystemExit) as exited:
                backtest_momentum.main()
        self.assertEqual(exited.exception.code, 0)
        read.assert_not_called()
        download.assert_not_called()

    def test_persistent_paths_keep_existing_root(self):
        root = Path(__file__).resolve().parents[1]
        self.assertEqual(paths.ROOT, root)
        self.assertEqual(storage.ROOT, root)
        self.assertEqual(Path(kite.INDIA_STOCKS_DIR), root / "india_stocks")
        self.assertEqual(us.US_STOCKS_DIR, root / "us_stocks")
        self.assertEqual(orders.TICKETS_FILE.parent, root / "us_stocks")
        self.assertEqual(kite_rebalance.JOURNAL.parent, root / "india_stocks")
        self.assertEqual(storage.OAUTH_FILE, root / ".robinhood_oauth.enc")

    def test_broker_packages_do_not_import_each_other(self):
        for broker in ("kite", "robinhood"):
            other = "robinhood" if broker == "kite" else "kite"
            for source in (paths.ROOT / "brokers" / broker).glob("*.py"):
                with self.subTest(source=source.name, broker=broker):
                    tree = ast.parse(source.read_text())
                    for node in ast.walk(tree):
                        if isinstance(node, ast.ImportFrom):
                            self.assertFalse(
                                (node.module or "").startswith(f"brokers.{other}")
                            )
                        elif isinstance(node, ast.Import):
                            self.assertFalse(
                                any(
                                    alias.name.startswith(f"brokers.{other}")
                                    for alias in node.names
                                )
                            )

    def test_project_node_runtime_is_still_discoverable(self):
        executable, _ = client.node_runtime()
        self.assertEqual(Path(executable).parent, paths.NODE_BIN)

    def test_settings_share_environment_and_file_lookup(self):
        with tempfile.TemporaryDirectory() as directory:
            env_file = Path(directory) / ".env"
            env_file.write_text('export STOCKS_TEST_VALUE="from-file"\n')
            with (
                patch.object(storage, "ENV_FILE", env_file),
                patch.dict(os.environ, {}, clear=True),
            ):
                self.assertEqual(storage.setting("STOCKS_TEST_VALUE"), "from-file")
                self.assertEqual(kite.get_credential("STOCKS_TEST_VALUE"), "from-file")
                self.assertIsNone(storage.setting("STOCKS_MISSING_VALUE"))
                with self.assertRaisesRegex(RuntimeError, "STOCKS_MISSING_VALUE"):
                    storage.require_setting("STOCKS_MISSING_VALUE")
                with patch.dict(os.environ, {"STOCKS_TEST_VALUE": "override"}):
                    self.assertEqual(storage.setting("STOCKS_TEST_VALUE"), "override")

    def test_dashboard_starts_and_refreshes_with_mocked_brokers(self):
        worker = Mock()
        worker.snapshot.return_value = None
        with tempfile.TemporaryDirectory() as directory, ExitStack() as stack:
            root = Path(directory)
            stack.enter_context(
                patch.object(accounts, "ROLES_FILE", root / "account_roles.json")
            )
            (root / "account_roles.json").write_text(
                json.dumps({"long_term": "LONG1234", "trading": "TRADE5678"})
            )
            accounts.holdings_path("LONG1234").write_text("symbol,quantity\nAAPL,2\n")
            (root / "india").mkdir()
            holding = {
                "symbol": "EXAMPLE",
                "exchange": "NSE",
                "shares": 2,
                "price": 100,
                "value": 200,
                "action": "HOLD",
                "momentum_score": 70,
                "portfolio_plan": "KEEP",
            }
            snapshot = {
                "date": "2026-10-06",
                "as_of": "2026-10-06T16:00:00+05:30",
                "score": 70,
                "holdings": [holding],
                "components": {"data_coverage_pct": 100},
            }
            (root / "india/history.json").write_text(
                json.dumps({"snapshots": [snapshot]})
            )
            for name, value in {
                "INDIA_STOCKS_DIR": str(root / "india"),
                "TOKEN_FILE": str(root / "india/token.json"),
                "PORTFOLIO_HISTORY_FILE": str(root / "india/history.json"),
                "PORTFOLIO_MEMORY_FILE": str(root / "india/memory.md"),
            }.items():
                stack.enter_context(patch.object(kite, name, value))
            stack.enter_context(patch.object(us, "US_STOCKS_DIR", root / "us"))
            stack.enter_context(
                patch.object(us, "HOLDINGS_CSV", root / "us/holdings.csv")
            )
            stack.enter_context(patch.object(paper_ui, "agent", return_value=worker))
            stack.enter_context(patch.object(market, "render_header"))
            stack.enter_context(patch.object(market, "render_learning"))
            stack.enter_context(
                patch.object(orders, "list_trading_accounts", return_value=[])
            )
            stack.enter_context(
                patch.object(
                    orders,
                    "submit_reviewed_order",
                    side_effect=AssertionError("No live trades"),
                )
            )
            stack.enter_context(
                patch.object(
                    kite,
                    "get_credential",
                    side_effect=RuntimeError("Missing test credentials"),
                )
            )
            scan = stack.enter_context(
                patch.object(us, "screen_index", return_value=pd.DataFrame())
            )
            portfolio_report = stack.enter_context(patch.object(us, "report_portfolio"))
            app = AppTest.from_file(
                str(paths.ROOT / "dashboard.py"), default_timeout=15
            ).run()
            self.assertFalse(app.exception)
            self.assertEqual(len(app.tabs), 10)
            self.assertIn("Benchmark comparison", [tab.label for tab in app.tabs])
            self.assertEqual(app.title[0].value, "varshan")
            self.assertIn("Market learning", [tab.label for tab in app.tabs])
            self.assertIn("Paper trading", [tab.label for tab in app.tabs])
            next(
                button
                for button in app.button
                if button.label == "Refresh US recommendations"
            ).click().run()
            self.assertFalse(app.exception)
            scan.assert_called_once()
            portfolio_report.assert_called_once()
            next(
                control
                for control in app.segmented_control
                if control.key == "holdings_market"
            ).set_value("US").run()
            self.assertFalse(app.exception)
            self.assertTrue(
                any(
                    header.value == "US · long-term holdings"
                    for header in app.subheader
                )
            )
            # Exercise the populated review through the actual dashboard, without broker orders.
            (root / "us").mkdir(exist_ok=True)
            source = accounts.holdings_path("LONG1234")
            report = pd.DataFrame(
                [
                    dict(
                        symbol="AAPL",
                        action="EXIT REVIEW",
                        long_term_action="EXIT REVIEW",
                        policy_version=long_term.POLICY_VERSION,
                        holdings_source=str(source.resolve()),
                        long_term_score=0,
                        long_term_reasons="Two years of earnings and cash-flow weakness",
                        next_year_earnings_growth_pct=-5,
                        earnings_forecast_analysts=10,
                    )
                ]
            )
            report.to_csv(root / "us/us_portfolio_momentum_2026_10_10.csv", index=False)
            app.run()
            self.assertFalse(app.exception)
            review = next(
                table.value
                for table in app.dataframe
                if "proposed_sell_quantity" in table.value
            )
            self.assertEqual(review.iloc[0].proposed_sell_quantity, 2)
            self.assertEqual(review.iloc[0].proposed_target_quantity, 0)
            source.write_text("symbol,quantity\nAAPL,3\n")
            app.run()
            self.assertFalse(app.exception)
            self.assertFalse(
                any("proposed_sell_quantity" in table.value for table in app.dataframe)
            )
            with patch.object(
                paper_ui, "agent", side_effect=RuntimeError("Paper storage unavailable")
            ):
                app.run()
                self.assertFalse(app.exception)
                self.assertTrue(
                    any(
                        "Paper storage unavailable" in error.value
                        for error in app.error
                    )
                )
                self.assertTrue(
                    any(widget.label == "Benchmark" for widget in app.selectbox)
                )
            with patch.object(
                us, "load_holdings", side_effect=ValueError("US holdings invalid")
            ):
                app.session_state["portfolio_report_cache"] = {}
                app.run()
                self.assertFalse(app.exception)
                self.assertTrue(
                    any(
                        "US holdings invalid" in warning.value
                        for warning in app.warning
                    )
                )
                self.assertTrue(
                    any(
                        header.value == "Weekly portfolio review"
                        for header in app.subheader
                    )
                )


if __name__ == "__main__":
    unittest.main()
