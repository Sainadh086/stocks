import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import unittest
from unittest.mock import patch

from shared import dialogs as ui


class CompletionNotice(unittest.TestCase):
    def test_one_success_notice_and_close_without_page_rerun(self):
        with (
            patch.object(ui.st, "session_state", {}),
            patch.object(ui.st, "toast") as toast,
            patch.object(ui, "_CLOSE") as close,
            patch.object(ui.st, "rerun") as rerun,
        ):
            ui.finish("batch")
            ui.finish("batch")
            toast.assert_called_once_with(
                "Orders are successfully executed.", icon=":material/check_circle:"
            )
            self.assertEqual(close.call_count, 2)
            close.assert_called_with(key="rebalance_completed_batch")
            rerun.assert_not_called()


if __name__ == "__main__":
    unittest.main()
