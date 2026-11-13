"""Slow and failed broker reads must leave the displayed values intact."""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import threading
import unittest
from concurrent.futures import Future
from datetime import datetime, timezone
from unittest.mock import patch

from brokers.robinhood import snapshots as ui


class SnapshotUpdates(unittest.TestCase):
    def test_slow_read_returns_without_blocking_and_does_not_overlap(self):
        entered, release = threading.Event(), threading.Event()
        old, fresh = {"value": 100}, {"value": 110}
        state = {"live_snapshot": old}

        def fetch(*args, **kwargs):
            entered.set()
            release.wait(2)
            return fresh

        with (
            patch.object(ui.st, "session_state", state),
            patch.object(ui.orders, "account_snapshot", side_effect=fetch) as read,
        ):
            try:
                ui.update("ACCOUNT", ["A"])
                self.assertTrue(entered.wait(1))
                future = state["live_snapshot_pending"][0]
                self.assertFalse(future.done())
                ui.update("ACCOUNT", ["A"])
                self.assertIs(state["live_snapshot"], old)
                self.assertEqual(read.call_count, 1)
            finally:
                release.set()
                future.result(timeout=2)
            ui.update("ACCOUNT", ["A"])
            self.assertIs(state["live_snapshot"], fresh)
            self.assertNotIn("live_snapshot_pending", state)
            self.assertEqual(read.call_count, 1)

    def test_failure_retains_values_and_waits_before_retry(self):
        failed = Future()
        failed.set_exception(ValueError("Feed unavailable"))
        old = {"value": 100}
        state = {
            "live_snapshot": old,
            "live_snapshot_pending": ui.PendingSnapshot(
                failed, "ACCOUNT", ("A",), None
            ),
        }
        with (
            patch.object(ui.st, "session_state", state),
            patch.object(ui.orders, "account_snapshot") as read,
        ):
            ui.update("ACCOUNT", ["A"])
            ui.update("ACCOUNT", ["A"])
            self.assertIs(state["live_snapshot"], old)
            self.assertEqual(state["live_error"], "Feed unavailable")
            read.assert_not_called()

    def test_read_cannot_overwrite_a_newer_order_review(self):
        future = Future()
        future.set_result({"value": 90})
        fresh = {"value": 110}
        state = {
            "live_snapshot": fresh,
            "live_snapshot_checked": datetime.now(timezone.utc),
            "live_quote_symbols": ["A"],
            "live_snapshot_pending": ui.PendingSnapshot(
                future, "ACCOUNT", ("A",), None
            ),
        }
        with (
            patch.object(ui.st, "session_state", state),
            patch.object(ui.orders, "account_snapshot") as read,
        ):
            ui.update("ACCOUNT", ["A"])
            self.assertIs(state["live_snapshot"], fresh)
            read.assert_not_called()

    def test_old_account_read_is_discarded_after_switch(self):
        future = Future()
        future.set_result({"account": "OLD"})
        state = {
            "live_snapshot_pending": ui.PendingSnapshot(future, "OLD", ("A",), None)
        }
        with (
            patch.object(ui.st, "session_state", state),
            patch.object(ui.threading, "Thread") as thread,
        ):
            ui.update("NEW", ("B",))
            self.assertNotIn("live_snapshot", state)
            self.assertEqual(state["live_snapshot_pending"][1:3], ("NEW", ("B",)))
            thread.return_value.start.assert_called_once()

    def test_refresh_during_initial_read_discards_old_result(self):
        future = Future()
        state = {
            "live_snapshot_pending": ui.PendingSnapshot(future, "ACCOUNT", ("A",), None)
        }
        with (
            patch.object(ui.st, "session_state", state),
            patch.object(ui.threading, "Thread") as thread,
        ):
            ui.invalidate()
            ui.update("ACCOUNT", ["A"])
            thread.assert_not_called()
            future.set_result({"value": 90})
            ui.update("ACCOUNT", ["A"])
            self.assertNotIn("live_snapshot", state)
            self.assertEqual(state["live_snapshot_pending"].revision, 1)
            thread.return_value.start.assert_called_once()

    def test_symbol_reordering_does_not_trigger_another_read(self):
        state = {
            "live_snapshot_checked": datetime.now(timezone.utc),
            "live_snapshot_requested_symbols": ("A", "B"),
        }
        with (
            patch.object(ui.st, "session_state", state),
            patch.object(ui.threading, "Thread") as thread,
        ):
            ui.update("ACCOUNT", ["B", "A", "A"])
            thread.assert_not_called()


if __name__ == "__main__":
    unittest.main()
