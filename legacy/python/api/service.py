"""Bounded background jobs and a single managed worker for the local app."""

import fcntl
import json
import os
import threading
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from time import monotonic
from uuid import uuid4
from zoneinfo import ZoneInfo

import pandas as pd

from api import reports
from brokers.kite import assessment
from brokers.kite import rebalance as kite_rebalance
from brokers.robinhood import accounts, client, orders, rebalance, strategy
from shared import market_data as market
from shared import storage
from shared.comparison import BENCHMARKS, basket_comparison, comparison_prices
from shared.paths import US_DIR
from trading.agent import PaperAgent, new_account

WORKSPACE_FILE = US_DIR / "varshan_workspace.json"
PROCESS_LOCK = US_DIR / "varshan_api.lock"


class Service:
    def __init__(self, workers=True):
        self.lock = threading.RLock()
        self.jobs_lock = threading.Lock()
        self.analysis_lock = threading.Lock()
        self.executor = ThreadPoolExecutor(
            max_workers=4, thread_name_prefix="varshan-job"
        )
        self.jobs = {}
        self.daily = market.DailyMarkets()
        self.workspace = None
        self.paper = None
        self.signals = None
        self.live = None
        self.live_error = None
        self.auto = rebalance.new_auto_state(None)
        self.automation_revoked = threading.Event()
        self.connections = {}
        self.stop = threading.Event()
        self.workers = workers
        self.thread = None
        self.process_lock = None

    def start(self):
        if self.workers:
            PROCESS_LOCK.parent.mkdir(parents=True, exist_ok=True)
            self.process_lock = os.fdopen(
                os.open(PROCESS_LOCK, os.O_WRONLY | os.O_CREAT, 0o600), "w"
            )
            try:
                fcntl.flock(self.process_lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                self.process_lock.close()
                self.process_lock = None
                raise RuntimeError(
                    "varshan is already running. Use one FastAPI process for this workspace."
                ) from None
            self.thread = threading.Thread(
                target=self.run, name="varshan-worker", daemon=True
            )
            self.thread.start()

    def close(self):
        self.stop.set()
        if self.signals:
            self.signals.wake.set()
        with self.lock:
            rebalance.disable_auto(self.auto, self.batch())
        if self.thread:
            self.thread.join(timeout=2)
        self.executor.shutdown(wait=False, cancel_futures=True)
        if self.process_lock:
            self.process_lock.close()
            self.process_lock = None

    def state(self):
        if self.workspace is None:
            try:
                self.workspace = json.loads(storage.read_text(WORKSPACE_FILE))
            except FileNotFoundError:
                self.workspace = {"comparisons": {}, "batch": None, "india_draft": None}
            if not isinstance(self.workspace, dict):
                raise ValueError("Saved application workspace is invalid.")
            batch = self.workspace.get("batch")
            if batch and batch.get("automatic") and batch["status"] in rebalance.ACTIVE:
                rebalance.disable_auto(self.auto, batch)
                self.save()
        return self.workspace

    def save(self):
        storage.write_text(
            WORKSPACE_FILE, json.dumps(reports.clean(self.state()), allow_nan=False)
        )

    def batch(self):
        # Shutdown and idle startup must not prompt for Keychain access.
        return self.workspace.get("batch") if self.workspace else None

    def save_batch(self, batch):
        self.state()["batch"] = batch
        self.save()

    def job(self, kind, operation):
        with self.jobs_lock:
            for job in self.jobs.values():
                if job["kind"] == kind and job["status"] in {"queued", "running"}:
                    return job.copy()
            if len(self.jobs) >= 100:
                old = next(
                    (
                        k
                        for k, j in self.jobs.items()
                        if j["status"] in {"completed", "failed"}
                    ),
                    None,
                )
                if old:
                    self.jobs.pop(old)
                else:
                    raise ValueError(
                        "Too many operations are in progress. Wait for them to finish."
                    )
            job = {
                "id": uuid4().hex,
                "kind": kind,
                "status": "queued",
                "result": None,
                "error": None,
            }
            self.jobs[job["id"]] = job

        def execute():
            with self.jobs_lock:
                job["status"] = "running"
            try:
                result = reports.clean(operation())
                with self.jobs_lock:
                    job.update(status="completed", result=result)
            except Exception as exc:
                with self.jobs_lock:
                    job.update(status="failed", error=self.error(exc))

        self.executor.submit(execute)
        return job.copy()

    def error(self, exc):
        message = str(exc)
        try:
            for number in accounts.load_roles().values():
                if number:
                    message = message.replace(number, f"••••{number[-4:]}")
        except Exception:
            pass
        return message

    def job_status(self, identity):
        with self.jobs_lock:
            if identity not in self.jobs:
                raise ValueError(
                    "Operation not found. It may belong to an earlier server session."
                )
            return self.jobs[identity].copy()

    def markets(self):
        values = []
        for item in market.MARKETS:
            now = datetime.now(ZoneInfo(item.zone))
            try:
                phase = market.session_phase(
                    market.market_schedule(item.calendar, now.date()), now
                )
            except Exception:
                phase = "Session timing unavailable"
            report, error, pending = self.daily.snapshot(item, now, phase)
            details = dict(report or {})
            history = details.pop("history", None)
            values.append(
                {
                    "code": item.code,
                    "name": item.name,
                    "benchmark": item.benchmark,
                    "theme": market.report_theme(report, now),
                    "phase": phase,
                    "report": details,
                    "pending": pending,
                    "error": error,
                    "history": [
                        {"date": str(k.date()), "value": float(v)}
                        for k, v in history.items()
                    ]
                    if history is not None
                    else [],
                    "education_url": item.education_url,
                    "reflection": market.messages(
                        {"theme": market.report_theme(report, now)}
                    ),
                }
            )
        return reports.clean(values)

    def account_state(self):
        error = None
        try:
            roles = accounts.load_roles()
        except ValueError as exc:
            roles = {"long_term": None, "trading": None}
            error = str(exc)
        try:
            settings = (
                accounts.load_trading_settings(roles["trading"])
                if roles["trading"]
                else (None, None)
            )
        except ValueError as exc:
            settings = (None, None)
            error = str(exc)
        return {
            "error": error,
            "roles": {
                key: {
                    "selected": bool(number),
                    "ending": number[-4:] if number else None,
                    "scope": reports.account_scope(number),
                }
                for key, number in roles.items()
            },
            "kite_connected": reports.token_current(),
            "live_settings": {"budget": settings[0], "reserve_pct": settings[1]},
        }

    def available_accounts(self):
        available = client.list_accounts()
        try:
            roles = accounts.load_roles()
        except ValueError:
            roles = {"long_term": None, "trading": None}
        return [
            {
                "id": a["account_number"],
                "label": f"Account ••••{a['account_number'][-4:]}",
                "agentic_allowed": a.get("agentic_allowed") is True,
                "long_term": roles["long_term"] == a["account_number"],
                "trading": roles["trading"] == a["account_number"],
            }
            for a in available
            if accounts.eligible(a)
        ]

    def change_roles(self, long_term, trading):
        with self.lock:
            self.state()
            self.require_idle()
            accounts.save_roles(long_term, trading, client.list_accounts())
            rebalance.disable_auto(self.auto)
            self.live = None
            self.auto = rebalance.new_auto_state(trading)
            self.state()["batch"] = None
            self.save()
            return self.account_state()

    def require_idle(self):
        if self.auto.get("enabled"):
            raise ValueError(
                "Pause automatic trading before changing account settings."
            )
        batch = self.batch()
        if batch and batch["status"] in rebalance.ACTIVE:
            raise ValueError(
                "Wait for the confirmed live rebalance to finish before changing settings."
            )

    def set_live_settings(self, budget, reserve):
        with self.lock:
            self.state()
            self.require_idle()
            account = self.trading_account()
            accounts.save_trading_settings(account, budget, reserve)
            rebalance.disable_auto(self.auto)
            return self.account_state()

    def trading_account(self):
        number = accounts.load_roles()["trading"]
        if not number:
            raise ValueError(
                "Choose and save your daily trading account in Account settings."
            )
        accounts.require_trading_role(number)
        return number

    def monitor(self):
        if self.signals is None:
            self.signals = strategy.SignalMonitor(stop_event=self.stop)
        return self.signals.snapshot()

    def fresh_decisions(self, account=None, planning=False):
        if self.stop.is_set():
            raise ValueError("Application is stopping; remaining orders are paused.")
        if self.auto.get("enabled"):
            connection = self.auto.get("connection")
            if (
                self.automation_revoked.is_set()
                or monotonic() - self.connections.get(connection, {}).get("seen", 0)
                >= 25
            ):
                raise ValueError("Browser disconnected; automatic trading is paused.")
        account = account or self.trading_account()
        if self.trading_account() != account:
            raise ValueError("Trading account selection changed.")
        budget, reserve = accounts.load_trading_settings(account)
        signals = self.monitor()
        selected = strategy.selected_signals(signals)
        symbols = selected.symbol.tolist() if not selected.empty else []
        snapshot = orders.account_snapshot(account, symbols=symbols)
        self.live = snapshot
        self.live_error = None
        builder = strategy.rebalance_plan if planning else strategy.build_actions
        return builder(
            snapshot, signals, budget, reserve, orders.list_tickets(account)
        ), signals

    def refresh_live(self):
        with self.lock:
            try:
                model, _ = self.fresh_decisions()
                return reports.clean(model)
            except Exception as exc:
                self.live_error = self.error(exc)
                raise

    def live_view(self):
        with self.lock:
            number = accounts.load_roles()["trading"]
            self.state()
            snapshot = (
                self.live
                if self.live and self.live.get("account_number") == number
                else None
            )
            budget, reserve = (
                accounts.load_trading_settings(number) if number else (None, None)
            )
            model = None
            if snapshot:
                signals = strategy.signal_snapshot()
                model = strategy.build_actions(
                    snapshot, signals, budget, reserve, orders.list_tickets(number)
                )
            batch = self.batch()
            return reports.clean(
                {
                    "snapshot": orders.mask(snapshot, number)
                    if snapshot and number
                    else None,
                    "scope": reports.account_scope(number),
                    "model": orders.mask(model, number) if model and number else None,
                    "error": self.live_error,
                    "auto": orders.mask(self.auto, number) if number else self.auto,
                    "batch": orders.mask(batch, number) if batch and number else None,
                    "tickets": orders.mask(orders.list_tickets(number), number)
                    if number
                    else [],
                }
            )

    def preview_live(self):
        with self.lock:
            self.state()
            self.require_idle()
            if self.auto["enabled"]:
                raise ValueError("Pause automatic trading before a manual rebalance.")
            number = self.trading_account()
            model, signals = self.fresh_decisions(number, planning=True)
            batch = rebalance.prepare(number, model, signals)
            self.save_batch(batch)
            return self.live_view()

    def reconcile_live(self):
        with self.lock:
            number = self.trading_account()
            for ticket in orders.list_tickets(number):
                if ticket["status"] in {"submitting", "submitted", "unknown"}:
                    orders.reconcile_ticket(ticket["id"])
            return self.live_view()

    def confirm_live(self, identity, acknowledged):
        with self.lock:
            batch = self.state().get("batch")
            if (
                not batch
                or batch["id"] != identity
                or batch["account"] != self.trading_account()
            ):
                raise ValueError("Review a new rebalance for the selected account.")
            if batch["status"] != "preview":
                raise ValueError("This rebalance has already been confirmed.")
            model, _ = self.fresh_decisions()
            rebalance.submit(
                batch,
                model,
                acknowledged=acknowledged,
                model_provider=lambda: self.fresh_decisions()[0],
                on_progress=self.save_batch,
            )
            self.save_batch(batch)
            return self.live_view()

    def set_auto(self, enabled, connection, acknowledged):
        if not enabled:
            self.automation_revoked.set()
        with self.lock:
            self.state()
            if enabled:
                if acknowledged is not True:
                    raise ValueError(
                        "Explicitly confirm that automatic trading places real orders."
                    )
                if (
                    monotonic() - self.connections.get(connection, {}).get("seen", 0)
                    > 25
                ):
                    raise ValueError(
                        "Connect the live updates stream before starting automatic trading."
                    )
                self.require_idle()
                number = self.trading_account()
                budget, reserve = accounts.load_trading_settings(number)
                if budget is None or reserve is None:
                    raise ValueError("Save a live budget and cash reserve first.")
                self.auto = {
                    **rebalance.new_auto_state(number),
                    "enabled": True,
                    "connection": connection,
                }
                self.automation_revoked.clear()
            else:
                rebalance.disable_auto(self.auto, self.batch())
                if self.workspace:
                    self.save()
            return reports.clean(self.auto)

    def paper_agent(self):
        with self.lock:
            if self.paper is None:
                self.paper = PaperAgent(start_worker=False)
            return self.paper

    def paper_control(self, action, budget, reserve):
        budget, reserve = accounts.validate_trading_settings(budget, reserve)
        return self.paper_agent().control(
            action, new_account(budget, reserve) if action == "start" else None
        )

    def compare(self, role, benchmark, period):
        with self.lock:
            holdings, scope = reports.comparison_holdings(role, self.live)
            account_scope = (
                "India"
                if role == "India"
                else reports.account_scope(accounts.load_roles()[role])
            )
        region = "India" if role == "India" else "US"
        if benchmark not in BENCHMARKS[region]:
            raise ValueError("Choose a benchmark for this market.")
        histories, sources = {}, []
        for symbol, _ in holdings:
            histories[symbol], source = self.comparison_prices(symbol, period)
            sources.append({"symbol": symbol, "source": source})
        index, source = self.comparison_prices(BENCHMARKS[region][benchmark], period)
        sources.append({"symbol": benchmark, "source": source})
        curve = basket_comparison(holdings, histories, benchmark, index)
        result = {
            "scope": account_scope,
            "benchmark": benchmark,
            "period": period,
            "role": role,
            "holdings": holdings,
            "sources": sources,
            "updated_at": datetime.now(timezone.utc).isoformat(),
            "curve": [
                {"date": str(day.date()), **row.to_dict()}
                for day, row in curve.iterrows()
            ],
        }
        with self.lock:
            comparisons = self.state().setdefault("comparisons", {})
            if len(comparisons) >= 30 and scope not in comparisons:
                comparisons.pop(next(iter(comparisons)))
            comparisons[scope] = result
            self.save()
            return result

    @staticmethod
    def comparison_prices(symbol, period):
        return comparison_prices(symbol, period)

    def comparison(self, role):
        with self.lock:
            try:
                holdings, scope = reports.comparison_holdings(role, self.live)
            except (FileNotFoundError, ValueError):
                # Retrieval needs identity, not a successful current holdings read.
                import hashlib

                number = accounts.load_roles().get(role)
                identity = "India" if role == "India" else f"{role}:{number or 'local'}"
                scope = hashlib.sha256(identity.encode()).hexdigest()[:20]
                holdings = None
            result = self.state().setdefault("comparisons", {}).get(scope)
            if result:
                return {
                    **result,
                    "holdings_changed": holdings is None
                    or reports.clean(holdings) != result["holdings"],
                }
            return None

    def india_recommendation(self, strategy_name, selected=None, exits=None):
        picked, view, choices, selected, exits = reports.india_plan(
            strategy_name, selected, exits
        )
        return reports.clean(
            {
                "view": view,
                "choices": choices,
                "selected": selected,
                "exits": exits,
                "holdings": picked["holdings"],
                "assessment": assessment.assess(view, picked, strategy_name),
            }
        )

    def kite_draft(self, strategy_name, selected, exits):
        with self.lock:
            _, view, _, _, _ = reports.india_plan(strategy_name, selected, exits)
            state = kite_rebalance.account_state(reports.kite_client())
            rows = kite_rebalance.editor_rows(view, state)
            keys = [f"{r.exchange}:{r.symbol}" for r in rows.itertuples()]
            quotes = kite_rebalance.live_quotes(keys)
            rows["price_inr"] = [quotes[k]["last_price"] for k in keys]
            rows["price_as_of"] = [quotes[k]["quoted_at"] for k in keys]
            draft = {
                "id": uuid4().hex,
                "rows": reports.clean(rows),
                "user": state["user"],
            }
            self.state()["india_draft"] = draft
            self.save()
            return draft

    def kite_review(self, identity, rows):
        with self.lock:
            draft = self.state().get("india_draft")
            if not draft or draft["id"] != identity:
                raise ValueError("Reopen the Kite rebalance editor.")
            original = pd.DataFrame(draft["rows"])
            client = reports.kite_client()
            if kite_rebalance.account_state(client)["user"] != draft["user"]:
                raise ValueError("Connected Kite account changed. Reopen the editor.")
            return reports.clean(
                kite_rebalance.review(client, pd.DataFrame(rows), original)
            )

    def touch(self, identity, live=False):
        # Heartbeats must not wait for a slow brokerage call holding the data lock.
        self.connections[identity] = {"seen": monotonic(), "live": live}

    def disconnect(self, identity):
        # Revoke the lease immediately, even if an in-flight broker call owns the lock.
        self.connections.pop(identity, None)
        if self.auto.get("connection") == identity:
            self.automation_revoked.set()
        with self.lock:
            if self.auto.get("connection") == identity:
                rebalance.disable_auto(self.auto, self.batch())
                if self.workspace:
                    self.save()

    def run(self):
        last_live = last_paper = 0
        while not self.stop.wait(1):
            now = monotonic()
            try:
                with self.lock:
                    alive = {
                        key: v
                        for key, v in self.connections.items()
                        if now - v["seen"] < 25
                    }
                    if (
                        self.auto.get("enabled")
                        and self.auto.get("connection") not in alive
                    ):
                        rebalance.disable_auto(self.auto, self.batch())
                        self.save()
                    if now - last_live >= 15:
                        last_live = now
                        batch = self.batch()
                        if self.auto.get("enabled"):
                            number = self.trading_account()
                            budget, reserve = accounts.load_trading_settings(number)
                            if budget is None or reserve is None:
                                raise ValueError(
                                    "Live budget is unavailable; automation paused."
                                )
                            batch = rebalance.tick_auto(
                                self.auto, number, self.fresh_decisions, batch
                            )
                            if batch:
                                self.save_batch(batch)
                        elif (
                            batch
                            and not batch.get("automatic")
                            and batch["status"] in rebalance.ACTIVE
                        ):
                            rebalance.advance(
                                batch,
                                model_provider=lambda: self.fresh_decisions()[0],
                                on_progress=self.save_batch,
                            )
                            self.save_batch(batch)
                        elif (
                            any(c["live"] for c in alive.values())
                            and accounts.load_roles()["trading"]
                        ):
                            self.refresh_live()
                if now - last_paper >= 60:
                    last_paper = now
                    if self.paper:
                        self.paper.cycle()
            except Exception as exc:
                with self.lock:
                    self.live_error = self.error(exc)
                    rebalance.disable_auto(self.auto, self.batch())
