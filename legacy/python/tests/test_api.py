"""HTTP and migration invariants. All brokers, price feeds and private paths are isolated."""

import json
import sys
import tempfile
import threading
import unittest
from contextlib import ExitStack
from decimal import Decimal
from pathlib import Path
from time import sleep
from unittest.mock import Mock, patch

import pandas as pd
from cryptography.fernet import Fernet
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from api import reports
from api.app import create_app
from api.service import Service
from brokers.robinhood import accounts
from shared import storage
from trading.agent import PaperAgent


class APITests(unittest.TestCase):
    def setUp(self):
        self.folder = tempfile.TemporaryDirectory()
        self.addCleanup(self.folder.cleanup)
        self.root = Path(self.folder.name)
        self.stack = ExitStack()
        self.addCleanup(self.stack.close)
        self.stack.enter_context(
            patch.object(storage, "cipher", return_value=Fernet(Fernet.generate_key()))
        )
        self.stack.enter_context(
            patch.object(accounts, "ROLES_FILE", self.root / "roles.json")
        )
        self.stack.enter_context(
            patch("api.service.WORKSPACE_FILE", self.root / "workspace.json")
        )
        self.stack.enter_context(patch.object(reports, "INDIA_DIR", self.root))
        self.stack.enter_context(patch.object(reports, "US_DIR", self.root))
        self.stack.enter_context(
            patch.object(reports.kite, "TOKEN_FILE", str(self.root / "kite_token.json"))
        )
        self.stack.enter_context(
            patch.object(
                reports.kite, "PORTFOLIO_HISTORY_FILE", str(self.root / "history.json")
            )
        )
        self.available = [
            {"account_number": "LONG1234", "state": "active", "agentic_allowed": False},
            {"account_number": "TRADE5678", "state": "active", "agentic_allowed": True},
            {"account_number": "OTHER9999", "state": "active", "agentic_allowed": True},
        ]
        accounts.save_roles("LONG1234", "TRADE5678", self.available)
        self.broker = self.stack.enter_context(
            patch("api.service.client.list_accounts", return_value=self.available)
        )
        self.service = Service(workers=False)
        self.stack.enter_context(
            patch(
                "api.service.PaperAgent",
                side_effect=lambda **kw: PaperAgent(
                    path=self.root / "paper.json", **kw
                ),
            )
        )
        self.browser = self.stack.enter_context(
            TestClient(create_app(self.service), base_url="http://127.0.0.1:8000")
        )
        self.token = self.browser.get("/api/bootstrap").json()["token"]
        self.headers = {"x-varshan-token": self.token}

    def post(self, path, payload=None):
        return self.browser.post(path, json=payload or {}, headers=self.headers)

    def complete(self, response):
        self.assertEqual(response.status_code, 200, response.text)
        job = response.json()
        for _ in range(100):
            if job["status"] not in {"queued", "running"}:
                return job
            sleep(0.01)
            job = self.browser.get(f"/api/jobs/{job['id']}").json()
        self.fail("Test operation did not complete")

    def test_only_local_origins_and_valid_csrf_can_mutate(self):
        with patch.object(self.service, "paper_control") as operation:
            self.assertEqual(
                self.browser.post("/api/paper/control", json={}).status_code, 403
            )
            response = self.browser.post(
                "/api/paper/control",
                json={},
                headers={**self.headers, "Origin": "https://evil.example"},
            )
            self.assertEqual(response.status_code, 403)
            self.assertEqual(
                self.browser.get(
                    "/api/bootstrap", headers={"sec-fetch-site": "cross-site"}
                ).status_code,
                403,
            )
            self.assertEqual(
                self.browser.get(
                    "/api/health", headers={"Host": "evil.example"}
                ).status_code,
                400,
            )
            operation.assert_not_called()

    def test_read_api_has_no_store_headers_and_no_orders(self):
        with patch("api.service.orders.submit_reviewed_order") as submit:
            response = self.browser.get("/api/accounts")
            self.assertEqual(response.headers["cache-control"], "no-store")
            self.assertNotIn("LONG1234", response.text)
            self.assertEqual(response.json()["roles"]["long_term"]["ending"], "1234")
            self.assertFalse(self.service.auto["enabled"])
            submit.assert_not_called()

    def test_invalid_payload_and_unconfirmed_live_orders_are_rejected(self):
        with patch.object(self.service, "confirm_live") as submit:
            for body in ({}, {"acknowledged": False}):
                self.assertEqual(
                    self.post("/api/live/batches/abc/confirm", body).status_code, 422
                )
            submit.assert_not_called()
        for value in (-1, 0):
            self.assertEqual(
                self.post(
                    "/api/live/settings", {"budget": value, "reserve_pct": 10}
                ).status_code,
                422,
            )
        self.assertEqual(
            self.post(
                "/api/live/settings", {"budget": 1000, "reserve_pct": 101}
            ).status_code,
            422,
        )
        self.assertEqual(self.post("/api/analysis/arbitrary").status_code, 422)
        self.assertEqual(
            self.post(
                "/api/comparisons",
                {"role": "long_term", "benchmark": "S&P 500", "period": "huge"},
            ).status_code,
            422,
        )

    def test_paper_start_never_changes_live_settings_or_calls_orders(self):
        accounts.save_trading_settings("TRADE5678", 750, 25)
        with patch("api.service.orders.submit_reviewed_order") as submit:
            paper = self.post(
                "/api/paper/control",
                {"action": "start", "budget": 5000, "reserve_pct": 5},
            ).json()
            self.assertEqual(paper["status"], "Running")
            self.post(
                "/api/paper/control",
                {"action": "pause", "budget": 5000, "reserve_pct": 5},
            )
            self.assertEqual(accounts.load_trading_settings("TRADE5678"), (750, 25))
            self.assertFalse(self.service.auto["enabled"])
            submit.assert_not_called()
        self.assertTrue(
            (self.root / "paper.json").read_bytes().startswith(storage.MAGIC)
        )

    def test_persistent_role_change_is_explicit_and_account_scoped(self):
        self.assertEqual(
            self.post(
                "/api/live/settings", {"budget": 900, "reserve_pct": 15}
            ).status_code,
            200,
        )
        job = self.complete(
            self.post(
                "/api/accounts/roles", {"long_term": "LONG1234", "trading": "OTHER9999"}
            )
        )
        self.assertEqual(job["status"], "completed")
        self.assertEqual(accounts.load_roles()["trading"], "OTHER9999")
        self.assertEqual(accounts.load_trading_settings("OTHER9999"), (None, None))
        self.assertEqual(accounts.load_trading_settings("TRADE5678"), (900, 15))
        self.assertFalse(self.service.auto["enabled"])
        invalid = self.complete(
            self.post(
                "/api/accounts/roles", {"long_term": "LONG1234", "trading": "LONG1234"}
            )
        )
        self.assertEqual(invalid["status"], "failed")
        self.assertEqual(accounts.load_roles()["trading"], "OTHER9999")

    def test_confirmed_active_batch_blocks_role_and_budget_changes(self):
        self.service.state()["batch"] = {
            "id": "active",
            "account": "TRADE5678",
            "status": "waiting_sales",
        }
        response = self.post("/api/live/settings", {"budget": 2000, "reserve_pct": 0})
        self.assertEqual(response.status_code, 400)
        job = self.complete(
            self.post(
                "/api/accounts/roles", {"long_term": "LONG1234", "trading": "OTHER9999"}
            )
        )
        self.assertEqual(job["status"], "failed")
        self.assertEqual(accounts.load_roles()["trading"], "TRADE5678")

    def test_auto_requires_live_connection_budget_and_explicit_confirmation(self):
        accounts.save_trading_settings("TRADE5678", 1000, 10)
        self.assertEqual(
            self.post(
                "/api/live/automation",
                {"enabled": True, "connection": "missing", "acknowledged": True},
            ).status_code,
            400,
        )
        self.service.touch("browser")
        self.assertEqual(
            self.post(
                "/api/live/automation",
                {"enabled": True, "connection": "browser", "acknowledged": False},
            ).status_code,
            400,
        )
        response = self.post(
            "/api/live/automation",
            {"enabled": True, "connection": "browser", "acknowledged": True},
        )
        self.assertEqual(response.status_code, 200)
        self.assertTrue(self.service.auto["enabled"])
        self.service.disconnect("browser")
        self.assertFalse(self.service.auto["enabled"])

    def test_websocket_authentication_heartbeat_and_disconnect(self):
        with self.browser.websocket_connect(
            "ws://127.0.0.1:8000/api/stream",
            headers={"Origin": "http://127.0.0.1:8000"},
        ) as stream:
            stream.send_json({"token": self.token})
            connected = stream.receive_json()
            identity = connected["connection"]
            stream.send_json({"type": "heartbeat", "live": True})
            self.assertEqual(stream.receive_json()["type"], "update")
            self.assertTrue(self.service.connections[identity]["live"])
            accounts.save_trading_settings("TRADE5678", 1000, 10)
            self.assertEqual(
                self.post(
                    "/api/live/automation",
                    {"enabled": True, "connection": identity, "acknowledged": True},
                ).status_code,
                200,
            )
        for _ in range(50):
            if not self.service.auto["enabled"]:
                break
            sleep(0.01)
        self.assertFalse(self.service.auto["enabled"])

    def test_revoked_lease_prevents_further_strategy_broker_reads(self):
        self.service.auto.update(enabled=True, connection="gone")
        with patch("api.service.orders.account_snapshot") as fetch:
            with self.assertRaisesRegex(ValueError, "disconnected"):
                self.service.fresh_decisions()
            fetch.assert_not_called()

    def test_background_jobs_are_deduplicated_and_report_failures(self):
        started, release = threading.Event(), threading.Event()
        operation = Mock(
            side_effect=lambda: (started.set(), release.wait(2), {"count": 1})[-1]
        )
        first = self.service.job("scan", operation)
        self.assertTrue(started.wait(1))
        second = self.service.job("scan", operation)
        self.assertEqual(first["id"], second["id"])
        release.set()
        self.complete(JSONResponseLike(first))
        operation.assert_called_once()
        job = self.service.job(
            "failure", Mock(side_effect=ValueError("TRADE5678 unavailable"))
        )
        failed = self.complete(JSONResponseLike(job))
        self.assertEqual(failed["status"], "failed")
        self.assertNotIn("TRADE5678", failed["error"])

    def test_saved_comparison_survives_restart_failure_and_role_switch(self):
        storage.write_csv(
            pd.DataFrame([{"symbol": "ABC", "quantity": 2}]),
            accounts.holdings_path("LONG1234"),
        )
        dates = pd.date_range("2026-10-01", periods=3)
        prices = pd.Series([100.0, 105.0, 110.0], index=dates)
        with patch.object(
            self.service, "comparison_prices", return_value=(prices, "TradingView")
        ):
            job = self.complete(
                self.post(
                    "/api/comparisons",
                    {"role": "long_term", "benchmark": "S&P 500", "period": "1y"},
                )
            )
            self.assertEqual(job["status"], "completed")
        original = self.browser.get("/api/comparisons/long_term").json()
        self.assertEqual(len(original["curve"]), 3)
        self.assertEqual(original["sources"][0]["source"], "TradingView")
        self.assertTrue(
            (self.root / "workspace.json").read_bytes().startswith(storage.MAGIC)
        )
        other = Service(workers=False)
        self.addCleanup(other.close)
        self.assertEqual(other.comparison("long_term")["curve"], original["curve"])
        with patch.object(
            self.service,
            "comparison_prices",
            side_effect=ValueError("Feed unavailable"),
        ):
            failed = self.complete(
                self.post(
                    "/api/comparisons",
                    {"role": "long_term", "benchmark": "S&P 500", "period": "1y"},
                )
            )
        self.assertEqual(failed["status"], "failed")
        self.assertEqual(
            self.browser.get("/api/comparisons/long_term").json()["curve"],
            original["curve"],
        )
        accounts.save_roles("OTHER9999", "TRADE5678", self.available)
        self.assertIsNone(other.comparison("long_term"))
        accounts.save_roles("LONG1234", "TRADE5678", self.available)
        self.assertEqual(other.comparison("long_term")["curve"], original["curve"])

    def test_restart_never_resumes_automatic_batches(self):
        self.service.state()["batch"] = {
            "id": "auto",
            "account": "TRADE5678",
            "status": "waiting_buys",
            "automatic": True,
        }
        self.service.save()
        restored = Service(workers=False)
        self.addCleanup(restored.close)
        self.assertEqual(restored.state()["batch"]["status"], "stopped")
        self.assertFalse(restored.auto["enabled"])

    def test_kite_editor_uses_server_original_not_browser_holdings(self):
        self.service.state()["india_draft"] = {
            "id": "draft",
            "user": "one",
            "rows": [{"symbol": "ABC", "exchange": "NSE", "current_shares": 10}],
        }
        with (
            patch.object(reports, "kite_client", return_value=Mock()),
            patch(
                "api.service.kite_rebalance.account_state",
                return_value={"user": "other"},
            ),
            patch("api.service.kite_rebalance.review") as review,
        ):
            with self.assertRaisesRegex(ValueError, "account changed"):
                self.service.kite_review("draft", [])
            review.assert_not_called()

    def test_json_normalization_and_api_unknown_route(self):
        data = reports.clean(
            {"decimal": Decimal("10.5"), "missing": pd.NA, "nan": float("nan")}
        )
        self.assertEqual(
            json.loads(json.dumps(data, allow_nan=False)),
            {"decimal": 10.5, "missing": None, "nan": None},
        )
        self.assertEqual(self.browser.get("/api/missing").status_code, 404)

    def test_single_process_lock_prevents_multiple_trading_workers(self):
        with patch("api.service.PROCESS_LOCK", self.root / "api.lock"):
            first, second = Service(), Service()
            try:
                first.start()
                with self.assertRaisesRegex(RuntimeError, "already running"):
                    second.start()
                first.close()
                second.start()
                self.assertIsNotNone(second.process_lock)
            finally:
                first.close()
                second.close()

    def test_corrupt_settings_can_be_repaired_without_switching_accounts(self):
        storage.write_text(accounts.trading_settings_path("TRADE5678"), '{"version":0}')
        settings = self.browser.get("/api/accounts").json()
        self.assertTrue(settings["roles"]["trading"]["selected"])
        self.assertIsNotNone(settings["error"])
        self.assertEqual(
            self.post(
                "/api/live/settings", {"budget": 1200, "reserve_pct": 15}
            ).status_code,
            200,
        )
        self.assertEqual(accounts.load_trading_settings("TRADE5678"), (1200, 15))

    def test_reconciliation_checks_existing_tickets_without_placing_orders(self):
        with (
            patch(
                "api.service.orders.list_tickets",
                return_value=[
                    {
                        "id": "unresolved",
                        "status": "unknown",
                        "arguments": {"account_number": "TRADE5678"},
                    },
                    {
                        "id": "preview",
                        "status": "preview",
                        "arguments": {"account_number": "TRADE5678"},
                    },
                ],
            ),
            patch("api.service.orders.reconcile_ticket") as reconcile,
            patch("api.service.orders.submit_reviewed_order") as submit,
        ):
            job = self.complete(self.post("/api/live/tickets/reconcile"))
            self.assertEqual(job["status"], "completed")
            reconcile.assert_called_once_with("unresolved")
            submit.assert_not_called()

    def test_pause_revokes_authorization_before_waiting_for_broker_lock(self):
        self.service.touch("browser")
        self.service.auto.update(enabled=True, connection="browser")
        finished = threading.Event()
        with self.service.lock:
            thread = threading.Thread(
                target=lambda: (self.service.set_auto(False, "", False), finished.set())
            )
            thread.start()
            self.assertTrue(self.service.automation_revoked.wait(1))
            with patch("api.service.orders.account_snapshot") as broker:
                with self.assertRaisesRegex(ValueError, "disconnected"):
                    self.service.fresh_decisions()
                broker.assert_not_called()
        self.assertTrue(finished.wait(1))
        thread.join()


class JSONResponseLike:
    status_code = 200
    text = ""

    def __init__(self, body):
        self.body = body

    def json(self):
        return self.body


if __name__ == "__main__":
    unittest.main()
