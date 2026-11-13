import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ServerOptions } from "node:https";
import { projectRoot } from "./shared/storage.js";

export function mobileTlsOptions(
  directory = join(projectRoot, ".local/mobile-tls"),
): ServerOptions {
  return {
    key: readFileSync(join(directory, "server-key.pem")),
    cert: readFileSync(join(directory, "server-cert.pem")),
    ca: readFileSync(join(directory, "root-ca.pem")),
    requestCert: true,
    rejectUnauthorized: true,
    minVersion: "TLSv1.2",
  };
}

export function mobileIdentityPackage(
  directory = join(projectRoot, ".local/mobile-tls"),
) {
  return {
    package: readFileSync(join(directory, "phone-identity.p12")).toString(
      "base64",
    ),
    password: readFileSync(
      join(directory, "phone-identity-password"),
      "utf8",
    ).trim(),
  };
}
