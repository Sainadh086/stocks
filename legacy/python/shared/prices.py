"""Central OHLCV reads: Yahoo first, then TradingView's public chart feed."""

import json
import math
import re
import secrets
from time import monotonic

import pandas as pd
import yfinance as yf
from websockets.sync.client import connect

FIELDS = ["Open", "High", "Low", "Close", "Volume"]
BENCHMARK_SYMBOLS = {
    "^GSPC": "SP:SPX",
    "^NDX": "NASDAQ:NDX",
    "^IXIC": "NASDAQ:IXIC",
    "^DJI": "DJ:DJI",
    "^RUT": "TVC:RUT",
    "^NSEI": "NSE:NIFTY",
    "^NSEBANK": "NSE:BANKNIFTY",
    "^BSESN": "BSE:SENSEX",
}


def symbol_candidates(symbol):
    if symbol in BENCHMARK_SYMBOLS:
        return [BENCHMARK_SYMBOLS[symbol]]
    if symbol.endswith(".NS"):
        return ["NSE:" + symbol[:-3]]
    if symbol.endswith(".BO"):
        return ["BSE:" + symbol[:-3]]
    ticker = symbol.replace("-", ".")
    if not re.fullmatch(r"[A-Z0-9.]{1,20}", ticker):
        raise ValueError("Unsupported market symbol")
    return [f"{exchange}:{ticker}" for exchange in ("NASDAQ", "NYSE", "AMEX")]


def wire_message(method, params):
    payload = json.dumps({"m": method, "p": params}, separators=(",", ":"))
    return f"~m~{len(payload.encode())}~m~{payload}"


def decode_messages(buffer):
    """Decode length-prefixed packets, retaining incomplete messages for the next read."""
    packets = []
    raw = buffer.encode("utf-8")
    while raw.startswith(b"~m~"):
        end = raw.find(b"~m~", 3)
        if end == -1:
            break
        length = int(raw[3:end])
        if length < 0 or length > 4 * 1024 * 1024:
            raise ValueError("Invalid TradingView packet length")
        start = end + 3
        if len(raw) < start + length:
            break
        packets.append(raw[start : start + length].decode("utf-8"))
        raw = raw[start + length :]
    return packets, raw.decode("utf-8")


def tradingview_history(symbol, interval="1d", bars=600):
    """Best-effort no-login feed; permission errors are returned, never bypassed."""
    resolution = {"1d": "1D", "5m": "5"}.get(interval)
    if resolution is None:
        raise ValueError("Unsupported price interval")
    errors = []
    for qualified in symbol_candidates(symbol):
        session = "cs_" + secrets.token_hex(6)
        rows = {}
        try:
            with connect(
                "wss://data.tradingview.com/socket.io/websocket",
                origin="https://www.tradingview.com",
                open_timeout=8,
                close_timeout=2,
                max_size=4 * 1024 * 1024,
            ) as socket:
                for method, params in (
                    ("set_auth_token", ["unauthorized_user_token"]),
                    ("chart_create_session", [session, ""]),
                    (
                        "resolve_symbol",
                        [
                            session,
                            "symbol_1",
                            "="
                            + json.dumps(
                                {
                                    "symbol": qualified,
                                    "adjustment": "splits",
                                    "session": "regular",
                                }
                            ),
                        ],
                    ),
                    (
                        "create_series",
                        [session, "s1", "s1", "symbol_1", resolution, min(bars, 5000)],
                    ),
                ):
                    socket.send(wire_message(method, params))
                deadline, buffer, complete = monotonic() + 12, "", False
                while not complete:
                    remaining = deadline - monotonic()
                    if remaining <= 0:
                        raise TimeoutError("TradingView history timed out")
                    chunk = socket.recv(timeout=remaining)
                    buffer += chunk.decode() if isinstance(chunk, bytes) else chunk
                    packets, buffer = decode_messages(buffer)
                    for packet in packets:
                        if packet.startswith("~h~"):
                            socket.send(f"~m~{len(packet)}~m~{packet}")
                            continue
                        message = json.loads(packet)
                        method, params = message.get("m"), message.get("p", [])
                        if method in {
                            "symbol_error",
                            "series_error",
                            "critical_error",
                            "protocol_error",
                        }:
                            raise ValueError(
                                "TradingView symbol or data access unavailable"
                            )
                        if method in {"timescale_update", "du"}:
                            for row in params[1].get("s1", {}).get("s", []):
                                values = row.get("v", [])
                                if len(values) >= 6:
                                    rows[values[0]] = values[1:6]
                        if method == "series_completed":
                            complete = True
                if not rows:
                    raise ValueError("TradingView returned no history")
                frame = pd.DataFrame.from_dict(rows, orient="index", columns=FIELDS)
                frame.index = pd.to_datetime(frame.index, unit="s", utc=True)
                if interval == "1d":
                    zone = (
                        "Asia/Kolkata"
                        if qualified.startswith(("NSE:", "BSE:"))
                        else "America/New_York"
                    )
                    frame.index = frame.index.tz_convert(zone).normalize()
                frame = validate_history(frame)
                frame.attrs.update(
                    source="TradingView",
                    symbol=qualified,
                    adjustment="splits; excludes dividends",
                )
                return frame
        except Exception as exc:
            errors.append(f"{qualified}: {type(exc).__name__}")
    raise ValueError("TradingView history unavailable (" + ", ".join(errors) + ")")


def validate_history(frame):
    if frame is None or frame.empty or not set(FIELDS).issubset(frame.columns):
        raise ValueError("Incomplete OHLCV history")
    result = frame[FIELDS].apply(pd.to_numeric, errors="coerce").dropna()
    result = result[result.map(math.isfinite).all(axis=1)]
    result = result[
        (result[["Open", "High", "Low", "Close"]] > 0).all(axis=1) & result.Volume.ge(0)
    ]
    result = result[
        (result.High >= result[["Open", "Low", "Close"]].max(axis=1))
        & (result.Low <= result[["Open", "High", "Close"]].min(axis=1))
    ]
    result = result[~result.index.duplicated(keep="last")].sort_index()
    if result.empty:
        raise ValueError("No valid OHLCV history")
    result.attrs.update(frame.attrs)
    return result


def history(symbol, period="1y", interval="1d", auto_adjust=True):
    try:
        frame = yf.Ticker(symbol).history(
            period={"1m": "1mo", "3m": "3mo", "6m": "6mo"}.get(period, period),
            interval=interval,
            auto_adjust=auto_adjust,
            timeout=10,
            raise_errors=True,
        )
        frame = validate_history(frame)
        frame.attrs.update(
            source="Yahoo Finance",
            adjustment="splits and dividends"
            if auto_adjust
            else "splits; excludes dividends",
        )
        return frame
    except Exception as yahoo_error:
        bars = {
            "1m": 35,
            "3m": 100,
            "6m": 180,
            "1y": 320,
            "2y": 650,
            "60d": 5000,
            "1d": 100,
        }.get(period, 650)
        try:
            frame = tradingview_history(symbol, interval=interval, bars=bars)
            months = {"1m": 1, "3m": 3, "6m": 6, "1y": 12, "2y": 24}.get(period)
            now = pd.Timestamp.now(tz=frame.index.tz)
            cutoff = (
                now - pd.DateOffset(months=months)
                if months
                else now - pd.Timedelta(days=60 if period == "60d" else 1)
            )
            if interval == "1d":
                cutoff = cutoff.normalize()
            frame = frame[(frame.index >= cutoff) & (frame.index <= now)]
            if frame.empty:
                raise ValueError(
                    "TradingView returned no prices in the requested period"
                )
            return frame
        except Exception as fallback_error:
            raise ValueError(
                f"{symbol}: Yahoo Finance and TradingView are unavailable. {fallback_error}"
            ) from yahoo_error
