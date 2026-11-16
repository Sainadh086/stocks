# varshan

The complete application runs on **TypeScript**: **React** for the UI and
**Node.js with Fastify** for the backend. Python and Streamlit are no longer
required to build, start, analyze portfolios, run trading workers, or backtest.

For desktop access on **macOS, Windows or Linux**, install Node.js 22.12+ with
npm, then run from this folder:

```sh
npm start
```

The portable launcher installs missing locked dependencies, builds both apps and
serves them at **http://127.0.0.1:8000**. Stop with Ctrl+C. Windows/Linux require
`VARSHAN_ENCRYPTION_KEY`; macOS keeps using Keychain. See
[cross-platform setup and data migration](docs/running.md) for key setup,
PowerShell commands, dependency updates and Mac-only feature requirements.

For background operation on the existing Mac installation:

```sh
cd stocks
sh web.sh start
sh web.sh status
sh web.sh stop
sh web.sh restart
```

Open **http://127.0.0.1:8000**. Node.js 22.12+ and npm are required; the launcher
uses the existing `.tools/node` installation automatically, installs locked
packages when missing, and builds both applications. `start` runs in the
background and leaves an already running server alone. `restart` stops gracefully,
rebuilds, and starts again. Both wait for the health endpoint before reporting
success. Build and server output is saved to `.local/varshan.log`.

`status` verifies the saved server PID and workspace and checks the web endpoint;
it exits with 0 when healthy, 1 when stopped, and 2 when unverified or unhealthy.
`stop` shuts down the desktop UI, mobile listeners and backend trading worker.
Restarting requires fresh automatic-trading confirmation; broker-accepted orders
remain at the broker. Supply the same environment overrides on each command,
for example `PORT=8001 sh web.sh restart` for a custom desktop port.

`run_varshan.sh` runs the Mac launcher in the foreground (stop with Ctrl+C).
`run_dashboard.sh` remains a compatibility launcher too.

The UI includes holdings, India and US recommendations, replacement research,
weekly reviews, live and paper trading, benchmark graphs, daily market learning,
and account settings. Values update through shared queries and WebSocket
notifications. Tabs retain their forms and analyses, and connected account
pickers stay in Account settings. The orange V logo and responsive theme remain.

## Project structure

- `frontend/src/`: React workspaces, account controls, charts and live updates.
- `server/src/brokers/`: Robinhood MCP, Kite REST, saved account roles and long-term business-quality rules.
- `server/src/shared/`: encrypted storage, market data, calendars and technical indicators.
- `server/src/trading/`: the shared opening-range strategy, paper journal and live decision model.
- `server/src/service.ts`: jobs, saved comparisons, trading workers and session consent.
- `server/src/app.ts`: validated local HTTP/WebSocket API and React hosting.
- `server/src/backtest.ts`: offline TypeScript backtests using the same strategy calculations.
- `server/test/`: isolated API, order-safety and synthetic Python parity fixtures.
- `legacy/python/`: the former implementation, retained as migration reference.

Private files remain in `india_stocks/`, `us_stocks/`, `backtests/` and the
existing encrypted `.env` and Robinhood OAuth cache. Storage is compatible with
the original authenticated Fernet format. On macOS the default key stays in Keychain under
`local-stock-portfolio`, with the original absolute project path as its account.
The first Node launch may ask macOS for Keychain access. Do not move the project
without also migrating its Keychain identity. No plaintext key file is created.

Choose **India broker account** in Account settings, Holdings or Recommendations.
There is no default broker: the saved Kite, Upstox or Groww account applies to
both India intraday trading and long-term holdings, analysis and delivery orders.
Connecting a broker does not select it. Existing installations must confirm their
choice once. Refresh India analysis after selecting an account; account histories
and plans are stored separately. Pause automation and reconcile pending orders
before switching. US account roles remain separate.

Both Robinhood account roles are selected explicitly and persist until changed.
Long-term analysis uses the investing account; intraday orders require the
separate saved Agentic trading account. Live budgets are account-specific and
never inherited from paper trading. Saved benchmark graphs retain their original
account scope and survive server restarts or failed data refreshes.

## Portfolio insights

Weekly review has **India**, **US** (long term), and **US trading** views.
It refreshes a trailing seven-day market and holdings briefing daily when opened,
with manual refresh available. Dated headlines come from Yahoo Finance with a
Google News RSS fallback and publisher links; completed-session moves retain their
own dates and price sources. These are reported events, not explanations of why a
price moved. Trading-account insights load a read-only broker snapshot as needed.

Benchmark comparison supports several same-market indices on one normalized
chart. Risk tables show annualized daily volatility, maximum drawdown, beta to the
primary index, 63-/126-session momentum, current concentration, and financial
quality evidence when available. The US research shortlist uses saved quality-vetted
candidates; dated financial evidence must be checked before acting. Metrics have
explicit formulas and missing-data states rather than proprietary or predictive
scores. Saved comparisons remain scoped to the selected account.

Choose up to six header indices in **Account settings → Top-bar benchmarks**.
Preferences are saved in the encrypted workspace and survive restarts. Index
quotes use Yahoo Finance with TradingView price fallback, and stale readings
retain their date and gray status.

## Gems investment research

In **Recommendations**, select **Gems**, choose India or US long term, and click
**Refresh analysis**. Gems independently scans the Nifty MidSmallCap 400 or
Nasdaq-100, without requiring a broker account or a momentum score. It saves an
encrypted dated screen and displays qualifying research candidates plus rejection
reasons. Results older than 24 hours require a refresh.

Gems v2 separates eligibility from scored preferences. Research candidates need
at least 70/100: valuation 25, growth 25, cash generation 25, capital efficiency
10 and price risk 15. A sector P/E comparison can add up to five valuation points
within its 25-point cap when five peers have evidence. Cheaper valuation, faster
sustained growth and lower volatility rank higher without requiring every ratio
to hit the same rigid cutoff.

Core checks require current financial/price evidence, two comparable annual
statements, positive latest earnings and operating/free cash flow, positive
annualized revenue and earnings growth, positive P/E no greater than 50, known
debt/equity at most 3, RSI below 70, annualized six-month volatility at most 50%,
ATR/price at most 5%, and price at least 80% of its 200-day average. These upper
eligibility bounds do not mean a stock is cheap or low risk; scores express those
preferences. Financials and property still need sector-specific analysis.
Dimensionless ratios may compare USD quotes with financial statements in another
currency; cash amounts retain their financial currency. USD allocation requires a
USD quote. Rejected price screens explicitly report that financials were skipped;
unavailable or stale evidence is a data gap. Watchlist rows do not enter plans.

These parameters are research heuristics, not tested return predictions. The
growth multiple uses historical growth rather than forward analyst PEG; P/E also
needs industry context. Management quality, capital-allocation decisions,
government-policy fit, regulatory exposure and the company's 3–5 year vision
remain explicit filing-review requirements for every candidate. Ratios do not
verify those judgments. Gems does not create rebalance orders or enable trading.
The US Gems view now includes an account-scoped, saved 3–5 year model allocation:
up to eight stocks, 12.5% per stock and 30% per sector, with a cash reserve and
40%/30%/30% entry stages. Record dated policy, management and vision notes with
source links before any initial amount is marked ready; reviews expire after
90 days. Targets must be compared with existing holdings and send no orders.
POST `/api/analysis/India/gems` or `/api/analysis/US/gems` runs the same scan.

## Trading controls

Both India and US live trading show a **Buy SYMBOL** action beside shortlisted
stocks. It opens a review for that stock only, sized from the saved account
budget and risk limits. The order requires final explicit confirmation; previewing
never submits it. Pause automatic trading first. Disabled buttons explain unmet
entry checks, stale data, pending orders or unsaved settings. A US buy dependent
on sale proceeds requires the existing full-rebalance review; row buys cannot
silently submit unrelated sells or spend estimated future proceeds. The broker,
account and strategy are checked again at preview and confirmation.


India trading defaults to automatic stock selection from **Nifty 100**.
Choose a trading index: **Nifty 50**, **Nifty Next 50**, **Nifty 100**,
**Nifty 200**, **Nifty 500**, **Nifty Bank** or **Nifty IT**. Save the
selected broker account's budget and reserve; no stock names are required.
The app downloads the chosen index's NSE equity constituents once per exchange
day and uses the shared US scanner to build a rotating shortlist of up to four
stocks. A completed 15-minute opening range, at least 10 baseline sessions and
1.5x relative opening volume produce candidates. Confirmed breakouts, VWAP/EMA,
fresh broker prices, spread, costs, budget and risk checks still gate orders.
The shortlist and waiting reasons appear in India trading. No qualifying stock
means no new buy. A missing/invalid index list or stale scan blocks entries and
is retried; existing managed exits retain their separate checks. A custom NSE
watchlist remains available. Saving or scanning never enables automatic orders;
start a separately confirmed trading session to execute through the chosen broker.

**Save India trading settings** confirms the budget, reserve, index and watchlist
on the local server, with a saved time and revision. These account-specific
settings survive page refreshes, browser closure and server restarts. An already
verified account can save limits even when its broker API is unavailable. The
form shows the confirmed amount separately from editable values and never starts
trades with unsaved changes. Older windows cannot overwrite a newer revision.

Confirmed settings, risk state, order references/receipts, managed stop/target
levels, pending-order state, history and the last account/shortlist summaries are
stored encrypted in `india_stocks/live_intraday_trading.json`. Constituent lists
are cached by index and NSE date in encrypted
`india_stocks/trading_index_constituents.json`; stale lists are not used for new
entries when the next day's download fails. Browser-local drafts preserve edits
for the same account and saved revision, but never authorize orders. Cached
snapshots are labelled with their time and restored as display-only data. Orders
still require fresh broker checks, current signals and explicit trading consent.


Live US and India buys now require net target reward at least equal to net risk
after estimated costs, plus positive target reward when estimated costs double.
Observed spreads can increase the estimate; the same costs enter risk sizing.
US top-ups are checked against their existing target. Protective exits are
independent of this entry filter. Trading views contain a shared market
comparison and the BloombergGPT research reference. BloombergGPT is an NLP model,
not a published profitable trading policy; it is not connected to this app.
See [the research and implementation review](docs/trading-research.md) for the
market differences, cost example, allocation policy and validation limits.

Active automatic execution and pending orders are checked every 750 ms, with a
250 ms scheduler, one workflow at a time and exponential read-failure backoff
up to 30 seconds. Monitoring without automation checks broker data every five
seconds; closed markets and paper/candle refreshes use fifteen-second intervals.
Authenticated dashboards receive coalesced WebSocket notifications about 40 ms
after backend changes, with HTTP polling as a reconnect fallback. Status GETs
do not write to disk, and decision-history responses contain the latest 100
entries (the encrypted journal still retains 2,000). Equity history is sampled
at most once every five seconds. Quote batches start after holdings arrive,
without waiting for portfolio/order history, with at most two quote requests
of twenty symbols in flight. Snapshot `fetch_duration_ms` measures acquisition
latency. These are scheduling targets, not guarantees of sub-second broker
responses, market-data delivery or fills. After the daily opening-range scan,
price polling focuses on the shortlist and held stocks.
Yahoo's live price observations are kept separately from completed candles:
they can supply a fresh entry price but cannot confirm a breakout. Historical
ORB paper/backtest entries remain limited to the first minute after a completed
first breakout. Live rotation entries are described below. Paper
trading displays its shortlist and per-stock waiting reasons, and retries an
empty shortlist when usable opening-range data arrives.

The watchlist considers all opening-range candidates, not only the original top
four. Candidates with a missed first breakout are removed immediately. An unheld
candidate that waits one minute is replaced when another qualified stock is
available, with a one-minute cooldown to prevent cycling back immediately.
Fresh eligible entries are retained. Holdings and pending or unresolved broker
orders continue to be monitored separately. Changing the watchlist alone never
sells or cancels an order; live holding replacements require the independently
validated sell-then-buy plan described below. Tables show watch start times and
replaced symbols. Entry, budget and risk checks still apply.

Live execution now uses `intraday_rotation_v1`. Unlike the historical ORB
paper/backtest entry rule above, live entries can use a current completed breakout
throughout the regular intraday entry window. A fresh broker price must still be
above the opening-range high. Entries also require a completed close at or above
session volume-weighted typical price (VWAP), the session-seeded 9-period EMA,
and at least 1.5x opening relative volume. Indicators exclude premarket,
incomplete, synthetic and invalid bars. New entries stop fifteen minutes before
the exchange close, including half-days. Broker quotes must retain VWAP/EMA
confirmation; a price jump beyond the last completed close is rejected when it
exceeds the larger of 0.5% of price or half the 14-bar average true range, capped
at 1.5% of price. Where the broker supplies bid/ask data, invalid/crossed spreads
or spreads wider than 0.5% block buys. These parameters are explicit strategy
heuristics, not an assertion of tested profitability.

The default live sizing mode targets available
capital after the saved cash reserve equally across 2–4 qualifying stock slots.
The allocatable capital is bounded by the saved budget, account equity, existing
investments and actual broker buying power. One qualifying stock gets at most
half, leaving room for a second. With a $100 budget and 10% reserve, full-fund
allocation targets are $45 each for two stocks, $30 each for three, or $22.50 each
for four. Every order is additionally capped so the position's planned loss at
its stop, including estimated execution costs and existing holding risk, stays
within 0.25% of account equity. A wider stop therefore reduces the order below
its equal-allocation target; unused money stays in cash. Orders below $1 are
blocked locally. No initial manual purchase is necessary. Historical ORB/paper
and configured RL policies retain their separate entry/allocation behavior.

Live entry stops use the tighter of the opening-range low or entry minus 1.5x
average true range. The target is 2R. After a post-entry completed candle closes
at +1R, protection moves to break-even and trails the two-candle low without
loosening. Original risk metadata is retained across top-ups; protection is
reconstructed from post-entry completed candles after restart. The target does
not move closer as the stop tightens.

After an interruption or restart, existing US holdings retain their saved
stop and target and are reassessed against current broker data, even if bought
in an earlier session. Age, missing metadata and restarting alone do not cause
a sale. Holdings without usable levels wait for current analysis; known stops,
targets, the daily loss halt, closing exits and qualified replacements still
apply. Failed retries without fills cannot replace a successful entry's risk
levels. Pending or uncertain orders continue to block new submissions.

Stops are software-monitored while the app and trading session are active, not resting broker stop orders; outages,
price gaps and execution costs can make actual losses exceed the planned cap.
A 1% decline from the first valid session equity snapshot persists a daily halt,
blocks entries, and triggers exits even if entry signals are stale. Equity
recovery and restarts cannot clear it; the next exchange session resets it.
Remaining holdings have a scheduled exit five minutes before exchange close.

Existing live holdings can receive top-up buys when they still satisfy the
confirmed-breakout and relative-volume requirements. The add uses remaining
broker buying power and budget after reserve, and subtracts the holding's current
market value from its target allocation. Existing and additional shares share
the same 0.25% position-risk budget. An existing stop is never loosened.
Top-ups keep the same position slot,
allow additions after a same-day entry, and have a $1 minimum to avoid repeated
penny-sized orders. Exit signals, pending/unresolved orders and stale data block
adds. Once the holding reaches its target, subsequent checks do not buy again.
The live decision table and order tickets identify top-ups explicitly.

When budget or position slots are occupied, the live plan can replace a weaker
holding with an eligible stronger candidate. Strength is the latest completed
close's percentage distance above the opening-range high. A replacement requires
an improvement of at least 0.25 percentage points, without an extra holding-time delay. The plan simulates proceeds and
rechecks eligibility before selling; the buy waits for the sale's confirmed fill
and actual buying power. A trained RL policy, when configured, retains allocation
control instead of this deterministic replacement rule.

Newly rotated candidates receive current prices in the same refresh cycle. When
no candidates qualify, refreshes sweep at most twelve universe stocks plus held
and protected stocks, rather than repeatedly scanning the entire universe.
Terminal broker receipts remain terminal even after they disappear from recent
order history. Automatic buys whose permitted amount shrinks get an exact new
broker review at the lower amount; they never grow past their preview. Withdrawn
signals supersede unsent automatic plans without ending session consent. Unknown
placements and rejected orders still stop execution for review.

**Check broker order status** refreshes one account snapshot, reconciles all
tickets and updates the displayed decision. A placement error or a response
without an order ID stays unresolved; an error alone does not prove rejection.
Confirmed receipts are saved before broker-session cleanup. Canceled, expired
and voided orders stop the remaining rebalance instead of waiting forever.
If the broker returns a different reference ID after a timeout, Order tickets
shows matching filled receipts for review. Verify the fill in Robinhood, then
use **Link confirmed receipt**. The server rechecks account, symbol, side, type,
exact quantity (or returned dollar amount), submission time and existing links.
Similar trades are never linked automatically. If no receipt can be verified,
the ticket remains blocked. Linking can allow an already-enabled automatic
session to continue; it does not enable a paused session.

The live view persists per-account decision history, automation changes and order
results (up to 2,000 records), with timestamps and per-stock waiting reasons.
Unchanged decision summaries are sampled at most once per minute. The dashboard
shows the last 100 records; the history survives restarts. Older records are not
reconstructed retrospectively.

Broker workflows share one authenticated MCP helper while the server is running,
serialized across dashboard reads and trading operations. They no longer start
and close a helper for each refresh. Reusable OAuth tokens and client registration
are checkpointed into the encrypted credential cache after each workflow. Process
locks, logs and one-time PKCE verifiers are excluded, and an explicitly emptied
cache replaces old credentials so invalidated tokens are not resurrected. A
broken connection is retired; only a later workflow opens a replacement. Failed
workflows, including potential placements, are never replayed. Server shutdown
closes the shared helper and removes its private temporary credential directory.
Robinhood can still require genuine OAuth reauthorization; connection reuse does
not bypass the broker's authentication or the app's separate trading consent.

In manual mode, eligible buy or sell signals open a review prompt while the live
tab is visible. Reviewing loads broker previews; orders still require the final
explicit confirmation. Automatic mode submits eligible orders under its separate
session consent. Broker reads, previews and execution checks share one MCP
connection within each operation. Each MCP request has its own timeout, and
broker rejection details are displayed with OAuth secrets redacted.
The initial history scan reports its progress rather than blocking live account
reads. Paper freshness is evaluated when a scan completes, so asynchronous data
loading cannot leave the simulation permanently waiting.

Starting or resuming a paper session creates simulated fills only. Live orders
require an eligible strategy action, a broker preview, and explicit confirmation.
Kite rebalances require a server-reviewed editable basket and confirmation.
Orders are journaled before placement; interrupted responses become unresolved
and are never automatically resent. Sells must fill before contingent buys,
and the backend rechecks actual available funds, holdings and current signals.

Automatic trading requires separate explicit consent for a backend session of
up to twelve hours, which continues when the browser disconnects. It starts
disabled on every server launch. Account changes, expiry and the stop control
pause future submissions. Orders already accepted by the broker remain
at the broker. One Node server may run per project, enforced by a process lock.
Run only the new application against this data directory.

Long-term exit proposals require repeated business weakness; a weak price trend
alone cannot trigger an exit of a healthy business. Missing, stale or mismatched
annual statements retain a review state. Funds and financial/real-estate
companies require a separate sector review. Long-term reports are read-only;
this application does not automatically submit long-term orders.

## Data and development

Yahoo Finance is the primary price source; TradingView is the fallback for
prices. Its public socket can be unavailable or delayed. Financial statements
come from Yahoo; absent fundamentals block eligibility rather than being
invented from TradingView prices. Comparisons normalize the current holdings
basket to 100 and exclude dividends, cash flows and transaction costs; they
are not a time-weighted account-performance record.

Daily market briefings use completed sessions and a 50-session price average.
Exchange schedules are bundled in `server/data/sessions.json` (2020–2035),
including the former backend's holidays, US daylight saving and early closes.
Update the schedule against exchange announcements as new holidays or exceptional
closures are published, particularly future NSE dates. Dates outside bundled
coverage fail closed. No Python calendar package is loaded at runtime.

```sh
export PATH="$PWD/.tools/node/bin:$PATH"
npm test                    # server safety/parity tests and React tests
npm run build               # strict TypeScript and production UI builds
npm run test:browser         # install Playwright Chromium first if needed
npm run format:check
npm --prefix server run dev # Node API on port 8000
npm --prefix frontend run dev # Vite on 5173, proxies API to Node
```

Browser tests use an inert server and intercepted synthetic portfolios; they
cannot access credentials or place orders. Server order tests use fake broker
sessions. Dependency locks are committed separately for the server and frontend.
Robinhood's OAuth helper is installed locally from the lockfile rather than
being downloaded by `npx` during a broker request.

Offline backtests accept CSVs with `timestamp,symbol,open,high,low,close,volume`;
include explicit UTC offsets. Input may be plaintext public data or already
encrypted. Results are encrypted using the same project storage.

```sh
npm --prefix server run backtest -- orb intraday.csv backtests/orb
npm --prefix server run backtest -- momentum daily.csv backtests/momentum '^NSEI'
```

ORB evaluation uses 20 warmup sessions, separate development/held-out accounts,
and doubled-cost stress runs. Momentum signals use prior daily bars and execute
only at observed subsequent opens. Historical data coverage and survivorship
bias limit both tests; reports do not mark a strategy ready for live trading.

Account settings now save privacy mode, Porcelain/Midnight/Botanical/Obsidian/Aurora/Sandstone themes, Yahoo Finance or TradingView stock links, and whether stock charts open inside Varshan or in a browser tab. Privacy mode removes private table values, quantities, portfolio metrics and graph contents from the rendered UI, hides private numeric inputs, and disables table CSV downloads. It does not change broker data or trading settings. Public stock price charts remain available. Saved preferences are kept in encrypted workspace storage; privacy and theme choices also bootstrap locally while preferences load.

Live US trading records broker-reported total account value on fresh snapshots, separately for each account, with up to 2,000 observations retained. Deposits and withdrawals affect this account-value chart. Recording or viewing the chart sends no orders. Nifty MidSmallCap 400 is available for India comparison and top-bar selection, using the exact `NSE:NIFTYMIDSML400` TradingView series.

Kite login now uses the same browser tab and a one-time return state. The callback exchanges the request token on the backend, removes callback credentials from the browser URL, and restores the workspace that initiated login. Register `http://127.0.0.1:8000/` as the redirect URL in the Kite developer console (the retired Streamlit app used port 8501). Kite controls this registered URL; `redirect_params` carries the return workspace and cannot override the registered redirect. Existing manual token entry remains available. Return states expire after ten minutes and cannot be reused; restarting the server during login requires starting a new login. No order or analysis job runs as a side effect of returning from login.

The six theme previews show each palette’s navigation, metrics and chart accents. Porcelain and Botanical keep the existing `light` and `forest` preference IDs, so saved selections continue working. Each theme coordinates surface gradients, navigation, metrics, buttons, chart accents and readable foregrounds; themes persist across reloads and respect reduced-motion preferences.

## Phones, HTTPS and notifications

The launcher now starts three listeners: the existing desktop app at `http://127.0.0.1:8000`, a phone setup guide at `http://<Wi-Fi-IP>:8080`, and the mobile app at `https://<Wi-Fi-IP>:8443`. The desktop listener stays on loopback. The setup listener serves only instructions and the public CA certificate; portfolio and trading APIs are served through authenticated HTTPS on the private network. Open **Account settings → Mobile access** on the desktop for the current addresses, a single-use five-minute pairing code, and a control to revoke phone access. Only one phone session is permitted at a time. Unpair or revoke the existing phone before connecting another. A paired device gets a twelve-hour Secure/HttpOnly cookie; device credentials and subscriptions are encrypted at rest. API requests retain origin and CSRF checks, including WebSocket authentication. Internet-facing hostnames and public client addresses are rejected.

1. Connect both phones to the computer’s Wi-Fi. On the phone, open the setup guide address and download the public certificate.
2. On iPhone, install the downloaded certificate/profile and enable trust in **Settings → General → About → Certificate Trust Settings**. On Android, install it as a **CA certificate** from Security settings. The public CA is installed for server trust. A password-protected phone identity is exported on the desktop after Touch ID and transferred using AirDrop or USB; CA and server private keys remain in `.local/mobile-tls/` with restrictive permissions.
3. Open the HTTPS mobile address. On iPhone/iPad with web-push support (iOS/iPadOS 16.4+), use **Share → Add to Home Screen**, then open Varshan from that icon. On Android, use Chrome or install the web app. Enter a fresh pairing code if prompted.
4. In phone **Account settings → Trading notifications**, enable notifications, grant permission, and send a test notification. Repeat pairing and notification enrollment for each phone/browser install.

Web Push uses persisted VAPID keys, a service worker and the browser’s push service, so a trading alert can arrive with the app closed. Alerts cover starts, pauses, automatic order updates and completed automatic rebalances. Payloads contain no balances, quantities, stock symbols or account numbers. An encrypted alert history and retry outbox survive server restarts; expired subscriptions are removed. Delivery failures never block orders. The service worker caches no account data, authentication responses or trading requests. The computer and phone need internet for delivery, and OS notification/Focus settings still apply. Install the certificate rather than bypassing an HTTPS warning; service workers and mobile push need a trusted secure context.

The TLS setup script uses OpenSSL and reuses the local CA while regenerating the server certificate when private IP addresses change. Restart the launcher after a Wi-Fi/IP change and use the new address; the same CA remains trusted. Private TLS files are excluded from source control. `MOBILE_PORT` (default 8443), `CERTIFICATE_PORT` (8080) and `PORT` (8000) configure listeners. `VARSHAN_MOBILE=0` keeps the mobile listener off.

### QR pairing and Mac Touch ID

Desktop **Account settings → Mobile access** shows a setup QR for installing the phone certificate. **Generate pairing code** opens a native Touch ID prompt on the Mac and then shows a second QR containing the secure phone address and single-use pairing code. Scan it to fill the code automatically, then tap **Open my workspace** on your phone. Codes expire after five minutes; generate a separate code for each phone. Pairing codes travel in a URL fragment, are removed immediately from the phone address bar, and are not sent as URL query parameters to the server.

Turning privacy mode off requires verification on the device being used: native Touch ID on the Mac, or a platform passkey on the paired phone (Face ID, fingerprint, or the phone’s OS-controlled device-lock fallback). The phone never invokes the Mac helper. Values remain masked until verification succeeds. Cancellation, timeout, unavailable Touch ID and failed verification leave the protected operation unchanged. Enabling privacy mode and changing themes do not require biometric approval.

The launcher compiles and locally signs `native/TouchID.swift` into `.local/biometrics/VarshanTouchID` using the Mac's Swift command-line tools. The Node backend calls Apple's `LocalAuthentication` framework asynchronously with the biometrics-only policy and no password fallback or reused approval. Fingerprints remain inside macOS; the helper returns only success or failure. Touch ID must be enrolled and the Mac unlocked. A non-Mac server cannot perform these protected actions.

## India intraday trading

**India trading** is a separate tab for NSE cash equities through **Zerodha
Kite, Upstox or Groww**, using whole shares and INR budgets. Settings, consent,
order tickets, risk state and history belong to the selected broker account.

1. Connect Kite using its existing login, or paste an Upstox/Groww daily access
   token in **Account settings → Broker accounts**. The backend verifies the
   account before saving the token in encrypted storage; tokens are never
   returned by the API. Obtain tokens from
   [Upstox developer apps](https://account.upstox.com/developer/apps) or
   [Groww Trading APIs](https://groww.in/trade-api/api-keys). Activate the broker's
   API, required subscriptions and registered public static IP before sending
   live orders. Renew expired tokens from Account settings.
2. Select the broker in **India trading**, refresh its account, and save a budget,
   cash reserve and 1–20 NSE stock symbols. Saving a connection does not start
   trading. The initial watchlist is editable. While this tab is visible, manual
   monitoring refreshes a configured, connected account every fifteen seconds
   during NSE hours after an initial account load. Idle and failed sessions do
   not repeatedly load; correct broker errors and refresh explicitly to retry.
   Routine checks leave form controls usable. Automatic
   sessions and pending orders are checked by the backend every five seconds;
   signal history refreshes independently so a scan cannot block risk exits.
3. Review an eligible buy or exit and confirm the real order, or explicitly start
   an India automatic session during NSE hours. It continues when the browser
   closes and expires at the exchange close. Graceful server shutdown pauses
   India automation. Crash recovery cannot extend consent or resend an
   unresolved order. US trading consent never enables India trading.

The India strategy shares completed 15-minute opening ranges, 1.5× relative
volume (at least ten prior opening ranges), VWAP/EMA confirmation, ATR stops, 2R
targets and break-even/trailing protection with the US strategy calculations.
Entries end thirty minutes before the NSE close; managed positions have a
scheduled exit twenty minutes before close, ahead of usual broker square-off.
Exchange dates and holidays use the NSE calendar and Asia/Kolkata timezone.
Up to four positions share the budget after reserve, with at least two allocation
slots. Whole-share sizes respect a 0.25% planned budget-risk cap, including an
estimated 0.4% of notional for costs and slippage. Actual costs and losses can
exceed estimates. A decline in intraday P&L of 1% of the budget from the first
session check persists a daily halt and triggers managed-share exits. Recovery
in P&L cannot clear it. These are strategy heuristics, not evidence of profitability.

This tab opens long intraday positions and exits app-managed quantities;
delivery holdings and external positions are excluded. Derivatives, short entries
and delivery orders are not supported here. Broker funds, stock eligibility and
managed shares are checked again before placement. Upstox uses protected v3
market orders, Kite uses its market-protection flag, and Groww uses CASH/MIS
market orders. Pending buys are cancelled after sixty seconds or when an exit is
needed; partial fills remain tracked for protection. Manual cancellation pauses
automation once the broker confirms it. **Check broker status** reconciles exact
broker references. Similar trades never resolve an unknown placement; unknown
placements block new orders and are never resent.

Stops run in software while the server is running and connected. Keep the Mac's
lid open. India and US automatic sessions share idle-sleep prevention; stopping
one does not release it while the other remains active. Broker square-off rules
and charges still apply. Protocol references:
[Upstox API](https://upstox.com/developer/api-documentation/),
[Groww API](https://groww.in/trade-api/docs/curl).

## Backend automatic trading

Starting automatic trading in the UI authorizes a backend session for up to twelve hours. It continues after tabs, browsers or phone apps close. The on/off choice is saved in an encrypted, account-bound automation preference and restored after API/server restarts or UI reloads. Restarting does not extend the original expiry. **Stop automatic trading** persists the off choice immediately. Account changes, expiration and execution errors still prevent unattended resumption. Interrupted automatic batches are not replayed: fresh broker snapshots reconcile known order IDs/reference IDs before new strategy decisions, while unresolved placements remain blocked. During the first upgrade from the non-persistent server, `web.sh restart` captures its current choice before stopping it; an unreadable live API aborts that migration without stopping the app. The worker continues checking snapshots on its normal 15-second schedule while running. The computer must remain awake and connected. Existing API clients that omit `background: true` retain browser-lease behavior. Paper sessions remain separate and send no orders. Trading decision history is the last card in the live US trading view.

On macOS, an enabled automatic trading session prevents idle system sleep while
allowing the display to sleep. Stopping or expiring the session, or shutting down
the server, releases this protection. Keep the lid open and the Mac connected:
closing the lid, choosing Sleep, losing power or losing network access can still
interrupt monitoring and software exits. If an order preview expires before any
placement, the worker discards that batch and evaluates a fresh plan without
turning automation off. Uncertain placements still require reconciliation and
are never resent automatically.

For iPhone certificate installation, open the setup guide in Safari and download `varshan.mobileconfig`. Install under Settings → General → VPN & Device Management, then enable full trust under Certificate Trust Settings. Android continues to use the `.cer` download with the CA certificate option.

### Phone verification and mobile cache

Use the secure Mac hostname shown in the updated QR (for example `https://varshans-macbook-air.local:8443`) for phone passkeys. The TLS certificate now covers this hostname, signed by the same existing local CA. Revoke the old IP-based phone session and pair once at the hostname address: host-only cookies cannot transfer across origins. The hostname resolves through your Wi-Fi’s local name service; phones and Mac must share the network with local discovery available.

The first phone privacy unlock registers a platform passkey; subsequent unlocks verify a signed challenge. The backend requires user verification, binds each challenge to the paired phone and exact origin, and accepts its one-use privacy proof for only sixty seconds. Cancelling or failing verification keeps values masked. No fingerprint or face data is stored by Varshan.

The Secure/HttpOnly session cookie still expires after twelve hours, and a small SameSite preference cookie restores the selected theme. Portfolio, comparison and weekly snapshots are encrypted with a non-extractable AES-GCM key in IndexedDB, scoped to the authenticated twelve-hour phone session. They restore after a reload and refresh through normal backend queries. Cache restoration requires a valid online session check; unpairing, revocation or expiration clears cached snapshots. Live orders, trading controls, jobs, broker credentials and authentication proofs are never persisted in this cache. Storage restrictions fall back to regular online operation.

Botanical now includes a layered woodland and waterfall backdrop, a forest sidebar widget, and leaf/sprout details on existing cards and metrics. The top-bar **Dark mode** switch saves through the existing appearance preferences; Botanical switches between forest day and **Forest at night**. **Dark** is also available as a dedicated graphite theme. Artwork is local vector geometry with no external image requests or background animation.

### Required phone identity and theme compatibility

Restart Varshan with `sh run_varshan.sh` after this update. The mobile HTTPS listener now requires a CA-signed client identity at the TLS handshake. Phones without an identity, phones presenting an untrusted identity, and plain HTTP access cannot reach the application or pairing endpoint. A pairing code cannot bypass the certificate requirement. The public HTTP setup listener serves only the guide and public root certificate.

On the Mac, open **Account settings → Mobile & security → Download phone identity certificate**, approve Touch ID, and transfer `varshan-phone-identity.p12` to your phone using AirDrop or USB. Copy the import password shown on the Mac. Install the identity on iPhone under Settings → General → VPN & Device Management, or as a VPN/app identity certificate on Android. Keep the public root CA installed and trusted. Select the Varshan identity when the browser asks, then pair normally. The password-protected package is never exposed on the public setup listener. Browser support for client identities in installed web apps varies; use Safari/Chrome if the installed app cannot present the identity.

Account settings groups appearance/privacy, markets/charts, broker accounts, and mobile security with quick section navigation. The backend advertises supported themes from the same catalog used for validation. A page talking to an older backend offers only its original six themes and shows a restart notice instead of submitting the new IDs. Appearance saves share a pending state and immediately update the preference cache after success.


Reinforcement learning allocation is available for the US paper and live trading
workflows. Train a deterministic tabular Q-learning policy offline:

```sh
npm --prefix server run backtest -- rl intraday.csv backtests/rl
# Supply an allocation policy, then enable learning influence in Account settings:
export RL_MODEL_PATH="$PWD/backtests/rl/policy.json"
npm start
```

Use stock-only five-minute OHLCV data with at least ten sessions and 100 aligned
bars. The first 70% of sessions train the policy; later sessions evaluate a frozen
policy against an equal-weight baseline and doubled costs. The encrypted report
contains equity curves, turnover and drawdown. Training uses a fixed seed, 40
epochs, 8 bps one-way costs and a reward based on net returns with drawdown and
exposure penalties. States encode momentum, volatility, drawdown and available
cash; actions choose 0%, 50% or 100% exposure to deployable capital. Up to four
momentum-ranked stocks receive equal slots, capped at 25% each. The replay uses
a 10% reserve and exits at the final aligned bar's open each session.

Runtime inference uses completed candles only and never explores or learns from
real orders. It applies the user's reserve and budget, existing stop-risk sizing,
quote freshness, daily loss limits and pending-order checks. Excess holdings can
be reduced when they exceed their target by more than 1% of equity (minimum $1);
new buys still require an eligible opening-range breakout. Unknown or insufficiently
trained states block entries and retain existing risk exits. A policy trained through
the decision timestamp also blocks entries. RL decisions and coverage reasons appear
in the existing live and paper monitors. Inference also requires **Account settings →
Reinforcement learning → Use reinforcement learning in trading and automatic trading**.
This setting defaults to off. Without RL_MODEL_PATH, the original
allocation policy runs with the faster one-minute watchlist rotation.

The RL replay evaluates allocation, not the full ORB execution overlay: its results
do not establish live performance. No model is activated or real order sent by
training. Live trading still requires the existing broker review/confirmation or
an explicitly started automatic session. The 15-minute opening range remains the
strategy's signal definition; the candidate rotation delay is now one minute.


The Live strategy monitor shows the current scanning or waiting stage even when
no stock decisions exist. During history and price loading, it reports completed
and total stock checks. The view polls status every three seconds while open,
without triggering extra scans or broker orders. The rebalance panel lists the
whole ticket queue and separates confirmed fills, pending broker orders and
orders not sent. It retains the latest batch after completion or a stop, including
its error. The monitor also shows the last account check and whether an RL policy
is configured. Frontend status and order-queue fallbacks work with an already
running backend; incremental scan counts require the updated server.


## Strategy reinforcement learning and trade evidence

**Recommendations → India / US reinforcement learning recommendations** shows
stock suggestions, scores, reasons, observation dates and evidence requirements
for the selected learning account. **Market learning → Strategy learning & trade journal** shows observed orders,
closed position cycles, recorded reasoning, evidence gaps and evaluation. The
existing offline portfolio Q-learner remains available separately. Learning is
advisory by default: validated scores do not alter investing plans or trading
candidate order until the saved setting is explicitly enabled. Changing it requires
both markets' automation to be paused and pending orders resolved. It never
starts an automatic session. The setting lives in encrypted local workspace
storage and survives refreshes and server restarts. The new
one-step tabular Q-learner (a contextual bandit) learns select versus wait from
realized outcomes. It is not a language model or a profitable-return guarantee.

Broker refreshes capture US trading orders, India orders from Kite/Upstox/Groww,
and Kite delivery orders. Syncing Robinhood investing holdings also loads its
available order history. Paper fills stay in a separate scope. Stable broker
identities deduplicate repeated snapshots; cumulative partial-fill/status
revisions remain in the encrypted journal without pruning buy/sell records.
Configured trading accounts also observe fresh candidates during regular market
hours while automation is paused, about once per minute with no browser open.
Active trading retains its existing refresh cadence. These reads collect context
and available order updates; they never submit orders. The server must be running
and connected. Capture failures surface in the advisor and cannot block protective broker exits.
Historical availability depends on broker retention and app refreshes; holdings
alone cannot reconstruct missing executions or off-app history. Unavailable fill
prices/timestamps remain unknown.

Strategy context is recorded before app trading previews and dated analysis
scans. Attribute external orders to their followed strategy and record reasoning
in the journal. Attribution cannot create historical features: only an earlier,
fresh saved observation can qualify. Complete flat-to-flat position cycles count
as independent samples; top-ups and partial sales do not multiply sample counts.
Open orders, missing opening lots, mixed strategies, incomplete partial-fill
chronology and future observations do not produce training rewards. Fees use
reported amounts when available; otherwise explicit fee buffers are 1 basis point
per US side and 10 basis points per India side. These are estimates, not a broker
fee reconciliation or tax accounting.

Each account, market and horizon learns separately. The model uses market trend,
volatility, RSI and the followed strategy. Select reward is net realized return,
with an extra 50% downside penalty; cash/wait reward is zero. A chronological
70/30 split purges training outcomes overlapping evaluation entries. Policy tables
are frozen during evaluation. Require 20 training cycles, 10 later evaluation
cycles and five independent examples in a state. With trading influence enabled,
rank adjustments activate only
when supported held-out outcomes beat the observed-strategy baseline and remain
positive with doubled costs. Adjustments are bounded to five Gems score points;
Gems eligibility and trading risk/consent checks stay authoritative. Uncovered
states retain the original ranking. Models refresh when observed orders change,
and can be explicitly retrained from the learning panel.

Evaluation is conditional on trades actually observed, is affected by selection
bias, and reports trade-normalized returns rather than portfolio returns. It
cannot establish outcomes for stocks never traded or prove that a strategy change
caused an improvement. Findings identify negative observed strategy averages,
costs consuming gross gains and missing context; they are prompts for research.
New strategies and long-term accounts will need time to collect enough completed
outcomes. No random live experimentation or automatic strategy-threshold editing
is performed.
