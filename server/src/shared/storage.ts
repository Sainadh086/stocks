import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  renameSync,
  openSync,
  fsyncSync,
  closeSync,
  rmSync,
  readdirSync,
  statSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "csv-parse/sync";
import { stringify } from "csv-stringify/sync";
export const ROOT = resolve(
  fileURLToPath(
    new URL(
      import.meta.url.includes("/server/dist/") ? "../../../../" : "../../../",
      import.meta.url,
    ),
  ),
);
// Compiled sources are one level deeper than sources.
export const projectRoot = ROOT;
export const INDIA = join(projectRoot, "india_stocks");
export const US = join(projectRoot, "us_stocks");
export const MAGIC = Buffer.from("STOCKS-ENCRYPTED-v1\n");
export type Row = Record<string, any>;
export function encrypt(
  data: Buffer,
  key: Buffer,
  timestamp = Math.floor(Date.now() / 1000),
  iv = randomBytes(16),
): Buffer {
  if (key.length !== 32) throw new Error("Invalid encryption key.");
  const header = Buffer.alloc(9);
  header[0] = 0x80;
  header.writeBigUInt64BE(BigInt(timestamp), 1);
  const cipher = createCipheriv("aes-128-cbc", key.subarray(16), iv);
  const body = Buffer.concat([header, iv, cipher.update(data), cipher.final()]);
  return Buffer.from(
    Buffer.concat([
      body,
      createHmac("sha256", key.subarray(0, 16)).update(body).digest(),
    ])
      .toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_"),
  );
}
export function decrypt(token: Buffer, key: Buffer): Buffer {
  const body = Buffer.from(token.toString().trim(), "base64url");
  if (key.length !== 32 || body.length < 73 || body[0] !== 0x80)
    throw new Error("Encrypted file could not be authenticated.");
  const message = body.subarray(0, -32),
    mac = body.subarray(-32);
  if (
    !timingSafeEqual(
      mac,
      createHmac("sha256", key.subarray(0, 16)).update(message).digest(),
    )
  )
    throw new Error("Encrypted file could not be authenticated.");
  const cipher = createDecipheriv(
    "aes-128-cbc",
    key.subarray(16),
    body.subarray(9, 25),
  );
  try {
    return Buffer.concat([
      cipher.update(body.subarray(25, -32)),
      cipher.final(),
    ]);
  } catch {
    throw new Error("Encrypted file could not be authenticated.");
  }
}
function walk(path: string): string[] {
  return existsSync(path)
    ? readdirSync(path).flatMap((n) => {
        const p = join(path, n);
        return statSync(p).isDirectory() ? walk(p) : [p];
      })
    : [];
}
/** Python's historical JSON writer allowed non-finite literals. Read them as
 * unavailable values without touching quoted strings or using code evaluation. */
export function parseSavedJson(content: string): unknown {
  // Current files are valid JSON. Only historical Python NaN/Infinity files
  // need the slower character-by-character compatibility parser.
  try {
    return JSON.parse(content);
  } catch {}
  let output = "",
    quoted = false,
    escaped = false;
  for (let i = 0; i < content.length; i++) {
    const char = content[i];
    if (quoted) {
      output += char;
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') quoted = false;
      continue;
    }
    if (char === '"') {
      quoted = true;
      output += char;
      continue;
    }
    const match = content.slice(i).match(/^(?:NaN|-?Infinity)(?=\s*[,}\]])/);
    if (match) {
      output += "null";
      i += match[0].length - 1;
    } else output += char;
  }
  return JSON.parse(output);
}
export class Storage {
  private key?: Buffer;
  constructor(
    readonly root = projectRoot,
    private readonly resolveKey?: () => Buffer,
  ) {}
  private encryptionKey(): Buffer {
    if (this.key) return this.key;
    if (this.resolveKey) return (this.key = this.resolveKey());
    const supplied = process.env.VARSHAN_ENCRYPTION_KEY;
    if (supplied !== undefined) {
      if (!/^[A-Za-z0-9+/_-]{43}=?$/.test(supplied))
        throw new Error(
          "VARSHAN_ENCRYPTION_KEY must encode exactly 32 random bytes in base64.",
        );
      const key = Buffer.from(supplied, "base64url");
      if (key.length !== 32)
        throw new Error("Invalid environment encryption key.");
      return (this.key = key);
    }
    if (process.platform !== "darwin")
      throw new Error(
        "Set VARSHAN_ENCRYPTION_KEY to a base64-encoded 32-byte secret on Windows/Linux. Keep the same key to reopen encrypted files.",
      );
    const args = [
      "find-generic-password",
      "-s",
      "local-stock-portfolio",
      "-a",
      this.root,
      "-w",
    ];
    let encoded: string;
    try {
      encoded = execFileSync("/usr/bin/security", args, {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }).trim();
    } catch {
      const privatePaths = [
        join(this.root, ".env"),
        join(this.root, ".robinhood_oauth.enc"),
        ...walk(join(this.root, "india_stocks")),
        ...walk(join(this.root, "us_stocks")),
        ...walk(join(this.root, "backtests")),
      ];
      if (
        privatePaths.some(
          (p) =>
            existsSync(p) &&
            readFileSync(p).subarray(0, MAGIC.length).equals(MAGIC),
        )
      )
        throw new Error(
          "Encryption key is unavailable in macOS Keychain; restore access before opening encrypted files.",
        );
      encoded = randomBytes(32).toString("base64");
      execFileSync(
        "/usr/bin/security",
        [
          "add-generic-password",
          "-U",
          "-s",
          "local-stock-portfolio",
          "-a",
          this.root,
          "-w",
          encoded,
        ],
        { stdio: "pipe" },
      );
      if (
        execFileSync("/usr/bin/security", args, {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
        }).trim() !== encoded
      )
        throw new Error("Could not verify Keychain encryption key.");
    }
    const key = Buffer.from(encoded, "base64url");
    if (key.length !== 32) throw new Error("Invalid Keychain encryption key.");
    return (this.key = key);
  }
  read(path: string): string {
    const data = readFileSync(path);
    return (
      data.subarray(0, MAGIC.length).equals(MAGIC)
        ? decrypt(data.subarray(MAGIC.length), this.encryptionKey())
        : data
    ).toString("utf8");
  }
  write(path: string, content: string): void {
    const data = Buffer.concat([
      MAGIC,
      encrypt(Buffer.from(content), this.encryptionKey()),
    ]);
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const temp = join(
      dirname(path),
      `.encrypted-${randomBytes(12).toString("hex")}`,
    );
    const fd = openSync(temp, "wx", 0o600);
    try {
      writeFileSync(fd, data);
      fsyncSync(fd);
      closeSync(fd);
      renameSync(temp, path);
    } catch (error) {
      try {
        closeSync(fd);
      } catch {}
      throw error;
    } finally {
      rmSync(temp, { force: true });
    }
  }
  json<T>(path: string, fallback: T): T {
    return existsSync(path) ? (parseSavedJson(this.read(path)) as T) : fallback;
  }
  save(path: string, value: unknown): void {
    this.write(path, JSON.stringify(value));
  }
  csv(path: string): Row[] {
    if (!existsSync(path)) return [];
    const content = this.read(path);
    if (!content.trim()) return [];
    return parse(content, {
      columns: true,
      skip_empty_lines: true,
      cast: (
        value: string,
        context: { header: boolean; column: string | number },
      ) => {
        if (
          context.header ||
          [
            "symbol",
            "stock",
            "buy",
            "sell",
            "exchange",
            "account_number",
          ].includes(String(context.column))
        )
          return value;
        if (value === "" || ["NaN", "Infinity", "-Infinity"].includes(value))
          return null;
        if (value === "True" || value === "true") return true;
        if (value === "False" || value === "false") return false;
        return Number.isFinite(Number(value)) ? Number(value) : value;
      },
    });
  }
  saveCsv(path: string, rows: Row[]): void {
    // Empty screens still need a valid, readable CSV, as pandas produced before migration.
    this.write(path, rows.length ? stringify(rows, { header: true }) : "\n");
  }
  setting(name: string): string {
    if (process.env[name]) return process.env[name]!;
    const path = join(this.root, ".env");
    if (existsSync(path)) {
      for (const line of this.read(path).split("\n")) {
        const m = line
          .trim()
          .replace(/^export\s+/, "")
          .match(/^([^=]+)=(.*)$/);
        if (m?.[1].trim() === name)
          return m[2].trim().replace(/^['"]|['"]$/g, "");
      }
    }
    throw new Error(
      `Missing ${name}. Set it in stocks/.env or the environment.`,
    );
  }
}
export const store = new Storage();
export function latest(directory: string, prefix: string): string | undefined {
  return existsSync(directory)
    ? readdirSync(directory)
        .filter((n) => n.startsWith(prefix))
        .sort()
        .map((n) => join(directory, n))
        .at(-1)
    : undefined;
}
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Request failed.";
}
export class Mutex {
  private tail: Promise<void> = Promise.resolve();
  async run<T>(action: () => Promise<T> | T): Promise<T> {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const prior = this.tail;
    this.tail = prior.then(() => gate);
    await prior;
    try {
      return await action();
    } finally {
      release();
    }
  }
}
export function processLock(path: string): () => void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      mkdirSync(path, { mode: 0o700 });
      writeFileSync(join(path, "pid"), String(process.pid), { mode: 0o600 });
      return () => rmSync(path, { recursive: true, force: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const pid = Number(
        existsSync(join(path, "pid"))
          ? readFileSync(join(path, "pid"), "utf8")
          : 0,
      );
      if (!pid)
        throw new Error(
          "Server lock is incomplete; inspect it before restarting.",
        );
      try {
        process.kill(pid, 0);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "ESRCH") {
          rmSync(path, { recursive: true });
          continue;
        }
        throw e;
      }
      throw new Error("Another varshan Node server is already running.");
    }
  }
  throw new Error("Unable to acquire server lock.");
}
