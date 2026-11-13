"""Read-only business-quality screening; never submits broker orders.

Annual statements are compared on matching fiscal dates. These conservative
growth-stock rules are app defaults, not forecasts or universal valuation rules.
"""

import json
import math
from datetime import datetime, timedelta, timezone

import pandas as pd
import yfinance as yf

from shared import storage
from shared.paths import US_DIR

POLICY_VERSION = 1
MAX_STATEMENT_AGE_DAYS = 450
MIN_CASH_CONVERSION = 0.7
UNDERPERFORMANCE_PP = -10.0
MIN_FORECAST_ANALYSTS = 3
CACHE_FILE = US_DIR / "long_term_fundamentals.json"


def number(value):
    try:
        result = float(value)
        return result if math.isfinite(result) else None
    except (ValueError, TypeError):
        return None


def statement_value(frame, date, names):
    for name in names:
        if name in frame.index:
            return number(frame.at[name, date])
    return None


def forecast(ticker, metric):
    """Optional next-fiscal-year consensus; unavailable is not negative growth."""
    try:
        table = getattr(ticker, f"get_{metric}_estimate")()
        row = table.loc["+1y"]
        rate = number(row.get("growth"))
        count = number(row.get("numberOfAnalysts"))
        return dict(growth_pct=rate * 100 if rate is not None else None, analysts=count)
    except Exception:
        return dict(growth_pct=None, analysts=None)


def annual_facts(income, cashflow, info):
    """Avoid combining unmatched years or substituting missing values with zero."""
    periods = []
    dates = sorted(set(income.columns) & set(cashflow.columns), reverse=True)
    for date in dates[:3]:
        ocf = statement_value(cashflow, date, ["Operating Cash Flow"])
        capex = statement_value(cashflow, date, ["Capital Expenditure"])
        fcf = statement_value(cashflow, date, ["Free Cash Flow"])
        if fcf is None and ocf is not None and capex is not None:
            fcf = ocf - abs(capex)
        periods.append(
            dict(
                date=pd.Timestamp(date).date().isoformat(),
                revenue=statement_value(income, date, ["Total Revenue"]),
                earnings=statement_value(income, date, ["Net Income"]),
                operating_cash_flow=ocf,
                free_cash_flow=fcf,
            )
        )
    return dict(
        periods=periods,
        sector=info.get("sector"),
        quote_type=info.get("quoteType"),
        currency=info.get("financialCurrency"),
        source="Yahoo Finance annual financial statements",
        statements_aligned=bool(dates) and max(income.columns) == max(cashflow.columns),
    )


class Fundamentals:
    """One bounded daily cache shared by manual scans, not by UI refresh ticks."""

    def __init__(self, now=None, path=None):
        self.now = now or datetime.now(timezone.utc)
        self.path = path or CACHE_FILE
        self.cache = {}
        if self.path.exists():
            try:
                data = json.loads(storage.read_text(self.path))
                if isinstance(data, dict):
                    self.cache = {
                        key: value
                        for key, value in data.items()
                        if isinstance(value, dict)
                    }
            except (OSError, ValueError):
                pass

    def get(self, symbol):
        cached = self.cache.get(symbol, {})
        try:
            age = self.now - datetime.fromisoformat(cached["fetched_at"])
            if timedelta(0) <= age < timedelta(hours=24):
                return dict(cached, data_status="CURRENT")
            retry_age = self.now - datetime.fromisoformat(cached["attempted_at"])
            if timedelta(0) <= retry_age < timedelta(minutes=5):
                return dict(cached, data_status="UNAVAILABLE")
        except (KeyError, TypeError, ValueError):
            pass
        try:
            ticker = yf.Ticker(symbol)
            info = ticker.get_info()
            facts = annual_facts(ticker.income_stmt, ticker.cashflow, info)
            if not facts["periods"] and info.get("quoteType") not in (
                "ETF",
                "MUTUALFUND",
            ):
                raise ValueError("No matched annual financial statements")
            facts["next_year_earnings"] = forecast(ticker, "earnings")
            facts["next_year_revenue"] = forecast(ticker, "revenue")
            facts.update(fetched_at=self.now.isoformat(), data_status="CURRENT")
        except Exception:
            # Preserve prior facts for inspection, but block decisions on failed refreshes.
            facts = dict(
                cached, data_status="UNAVAILABLE", attempted_at=self.now.isoformat()
            )
        self.cache[symbol] = facts
        return facts.copy()

    def save(self):
        bounded = sorted(
            self.cache.items(),
            key=lambda item: item[1].get("fetched_at", item[1].get("attempted_at", "")),
            reverse=True,
        )[:500]
        storage.write_text(self.path, json.dumps(dict(bounded), allow_nan=False))


def growth(current, previous):
    if current is None or previous is None or previous <= 0:
        return None
    return (current / previous - 1) * 100


def cash_is_weak(period):
    earnings = number(period.get("earnings"))
    ocf = number(period.get("operating_cash_flow"))
    fcf = number(period.get("free_cash_flow"))
    if any(value is None for value in (earnings, ocf, fcf)):
        return None
    return (
        ocf <= 0 or fcf <= 0 or (earnings > 0 and ocf / earnings < MIN_CASH_CONVERSION)
    )


def assess(facts, technical, benchmark_return=None, now=None):
    """Price weakness alone cannot sell a healthy business; absent data blocks exits."""
    now = now or datetime.now(timezone.utc)
    result = dict(
        policy_version=POLICY_VERSION,
        long_term_action="REVIEW",
        long_term_eligible=False,
        long_term_score=None,
        long_term_reasons="Financial statements unavailable; inspect company filings",
        financial_period=None,
        financial_currency=facts.get("currency"),
        financial_source=facts.get("source", "Unavailable"),
        financial_fetched_at=facts.get("fetched_at"),
        revenue_growth_pct=None,
        earnings_growth_pct=None,
        net_income=None,
        operating_cash_flow=None,
        free_cash_flow=None,
        cash_conversion=None,
        relative_return_6m_pp=None,
        next_year_earnings_growth_pct=facts.get("next_year_earnings", {}).get(
            "growth_pct"
        ),
        next_year_revenue_growth_pct=facts.get("next_year_revenue", {}).get(
            "growth_pct"
        ),
        earnings_forecast_analysts=facts.get("next_year_earnings", {}).get("analysts"),
        revenue_forecast_analysts=facts.get("next_year_revenue", {}).get("analysts"),
    )
    stock_return = number(technical.get("return_6m_pct"))
    benchmark_return = number(benchmark_return)
    if stock_return is not None and benchmark_return is not None:
        result["relative_return_6m_pp"] = stock_return - benchmark_return
    if facts.get("data_status") != "CURRENT":
        return result
    if facts.get("quote_type") in ("ETF", "MUTUALFUND"):
        result["long_term_reasons"] = (
            "Fund: company earnings/cash-flow rules do not apply"
        )
        return result
    if facts.get("sector") in ("Financial Services", "Real Estate"):
        result["long_term_reasons"] = (
            "Sector-specific review required; generic cash-flow rules do not apply"
        )
        return result
    if not facts.get("sector") or facts.get("quote_type") != "EQUITY":
        result["long_term_reasons"] = (
            "Company type or sector unavailable; inspect filings before applying rules"
        )
        return result
    periods = facts.get("periods", [])
    if facts.get("statements_aligned") is False:
        result["long_term_reasons"] = (
            "Latest income and cash-flow fiscal dates do not match; inspect filings"
        )
        return result
    if len(periods) < 2:
        return result
    latest, prior = periods[:2]
    result["financial_period"] = latest.get("date")
    try:
        date = pd.Timestamp(latest["date"]).date()
        gap = (date - pd.Timestamp(prior["date"]).date()).days
        if (
            not 300 <= gap <= 430
            or not 0 <= (now.date() - date).days <= MAX_STATEMENT_AGE_DAYS
        ):
            result["long_term_reasons"] = (
                "Stale or non-comparable annual statements; refresh and inspect filings"
            )
            return result
    except (ValueError, KeyError, TypeError):
        return result
    revenue, earnings, ocf, fcf = (
        number(latest.get(key))
        for key in ("revenue", "earnings", "operating_cash_flow", "free_cash_flow")
    )
    result.update(net_income=earnings, operating_cash_flow=ocf, free_cash_flow=fcf)
    previous_revenue = number(prior.get("revenue"))
    previous_earnings = number(prior.get("earnings"))
    result["revenue_growth_pct"] = growth(revenue, previous_revenue)
    result["earnings_growth_pct"] = growth(earnings, previous_earnings)
    if (
        any(
            value is None
            for value in (
                revenue,
                earnings,
                ocf,
                fcf,
                previous_revenue,
                previous_earnings,
            )
        )
        or revenue <= 0
        or previous_revenue <= 0
    ):
        return result
    result["cash_conversion"] = ocf / earnings if earnings > 0 else None
    rg, eg = result["revenue_growth_pct"], result["earnings_growth_pct"]
    checks = [
        earnings > 0,
        ocf > 0,
        fcf > 0,
        rg > 0,
        eg is not None and eg > 0,
        result["cash_conversion"] is not None
        and result["cash_conversion"] >= MIN_CASH_CONVERSION,
    ]
    result["long_term_score"] = round(sum(checks) / len(checks) * 100)
    reasons = []
    forecast_weak = False
    for metric in ("earnings", "revenue"):
        estimate = facts.get(f"next_year_{metric}", {})
        rate, count = (
            number(estimate.get("growth_pct")),
            number(estimate.get("analysts")),
        )
        if (
            rate is not None
            and count is not None
            and count >= MIN_FORECAST_ANALYSTS
            and rate <= 0
        ):
            forecast_weak = True
            reasons.append(
                f"Next-year {metric} consensus is non-growing ({rate:.1f}%, {count:g} analysts); estimate, not a guarantee"
            )
    if earnings <= 0:
        reasons.append("Annual earnings are non-positive")
    if ocf <= 0:
        reasons.append("Operating cash flow is non-positive")
    if fcf <= 0:
        reasons.append("Free cash flow is non-positive")
    if (
        result["cash_conversion"] is not None
        and result["cash_conversion"] < MIN_CASH_CONVERSION
    ):
        reasons.append("Operating cash flow is below 70% of earnings")
    if rg <= 0:
        reasons.append("Annual revenue is not growing")
    if eg is None:
        reasons.append("Prior earnings were non-positive; recovery needs review")
    elif eg <= 0:
        reasons.append("Annual earnings are not growing")
    # An exit needs repeated business weakness, not just a bad trading day.
    repeated_losses = (
        earnings <= 0
        and previous_earnings <= 0
        and ocf <= 0
        and number(prior.get("operating_cash_flow")) is not None
        and number(prior.get("operating_cash_flow")) <= 0
    )
    persistent_growth_weakness = False
    if len(periods) >= 3:
        older = periods[2]
        try:
            older_gap = (pd.Timestamp(prior["date"]) - pd.Timestamp(older["date"])).days
            prior_rg = growth(previous_revenue, number(older.get("revenue")))
            prior_eg = growth(previous_earnings, number(older.get("earnings")))
            persistent_growth_weakness = (
                300 <= older_gap <= 430
                and rg <= 0
                and eg is not None
                and eg <= 0
                and prior_rg is not None
                and prior_rg <= 0
                and prior_eg is not None
                and prior_eg <= 0
            )
        except (TypeError, ValueError, KeyError):
            pass
    relative = result["relative_return_6m_pp"]
    price, average = number(technical.get("price")), number(technical.get("sma200"))
    underperforming = (
        relative is not None
        and relative <= UNDERPERFORMANCE_PP
        and price is not None
        and average is not None
        and 0 < price < average
    )
    if repeated_losses or (
        persistent_growth_weakness
        and cash_is_weak(latest)
        and cash_is_weak(prior)
        and underperforming
    ):
        result["long_term_action"] = "EXIT REVIEW"
        reasons.append(
            "Non-positive earnings and operating cash flow in two annual periods"
            if repeated_losses
            else "Two annual growth declines, weak cash generation in both years, and 6M S&P 500 underperformance of at least 10pp below the 200-day average"
        )
    elif all(checks):
        result["long_term_action"] = (
            "WATCH"
            if technical.get("action") in ("REPLACE", "WATCH", "NO DATA")
            or underperforming
            or forecast_weak
            else "HOLD"
        )
        result["long_term_eligible"] = result["long_term_action"] == "HOLD"
        reasons.append(
            "Positive earnings, cash generation, revenue and earnings growth"
        )
        if not result["long_term_eligible"]:
            reasons.append(
                "Annual business checks pass; monitor price trend or growth outlook before adding"
            )
    else:
        result["long_term_action"] = "WATCH"
        reasons.append("Weakness needs follow-up; exit evidence is not yet persistent")
    result["long_term_reasons"] = " | ".join(reasons)
    return result


def enrich(frame, fundamentals, benchmark_return=None):
    if frame.empty:
        return frame.copy()
    additions = [
        assess(fundamentals.get(row["symbol"]), row, benchmark_return, fundamentals.now)
        for _, row in frame.iterrows()
    ]
    return pd.concat([frame.reset_index(drop=True), pd.DataFrame(additions)], axis=1)


def rebalance_review(holdings, report):
    """Proposed reductions only; never infer cash, quantity, or an automatic buy."""
    if holdings.empty or report.empty or "long_term_action" not in report:
        return pd.DataFrame()
    plan = holdings.merge(report, on="symbol", how="left", validate="one_to_one")
    quantity = pd.to_numeric(
        plan.get("quantity", pd.Series(index=plan.index, dtype=float)), errors="coerce"
    )
    plan["proposed_sell_quantity"] = quantity.where(
        plan["long_term_action"].eq("EXIT REVIEW") & quantity.gt(0), 0
    )
    plan["proposed_target_quantity"] = quantity - plan["proposed_sell_quantity"]
    plan["review_instruction"] = (
        plan["long_term_action"]
        .map(
            {
                "EXIT REVIEW": "Review filings, taxes and liquidity before selling; proceeds may stay in cash",
                "HOLD": "Retain; business-quality checks pass",
                "WATCH": "Retain pending follow-up on business or trend weakness",
                "REVIEW": "Retain pending verified financial data or sector review",
            }
        )
        .fillna("Retain pending a current analysis")
    )
    plan.loc[
        quantity.isna() | quantity.lt(0),
        ["proposed_sell_quantity", "proposed_target_quantity"],
    ] = float("nan")
    return plan


def report_is_current(report, report_file, source, roles_file, now=None):
    """Do not reuse another account's report, old rules, or yesterday's decisions."""
    now = now or datetime.now(timezone.utc)
    required = {"long_term_action", "policy_version", "holdings_source"}
    if (
        report_file is None
        or not source.exists()
        or report.empty
        or not required.issubset(report)
    ):
        return False
    if (
        not report["policy_version"].eq(POLICY_VERSION).all()
        or not report["holdings_source"].eq(str(source.resolve())).all()
    ):
        return False
    modified = report_file.stat().st_mtime
    oldest = max(
        source.stat().st_mtime, roles_file.stat().st_mtime if roles_file.exists() else 0
    )
    return modified >= oldest and 0 <= now.timestamp() - modified < 24 * 3600
