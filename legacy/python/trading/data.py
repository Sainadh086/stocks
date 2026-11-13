"""Intraday paper feed; historical volume baselines cached once per session."""

import pandas as pd
import yfinance as yf

from brokers.robinhood import analysis as us_stocks
from shared import prices
from trading.orb import normalize


class Feed:
    def __init__(self):
        self.day = None
        self.history = {}

    def fetch(self, now, held=()):
        day = str(pd.Timestamp(now).tz_convert("America/New_York").date())
        symbols = sorted(
            set(self.history if self.day == day else us_stocks.load_index_symbols())
            | set(held)
        )
        if self.day != day:
            self.history = download(symbols, "60d")
            self.day = day
        today = download(symbols, "1d")
        result = {}
        for symbol in set(self.history) | set(today):
            frames = [
                f
                for f in (self.history.get(symbol), today.get(symbol))
                if f is not None
            ]
            combined = pd.concat(frames)
            result[symbol] = combined[
                ~combined.index.duplicated(keep="last")
            ].sort_index()
        for symbol in held:
            frame = result.get(symbol)
            if (
                frame is None
                or frame.empty
                or pd.Timestamp(now) - frame.index[-1] > pd.Timedelta(minutes=10)
            ):
                raise ValueError(
                    f"Intraday data missing or stale for held stock {symbol}."
                )
        if not today:
            raise ValueError("No current intraday data; paper trading is waiting.")
        return result


def download(symbols, period="60d"):
    try:
        raw = yf.download(
            symbols,
            period=period,
            interval="5m",
            auto_adjust=True,
            progress=False,
            threads=True,
            timeout=20,
            multi_level_index=True,
        )
    except Exception:
        raw = pd.DataFrame()
    result = {}
    for symbol in symbols:
        try:
            if raw is None or raw.empty:
                raise ValueError("Yahoo Finance returned no data")
            frame = raw.xs(symbol, axis=1, level=1).dropna()
            if not frame.empty:
                result[symbol] = normalize(frame)
        except (KeyError, ValueError):
            pass
        if symbol not in result:
            try:
                frame = prices.tradingview_history(
                    symbol, interval="5m", bars=5000 if period == "60d" else 100
                )
                result[symbol] = normalize(frame)
            except Exception:
                continue
    return result
