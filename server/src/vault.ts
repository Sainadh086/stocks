import { createHmac, randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { decrypt, encrypt, Storage } from "./shared/storage.js";
import type { RememberedKey } from "./remembered-key.js";

const record = z.strictObject({
  version: z.literal(1),
  salt: z.string().regex(/^[a-f0-9]{32}$/),
  wrapped: z.string().min(100).max(300),
  key_check: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
});
const keyCheck = (key: Buffer) =>
  createHmac("sha256", key).update("varshan-vault-auto-open-v1").digest("hex");
const passwordValue = z
  .string()
  .min(12, "Use at least 12 characters.")
  .max(1024);
function derive(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(
      password,
      salt,
      32,
      { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 },
      (error, key) => {
        if (error) reject(error);
        else resolve(key);
      },
    );
  });
}

export class Vault {
  readonly path: string;
  constructor(
    private readonly storage: Storage,
    private readonly remembered?: RememberedKey,
  ) {
    this.path = join(storage.root, ".varshan-vault.json");
  }
  configured(): boolean {
    return existsSync(this.path);
  }
  tryAutoUnlock(): boolean {
    if (!this.configured()) return false;
    const key = this.remembered?.read();
    if (!key) return false;
    try {
      const saved = record.parse(JSON.parse(readFileSync(this.path, "utf8")));
      if (saved.key_check) {
        if (
          !timingSafeEqual(
            Buffer.from(saved.key_check, "hex"),
            Buffer.from(keyCheck(key), "hex"),
          )
        )
          return false;
      } else if (!this.storage.verifyKey(key)) return false;
      this.storage.unlock(key);
      return true;
    } catch {
      return false;
    } finally {
      key.fill(0);
    }
  }
  async setup(password: string, confirmation: string): Promise<void> {
    passwordValue.parse(password);
    if (password !== confirmation) throw new Error("Passwords do not match.");
    if (this.configured())
      throw new Error("A password is already configured. Unlock instead.");
    const key = this.storage.passwordSetupKey();
    const salt = randomBytes(16);
    const wrappingKey = await derive(password, salt);
    const saved = {
      version: 1,
      salt: salt.toString("hex"),
      wrapped: encrypt(key, wrappingKey).toString(),
      key_check: keyCheck(key),
    };
    wrappingKey.fill(0);
    this.remembered?.write(key);
    const fd = openSync(this.path, "wx", 0o600);
    try {
      writeFileSync(fd, JSON.stringify(saved));
      fsyncSync(fd);
    } catch (error) {
      rmSync(this.path, { force: true });
      throw error;
    } finally {
      closeSync(fd);
    }
    this.storage.unlock(key);
    key.fill(0);
  }
  async unlock(password: string): Promise<void> {
    passwordValue.parse(password);
    const saved = record.parse(JSON.parse(readFileSync(this.path, "utf8")));
    const wrappingKey = await derive(password, Buffer.from(saved.salt, "hex"));
    let key: Buffer;
    try {
      key = decrypt(Buffer.from(saved.wrapped), wrappingKey);
    } catch {
      throw new Error(
        "Incorrect password or damaged password file. Try again.",
      );
    } finally {
      wrappingKey.fill(0);
    }
    try {
      this.remembered?.write(key);
      this.storage.unlock(key);
    } finally {
      key.fill(0);
    }
  }
}
