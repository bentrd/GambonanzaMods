#!/usr/bin/env node
// Static share pages: one tiny HTML file per registry entry, written into the
// assembled site at /<type>/<id>/ by the Pages deploy (pages.yml). They exist
// for the crawlers Discord/Slack/Twitter send at a pasted link - those read
// OG tags without running a line of JavaScript, so the single-page site's
// #/mod/<id> routes would all unfurl as the generic homepage card. Each stub
// carries the entry's own title/description/image, then bounces a human
// straight to the live route (which has the "Open in Mod Manager" button).
//
//   node tools/make-site-pages.mjs <assembled-site-dir>

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const SITE = 'https://bentrd.github.io/GambonanzaMods';

/** Same id shape the registry schemas enforce. An id is about to become a
 *  filesystem path and an HTML attribute - nothing else gets to. */
const ID_RE = /^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/;

const esc = (value) => String(value ?? '').replace(/[&<>"']/g,
  (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function stub({ type, entry, label }) {
  const url = `${SITE}/${type}/${entry.id}/`;
  const target = `${SITE}/#/${type}/${entry.id}`;
  // Texture packs can bring their own screenshot; everything else gets the
  // site mark. raw.githubusercontent.com is the one host the registry allows.
  const image = type === 'texturepack' && /^https:\/\/raw\.githubusercontent\.com\//.test(entry.preview || '')
    ? entry.preview
    : `${SITE}/favicon.png`;
  const title = `${entry.name} — Gambonanza Mods`;
  const desc = `${label} by ${entry.author}${entry.summary ? ` · ${entry.summary}` : ''}`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${esc(title)}</title>
<meta name="description" content="${esc(desc)}">
<meta property="og:type" content="website">
<meta property="og:site_name" content="Gambonanza Mods">
<meta property="og:title" content="${esc(entry.name)}">
<meta property="og:description" content="${esc(desc)}">
<meta property="og:image" content="${esc(image)}">
<meta property="og:url" content="${esc(url)}">
<meta name="twitter:card" content="summary">
<meta name="theme-color" content="#3a1521">
<link rel="icon" href="${SITE}/favicon.png" type="image/png">
<meta http-equiv="refresh" content="0;url=${esc(target)}">
<style>body{background:#3a1521;color:#f4e5c2;font-family:system-ui,sans-serif;display:grid;place-items:center;min-height:100vh;margin:0}a{color:#f4c530}</style>
</head>
<body>
<p><a href="${esc(target)}">${esc(entry.name)}</a></p>
<script>location.replace(${JSON.stringify(target)});</script>
</body>
</html>
`;
}

const outRoot = process.argv[2];
if (!outRoot) {
  console.error('usage: node tools/make-site-pages.mjs <assembled-site-dir>');
  process.exit(1);
}

const index = JSON.parse(await readFile(path.join(outRoot, 'registry', 'index.json'), 'utf8'));
const collections = [
  ['mod', 'Mod', index.mods],
  ['modpack', 'Modpack', index.modpacks],
  ['texturepack', 'Texture pack', index.texturepacks],
];

let written = 0;
for (const [type, label, list] of collections) {
  for (const entry of list || []) {
    if (!entry?.id || !ID_RE.test(entry.id)) {
      console.warn(`skipping ${type} with unusable id: ${JSON.stringify(entry?.id)}`);
      continue;
    }
    const dir = path.join(outRoot, type, entry.id);
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'index.html'), stub({ type, entry, label }));
    written++;
  }
}
console.log(`wrote ${written} share pages into ${outRoot}`);
