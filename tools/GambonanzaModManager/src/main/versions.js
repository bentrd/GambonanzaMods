'use strict';

// Version comparison shared by the update checks. Kept separate (and pure) so
// the unit tests can hammer it without loading Electron.

/**
 * Compare two version-ish strings ("1.2.3", "v1.10", "manager-v2.0.1").
 * Returns >0 when a is newer, <0 when older, 0 when equal. Numeric segments
 * compare numerically; a pre-release suffix loses to the same core without
 * one ("1.2.0-rc1" < "1.2.0").
 */
function compareTags(a, b) {
  const parse = (v) => {
    const cleaned = String(v ?? '').trim().replace(/^[A-Za-z-]*v/i, '');
    const [core, ...pre] = cleaned.split(/[-+]/);
    return { parts: core.split('.'), pre: pre.join('-') };
  };
  const x = parse(a);
  const y = parse(b);
  for (let i = 0; i < Math.max(x.parts.length, y.parts.length); i++) {
    const xs = x.parts[i] ?? '0';
    const ys = y.parts[i] ?? '0';
    const xn = Number(xs);
    const yn = Number(ys);
    if (Number.isFinite(xn) && Number.isFinite(yn)) {
      if (xn !== yn) return xn - yn;
    } else if (xs !== ys) {
      return xs < ys ? -1 : 1;
    }
  }
  if (x.pre === y.pre) return 0;
  if (!x.pre) return 1;
  if (!y.pre) return -1;
  return x.pre < y.pre ? -1 : 1;
}

module.exports = { compareTags };
