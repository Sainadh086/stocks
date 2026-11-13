import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, expect, it, vi } from "vitest";
import { queryClient } from "./api";
import { TradeLearning } from "./trade-learning";
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
