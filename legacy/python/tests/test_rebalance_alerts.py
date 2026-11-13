import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import unittest
from datetime import datetime, timezone

from brokers.robinhood.alerts import payload


class RebalanceAlerts(unittest.TestCase):
    def test_only_actionable_buys_sells_and_no_account_identifier(self):
        model = {
            "actions": [
                dict(symbol="BUY", side="buy", action="BUY", enabled=True),
                dict(symbol="SELL", side="sell", action="EXIT", enabled=True),
                dict(symbol="HOLD", side=None, action="HOLD", enabled=False),
                dict(symbol="WAIT", side="buy", action="WAIT", enabled=False),
            ]
        }
        result = payload(
            "PRIVATE_ACCOUNT", model, datetime(2026, 10, 6, 15, tzinfo=timezone.utc)
        )
        self.assertEqual([a["side"] for a in result["actions"]], ["SELL", "BUY"])
        self.assertEqual(result["day"], "2026-10-06")
        self.assertNotIn("PRIVATE_ACCOUNT", str(result))
        self.assertEqual(
            result["account_key"], payload("PRIVATE_ACCOUNT", model)["account_key"]
        )

    def test_empty_actions_and_chicago_date(self):
        result = payload(
            "ACCOUNT", {"actions": []}, datetime(2026, 10, 6, 2, tzinfo=timezone.utc)
        )
        self.assertFalse(result["actions"])
        self.assertEqual(result["day"], "2026-10-05")


if __name__ == "__main__":
    unittest.main()
