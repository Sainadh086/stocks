import { spawn } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const runtimeEnv = { ...process.env };
const pathKey =
  Object.keys(runtimeEnv).find((name) => name.toLowerCase() === "path") ??
  "PATH";
runtimeEnv[pathKey] =
  dirname(process.execPath) + delimiter + (runtimeEnv[pathKey] ?? "");
const toolingEnv = Object.fromEntries(
  Object.entries(runtimeEnv).filter(
    ([name]) => name.toUpperCase() !== "VARSHAN_ENCRYPTION_KEY",
  ),
);
const help = `Usage: npm start -- [--mobile | --check]
       npm run setup

Requires Node.js 22.12+ and npm on macOS, Windows or Linux.
Installs missing dependencies, builds the UI and API, then runs in the foreground.
Open http://127.0.0.1:8000 (override with PORT). Stop with Ctrl+C.

--mobile  Enable the existing Mac Touch ID and phone certificate setup.
--check   Validate configuration without installing, building or starting.
--setup   Reinstall locked dependencies and build, without starting the API.
--help    Show this help.

On Windows/Linux, supply VARSHAN_ENCRYPTION_KEY as a base64-encoded 32-byte
secret from your password manager. Keep the same key for subsequent launches.
macOS uses its existing Keychain unless this environment variable is provided.
See docs/running.md for setup and copying the app to another machine.`;

export function configuration({
  args = process.argv.slice(2),
  version = process.versions.node,
  platform = process.platform,
  env = process.env,
} = {}) {
  if (args.some((arg) => !["--mobile", "--check", "--setup"].includes(arg)))
    throw new Error("Unknown option. Run npm start -- --help.");
  const [major, minor] = version.split(".").map(Number);
  if (major < 22 || (major === 22 && minor < 12))
    throw new Error("Install Node.js 22.12 or newer, including npm.");
  const ports = [
    env.PORT ?? "8000",
    env.MOBILE_PORT ?? "8443",
    env.CERTIFICATE_PORT ?? "8080",
  ].map(Number);
  if (ports.some((port) => !Number.isInteger(port) || port < 1 || port > 65535))
    throw new Error(
      "PORT, MOBILE_PORT and CERTIFICATE_PORT must be valid TCP ports.",
    );
  if (new Set(ports).size !== ports.length)
    throw new Error("Desktop, mobile and certificate ports must differ.");
  const key = env.VARSHAN_ENCRYPTION_KEY;
  if (
    key !== undefined &&
    (!/^[A-Za-z0-9+/_-]{43}=?$/.test(key) ||
      Buffer.from(key, "base64url").length !== 32)
  )
    throw new Error(
      "VARSHAN_ENCRYPTION_KEY must encode exactly 32 random bytes in base64.",
    );
  const setup = args.includes("--setup");
  if (!setup && platform !== "darwin" && !key)
    throw new Error(
      "Set VARSHAN_ENCRYPTION_KEY before starting on Windows/Linux. See docs/running.md.",
    );
  const mobile = args.includes("--mobile") || env.VARSHAN_MOBILE === "1";
  if (mobile && platform !== "darwin")
    throw new Error(
      "Phone pairing requires macOS Touch ID. Omit --mobile and unset VARSHAN_MOBILE for desktop access.",
    );
  return { port: ports[0], setup, check: args.includes("--check"), mobile };
}

function npmCli() {
  const candidates = [
    process.env.npm_execpath,
    join(dirname(process.execPath), "npm"),
    join(dirname(process.execPath), "node_modules/npm/bin/npm-cli.js"),
    join(dirname(process.execPath), "../lib/node_modules/npm/bin/npm-cli.js"),
  ];
  for (const candidate of candidates) {
    if (!candidate || !existsSync(candidate)) continue;
    const path = realpathSync(candidate);
    if (path.endsWith("npm-cli.js")) return path;
  }
  throw new Error(
    "Could not find npm. Install Node.js with npm, then run npm start.",
  );
}

async function run(args, env = toolingEnv) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: root,
      env,
      stdio: "inherit",
    });
    const interrupt = () => child.kill("SIGINT");
    const terminate = () => child.kill("SIGTERM");
    process.on("SIGINT", interrupt);
    process.on("SIGTERM", terminate);
    const cleanup = () => {
      process.off("SIGINT", interrupt);
      process.off("SIGTERM", terminate);
    };
    child.once("error", (error) => {
      cleanup();
      reject(error);
    });
    child.once("exit", (code, signal) => {
      cleanup();
      resolveRun(code ?? (signal === "SIGINT" ? 130 : 143));
    });
  });
}

async function main() {
  if (process.argv.slice(2).some((arg) => ["--help", "-h"].includes(arg))) {
    console.log(help);
    return 0;
  }
  const options = configuration();
  const npm = npmCli();
  console.log(`Varshan: ${process.platform}, Node ${process.versions.node}`);
  console.log(`Workspace: ${root}`);
  console.log(`Desktop: http://127.0.0.1:${options.port}`);
  if (options.check) return 0;
  process.umask(0o077);
  for (const directory of ["server", "frontend"]) {
    if (options.setup || !existsSync(join(root, directory, "node_modules"))) {
      console.log(`Installing locked ${directory} dependencies…`);
      const code = await run([npm, "ci", "--prefix", directory]);
      if (code !== 0) return code;
    }
  }
  if (options.mobile) {
    for (const script of ["build-touch-id.mjs", "mobile-tls.mjs"]) {
      const code = await run([join(root, "scripts", script)]);
      if (code !== 0) return code;
    }
  }
  for (const directory of ["server", "frontend"]) {
    const code = await run([npm, "--prefix", directory, "run", "build"]);
    if (code !== 0) return code;
  }
  if (options.setup) {
    console.log("Setup complete. Run npm start to launch Varshan.");
    return 0;
  }
  console.log("Starting the API and UI. Stop with Ctrl+C.");
  return run([join(root, "server/dist/src/index.js")], {
    ...runtimeEnv,
    VARSHAN_MOBILE: options.mobile ? "1" : "0",
  });
}

if (
  process.argv[1] &&
  pathToFileURL(realpathSync(resolve(process.argv[1]))).href === import.meta.url
) {
  try {
    process.exitCode = await main();
  } catch (error) {
    console.error(`Varshan could not start: ${error.message}`);
    process.exitCode = 1;
  }
}
