'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { pipeline } = require('node:stream/promises');
const { Readable } = require('node:stream');

const { MAX_DOWNLOAD_BYTES } = require('./config');
const log = require('./log');

// All network access funnels through here so the rules are in one auditable
// place. The manager writes DLLs into someone's game folder; the least it can
// do is refuse to fetch them from anywhere but GitHub.

/** Hosts we are willing to talk to at all. */
const ALLOWED_HOSTS = new Set([
  'api.github.com',
  'github.com',
  'codeload.github.com',
  'objects.githubusercontent.com',
  'release-assets.githubusercontent.com',
  'raw.githubusercontent.com',
  'user-images.githubusercontent.com',
  'avatars.githubusercontent.com',
  'bentrd.github.io',
]);

/** Hosts GitHub is allowed to redirect asset downloads to. */
const ALLOWED_REDIRECT_SUFFIX = '.githubusercontent.com';

const USER_AGENT = 'GambonanzaModManager';

class NetworkError extends Error {
  constructor(message, { status = 0, url = '' } = {}) {
    super(message);
    this.name = 'NetworkError';
    this.status = status;
    this.url = url;
  }
}

function assertAllowedUrl(rawUrl, { requireRepo = null } = {}) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new NetworkError(`not a valid URL: ${rawUrl}`);
  }
  if (url.protocol !== 'https:') {
    throw new NetworkError(`refusing a non-HTTPS URL: ${rawUrl}`);
  }
  const host = url.hostname.toLowerCase();
  if (!ALLOWED_HOSTS.has(host) && !host.endsWith(ALLOWED_REDIRECT_SUFFIX)) {
    throw new NetworkError(`refusing to download from ${host} - the manager only talks to GitHub`);
  }
  if (requireRepo) {
    // A mod entry claims a repo; the download must actually come from that
    // repo's releases. Without this, a registry entry could point at a
    // trustworthy-looking repo and serve a binary from somewhere else.
    const expected = `/${requireRepo}/releases/download/`.toLowerCase();
    const isRepoAsset = host === 'github.com' && url.pathname.toLowerCase().startsWith(expected);
    const isApiAsset = host === 'api.github.com'
      && url.pathname.toLowerCase().startsWith(`/repos/${requireRepo.toLowerCase()}/releases/assets/`);
    if (!isRepoAsset && !isApiAsset) {
      throw new NetworkError(`download URL does not belong to ${requireRepo}: ${rawUrl}`);
    }
  }
  return url;
}

function headers({ token, accept = 'application/json' } = {}) {
  const h = {
    accept,
    'user-agent': USER_AGENT,
  };
  if (token) h.authorization = `Bearer ${token}`;
  return h;
}

/**
 * Follow redirects by hand so every hop gets checked against the allowlist.
 * `fetch`'s automatic redirect handling would happily follow GitHub off to
 * anywhere it pointed us.
 */
async function fetchChecked(url, options = {}, { requireRepo = null, maxHops = 6 } = {}) {
  let current = assertAllowedUrl(url, { requireRepo }).toString();
  for (let hop = 0; hop < maxHops; hop++) {
    const res = await fetch(current, { ...options, redirect: 'manual' });
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get('location');
      if (!location) throw new NetworkError(`redirect with no destination from ${current}`, { status: res.status, url: current });
      // Redirect targets are only checked against the host allowlist: GitHub
      // hands asset downloads off to its CDN, which is not under /releases/.
      current = assertAllowedUrl(new URL(location, current).toString()).toString();
      continue;
    }
    return { res, url: current };
  }
  throw new NetworkError(`too many redirects starting at ${url}`);
}

/** GET JSON with a timeout. Returns { ok, status, data, etag }. */
async function getJson(url, { token, timeoutMs = 20000, etag = null, accept } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const h = headers({ token, accept: accept || 'application/vnd.github+json' });
    if (etag) h['if-none-match'] = etag;
    const { res } = await fetchChecked(url, { headers: h, signal: controller.signal });
    if (res.status === 304) return { ok: true, status: 304, data: null, etag };
    const nextEtag = res.headers.get('etag');
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      const message = describeHttpError(res, body, url);
      return { ok: false, status: res.status, error: message, data: null, etag: nextEtag };
    }
    return { ok: true, status: res.status, data: await res.json(), etag: nextEtag };
  } catch (err) {
    if (err.name === 'AbortError') {
      return { ok: false, status: 0, error: 'the request timed out - check your internet connection', data: null };
    }
    return { ok: false, status: 0, error: err.message, data: null };
  } finally {
    clearTimeout(timer);
  }
}

function describeHttpError(res, body, url) {
  if (res.status === 404) return `not found on GitHub (${url})`;
  if (res.status === 403 && /rate limit/i.test(body)) {
    const reset = Number(res.headers.get('x-ratelimit-reset'));
    const mins = reset ? Math.max(1, Math.ceil((reset * 1000 - Date.now()) / 60000)) : null;
    return `GitHub rate limit reached${mins ? ` - try again in about ${mins} minute${mins === 1 ? '' : 's'}` : ''}`;
  }
  if (res.status === 401) return 'GitHub rejected the sign-in - try signing in again';
  return `GitHub returned ${res.status} ${res.statusText || ''}`.trim();
}

/**
 * Download to a file, verifying size and (when given) SHA-256 before the
 * caller ever sees the path. Returns { path, bytes, sha256 }.
 *
 * The hash check is the whole security story for mod installs: CI hashed the
 * asset when a human reviewed the registry entry, and nothing gets unpacked
 * into the game folder unless the bytes still match.
 */
async function download(url, destPath, options = {}) {
  // One automatic retry for transient blips ("fetch failed", resets,
  // timeouts, 5xx) - the errors users saw and fixed by clicking again.
  // Deliberate refusals (checksum mismatch, 4xx, cancelled) never retry.
  try {
    return await downloadOnce(url, destPath, options);
  } catch (err) {
    const cancelled = options.signal?.aborted;
    const transient = !cancelled && (
      err.name !== 'NetworkError'
      || /timed out|returned 5\d\d/i.test(err.message)
    );
    if (!transient) throw err;
    log.warn('net', `download failed (${err.message}) - retrying once`);
    await new Promise((resolve) => setTimeout(resolve, 1500));
    return downloadOnce(url, destPath, options);
  }
}

async function downloadOnce(url, destPath, {
  token,
  onProgress,
  expectedSha256 = null,
  requireRepo = null,
  maxBytes = MAX_DOWNLOAD_BYTES,
  timeoutMs = 120000,
  signal,
} = {}) {
  await fsp.mkdir(path.dirname(destPath), { recursive: true });
  const tmpPath = `${destPath}.part`;
  await fsp.rm(tmpPath, { force: true });

  const controller = new AbortController();
  const onAbort = () => controller.abort();
  if (signal) {
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  }
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const { res, url: finalUrl } = await fetchChecked(
      url,
      { headers: headers({ token, accept: 'application/octet-stream' }), signal: controller.signal },
      { requireRepo },
    );
    if (!res.ok || !res.body) {
      throw new NetworkError(describeHttpError(res, '', url), { status: res.status, url });
    }

    const declared = Number(res.headers.get('content-length')) || 0;
    if (declared && declared > maxBytes) {
      throw new NetworkError(`download is ${(declared / 1e6).toFixed(1)} MB, which is larger than this app will accept`);
    }

    const hash = crypto.createHash('sha256');
    let received = 0;
    let lastReport = 0;

    const source = Readable.fromWeb(res.body);
    source.on('data', (chunk) => {
      received += chunk.length;
      hash.update(chunk);
      if (received > maxBytes) {
        source.destroy(new NetworkError('download exceeded the maximum allowed size'));
        return;
      }
      const now = Date.now();
      if (onProgress && (now - lastReport > 100 || received === declared)) {
        lastReport = now;
        onProgress({ received, total: declared });
      }
    });

    await pipeline(source, fs.createWriteStream(tmpPath));

    const sha256 = hash.digest('hex');
    if (expectedSha256 && sha256.toLowerCase() !== expectedSha256.toLowerCase()) {
      throw new NetworkError(
        'the downloaded file does not match the checksum in the registry. '
        + 'Nothing was installed. This usually means the release was re-uploaded; '
        + 'it can also mean the download was tampered with.',
      );
    }

    await fsp.rename(tmpPath, destPath);
    log.info('net', `downloaded ${path.basename(destPath)}`, { url: finalUrl, bytes: received, sha256: sha256.slice(0, 12) });
    if (onProgress) onProgress({ received, total: received });
    return { path: destPath, bytes: received, sha256 };
  } catch (err) {
    await fsp.rm(tmpPath, { force: true }).catch(() => {});
    if (err.name === 'AbortError') throw new NetworkError('the download was cancelled or timed out');
    throw err;
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onAbort);
  }
}

module.exports = {
  NetworkError,
  assertAllowedUrl,
  getJson,
  download,
  USER_AGENT,
  headers,
  fetchChecked,
};
