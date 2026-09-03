'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const publish = require('../src/main/publish');

// "Open submission on GitHub" builds a github.com/.../issues/new URL whose
// query parameters prefill the issue form, keyed by each field's `id` in the
// template. That breaks silently in two ways, and both shipped (#33): a form
// field the app never sends (the registry id was one), and a parameter GitHub
// reserves for itself - `repo` - which it drops without a word, leaving the
// field blank. These tests pin every parameter to a template field, every
// field to a parameter, and keep the reserved names out of the templates.

const TEMPLATES = path.join(__dirname, '..', '..', '..', '.github', 'ISSUE_TEMPLATE');

/**
 * Names github.com/<owner>/<repo>/issues/new interprets itself, so a template
 * field with one of these ids can never be prefilled. The first seven are
 * documented; `repo` is not, but it is eaten all the same.
 */
const RESERVED = new Set(['title', 'body', 'labels', 'milestone', 'assignees', 'projects', 'template', 'repo']);

/** ids of the fillable fields (input / textarea / dropdown) of a template, in order. */
function templateFieldIds(file) {
  const yaml = fs.readFileSync(path.join(TEMPLATES, file), 'utf8');
  const ids = [];
  for (const match of yaml.matchAll(/^ {2}- type: (\w+)\n(?: {4}#[^\n]*\n)* {4}id: ([\w-]+)/gm)) {
    if (match[1] !== 'markdown' && match[1] !== 'checkboxes') ids.push(match[2]);
  }
  return ids;
}

const paramsOf = (url) => new URL(url).searchParams;

test('a mod submission URL carries every field of the form, id and repository included', () => {
  const params = paramsOf(publish.submissionIssueUrl({
    name: 'One Way’s Gambit',
    id: 'one-ways-gambit',
    repo: 'someone/some-mod',
    asset: 'OneWaysGambit.zip',
    folder: 'OneWaysGambit',
    summary: 'Moving a piece to the right protects it.',
    tags: ['gameplay', 'gambits'],
  }));
  assert.equal(params.get('template'), 'mod-submission.yml');
  assert.equal(params.get('title'), '[Mod] One Way’s Gambit');
  assert.equal(params.get('mod-name'), 'One Way’s Gambit');
  assert.equal(params.get('mod-id'), 'one-ways-gambit');
  assert.equal(params.get('mod-repo'), 'someone/some-mod');
  assert.equal(params.get('asset'), 'OneWaysGambit.zip');
  assert.equal(params.get('folder'), 'OneWaysGambit');
  assert.equal(params.get('summary'), 'Moving a piece to the right protects it.');
  assert.equal(params.get('tags'), 'gameplay, gambits');
});

test('a half-filled form still opens a well-formed URL', () => {
  const params = paramsOf(publish.submissionIssueUrl({ tags: [] }));
  assert.equal(params.get('template'), 'mod-submission.yml');
  assert.equal(params.get('mod-id'), '');
  assert.equal(params.get('mod-repo'), '');
});

for (const [what, file, build] of [
  ['mod', 'mod-submission.yml', () => publish.submissionIssueUrl({ name: 'x' })],
  ['modpack', 'modpack-submission.yml', () => publish.modpackIssueUrl({ name: 'x' })],
]) {
  test(`every ${what} prefill parameter is a field of ${file}, and every field gets one`, () => {
    const ids = templateFieldIds(file);
    assert.ok(ids.length >= 3, `could not read the field ids out of ${file}`);
    const params = [...paramsOf(build()).keys()].filter((k) => k !== 'template' && k !== 'title');
    assert.deepEqual(params.filter((k) => !ids.includes(k)), [],
      'parameters that match no form field - GitHub ignores them');
    assert.deepEqual(ids.filter((id) => !params.includes(id)), [],
      'form fields the app never fills in');
  });

  test(`no field of ${file} has a name GitHub keeps for itself`, () => {
    assert.deepEqual(templateFieldIds(file).filter((id) => RESERVED.has(id)), []);
  });
}
