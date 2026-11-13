import {
  readKiteReturn,
  completeKiteReturn,
  clearKiteReturn,
} from "./kite-login";
import { useEffect, useState } from "react";
import {
  BarChart3,
  BookOpen,
  ChevronRight,
  CircleHelp,
  GitCompareArrows,
  LayoutDashboard,
  Menu,
  Repeat2,
  Settings2,
  ShieldCheck,
  Sparkles,
  TrendingUp,
  X,
} from "lucide-react";
import { queryClient, useData, useStream } from "./api";
import { Badge, Failure, Notice } from "./components";
import { AccountSettings } from "./accounts";
import {
  AccountSummary,
  Benchmarks,
  Holdings,
  Learning,
  Recommendations,
  Replacements,
  Weekly,
} from "./workspaces";
import { Trading } from "./trading";
import { IndiaTrading } from "./india-trading";
import { ApiHealth } from "./api-health";
import type { Market } from "./types";
import {
  ForestAtmosphere,
  ForestRetreat,
  ThemeModeSwitch,
} from "./forest-theme";
import "./style.css";

const pages = [
  {
    id: "holdings",
    label: "Holdings",
    icon: LayoutDashboard,
    subtitle: "A clear view of what you own.",
  },
  {
    id: "recommendations",
    label: "Recommendations",
    icon: Sparkles,
    subtitle: "Turn research into a considered allocation.",
  },
  {
    id: "replacements",
    label: "Replacements",
    icon: Repeat2,
    subtitle: "Find the next candidates for your portfolio.",
  },
  {
    id: "weekly",
    label: "Weekly review",
    icon: BarChart3,
    subtitle: "Step back. Review progress and portfolio risk.",
  },
  {
    id: "trading",
    label: "US trading",
    icon: TrendingUp,
    subtitle: "Separate live execution and paper practice.",
  },
  {
    id: "india-trading",
    label: "India trading",
    icon: TrendingUp,
    subtitle: "NSE intraday trading with Kite, Upstox and Groww.",
  },
  {
    id: "benchmark",
    label: "Benchmark comparison",
    icon: GitCompareArrows,
    subtitle: "Put your holdings in a broader market context.",
  },
  {
    id: "learning",
    label: "Market learning",
    icon: BookOpen,
    subtitle: "Your daily India and US market briefing.",
  },
] as const;
type Page = (typeof pages)[number]["id"];
export default function App() {
  const [kiteReturn] = useState(readKiteReturn);
  const [kiteStatus, setKiteStatus] = useState("");
  const [kiteError, setKiteError] = useState<Error | null>(null);
  const [page, setPage] = useState<Page>(() => {
    const requested = new URL(window.location.href).searchParams.get(
      "workspace",
    );
    const saved =
      kiteReturn?.page ??
      (pages.some((p) => p.id === requested)
        ? requested
        : localStorage.getItem("varshan-page"));
    return pages.some((p) => p.id === saved) ? (saved as Page) : "holdings";
  });
  const [visited, setVisited] = useState<Set<Page>>(new Set([page]));
  const [settings, setSettings] = useState(!!kiteReturn && !kiteReturn.state);
  const [menu, setMenu] = useState(false);
  useEffect(() => {
    if (!kiteReturn) return;
    clearKiteReturn();
    if (!kiteReturn.success) {
      setKiteError(
        new Error(
          "Kite login was not completed. Start a new login from Account settings.",
        ),
      );
      setSettings(true);
      return;
    }
    if (!kiteReturn.state) return;
    let active = true;
    setKiteStatus("Completing Kite login…");
    completeKiteReturn(kiteReturn)
      .then((result) => {
        if (!active) return;
        navigate(result.return_page);
        setKiteStatus("Kite connected. You’re back in your workspace.");
        for (const key of ["accounts", "portfolios", "kite-batches"])
          void queryClient.invalidateQueries({ queryKey: [key] });
      })
      .catch((error) => {
        if (!active) return;
        setKiteStatus("");
        setKiteError(error);
        setSettings(true);
      });
    return () => {
      active = false;
    };
  }, [kiteReturn]);
  useEffect(() => {
    if (!menu) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMenu(false);
    };
    document.addEventListener("keydown", closeOnEscape);
    return () => document.removeEventListener("keydown", closeOnEscape);
  }, [menu]);
  const connection = useStream(visited.has("trading"));
  const markets = useData<Market[]>("markets", "/markets", 30_000);
  const indices = useData<Market[]>("indices", "/indices", 30_000);
  const current = pages.find((p) => p.id === page)!;
  function navigate(next: Page) {
    setPage(next);
    setVisited((previous) => new Set([...previous, next]));
    localStorage.setItem("varshan-page", next);
    setMenu(false);
  }
  return (
    <div className="app-shell">
      <ForestAtmosphere />
      <a className="skip-link" href="#workspace">
        Skip to workspace
      </a>
      {menu && (
        <button
          className="navigation-backdrop"
          aria-label="Dismiss navigation"
          onClick={() => setMenu(false)}
        />
      )}
      <aside className={`sidebar ${menu ? "open" : ""}`}>
        <div className="brand">
          <img src="/brand/varshan-logo.svg" alt="" />
          <span>
            varshan<span className="brand-dot">.</span>
          </span>
          <button
            className="icon-button mobile-close"
            aria-label="Close navigation"
            onClick={() => setMenu(false)}
          >
            <X size={20} />
          </button>
        </div>
        <div className="nav-caption">YOUR WORKSPACE</div>
        <nav aria-label="Main navigation">
          {pages.map((item) => (
            <button
              key={item.id}
              aria-current={page === item.id ? "page" : undefined}
              className={page === item.id ? "selected" : ""}
              onClick={() => navigate(item.id)}
            >
              <item.icon size={19} />
              <span>{item.label}</span>
              {page === item.id && <ChevronRight size={14} />}
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <ForestRetreat />
          <div className="local-card">
            <ShieldCheck size={20} />
            <div>
              <strong>Your accounts, your control</strong>
              <p>Private data stays encrypted locally.</p>
            </div>
          </div>
          <button onClick={() => setSettings(true)}>
            <Settings2 size={18} />
            Account settings
          </button>
          <div className="sidebar-note">
            <CircleHelp size={13} />
            Public market prices may be delayed.
          </div>
        </div>
      </aside>
      <div className="main-shell">
        <header className="topbar">
          <button
            className="icon-button mobile-menu"
            aria-label="Open navigation"
            aria-expanded={menu}
            onClick={() => setMenu(true)}
          >
            <Menu size={21} />
          </button>
          <div className="market-strip">
            {(Array.isArray(indices.data) && indices.data.length
              ? indices.data
              : markets.data || []
            ).map((market) => (
              <div
                className="market-pill"
                key={market.benchmark}
                title={`${market.benchmark} · ${market.report.date || "Price date unavailable"} · ${market.report.source || "Source unavailable"}`}
              >
                <Badge tone={market.theme || ""}>
                  {market.code} <span className="status-dot" />
                  {market.theme || "Loading"}
                </Badge>
                <div className="ticker-price">
                  <small>{market.benchmark}</small>
                  <strong>
                    {market.report.price?.toLocaleString(undefined, {
                      maximumFractionDigits: 2,
                    }) || "—"}
                  </strong>
                </div>
                {market.report.change_pct !== undefined && (
                  <span
                    className={market.report.change_pct >= 0 ? "up" : "down"}
                  >
                    {market.report.change_pct >= 0 ? "+" : ""}
                    {market.report.change_pct.toFixed(2)}%
                  </span>
                )}
              </div>
            ))}
          </div>
          <ApiHealth />
          <ThemeModeSwitch />
          <button
            className="settings-button"
            onClick={() => setSettings(true)}
            aria-label="Open account settings"
          >
            <Settings2 size={17} />
            <span>Accounts</span>
          </button>
        </header>
        <main id="workspace" tabIndex={-1}>
          <div className="page-heading">
            <div>
              <div className="eyebrow">INVEST WITH PERSPECTIVE</div>
              <h1>{current.label}</h1>
              <p>{current.subtitle}</p>
            </div>
            <div className="connection-state">
              <span className={`status-dot ${connection ? "connected" : ""}`} />
              {connection ? "Updates connected" : "Updates reconnecting"}
            </div>
          </div>
          <div className="account-summary">
            <AccountSummary />
          </div>
          <Failure error={markets.error || kiteError} />
          {kiteStatus && <Notice>{kiteStatus}</Notice>}
          {visited.has("holdings") && (
            <div hidden={page !== "holdings"}>
              <Holdings />
            </div>
          )}
          {visited.has("recommendations") && (
            <div hidden={page !== "recommendations"}>
              <Recommendations />
            </div>
          )}
          {visited.has("replacements") && (
            <div hidden={page !== "replacements"}>
              <Replacements />
            </div>
          )}
          {visited.has("weekly") && (
            <div hidden={page !== "weekly"}>
              <Weekly />
            </div>
          )}
          {visited.has("trading") && (
            <div hidden={page !== "trading"}>
              <Trading connection={connection} />
            </div>
          )}
          {visited.has("india-trading") && (
            <div hidden={page !== "india-trading"}>
              <IndiaTrading
                active={page === "india-trading"}
                onOpenAccounts={() => setSettings(true)}
              />
            </div>
          )}
          {visited.has("benchmark") && (
            <div hidden={page !== "benchmark"}>
              <Benchmarks />
            </div>
          )}
          {visited.has("learning") && (
            <div hidden={page !== "learning"}>
              <Learning />
            </div>
          )}
          <footer>
            varshan <span>•</span> Investing and trading, with a plan.
          </footer>
        </main>
      </div>
      {settings && (
        <AccountSettings
          page={page}
          connectionError={kiteError}
          callbackToken={!kiteReturn?.state ? kiteReturn?.token : undefined}
          onClose={() => setSettings(false)}
        />
      )}
    </div>
  );
}
