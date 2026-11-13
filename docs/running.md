# Running Varshan on another machine

The desktop UI and API run on macOS, Windows and Linux with **Node.js 22.12 or
newer and npm**. Install a supported Node.js LTS release that includes npm, then
open a terminal in the `stocks` folder. Python, Flutter, Docker and a global
TypeScript installation are not required.

## Start

On macOS, the existing macOS Keychain stores the encryption key:

```sh
npm start
```

On Windows or Linux, first supply `VARSHAN_ENCRYPTION_KEY` as a secret environment
variable. Generate a new key **once for a fresh workspace**:

```sh
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"
```

Save the generated value in your password manager and use that same value every
time you start this workspace. Prefer your password manager's environment-secret
injection. The following examples use a placeholder; never commit a real key or
put it in the app's `.env` file (that file can itself be encrypted).

Linux/macOS terminal:

```sh
export VARSHAN_ENCRYPTION_KEY='YOUR_SAVED_BASE64_KEY'
npm start
```

Windows PowerShell:

```powershell
$env:VARSHAN_ENCRYPTION_KEY = 'YOUR_SAVED_BASE64_KEY'
npm start
```

Open **http://127.0.0.1:8000** after the server reports `varshan desktop`.
The header's API indicator confirms whether the API is responding. Keep the
terminal open and stop with **Ctrl+C**.

The launcher installs locked server/frontend dependencies if their `node_modules`
folders are missing, builds both applications and starts the API, which serves
the UI. A failed install or build prevents startup and returns its exit code.
It works from folders containing spaces and does not require Unix shell tools.
Encryption keys are passed to the API, but excluded from npm/build scripts and
the Robinhood helper environment.

After changing dependencies or copying from a different operating system, run:

```sh
npm run setup
npm start
```

`setup` reinstalls packages from both committed lockfiles and builds both apps;
it does not start the server or connect broker accounts. Internet access is
needed for package installation and normal market/broker operations. Later
launches reuse installed packages. Broker credentials and account selections
are configured through Account settings as usual.

## Options

```sh
npm start -- --help
npm start -- --check
```

`--check` validates Node, npm, ports and encryption-key configuration without
installing packages, building, connecting brokers or starting a server.
It does not test Keychain access or broker connectivity.

Set `PORT` for a different desktop port. In a Unix terminal:

```sh
PORT=8001 npm start
```

In PowerShell:

```powershell
$env:PORT = '8001'
npm start
```

Desktop access binds to loopback; use the browser on the computer running the
app. The launcher does not replace an existing running server: stop it using
its original terminal or `sh web.sh stop` before starting another instance.

## macOS phone access and Touch ID

The portable launcher defaults to desktop access. To compile the existing
Touch ID helper and generate phone TLS certificates on a Mac:

```sh
npm start -- --mobile
```

This requires Apple's Swift command-line tools (`xcode-select --install`),
`openssl`, and enrolled Touch ID for protected operations. Existing certificate,
phone identity and pairing requirements still apply. `VARSHAN_MOBILE=1` also
enables this mode. The existing `sh web.sh start|stop|restart|status` commands
remain available on macOS, including background operation and log files.
`sh run_varshan.sh` remains the Mac foreground command.

Windows/Linux desktop access does not provide the Mac's Touch ID verification,
phone pairing, or automatic idle-sleep prevention. Protected operations remain
blocked when verification is unavailable, including turning privacy mode off
after enabling it. Keep the host awake when running trading workers.

## Copying the project and existing data

For a fresh installation, copy the source, `package.json`, `scripts`, `docs`,
`assets`, `native`, and both `server` and `frontend` projects with their lockfiles.
Include `server/data`, which contains the exchange session calendars.
Exclude `node_modules`, `dist`, `.tools`, `.local`, `.env`, `.robinhood_oauth*`,
`india_stocks`, `us_stocks`, `backtests`, logs and process locks. Dependencies,
build outputs, runtime folders and Mac certificates are machine-specific or
created as needed. Connect your broker accounts on the new machine.

Existing encrypted data requires its **original encryption key**. On macOS that
key belongs to the Keychain service `local-stock-portfolio`, with the old absolute
project path as its account. Moving the folder or computer does not move its
Keychain entry. Migrate that key securely and supply it through
`VARSHAN_ENCRYPTION_KEY` before opening copied private data. A new random key
cannot decrypt old files. The launcher never exports Keychain secrets, copies
broker sessions, deletes private data or rotates encryption keys automatically.

Copying saved trading state can include an unexpired automatic-trading choice.
Stop automation on the original computer before migration, and review the
copied account/session settings before starting the new machine. Avoid running
two copies against the same broker account.

## Launcher checks

```sh
npm run test:launcher
```

These isolated tests exercise configuration for all three OS families, setup,
dependency reuse, folders containing spaces, build failure and exit propagation.
They use fake build/API processes and never access real brokers or private data.
