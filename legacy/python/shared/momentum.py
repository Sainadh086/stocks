"""Shared price indicators and momentum scoring for India and US stocks."""

import numpy as np
import pandas as pd

from shared import prices

STRONG_HOLD_SCORE = 80
HOLD_SCORE = 70
WATCH_SCORE = 60
REPLACE_SCORE = 60


def get_historical_data(symbol, exchange="NSE", period="2y"):
    suffix = {"NSE": ".NS", "BSE": ".BO", "US": ""}.get(exchange)
    if suffix is None:
        print(f"No Yahoo Finance mapping for {exchange}:{symbol}.")
        return pd.DataFrame()
    yahoo_symbol = f"{symbol}{suffix}"
    try:
        df = prices.history(yahoo_symbol, period=period)
    except Exception as exc:
        print(f"Price lookup failed for {yahoo_symbol}: {exc}")
        return pd.DataFrame()

    if df.empty:
        print(f"No Yahoo Finance history for {yahoo_symbol}.")
        return df

    df = df.rename(columns=str.lower)
    required = ["open", "high", "low", "close", "volume"]
    if not set(required).issubset(df.columns):
        print(f"Incomplete Yahoo Finance history for {yahoo_symbol}.")
        return pd.DataFrame()
    return df[required].dropna()


# ============================================================
# RSI
# ============================================================


def calculate_rsi(close, period=14):

    delta = close.diff()

    gains = delta.clip(lower=0)

    losses = -delta.clip(upper=0)

    avg_gain = gains.ewm(alpha=1 / period, adjust=False).mean()

    avg_loss = losses.ewm(alpha=1 / period, adjust=False).mean()

    rs = avg_gain / avg_loss.replace(0, np.nan)

    return 100 - 100 / (1 + rs)


# ============================================================
# ATR
# ============================================================


def calculate_atr(df, period=14):

    previous_close = df["close"].shift()

    ranges = pd.concat(
        [
            df["high"] - df["low"],
            (df["high"] - previous_close).abs(),
            (df["low"] - previous_close).abs(),
        ],
        axis=1,
    )

    true_range = ranges.max(axis=1)

    return true_range.rolling(period).mean()


# ============================================================
# CALCULATE TECHNICAL INDICATORS
# ============================================================


def calculate_indicators(df):

    df = df.copy()

    close = df["close"]

    # Moving averages
    df["EMA5"] = close.ewm(span=5).mean()

    df["EMA10"] = close.ewm(span=10).mean()

    df["EMA20"] = close.ewm(span=20).mean()

    df["SMA50"] = close.rolling(50).mean()

    df["SMA100"] = close.rolling(100).mean()

    df["SMA200"] = close.rolling(200).mean()

    # Returns
    df["RETURN_5D"] = close.pct_change(5)

    df["RETURN_20D"] = close.pct_change(20)

    df["RETURN_63D"] = close.pct_change(63)

    df["RETURN_126D"] = close.pct_change(126)

    # RSI
    df["RSI"] = calculate_rsi(close)

    # ATR
    df["ATR"] = calculate_atr(df)

    # Volume
    df["AVG_VOLUME_20"] = df["volume"].rolling(20).mean()

    df["VOLUME_RATIO"] = df["volume"] / df["AVG_VOLUME_20"]

    # Highs
    df["HIGH_20"] = close.rolling(20).max()

    df["HIGH_52W"] = close.rolling(252).max()

    return df


# ============================================================
# MOMENTUM SCORE
# ============================================================


def calculate_momentum_score(df):

    latest = df.iloc[-1]

    price = latest["close"]

    score = 0

    reasons = []

    # --------------------------------------------------------
    # 1. LONG TERM TREND
    # 20 points
    # --------------------------------------------------------

    if price > latest["SMA200"]:
        score += 10

        reasons.append("Above 200 SMA")

    if latest["SMA50"] > latest["SMA200"]:
        score += 10

        reasons.append("50 SMA > 200 SMA")

    # --------------------------------------------------------
    # 2. MEDIUM TERM TREND
    # 20 points
    # --------------------------------------------------------

    if price > latest["SMA50"]:
        score += 10

        reasons.append("Above 50 SMA")

    if latest["EMA20"] > latest["SMA50"]:
        score += 10

        reasons.append("20 EMA > 50 SMA")

    # --------------------------------------------------------
    # 3. SHORT TERM MOMENTUM
    # 20 points
    # --------------------------------------------------------

    if price > latest["EMA5"] > latest["EMA10"] > latest["EMA20"]:
        score += 20

        reasons.append("Strong short-term trend")

    elif price > latest["EMA20"]:
        score += 10

    # --------------------------------------------------------
    # 4. RETURNS
    # 20 points
    # --------------------------------------------------------

    if latest["RETURN_20D"] > 0.08:
        score += 10

        reasons.append("Strong 1M return")

    elif latest["RETURN_20D"] > 0:
        score += 5

    if latest["RETURN_63D"] > 0.15:
        score += 10

        reasons.append("Strong 3M return")

    elif latest["RETURN_63D"] > 0:
        score += 5

    # --------------------------------------------------------
    # 5. RSI
    # 10 points
    # --------------------------------------------------------

    rsi = latest["RSI"]

    if 55 <= rsi <= 75:
        score += 10

        reasons.append("Healthy RSI")

    elif 45 <= rsi < 55:
        score += 5

    # --------------------------------------------------------
    # 6. VOLUME
    # 10 points
    # --------------------------------------------------------

    if latest["VOLUME_RATIO"] >= 1.5:
        score += 10

        reasons.append("Strong volume")

    elif latest["VOLUME_RATIO"] >= 1:
        score += 5

    return score, reasons


# ============================================================
# MOMENTUM DETERIORATION
# ============================================================


def detect_deterioration(df):

    latest = df.iloc[-1]

    warnings = []

    price = latest["close"]

    # Short term warning
    if price < latest["EMA5"]:
        warnings.append("Below 5 EMA")

    if price < latest["EMA10"]:
        warnings.append("Below 10 EMA")

    if price < latest["EMA20"]:
        warnings.append("Below 20 EMA")

    # More serious
    if price < latest["SMA50"]:
        warnings.append("BELOW 50 SMA")

    # Long term failure
    if price < latest["SMA200"]:
        warnings.append("BELOW 200 SMA")

    # Momentum deterioration
    if latest["RSI"] < 45:
        warnings.append("Weak RSI")

    # Negative month
    if latest["RETURN_20D"] < 0:
        warnings.append("Negative 1M momentum")

    return warnings


# ============================================================
# CLASSIFY POSITION
# ============================================================


def classify_stock(score, warnings):

    severe_warning = "BELOW 50 SMA" in warnings

    long_term_failure = "BELOW 200 SMA" in warnings

    if score < REPLACE_SCORE or long_term_failure:
        return "REPLACE"

    if severe_warning:
        return "WATCH"

    if score >= STRONG_HOLD_SCORE:
        return "STRONG HOLD"

    if score >= HOLD_SCORE:
        return "HOLD"

    return "WATCH"


# ============================================================
# ANALYZE ONE STOCK
# ============================================================


def analyze_stock(symbol, exchange="NSE"):
    data = get_historical_data(symbol, exchange)

    if len(data) < 200:
        print(f"Not enough price history for {symbol} ({len(data)} days).")
        return None

    data = calculate_indicators(data)

    score, reasons = calculate_momentum_score(data)

    warnings = detect_deterioration(data)

    action = classify_stock(score, warnings)

    latest = data.iloc[-1]

    atr_stop = latest["close"] - 3 * latest["ATR"]

    return {
        "symbol": symbol,
        "exchange": exchange,
        "price": latest["close"],
        "momentum_score": score,
        "action": action,
        "return_1m_pct": latest["RETURN_20D"] * 100,
        "return_3m_pct": latest["RETURN_63D"] * 100,
        "return_6m_pct": latest["RETURN_126D"] * 100,
        "rsi": latest["RSI"],
        "ema20": latest["EMA20"],
        "sma50": latest["SMA50"],
        "sma200": latest["SMA200"],
        "atr": latest["ATR"],
        "risk_level": atr_stop,
        "warnings": " | ".join(warnings),
        "strengths": " | ".join(reasons),
    }


def unscored_holding(holding):
    """Keep a holding visible when Yahoo has insufficient history."""
    return {
        "symbol": holding["tradingsymbol"],
        "exchange": holding["exchange"],
        "price": holding.get("last_price", np.nan),
        "momentum_score": np.nan,
        "action": "NO DATA",
        "return_1m_pct": np.nan,
        "return_3m_pct": np.nan,
        "return_6m_pct": np.nan,
        "rsi": np.nan,
        "ema20": np.nan,
        "sma50": np.nan,
        "sma200": np.nan,
        "atr": np.nan,
        "risk_level": np.nan,
        "warnings": "Yahoo history unavailable or fewer than 200 trading days",
        "strengths": "",
    }


def assess_potential(row):
    """Describe supportive momentum signals; this is not a price forecast."""
    fields = (
        "price",
        "sma50",
        "sma200",
        "return_1m_pct",
        "return_3m_pct",
        "return_6m_pct",
        "rsi",
    )
    if any(field not in row or pd.isna(row[field]) for field in fields):
        return "UNKNOWN", "Insufficient indicator data"

    trend = row["price"] > row["sma50"] > row["sma200"]
    returns = [
        ("1M return positive", row["return_1m_pct"] > 0),
        ("3M return positive", row["return_3m_pct"] > 0),
        ("6M return positive", row["return_6m_pct"] > 0),
    ]
    healthy_rsi = 50 <= row["rsi"] <= 70
    signals = int(trend) + sum(int(passed) for _, passed in returns) + int(healthy_rsi)
    reasons = []
    if trend:
        reasons.append("price > 50 SMA > 200 SMA")
    reasons.extend(label for label, passed in returns if passed)
    if healthy_rsi:
        reasons.append("RSI 50-70")

    if trend and row["return_6m_pct"] > 0 and signals >= 4:
        potential = "HIGH"
    elif signals >= 3:
        potential = "MODERATE"
    else:
        potential = "LOW"
    return potential, " | ".join(reasons) or "No supporting signals"
