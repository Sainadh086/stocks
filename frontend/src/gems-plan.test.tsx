import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, expect, it, vi } from "vitest";
import { USGemsPlan } from "./gems-plan";
import { queryClient } from "./api";

let plan: Record<string, any>;
let writes: { path: string; body: Record<string, any> }[];
beforeEach(() => {
  queryClient.clear();
  writes = [];
  plan = {
    scope: "investing-one",
    budget: 10000,
    reserve_pct: 10,
    saved: false,
    picks: [
      {
        symbol: "GEM",
        sector: "Technology",
        target_usd: 1125,
        initial_usd: 450,
        ready_initial_usd: 0,
        qualitative_status: "REVIEW REQUIRED",
      },
    ],
    target_cash_usd: 8875,
    ready_initial_usd: 0,
    schedule: [],
    reviews: {},
    message: "Model portfolio targets only; no orders are created.",
    review_policy: "Review filings each quarter.",
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string, options?: RequestInit) => {
      const path = String(input);
      if (path === "/api/bootstrap")
        return new Response(JSON.stringify({ token: "test-token" }));
      if (options?.method === "POST") {
        const body = JSON.parse(String(options.body));
        writes.push({ path, body });
        if (path === "/api/us/gems/plan")
          plan = { ...plan, ...body, saved: true };
        if (path === "/api/us/gems/reviews") {
          plan.reviews[body.symbol] = {
            ...body,
            reviewed_at: new Date().toISOString(),
          };
          plan.picks[0].qualitative_status = "REVIEWED — investor attestation";
          plan.picks[0].ready_initial_usd = 450;
          plan.ready_initial_usd = 450;
        }
      }
      return new Response(JSON.stringify(plan), { status: 200 });
    }),
  );
});
function mount() {
  render(
    <QueryClientProvider client={queryClient}>
      <USGemsPlan />
    </QueryClientProvider>,
  );
}
it("saves model budget and requires dated source evidence before recording a review", async () => {
  mount();
  const table = await screen.findByRole("table", {
    name: "US Gems allocation",
  });
  expect(within(table).getByText("REVIEW REQUIRED")).toBeVisible();
  fireEvent.change(screen.getByLabelText("Gems portfolio budget ($)"), {
    target: { value: "5000" },
  });
  fireEvent.click(
    screen.getByRole("button", { name: "Build and save Gems plan" }),
  );
  expect(await screen.findByText("Gems plan saved")).toBeVisible();
  expect(writes[0]).toEqual({
    path: "/api/us/gems/plan",
    body: { budget: 5000, reserve_pct: 10 },
  });
  fireEvent.click(
    screen.getByText("Record policy, management and long-term vision review"),
  );
  fireEvent.change(screen.getByLabelText("Gems company to review"), {
    target: { value: "GEM" },
  });
  const save = screen.getByRole("button", { name: "Save dated Gems review" });
  expect(save).toBeDisabled();
  for (const label of [
    "Government-policy fit and regulatory risks",
    "Management, governance and capital-allocation decisions",
    "3–5 year growth vision and thesis risks",
  ])
    fireEvent.change(screen.getByLabelText(label), {
      target: {
        value: "Reviewed dated evidence and documented material thesis risks.",
      },
    });
  fireEvent.change(
    screen.getByLabelText("Dated source links (HTTPS, one per line)"),
    { target: { value: "https://www.sec.gov/edgar/search/" } },
  );
  expect(save).toBeDisabled();
  fireEvent.click(
    screen.getByRole("checkbox", { name: /I reviewed these dated sources/ }),
  );
  fireEvent.click(save);
  expect(await screen.findByText("Dated review saved")).toBeVisible();
  await waitFor(() =>
    expect(
      within(table).getByText("REVIEWED — investor attestation"),
    ).toBeVisible(),
  );
  expect(writes[1].body.acknowledged).toBe(true);
  expect(writes[1].body.source_urls).toEqual([
    "https://www.sec.gov/edgar/search/",
  ]);
  expect(writes[1].body).not.toHaveProperty("reviewed_at");
  fireEvent.change(screen.getByLabelText("Gems company to review"), {
    target: { value: "" },
  });
  fireEvent.change(screen.getByLabelText("Gems company to review"), {
    target: { value: "GEM" },
  });
  fireEvent.click(
    screen.getByRole("checkbox", { name: /I reviewed these dated sources/ }),
  );
  fireEvent.click(
    screen.getByRole("button", { name: "Save dated Gems review" }),
  );
  await waitFor(() => expect(writes.length).toBe(3));
  expect(writes[2].body).not.toHaveProperty("reviewed_at");
  expect(writes.every((write) => write.path.startsWith("/api/us/gems/"))).toBe(
    true,
  );
});
it("keeps cash and prevents a review when a fresh scan has no allocation candidates", async () => {
  plan.picks = [];
  plan.message = "Refresh US Gems analysis before building current targets.";
  mount();
  expect(await screen.findByText(plan.message)).toBeVisible();
  fireEvent.click(
    screen.getByText("Record policy, management and long-term vision review"),
  );
  expect(screen.getByLabelText("Gems company to review")).toHaveValue("");
  expect(
    screen.queryByRole("button", { name: "Save dated Gems review" }),
  ).not.toBeInTheDocument();
  expect(writes).toEqual([]);
});
