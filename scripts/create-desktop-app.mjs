import { execFileSync } from "node:child_process";
import {
  accessSync,
  chmodSync,
  constants,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

if (process.platform !== "darwin") {
  console.error(
    "The app icon installer is for macOS. Use npm start on Windows/Linux.",
  );
  process.exit(1);
}
const root = fileURLToPath(new URL("../", import.meta.url));
const contents = join(root, "Varshan.app/Contents");
mkdirSync(join(contents, "MacOS"), { recursive: true });
mkdirSync(join(contents, "Resources"), { recursive: true });
mkdirSync(join(root, ".local"), { recursive: true });
const temp = mkdtempSync(join(root, ".local/app-icon-"));
const iconset = join(temp, "Varshan.iconset");
mkdirSync(iconset);
try {
  for (const size of [16, 32, 128, 256, 512]) {
    for (const scale of [1, 2]) {
      execFileSync(
        "/usr/bin/sips",
        [
          "-z",
          String(size * scale),
          String(size * scale),
          join(root, "frontend/public/icons/varshan-512.png"),
          "--out",
          join(iconset, `icon_${size}x${size}${scale === 2 ? "@2x" : ""}.png`),
        ],
        { stdio: "pipe" },
      );
    }
  }
  execFileSync("/usr/bin/iconutil", [
    "-c",
    "icns",
    iconset,
    "-o",
    join(contents, "Resources/Varshan.icns"),
  ]);
} finally {
  rmSync(temp, { recursive: true, force: true });
}
const quote = (value) => "'" + value.replaceAll("'", "'\\''") + "'";
const executable = join(contents, "MacOS/Varshan");
const launcher = join(contents, "Resources/launch.sh");
writeFileSync(
  launcher,
  `#!/bin/sh
set -eu
umask 077
cd ${quote(root)}
export PATH="$PWD/.tools/node/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
mkdir -p .local
if ! /bin/sh web.sh start >> .local/app-launch.log 2>&1; then
  /usr/bin/osascript -e 'display alert "Varshan could not start" message "Check .local/app-launch.log in your stocks project for details." as critical'
  exit 1
fi
/usr/bin/open "http://127.0.0.1:${"${PORT:-8000}"}"
`,
  { mode: 0o755 },
);
// Launch Services requires a native executable for a Finder app bundle.
execFileSync("/usr/bin/clang", ["-x", "c", "-Os", "-o", executable, "-"], {
  input: `#include <unistd.h>\nint main(void) { execl("/bin/sh", "sh", ${JSON.stringify(launcher)}, (char *)0); return 1; }\n`,
  stdio: ["pipe", "pipe", "pipe"],
});
chmodSync(executable, 0o755);
writeFileSync(
  join(contents, "Info.plist"),
  `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleName</key><string>Varshan</string>
<key>CFBundleDisplayName</key><string>Varshan</string>
<key>CFBundleIdentifier</key><string>local.varshan.desktop</string>
<key>CFBundleVersion</key><string>1</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleExecutable</key><string>Varshan</string>
<key>CFBundleIconFile</key><string>Varshan.icns</string>
<key>LSUIElement</key><true/>
</dict></plist>
`,
);
// Verify the generated bundle before presenting it as ready to click.
accessSync(executable, constants.X_OK);
accessSync(join(contents, "Resources/Varshan.icns"), constants.R_OK);
execFileSync("/bin/sh", ["-n", launcher]);
execFileSync("/usr/bin/plutil", ["-lint", join(contents, "Info.plist")], {
  stdio: "pipe",
});
console.log(
  `Created ${join(root, "Varshan.app")}\nDouble-click it in Finder, or drag it to the Dock. Keep the stocks folder in place.`,
);
