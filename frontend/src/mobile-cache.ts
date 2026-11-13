import type { QueryClient, QueryKey } from "@tanstack/react-query";
const allowed = new Set([
  "portfolios",
  "comparisons",
  "comparison",
  "weekly",
  "weekly-events",
  "markets",
  "indices",
  "learning",
  "recommendations",
  "replacements",
]);
let database: Promise<IDBDatabase> | null = null;
function db() {
  database ??= new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open("varshan-mobile-cache", 1);
    request.onupgradeneeded = () => request.result.createObjectStore("cache");
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  }).catch((error) => {
    database = null;
    throw error;
  });
  return database;
}
async function read<T>(key: string): Promise<T | undefined> {
  const database = await db();
  return new Promise((resolve, reject) => {
    const r = database.transaction("cache").objectStore("cache").get(key);
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}
async function write(key: string, value: unknown) {
  const database = await db();
  return new Promise<void>((resolve, reject) => {
    const t = database.transaction("cache", "readwrite");
    t.objectStore("cache").put(value, key);
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
  });
}
export async function clearMobileCache() {
  try {
    const database = await db();
    await new Promise<void>((resolve, reject) => {
      const t = database.transaction("cache", "readwrite");
      t.objectStore("cache").clear();
      t.oncomplete = () => resolve();
      t.onerror = () => reject(t.error);
    });
  } catch {
    /* Storage restrictions never prevent unpairing. */
  }
}
interface Snapshot {
  scope: string;
  expires: number;
  iv: Uint8Array<ArrayBuffer>;
  encrypted: ArrayBuffer;
}
export async function startMobileCache(
  client: QueryClient,
  scope: string,
  expires: number,
) {
  if (!Number.isFinite(expires) || expires <= Date.now()) return () => {};
  let key = await read<CryptoKey>("key");
  if (!key) {
    key = await crypto.subtle.generateKey(
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt", "decrypt"],
    );
    await write("key", key);
  }
  const encryptionKey = key;
  const saved = await read<Snapshot>("snapshot");
  if (saved && saved.scope === scope && saved.expires > Date.now()) {
    try {
      const plain = await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: saved.iv },
        key,
        saved.encrypted,
      );
      for (const entry of JSON.parse(new TextDecoder().decode(plain)) as {
        key: QueryKey;
        data: unknown;
        updated: number;
      }[]) {
        if (allowed.has(String(entry.key[0])) && Number.isFinite(entry.updated))
          client.setQueryData(entry.key, entry.data, {
            updatedAt: entry.updated,
          });
      }
    } catch {
      /* Invalid cache falls back to fresh backend data. */
    }
  }
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let chain = Promise.resolve();
  const unsubscribe = client.getQueryCache().subscribe((event) => {
    if (
      event.type !== "updated" ||
      !allowed.has(String(event.query.queryKey[0]))
    )
      return;
    clearTimeout(timer);
    timer = setTimeout(() => {
      chain = chain
        .then(async () => {
          if (stopped || Date.now() >= expires) return;
          const entries = client
            .getQueryCache()
            .getAll()
            .filter(
              (q) =>
                allowed.has(String(q.queryKey[0])) &&
                q.state.status === "success",
            )
            .map((q) => ({
              key: q.queryKey,
              data: q.state.data,
              updated: q.state.dataUpdatedAt,
            }));
          const plain = new TextEncoder().encode(JSON.stringify(entries));
          if (plain.byteLength > 2_000_000) return;
          const iv = crypto.getRandomValues(new Uint8Array(12));
          const encrypted = await crypto.subtle.encrypt(
            { name: "AES-GCM", iv },
            encryptionKey,
            plain,
          );
          if (!stopped && Date.now() < expires)
            await write("snapshot", { scope, expires, iv, encrypted });
        })
        .catch(() => {});
    }, 250);
  });
  return () => {
    stopped = true;
    clearTimeout(timer);
    unsubscribe();
  };
}
export function savePreferenceCookie(theme: string, privacy: boolean) {
  document.cookie = `varshan_preferences=${encodeURIComponent(JSON.stringify({ theme, privacy }))}; Path=/; Max-Age=43200; SameSite=Strict${location.protocol === "https:" ? "; Secure" : ""}`;
}
export function cachedThemeCookie() {
  try {
    const cookie = document.cookie
      .split(";")
      .map((value) => value.trim())
      .find((value) => value.startsWith("varshan_preferences="));
    const parsed = JSON.parse(
      decodeURIComponent(cookie?.slice("varshan_preferences=".length) ?? "{}"),
    );
    return typeof parsed.theme === "string" ? parsed.theme : null;
  } catch {
    return null;
  }
}
