import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import builtins
import importlib.util
import unittest
from unittest.mock import Mock, patch

from brokers.kite import ui as ui


class LoginCompatibility(unittest.TestCase):
    def test_component_imports_in_project_environment(self):
        self.assertTrue(ui.automatic_handoff_available())

    def test_old_runtime_import_and_native_handoff(self):
        real_import = builtins.__import__

        def old_import(name, *args, **kwargs):
            if name == "streamlit.components.v2":
                raise ModuleNotFoundError(
                    "No module named 'streamlit.components.v2'", name=name
                )
            return real_import(name, *args, **kwargs)

        spec = importlib.util.spec_from_file_location(
            "legacy_kite_login_ui", ui.__file__
        )
        module = importlib.util.module_from_spec(spec)
        with patch("builtins.__import__", side_effect=old_import):
            spec.loader.exec_module(module)
        self.assertFalse(module.automatic_handoff_available())
        callback = Mock()
        with (
            patch.object(module.st, "link_button") as link,
            patch.object(module.st, "button") as button,
            patch.object(module.st, "caption"),
            patch.object(module.st, "success") as success,
        ):
            module.login_button(
                "https://kite.test/login", "http://localhost/", callback
            )
            link.assert_called_once_with("Open Kite login", "https://kite.test/login")
            self.assertIs(button.call_args.kwargs["on_click"], callback)
            module.return_to_dashboard()
            success.assert_called_once()


if __name__ == "__main__":
    unittest.main()
