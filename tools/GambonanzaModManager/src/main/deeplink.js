'use strict';

// gmm:// deep links - the app's address system. A link like gmm://mod/en-passant
// arrives from the OS (a click on the website, a Discord paste) and names one
// registry entry to show. Nothing else: a deep link never carries a download
// URL, a repo, or a file path, because links get pasted by strangers and the
// registry id is the one token that can only ever resolve to something a
// human already reviewed and listed. Everything beyond "which page?" stays
// the renderer's decision.

/** The pages a link can open. Matches the three registry collections. */
const TYPES = new Set(['mod', 'modpack', 'texturepack']);

/** Same shape the registry enforces on ids (see registry/schema.json). */
const ID_RE = /^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/;

/**
 * gmm://<type>/<id> -> { type, id }, or null for anything else - unknown
 * scheme, unknown type, malformed id, extra path segments, junk. Null means
 * "log it and move on"; a bad link must never throw on the app's front door.
 */
function parse(raw) {
  if (typeof raw !== 'string' || raw.length > 200) return null;
  let url;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== 'gmm:') return null;
  // gmm://mod/x parses as host "mod" + path "/x"; gmm:mod/x (no slashes) puts
  // everything in the path. Treat both the same, and ignore ?query / #hash.
  const segments = `${url.host}${url.pathname}`.toLowerCase().split('/').filter(Boolean);
  if (segments.length !== 2) return null;
  const [type, id] = segments;
  if (!TYPES.has(type) || !ID_RE.test(id)) return null;
  return { type, id };
}

module.exports = { parse };
