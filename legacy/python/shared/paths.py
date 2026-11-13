"""Stable project paths, independent of the working directory or broker package."""

from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
ENV_FILE = ROOT / ".env"
INDIA_DIR = ROOT / "india_stocks"
US_DIR = ROOT / "us_stocks"
BACKTESTS_DIR = ROOT / "backtests"
NODE_BIN = ROOT / ".tools" / "node" / "bin"
