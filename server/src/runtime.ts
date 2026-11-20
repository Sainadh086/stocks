import { mobileTlsOptions } from "./mobile-tls.js";
import { createApp } from "./app.js";
import { Service } from "./service.js";
import { MobileAccess, privateAddress, loopback } from "./mobile-access.js";
import { Notifications } from "./notifications.js";
import { MacBiometrics } from "./biometrics.js";
import { iphoneCertificateProfile } from "./mobile-certificate.js";
import { createServer } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { projectRoot } from "./shared/storage.js";
const port = Number(process.env.PORT ?? 8000),
  mobilePort = Number(process.env.MOBILE_PORT ?? 8443),
  certificatePort = Number(process.env.CERTIFICATE_PORT ?? 8080);
for (const value of [port, mobilePort, certificatePort])
  if (!Number.isInteger(value) || value < 1 || value > 65535)
    throw new Error("Ports must be valid TCP ports.");
if (new Set([port, mobilePort, certificatePort]).size !== 3)
  throw new Error("Desktop, mobile and certificate ports must differ.");
const directory = join(projectRoot, ".local/mobile-tls");
const service = new Service(),
  access = new MobileAccess(mobilePort, certificatePort),
  notifications = new Notifications();
const biometrics = new MacBiometrics();
const pruneNotifications = () =>
  notifications.retainOwners([
    "desktop",
    ...access.activeSessions().map((session) => String(session.hash)),
  ]);
service.setNotifier((...args) => {
  pruneNotifications();
  notifications.publish(...args);
});
const app = await createApp(service, { access, notifications, biometrics });
const servers = [app];
const mobileEnabled =
  process.env.VARSHAN_MOBILE !== "0" &&
  existsSync(join(directory, "server-cert.pem"));
const mobile = mobileEnabled
  ? await createApp(service, {
      access,
      notifications,
      biometrics,
      manageService: false,
      https: mobileTlsOptions(directory),
    })
  : null;
if (mobile) servers.push(mobile);
const certificates = mobile
  ? createServer((request, response) => {
      if (
        !privateAddress(request.socket.remoteAddress ?? "") &&
        !loopback(request.socket.remoteAddress ?? "")
      ) {
        response.writeHead(403);
        response.end();
        return;
      }
      if (!access.permittedHost(request.headers.host ?? "")) {
        response.writeHead(400);
        response.end();
        return;
      }
      if (request.method === "GET" && request.url === "/") {
        const mobileUrl =
          access.setup().urls[0] ?? `https://127.0.0.1:${mobilePort}`;
        response.writeHead(200, {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "no-store",
          "Referrer-Policy": "no-referrer",
        });
        response.end(
          `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"/><title>Varshan phone setup</title><style>body{font-family:system-ui;background:#f4f5f9;color:#202a43;max-width:560px;margin:8vh auto;padding:24px;line-height:1.7}main{background:white;padding:28px;border-radius:18px}a{color:#415ac6}li{margin:14px 0}</style></head><body><main><h1>Varshan on your phone</h1><ol><li>On iPhone, open this page in Safari and <a href="/varshan.mobileconfig">download the iPhone certificate profile</a>. Install it under Settings → General → VPN &amp; Device Management, then enable trust in Settings → General → About → Certificate Trust Settings. On Android, <a href="/certificate.cer">download the CA certificate</a> and install it using Security settings → Install a certificate → CA certificate (not VPN/app certificate).</li><li>On your Mac, open Account settings → Mobile &amp; security, download the password-protected phone identity using Touch ID, and transfer it to your phone using AirDrop or a USB connection. Install it as an identity certificate using the password shown on the Mac. This identity is required to connect.</li><li><a href="${mobileUrl}">Open your secure Varshan app</a>. On iPhone, use Share → Add to Home Screen and open the app from its icon. Android supports Chrome or an installed app.</li><li>Generate a pairing code in desktop Account settings → Mobile access. Enter it on your phone, then enable Trading notifications in Account settings.</li></ol><p>The computer running Varshan must remain awake and connected.</p></main></body></html>`,
        );
        return;
      }
      if (request.method === "GET" && request.url === "/varshan.mobileconfig") {
        response.writeHead(200, {
          "Content-Type": "application/x-apple-aspen-config",
          "Content-Disposition": "attachment; filename=varshan.mobileconfig",
          "Cache-Control": "no-store",
        });
        response.end(
          iphoneCertificateProfile(
            readFileSync(join(directory, "root-ca.cer")),
          ),
        );
        return;
      }
      if (request.method !== "GET" || request.url !== "/certificate.cer") {
        response.writeHead(404);
        response.end("Download the certificate from /certificate.cer");
        return;
      }
      response.writeHead(200, {
        "Content-Type": "application/x-x509-ca-cert",
        "Content-Disposition": "attachment; filename=varshan-local-ca.cer",
        "Cache-Control": "no-store",
      });
      response.end(readFileSync(join(directory, "root-ca.cer")));
    })
  : null;
let closing = false;
async function close() {
  if (closing) return;
  closing = true;
  clearInterval(retry);
  if (certificates) certificates.close();
  for (const server of [...servers].reverse()) await server.close();
  await notifications.close();
}
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.once(signal, () => {
    void close().then(() => process.exit(0));
  });
const retry = setInterval(() => {
  pruneNotifications();
  notifications.retry();
}, 60000);
retry.unref();
pruneNotifications();
notifications.start();
try {
  await app.listen({ host: "127.0.0.1", port });
  if (mobile) await mobile.listen({ host: "0.0.0.0", port: mobilePort });
  if (certificates)
    await new Promise<void>((resolve, reject) => {
      certificates.once("error", reject);
      certificates.listen(certificatePort, "0.0.0.0", resolve);
    });
  console.log(`varshan desktop: http://127.0.0.1:${port}`);
  for (const url of mobile ? access.setup().urls : [])
    console.log(`varshan mobile: ${url} (pair from desktop Account settings)`);
} catch (error) {
  await close();
  throw error;
}
