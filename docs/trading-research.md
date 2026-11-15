# Trading research and US Gems implementation

The same breakout framework can run in the US and India, but its profitability
does not transfer automatically. This review establishes implementation
compatibility and identifies different execution economics. It is not a
historical performance study.

## What BloombergGPT contributes

The [BloombergGPT paper](https://arxiv.org/html/2303.17564v3) evaluates financial
language tasks, including sentiment, named-entity extraction and question
answering. It does not publish a tested stock-trading policy or trading-return
evaluation. Financial sentiment must be interpreted in company context; ordinary
positive/negative wording is insufficient. This app does not have a BloombergGPT
model connection or Bloomberg market-data entitlement.

The practical separation here is financial research with dated sources, followed
by independently validated quantitative execution. Existing Weekly review
provides dated headlines; Gems now records an investor's source-backed thesis.
No headline, language-model answer or qualitative checkbox can submit an order.
The cost filter below is our implementation choice, not a BloombergGPT rule.

## US versus India

| Aspect | US implementation | India implementation |
|---|---|---|
| Session | New York calendar, including early closes | NSE calendar, Asia/Kolkata |
| Shared signals | Completed 15-minute range, five-minute candles, ≥1.5× opening volume, VWAP, EMA9 | Same calculations with NSE sessions and `.NS` prices |
| Sizing | Fractional dollar orders, actual unleveraged funds | Whole shares, actual cash and intraday eligibility |
| Risk basis | 0.25% account equity per position | 0.25% saved budget per trade |
| Daily halt | 1% session equity decline | 1% budget loss |
| Entry cutoff | 15 minutes before close | 30 minutes before close |
| Scheduled exit | 5 minutes before close | 20 minutes before close, ahead of usual square-off |
| Turnover | Qualified top-ups and sell-then-buy rotations | One entry per stock per session; app-managed intraday shares |
| Estimated costs | Existing fee, spread and slippage model | Minimum 0.4% round trip estimate |

[NYSE hours](https://www.nyse.com/trade/hours-calendars) and
[NSE hours](https://www.nseindia.com/static/market-data/market-timings) establish the
session differences. Broker rules are separate: for example,
[Robinhood's current intraday account rules](https://robinhood.com/us/en/support/articles/day-trading/)
must be checked instead of assuming older pattern-day-trader restrictions still
apply. India MIS eligibility, whole-share sizes, circuit limits and square-off
remain broker-specific. This change does not introduce leverage or new consent.

## Implemented execution improvement

New live buys in both markets, and US top-ups, must pass the same cost-aware
quality function. Given entry P, stop S, target T and estimated round-trip cost C:

- Net risk per share = P − S + C.
- Net target reward per share = T − P − C.
- Net reward/risk must be at least 1; reward must remain positive at 2C.

The US estimate reuses its fill-cost model and conservatively considers either
exit. India retains its existing 0.4% estimate. Where bid/ask are available, the
observed spread can raise either estimate. The same estimate enters buy risk
sizing. Original target prices are retained for US top-ups. Stops, scheduled
exits and daily loss protection do not require an entry-quality pass.

An illustrative 110 entry, 109.70 stop and 110.60 target has a gross 2R target.
With this app's estimates it yields net reward/risk about **1.14 in the US** and
**0.22 in India**. The US example passes; India rejects it, including a negative
reward under doubled costs. These are arithmetic scenarios in nominal local
currency, not returns from actual trades or predictions.

Separate historical validation is still required for each market: use
chronological development and untouched evaluation windows, actual exchange
sessions, corporate-action-adjusted inputs, realistic fills, rejected orders,
fees and doubled-cost stress. Compare net return, drawdown, turnover, coverage and
profit factor against the prior strategy and a cash baseline. Do not infer
"good" or "excellent" performance from NLP benchmark scores or synthetic tests.

## Implemented US Gems long-term plan

In Recommendations, choose US long term → Gems. Refresh its quantitative screen,
then set a dedicated model-portfolio budget and cash reserve and save the plan.
It is stored encrypted under the selected investing account's scope.

- Horizon: 3–5 years; up to eight candidates, 12.5% maximum per stock and 30% per
  sector. Equal slots use the budget after reserve; missing candidates leave cash.
- Entries: 40% initially, 30% after at least 30 days, and 30% after at least 60
  days. Saving fixes the schedule anchor; reading it does not move dates.
- Reviews: record policy exposure, management/capital-allocation analysis,
  long-term vision and HTTPS links to dated sources. Server-stamped attestations
  expire after 90 days. Pending reviews have zero ready initial allocation.
- Eligibility: only a current Gems scan, USD financial evidence, valid prices and
  sector data can create model targets. Refresh the screen before each addition.
- Maintenance: quarterly and event-driven thesis review; review a rebalance for
  thesis changes or ≥5 percentage-point weight drift, considering taxes and costs.
  A technical failure pauses additions; it does not automatically sell a
  long-term holding.

Targets are for a dedicated allocation and do not subtract existing holdings or
record completed investments. Compare them with actual holdings before acting.
The plan and reviews are research records; they do not call a broker, place
orders, enable automation or reuse intraday consent.


## India automatic stock selection

India intraday trading uses the current [NSE Nifty 100 constituent list](https://www.nseindia.com/static/products-services/indices-nifty100-index) as its default discovery universe. This is a large-cap universe choice, not an assertion that all members are liquid at every moment or approved for intraday orders by every broker. The constituent list is refreshed each NSE date and must contain a plausible full set of EQ symbols; invalid downloads do not fall back to investment-research stocks or a static list.

The app reuses the US `Feed` and rotating watchlist with NSE hours. It requires a complete 15-minute opening range, at least ten prior opening-volume observations, and opening relative volume of at least 1.5. The scanner ranks current breakout strength and relative volume, maintains at most four candidates, rotates waiting stocks after one minute, and monitors held/pending symbols separately. Confirmed completed-candle breakouts, VWAP/EMA confirmation, recent broker quotes, a maximum 0.5% spread when quotes include depth, anti-chasing checks and cost-adjusted reward/risk are still required before a buy. These thresholds are app heuristics, not validated return predictions. The relevance of price, volume, volatility and liquidity is discussed by [Upstox](https://upstox.com/learning-center/intraday-trading/price-volume-volatility-and-liquidity-in-intraday-trading/article-1941/); individual brokers can still reject restricted stocks.

Stock selection and order consent are separate: saving the mode or scanning cannot place an order. Manual mode retains per-order previews; automatic execution requires explicit India session consent. Whole-share quantities, account budget/reserve, four-position cap, 0.25% planned budget risk per trade, 1% daily loss halt and India's existing entry/exit cutoffs remain enforced. A failed initial history scan retries instead of caching an empty universe for the day. No live profitability or execution guarantee has been established by this change.


## Local India settings and index data

The default discovery index is Nifty 100, with selectable Nifty 50, Nifty Next 50, Nifty 200, Nifty 500, Nifty Bank and Nifty IT universes. All use NSE's EQ constituent files and the same entry/risk rules. Constituents are saved locally per index and NSE date; same-day downloads can be reused after restart, while stale or malformed lists block new entries until refreshed. Broader universes take longer to scan.

Trading limits are account-bound, saved independently of broker network availability once the account identity has been verified, and acknowledged only after the encrypted local write succeeds. Each save increments a revision; requests naming an older revision, broker or account are rejected. A failed settings write restores the previous in-memory limits. The UI restores confirmed limits from the server, preserves account-scoped browser drafts separately, and prevents those drafts from starting or reviewing trades. Cached account and shortlist summaries are for display; execution always reads the broker again and pending/uncertain orders remain blocked until reconciled. Credentials are never stored in browser drafts.
