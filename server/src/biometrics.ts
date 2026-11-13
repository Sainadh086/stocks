import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { projectRoot } from "./shared/storage.js";

export type BiometricAction = "pair" | "privacy";
export interface BiometricVerifier {
  verify(action: BiometricAction): Promise<void>;
}
const execute = promisify(execFile);
export class MacBiometrics implements BiometricVerifier {
  private pending = false;
  async verify(action: BiometricAction) {
    if (this.pending)
      throw new Error(
        "Complete the current Touch ID prompt on your Mac first.",
      );
    const executable = join(projectRoot, ".local/biometrics/VarshanTouchID");
    if (process.platform !== "darwin" || !existsSync(executable))
      throw new Error(
        "Touch ID protection requires the Mac helper. Restart Varshan using run_varshan.sh on your Mac.",
      );
    this.pending = true;
    try {
      const { stdout } = await execute(executable, [action], {
        timeout: 60_000,
        maxBuffer: 4096,
      });
      const result: unknown = JSON.parse(stdout);
      if (
        !result ||
        typeof result !== "object" ||
        !("verified" in result) ||
        result.verified !== true
      ) {
        const message =
          result &&
          typeof result === "object" &&
          "message" in result &&
          typeof result.message === "string"
            ? result.message
            : "Touch ID verification failed. Nothing was changed.";
        throw new Error(message);
      }
    } catch (error) {
      if (error instanceof Error && !("code" in error)) throw error;
      throw new Error(
        "Touch ID could not complete. Unlock your Mac and try again; nothing was changed.",
      );
    } finally {
      this.pending = false;
    }
  }
}
