"""Authenticated file encryption; the project key lives in macOS Keychain."""

import base64
import fcntl
import io
import json
import os
import tempfile
import threading
from contextlib import contextmanager
from functools import lru_cache
from pathlib import Path

from cryptography.fernet import Fernet, InvalidToken

from shared.paths import ENV_FILE, ROOT

MAGIC = b"STOCKS-ENCRYPTED-v1\n"
OAUTH_FILE = ROOT / ".robinhood_oauth.enc"
_oauth_lock = threading.Lock()


def setting(name: str) -> str | None:
    """Read environment overrides or the existing encrypted project .env file."""
    value = os.getenv(name)
    if value:
        return value
    if ENV_FILE.exists():
        for line in read_text(ENV_FILE).splitlines():
            line = line.strip()
            if line.startswith("export "):
                line = line[7:].lstrip()
            key, separator, value = line.partition("=")
            if separator and key.strip() == name:
                return value.strip().strip("\"'") or None
    return None


def require_setting(name: str) -> str:
    value = setting(name)
    if not value:
        raise RuntimeError(f"Missing {name}. Set it in stocks/.env or the environment.")
    return value


@lru_cache(maxsize=1)
def cipher():
    # Explicit backend prevents an insecure file-based keyring fallback.
    from keyring.backends.macOS import Keyring

    backend = Keyring()
    service = "local-stock-portfolio"
    account = str(ROOT)
    key = backend.get_password(service, account)
    if key is None:
        if any(path.read_bytes().startswith(MAGIC) for path in private_files()):
            raise RuntimeError(
                "Encryption key is missing from Keychain; restore it before opening encrypted files."
            )
        key = Fernet.generate_key().decode("ascii")
        backend.set_password(service, account, key)
        if backend.get_password(service, account) != key:
            raise RuntimeError("Could not verify the encryption key in macOS Keychain.")
    return Fernet(key.encode("ascii"))


def read_bytes(path):
    data = Path(path).read_bytes()
    if data.startswith(MAGIC):
        try:
            return cipher().decrypt(data[len(MAGIC) :])
        except InvalidToken as exc:
            raise RuntimeError(
                "Encrypted file could not be authenticated. Check the Keychain key."
            ) from exc
    return data  # Compatibility for public data and files awaiting migration.


def read_text(path):
    return read_bytes(path).decode("utf-8")


def write_bytes(path, data):
    path = Path(path)
    encrypted = MAGIC + cipher().encrypt(data)
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary = tempfile.mkstemp(prefix=".encrypted-", dir=path.parent)
    try:
        with os.fdopen(descriptor, "wb") as file:
            file.write(encrypted)
            file.flush()
            os.fsync(file.fileno())
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def write_text(path, content):
    write_bytes(path, content.encode("utf-8"))


@contextmanager
def open_text(path, mode="r"):
    if mode not in ("r", "w"):
        raise ValueError("Encrypted text files support r or w mode.")
    stream = io.StringIO(read_text(path) if mode == "r" else "")
    try:
        yield stream
    except BaseException:
        raise
    else:
        if mode == "w":
            write_text(path, stream.getvalue())
    finally:
        stream.close()


def read_csv(path, **kwargs):
    import pandas as pd

    return pd.read_csv(io.BytesIO(read_bytes(path)), **kwargs)


def write_csv(frame, path, **kwargs):
    write_text(path, frame.to_csv(**kwargs))


def private_files():
    patterns = [
        ".env",
        ".streamlit/secrets.toml",
        ".robinhood_oauth.enc",
        "india_stocks/kite_access_token.json",
        "india_stocks/portfolio_history.json",
        "india_stocks/portfolio_memory.md",
        "india_stocks/weekly_review_*.md",
        "india_stocks/zerodha_*.csv",
        "us_stocks/*holdings*.csv",
        "us_stocks/*connection*.json",
        "us_stocks/us_portfolio_*.csv",
        "india_stocks/*.csv",
        "india_stocks/*.json",
        "india_stocks/*.md",
        "us_stocks/*.csv",
        "us_stocks/*.json",
        "us_stocks/*.md",
        "backtests/**/*.csv",
        "backtests/**/*.json",
        "backtests/*.json",
        "backtests/*.csv",
    ]
    return sorted(
        {path for pattern in patterns for path in ROOT.glob(pattern) if path.is_file()}
    )


def migrate_files():
    cipher()  # Establish and verify Keychain access before modifying any file.
    count = 0
    for path in private_files():
        original = path.read_bytes()
        if original.startswith(MAGIC):
            read_bytes(path)  # Verify existing ciphertext too.
            continue
        stamp = path.stat().st_mtime_ns
        write_bytes(path, original)
        if read_bytes(path) != original:
            raise RuntimeError("Migration verification failed.")
        os.utime(path, ns=(stamp, stamp))
        count += 1
    return count


def migrate_oauth():
    """Import this endpoint's old OAuth files, then remove the verified originals."""
    import hashlib

    server_hash = hashlib.md5(b"https://agent.robinhood.com/mcp/trading").hexdigest()
    source = Path.home() / ".mcp-auth"
    files = [p for p in source.rglob(f"{server_hash}_*") if p.is_file()]
    if not files:
        return 0
    saved = json.loads(read_text(OAUTH_FILE)) if OAUTH_FILE.exists() else {}
    for path in files:
        saved[str(path.relative_to(source))] = base64.b64encode(
            path.read_bytes()
        ).decode("ascii")
    write_text(OAUTH_FILE, json.dumps(saved))
    verified = json.loads(read_text(OAUTH_FILE))
    for path in files:
        if (
            base64.b64decode(verified[str(path.relative_to(source))])
            != path.read_bytes()
        ):
            raise RuntimeError(
                "OAuth migration verification failed; originals preserved."
            )
    for path in files:
        path.unlink()
    return len(files)


@contextmanager
def oauth_environment(environment):
    """Unwrap OAuth only for the helper's lifetime and re-encrypt refreshed tokens."""
    with _oauth_lock:
        lock_path = ROOT / ".oauth.lock"
        descriptor = os.open(lock_path, os.O_CREAT | os.O_RDWR, 0o600)
        with os.fdopen(descriptor, "a") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX)
            with tempfile.TemporaryDirectory(prefix="stocks-oauth-") as temporary:
                directory = Path(temporary)
                if OAUTH_FILE.exists():
                    saved = json.loads(read_text(OAUTH_FILE))
                    for relative, encoded in saved.items():
                        path = directory / relative
                        if not path.resolve().is_relative_to(directory.resolve()):
                            raise RuntimeError("Invalid OAuth cache path.")
                        path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
                        path.write_bytes(base64.b64decode(encoded))
                        path.chmod(0o600)
                configured = dict(environment, MCP_REMOTE_CONFIG_DIR=temporary)
                try:
                    yield configured
                finally:
                    saved = {
                        str(p.relative_to(directory)): base64.b64encode(
                            p.read_bytes()
                        ).decode("ascii")
                        for p in directory.rglob("*")
                        if p.is_file() and not p.name.endswith((".lock", ".log"))
                    }
                    if saved:
                        write_text(OAUTH_FILE, json.dumps(saved))


if __name__ == "__main__":
    print(
        f"Encrypted {migrate_files()} project files; migrated {migrate_oauth()} Robinhood OAuth files."
    )
