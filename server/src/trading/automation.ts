import { join } from "node:path";
import { US } from "../shared/storage.js";

export const automationPreferencePath = join(
  US,
  "live_automation_preference.json",
);

export function preferenceFromSnapshot(
  live: {
    scope?: unknown;
    auto?: { enabled?: unknown; background?: unknown; expires_at?: unknown };
  },
  now = Date.now(),
) {
  if (
    typeof live.auto?.enabled !== "boolean" ||
    typeof live.scope !== "string" ||
    !live.scope
  )
    throw new Error(
      "The running API returned no readable automatic trading choice.",
    );
  const enabled = live.auto.enabled && live.auto.background === true;
  const expires =
    typeof live.auto.expires_at === "string"
      ? Date.parse(live.auto.expires_at)
      : NaN;
  if (enabled && !Number.isFinite(expires))
    throw new Error("The running trading session has no readable expiry.");
  return {
    version: 1,
    enabled: enabled && expires > now,
    scope: live.scope,
    expires_at: enabled ? expires : null,
    updated_at: new Date(now).toISOString(),
  };
}
