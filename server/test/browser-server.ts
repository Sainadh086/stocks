/** Browser tests exercise the real HTTP/static server with no access to broker credentials. */
import { createApp } from "../src/app.js";
import type { Service } from "../src/service.js";
const inert = {
  start() {},
  async close() {},
  error(e: unknown) {
    return e instanceof Error ? e.message : "Test server request failed";
  },
  touch() {},
  disconnect() {},
} as unknown as Service;
const app = await createApp(inert);
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.once(signal, () => {
    void app.close().then(() => process.exit(0));
  });
await app.listen({ host: "127.0.0.1", port: Number(process.env.PORT ?? 8002) });
