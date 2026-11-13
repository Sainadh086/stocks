import {
  createHash,
  randomBytes,
  randomInt,
  timingSafeEqual,
} from "node:crypto";
import { networkInterfaces, hostname } from "node:os";
import { join } from "node:path";
import type { TLSSocket } from "node:tls";
import type { FastifyRequest } from "fastify";
import { store, US, type Row } from "./shared/storage.js";
export const privateAddress = (value: string) =>
  /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(
    value.replace(/^::ffff:/, ""),
  );
export const loopback = (value: string) =>
  ["127.0.0.1", "::1"].includes(value.replace(/^::ffff:/, ""));
const digest = (value: string) =>
  createHash("sha256").update(value).digest("hex");
export const MOBILE_SESSION_SECONDS = 12 * 60 * 60;
export const mobileHostname = () => {
  const name = hostname()
    .toLowerCase()
    .replace(/\.local$/, "");
  return /^[a-z0-9-]+$/.test(name) ? `${name}.local` : "varshan.local";
};
export class MobileAccess {
  readonly path = join(US, "mobile_devices.json");
  readonly port: number;
  readonly certificatePort: number;
  private pairing: { hash: string; expires: number } | null = null;
  private attempts = new Map<string, { count: number; until: number }>();
  constructor(port = 8443, certificatePort = 8080) {
    this.port = port;
    this.certificatePort = certificatePort;
  }
  addresses() {
    return Object.values(networkInterfaces()).flatMap((rows) =>
      (rows ?? [])
        .filter(
          (r) =>
            r.family === "IPv4" && !r.internal && privateAddress(r.address),
        )
        .map((r) => r.address),
    );
  }
  local(request: FastifyRequest) {
    const host = (request.headers.host ?? "").replace(/:\d+$/, "");
    return (
      loopback(request.ip) && ["localhost", "127.0.0.1", "[::1]"].includes(host)
    );
  }
  permittedHost(host: string) {
    return [
      "localhost",
      "127.0.0.1",
      "[::1]",
      mobileHostname(),
      ...this.addresses(),
    ].includes(host.replace(/:\d+$/, ""));
  }
  secure(request: FastifyRequest) {
    const socket = request.raw.socket as TLSSocket;
    return (
      request.protocol === "https" &&
      socket.authorized === true &&
      !!socket.getPeerCertificate?.().raw
    );
  }
  session(request: FastifyRequest): string | null {
    const cookie = request.headers.cookie
      ?.split(";")
      .map((p) => p.trim())
      .find((p) => p.startsWith("varshan_device="))
      ?.slice("varshan_device=".length);
    if (!cookie || !/^[A-Za-z0-9_-]{43}$/.test(cookie) || !this.secure(request))
      return null;
    const sessions = this.activeSessions();
    const match = sessions.find(
      (row) => row.hash === digest(cookie) && row.expires > Date.now(),
    );
    return match?.hash ?? null;
  }
  authorized(request: FastifyRequest) {
    return this.local(request) || !!this.session(request);
  }
  activeSessions(): Row[] {
    // Apply the new limit to existing seven-day sessions as well.
    return store
      .json<Row[]>(this.path, [])
      .map<Row>((row) => ({
        ...row,
        expires: Math.min(
          Number(row.expires),
          Date.parse(row.created_at) + MOBILE_SESSION_SECONDS * 1000,
        ),
      }))
      .filter((row) => Number.isFinite(row.expires) && row.expires > Date.now())
      .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))
      .slice(0, 1);
  }
  requireAvailableSlot() {
    if (this.activeSessions().length)
      throw new Error(
        "One phone is already connected. Unpair it or revoke phone access on the desktop before connecting another.",
      );
  }
  setup() {
    const session = this.activeSessions()[0];
    return {
      connected: !!session,
      expires_at: session ? new Date(session.expires).toISOString() : null,
      urls: this.addresses().map(
        () => `https://${mobileHostname()}:${this.port}`,
      ),
      setup_urls: this.addresses().map(
        (ip) => `http://${ip}:${this.certificatePort}`,
      ),
      certificate_urls: this.addresses().map(
        (ip) => `http://${ip}:${this.certificatePort}/certificate.cer`,
      ),
      profile_urls: this.addresses().map(
        (ip) => `http://${ip}:${this.certificatePort}/varshan.mobileconfig`,
      ),
    };
  }
  issuePairing() {
    this.requireAvailableSlot();
    this.attempts.clear();
    const code = String(randomInt(100000, 1000000));
    const expires = Date.now() + 5 * 60_000;
    this.pairing = { hash: digest(code), expires };
    return { code, expires_at: new Date(expires).toISOString() };
  }
  pair(code: string, ip: string) {
    const attempt = this.attempts.get(ip);
    if (attempt && attempt.until > Date.now() && attempt.count >= 5)
      throw new Error(
        "Too many attempts. Wait ten minutes or create a new code on the desktop.",
      );
    this.attempts.set(ip, {
      count: attempt && attempt.until > Date.now() ? attempt.count + 1 : 1,
      until: Date.now() + 10 * 60_000,
    });
    if (
      !this.pairing ||
      this.pairing.expires <= Date.now() ||
      !timingSafeEqual(
        Buffer.from(digest(code)),
        Buffer.from(this.pairing.hash),
      )
    )
      throw new Error(
        "Pairing code is incorrect or expired. Generate a fresh code on your desktop.",
      );
    this.requireAvailableSlot();
    this.pairing = null;
    this.attempts.delete(ip);
    const token = randomBytes(32).toString("base64url"),
      hash = digest(token),
      expires = Date.now() + MOBILE_SESSION_SECONDS * 1000;
    store.save(this.path, [
      { hash, expires, created_at: new Date().toISOString() },
    ]);
    return token;
  }
  revokeAll() {
    const owners = store.json<Row[]>(this.path, []).map((s) => String(s.hash));
    store.save(this.path, []);
    this.pairing = null;
    return owners;
  }
  revoke(hash: string) {
    store.save(
      this.path,
      store.json<Row[]>(this.path, []).filter((s) => s.hash !== hash),
    );
  }
}
