import { execFileSync } from 'node:child_process';
import { mkdirSync, existsSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

if (process.platform === 'darwin') {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const directory = join(root, '.local', 'biometrics');
  const source = join(root, 'native', 'TouchID.swift');
  const executable = join(directory, 'VarshanTouchID');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (!existsSync(executable) || statSync(source).mtimeMs > statSync(executable).mtimeMs) {
    execFileSync('/usr/bin/xcrun', ['swiftc', source, '-o', executable, '-module-cache-path', join(directory, 'module-cache'), '-framework', 'LocalAuthentication', '-framework', 'AppKit'], { stdio: 'inherit' });
    execFileSync('/usr/bin/codesign', ['--force', '--sign', '-', executable], { stdio: 'inherit' });
  }
}
