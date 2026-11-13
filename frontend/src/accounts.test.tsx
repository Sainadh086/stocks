import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, expect, it, vi } from "vitest";
import { AccountSettings } from "./accounts";

vi.mock("./mobile", () => ({
  MobileSettings: () => <p>Mobile access controls</p>,
  NotificationSettings: () => <p>Notification controls</p>,
}));
afterEach(() => vi.unstubAllGlobals());
function setup(page = "india-trading", callbackToken = "") {
  const posts: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string, init?: RequestInit) => {
      const path = String(input);
      if (init?.method === "POST") posts.push(path);
      const data =
        path === "/api/accounts"
          ? {
              roles: {
                long_term: { selected: true, ending: "••••1234" },
                trading: { selected: true, ending: "5678" },
              },
              kite_connected: true,
            }
          : path === "/api/preferences"
            ? {
                privacy_mode: true,
                theme: "light",
                supported_themes: ["light", "midnight"],
                top_benchmarks: [],
                catalog: [],
              }
            : path === "/api/india/trading"
              ? {
                  broker: "kite",
                  error:
                    "Kite PermissionException: Insufficient permission for that call.",
                  brokers: [],
                  auto: { enabled: false },
                  tickets: [],
                }
              : { local: true };
      return new Response(JSON.stringify(data));
    }),
  );
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <AccountSettings
        onClose={vi.fn()}
        page={page}
        callbackToken={callbackToken}
      />
    </QueryClientProvider>,
  );
  return { posts };
}

it("opens broker navigation from India trading and surfaces a saved session's permission error", async () => {
  const f = setup();
  expect(
    screen.getByRole("button", { name: "Broker accounts" }),
  ).toHaveAttribute("aria-current", "location");
  expect(await screen.findByText("Access needs attention")).toBeVisible();
  expect(
    screen.getByText(
      "Kite PermissionException: Insufficient permission for that call.",
    ),
  ).toBeVisible();
  fireEvent.click(screen.getByText("US accounts · Robinhood"));
  expect(screen.getByText("Long term · •••• 1234")).toBeVisible();
  expect(screen.getByText("Daily trading · •••• 5678")).toBeVisible();
  expect(f.posts).toEqual([]);
});

it("retains broker token edits when navigating settings sections", async () => {
  setup();
  fireEvent.change(await screen.findByLabelText("Daily access token"), {
    target: { value: "unsaved-test-token" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Appearance & privacy" }));
  expect(
    screen.getByRole("button", { name: "Appearance & privacy" }),
  ).toHaveAttribute("aria-current", "location");
  fireEvent.click(screen.getByRole("button", { name: "Broker accounts" }));
  expect(screen.getByLabelText("Daily access token")).toHaveValue(
    "unsaved-test-token",
  );
});

it("opens the broker section for a returned Kite token on another workspace", async () => {
  setup("holdings", "one-time-fixture");
  await waitFor(() =>
    expect(
      screen.getByRole("button", { name: "Broker accounts" }),
    ).toHaveAttribute("aria-current", "location"),
  );
  expect(
    screen.getByLabelText("One-time request token or redirect URL"),
  ).toHaveValue("one-time-fixture");
  expect(
    screen.getByLabelText("One-time request token or redirect URL"),
  ).toHaveAttribute("type", "password");
});
