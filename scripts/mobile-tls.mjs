import { randomBytes } from "node:crypto";
import { networkInterfaces, hostname } from "node:os";
import { execFileSync } from "node:child_process";
import { mkdirSync, existsSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("..", import.meta.url));
const directory = join(root, ".local", "mobile-tls");
mkdirSync(directory, { recursive: true, mode: 0o700 });
const addresses = Object.values(networkInterfaces()).flatMap((rows) =>
  (rows ?? [])
    .filter(
      (r) =>
        r.family === "IPv4" &&
        !r.internal &&
        /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(r.address),
    )
    .map((r) => r.address),
);
const caKey = join(directory, "root-key.pem"),
  ca = join(directory, "root-ca.pem");
const run = (args) => execFileSync("openssl", args, { stdio: "ignore" });
if (!existsSync(ca)) {
  run(["genrsa", "-out", caKey, "2048"]);
  writeFileSync(
    join(directory, "ca.cnf"),
    "[req]\ndistinguished_name=dn\nx509_extensions=ca\nprompt=no\n[dn]\nCN=Varshan Local Network CA\n[ca]\nbasicConstraints=critical,CA:true\nkeyUsage=critical,keyCertSign,cRLSign\nsubjectKeyIdentifier=hash\n",
    { mode: 0o600 },
  );
  run([
    "req",
    "-x509",
    "-new",
    "-key",
    caKey,
    "-sha256",
    "-days",
    "3650",
    "-out",
    ca,
    "-config",
    join(directory, "ca.cnf"),
  ]);
  run([
    "x509",
    "-in",
    ca,
    "-outform",
    "DER",
    "-out",
    join(directory, "root-ca.cer"),
  ]);
}
const certificate = join(directory, "server-cert.pem"),
  key = join(directory, "server-key.pem");
const sans = [
  "DNS:" +
    hostname()
      .toLowerCase()
      .replace(/\.local$/, "") +
    ".local",
  "DNS:localhost",
  "IP:127.0.0.1",
  "IP:::1",
  ...addresses.map((ip) => "IP:" + ip),
].join(",");
const configuration = `[req]\ndistinguished_name=dn\nprompt=no\n[dn]\nCN=Varshan\n[server]\nbasicConstraints=critical,CA:false\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName=${sans}\n`;
const config = join(directory, "server.cnf");
if (
  !existsSync(certificate) ||
  !existsSync(config) ||
  readFileSync(config, "utf8") !== configuration
) {
  writeFileSync(config, configuration, { mode: 0o600 });
  run(["genrsa", "-out", key, "2048"]);
  run([
    "req",
    "-new",
    "-key",
    key,
    "-out",
    join(directory, "server.csr"),
    "-config",
    config,
  ]);
  run([
    "x509",
    "-req",
    "-in",
    join(directory, "server.csr"),
    "-CA",
    ca,
    "-CAkey",
    caKey,
    "-CAcreateserial",
    "-out",
    certificate,
    "-days",
    "365",
    "-sha256",
    "-extfile",
    config,
    "-extensions",
    "server",
  ]);
}
// Phones must present an identity signed by this CA. The encrypted export is
// delivered only through the Touch ID protected desktop endpoint, never on LAN HTTP.
const phoneKey = join(directory, "phone-key.pem");
const phoneCert = join(directory, "phone-cert.pem");
const phoneExport = join(directory, "phone-identity.p12");
const phonePassword = join(directory, "phone-identity-password");
if (
  !existsSync(phoneExport) ||
  !existsSync(phonePassword) ||
  !existsSync(phoneCert) ||
  (() => {
    try {
      run(["x509", "-checkend", "86400", "-noout", "-in", phoneCert]);
      return false;
    } catch {
      return true;
    }
  })()
) {
  const clientConfig = join(directory, "phone.cnf");
  writeFileSync(
    clientConfig,
    "[req]\ndistinguished_name=dn\nprompt=no\n[dn]\nCN=Varshan Phone Identity\n[client]\nbasicConstraints=critical,CA:false\nkeyUsage=critical,digitalSignature\nextendedKeyUsage=clientAuth\n",
    { mode: 0o600 },
  );
  writeFileSync(phonePassword, randomBytes(24).toString("base64url"), {
    mode: 0o600,
  });
  run(["genrsa", "-out", phoneKey, "2048"]);
  run([
    "req",
    "-new",
    "-key",
    phoneKey,
    "-out",
    join(directory, "phone.csr"),
    "-config",
    clientConfig,
  ]);
  run([
    "x509",
    "-req",
    "-in",
    join(directory, "phone.csr"),
    "-CA",
    ca,
    "-CAkey",
    caKey,
    "-CAcreateserial",
    "-out",
    phoneCert,
    "-days",
    "365",
    "-sha256",
    "-extfile",
    clientConfig,
    "-extensions",
    "client",
  ]);
  run([
    "pkcs12",
    "-export",
    "-inkey",
    phoneKey,
    "-in",
    phoneCert,
    "-certfile",
    ca,
    "-name",
    "Varshan Phone Identity",
    "-out",
    phoneExport,
    "-passout",
    "file:" + phonePassword,
  ]);
}
for (const file of [caKey, key, phoneKey, phoneExport, phonePassword]) {
  const { chmodSync } = await import("node:fs");
  chmodSync(file, 0o600);
}
console.log(
  "Mobile HTTPS requires the trusted CA and a phone identity certificate. Export the password-protected identity from desktop Account settings using Touch ID.",
);
