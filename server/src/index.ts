import { join } from "node:path";
import { createUnlockApp } from "./unlock-app.js";
import { Vault } from "./vault.js";
import { rememberedKey } from "./remembered-key.js";
import { processLock, store, US } from "./shared/storage.js";

const port = Number(process.env.PORT ?? 8000);
if (!Number.isInteger(port) || port < 1 || port > 65535)
  throw new Error("PORT must be a valid TCP port.");
const vault = new Vault(store, rememberedKey(store.root));
if (!vault.tryAutoUnlock()) {
  const release = processLock(join(US, ".varshan-node.lock"));
  let opened!: () => void;
  const ready = new Promise<void>((resolve) => {
    opened = resolve;
  });
  const gate = createUnlockApp(vault, opened);
  const stop = () => {
    void gate.close().finally(() => {
      release();
      process.exit(0);
    });
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    await gate.listen({ host: "127.0.0.1", port });
    console.log(
      `varshan desktop: http://127.0.0.1:${port} (enter your encryption password)`,
    );
    await ready;
    await gate.close();
  } finally {
    release();
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
  }
}
// No account state, broker connection or trading worker is loaded while locked.
await import("./runtime.js");
