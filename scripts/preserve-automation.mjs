// One-time migration for the pre-persistence server, performed before stopping it.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { store } from "../server/dist/src/shared/storage.js";
import {
  automationPreferencePath,
  preferenceFromSnapshot,
} from "../server/dist/src/trading/automation.js";

if (
  !existsSync(automationPreferencePath) &&
  !existsSync(join(store.root, ".varshan-vault.json"))
) {
  try {
    const port = Number(process.env.PORT ?? 8000);
    if (!Number.isInteger(port) || port < 1 || port > 65535)
      throw new Error("Invalid local port.");
    const health = await fetch(`http://127.0.0.1:${port}/api/health`, {
      signal: AbortSignal.timeout(5000),
    });
    // Locked startup has not loaded workers or an in-memory trading choice.
    if (health.ok && (await health.json()).locked) process.exit(0);
    const response = await fetch(`http://127.0.0.1:${port}/api/live`, {
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok)
      throw new Error("Could not read the current trading choice.");
    const preference = preferenceFromSnapshot(await response.json());
    if (!existsSync(automationPreferencePath)) {
      store.save(automationPreferencePath, preference);
      console.log(
        `Preserved automatic trading choice: ${preference.enabled ? "on" : "off"}.`,
      );
    }
  } catch {
    console.error(
      "Could not preserve the running auto-trading choice. No server was stopped; retry the restart when the local API responds.",
    );
    process.exitCode = 1;
  }
}
