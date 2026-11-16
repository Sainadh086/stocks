import { mobileIdentityPackage } from "./mobile-tls.js";
import { themeIds } from "./themes.js";
import Fastify from "fastify";
import fastifyStatic from "@fastify/static";
import websocket from "@fastify/websocket";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { projectRoot } from "./shared/storage.js";
import { Service } from "./service.js";
import { history } from "./shared/prices.js";
import {
  MobileAccess,
  privateAddress,
  loopback,
  MOBILE_SESSION_SECONDS,
} from "./mobile-access.js";
import { Notifications } from "./notifications.js";
import { PhoneVerification } from "./phone-verification.js";
import { MacBiometrics, type BiometricVerifier } from "./biometrics.js";
import type { ServerOptions } from "node:https";
import * as kite from "./brokers/kite.js";
import { indiaTradingIndexNames } from "./trading/india-indices.js";
import { brokerIds } from "./brokers/india.js";
import { selectedBroker, investmentScope } from "./brokers/india-selection.js";
import { scope } from "./brokers/accounts.js";
import {
  learningView,
  learningSettings,
  refreshLearning,
  attributeLearning,
} from "./learning.js";
const strict = <T extends z.ZodRawShape>(shape: T) => z.strictObject(shape);
const budget = {
  budget: z.number().finite().positive(),
  reserve_pct: z.number().finite().min(0).max(100),
};
const confirm = strict({ acknowledged: z.literal(true) }),
  role = z.enum(["India", "long_term", "trading"]),
  strategy = z.enum(["momentum", "weekend_style", "naked_style"]);
const plan = strict({
  strategy: strategy.default("momentum"),
  selected: z.array(z.string()).max(8).optional(),
  exits: z.array(z.string()).max(100).optional(),
});
const editor = strict({
  symbol: z.string(),
  exchange: z.enum(["NSE", "BSE"]),
  status: z.string(),
  current_shares: z.number().finite(),
  target_shares: z.number().finite(),
  sell_shares: z.number().finite().nonnegative(),
  buy_shares: z.number().finite().nonnegative(),
  price_inr: z.number().finite().nullable().optional(),
  price_as_of: z.string().nullable().optional(),
});
export function equalToken(left: unknown, right: string): boolean {
  if (typeof left !== "string") return false;
  const a = Buffer.from(left),
    b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}
export const allowedOrigin = (
  origin: string,
  host: string,
  protocol = "http",
) =>
  [
    ...["http://127.0.0.1:5173", "http://localhost:5173"],
    `${protocol}://${host}`,
  ].includes(origin);
export interface AppOptions {
  biometrics?: BiometricVerifier;
  access?: MobileAccess;
  notifications?: Notifications;
  https?: ServerOptions;
  manageService?: boolean;
  mobileIdentity?: typeof mobileIdentityPackage;
}
export async function createApp(
  service = new Service(),
  options: AppOptions = {},
) {
  const app = Fastify({
      logger: false,
      bodyLimit: 128 * 1024,
      ...(options.https ? { https: options.https } : {}),
    }),
    token = randomBytes(32).toString("base64url");
  const biometrics = options.biometrics ?? new MacBiometrics();
  const phoneVerification = new PhoneVerification();
  const phoneOrigin = (request: Parameters<MobileAccess["local"]>[0]) =>
    `${request.protocol}://${request.headers.host}`;
  app.addHook("onRequest", async (request, reply) => {
    const host = request.headers.host ?? "",
      hostname = host.replace(/:\d+$/, "");
    if (
      !(options.access
        ? options.access.permittedHost(host)
        : ["localhost", "127.0.0.1", "[::1]"].includes(hostname))
    )
      return reply
        .code(400)
        .send({ detail: "Use the local varshan application." });
    if (
      options.access &&
      !options.access.local(request) &&
      !privateAddress(request.ip) &&
      !loopback(request.ip)
    )
      return reply
        .code(403)
        .send({ detail: "Connect through the same private Wi-Fi network." });
    if (
      options.access &&
      !options.access.local(request) &&
      !options.access.secure(request)
    )
      return reply.code(403).send({
        detail:
          "Install the phone identity certificate and connect through the secure HTTPS address.",
      });
    const path = request.url.split("?")[0];
    if (
      options.access &&
      request.url.startsWith("/api") &&
      !["/api/access/status", "/api/access/pair", "/api/health"].includes(
        path,
      ) &&
      !options.access.authorized(request)
    )
      return reply.code(401).send({
        detail: "Pair this device from your desktop to open Varshan.",
      });
    if (request.url.startsWith("/api")) {
      const origin = request.headers.origin;
      if (
        (origin && !allowedOrigin(origin, host, request.protocol)) ||
        request.headers["sec-fetch-site"] === "cross-site"
      )
        return reply
          .code(403)
          .send({ detail: "Use the local varshan application." });
      if (
        path !== "/api/access/pair" &&
        !["GET", "HEAD", "OPTIONS"].includes(request.method) &&
        !equalToken(request.headers["x-varshan-token"], token)
      )
        return reply
          .code(403)
          .send({ detail: "Reload varshan before changing data." });
    }
  });
  app.addHook("onSend", async (request, reply, payload) => {
    reply
      .header(
        "Cache-Control",
        request.url.startsWith("/assets/")
          ? "public, max-age=31536000, immutable"
          : "no-store",
      )
      .header("X-Content-Type-Options", "nosniff")
      .header("Referrer-Policy", "no-referrer")
      .header("Content-Security-Policy", "frame-ancestors 'none'");
    return payload;
  });
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof z.ZodError)
      return reply.code(422).send({
        detail: error.issues
          .map((i) => `${i.path.join(".")}: ${i.message}`)
          .join("; "),
      });
    return reply
      .code((error as { statusCode?: number }).statusCode ?? 400)
      .send({ detail: service.error(error) });
  });
  await app.register(websocket, { options: { maxPayload: 16384 } });
  app.get("/api/health", () => ({ status: "ok", app: "varshan" }));
  app.get("/api/access/status", (request) => ({
    authenticated: !options.access || options.access.authorized(request),
    local: !options.access || options.access.local(request),
    secure: request.protocol === "https",
    cache_id: options.access?.session(request) ?? null,
    expires_at: options.access?.session(request)
      ? new Date(options.access.activeSessions()[0].expires).toISOString()
      : null,
  }));
  app.post("/api/phone-verification/options", (request) => {
    strict({}).parse(request.body);
    const owner = options.access?.session(request);
    if (!owner)
      throw new Error("Pair this phone before setting up device verification.");
    return phoneVerification.options(owner, phoneOrigin(request));
  });
  app.post("/api/phone-verification/verify", (request) => {
    const p = strict({ id: z.string().max(100), response: z.unknown() }).parse(
      request.body,
    );
    const owner = options.access?.session(request);
    if (!owner) throw new Error("Pair this phone before verifying.");
    return phoneVerification.verify(
      owner,
      phoneOrigin(request),
      p.id,
      p.response,
    );
  });
  app.post("/api/access/pair", (request, reply) => {
    if (!options.access || !options.access.secure(request))
      throw new Error(
        "Install the phone identity certificate and use the HTTPS mobile address shown on your desktop.",
      );
    const { code } = strict({ code: z.string().regex(/^\d{6}$/) }).parse(
      request.body,
    );
    const session = options.access.pair(code, request.ip);
    reply.header(
      "Set-Cookie",
      `varshan_device=${session}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${MOBILE_SESSION_SECONDS}`,
    );
    return { authenticated: true };
  });
  app.get("/api/mobile/setup", (request) => {
    if (!options.access?.local(request))
      throw new Error("Open mobile setup on the desktop running Varshan.");
    return options.access.setup();
  });
  app.post("/api/mobile/identity", async (request) => {
    strict({}).parse(request.body);
    if (!options.access?.local(request))
      throw new Error(
        "Download phone certificates only on the desktop running Varshan.",
      );
    await biometrics.verify("pair");
    return (options.mobileIdentity ?? mobileIdentityPackage)();
  });
  app.post("/api/mobile/pairing", async (request) => {
    strict({}).parse(request.body);
    if (!options.access?.local(request))
      throw new Error("Generate pairing codes on the desktop running Varshan.");
    options.access.requireAvailableSlot();
    await biometrics.verify("pair");
    return options.access.issuePairing();
  });
  app.post("/api/mobile/revoke", (request) => {
    strict({}).parse(request.body);
    if (!options.access?.local(request))
      throw new Error("Revoke mobile access from the desktop running Varshan.");
    for (const owner of options.access.revokeAll())
      options.notifications?.removeOwner(owner);
    return { revoked: true };
  });
  app.post("/api/access/logout", (request, reply) => {
    strict({}).parse(request.body);
    const owner = options.access?.session(request);
    if (owner) {
      options.access!.revoke(owner);
      options.notifications?.removeOwner(owner);
    }
    reply.header(
      "Set-Cookie",
      "varshan_device=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0",
    );
    return { authenticated: false };
  });
  const notificationOwner = (request: Parameters<MobileAccess["local"]>[0]) =>
    options.access?.local(request) || !options.access
      ? "desktop"
      : options.access.session(request)!;
  app.get(
    "/api/notifications",
    () =>
      options.notifications?.status() ?? {
        public_key: null,
        devices: 0,
        events: [],
        delivery_error: null,
      },
  );
  app.post("/api/notifications/subscribe", (request) => {
    const p = strict({
      endpoint: z.string().url().max(2048),
      expirationTime: z.number().nullable().optional(),
      keys: strict({
        p256dh: z.string().min(40).max(200),
        auth: z.string().min(16).max(100),
      }),
    }).parse(request.body);
    if (!options.notifications)
      throw new Error("Restart Varshan to enable notifications.");
    options.notifications.subscribe(p, notificationOwner(request));
    return { subscribed: true };
  });
  app.post("/api/notifications/unsubscribe", (request) => {
    const p = strict({ endpoint: z.string().url().max(2048) }).parse(
      request.body,
    );
    options.notifications?.unsubscribe(p.endpoint, notificationOwner(request));
    return { subscribed: false };
  });
  app.post("/api/notifications/test", (request) => {
    strict({}).parse(request.body);
    return options.notifications?.test(notificationOwner(request));
  });
  app.get("/api/bootstrap", () => ({ token, name: "varshan" }));
  app.get("/api/accounts", () => service.accountState());
  app.get("/api/india/trading", () => service.india.view());
  app.post("/api/india/broker", (request) => {
    const p = strict({ broker: z.enum(brokerIds) }).parse(request.body);
    return service.job("india-broker", () => service.india.select(p.broker));
  });
  app.post("/api/india/trading/broker", (request) => {
    const p = strict({ broker: z.enum(brokerIds) }).parse(request.body);
    return service.job("india-broker", () => service.india.select(p.broker));
  });
  app.post("/api/india/trading/connect", (request) => {
    const p = strict({
      broker: z.enum(["upstox", "groww"]),
      access_token: z.string().min(1).max(8192).regex(/^\S+$/),
    }).parse(request.body);
    return service.job("india-connect", () =>
      service.india.connect(p.broker, p.access_token),
    );
  });
  app.post("/api/india/trading/settings", (request) => {
    const p = strict({
      ...budget,
      selection_mode: z.enum(["automatic", "manual"]).default("automatic"),
      index: z.enum(indiaTradingIndexNames).default("Nifty 100"),
      expected_revision: z.number().int().nonnegative().optional(),
      expected_scope: z
        .string()
        .regex(/^[a-f0-9]{20}$/)
        .optional(),
      expected_broker: z.enum(brokerIds).optional(),
      symbols: z
        .array(z.string().regex(/^[A-Z0-9][A-Z0-9&.\-]{0,29}$/))
        .max(20)
        .default([]),
    }).parse(request.body);
    const { expected_revision, expected_scope, expected_broker, ...settings } =
      p;
    return service.job(
      "india-settings-" + randomBytes(12).toString("hex"),
      () =>
        service.india.configure(settings, {
          revision: expected_revision,
          scope: expected_scope,
          broker: expected_broker,
        }),
    );
  });
  app.post("/api/india/trading/refresh", (request) => {
    strict({}).parse(request.body);
    return service.job("india-refresh", () => service.india.refresh());
  });
  app.post("/api/india/trading/preview", (request) => {
    const p = strict({
      symbol: z.string().regex(/^[A-Z0-9][A-Z0-9&.\-]{0,29}$/),
      side: z.enum(["buy", "sell"]),
      expected_scope: z
        .string()
        .regex(/^[a-f0-9]{20}$/)
        .optional(),
      expected_revision: z.number().int().nonnegative().optional(),
      expected_broker: z.enum(brokerIds).optional(),
    }).parse(request.body);
    return service.job(
      `india-preview:${p.symbol}:${p.side}:${p.expected_scope ?? "current"}`,
      () =>
        service.india.preview(p.symbol, p.side, {
          scope: p.expected_scope,
          revision: p.expected_revision,
          broker: p.expected_broker,
        }),
    );
  });
  app.post<{ Params: { id: string } }>(
    "/api/india/trading/orders/:id/confirm",
    (request) => {
      const p = confirm.parse(request.body);
      return service.job("india-confirm-" + request.params.id, () =>
        service.india.confirm(request.params.id, p.acknowledged),
      );
    },
  );
  app.post<{ Params: { id: string } }>(
    "/api/india/trading/orders/:id/cancel",
    (request) => {
      const p = confirm.parse(request.body);
      return service.job("india-cancel-" + request.params.id, () =>
        service.india.cancel(request.params.id, p.acknowledged),
      );
    },
  );
  app.post("/api/india/trading/automation", (request) => {
    const p = strict({
      enabled: z.boolean(),
      acknowledged: z.boolean().default(false),
    }).parse(request.body);
    return service.job("india-automation", () =>
      service.india.setAuto(p.enabled, p.acknowledged),
    );
  });
  app.post("/api/accounts/discover", () =>
    service.job("accounts", () => service.availableAccounts()),
  );
  app.post("/api/accounts/roles", (request) => {
    const p = strict({
      long_term: z.string().min(1).max(64),
      trading: z.string().min(1).max(64),
    }).parse(request.body);
    return service.job("roles", () =>
      service.changeRoles(p.long_term, p.trading),
    );
  });
  app.post("/api/accounts/sync", () =>
    service.job("sync", () => service.sync()),
  );
  const workspacePage = z.enum([
    "holdings",
    "recommendations",
    "replacements",
    "weekly",
    "trading",
    "india-trading",
    "benchmark",
    "learning",
  ]);
  const kiteReturns = new Map<string, { page: string; expires: number }>();
  app.get<{ Querystring: { return_page?: string } }>(
    "/api/kite/login",
    (request) => {
      const page = workspacePage.parse(request.query.return_page ?? "holdings");
      for (const [key, pending] of kiteReturns)
        if (pending.expires <= Date.now()) kiteReturns.delete(key);
      if (kiteReturns.size >= 100)
        throw new Error(
          "Too many pending Kite logins. Complete the existing login first.",
        );
      const state = randomBytes(32).toString("base64url");
      kiteReturns.set(state, { page, expires: Date.now() + 10 * 60_000 });
      return {
        url: kite.login({
          varshan_kite_state: state,
          varshan_return_page: page,
        }),
      };
    },
  );
  app.post("/api/kite/callback", (request) => {
    const input = strict({
      request_token: z.string().min(1).max(4096),
      state: z.string().min(1).max(100),
    }).parse(request.body);
    const pending = kiteReturns.get(input.state);
    if (!pending || pending.expires <= Date.now())
      throw new Error(
        "Kite login expired or was already completed. Start a new Kite login from Account settings.",
      );
    kiteReturns.delete(input.state);
    return service.job(`kite-callback-${input.state}`, async () => ({
      ...(await kite.connect(input.request_token)),
      return_page: pending.page,
    }));
  });
  app.post("/api/kite/connect", (request) => {
    const p = strict({ request_token: z.string().min(1).max(4096) }).parse(
      request.body,
    );
    return service.job("kite-connect", () => kite.connect(p.request_token));
  });
  app.get("/api/portfolios", () => service.portfolios());
  app.get("/api/markets", () => service.markets());
  app.get("/api/indices", () => service.indices());
  app.get<{ Params: { symbol: string }; Querystring: { period?: string } }>(
    "/api/charts/:symbol",
    async (request) => {
      const symbol = z
        .string()
        .max(40)
        .regex(/^[A-Za-z0-9.^:_-]+$/)
        .parse(request.params.symbol);
      const period = z
        .enum(["1m", "3m", "6m", "1y"])
        .parse(request.query.period ?? "3m");
      const result = await history(symbol, period);
      return { ...result, symbol };
    },
  );
  app.get("/api/preferences", () => service.preferences());
  app.post("/api/preferences", async (request) => {
    const p = strict({
      top_benchmarks: z.array(z.string()).min(1).max(6).optional(),
      privacy_mode: z.boolean().optional(),
      verification: z.string().max(100).optional(),
      chart_provider: z.enum(["yahoo", "tradingview"]).optional(),
      chart_view: z.enum(["external", "embedded"]).optional(),
      theme: z.enum(themeIds).optional(),
    })
      .refine((p) => Object.keys(p).length > 0)
      .parse(request.body);
    if (p.privacy_mode === false) {
      const owner = options.access?.session(request);
      if (owner && !options.access?.local(request))
        phoneVerification.consume(owner, phoneOrigin(request), p.verification);
      else if (service.preferences().privacy_mode === true)
        await biometrics.verify("privacy");
    }
    const { verification: _verification, ...patch } = p;
    return service.savePreferences(patch);
  });
  app.get<{ Params: { role: string } }>("/api/weekly/:role", (request) =>
    service.weekly(role.parse(request.params.role)),
  );
  app.post<{ Params: { role: string } }>("/api/weekly/:role", (request) => {
    strict({}).parse(request.body);
    const selected = role.parse(request.params.role);
    return service.job("weekly-" + selected, () =>
      service.refreshWeekly(selected),
    );
  });
  app.post<{ Params: { market: string } }>(
    "/api/analysis/:market/gems",
    (request) => {
      const market = z.enum(["India", "US"]).parse(request.params.market);
      return service.job("gems-" + market, () => service.analyzeGems(market));
    },
  );
  app.get("/api/us/gems/plan", () => service.usGemsPlan());
  app.get("/api/learning/settings", () => learningSettings());
  app.post("/api/learning/settings", (request) => {
    const p = strict({ execution_enabled: z.boolean() }).parse(request.body);
    return service.setLearningExecution(p.execution_enabled);
  });
  app.get<{ Querystring: { bucket?: string; market?: string } }>(
    "/api/learning",
    (request) =>
      learningView(
        request.query.bucket,
        z.enum(["India", "US"]).optional().parse(request.query.market),
      ),
  );
  app.post("/api/learning/train", (request) => {
    const p = strict({ bucket: z.string().min(1).max(200) }).parse(
      request.body,
    );
    return refreshLearning(p.bucket);
  });
  app.post("/api/learning/attribute", (request) => {
    const p = strict({
      key: z.string().min(1).max(300),
      strategy: z.enum([
        "gems",
        "momentum",
        "weekend_style",
        "naked_style",
        "intraday_rotation_v1",
        "orb_15m_v1",
      ]),
      reason: z.string().trim().min(10).max(2000),
    }).parse(request.body);
    return attributeLearning(p.key, p.strategy, p.reason);
  });
  app.post("/api/us/gems/plan", (request) => {
    const p = strict({
      ...budget,
      budget: z.number().finite().positive().max(1e9),
    }).parse(request.body);
    return service.saveUsGemsPlan(p.budget, p.reserve_pct);
  });
  app.post("/api/us/gems/reviews", (request) => {
    const notes = z.string().trim().min(20).max(4000);
    const p = strict({
      symbol: z.string().regex(/^[A-Z0-9-]{1,30}$/),
      policy_notes: notes,
      management_notes: notes,
      vision_notes: notes,
      source_urls: z
        .array(
          z
            .url()
            .refine(
              (url) => new URL(url).protocol === "https:",
              "Use HTTPS source links",
            ),
        )
        .min(1)
        .max(5),
      acknowledged: z.literal(true),
    }).parse(request.body);
    return service.saveGemsReview(p);
  });
  app.post<{ Params: { market: string } }>(
    "/api/analysis/:market",
    (request) => {
      const market = z.enum(["India", "US"]).parse(request.params.market);
      return service.job("analysis-" + market, () => service.analyze(market));
    },
  );
  app.get<{ Params: { id: string } }>("/api/jobs/:id", (request) =>
    service.jobStatus(request.params.id),
  );
  app.get<{ Params: { role: string } }>("/api/comparisons/:role", (request) =>
    service.comparison(role.parse(request.params.role)),
  );
  app.post("/api/comparisons", (request) => {
    const p = strict({
      role,
      benchmark: z.string().optional(),
      benchmarks: z.array(z.string()).min(1).max(6).optional(),
      period: z.enum(["1m", "3m", "6m", "1y", "2y"]),
    })
      .refine(
        (body) => Boolean(body.benchmark) !== Boolean(body.benchmarks),
        "Choose benchmark or benchmarks, not both",
      )
      .parse(request.body);
    return service.job("comparison-" + p.role, () =>
      service.compare(p.role, p.benchmarks ?? p.benchmark!, p.period),
    );
  });
  app.get("/api/live", () => service.liveView());
  app.post("/api/live/refresh", () =>
    service.job("live-refresh", () => service.refreshLive()),
  );
  app.post("/api/live/settings", (request) => {
    const p = strict(budget).parse(request.body);
    return service.setSettings(p.budget, p.reserve_pct);
  });
  app.post("/api/live/preview", (request) => {
    const p = strict({
      symbol: z
        .string()
        .regex(/^[A-Z][A-Z0-9.-]{0,14}$/)
        .optional(),
      expected_scope: z
        .string()
        .regex(/^[a-f0-9]{20}$/)
        .optional(),
    }).parse(request.body ?? {});
    return service.job(
      `live-preview:${p.symbol ?? "rebalance"}:${p.expected_scope ?? "current"}`,
      () => service.previewLive(p.symbol, p.expected_scope),
    );
  });
  app.post("/api/live/tickets/reconcile", () =>
    service.job("live-reconcile", () => service.reconcileLive()),
  );
  app.post<{ Params: { id: string } }>(
    "/api/live/tickets/:id/link",
    (request) => {
      const p = strict({
        order_id: z.string().min(1).max(100),
        acknowledged: z.literal(true),
      }).parse(request.body);
      return service.job(
        `live-link-order:${request.params.id}:${p.order_id}`,
        () =>
          service.linkLiveOrder(request.params.id, p.order_id, p.acknowledged),
      );
    },
  );
  app.post<{ Params: { id: string } }>(
    "/api/live/batches/:id/confirm",
    (request) => {
      const p = confirm.parse(request.body);
      return service.job("live-confirm-" + request.params.id, () =>
        service.confirmLive(request.params.id, p.acknowledged),
      );
    },
  );
  app.post("/api/live/automation", (request) => {
    const p = strict({
      enabled: z.boolean(),
      connection: z.string().default(""),
      acknowledged: z.boolean().default(false),
      background: z.boolean().default(false),
    }).parse(request.body);
    return service.setAuto(
      p.enabled,
      p.connection,
      p.acknowledged,
      p.background,
    );
  });
  app.get("/api/paper", () => service.paper());
  app.post("/api/paper/control", (request) => {
    const p = strict({
      ...budget,
      action: z.enum(["start", "pause", "resume", "end"]),
    }).parse(request.body);
    return service.paperControl(p.action, p.budget, p.reserve_pct);
  });
  app.post("/api/india/plan", (request) => {
    const p = plan.parse(request.body);
    return service.indiaRecommendation(p.strategy, p.selected, p.exits);
  });
  for (const base of ["/api/india/investing", "/api/kite"]) {
    app.post(`${base}/draft`, (request) => {
      const p = plan.parse(request.body);
      return service.job("kite-draft", () =>
        service.kiteDraft(p.strategy, p.selected, p.exits),
      );
    });
    app.post(`${base}/review`, (request) => {
      const p = strict({
        id: z.string(),
        rows: z.array(editor).max(100),
      }).parse(request.body);
      return service.job("kite-review", () => service.kiteReview(p.id, p.rows));
    });
    app.get(`${base}/batches`, () =>
      Object.values(kite.batches())
        .filter(
          (b) =>
            (b.broker ?? "kite") === selectedBroker() &&
            scope((b.broker ?? "kite") + ":" + b.user) === investmentScope(),
        )
        .slice(-20)
        .reverse(),
    );
    app.post<{ Params: { id: string } }>(
      `${base}/batches/:id/confirm`,
      (request) => {
        const p = confirm.parse(request.body);
        return service.job("kite-confirm-" + request.params.id, () =>
          kite.submit(request.params.id, p.acknowledged),
        );
      },
    );
    app.post<{ Params: { id: string } }>(
      `${base}/batches/:id/status`,
      (request) =>
        service.job("kite-status-" + request.params.id, () =>
          kite.refreshStatus(request.params.id),
        ),
    );
  }
  app.get("/api/stream", { websocket: true }, (socket, request) => {
    if (
      !allowedOrigin(
        request.headers.origin ?? "",
        request.headers.host ?? "",
        request.protocol,
      )
    ) {
      socket.close(1008);
      return;
    }
    let id: string | null = null;
    let unsubscribe: (() => void) | undefined;
    let updateTimer: NodeJS.Timeout | undefined;
    const changedTopics = new Set<string>();
    let timer = setTimeout(() => socket.close(1008), 5000);
    socket.on("message", (raw) => {
      try {
        if (options.access && !options.access.authorized(request)) {
          socket.close(1008);
          return;
        }
        const msg = JSON.parse(raw.toString());
        if (!id) {
          if (!equalToken(msg.token, token)) {
            socket.close(1008);
            return;
          }
          id = randomBytes(24).toString("base64url");
          service.touch(id);
          socket.send(JSON.stringify({ type: "connected", connection: id }));
          unsubscribe = service.subscribeLive((topic) => {
            // Coalesce changes within a workflow and avoid buffering updates
            // for a slow client. Clients fetch the latest snapshot on receipt.
            if (socket.readyState !== 1 || socket.bufferedAmount > 65536)
              return;
            changedTopics.add(topic);
            if (updateTimer) return;
            updateTimer = setTimeout(() => {
              updateTimer = undefined;
              if (options.access && !options.access.authorized(request)) {
                socket.close(1008);
                return;
              }
              if (socket.readyState === 1)
                socket.send(
                  JSON.stringify({
                    type: "update",
                    topics: [...changedTopics],
                  }),
                );
              changedTopics.clear();
            }, 40);
          });
        } else if (msg.type === "heartbeat") {
          service.touch(id, msg.live === true);
          socket.send(
            JSON.stringify({
              type: "update",
              topics: ["live", "paper", "markets"],
            }),
          );
        }
        clearTimeout(timer);
        timer = setTimeout(() => socket.close(1008), 20000);
      } catch {
        socket.close(1008);
      }
    });
    socket.on("close", () => {
      unsubscribe?.();
      clearTimeout(updateTimer);
      clearTimeout(timer);
      if (id) service.disconnect(id);
    });
    socket.on("error", () => {
      unsubscribe?.();
      clearTimeout(updateTimer);
      if (id) service.disconnect(id);
    });
  });
  const dist = join(projectRoot, "frontend/dist");
  if (existsSync(join(dist, "assets")))
    await app.register(fastifyStatic, {
      root: join(dist, "assets"),
      prefix: "/assets/",
    });
  await app.register(fastifyStatic, {
    root: join(projectRoot, "assets"),
    prefix: "/brand/",
    decorateReply: !app.hasReplyDecorator("sendFile"),
  });
  for (const file of ["sw.js", "manifest.webmanifest"])
    app.get("/" + file, (_request, reply) =>
      reply
        .type(
          file.endsWith("js")
            ? "application/javascript"
            : "application/manifest+json",
        )
        .sendFile(file, dist),
    );
  if (existsSync(join(dist, "icons")))
    await app.register(fastifyStatic, {
      root: join(dist, "icons"),
      prefix: "/icons/",
      decorateReply: false,
    });
  app.setNotFoundHandler((request, reply) => {
    if (
      request.url.startsWith("/api") ||
      request.url.startsWith("/assets") ||
      request.url.startsWith("/brand")
    )
      return reply.code(404).send({ detail: "Not found" });
    if (!existsSync(join(dist, "index.html")))
      return reply
        .code(503)
        .send({ detail: "Build the React UI with run_varshan.sh first." });
    return reply.sendFile("index.html", dist);
  });
  if (options.manageService !== false) {
    app.addHook("onReady", () => service.start());
    app.addHook("onClose", () => service.close());
  }
  return app;
}
