import { AccessGate } from "./mobile";
import { cachedThemeCookie } from "./mobile-cache";
import { applyTheme } from "./themes";
import { StockChartWindow, PreferencesProvider } from "./preferences";
import { Component } from "react";
import type { ErrorInfo, ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClientProvider } from "@tanstack/react-query";
import { queryClient } from "./api";
import App from "./App";

class ErrorBoundary extends Component<
  { children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch(_error: Error, _info: ErrorInfo) {
    /* Brokerage data is never logged to the browser console. */
  }
  render() {
    return this.state.failed ? (
      <main className="fatal">
        <h1>Let’s reopen your workspace</h1>
        <p>
          The interface could not render. Saved accounts and completed analyses
          remain in local encrypted storage.
        </p>
        <button onClick={() => location.reload()}>Reload varshan</button>
      </main>
    ) : (
      this.props.children
    );
  }
}
applyTheme(
  cachedThemeCookie() ?? localStorage.getItem("varshan-theme") ?? "light",
);
if (window.isSecureContext && "serviceWorker" in navigator)
  void navigator.serviceWorker.register("/sw.js").catch(() => {
    /* Notification settings reports registration errors when enabled. */
  });
createRoot(document.getElementById("root")!).render(
  <ErrorBoundary>
    <QueryClientProvider client={queryClient}>
      <AccessGate>
        <PreferencesProvider>
          <App />
          <StockChartWindow />
        </PreferencesProvider>
      </AccessGate>
    </QueryClientProvider>
  </ErrorBoundary>,
);
