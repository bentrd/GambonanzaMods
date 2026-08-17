'use strict';

const { GITHUB_CLIENT_ID, HOME_REPO } = require('./config');
const net = require('./net');
const log = require('./log');

// "Publish your mod" for creators, built so the registry stays hosting-free:
// a creator's mod lives in *their* GitHub repo, its DLL is attached to *their*
// GitHub release, and the registry only ever stores a pointer. Submitting is
// therefore just "open a pull request adding one small JSON file", and the
// manager automates exactly that.
//
// Sign-in uses GitHub's device flow: the app shows an 8-character code, the
// creator types it into github.com/login/device in their browser, done. No
// client secret, no embedded browser, no password ever touches this app.
// Players never need any of this - it's for the Publish tab only.

const DEVICE_CODE_URL = 'https://github.com/login/device/code';
const TOKEN_URL = 'https://github.com/login/oauth/access_token';
/** public_repo = fork + branch + PR on public repositories. Nothing private. */
const OAUTH_SCOPE = 'public_repo';

function signInAvailable() {
  return !!GITHUB_CLIENT_ID;
}

/** Step 1: ask GitHub for a user code. Renderer shows code + URL. */
async function beginDeviceFlow() {
  if (!GITHUB_CLIENT_ID) throw new Error('sign-in is not configured in this build - use "open a pre-filled submission" instead');
  const res = await postForm(DEVICE_CODE_URL, { client_id: GITHUB_CLIENT_ID, scope: OAUTH_SCOPE });
  if (!res.device_code) throw new Error(res.error_description || 'GitHub did not issue a device code');
  return {
    deviceCode: res.device_code,
    userCode: res.user_code,
    verificationUri: res.verification_uri || 'https://github.com/login/device',
    interval: Math.max(5, Number(res.interval) || 5),
    expiresIn: Number(res.expires_in) || 900,
  };
}

/**
 * Step 2: poll until the user has typed the code (or gave up). Resolves to
 * { token, login }. The caller stores the token; we never log it.
 */
async function pollDeviceFlow({ deviceCode, interval, expiresIn }, { signal } = {}) {
  const deadline = Date.now() + expiresIn * 1000;
  let waitMs = interval * 1000;

  while (Date.now() < deadline) {
    if (signal?.aborted) throw new Error('sign-in cancelled');
    await sleep(waitMs, signal);

    const res = await postForm(TOKEN_URL, {
      client_id: GITHUB_CLIENT_ID,
      device_code: deviceCode,
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
    });

    if (res.access_token) {
      const login = await whoAmI(res.access_token);
      log.info('publish', `signed in to GitHub as ${login}`);
      return { token: res.access_token, login };
    }
    if (res.error === 'authorization_pending') continue;
    if (res.error === 'slow_down') { waitMs += 5000; continue; }
    if (res.error === 'expired_token') break;
    if (res.error === 'access_denied') throw new Error('sign-in was cancelled on GitHub');
    throw new Error(res.error_description || `GitHub sign-in failed (${res.error || 'unknown error'})`);
  }
  throw new Error('the sign-in code expired - try again');
}

async function whoAmI(token) {
  const res = await net.getJson('https://api.github.com/user', { token });
  if (!res.ok) throw new Error('GitHub accepted the sign-in but /user failed - try again');
  return res.data.login;
}

/** List the user's public repos, most recently pushed first, for the picker. */
async function listRepos(token) {
  const res = await net.getJson(
    'https://api.github.com/user/repos?per_page=100&sort=pushed&visibility=public&affiliation=owner,collaborator',
    { token },
  );
  if (!res.ok) throw new Error(res.error || 'could not list your repositories');
  return res.data
    .filter((r) => !r.private && !r.fork)
    .map((r) => ({
      fullName: r.full_name,
      description: r.description || '',
      pushedAt: r.pushed_at,
      defaultBranch: r.default_branch,
      stars: r.stargazers_count,
    }));
}

/** Releases of one repo with their assets, for the asset picker. */
async function listReleaseAssets(token, repo) {
  const res = await net.getJson(`https://api.github.com/repos/${repo}/releases?per_page=10`, { token });
  if (!res.ok) throw new Error(res.error || `could not list releases of ${repo}`);
  return res.data
    .filter((rel) => !rel.draft)
    .map((rel) => ({
      tag: rel.tag_name,
      prerelease: rel.prerelease,
      assets: (rel.assets || [])
        .filter((a) => /\.(zip|dll)$/i.test(a.name))
        .map((a) => ({ name: a.name, size: a.size })),
    }));
}

/**
 * The whole submission: fork GambonanzaMods (no-op when it exists), branch,
 * commit one JSON file, open the PR. Returns the PR URL. Shared by mod and
 * modpack submissions - the only differences are the file path and the words.
 */
async function submitRegistryFile(token, {
  branch, filePath, json, commitMessage, prTitle, prBody,
}, { onStep = () => {} } = {}) {
  const homeName = HOME_REPO.split('/')[1];
  const login = await whoAmI(token);

  onStep('Forking the registry');
  const fork = await api(token, 'POST', `/repos/${HOME_REPO}/forks`, {});
  const forkFullName = fork?.full_name || `${login}/${homeName}`;
  await waitForRepo(token, forkFullName);

  onStep('Finding the newest revision');
  const homeRepoMeta = await api(token, 'GET', `/repos/${HOME_REPO}`);
  const base = homeRepoMeta.default_branch || 'main';
  const baseRef = await api(token, 'GET', `/repos/${HOME_REPO}/git/ref/heads/${base}`);
  const baseSha = baseRef.object.sha;

  onStep('Creating a branch on your fork');
  // Push the base commit into the fork first so the branch can point at it
  // even when the fork is stale.
  await api(token, 'POST', `/repos/${forkFullName}/merge-upstream`, { branch: base }).catch(() => {});
  await api(token, 'POST', `/repos/${forkFullName}/git/refs`, {
    ref: `refs/heads/${branch}`,
    sha: baseSha,
  }).catch(async (err) => {
    // Branch exists from an earlier attempt - move it to the new base.
    if (!/already exists/i.test(err.message)) throw err;
    await api(token, 'PATCH', `/repos/${forkFullName}/git/refs/heads/${branch}`, { sha: baseSha, force: true });
  });

  onStep('Adding your file');
  const content = Buffer.from(`${JSON.stringify(json, null, 2)}\n`).toString('base64');
  const existing = await api(token, 'GET', `/repos/${forkFullName}/contents/${filePath}?ref=${branch}`).catch(() => null);
  await api(token, 'PUT', `/repos/${forkFullName}/contents/${filePath}`, {
    message: commitMessage,
    content,
    branch,
    ...(existing?.sha ? { sha: existing.sha } : {}),
  });

  onStep('Opening the pull request');
  const pr = await api(token, 'POST', `/repos/${HOME_REPO}/pulls`, {
    title: prTitle,
    body: prBody,
    head: `${login}:${branch}`,
    base,
    maintainer_can_modify: true,
  }).catch(async (err) => {
    if (/A pull request already exists/i.test(err.message)) {
      const open = await api(token, 'GET', `/repos/${HOME_REPO}/pulls?head=${login}:${branch}&state=open`);
      if (open?.[0]) return open[0];
    }
    throw err;
  });

  log.info('publish', `opened registry PR ${pr.html_url}`);
  return { url: pr.html_url, number: pr.number };
}

/** Submit one mod entry as registry/mods/<id>.json. */
function submitEntry(token, entry, opts = {}) {
  return submitRegistryFile(token, {
    branch: `registry/${entry.id}`,
    filePath: `registry/mods/${entry.id}.json`,
    json: entry,
    commitMessage: `registry: add ${entry.name}`,
    prTitle: `Registry: add ${entry.name}`,
    prBody: [
      `Adds **${entry.name}** by ${entry.author} to the mod registry.`,
      '',
      `- Repository: https://github.com/${entry.repo}`,
      `- Release asset: \`${entry.asset}\``,
      `- Install folder: \`${entry.folder}\``,
      '',
      '_Submitted from the Gambonanza Mod Manager._',
    ].join('\n'),
  }, opts);
}

/** Submit one modpack entry as registry/modpacks/<id>.json. */
function submitModpack(token, entry, opts = {}) {
  return submitRegistryFile(token, {
    branch: `registry/modpack-${entry.id}`,
    filePath: `registry/modpacks/${entry.id}.json`,
    json: entry,
    commitMessage: `registry: add modpack ${entry.name}`,
    prTitle: `Registry: add modpack ${entry.name}`,
    prBody: [
      `Adds the **${entry.name}** modpack by ${entry.author} to the registry.`,
      '',
      `Mods in the pack:`,
      ...entry.mods.map((id) => `- \`${id}\``),
      '',
      '_A modpack is metadata only - it bundles mods that are already in the registry._',
      '_Submitted from the Gambonanza Mod Manager._',
    ].join('\n'),
  }, opts);
}

async function waitForRepo(token, fullName) {
  for (let i = 0; i < 10; i++) {
    const res = await net.getJson(`https://api.github.com/repos/${fullName}`, { token });
    if (res.ok) return;
    await sleep(1500);
  }
  throw new Error(`the fork ${fullName} did not become ready - try again in a minute`);
}

/** Pre-filled new-issue URL for the no-sign-in path. */
function submissionIssueUrl(entry) {
  const params = new URLSearchParams({
    template: 'mod-submission.yml',
    title: `[Mod] ${entry.name || ''}`,
    'mod-name': entry.name || '',
    repo: entry.repo || '',
    asset: entry.asset || '',
    folder: entry.folder || '',
    summary: entry.summary || '',
    tags: (entry.tags || []).join(', '),
  });
  return `https://github.com/${HOME_REPO}/issues/new?${params.toString()}`;
}

/** Pre-filled new-issue URL for a modpack, for the no-sign-in path. */
function modpackIssueUrl(entry) {
  const params = new URLSearchParams({
    template: 'modpack-submission.yml',
    title: `[Modpack] ${entry.name || ''}`,
    'pack-name': entry.name || '',
    mods: (entry.mods || []).join(', '),
    summary: entry.summary || '',
    description: entry.description || '',
  });
  return `https://github.com/${HOME_REPO}/issues/new?${params.toString()}`;
}

// ---------------------------------------------------------------------------

async function api(token, method, apiPath, body) {
  const url = `https://api.github.com${apiPath}`;
  const { res } = await net.fetchChecked(url, {
    method,
    headers: {
      ...net.headers({ token }),
      accept: 'application/vnd.github+json',
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  const json = text ? JSON.parse(text) : null;
  if (!res.ok && res.status !== 202) {
    const detail = json?.errors?.map((e) => e.message).filter(Boolean).join('; ');
    throw new Error(json?.message ? `${json.message}${detail ? ` (${detail})` : ''}` : `GitHub returned ${res.status}`);
  }
  return json;
}

async function postForm(url, fields) {
  const { res } = await net.fetchChecked(url, {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded', 'user-agent': net.USER_AGENT },
    body: new URLSearchParams(fields).toString(),
  });
  if (!res.ok) throw new Error(`GitHub returned ${res.status} during sign-in`);
  return res.json();
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => { clearTimeout(t); reject(new Error('cancelled')); }, { once: true });
  });
}

module.exports = {
  signInAvailable,
  beginDeviceFlow,
  pollDeviceFlow,
  listRepos,
  listReleaseAssets,
  submitEntry,
  submitModpack,
  submissionIssueUrl,
  modpackIssueUrl,
  OAUTH_SCOPE,
};
