import { execFileSync } from "node:child_process";
import { timingSafeEqual } from "node:crypto";

export interface RememberedKey {
  read(): Buffer | undefined;
  write(key: Buffer): void;
}

/** Remember only the random data key; the user's password is never stored. */
export function rememberedKey(root: string): RememberedKey {
  const args = ["-s", "local-stock-portfolio", "-a", root];
  const supplied = process.env.VARSHAN_ENCRYPTION_KEY;
  return {
    read() {
      try {
        const encoded =
          supplied ??
          (process.platform === "darwin"
            ? execFileSync(
                "/usr/bin/security",
                ["find-generic-password", ...args, "-w"],
                { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
              ).trim()
            : "");
        if (!/^[A-Za-z0-9+/_-]{43}=?$/.test(encoded)) return undefined;
        const key = Buffer.from(encoded, "base64url");
        return key.length === 32 ? key : undefined;
      } catch {
        return undefined;
      }
    },
    write(key) {
      const existing = this.read();
      if (existing && timingSafeEqual(existing, key)) return;
      if (supplied !== undefined)
        throw new Error(
          "VARSHAN_ENCRYPTION_KEY does not match this workspace. Remove the override before restoring its remembered key.",
        );
      if (process.platform !== "darwin") return;
      try {
        execFileSync(
          "/usr/bin/security",
          ["add-generic-password", "-U", ...args, "-w", key.toString("base64")],
          { stdio: "pipe" },
        );
        const saved = this.read();
        if (!saved || !timingSafeEqual(saved, key)) throw new Error();
      } catch {
        throw new Error(
          "Allow macOS Keychain access so Varshan can remember the encryption key.",
        );
      }
    },
  };
}
