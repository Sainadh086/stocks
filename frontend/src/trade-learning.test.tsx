import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, expect, it, vi } from "vitest";
import { queryClient } from "./api";
import { LearningSettings, TradeLearning } from "./trade-learning";
let writes: string[];
beforeEach(() => {
  queryClient.clear();
  writes = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (path: string, options?: RequestInit) => {
      if (String(path).endsWith("/bootstrap"))
        return new Response(JSON.stringify({ token: "test-token" }));
      if (options?.method === "POST") writes.push(String(path));
      return new Response(
        JSON.stringify({
          contexts: [{ bucket: "test", label: "US investing" }],
          selected: "test",
          orders: [],
          episodes: [],
          insights: [],
          policy: null,
          error: null,
          coverage: "Broker retention determines historical coverage.",
        }),
      );
    }),
  );
});

it("shows market-specific stock advice in recommendations without submitting orders", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            contexts: [{ bucket: "india", label: "India trading" }],
            selected: "india",
            orders: [],
            episodes: [],
            insights: [],
            policy: null,
            execution_enabled: false,
            recommendations: [
              {
                symbol: "INFY",
                strategy: "intraday_rotation_v1",
                learning_suggestion: "Evidence needed",
                learning_reason: "More closed cycles needed",
                observed_reason: "Observed scan",
              },
            ],
          }),
        ),
    ),
  );
  render(
    <QueryClientProvider client={queryClient}>
      <TradeLearning market="India" />
    </QueryClientProvider>,
  );
  expect(
    await screen.findByRole("heading", {
      name: "India reinforcement learning recommendations",
    }),
  ).toBeVisible();
  expect(
    await screen.findByRole("table", {
      name: "Learning stock recommendations",
    }),
  ).toHaveTextContent("INFY");
  expect(screen.getByText("Recommendations only")).toBeVisible();
  expect(vi.mocked(fetch).mock.calls[0][0]).toBe("/api/learning?market=India");
  expect(
    vi
      .mocked(fetch)
      .mock.calls.every(([, options]) => !options || options.method !== "POST"),
  ).toBe(true);
});

it("saves the learning trading preference explicitly and restores it after remount", async () => {
  let enabled = false;
  const posts: unknown[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (path: string, options?: RequestInit) => {
      if (String(path).endsWith("/bootstrap"))
        return new Response(JSON.stringify({ token: "fixture" }));
      if (options?.method === "POST") {
        const body = JSON.parse(String(options.body));
        posts.push({ path, body });
        enabled = body.execution_enabled;
      }
      return new Response(JSON.stringify({ execution_enabled: enabled }));
    }),
  );
  const view = render(
    <QueryClientProvider client={queryClient}>
      <LearningSettings />
    </QueryClientProvider>,
  );
  const toggle = await screen.findByRole("checkbox", {
    name: "Use reinforcement learning in trading and automatic trading",
  });
  await waitFor(() => expect(toggle).toBeEnabled());
  expect(toggle).not.toBeChecked();
  expect(posts).toEqual([]);
  fireEvent.click(toggle);
  await waitFor(() => expect(toggle).toBeChecked());
  expect(posts).toEqual([
    { path: "/api/learning/settings", body: { execution_enabled: true } },
  ]);
  view.unmount();
  queryClient.clear();
  render(
    <QueryClientProvider client={queryClient}>
      <LearningSettings />
    </QueryClientProvider>,
  );
  await waitFor(() => expect(screen.getByRole("checkbox")).toBeChecked());
  fireEvent.click(screen.getByRole("checkbox"));
  await waitFor(() => expect(screen.getByRole("checkbox")).not.toBeChecked());
  expect(posts).toHaveLength(2);
});
it("shows cold-start evidence requirements and trains without posting a broker action", async () => {
  render(
    <QueryClientProvider client={queryClient}>
      <TradeLearning />
    </QueryClientProvider>,
  );
  expect(await screen.findByText("Collecting evidence")).toBeVisible();
  fireEvent.click(
    screen.getByRole("button", { name: "Train and evaluate advisor" }),
  );
  await waitFor(() => expect(writes).toEqual(["/api/learning/train"]));
  expect(screen.getByText(/real trades never explore randomly/)).toBeVisible();
  fireEvent.click(
    screen.getByText("Buy / sell journal and strategy attribution"),
  );
  expect(
    screen.getByRole("button", { name: "Save strategy reasoning" }),
  ).toBeDisabled();
  expect(
    screen.getByText(/does not fabricate historical market features/),
  ).toBeVisible();
});
