"""FastAPI entry point. Bind to loopback; serve the built React UI on the same origin."""

import asyncio
import secrets
from contextlib import asynccontextmanager
from typing import Literal

from fastapi import FastAPI, HTTPException, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, ConfigDict, Field
from starlette.middleware.trustedhost import TrustedHostMiddleware

from api import reports
from api.service import Service
from brokers.kite import rebalance as kite_rebalance
from brokers.robinhood import client
from shared.paths import ROOT

Market = Literal["India", "US"]
Role = Literal["India", "long_term", "trading"]
Strategy = Literal["momentum", "weekend_style", "naked_style"]


class Payload(BaseModel):
    model_config = ConfigDict(extra="forbid")


class Roles(Payload):
    long_term: str = Field(min_length=1, max_length=64)
    trading: str = Field(min_length=1, max_length=64)


class Budget(Payload):
    budget: float = Field(gt=0, allow_inf_nan=False)
    reserve_pct: float = Field(ge=0, le=100, allow_inf_nan=False)


class PaperControl(Budget):
    action: Literal["start", "pause", "resume", "end"]


class Confirm(Payload):
    acknowledged: Literal[True]


class Auto(Payload):
    enabled: bool
    connection: str = ""
    acknowledged: bool = False


class Compare(Payload):
    role: Role
    benchmark: str
    period: Literal["1m", "3m", "6m", "1y", "2y"]


class IndiaPlan(Payload):
    strategy: Strategy = "momentum"
    selected: list[str] | None = Field(default=None, max_length=8)
    exits: list[str] | None = Field(default=None, max_length=100)


class EditorRow(Payload):
    symbol: str
    exchange: Literal["NSE", "BSE"]
    status: str
    current_shares: float
    target_shares: float
    sell_shares: float = Field(ge=0, allow_inf_nan=False)
    buy_shares: float = Field(ge=0, allow_inf_nan=False)
    price_inr: float | None = None
    price_as_of: str | None = None


class KiteReview(Payload):
    id: str
    rows: list[EditorRow] = Field(max_length=100)


class Token(Payload):
    request_token: str = Field(min_length=1, max_length=4096)


def allowed_origin(origin, host):
    return origin in {
        f"http://{host}",
        "http://127.0.0.1:5173",
        "http://localhost:5173",
    }


def create_app(service=None):
    service = service or Service()
    csrf = secrets.token_urlsafe(32)

    @asynccontextmanager
    async def lifespan(app):
        service.start()
        try:
            yield
        finally:
            await asyncio.to_thread(service.close)

    app = FastAPI(title="varshan", lifespan=lifespan, docs_url=None, redoc_url=None)
    app.state.service = service
    app.add_middleware(
        TrustedHostMiddleware, allowed_hosts=["127.0.0.1", "localhost", "[::1]"]
    )

    @app.middleware("http")
    async def local_requests(request: Request, call_next):
        if request.url.path.startswith("/api"):
            origin = request.headers.get("origin")
            if (
                origin and not allowed_origin(origin, request.headers.get("host"))
            ) or request.headers.get("sec-fetch-site") == "cross-site":
                return JSONResponse(
                    {"detail": "Use the local varshan application."}, status_code=403
                )
            if request.method not in {
                "GET",
                "HEAD",
                "OPTIONS",
            } and not secrets.compare_digest(
                request.headers.get("x-varshan-token", ""), csrf
            ):
                return JSONResponse(
                    {"detail": "Reload varshan before changing data."}, status_code=403
                )
        response = await call_next(request)
        response.headers["Cache-Control"] = (
            "public, max-age=31536000, immutable"
            if request.url.path.startswith("/assets/")
            else "no-store"
        )
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["Referrer-Policy"] = "no-referrer"
        response.headers["Content-Security-Policy"] = "frame-ancestors 'none'"
        return response

    @app.exception_handler(ValueError)
    @app.exception_handler(RuntimeError)
    @app.exception_handler(OSError)
    async def domain_error(request, exc):
        return JSONResponse({"detail": service.error(exc)}, status_code=400)

    @app.get("/api/health")
    def health():
        return {"status": "ok", "app": "varshan"}

    @app.get("/api/bootstrap")
    def bootstrap():
        return {"token": csrf, "name": "varshan"}

    @app.get("/api/accounts")
    def accounts():
        return service.account_state()

    @app.post("/api/accounts/discover")
    def discover():
        return service.job("accounts", service.available_accounts)

    @app.post("/api/accounts/roles")
    def roles(payload: Roles):
        return service.job(
            "roles", lambda: service.change_roles(payload.long_term, payload.trading)
        )

    @app.post("/api/accounts/sync")
    def sync():
        def perform():
            with service.lock:
                count, omitted = client.sync_long_term_holdings()
                return {"count": count, "omitted": omitted}

        return service.job("sync", perform)

    @app.get("/api/kite/login")
    def kite_login():
        return {"url": reports.kite_login()}

    @app.post("/api/kite/connect")
    def connect(payload: Token):
        return service.job(
            "kite-connect", lambda: reports.connect_kite(payload.request_token)
        )

    @app.get("/api/portfolios")
    def portfolios():
        with service.lock:
            return reports.portfolios()

    @app.get("/api/markets")
    def markets():
        return service.markets()

    @app.post("/api/analysis/{market}")
    def analyze(market: Market):
        def perform():
            with service.analysis_lock:
                return reports.refresh_analysis(market)

        return service.job(f"analysis-{market}", perform)

    @app.get("/api/jobs/{identity}")
    def job(identity: str):
        return service.job_status(identity)

    @app.get("/api/comparisons/{role}")
    def comparison(role: Role):
        return service.comparison(role)

    @app.post("/api/comparisons")
    def compare(payload: Compare):
        return service.job(
            f"comparison-{payload.role}",
            lambda: service.compare(payload.role, payload.benchmark, payload.period),
        )

    @app.get("/api/live")
    def live():
        return service.live_view()

    @app.post("/api/live/refresh")
    def refresh_live():
        return service.job("live-refresh", service.refresh_live)

    @app.post("/api/live/settings")
    def live_settings(payload: Budget):
        return service.set_live_settings(payload.budget, payload.reserve_pct)

    @app.post("/api/live/preview")
    def live_preview():
        return service.job("live-preview", service.preview_live)

    @app.post("/api/live/tickets/reconcile")
    def reconcile_live():
        return service.job("live-reconcile", service.reconcile_live)

    @app.get("/api/kite/batches")
    def kite_batches():
        return reports.clean(list(kite_rebalance.records().values())[-20:][::-1])

    @app.post("/api/live/batches/{identity}/confirm")
    def live_confirm(identity: str, payload: Confirm):
        return service.job(
            f"live-confirm-{identity}",
            lambda: service.confirm_live(identity, payload.acknowledged),
        )

    @app.post("/api/live/automation")
    def automation(payload: Auto):
        return service.set_auto(
            payload.enabled, payload.connection, payload.acknowledged
        )

    @app.get("/api/paper")
    def paper():
        return reports.clean(service.paper_agent().snapshot())

    @app.post("/api/paper/control")
    def paper_control(payload: PaperControl):
        return reports.clean(
            service.paper_control(payload.action, payload.budget, payload.reserve_pct)
        )

    @app.post("/api/india/plan")
    def india_plan(payload: IndiaPlan):
        return service.india_recommendation(
            payload.strategy, payload.selected, payload.exits
        )

    @app.post("/api/kite/draft")
    def kite_draft(payload: IndiaPlan):
        return service.job(
            "kite-draft",
            lambda: service.kite_draft(
                payload.strategy, payload.selected, payload.exits
            ),
        )

    @app.post("/api/kite/review")
    def kite_review(payload: KiteReview):
        return service.job(
            "kite-review",
            lambda: service.kite_review(
                payload.id, [r.model_dump() for r in payload.rows]
            ),
        )

    @app.post("/api/kite/batches/{identity}/confirm")
    def kite_confirm(identity: str, payload: Confirm):
        def perform():
            with service.lock:
                return reports.clean(
                    kite_rebalance.submit(
                        reports.kite_client(),
                        identity,
                        acknowledged=payload.acknowledged,
                    )
                )

        return service.job(f"kite-confirm-{identity}", perform)

    @app.post("/api/kite/batches/{identity}/status")
    def kite_status(identity: str):
        return service.job(
            f"kite-status-{identity}",
            lambda: reports.clean(
                kite_rebalance.refresh_status(reports.kite_client(), identity)
            ),
        )

    @app.websocket("/api/stream")
    async def stream(websocket: WebSocket):
        origin = websocket.headers.get("origin", "")
        if not allowed_origin(origin, websocket.headers.get("host")):
            await websocket.close(code=1008)
            return
        await websocket.accept()
        identity = None
        try:
            hello = await asyncio.wait_for(websocket.receive_json(), timeout=5)
            if not secrets.compare_digest(str(hello.get("token", "")), csrf):
                await websocket.close(code=1008)
                return
            identity = secrets.token_urlsafe(24)
            service.touch(identity)
            await websocket.send_json({"type": "connected", "connection": identity})
            while True:
                message = await asyncio.wait_for(websocket.receive_json(), timeout=20)
                if message.get("type") != "heartbeat":
                    continue
                service.touch(identity, message.get("live") is True)
                # Small notifications invalidate React queries, keeping old values visible.
                await websocket.send_json(
                    {"type": "update", "topics": ["live", "paper", "markets"]}
                )
        except (WebSocketDisconnect, TimeoutError, ValueError):
            pass
        finally:
            if identity:
                await asyncio.to_thread(service.disconnect, identity)

    dist = ROOT / "frontend" / "dist"
    if (dist / "assets").is_dir():
        app.mount("/assets", StaticFiles(directory=dist / "assets"), name="assets")
    app.mount("/brand", StaticFiles(directory=ROOT / "assets"), name="brand")

    @app.get("/{path:path}")
    def frontend(path: str):
        if path.startswith("api/") or path.startswith("assets/"):
            raise HTTPException(404, "Not found")
        if not (dist / "index.html").exists():
            return JSONResponse(
                {
                    "detail": "Build the React UI with run_varshan.sh before starting the app."
                },
                status_code=503,
            )
        return FileResponse(dist / "index.html")

    return app


app = create_app()
