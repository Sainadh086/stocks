import { MobileSettings, NotificationSettings } from "./mobile";
import {
  IndiaBrokerConnections,
  IndiaBrokerPicker,
  type IndiaLive,
} from "./india-trading";
import { useAppearance } from "./appearance";
import { LearningSettings } from "./trade-learning";
import {
  Palette,
  Landmark,
  ChartNoAxesCombined,
  Smartphone,
} from "lucide-react";
import { ForestScene, ThemeModeSwitch } from "./forest-theme";
import { useEffect, useState } from "react";
import { request, runJob, useAction, useData } from "./api";
import { Badge, Card, Failure, Modal, Notice } from "./components";
import type { AccountOption, Accounts, Preferences } from "./types";

export function AccountSettings({
  onClose,
  page = "holdings",
  callbackToken = "",
  connectionError,
}: {
  onClose: () => void;
  page?: string;
  callbackToken?: string;
  connectionError?: Error | null;
}) {
  const saved = useData<Accounts>("accounts", "/accounts");
  const india = useData<IndiaLive>(["india-trading"], "/india/trading");
  const kiteError = india.data?.broker === "kite" ? india.data.error : null;
  const preferences = useData<Preferences>("preferences", "/preferences");
  const access = useData<{ local: boolean }>("access", "/access/status");
  const appearance = useAppearance();
  const themes = appearance.themes;
  const [privacyMode, setPrivacyMode] = useState(false);
  useEffect(() => {
    setPrivacyMode(preferences.data?.privacy_mode ?? false);
  }, [preferences.data?.privacy_mode]);
  const [topBenchmarks, setTopBenchmarks] = useState<string[]>([]);
  useEffect(() => {
    if (preferences.data?.top_benchmarks)
      setTopBenchmarks(preferences.data.top_benchmarks);
  }, [preferences.data]);
  const saveIndices = useAction(
    () =>
      request<Preferences>("/preferences", { top_benchmarks: topBenchmarks }),
    ["preferences", "indices"],
  );
  const [longTerm, setLongTerm] = useState("");
  const [trading, setTrading] = useState("");
  const [token, setToken] = useState(callbackToken);
  const [login, setLogin] = useState("");
  const [section, setSection] = useState("appearance");
  useEffect(() => {
    if (
      page === "india-trading" ||
      page === "trading" ||
      callbackToken ||
      connectionError
    ) {
      setSection("brokers");
      document
        .getElementById("settings-brokers")
        ?.scrollIntoView?.({ behavior: "instant", block: "start" });
    }
  }, [page, callbackToken, connectionError]);
  const discover = useAction(
    () => runJob<AccountOption[]>("/accounts/discover"),
    [],
  );
  const save = useAction(() =>
    runJob("/accounts/roles", { long_term: longTerm, trading }),
  );
  const connect = useAction(() =>
    runJob("/kite/connect", { request_token: token }),
  );
  const openLogin = useAction(
    () =>
      request<{ url: string }>(
        `/kite/login?return_page=${encodeURIComponent(page)}`,
      ),
    [],
  );
  function load() {
    discover.mutate(undefined, {
      onSuccess: (rows) => {
        setLongTerm(rows.find((r) => r.long_term)?.id || "");
        setTrading(rows.find((r) => r.trading)?.id || "");
      },
    });
  }
  return (
    <Modal
      title="Account settings"
      onClose={onClose}
      className="account-settings-dialog"
    >
      <div className="settings-intro">
        <p>
          Manage your broker connections, workspace preferences and trusted
          devices.
        </p>
        <span>
          <Landmark size={14} aria-hidden="true" /> Credentials stay encrypted
          on this computer
        </span>
      </div>
      <nav className="settings-navigation" aria-label="Settings sections">
        {[
          { id: "appearance", label: "Appearance & privacy", icon: Palette },
          {
            id: "markets",
            label: "Markets & charts",
            icon: ChartNoAxesCombined,
          },
          { id: "brokers", label: "Broker accounts", icon: Landmark },
          {
            id: "learning",
            label: "Reinforcement learning",
            icon: ChartNoAxesCombined,
          },
          { id: "devices", label: "Mobile & security", icon: Smartphone },
        ].map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            aria-current={section === id ? "location" : undefined}
            aria-controls={`settings-${id}`}
            onClick={() => {
              setSection(id);
              document
                .getElementById(`settings-${id}`)
                ?.scrollIntoView?.({ behavior: "instant", block: "start" });
            }}
          >
            <Icon size={17} />
            {label}
          </button>
        ))}
      </nav>
      <div className="settings-content">
        <section id="settings-appearance" className="settings-section">
          <Card
            title="Privacy & appearance"
            subtitle="Settings stay saved across tabs and sessions."
          >
            <Failure
              error={
                appearance.variables?.chart_provider ||
                appearance.variables?.chart_view
                  ? null
                  : appearance.error
              }
            />
            <label className="check">
              <input
                type="checkbox"
                checked={privacyMode}
                disabled={appearance.isPending || !preferences.data}
                onChange={(e) => {
                  setPrivacyMode(e.target.checked);
                  appearance.mutate(
                    { privacy_mode: e.target.checked },
                    {
                      onError: () =>
                        setPrivacyMode(preferences.data?.privacy_mode ?? false),
                    },
                  );
                }}
              />
              Privacy mode · hide holdings values, quantities and portfolio
              graphs
            </label>
            <p className="footnote" role="status">
              {appearance.isPending &&
              privacyMode === false &&
              preferences.data?.privacy_mode
                ? access.data?.local === false
                  ? "Verify on this phone. Private values stay hidden until verification succeeds."
                  : "Waiting for Touch ID on your Mac. Private values stay hidden."
                : access.data?.local === false
                  ? "Turning privacy mode off uses this phone’s Face ID, fingerprint or device lock."
                  : "Turning privacy mode off requires Touch ID on this Mac."}
            </p>
            <div className="appearance-mode">
              <span>Color mode</span>
              <ThemeModeSwitch />
            </div>
            {!preferences.data?.supported_themes && (
              <Notice>
                Restart Varshan and refresh to enable Dark and Forest at night.
                Existing themes are available now.
              </Notice>
            )}
            <div className="theme-gallery" aria-label="Theme previews">
              {themes.map((theme) => (
                <button
                  key={theme.id}
                  className="theme-option"
                  aria-label={`Use ${theme.name} theme`}
                  aria-pressed={
                    (preferences.data?.theme ?? "light") === theme.id
                  }
                  disabled={appearance.isPending || !appearance.ready}
                  onClick={() => appearance.mutate({ theme: theme.id })}
                >
                  <span
                    className={`theme-preview ${theme.id.startsWith("forest") ? "forest-preview" : ""}`}
                    style={{
                      background: theme.colors[0],
                      color: theme.colors[2],
                    }}
                    aria-hidden="true"
                  >
                    {theme.id.startsWith("forest") && <ForestScene />}
                    <span
                      className="preview-rail"
                      style={{ background: theme.colors[1] }}
                    >
                      <i />
                      <i />
                      <i />
                    </span>
                    <span className="preview-content">
                      <span className="preview-heading" />
                      <span className="preview-metrics">
                        <i style={{ background: theme.colors[1] }} />
                        <i style={{ background: theme.colors[1] }} />
                        <i style={{ background: theme.colors[1] }} />
                      </span>
                      <span
                        className="preview-chart"
                        style={{ background: theme.colors[1] }}
                      >
                        <svg viewBox="0 0 120 32">
                          <path
                            d="M2 28 L20 21 L36 25 L53 13 L69 18 L88 5 L105 10 L118 2"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="2"
                          />
                        </svg>
                      </span>
                    </span>
                  </span>
                  <span className="theme-title">
                    {theme.name}
                    <span>
                      {(preferences.data?.theme ?? "light") === theme.id
                        ? "Selected"
                        : theme.mode === "dark"
                          ? "Dark"
                          : "Light"}
                    </span>
                  </span>
                  <small>{theme.description}</small>
                </button>
              ))}
            </div>
            <div className="compact-theme-select">
              <label>
                Theme
                <select
                  disabled={appearance.isPending || !appearance.ready}
                  aria-label="Theme"
                  value={preferences.data?.theme ?? "light"}
                  onChange={(e) =>
                    appearance.mutate({
                      theme: e.target.value as Preferences["theme"],
                    })
                  }
                >
                  {themes.map((theme) => (
                    <option key={theme.id} value={theme.id}>
                      {theme.name}
                    </option>
                  ))}
                </select>
              </label>
            </div>
          </Card>
        </section>
        <section id="settings-markets" className="settings-section">
          <Card
            title="Stock charts"
            subtitle="Choose where stock links open and which price provider to use."
          >
            <Failure
              error={
                appearance.variables?.chart_provider ||
                appearance.variables?.chart_view
                  ? appearance.error
                  : null
              }
            />
            <div className="form-row">
              <label>
                Stock link provider
                <select
                  disabled={appearance.isPending || !appearance.ready}
                  aria-label="Stock link provider"
                  value={preferences.data?.chart_provider ?? "yahoo"}
                  onChange={(e) =>
                    appearance.mutate({
                      chart_provider: e.target
                        .value as Preferences["chart_provider"],
                    })
                  }
                >
                  <option value="yahoo">Yahoo Finance</option>
                  <option value="tradingview">TradingView</option>
                </select>
              </label>
              <label>
                Open stock charts
                <select
                  disabled={appearance.isPending || !appearance.ready}
                  aria-label="Open stock charts"
                  value={preferences.data?.chart_view ?? "embedded"}
                  onChange={(e) =>
                    appearance.mutate({
                      chart_view: e.target.value as Preferences["chart_view"],
                    })
                  }
                >
                  <option value="embedded">Inside Varshan</option>
                  <option value="external">In a new browser tab</option>
                </select>
              </label>
            </div>
          </Card>
          <Card
            title="Top-bar benchmarks"
            subtitle="Choose up to six indices. Your selection is saved until you change it."
          >
            <Failure error={preferences.error || saveIndices.error} />
            <div className="selection-grid">
              {["India", "US"].map((region) => (
                <div key={region}>
                  <h3>{region}</h3>
                  {preferences.data?.catalog
                    ?.filter((index) => index.region === region)
                    .map((index) => (
                      <label className="check" key={index.name}>
                        <input
                          type="checkbox"
                          checked={topBenchmarks.includes(index.name)}
                          disabled={
                            !topBenchmarks.includes(index.name) &&
                            topBenchmarks.length >= 6
                          }
                          onChange={(event) =>
                            setTopBenchmarks(
                              event.target.checked
                                ? [...topBenchmarks, index.name]
                                : topBenchmarks.filter(
                                    (name) => name !== index.name,
                                  ),
                            )
                          }
                        />
                        {index.name}
                      </label>
                    ))}
                </div>
              ))}
            </div>
            <button
              className="primary"
              disabled={!topBenchmarks.length || saveIndices.isPending}
              onClick={() => saveIndices.mutate()}
            >
              {saveIndices.isPending ? "Saving…" : "Save top-bar benchmarks"}
            </button>
            {saveIndices.isSuccess && (
              <Notice>Top-bar benchmarks saved.</Notice>
            )}
          </Card>
        </section>
        <section id="settings-brokers" className="settings-section">
          <div className="broker-section-heading">
            <div>
              <span className="section-eyebrow">CONNECTED ACCOUNTS</span>
              <h3>Broker connections</h3>
              <p>
                {page === "india-trading"
                  ? "Choose one India broker account for trading and long-term investing. Expand US accounts to manage Robinhood."
                  : "Choose your India broker for trading and long-term investing, and separate US investing and trading accounts."}
              </p>
            </div>
            <Badge>Encrypted locally</Badge>
          </div>
          <Failure
            error={
              connectionError ||
              saved.error ||
              saved.data?.error ||
              discover.error ||
              save.error ||
              connect.error ||
              openLogin.error
            }
          />
          <Card title="India broker account">
            <IndiaBrokerPicker />
          </Card>
          <details
            className="broker-us-details"
            open={page !== "india-trading"}
          >
            <summary>
              <span>US accounts · Robinhood</span>
              <Badge>
                {saved.data?.roles.long_term.selected &&
                saved.data?.roles.trading.selected
                  ? "Configured"
                  : "Set up"}
              </Badge>
            </summary>
            <Card
              title="Robinhood account roles"
              className="broker-card broker-card-us"
              subtitle="US investing & intraday trading · saved account roles"
            >
              <div className="actions">
                <Badge
                  tone={saved.data?.roles.long_term.selected ? "bullish" : ""}
                >
                  Long term ·{" "}
                  {saved.data?.roles.long_term.ending
                    ? `•••• ${saved.data.roles.long_term.ending.slice(-4)}`
                    : "Not selected"}
                </Badge>
                <Badge
                  tone={saved.data?.roles.trading.selected ? "bullish" : ""}
                >
                  Daily trading ·{" "}
                  {saved.data?.roles.trading.ending
                    ? `•••• ${saved.data.roles.trading.ending.slice(-4)}`
                    : "Not selected"}
                </Badge>
              </div>
              <p>
                Use distinct accounts for investing and daily trading. The daily
                trading account must support Robinhood Agentic trading.
              </p>
              <button disabled={discover.isPending} onClick={load}>
                {discover.isPending
                  ? "Connecting to Robinhood…"
                  : "Connect / manage Robinhood accounts"}
              </button>
              {discover.data && (
                <>
                  <div className="form-row">
                    <label>
                      Long-term account
                      <select
                        value={longTerm}
                        onChange={(e) => setLongTerm(e.target.value)}
                      >
                        <option value="">Select account</option>
                        {discover.data.map((a) => (
                          <option value={a.id} key={a.id}>
                            {a.label}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label>
                      Daily trading account
                      <select
                        value={trading}
                        onChange={(e) => setTrading(e.target.value)}
                      >
                        <option value="">Select account</option>
                        {discover.data
                          .filter((a) => a.agentic_allowed)
                          .map((a) => (
                            <option value={a.id} key={a.id}>
                              {a.label}
                            </option>
                          ))}
                      </select>
                    </label>
                  </div>
                  <button
                    className="primary"
                    disabled={
                      save.isPending ||
                      !longTerm ||
                      !trading ||
                      longTerm === trading
                    }
                    onClick={() =>
                      save.mutate(undefined, { onSuccess: onClose })
                    }
                  >
                    {save.isPending ? "Saving…" : "Save account roles"}
                  </button>
                </>
              )}
              <p className="footnote">
                The existing encrypted OAuth connection is reused. Robinhood may
                open its authorization flow on first connection.
              </p>
            </Card>
          </details>
          <Card
            title="Kite connection"
            className="broker-card"
            subtitle="India · Zerodha daily session"
            action={
              <Badge
                tone={
                  kiteError
                    ? "bearish"
                    : saved.data?.kite_connected
                      ? "bullish"
                      : ""
                }
              >
                {kiteError
                  ? "Access needs attention"
                  : saved.data?.kite_connected
                    ? "Session connected"
                    : "Needs login"}
              </Badge>
            }
          >
            <p>
              Kite sessions need daily renewal. Your API key and secret remain
              in the existing encrypted backend storage.
            </p>
            <Failure error={kiteError} />
            {kiteError && (
              <p className="footnote">
                Check the Kite session and your app’s API permissions, then
                refresh the India trading account.
              </p>
            )}
            <button
              disabled={openLogin.isPending}
              onClick={() =>
                openLogin.mutate(undefined, {
                  onSuccess: (result) => setLogin(result.url),
                })
              }
            >
              Get Kite login link
            </button>
            {login && (
              <p>
                <a
                  href={login}
                  rel="noreferrer"
                  onClick={() => localStorage.setItem("varshan-page", page)}
                >
                  Continue to Kite login →
                </a>
              </p>
            )}
            <form
              onSubmit={(e) => {
                e.preventDefault();
                connect.mutate(undefined, { onSuccess: () => setToken("") });
              }}
            >
              <label>
                One-time request token or redirect URL
                <input
                  autoComplete="off"
                  type="password"
                  value={token}
                  onChange={(e) => setToken(e.target.value)}
                  placeholder="Paste after signing in to Kite"
                />
              </label>
              <button
                className="primary"
                disabled={!token.trim() || connect.isPending}
                type="submit"
              >
                {connect.isPending ? "Connecting…" : "Connect Kite"}
              </button>
            </form>
            {connect.isSuccess && <Notice>Kite session saved.</Notice>}
            <details className="broker-help">
              <summary>Redirect setup and login help</summary>
              <p className="footnote">
                Set your Kite developer app’s redirect URL to{" "}
                {window.location.origin}
                /. After login, Varshan reconnects and returns to this workspace
                automatically. If your existing redirect opens elsewhere, paste
                its URL above.
              </p>
            </details>
          </Card>
          <IndiaBrokerConnections />
        </section>
        <section id="settings-learning" className="settings-section">
          <LearningSettings />
        </section>
        <section id="settings-devices" className="settings-section">
          <MobileSettings />
          <NotificationSettings />
        </section>
      </div>
    </Modal>
  );
}
