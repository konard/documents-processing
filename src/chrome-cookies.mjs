// chrome-cookies.mjs — read and decrypt cookies from the local Chrome profile
// via the filesystem, and return them in the shape Playwright's addCookies()
// expects. This lets a browser-commander session reuse an existing Chrome login
// without re-authenticating.
//
// How Chrome stores cookies on each OS (values in the SQLite "Cookies" DB are
// encrypted; the key comes from the OS credential store):
//   macOS   — AES-128-CBC, key = PBKDF2(HMAC-SHA1, pass, "saltysalt", 1003, 16),
//             where `pass` is the "Chrome Safe Storage" password in the Keychain.
//   Linux   — AES-128-CBC, key = PBKDF2(pass, "saltysalt", 1, 16); `pass` is the
//             GNOME/KWallet secret, or the fixed fallback "peanuts".
// Encrypted values are prefixed with a version tag ("v10"/"v11"); the remainder
// is the IV-less ciphertext (IV is 16 spaces) padded PKCS#7.
//
// The Keychain/secret read is performed by the OS `security` tool, which prompts
// the user for authorization — this is the user's own credential store, accessed
// with their consent, to reuse their own session. Nothing is exfiltrated: the
// decrypted cookies are handed straight to the local browser session.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';

const CHROME_PROFILE_DIRS = [
  path.join(os.homedir(), 'Library/Application Support/Google/Chrome/Default'),
  path.join(os.homedir(), '.config/google-chrome/Default'),
  path.join(os.homedir(), '.config/chromium/Default'),
];

function findProfileDir() {
  return CHROME_PROFILE_DIRS.find((dir) => fs.existsSync(dir)) || null;
}

// Chrome keeps the cookie DB either at Default/Cookies or Default/Network/Cookies.
function findCookieDb(profileDir) {
  return [
    path.join(profileDir, 'Network', 'Cookies'),
    path.join(profileDir, 'Cookies'),
  ].find((file) => fs.existsSync(file));
}

// ---- key material ---------------------------------------------------------

// Cache the Safe Storage password for the lifetime of the process. macOS pops a
// Keychain authorization dialog on every distinct `security` read, so reading it
// more than once in a run means more than one prompt. Holding it here means at
// most one prompt per process, regardless of how many times cookies are read.
let safeStoragePasswordCache = null;

// Where the on-disk password cache lives, so the Keychain prompt is shared
// ACROSS separate script runs (not just within one process). Kept in the same
// data/ dir as the cookie cache (git-ignored) with restrictive permissions.
function passwordCacheFile(cacheDir) {
  return path.join(cacheDir, '.chrome-safe-storage-key.json');
}

// Read the on-disk password cache if present and within TTL.
function readPasswordCache(cacheDir, ttlMinutes) {
  if (!cacheDir) {
    return null;
  }
  try {
    const file = passwordCacheFile(cacheDir);
    if (!fs.existsSync(file)) {
      return null;
    }
    const cached = JSON.parse(fs.readFileSync(file, 'utf8'));
    const ageMinutes = (Date.now() - cached.savedAt) / 60000;
    if (ageMinutes <= ttlMinutes && cached.password) {
      return { password: cached.password, iterations: cached.iterations };
    }
  } catch {
    /* corrupt/unreadable — fall through and re-read from the Keychain */
  }
  return null;
}

function writePasswordCache(cacheDir, value) {
  if (!cacheDir) {
    return;
  }
  try {
    fs.mkdirSync(cacheDir, { recursive: true });
    const file = passwordCacheFile(cacheDir);
    fs.writeFileSync(file, JSON.stringify({ savedAt: Date.now(), ...value }), {
      mode: 0o600, // owner-only; this holds a local secret
    });
    fs.chmodSync(file, 0o600);
  } catch {
    /* best-effort cache; a failure here just means the next run re-prompts */
  }
}

// The per-installation "Safe Storage" password from the OS credential store.
// Cached both in-process and on disk (data/, TTL) so the Keychain dialog appears
// at most once per TTL window across ALL of our scripts, not once per run.
function getSafeStoragePassword(cacheDir, ttlMinutes = 720) {
  if (safeStoragePasswordCache) {
    return safeStoragePasswordCache;
  }
  const fromDisk = readPasswordCache(cacheDir, ttlMinutes);
  if (fromDisk) {
    safeStoragePasswordCache = fromDisk;
    return fromDisk;
  }
  if (process.platform === 'darwin') {
    const result = spawnSync(
      'security',
      [
        'find-generic-password',
        '-w',
        '-s',
        'Chrome Safe Storage',
        '-a',
        'Chrome',
      ],
      { encoding: 'utf8' }
    );
    if (result.status !== 0 || !result.stdout) {
      throw new Error(
        'Could not read the Chrome Safe Storage password from the Keychain ' +
          '(authorization declined?).'
      );
    }
    safeStoragePasswordCache = {
      password: result.stdout.trim(),
      iterations: 1003,
    };
    writePasswordCache(cacheDir, safeStoragePasswordCache);
    return safeStoragePasswordCache;
  }
  // Linux: try the fixed fallback used when no secret service is configured.
  safeStoragePasswordCache = { password: 'peanuts', iterations: 1 };
  writePasswordCache(cacheDir, safeStoragePasswordCache);
  return safeStoragePasswordCache;
}

function deriveKey(password, iterations) {
  return crypto.pbkdf2Sync(password, 'saltysalt', iterations, 16, 'sha1');
}

// ---- decryption -----------------------------------------------------------

// Decrypt one Chrome-encrypted cookie value (a Buffer starting with v10/v11).
function decryptValue(encrypted, key) {
  if (!encrypted || encrypted.length === 0) {
    return '';
  }
  const prefix = encrypted.slice(0, 3).toString('latin1');
  if (prefix !== 'v10' && prefix !== 'v11') {
    // Not encrypted (older Chrome) — return as-is.
    return encrypted.toString('utf8');
  }
  const iv = Buffer.alloc(16, ' ');
  const ciphertext = encrypted.slice(3);
  const decipher = crypto.createDecipheriv('aes-128-cbc', key, iv);
  decipher.setAutoPadding(true);
  let decrypted = Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]);
  // Newer Chrome builds prepend a 32-byte SHA-256 domain hash to the plaintext.
  // Keep the tail only when it is fully printable; a value with no such hash
  // stays intact. Byte values are checked directly (no control-char regex).
  if (decrypted.length > 32) {
    const candidate = decrypted.slice(32);
    if (isPrintable(candidate)) {
      decrypted = candidate;
    }
  }
  return decrypted.toString('utf8');
}

// True when every byte is tab/newline/carriage-return or a printable ASCII char.
function isPrintable(buffer) {
  for (const byte of buffer) {
    const ok =
      byte === 9 || byte === 10 || byte === 13 || (byte >= 32 && byte <= 126);
    if (!ok) {
      return false;
    }
  }
  return true;
}

// ---- cache ----------------------------------------------------------------

// Decrypted cookies are cached so the Keychain prompt (and DB read) are limited
// to one per TTL window. The cache is keyed by domain filter and lives wherever
// the caller points cacheDir (data/, git-ignored).
function cacheFile(cacheDir, domainFilter) {
  const safe = domainFilter.replace(/[^a-z0-9.]/gi, '_') || 'all';
  return path.join(cacheDir, `chrome-cookies-${safe}.json`);
}

function readCache(file, ttlMinutes) {
  if (!fs.existsSync(file)) {
    return null;
  }
  try {
    const cached = JSON.parse(fs.readFileSync(file, 'utf8'));
    const ageMinutes = (Date.now() - cached.savedAt) / 60000;
    if (ageMinutes <= ttlMinutes && Array.isArray(cached.cookies)) {
      return cached.cookies;
    }
  } catch {
    /* corrupt cache — fall through and re-read */
  }
  return null;
}

// ---- public API -----------------------------------------------------------

// Read + decrypt cookies for hosts matching `domainFilter` (a substring, e.g.
// "google.com"). Returns Playwright-style cookie objects for addCookies().
//
// options.cacheDir  — when set, decrypted cookies are cached there and reused
//                     for options.ttlMinutes (default 720 = 12h), so the
//                     Keychain prompt appears only once per window.
// options.refresh   — force a fresh read, ignoring any cache.
export function readChromeCookies(domainFilter = '', options = {}) {
  const { cacheDir, ttlMinutes = 720, refresh = false } = options;

  if (cacheDir && !refresh) {
    const cached = readCache(cacheFile(cacheDir, domainFilter), ttlMinutes);
    if (cached) {
      return cached;
    }
  }

  const profileDir = findProfileDir();
  if (!profileDir) {
    throw new Error('No local Chrome profile found.');
  }
  const cookieDb = findCookieDb(profileDir);
  if (!cookieDb) {
    throw new Error(`No cookie database under ${profileDir}.`);
  }

  // Copy the DB first: Chrome keeps it open (locked) while running, so we read a
  // standalone snapshot and never touch the live file.
  const tmpDb = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), 'dp-cookies-')),
    'Cookies'
  );
  fs.copyFileSync(cookieDb, tmpDb);

  const { password, iterations } = getSafeStoragePassword(cacheDir, ttlMinutes);
  const key = deriveKey(password, iterations);

  let cookies;
  try {
    cookies = queryCookieRows(tmpDb, domainFilter)
      .map((row) => toPlaywrightCookie(row, key))
      .filter((cookie) => cookie && cookie.value);
  } finally {
    fs.rmSync(path.dirname(tmpDb), { recursive: true, force: true });
  }

  if (cacheDir) {
    fs.mkdirSync(cacheDir, { recursive: true });
    fs.writeFileSync(
      cacheFile(cacheDir, domainFilter),
      JSON.stringify({ savedAt: Date.now(), cookies }, null, 2)
    );
  }
  return cookies;
}

// Query the SQLite cookie DB with the sqlite3 CLI (no native dependency). Rows
// come back as tab-separated fields with the encrypted value hex-encoded.
function queryCookieRows(dbPath, domainFilter) {
  const where = domainFilter
    ? `WHERE host_key LIKE '%${domainFilter.replace(/'/g, "''")}%'`
    : '';
  const sql =
    'SELECT host_key, name, path, is_secure, is_httponly, expires_utc, ' +
    `hex(encrypted_value) FROM cookies ${where};`;
  const result = spawnSync('sqlite3', ['-separator', '\t', dbPath, sql], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(`sqlite3 failed: ${result.stderr || 'unknown error'}`);
  }
  return result.stdout
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [host, name, cookiePath, secure, httpOnly, expires, hexValue] =
        line.split('\t');
      return { host, name, cookiePath, secure, httpOnly, expires, hexValue };
    });
}

// Chrome stores expiry as microseconds since the Windows epoch (year 1601);
// convert to Unix seconds by subtracting the epoch offset.
function chromeTimeToUnix(expiresUtc) {
  const micros = Number(expiresUtc);
  if (!micros) {
    return -1; // session cookie
  }
  return Math.floor(micros / 1_000_000 - 11_644_473_600);
}

function toPlaywrightCookie(row, key) {
  const value = decryptValue(Buffer.from(row.hexValue, 'hex'), key);
  return {
    name: row.name,
    value,
    domain: row.host,
    path: row.cookiePath || '/',
    expires: chromeTimeToUnix(row.expires),
    httpOnly: row.httpOnly === '1',
    secure: row.secure === '1',
    sameSite: 'Lax',
  };
}
