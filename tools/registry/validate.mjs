#!/usr/bin/env node
// Validates every file in registry/mods/. Run by CI on pull requests that
// touch the registry, and by hand before you send one:
//
//     node tools/registry/validate.mjs
//     node tools/registry/validate.mjs --check-releases    (also hits GitHub)
//
// Exit code 0 = good to merge.

import {
  loadEntries, validateEntry, validateModpackEntry, resolveLatestRelease,
  HOME_REPO, MODPACKS_DIR,
} from './lib.mjs';

const args = new Set(process.argv.slice(2));
const checkReleases = args.has('--check-releases');

const RESET = '\u001b[0m';
const RED = process.stdout.isTTY || process.env.CI ? '\u001b[31m' : '';
const YELLOW = process.stdout.isTTY || process.env.CI ? '\u001b[33m' : '';
const GREEN = process.stdout.isTTY || process.env.CI ? '\u001b[32m' : '';

let failures = 0;
let warnings = 0;

const entries = await loadEntries();
if (entries.length === 0) {
  console.log('registry/mods/ is empty - nothing to validate.');
  process.exit(0);
}

const seenIds = new Map();
const seenFolders = new Map();
const ids = new Set(entries.map(({ entry }) => entry.id));

for (const { fileName, entry } of entries) {
  const problems = validateEntry(entry, fileName);

  // Cross-entry uniqueness. Two mods sharing an install folder would silently
  // overwrite each other inside the game's Mods/ directory.
  if (entry.id) {
    if (seenIds.has(entry.id)) problems.push(`duplicate id, already used by ${seenIds.get(entry.id)}`);
    else seenIds.set(entry.id, fileName);
  }
  if (entry.folder) {
    const key = entry.folder.toLowerCase();
    if (seenFolders.has(key)) problems.push(`install folder "${entry.folder}" is already taken by ${seenFolders.get(key)}`);
    else seenFolders.set(key, fileName);
  }
  for (const dep of entry.dependencies || []) {
    if (!ids.has(dep)) problems.push(`dependency "${dep}" is not in the registry`);
  }

  if (problems.length) {
    failures += problems.length;
    console.log(`${RED}✗ registry/mods/${fileName}${RESET}`);
    for (const p of problems) console.log(`    ${p}`);
    continue;
  }

  if (!checkReleases) {
    console.log(`${GREEN}✓${RESET} ${fileName}`);
    continue;
  }

  try {
    const release = await resolveLatestRelease(entry);
    if (release) {
      console.log(`${GREEN}✓${RESET} ${fileName} → ${entry.repo} ${release.tag} (${release.asset.name})`);
      if (entry.pending) {
        warnings++;
        console.log(`    ${YELLOW}note${RESET}: "pending" is set but a release exists - drop the flag so the mod shows up as installable.`);
      }
    } else if (entry.pending) {
      warnings++;
      console.log(`${YELLOW}·${RESET} ${fileName} → no release yet (marked "pending", that's fine)`);
    } else {
      failures++;
      console.log(`${RED}✗ registry/mods/${fileName}${RESET}`);
      console.log(`    no release of ${entry.repo} has an asset matching "${entry.asset}".`);
      console.log('    Publish a GitHub release with that file attached, or set "pending": true until you do.');
      if (entry.repo === HOME_REPO) {
        console.log('    (Mods bundled with this repo are published by tools/package-framework.sh.)');
      }
    }
  } catch (err) {
    failures++;
    console.log(`${RED}✗ registry/mods/${fileName}${RESET}`);
    console.log(`    ${err.message}`);
  }
}

// Modpacks: same treatment, minus the release checks (a pack has no release
// of its own - its members' releases were just checked above).
const packs = await loadEntries(MODPACKS_DIR);
const seenPackIds = new Map();
for (const { fileName, entry } of packs) {
  const problems = validateModpackEntry(entry, fileName, ids);
  if (entry.id) {
    if (seenPackIds.has(entry.id)) problems.push(`duplicate id, already used by ${seenPackIds.get(entry.id)}`);
    else seenPackIds.set(entry.id, fileName);
  }
  if (problems.length) {
    failures += problems.length;
    console.log(`${RED}✗ registry/modpacks/${fileName}${RESET}`);
    for (const p of problems) console.log(`    ${p}`);
  } else {
    console.log(`${GREEN}✓${RESET} modpacks/${fileName} (${entry.mods.length} mods)`);
  }
}

console.log('');
if (failures) {
  console.log(`${RED}${failures} problem(s) found in ${entries.length + packs.length} entries.${RESET}`);
  process.exit(1);
}
console.log(`${GREEN}All ${entries.length} registry entries${packs.length ? ` and ${packs.length} modpack(s)` : ''} look good.${RESET}${warnings ? ` (${warnings} note(s))` : ''}`);
