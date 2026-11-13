import { act, render, screen, waitFor } from "@testing-library/react";
import {
  onlineManager,
  QueryClient,
  QueryClientProvider,
} from "@tanstack/react-query";
import { afterEach, expect, it, vi } from "vitest";
import { ApiHealth } from "./api-health";

afterEach(() => {
  onlineManager.setOnline(true);
  vi.restoreAllMocks();
});
function mount() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <ApiHealth />
    </QueryClientProvider>,
  );
  return client;
}
const ok = () => new Response(JSON.stringify({ status: "ok", app: "varshan" }));
it("shows checking until a fresh API response arrives", async () => {
  let finish!: (value: Response) => void;
  const fetch = vi.fn(
    () =>
      new Promise<Response>((resolve) => {
        finish = resolve;
      }),
  );
  vi.stubGlobal("fetch", fetch);
  mount();
  expect(
    screen.getByRole("status", { name: "API health: checking" }),
  ).toBeVisible();
  await act(async () => finish(ok()));
  expect(
    await screen.findByRole("status", { name: "API health: online" }),
  ).toBeVisible();
  expect(fetch).toHaveBeenCalledWith(
    "/api/health",
    expect.objectContaining({ cache: "no-store" }),
  );
});
it("replaces cached online status on failure and recovers after a later check", async () => {
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(ok())
    .mockRejectedValueOnce(new TypeError("Network unavailable"))
    .mockResolvedValueOnce(ok());
  vi.stubGlobal("fetch", fetch);
  const client = mount();
  await screen.findByRole("status", { name: "API health: online" });
  await act(async () => {
    await client.refetchQueries({ queryKey: ["api-health"] });
  });
  expect(
    await screen.findByRole("status", { name: "API health: offline" }),
  ).toBeVisible();
  expect(client.getQueryData(["api-health"])).toBeDefined();
  await act(async () => {
    await client.refetchQueries({ queryKey: ["api-health"] });
  });
  expect(
    await screen.findByRole("status", { name: "API health: online" }),
  ).toBeVisible();
});
it.each([
  [503, { status: "ok", app: "varshan" }],
  [200, { status: "failed", app: "varshan" }],
  [200, { status: "ok", app: "another-app" }],
])(
  "does not report online for an unhealthy or unexpected response (%s)",
  async (status, body) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify(body), { status })),
    );
    mount();
    expect(
      await screen.findByRole("status", { name: "API health: offline" }),
    ).toBeVisible();
  },
);
it("checks the local API even when the browser reports no internet connection", async () => {
  onlineManager.setOnline(false);
  const fetch = vi.fn(async () => ok());
  vi.stubGlobal("fetch", fetch);
  mount();
  await waitFor(() =>
    expect(
      screen.getByRole("status", { name: "API health: online" }),
    ).toBeVisible(),
  );
  expect(fetch).toHaveBeenCalledTimes(1);
});
