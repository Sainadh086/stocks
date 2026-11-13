import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { queryClient, request, useAction, useData } from "./api";
import { Card, Failure, Notice } from "./components";
import { QRCodeSVG } from "qrcode.react";
import { clearMobileCache, startMobileCache } from "./mobile-cache";

export function pairingCodeFromHash(hash: string) {
  const value = new URLSearchParams(hash.replace(/^#/, "")).get("pair");
  return value && /^\d{6}$/.test(value) ? value : "";
}
interface Access {
  authenticated: boolean;
  local: boolean;
  secure: boolean;
  cache_id?: string | null;
  expires_at?: string | null;
}
export function AccessGate({ children }: { children: ReactNode }) {
  const status = useData<Access>("access", "/access/status", 30000);
  const [code, setCode] = useState(() =>
    pairingCodeFromHash(window.location.hash),
  );
  const [error, setError] = useState<Error | null>(null);
  const [pending, setPending] = useState(false);
  const previous = useRef(false);
  const [hydrated, setHydrated] = useState<string | null>(null);
  useEffect(() => {
    const scope = status.data?.cache_id;
    if (!scope || !status.data?.authenticated || status.data.local) return;
    let cancelled = false;
    let stop: (() => void) | undefined;
    void startMobileCache(
      queryClient,
      scope,
      Date.parse(status.data.expires_at ?? ""),
    )
      .then((cleanup) => {
        if (cancelled) cleanup();
        else {
          stop = cleanup;
          setHydrated(scope);
        }
      })
      .catch(() => {
        if (!cancelled) setHydrated(scope);
      });
    return () => {
      cancelled = true;
      stop?.();
    };
  }, [
    status.data?.cache_id,
    status.data?.expires_at,
    status.data?.authenticated,
    status.data?.local,
  ]);
  useEffect(() => {
    if (pairingCodeFromHash(window.location.hash))
      window.history.replaceState(
        null,
        "",
        window.location.pathname + window.location.search,
      );
  }, []);
  useEffect(() => {
    if (status.data?.authenticated === false) void clearMobileCache();
    if (previous.current && status.data?.authenticated === false) {
      queryClient.clear();
      void clearMobileCache();
    }
    previous.current = status.data?.authenticated ?? false;
  }, [status.data?.authenticated]);
  async function pair() {
    if (!status.data?.secure || !window.isSecureContext) {
      setError(
        new Error(
          "Install and trust the certificates before pairing through HTTPS.",
        ),
      );
      return;
    }
    setPending(true);
    setError(null);
    try {
      const response = await fetch("/api/access/pair", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code }),
      });
      const result = await response.json();
      if (!response.ok)
        throw new Error(result.detail ?? "Pairing could not complete.");
      setCode("");
      queryClient.clear();
      await status.refetch();
    } catch (e) {
      setError(
        e instanceof Error ? e : new Error("Pairing could not complete."),
      );
    } finally {
      setPending(false);
    }
  }
  if (status.data?.authenticated) {
    if (
      status.data.cache_id &&
      !status.data.local &&
      hydrated !== status.data.cache_id
    )
      return (
        <main className="pairing-screen">
          <Notice>Restoring your saved mobile workspace…</Notice>
        </main>
      );
    return <>{children}</>;
  }
  return (
    <main className="pairing-screen">
      <div className="pairing-brand">
        <img src="/brand/varshan-logo.svg" alt="" />
        <h1>varshan</h1>
      </div>
      <Card
        title={
          status.isPending ? "Connecting to your workspace" : "Pair your phone"
        }
        subtitle="Your portfolio and trading controls stay private on your Wi-Fi network."
      >
        <Failure error={status.error || error} />
        {status.isPending ? (
          <Notice>Checking device access…</Notice>
        ) : (
          <>
            <p>
              On the computer running Varshan, open Account settings → Mobile
              access and generate a six-digit pairing code.
            </p>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void pair();
              }}
            >
              <label>
                Pairing code
                <input
                  type="password"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  aria-label="Pairing code"
                  value={code}
                  maxLength={6}
                  onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
                />
              </label>
              <button
                className="primary"
                disabled={
                  pending ||
                  code.length !== 6 ||
                  !status.data?.secure ||
                  !window.isSecureContext
                }
              >
                {pending ? "Pairing…" : "Open my workspace"}
              </button>
            </form>
            <p className="footnote">
              Use the HTTPS address shown on your desktop. Install and trust the
              local certificate on your phone before pairing.
            </p>
          </>
        )}
      </Card>
    </main>
  );
}
export function MobileSettings() {
  const status = useData<Access>("access", "/access/status");
  const setup = useData<{
    urls: string[];
    setup_urls: string[];
    certificate_urls: string[];
    profile_urls: string[];
    connected: boolean;
    expires_at: string | null;
  }>("mobile-setup", "/mobile/setup", 30000, status.data?.local === true);
  const code = useAction(
    () => request<{ code: string; expires_at: string }>("/mobile/pairing", {}),
    [],
  );
  const identity = useAction(async () => {
    const result = await request<{ package: string; password: string }>(
      "/mobile/identity",
      {},
    );
    const bytes = Uint8Array.from(atob(result.package), (char) =>
      char.charCodeAt(0),
    );
    const url = URL.createObjectURL(
      new Blob([bytes], { type: "application/x-pkcs12" }),
    );
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "varshan-phone-identity.p12";
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    return { password: result.password };
  }, []);
  const revoke = useAction(
    () => request("/mobile/revoke", {}),
    ["mobile-setup"],
  );
  const logout = useAction(() => request("/access/logout", {}), ["access"]);
  if (status.data?.local === false)
    return (
      <Card title="This phone">
        <p>
          This device is paired with your private Varshan server. Access expires
          after 12 hours from pairing; pair again when prompted. Privacy unlocks
          use this phone’s Face ID, fingerprint or device lock. Cached analysis
          is encrypted on this phone and refreshed from the backend.
        </p>
        <button onClick={() => logout.mutate()} disabled={logout.isPending}>
          Unpair this device
        </button>
        <Failure error={logout.error} />
      </Card>
    );
  return (
    <Card
      title="Mobile access"
      subtitle="Open Varshan on iPhone or Android while connected to the same Wi-Fi."
    >
      <Failure
        error={setup.error || code.error || revoke.error || identity.error}
      />
      <Notice>
        A phone identity certificate is required before the HTTPS app can
        connect. A pairing code alone cannot grant access.
      </Notice>
      <div className="identity-download">
        <strong>Phone identity · required</strong>
        <p>
          Download on this Mac, transfer the file to your phone with AirDrop or
          USB, and install it as an identity certificate. Keep the public CA
          installed and trusted too.
        </p>
        <button disabled={identity.isPending} onClick={() => identity.mutate()}>
          {identity.isPending
            ? "Waiting for Touch ID on your Mac…"
            : "Download phone identity certificate"}
        </button>
        {identity.data && (
          <label>
            Certificate import password
            <input
              readOnly
              type="password"
              value={identity.data.password}
              onFocus={(event) => event.currentTarget.select()}
            />
            <button
              onClick={() =>
                void navigator.clipboard.writeText(identity.data!.password)
              }
            >
              Copy import password
            </button>
          </label>
        )}
      </div>
      {setup.data?.urls.map((url, i) => (
        <div key={url} className="mobile-address">
          <strong>Phone address</strong>
          {setup.data?.setup_urls?.[i] && (
            <div className="phone-qr">
              <QRCodeSVG
                value={setup.data.setup_urls[i]}
                size={160}
                marginSize={4}
                title="Scan to install the phone certificate"
                role="img"
                aria-label="Scan to install the phone certificate"
              />
              <div>
                <strong>1. Scan for phone setup</strong>
                <p>
                  Install and trust the certificate, then return here for your
                  pairing QR.
                </p>
                <a
                  href={setup.data.setup_urls[i]}
                  target="_blank"
                  rel="noreferrer"
                >
                  Phone setup guide
                </a>
              </div>
            </div>
          )}
          <a href={url} target="_blank" rel="noreferrer">
            {url}
          </a>
          <a href={setup.data?.profile_urls?.[i]}>
            Install iPhone certificate profile
          </a>
          <a href={setup.data?.certificate_urls[i]} download>
            Download Android CA certificate
          </a>
        </div>
      ))}
      <ol className="mobile-steps">
        <li>
          Download the public certificate on each phone. On iPhone, install the
          profile in Safari, install under Settings → General → VPN & Device
          Management, then enable trust under Settings → General → About →
          Certificate Trust Settings. On Android, install it as a CA certificate
          in Security settings using CA certificate, rather than VPN/app
          certificate.
        </li>
        <li>
          Install the password-protected phone identity from this Mac. On
          iPhone, install it in Settings → General → VPN & Device Management; on
          Android, choose a VPN/app identity certificate. Then open the HTTPS
          address, select the identity if prompted, and enter a pairing code
          from this desktop.
        </li>
        <li>
          For iPhone notifications, use Share → Add to Home Screen and open that
          app. On Android, open in Chrome or install the app.
        </li>
      </ol>
      {setup.data?.connected && (
        <Notice>
          One phone is connected. Access expires at{" "}
          {new Date(setup.data.expires_at!).toLocaleString()}. Revoke its access
          before pairing another phone.
        </Notice>
      )}
      <button
        onClick={() => code.mutate()}
        disabled={code.isPending || setup.data?.connected}
      >
        {code.isPending
          ? "Waiting for Touch ID on your Mac…"
          : "Generate pairing code"}
      </button>
      <p className="footnote">
        Creating a pairing QR requires your fingerprint on this Mac. Each code
        works once and expires in five minutes.
      </p>
      <button
        disabled={revoke.isPending}
        onClick={() =>
          revoke.mutate(undefined, { onSuccess: () => code.reset() })
        }
      >
        Revoke all phone access
      </button>
      {revoke.isSuccess && (
        <Notice>
          Phone access and phone notification subscriptions revoked.
        </Notice>
      )}
      {code.data && setup.data?.urls[0] && (
        <PairingQR
          code={code.data.code}
          expires={code.data.expires_at}
          url={setup.data.urls[0]}
        />
      )}
    </Card>
  );
}
function PairingQR({
  code,
  expires,
  url,
}: {
  code: string;
  expires: string;
  url: string;
}) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  if (now >= Date.parse(expires))
    return (
      <Notice>Pairing QR expired. Generate a fresh code with Touch ID.</Notice>
    );
  return (
    <div className="phone-qr pairing-qr">
      <QRCodeSVG
        value={`${url}/#pair=${code}`}
        size={192}
        marginSize={4}
        title="Scan to pair your phone with Varshan"
        role="img"
        aria-label="Scan to pair your phone with Varshan"
      />
      <div>
        <strong>2. Scan to connect your phone</strong>
        <p>
          Your code is filled in automatically. Tap Open my workspace on the
          phone.
        </p>
        <strong className="pair-code">{code}</strong>
        <p>
          Expires at{" "}
          {new Date(expires).toLocaleTimeString([], {
            hour: "2-digit",
            minute: "2-digit",
          })}
          . One phone per code.
        </p>
      </div>
    </div>
  );
}
interface NotificationData {
  public_key: string | null;
  devices: number;
  events: { id: string; title: string; body: string; created_at: string }[];
  delivery_error: string | null;
}
const supportsPush = () =>
  window.isSecureContext &&
  "serviceWorker" in navigator &&
  "PushManager" in window &&
  "Notification" in window;
function pushKey(value: string) {
  const text = atob(value.replace(/-/g, "+").replace(/_/g, "/"));
  const bytes = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i);
  return bytes.buffer;
}
export function NotificationSettings() {
  const data = useData<NotificationData>(
    "notifications",
    "/notifications",
    15000,
  );
  const [enabled, setEnabled] = useState(false);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [message, setMessage] = useState("");
  const supported = supportsPush();
  useEffect(() => {
    if (!supported) return;
    let active = true;
    navigator.serviceWorker
      .register("/sw.js")
      .then(() => navigator.serviceWorker.ready)
      .then((r) => r.pushManager.getSubscription())
      .then((s) => {
        if (active) setEnabled(!!s);
      })
      .catch((e) => {
        if (active) setError(e);
      });
    return () => {
      active = false;
    };
  }, [supported]);
  async function enable() {
    setWorking(true);
    setError(null);
    setMessage("");
    try {
      const permission = await Notification.requestPermission();
      if (permission !== "granted")
        throw new Error(
          "Allow notifications in your browser settings, then try again.",
        );
      if (!data.data?.public_key)
        throw new Error(
          "Push notifications are not configured. Restart Varshan.",
        );
      await navigator.serviceWorker.register("/sw.js");
      const worker = await navigator.serviceWorker.ready;
      const subscription =
        (await worker.pushManager.getSubscription()) ??
        (await worker.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: pushKey(data.data.public_key),
        }));
      await request("/notifications/subscribe", subscription.toJSON());
      setEnabled(true);
      setMessage("Trading notifications enabled on this device.");
    } catch (e) {
      setError(
        e instanceof Error
          ? e
          : new Error("Notifications could not be enabled."),
      );
    } finally {
      setWorking(false);
    }
  }
  async function disable() {
    setWorking(true);
    setError(null);
    try {
      const worker = await navigator.serviceWorker.ready;
      const subscription = await worker.pushManager.getSubscription();
      if (subscription) {
        await request("/notifications/unsubscribe", {
          endpoint: subscription.endpoint,
        });
        await subscription.unsubscribe();
      }
      setEnabled(false);
      setMessage("Notifications disabled on this device.");
    } catch (e) {
      setError(
        e instanceof Error
          ? e
          : new Error("Notifications could not be disabled."),
      );
    } finally {
      setWorking(false);
    }
  }
  const test = useAction(
    () => request("/notifications/test", {}),
    ["notifications"],
  );
  return (
    <Card
      title="Trading notifications"
      subtitle="Backend alerts for automatic trading starts, pauses, order updates and completed rebalances."
    >
      <Failure error={data.error || error || test.error} />
      {!supported && (
        <Notice>
          Use trusted HTTPS on your phone. On iPhone, add Varshan to the Home
          Screen first and open it there to enable notifications.
        </Notice>
      )}
      <div className="actions">
        <button
          className="primary"
          disabled={!supported || working || !data.data?.public_key}
          onClick={() => void (enabled ? disable() : enable())}
        >
          {working
            ? "Updating…"
            : enabled
              ? "Disable notifications on this device"
              : "Enable notifications on this device"}
        </button>
        <button
          disabled={!enabled || test.isPending}
          onClick={() => test.mutate()}
        >
          Send test notification
        </button>
      </div>
      {message && <Notice>{message}</Notice>}
      {test.isSuccess && (
        <Notice>Test notification queued for this device.</Notice>
      )}
      {data.data?.delivery_error && <Notice>{data.data.delivery_error}</Notice>}
      <p className="footnote">
        Notifications hide symbols, balances and quantities. Your computer must
        remain awake with Varshan running and internet available. Phone
        notification delivery also depends on its browser and notification
        settings.
      </p>
      {!!data.data?.events?.length && (
        <details>
          <summary>Recent trading alerts</summary>
          <ul className="headline-list">
            {data.data.events.slice(0, 10).map((event) => (
              <li key={event.id}>
                <strong>{event.title}</strong>
                <p>{event.body}</p>
                <small>{new Date(event.created_at).toLocaleString()}</small>
              </li>
            ))}
          </ul>
        </details>
      )}
    </Card>
  );
}
