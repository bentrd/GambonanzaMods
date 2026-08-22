// Unit tests for the parts of lib.mjs that read UNTRUSTED input: the two issue
// parsers and the validators standing behind them. Everything else in this
// file talks to GitHub and is covered by validate.mjs running in CI.
//
//     node --test tools/registry/lib.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  parseSubmissionIssue, parseModpackSubmissionIssue, validateModpackEntry,
} from './lib.mjs';

/** GitHub renders an issue form as "### <label>\n\n<value>" blocks. */
const form = (fields) => Object.entries(fields)
  .map(([label, value]) => `### ${label}\n\n${value || '_No response_'}\n`)
  .join('\n');

const MODS = new Set(['kamikaze-gambit', 'spikes-gambit', 'en-passant']);
const SKINS = new Set(['midnight-chess']);

/** The parsed entry a submitter's form would produce. */
const parsePack = (over = {}, context = { author: 'ben-gambo', createdAt: '2026-08-22T10:00:00Z' }) =>
  parseModpackSubmissionIssue(packForm(over), context);

const packForm = (over = {}) => form({
  'Pack name': 'My Perfect Loadout',
  'Registry id': '',
  'Mods in the pack': 'kamikaze-gambit, spikes-gambit',
  'Texture pack': 'midnight-chess',
  'One-line summary': 'Everything you need for a chaos-gambit run.',
  'Longer description': '',
  ...over,
});

test('a modpack form parses into a registry entry', () => {
  const entry = parseModpackSubmissionIssue(packForm(), { author: 'ben-gambo', createdAt: '2026-08-22T10:00:00Z' });
  assert.deepEqual(entry, {
    id: 'my-perfect-loadout',
    name: 'My Perfect Loadout',
    author: 'ben-gambo',
    summary: 'Everything you need for a chaos-gambit run.',
    mods: ['kamikaze-gambit', 'spikes-gambit'],
    texturepack: 'midnight-chess',
    submittedBy: 'ben-gambo',
    addedAt: '2026-08-22',
  });
  assert.equal(validateModpackEntry(entry, 'my-perfect-loadout.json', MODS, SKINS).length, 0);
});

test('an explicit registry id wins over the derived one', () => {
  const entry = parsePack({ 'Registry id': 'Chaos Run!' });
  assert.equal(entry.id, 'chaos-run');
});

test('the two forms never claim each other', () => {
  const modForm = form({
    'Mod name': 'Kamikaze Gambit',
    'GitHub repository': 'https://github.com/ben/kamikaze.git',
    'Release asset': 'Kamikaze.zip',
    'Install folder': 'Kamikaze',
    'One-line summary': 'It explodes.',
  });
  assert.equal(parseModpackSubmissionIssue(modForm), null);
  assert.equal(parseSubmissionIssue(packForm()), null);
  // And neither form matches an ordinary issue.
  assert.equal(parseModpackSubmissionIssue('Hey, the game crashes on launch'), null);
  assert.equal(parseModpackSubmissionIssue(''), null);
  assert.equal(parseModpackSubmissionIssue(null), null);
});

test('a texture pack on its own is a valid modpack', () => {
  const entry = parsePack({ 'Mods in the pack': '' });
  assert.deepEqual(entry.mods, []);
  assert.equal(validateModpackEntry(entry, `${entry.id}.json`, MODS, SKINS).length, 0);
});

test('a modpack with nothing in it is refused', () => {
  const entry = parsePack({ 'Mods in the pack': '', 'Texture pack': '' });
  assert.equal(entry.texturepack, undefined);
  const problems = validateModpackEntry(entry, `${entry.id}.json`, MODS, SKINS);
  assert.match(problems.join(' '), /at least one mod, or a texture pack/);
});

test('members must already be listed - a pack cannot invent one', () => {
  const entry = parsePack({ 'Mods in the pack': 'kamikaze-gambit, not-a-real-mod' });
  assert.match(validateModpackEntry(entry, `${entry.id}.json`, MODS, SKINS).join(' '), /"not-a-real-mod" is not in the registry/);

  const skin = parsePack({ 'Texture pack': 'not-a-real-skin' });
  assert.match(validateModpackEntry(skin, `${skin.id}.json`, MODS, SKINS).join(' '), /texture pack "not-a-real-skin" is not in the registry/);
});

test('an unreviewed member is allowed - the manager warns instead', () => {
  const entry = parsePack({ 'Mods in the pack': 'en-passant' });
  assert.deepEqual(validateModpackEntry(entry, `${entry.id}.json`, MODS, SKINS), []);
});

test('malformed and duplicated ids are caught', () => {
  const dupe = parsePack({ 'Mods in the pack': 'kamikaze-gambit, kamikaze-gambit' });
  assert.match(validateModpackEntry(dupe, `${dupe.id}.json`, MODS, SKINS).join(' '), /listed twice/);

  const bad = parsePack({ 'Mods in the pack': '../../etc/passwd' });
  assert.match(validateModpackEntry(bad, `${bad.id}.json`, MODS, SKINS).join(' '), /is malformed|not in the registry/);
});

test('the file name must match the id', () => {
  const entry = parsePack();
  assert.match(validateModpackEntry(entry, 'something-else.json', MODS, SKINS).join(' '), /file name must match the id/);
});

test('unknown fields are refused, so a typo is never silently ignored', () => {
  const problems = validateModpackEntry({
    id: 'x-y', name: 'Xy', author: 'a', summary: 'eight chars', mods: ['kamikaze-gambit'], texturepacks: 'oops',
  }, 'x-y.json', MODS, SKINS);
  assert.match(problems.join(' '), /unknown field "texturepacks"/);
});

test('caps hold: 24 mods and the length limits', () => {
  const many = Array.from({ length: 25 }, (_, i) => `mod-${i}`);
  const problems = validateModpackEntry({
    id: 'x-y', name: 'Xy', author: 'a', summary: 'eight chars', mods: many,
  }, 'x-y.json', null, null);
  assert.match(problems.join(' '), /at most 24 entries/);

  const long = validateModpackEntry({
    id: 'x-y', name: 'Xy', author: 'a', summary: 'short', mods: ['kamikaze-gambit'],
  }, 'x-y.json', MODS, SKINS);
  assert.match(long.join(' '), /"summary" is too short/);
});
