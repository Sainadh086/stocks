import { runJob } from "./api";
export const workspacePages = [
  "holdings",
  "recommendations",
  "replacements",
  "weekly",
  "trading",
  "india-trading",
  "benchmark",
  "learning",
] as const;
export type WorkspacePage = (typeof workspacePages)[number];
export const validWorkspacePage = (
  value: string | null,
): value is WorkspacePage => workspacePages.some((page) => page === value);
export interface KiteReturn {
  page: WorkspacePage;
  token: string;
  state: string | null;
  success: boolean;
}
export function readKiteReturn(): KiteReturn | null {
  const url = new URL(window.location.href);
  const token = url.searchParams.get("request_token");
  const state = url.searchParams.get("varshan_kite_state");
  if (!token && !state) return null;
  const requested =
    url.searchParams.get("varshan_return_page") ??
    localStorage.getItem("varshan-page");
  const result = {
    page: validWorkspacePage(requested)
      ? requested
      : ("holdings" as WorkspacePage),
    token: token ?? "",
    state,
    success: !!token && url.searchParams.get("status") !== "error",
  };
  return result;
}
const exchanges = new Map<
  string,
  Promise<{ connected: boolean; return_page: WorkspacePage }>
>();
export function completeKiteReturn(callback: KiteReturn) {
  if (!callback.state)
    throw new Error("Use Account settings to complete this Kite connection.");
  const existing = exchanges.get(callback.state);
  if (existing) return existing;
  const promise = runJob<unknown>("/kite/callback", {
    request_token: callback.token,
    state: callback.state,
  }).then((value) => {
    const result = value as {
      connected?: unknown;
      return_page?: unknown;
    } | null;
    if (!result || result.connected !== true)
      throw new Error(
        "Kite did not confirm the connection. Start a fresh login from Account settings.",
      );
    return {
      connected: true,
      return_page:
        typeof result.return_page === "string" &&
        validWorkspacePage(result.return_page)
          ? result.return_page
          : callback.page,
    };
  });
  exchanges.set(callback.state, promise);
  return promise;
}

export function clearKiteReturn() {
  const url = new URL(window.location.href);
  for (const key of [
    "request_token",
    "varshan_kite_state",
    "varshan_return_page",
    "action",
    "status",
  ])
    url.searchParams.delete(key);
  window.history.replaceState(null, "", url.pathname + url.search + url.hash);
}
