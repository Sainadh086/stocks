"""Local, read-only Plaid Investments link for US brokerage holdings.

The browser talks only to a loopback server. Plaid credentials and the long-lived
access token stay in Python and never enter the dashboard page or Link script.
"""

import json
import math
import re
import secrets
from datetime import datetime, timezone
from html import escape
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from threading import Thread
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

import pandas as pd

from brokers.robinhood import analysis as us_stocks
from shared import storage as secure_storage
from shared.storage import require_setting as credential
from shared.storage import setting

LINK_PORT = 8502
LINK_URL = f"http://127.0.0.1:{LINK_PORT}/"
CONNECTION_FILE = us_stocks.US_STOCKS_DIR / "plaid_connection.json"
HOLDINGS_FILE = us_stocks.US_STOCKS_DIR / "plaid_holdings.csv"
_server = None


def plaid_post(endpoint, payload):
    environment = (setting("PLAID_ENV") or "production").lower()
    if environment not in ("production", "sandbox"):
        raise ValueError("PLAID_ENV must be production or sandbox.")
    request = Request(
        f"https://{environment}.plaid.com{endpoint}",
        data=json.dumps(payload).encode("utf-8"),
        headers={
            "Content-Type": "application/json",
            "PLAID-CLIENT-ID": credential("PLAID_CLIENT_ID"),
            "PLAID-SECRET": credential("PLAID_SECRET"),
        },
        method="POST",
    )
    try:
        with urlopen(request, timeout=30) as response:
            return json.load(response)
    except HTTPError as exc:
        try:
            error = json.load(exc)
            code = error.get("error_code", "API_ERROR")
            message = error.get("error_message", "Plaid request failed")
        except (ValueError, TypeError):
            code, message = "API_ERROR", "Plaid request failed"
        raise RuntimeError(f"Plaid {code}: {message}") from exc
    except URLError as exc:
        raise RuntimeError("Could not reach Plaid. Check your connection.") from exc


def private_write(path, content):
    secure_storage.write_text(path, content)


def connection():
    try:
        with secure_storage.open_text(CONNECTION_FILE) as file:
            data = json.load(file)
        return data if data.get("access_token") else None
    except (OSError, ValueError, TypeError):
        return None


def sync_due(now=None):
    saved = connection()
    if not saved:
        return False
    stamp = saved.get("last_synced_at")
    if not stamp:
        return True
    try:
        previous = datetime.fromisoformat(stamp)
        current = now or datetime.now(timezone.utc)
        return (
            previous.astimezone(us_stocks.MARKET_TIMEZONE).date()
            < current.astimezone(us_stocks.MARKET_TIMEZONE).date()
        )
    except (TypeError, ValueError):
        return True


def normalize_holdings(response):
    """Keep positive USD stock/ETF positions; combine matching tickers."""
    securities = {
        item.get("security_id"): item for item in response.get("securities", [])
    }
    investment_accounts = {
        item.get("account_id")
        for item in response.get("accounts", [])
        if item.get("type") == "investment"
    }
    amounts = {}
    omitted = 0
    for holding in response.get("holdings", []):
        security = securities.get(holding.get("security_id"), {})
        symbol = (
            str(security.get("ticker_symbol") or "").strip().upper().replace(".", "-")
        )
        quantity = holding.get("quantity")
        try:
            quantity = float(quantity)
        except (TypeError, ValueError):
            quantity = float("nan")
        if (
            holding.get("account_id") not in investment_accounts
            or security.get("type") not in ("equity", "etf")
            or security.get("iso_currency_code") != "USD"
            or not re.fullmatch(r"[A-Z0-9-]+", symbol)
            or not math.isfinite(quantity)
            or quantity <= 0
        ):
            omitted += 1
            continue
        amounts[symbol] = amounts.get(symbol, 0.0) + quantity
    frame = pd.DataFrame(sorted(amounts.items()), columns=["symbol", "quantity"])
    return frame, omitted


def sync_holdings(access_token=None):
    saved = connection()
    token = access_token or (saved or {}).get("access_token")
    if not token:
        raise RuntimeError("Connect a brokerage account through Plaid first.")
    response = plaid_post("/investments/holdings/get", {"access_token": token})
    holdings, omitted = normalize_holdings(response)
    if not response.get("accounts"):
        raise RuntimeError(
            "Plaid returned no accounts; existing holdings were left intact."
        )
    private_write(HOLDINGS_FILE, holdings.to_csv(index=False))
    private_write(
        CONNECTION_FILE,
        json.dumps(
            {
                "access_token": token,
                "last_synced_at": datetime.now(timezone.utc).isoformat(),
                "holdings_count": len(holdings),
                "omitted_positions": omitted,
            }
        ),
    )
    return len(holdings), omitted


def create_link_token():
    response = plaid_post(
        "/link/token/create",
        {
            "user": {"client_user_id": "local-stock-portfolio"},
            "client_name": "varshan",
            "products": ["investments"],
            "country_codes": ["US"],
            "language": "en",
        },
    )
    return response["link_token"]


class LinkHandler(BaseHTTPRequestHandler):
    def log_message(self, format, *args):
        pass

    def respond(self, status, body, content_type="text/html; charset=utf-8"):
        encoded = body.encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(encoded)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Frame-Options", "DENY")
        self.end_headers()
        self.wfile.write(encoded)

    def do_GET(self):
        if self.path != "/":
            self.respond(404, "Not found", "text/plain; charset=utf-8")
            return
        try:
            link_token = create_link_token()
        except Exception as exc:
            self.respond(502, f"<h2>Plaid setup failed</h2><p>{escape(str(exc))}</p>")
            return
        page = """<!doctype html><html lang="en"><meta charset="utf-8">
<title>Connect brokerage holdings</title>
<style>body{font:16px system-ui;max-width:550px;margin:50px auto;padding:0 20px}
button{padding:12px 18px;font:inherit}#message{margin-top:20px}</style>
<h1>Connect brokerage holdings</h1>
<p>Plaid will ask you to authorize read access to investment holdings. This app
stores the resulting access token locally and does not place trades.</p>
<button id="connect" disabled>Loading Plaid…</button><p id="message"></p>
<p><a href="http://127.0.0.1:8501/">Return to dashboard</a></p>
<script src="https://cdn.plaid.com/link/v2/stable/link-initialize.js"></script>
<script>
const linkToken = LINK_TOKEN;
const nonce = NONCE;
const button = document.getElementById('connect');
const message = document.getElementById('message');
const handler = Plaid.create({token: linkToken,
  onSuccess: async (publicToken) => {
    button.disabled = true;
    message.textContent = 'Saving connection and syncing holdings…';
    try {
      const response = await fetch('/exchange', {method:'POST',
        headers:{'Content-Type':'application/json'},
        body:JSON.stringify({public_token:publicToken, nonce:nonce})});
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Sync failed');
      message.textContent = 'Connected: ' + result.count + ' stock/ETF positions. Return to the dashboard.';
    } catch (error) {
      message.textContent = error.message;
    }
  },
  onExit: (error) => { if (error) message.textContent = error.display_message || error.error_message || 'Connection canceled'; }
});
button.disabled = false;
button.textContent = 'Continue with Plaid';
button.onclick = () => handler.open();
</script></html>"""
        page = page.replace("LINK_TOKEN", json.dumps(link_token)).replace(
            "NONCE", json.dumps(self.server.nonce)
        )
        self.respond(200, page)

    def do_POST(self):
        if self.path != "/exchange" or self.headers.get("Origin") != LINK_URL.rstrip(
            "/"
        ):
            self.respond(403, '{"error":"Request rejected"}', "application/json")
            return
        try:
            size = int(self.headers.get("Content-Length", "0"))
            if size <= 0 or size > 10000:
                raise ValueError("Invalid request size")
            body = json.loads(self.rfile.read(size))
            if not secrets.compare_digest(
                str(body.get("nonce", "")), self.server.nonce
            ):
                raise ValueError("Invalid connection session")
            public_token = body.get("public_token")
            if not isinstance(public_token, str) or not public_token:
                raise ValueError("Missing public token")
            exchanged = plaid_post(
                "/item/public_token/exchange", {"public_token": public_token}
            )
            private_write(
                CONNECTION_FILE, json.dumps({"access_token": exchanged["access_token"]})
            )
            count, omitted = sync_holdings(exchanged["access_token"])
            self.server.nonce = secrets.token_urlsafe(32)
            self.respond(
                200,
                json.dumps({"count": count, "omitted": omitted}),
                "application/json",
            )
        except Exception as exc:
            self.respond(400, json.dumps({"error": str(exc)}), "application/json")


def start_link_server():
    global _server
    if _server is None:
        server = ThreadingHTTPServer(("127.0.0.1", LINK_PORT), LinkHandler)
        server.nonce = secrets.token_urlsafe(32)
        Thread(target=server.serve_forever, daemon=True).start()
        _server = server
    return LINK_URL
