'use strict';

// Renderer. Plain DOM, no framework, no build step: the whole UI is this one
// file, which keeps the app auditable end to end - important for a tool that
// people trust to touch their game install.
//
// Pattern: one `state` object mirrors the main process; every action calls an
// IPC method and then re-fetches state. Rendering is idempotent - each view
// has a render<View>() that repaints from state.

const api = window.gambonanza;

const state = {
  data: null,          // full state from main (app, settings, game, registry, installed)
  updates: null,       // last update-check result
  view: 'home',
  search: '',
  tag: '',
  busy: new Map(),     // operationId -> {label}
  publish: {
    signedIn: false,
    login: '',
    repos: null,
    releases: null,
    entry: { tags: [] },
    submitting: false,
    device: null,
  },
};

const $ = (id) => document.getElementById(id);
const el = (tag, attrs = {}, ...children) => {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else if (k === 'html') node.innerHTML = v; // only ever given trusted literals
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else if (v === true) node.setAttribute(k, '');
    else if (v !== false && v != null) node.setAttribute(k, v);
  }
  for (const child of children.flat()) {
    if (child == null || child === false) continue;
    node.append(child.nodeType ? child : document.createTextNode(String(child)));
  }
  return node;
};

// ---------------------------------------------------------------------------
// Icons + download counts
// ---------------------------------------------------------------------------

// Hand-drawn pixel icons matching the rest of the chrome (crispEdges, 12x12).
// Trusted literals only - fed to el()'s `html` attribute, never user data.
const pix = (d) => `<svg class="pix" width="13" height="13" viewBox="0 0 12 12" shape-rendering="crispEdges" fill="currentColor" aria-hidden="true"><path d="${d}"/></svg>`;
const ICONS = {
  download: pix('M5 1h2v1H5zM5 2h2v1H5zM5 3h2v1H5zM3 4h6v1H3zM4 5h4v1H4zM5 6h2v1H5zM1 8h10v2H1z'),
  flame: pix('M7 0h1v1H7zM6 1h2v1H6zM5 2h2v1H5zM4 3h3v1H4zM3 4h5v1H3zM3 5h6v1H3zM2 6h8v1H2zM2 7h8v1H2zM3 8h7v1H3zM4 9h5v1H4zM5 10h3v1H5z'),
  star: pix('M5 1h2v1H5zM5 2h2v1H5zM4 3h4v1H4zM1 4h10v1H1zM2 5h8v1H2zM3 6h6v1H3zM2 7h8v1H2zM2 8h3v1H2zM7 8h3v1H7zM1 9h2v1H1zM9 9h2v1H9z'),
  sprout: pix('M8 1h3v1H8zM7 2h4v1H7zM8 3h2v1H8zM1 3h3v1H1zM1 4h4v1H1zM2 5h2v1H2zM5 4h2v7H5z'),
};

/** 1234 -> "1.2k". Counts, not bytes - nobody needs the exact number. */
function fmtCount(n) {
  n = Number(n) || 0;
  if (n >= 1e6) return `${(n / 1e6).toFixed(n < 1e7 ? 1 : 0)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(n < 1e4 ? 1 : 0)}k`;
  return String(n);
}

/**
 * Popularity is relative to the rest of the registry, not an absolute number:
 * "hot" = top fifth of mods by lifetime downloads, "popular" = top half.
 * Absolute floors stop a brand-new registry (where 3 downloads is technically
 * the top fifth) from handing out flames like participation trophies.
 */
function popularityTiers(mods) {
  const counts = mods.filter((m) => m.latest).map((m) => m.downloads || 0).sort((a, b) => a - b);
  if (!counts.length) return null;
  const at = (p) => counts[Math.min(counts.length - 1, Math.floor(p * counts.length))];
  return { hot: Math.max(at(0.8), 25), popular: Math.max(at(0.5), 5) };
}

function popularityOf(mod, tiers) {
  const dl = mod.downloads || 0;
  if (tiers && dl >= tiers.hot) {
    return { cls: 'hot', icon: 'flame', label: 'hot', title: 'Hot - among the most downloaded mods in the registry' };
  }
  if (tiers && dl >= tiers.popular) {
    return { cls: 'popular', icon: 'star', label: 'popular', title: 'Popular - downloaded more than most mods' };
  }
  return { cls: 'growing', icon: 'sprout', label: 'growing', title: 'Growing - every mod starts somewhere' };
}

/** The "⬇ 1.2k" + popularity pair shown on mod cards. */
function statsRow(mod, tiers) {
  const pop = popularityOf(mod, tiers);
  return el('div', { class: 'stats' },
    el('span', { class: 'stat', title: `Downloaded ${(mod.downloads || 0).toLocaleString()} times across all versions (counted by GitHub)` },
      el('span', { class: 'micon', html: ICONS.download }), fmtCount(mod.downloads || 0)),
    el('span', { class: `stat pop ${pop.cls}`, title: pop.title },
      el('span', { class: 'micon', html: ICONS[pop.icon] }), pop.label));
}

// ---------------------------------------------------------------------------
// Toasts + modal
// ---------------------------------------------------------------------------

function toast(message, kind = '') {
  const t = el('div', { class: `toast ${kind}` }, message);
  $('toasts').append(t);
  setTimeout(() => t.remove(), kind === 'err' ? 7000 : 4200);
}

const modal = {
  open({ title, body, progress = false, buttons = [] }) {
    $('modalTitle').textContent = title;
    $('modalBody').textContent = body || '';
    $('modalProgress').hidden = !progress;
    $('modalProgressFill').classList.add('indeterminate');
    $('modalProgressFill').style.width = '0%';
    const row = $('modalButtons');
    row.replaceChildren(...buttons.map(({ label, kind = 'btn-cream', onClick }) =>
      el('button', { class: `btn ${kind}`, onclick: onClick }, label)));
    $('modalBackdrop').classList.add('open');
  },
  progress({ message, percent }) {
    if (message) $('modalBody').textContent = message;
    const fill = $('modalProgressFill');
    if (percent == null) {
      fill.classList.add('indeterminate');
    } else {
      fill.classList.remove('indeterminate');
      fill.style.width = `${percent}%`;
    }
  },
  close() {
    $('modalBackdrop').classList.remove('open');
  },
};

function confirmModal({ title, body, confirmLabel, confirmKind = 'btn-red' }) {
  return new Promise((resolve) => {
    modal.open({
      title,
      body,
      buttons: [
        { label: 'Cancel', kind: 'btn-cream', onClick: () => { modal.close(); resolve(false); } },
        { label: confirmLabel, kind: confirmKind, onClick: () => { modal.close(); resolve(true); } },
      ],
    });
  });
}

// ---------------------------------------------------------------------------
// State + navigation
// ---------------------------------------------------------------------------

async function call(fn, payload) {
  const res = await fn(payload);
  if (!res.ok) throw new Error(res.error);
  return res.data;
}

async function refresh({ forceRegistry = false } = {}) {
  try {
    state.data = await call(api.getState, { forceRegistry });
  } catch (err) {
    toast(`Could not load: ${err.message}`, 'err');
    return;
  }
  renderAll();
}

function show(view) {
  state.view = view;
  for (const btn of document.querySelectorAll('.nav-btn')) {
    btn.classList.toggle('active', btn.dataset.view === view);
  }
  for (const section of document.querySelectorAll('.view')) {
    section.classList.toggle('active', section.id === `view-${view}`);
  }
  api.setSettings({ lastView: view }).catch(() => {});
  if (view === 'settings') renderSettings();
  if (view === 'updates') renderUpdates();
}

function renderAll() {
  renderTopbar();
  renderHome();
  renderBrowse();
  renderInstalled();
  renderUpdates();
  renderPublish();
  if (state.view === 'settings') renderSettings();
}

// ---------------------------------------------------------------------------
// Topbar
// ---------------------------------------------------------------------------

function renderTopbar() {
  const game = state.data?.game;
  const pill = $('gamePill');
  const text = $('gamePillText');
  pill.classList.remove('ok', 'warn');
  if (!game || !game.valid) {
    text.textContent = 'Game not found - open Set up';
  } else if (game.state === 'patched') {
    pill.classList.add('ok');
    text.textContent = `Ready for mods · framework ${game.frameworkVersion || '?'}`;
  } else if (game.state === 'stale') {
    pill.classList.add('warn');
    text.textContent = 'Game updated - re-patch needed';
  } else if (game.state === 'broken') {
    pill.classList.add('warn');
    text.textContent = 'Framework damaged - re-patch needed';
  } else {
    pill.classList.add('warn');
    text.textContent = 'Game found - not patched yet';
  }
}

// ---------------------------------------------------------------------------
// Home
// ---------------------------------------------------------------------------

function renderHome() {
  const d = state.data;
  const game = d?.game;
  const modCount = d?.installed?.length || 0;
  const settled = !!game?.valid && game.state === 'patched';

  const steps = [
    { t: 'Find the game', d: game?.valid ? shortPath(game.gameDir) : 'not found yet', done: !!game?.valid },
    { t: 'Patch the game', d: game?.patched ? `framework ${game.frameworkVersion || 'installed'}` : 'adds mod support', done: !!game?.patched && game?.state === 'patched' },
    { t: 'Install mods', d: modCount ? `${modCount} installed` : 'from Browse mods', done: modCount > 0 },
    { t: 'Play', d: 'launch from Steam or here', done: false },
  ];
  $('homeSteps').replaceChildren(...steps.map((s, i) =>
    el('div', { class: `step${s.done ? ' done' : ''}` },
      el('div', { class: 'n' }, el('span', {}, String(i + 1))),
      el('div', {}, el('div', { class: 't' }, s.t), el('div', { class: 'd' }, s.d)))));

  // Once set up, the checklist earns its retirement: collapsed behind a quiet
  // dropdown. While something still needs doing it stays open and visible.
  // Only touch the open state when settledness CHANGES - renderHome runs
  // after every action, and stomping a disclosure the user opened is rude.
  const details = $('setupDetails');
  if (renderHome.lastSettled !== settled) {
    details.open = !settled;
    renderHome.lastSettled = settled;
  }
  $('setupSummary').textContent = settled ? 'Setup details' : 'What still needs doing';

  const status = $('homeStatus');
  const hint = $('homeHint');
  const actions = $('homeActions');
  actions.replaceChildren();

  if (!game || !game.valid) {
    status.textContent = 'Let’s find your game';
    hint.textContent = 'The manager looks in the usual Steam places automatically. If Gambonanza is installed somewhere unusual, point me at its folder.';
    actions.append(
      el('button', { class: 'btn btn-green big', onclick: detectGame }, 'Find my game'),
      el('button', { class: 'btn btn-cream big', onclick: pickGameFolder }, 'Choose folder…'),
    );
  } else if (game.state === 'patched') {
    status.textContent = 'Ready to play';
    hint.textContent = modCount
      ? `${modCount} mod${modCount === 1 ? '' : 's'} will load on the next launch.`
      : 'The game is patched - grab something from Browse mods, or just play.';
    actions.append(
      el('button', { class: 'btn btn-green play-hero', onclick: launchGame }, '▶ Play'),
      el('button', { class: 'btn btn-cream', onclick: () => show('browse') }, 'Browse mods'),
    );
  } else if (game.state === 'stale') {
    status.textContent = 'Steam updated the game';
    hint.textContent = 'A game update replaced the patched files. One click puts mod support back - your mods and settings are untouched.';
    actions.append(
      el('button', { class: 'btn btn-green big', onclick: () => patchGame() }, 'Re-patch my game'),
    );
  } else if (game.state === 'broken') {
    status.textContent = 'Something needs fixing';
    hint.textContent = 'Part of the mod framework is missing. Re-patching repairs it in place.';
    actions.append(
      el('button', { class: 'btn btn-green big', onclick: () => patchGame() }, 'Repair'),
    );
  } else {
    status.textContent = 'One click to go';
    hint.textContent = 'Patching adds mod support to Gambonanza. Your original game file is backed up first, and "Restore" in Settings undoes everything.';
    actions.append(
      el('button', { class: 'btn btn-green big', onclick: () => patchGame() }, 'Patch my game'),
      el('button', { class: 'btn btn-cream', onclick: pickGameFolder }, 'Wrong folder?'),
    );
  }

  renderHomeBanners();
}

function renderHomeBanners() {
  const box = $('homeBanners');
  box.replaceChildren();
  const fw = state.updates?.framework;
  if (fw?.updateAvailable) {
    box.append(el('div', { class: 'banner update' },
      el('div', { class: 'grow' },
        el('b', {}, `Framework ${fw.release.version} is out (you have ${fw.installedVersion})`),
        el('div', { class: 'detail' }, 'Update and re-patch in one click - see the changelog under Updates.')),
      el('button', { class: 'btn btn-green small', onclick: () => patchGame(fw.release.tag) }, 'Update now'),
      el('button', { class: 'btn btn-cream small', onclick: () => show('updates') }, 'Changelog'),
    ));
  }
  const mgr = state.updates?.manager;
  if (mgr?.updateAvailable) {
    box.append(el('div', { class: 'banner update' },
      el('div', { class: 'grow' },
        el('b', {}, `Mod Manager ${mgr.release.version} is available`),
        el('div', { class: 'detail' }, 'One click - the app updates and restarts itself.')),
      el('button', { class: 'btn btn-green small', onclick: () => applyManagerUpdate(mgr) }, 'Update & restart'),
    ));
  }
}

async function applyManagerUpdate(mgr) {
  const operationId = `self-update-${++opCounter}`;
  modal.open({
    title: `Updating to ${mgr.release.version}`,
    body: 'Getting started…',
    progress: true,
    buttons: [{ label: 'Cancel', kind: 'btn-cream', onClick: () => api.cancelOperation({ operationId }) }],
  });
  try {
    await call(api.applyManagerUpdate, { operationId });
    // If we're still alive the swap is staged - the app quits itself now.
    modal.progress({ message: 'Restarting…', percent: null });
  } catch (err) {
    modal.close();
    toast(`${err.message} - you can still download it manually.`, 'err');
    api.openExternal(mgr.release.url);
  }
}

// ---------------------------------------------------------------------------
// Browse
// ---------------------------------------------------------------------------

const TAGS = ['gameplay', 'gambits', 'quality-of-life', 'ui', 'visual', 'audio', 'cheats', 'library', 'tools'];

function renderBrowse() {
  const mods = state.data?.registry?.mods || [];
  const registryMods = mods.filter((m) => m.kind === 'registry');

  $('browseCount').hidden = registryMods.length === 0;
  $('browseCount').textContent = String(registryMods.length);

  // tag chips
  const chips = $('tagChips');
  const usedTags = TAGS.filter((t) => registryMods.some((m) => (m.tags || []).includes(t)));
  chips.replaceChildren(...usedTags.map((t) =>
    el('button', {
      class: `chip${state.tag === t ? ' on' : ''}`,
      onclick: () => { state.tag = state.tag === t ? '' : t; renderBrowse(); },
    }, t.replace(/-/g, ' '))));

  const q = state.search.trim().toLowerCase();
  const visible = registryMods.filter((m) => {
    if (state.tag && !(m.tags || []).includes(state.tag)) return false;
    if (q) return [m.name, m.author, m.summary, m.id, ...(m.tags || [])].join(' ').toLowerCase().includes(q);
    // Libraries are plumbing: installed automatically with whatever needs
    // them, so the default shelf hides them. The "library" chip (or a
    // search) still finds them.
    if ((m.tags || []).includes('library')) return false;
    return true;
  });

  $('browseEmpty').hidden = visible.length > 0;
  // Tiers come from the WHOLE registry, not the filtered view - searching for
  // "junk" must not crown the one result "hot" for being alone.
  const tiers = popularityTiers(registryMods);
  $('modGrid').replaceChildren(...visible.map((m) => renderModCard(m, tiers)));
}

function renderModCard(mod, tiers) {
  const badges = [];
  // reviewed === false comes from the index for issue-sourced submissions
  // nobody has vetted yet; registry entries carry reviewed: true. Older
  // cached indexes predate the field entirely - and everything in them went
  // through review - so only an explicit false counts as unreviewed.
  if (mod.reviewed === false) {
    badges.push(el('span', { class: 'tag red', title: 'Community submission awaiting review - nobody has checked this code yet. Read the source before installing.' }, 'unreviewed'));
  } else {
    badges.push(el('span', { class: 'tag gold', title: 'The source code was reviewed before this mod was listed' }, 'reviewed'));
  }
  if (mod.installed) badges.push(el('span', { class: 'tag green' }, 'installed'));
  if (mod.updateAvailable) badges.push(el('span', { class: 'tag blue' }, 'update'));
  if (mod.pending) badges.push(el('span', { class: 'tag', title: 'The author has not published a release yet' }, 'coming soon'));

  const foot = el('div', { class: 'foot' });
  const version = mod.latest?.version ? `v${mod.latest.version}` : '';
  foot.append(el('span', { class: 'ver' }, version), el('span', { class: 'grow' }));

  foot.append(el('button', {
    class: 'btn btn-cream small',
    title: 'Open the mod’s source code on GitHub',
    onclick: () => api.openExternal(mod.homepage || `https://github.com/${mod.repo}`),
  }, 'Source'));

  if (mod.installed && mod.updateAvailable) {
    foot.append(el('button', { class: 'btn btn-green small', onclick: () => installMod(mod) }, 'Update'));
  } else if (mod.installed) {
    foot.append(el('button', { class: 'btn btn-red small', onclick: () => uninstallMod(mod.folder, mod.name) }, 'Remove'));
  } else if (mod.installable) {
    foot.append(el('button', { class: 'btn btn-green small', onclick: () => installMod(mod) }, 'Install'));
  } else {
    foot.append(el('button', { class: 'btn btn-cream small', disabled: true }, 'No release yet'));
  }

  const deps = (mod.dependencies || []).length
    ? el('div', { class: 'tiny muted' }, `needs: ${mod.dependencies.join(', ')}`)
    : null;

  return el('div', { class: 'mod-card' },
    el('div', { class: 'head' },
      el('div', {},
        el('h3', {}, mod.name),
        el('div', { class: 'by' }, `by ${mod.author}`)),
      el('div', { class: 'badges' }, badges)),
    el('div', { class: 'sum' }, mod.summary || ''),
    statsRow(mod, tiers),
    deps,
    foot);
}

// ---------------------------------------------------------------------------
// Installed
// ---------------------------------------------------------------------------

function renderInstalled() {
  const installed = state.data?.installed || [];
  $('installedCount').hidden = installed.length === 0;
  $('installedCount').textContent = String(installed.length);
  $('installedEmpty').hidden = installed.length > 0;
  $('installedFootnote').hidden = installed.length === 0;

  const registryById = new Map((state.data?.registry?.mods || []).map((m) => [m.id, m]));

  $('installedList').replaceChildren(...installed.map((m) => {
    const reg = m.registryId ? registryById.get(m.registryId) : null;
    const bits = [];
    if (m.installedVersion) bits.push(`v${String(m.installedVersion).replace(/^v/, '')}`);
    bits.push(m.managed ? 'from the mod registry' : 'installed by hand');
    if (reg?.updateAvailable) bits.push('update available');

    const row = el('div', { class: `mod-row${m.enabled ? '' : ' disabled'}` },
      // A folder without mod.json is never loaded by the game and has nothing
      // to toggle - offering the switch would just throw.
      m.hasManifest
        ? el('button', {
            class: `ptoggle${m.enabled ? ' on' : ''}`,
            title: m.enabled ? 'Enabled - click to disable' : 'Disabled - click to enable',
            onclick: () => toggleMod(m),
          })
        : el('span', { class: 'tag', title: 'This folder has no mod.json, so the game ignores it.' }, 'no mod.json'),
      el('div', { class: 'info' },
        el('div', { class: 'nm' }, m.manifest?.name || m.folder),
        el('div', { class: 'meta' }, bits.join(' · '))),
    );
    if (reg?.updateAvailable) {
      row.append(el('button', { class: 'btn btn-green small', onclick: () => installMod(reg) }, 'Update'));
    }
    row.append(el('button', { class: 'btn btn-red small', onclick: () => uninstallMod(m.folder, m.manifest?.name || m.folder) }, 'Remove'));
    return row;
  }));
}

// ---------------------------------------------------------------------------
// Updates view
// ---------------------------------------------------------------------------

function renderUpdates() {
  const box = $('updatesBody');
  const u = state.updates;
  const game = state.data?.game;
  if (!u) {
    box.replaceChildren(el('div', { class: 'empty-note' }, 'Checking for updates…'));
    return;
  }

  const parts = [];

  // Framework stream
  const fw = u.framework;
  if (fw?.error) {
    parts.push(el('div', { class: 'inset-row' }, `Could not check the framework: ${fw.error}`));
  } else if (fw) {
    const isCurrent = game?.patched && !fw.updateAvailable && !fw.gameUpdated && !fw.skippedVersion;
    parts.push(el('div', { class: 'section-band' }, 'Game framework'));
    if (fw.gameUpdated) {
      parts.push(el('div', { class: 'banner danger', style: 'margin-top:10px' },
        el('div', { class: 'grow' },
          el('b', {}, 'Steam updated Gambonanza'),
          el('div', { class: 'detail' }, 'The patch was overwritten. Re-patch to get your mods back - one click, mods and settings survive.')),
        el('button', { class: 'btn btn-green small', onclick: () => patchGame() }, 'Re-patch')));
    }
    if (fw.updateAvailable) {
      parts.push(el('div', { class: 'banner update', style: 'margin-top:10px' },
        el('div', { class: 'grow' },
          el('b', {}, `Framework ${fw.release.version} is available`),
          el('div', { class: 'detail' }, `You have ${fw.installedVersion}. Updating re-patches the game with the new version.`)),
        el('button', { class: 'btn btn-green small', onclick: () => patchGame(fw.release.tag) }, 'Update & re-patch'),
        el('button', { class: 'btn btn-cream small', onclick: () => dismissUpdate('framework', fw.release.version) }, 'Skip')));
    } else if (fw.skippedVersion) {
      parts.push(el('div', { class: 'inset-row', style: 'margin-top:10px; display:flex; align-items:center; gap:10px' },
        el('span', { style: 'flex:1' }, `You skipped framework ${fw.skippedVersion}.`),
        el('button', { class: 'btn btn-cream small', onclick: () => dismissUpdate('framework', '') }, 'Show again')));
    } else if (isCurrent) {
      parts.push(el('div', { class: 'inset-row', style: 'margin-top:10px' },
        `You're on the newest framework (${fw.installedVersion || fw.release?.version || '?'}). Nothing to do.`));
    } else if (!game?.patched) {
      parts.push(el('div', { class: 'inset-row', style: 'margin-top:10px' },
        'The game is not patched yet - the newest framework will be used when you patch.'));
    }
    if (fw.release?.notes) {
      parts.push(el('div', { class: 'tiny muted', style: 'margin-top:12px' }, `Changelog for ${fw.release.version}:`));
      parts.push(el('div', { class: 'release-notes' }, fw.release.notes));
    }
  }

  // Mod updates
  const updatable = (state.data?.registry?.mods || []).filter((m) => m.updateAvailable);
  parts.push(el('div', { class: 'section-band', style: 'margin-top:18px' }, 'Mods'));
  if (updatable.length) {
    for (const mod of updatable) {
      parts.push(el('div', { class: 'banner update', style: 'margin-top:10px' },
        el('div', { class: 'grow' },
          el('b', {}, `${mod.name} ${mod.latest.version ? `v${mod.latest.version}` : mod.latest.tag}`),
          el('div', { class: 'detail' }, `You have ${mod.local?.installedVersion || 'an older version'}.`)),
        el('button', { class: 'btn btn-green small', onclick: () => installMod(mod) }, 'Update')));
    }
    if (updatable.length > 1) {
      parts.push(el('div', { style: 'margin-top:10px; text-align:center' },
        el('button', { class: 'btn btn-green', onclick: updateAllMods }, `Update all (${updatable.length})`)));
    }
  } else {
    parts.push(el('div', { class: 'inset-row', style: 'margin-top:10px' }, 'All installed mods are up to date.'));
  }

  // Manager stream
  const mgr = u.manager;
  parts.push(el('div', { class: 'section-band', style: 'margin-top:18px' }, 'This app'));
  if (mgr?.error) {
    parts.push(el('div', { class: 'inset-row', style: 'margin-top:10px' }, `Could not check for app updates: ${mgr.error}`));
  } else if (mgr?.updateAvailable) {
    parts.push(el('div', { class: 'banner update', style: 'margin-top:10px' },
      el('div', { class: 'grow' },
        el('b', {}, `Mod Manager ${mgr.release.version} is available`),
        el('div', { class: 'detail' }, `You have ${state.data?.app?.version}. The app updates and restarts itself.`)),
      el('button', { class: 'btn btn-green small', onclick: () => applyManagerUpdate(mgr) }, 'Update & restart'),
      el('button', { class: 'btn btn-cream small', onclick: () => dismissUpdate('manager', mgr.release.version) }, 'Skip')));
    if (mgr.release.notes) parts.push(el('div', { class: 'release-notes' }, mgr.release.notes));
  } else if (mgr?.skippedVersion) {
    parts.push(el('div', { class: 'inset-row', style: 'margin-top:10px; display:flex; align-items:center; gap:10px' },
      el('span', { style: 'flex:1' }, `You skipped Mod Manager ${mgr.skippedVersion}.`),
      el('button', { class: 'btn btn-cream small', onclick: () => dismissUpdate('manager', '') }, 'Show again')));
  } else if (mgr) {
    parts.push(el('div', { class: 'inset-row', style: 'margin-top:10px' }, `Mod Manager ${state.data?.app?.version} is the newest version.`));
  }

  parts.push(el('div', { style: 'margin-top:16px; text-align:center' },
    el('button', { class: 'btn btn-cream small', onclick: checkUpdatesNow }, '↻ Check again')));

  box.replaceChildren(...parts);

  const attention = !!(fw?.updateAvailable || fw?.gameUpdated || mgr?.updateAvailable || updatable.length);
  $('updatesNav').classList.toggle('attention', attention);
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

async function detectGame() {
  try {
    const info = await call(api.detectGame);
    if (info) toast(`Found Gambonanza at ${shortPath(info.gameDir)}`, 'ok');
    else toast('Could not find Gambonanza automatically - use "Choose folder…"', 'err');
  } catch (err) {
    toast(err.message, 'err');
  }
  await refresh();
}

async function pickGameFolder() {
  try {
    const info = await call(api.pickGameFolder);
    if (info) toast(`Using ${shortPath(info.gameDir)}`, 'ok');
  } catch (err) {
    toast(err.message, 'err');
  }
  await refresh();
}

async function launchGame() {
  try {
    await call(api.launchGame);
  } catch (err) {
    toast(err.message, 'err');
  }
}

let opCounter = 0;

async function patchGame(tag = null) {
  const operationId = `patch-${++opCounter}`;
  modal.open({
    title: tag ? 'Updating the framework' : 'Patching Gambonanza',
    body: 'Getting started…',
    progress: true,
    buttons: [{ label: 'Cancel', kind: 'btn-cream', onClick: () => api.cancelOperation({ operationId }) }],
  });
  try {
    const result = await call(api.patchGame, { operationId, tag });
    modal.close();
    toast(`Gambonanza is patched (framework ${result.version}). Mods load next launch.`, 'ok');
  } catch (err) {
    modal.close();
    toast(err.message, 'err');
  }
  await refresh();
  await checkUpdatesQuiet();
}

async function installMod(mod) {
  // Unreviewed submissions install fine, but never silently: the whole trust
  // model for them is "you read the source", so say exactly that first.
  // Updates prompt too - a new release of an unreviewed mod is new unread code.
  if (mod.reviewed === false) {
    const yes = await confirmModal({
      title: `${mod.name} is unreviewed`,
      body: 'This community submission has not been reviewed yet - nobody has checked what its code does. Read the source on GitHub (the Source button) and only continue if you trust it.',
      confirmLabel: mod.installed ? 'Update anyway' : 'Install anyway',
    });
    if (!yes) return;
  }
  const operationId = `mod-${++opCounter}`;
  modal.open({
    title: mod.installed ? `Updating ${mod.name}` : `Installing ${mod.name}`,
    body: 'Getting started…',
    progress: true,
    buttons: [{ label: 'Cancel', kind: 'btn-cream', onClick: () => api.cancelOperation({ operationId }) }],
  });
  try {
    await call(api.installMod, { id: mod.id, operationId });
    modal.close();
    toast(`${mod.name} ${mod.installed ? 'updated' : 'installed'}.`, 'ok');
  } catch (err) {
    modal.close();
    toast(err.message, 'err');
  }
  await refresh();
}

async function updateAllMods() {
  const updatable = (state.data?.registry?.mods || []).filter((m) => m.updateAvailable);
  for (const mod of updatable) {
    // Sequential on purpose: one progress modal at a time, and the installs
    // share the Mods/ folder.
    // eslint-disable-next-line no-await-in-loop
    await installMod(mod);
  }
}

async function uninstallMod(folder, name) {
  const yes = await confirmModal({
    title: `Remove ${name}?`,
    body: 'The mod’s folder is deleted from the game. You can reinstall it from Browse mods any time.',
    confirmLabel: 'Remove',
  });
  if (!yes) return;
  try {
    await call(api.uninstallMod, { folder });
    toast(`${name} removed.`, 'ok');
  } catch (err) {
    toast(err.message, 'err');
  }
  await refresh();
}

async function toggleMod(m) {
  try {
    await call(api.setModEnabled, { folder: m.folder, enabled: !m.enabled });
  } catch (err) {
    toast(err.message, 'err');
  }
  await refresh();
}

async function restoreGame() {
  const yes = await confirmModal({
    title: 'Restore original game files?',
    body: 'This removes the mod framework and puts Assembly-CSharp.dll back exactly as Steam shipped it. Your mod folders stay on disk but stop loading.',
    confirmLabel: 'Restore',
  });
  if (!yes) return;
  try {
    const result = await call(api.restoreGame, {});
    toast(`Game restored from ${result.restoredFrom}.`, 'ok');
  } catch (err) {
    toast(err.message, 'err');
  }
  await refresh();
}

async function checkUpdatesNow() {
  toast('Checking for updates…');
  await checkUpdatesQuiet();
  toast('Update check finished.', 'ok');
}

async function checkUpdatesQuiet() {
  try {
    state.updates = await call(api.checkUpdates);
  } catch (err) {
    state.updates = { framework: { error: err.message }, manager: { error: err.message } };
  }
  renderUpdates();
  renderHomeBanners();
}

async function dismissUpdate(kind, version) {
  // The main process owns this state - persist, then re-derive everything
  // from a fresh check so the skip survives restarts and periodic checks.
  await api.dismissUpdate({ kind, version });
  await checkUpdatesQuiet();
  toast(version ? 'Okay - not mentioning that version again.' : 'Update visible again.');
}

// ---------------------------------------------------------------------------
// Publish
// ---------------------------------------------------------------------------

/**
 * The GitHub sign-in status box, shared by the Publish tab and the modpack
 * publish form - it is the same account and the same device flow; only the
 * "what you are submitting" word changes.
 */
function authBox(what) {
  const p = state.publish;
  const signInAvailable = state.data?.publish?.signInAvailable;
  const settings = state.data?.settings;
  if (settings?.githubSignedIn && !p.signedIn) {
    p.signedIn = true;
    p.login = settings.githubLogin || '';
  }

  if (p.signedIn) {
    return el('div', { class: 'inset-row', style: 'display:flex; align-items:center; gap:10px' },
      el('span', {}, `Signed in as `), el('b', {}, p.login || 'GitHub user'),
      el('span', { style: 'flex:1' }),
      el('button', { class: 'btn btn-cream small', onclick: signOut }, 'Sign out'));
  }
  if (p.device) {
    return el('div', { class: 'inset-row', style: 'text-align:center' },
      el('p', { style: 'margin:0 0 8px' }, 'Enter this code on GitHub to sign in:'),
      el('div', { class: 'device-code' }, p.device.userCode),
      el('p', { class: 'tiny muted', style: 'margin:10px 0 0' },
        'A browser tab has opened at github.com/login/device. Waiting for you to approve…'),
    );
  }
  if (signInAvailable) {
    return el('div', { class: 'inset-row', style: 'display:flex; align-items:center; gap:10px' },
      el('div', { style: 'flex:1' },
        el('div', {}, `Sign in with GitHub to submit your ${what} without leaving the app.`),
        el('div', { class: 'tiny muted' }, 'Uses GitHub’s device code - no password ever touches this app.')),
      el('button', { class: 'btn btn-green small', onclick: signIn }, 'Sign in with GitHub'));
  }
  return el('div', { class: 'inset-row' },
    'Fill in the form and hit "Open submission on GitHub" - it pre-fills an issue for you, no sign-in needed.');
}

function renderPublish() {
  $('publishAuth').replaceChildren(authBox('mod'));
  renderPublishForm();
}

function renderPublishForm() {
  const p = state.publish;
  const box = $('publishForm');
  const e = p.entry;

  const field = (label, key, { placeholder = '', help = '', full = false, textarea = false } = {}) => {
    const input = el(textarea ? 'textarea' : 'input', {
      class: 'game-input',
      placeholder,
      value: textarea ? undefined : (e[key] || ''),
      oninput: (ev) => { e[key] = ev.target.value; },
    });
    if (textarea) input.value = e[key] || '';
    return el('div', { class: `field${full ? ' full' : ''}` },
      el('label', {}, label), input,
      help ? el('div', { class: 'help' }, help) : null);
  };

  const repoField = p.signedIn && p.repos
    ? el('div', { class: 'field' },
        el('label', {}, 'Your mod’s repository'),
        el('select', {
          class: 'game-input',
          onchange: (ev) => { e.repo = ev.target.value; loadReleases(); },
        },
          el('option', { value: '' }, 'Pick a repository…'),
          ...p.repos.map((r) => el('option', { value: r.fullName, selected: e.repo === r.fullName }, r.fullName))),
        el('div', { class: 'help' }, 'Public repositories you own.'))
    : field('Your mod’s repository', 'repo', { placeholder: 'yourname/your-mod', help: 'The public GitHub repo with your mod’s source and releases.' });

  const assetField = p.signedIn && p.releases?.length
    ? el('div', { class: 'field' },
        el('label', {}, 'Release file'),
        el('select', { class: 'game-input', onchange: (ev) => { e.asset = ev.target.value; } },
          el('option', { value: '' }, 'Pick the file players download…'),
          ...p.releases.flatMap((rel) => rel.assets.map((a) =>
            el('option', { value: a.name, selected: e.asset === a.name }, `${a.name}  (${rel.tag})`)))),
        el('div', { class: 'help' }, 'A .zip with mod.json + your DLL inside, attached to a GitHub release.'))
    : field('Release file name', 'asset', { placeholder: 'MyMod.zip', help: 'The asset attached to your GitHub release. Globs work: MyMod-*.zip' });

  box.replaceChildren(
    el('div', { class: 'form-grid', style: 'margin-top:14px' },
      field('Mod name', 'name', { placeholder: 'My Cool Mod' }),
      field('Registry id', 'id', { placeholder: 'my-cool-mod', help: 'lowercase-with-dashes, permanent' }),
      repoField,
      assetField,
      field('Install folder', 'folder', { placeholder: 'MyCoolMod', help: 'Folder created under the game’s Mods/' }),
      field('Author', 'author', { placeholder: 'you' }),
      field('One-line summary', 'summary', { full: true, placeholder: 'What does it do? (shown on the mod card)' }),
      el('div', { class: 'field full' },
        el('label', {}, 'Tags'),
        el('div', { class: 'chip-row' }, ...TAGS.map((t) =>
          el('button', {
            class: `chip${(e.tags || []).includes(t) ? ' on' : ''}`,
            onclick: (ev) => {
              ev.preventDefault();
              e.tags = (e.tags || []).includes(t) ? e.tags.filter((x) => x !== t) : [...(e.tags || []), t].slice(0, 5);
              renderPublishForm();
            },
          }, t.replace(/-/g, ' '))))),
    ),
    el('div', { style: 'display:flex; gap:10px; justify-content:center; margin-top:18px; flex-wrap:wrap' },
      p.signedIn
        ? el('button', { class: 'btn btn-green', disabled: p.submitting, onclick: submitEntry },
            p.submitting ? 'Submitting…' : 'Submit to the registry')
        : null,
      el('button', { class: 'btn btn-cream', onclick: openIssueSubmission }, 'Open submission on GitHub'),
      el('button', { class: 'btn btn-cream', onclick: () => api.openExternal('https://github.com/bentrd/GambonanzaMods/blob/main/docs/MOD_PUBLISHING.md') }, 'How do I make a mod?'),
    ),
  );
}

async function signIn() {
  try {
    const flow = await call(api.publishBegin);
    state.publish.device = flow;
    api.openExternal(flow.verificationUri);
    renderPublish();
  } catch (err) {
    toast(err.message, 'err');
  }
}

async function signOut() {
  await api.publishSignOut();
  state.publish.signedIn = false;
  state.publish.login = '';
  state.publish.repos = null;
  state.publish.releases = null;
  await refresh();
}

async function loadRepos() {
  try {
    state.publish.repos = await call(api.publishListRepos);
    renderPublish();
  } catch (err) {
    toast(err.message, 'err');
  }
}

async function loadReleases() {
  const repo = state.publish.entry.repo;
  state.publish.releases = null;
  if (!repo) return;
  try {
    state.publish.releases = await call(api.publishListReleases, { repo });
    if (!state.publish.releases.some((rel) => rel.assets.length)) {
      toast('That repository has no releases with a .zip or .dll attached yet. Create a GitHub release first - the form still works, the entry just stays "coming soon" until you do.', 'err');
    }
    renderPublishForm();
  } catch (err) {
    toast(err.message, 'err');
  }
}

async function submitEntry() {
  const p = state.publish;
  p.submitting = true;
  renderPublishForm();
  try {
    const result = await call(api.publishSubmit, { entry: p.entry });
    toast('Submission opened! The maintainers will review it soon.', 'ok');
    api.openExternal(result.url);
  } catch (err) {
    toast(err.message, 'err');
  } finally {
    p.submitting = false;
    renderPublishForm();
  }
}

async function openIssueSubmission() {
  try {
    const url = await call(api.publishIssueUrl, { entry: state.publish.entry });
    api.openExternal(url);
  } catch (err) {
    toast(err.message, 'err');
  }
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

async function renderSettings() {
  const d = state.data;
  const s = d?.settings || {};
  const game = d?.game;
  const box = $('settingsBody');

  const settingToggle = (key, title, desc) =>
    el('div', { class: 'setting-row' },
      el('div', { class: 'info' }, el('div', { class: 't' }, title), el('div', { class: 'd' }, desc)),
      el('button', {
        class: `ptoggle${s[key] ? ' on' : ''}`,
        onclick: async () => { await api.setSettings({ [key]: !s[key] }); await refresh(); renderSettings(); },
      }));

  box.replaceChildren(
    el('div', { class: 'setting-row' },
      el('div', { class: 'info' },
        el('div', { class: 't' }, 'Game folder'),
        el('div', { class: 'd' }, game?.valid ? game.gameDir : 'not set')),
      el('button', { class: 'btn btn-cream small', onclick: pickGameFolder }, 'Change…'),
      el('button', { class: 'btn btn-cream small', onclick: () => api.openGameFolder('game') }, 'Open')),
    el('div', { class: 'setting-row' },
      el('div', { class: 'info' },
        el('div', { class: 't' }, 'Mods folder'),
        el('div', { class: 'd' }, game?.valid ? game.modsDir : 'patch the game first')),
      el('button', { class: 'btn btn-cream small', disabled: !game?.valid, onclick: () => api.openGameFolder('mods') }, 'Open')),
    settingToggle('autoCheckUpdates', 'Check for updates automatically', 'Framework and app releases, a few times a day'),
    settingToggle('quitOnPlay', 'Close this app when the game starts', 'The manager is only needed between runs'),
    el('div', { class: 'setting-row' },
      el('div', { class: 'info' },
        el('div', { class: 't' }, 'Restore original game files'),
        el('div', { class: 'd' }, 'Undo the patch completely. Mods stay on disk but stop loading.')),
      el('button', { class: 'btn btn-red small', disabled: !game?.patched, onclick: restoreGame }, 'Restore')),
  );

  // Backups
  try {
    const backups = await call(api.listBackups);
    $('backupsList').replaceChildren(
      backups.length
        ? el('div', {}, ...backups.map((b) =>
            el('div', { class: 'setting-row' },
              el('div', { class: 'info' },
                el('div', { class: 't' }, new Date(b.createdAt).toLocaleString()),
                el('div', { class: 'd' }, `${b.reason || 'backup'} · ${(b.bytes / 1e6).toFixed(1)} MB`)),
              el('button', {
                class: 'btn btn-cream small',
                onclick: async () => {
                  const yes = await confirmModal({
                    title: 'Restore this backup?',
                    body: 'The game’s code file is replaced with this snapshot and the mod framework is removed. Patch again afterwards if you want mods back.',
                    confirmLabel: 'Restore backup',
                  });
                  if (!yes) return;
                  try {
                    await call(api.restoreBackup, { id: b.id });
                    toast('Backup restored.', 'ok');
                  } catch (err) { toast(err.message, 'err'); }
                  await refresh();
                  renderSettings();
                },
              }, 'Restore'))))
        : el('div', { class: 'empty-note' }, 'No backups yet - one is made automatically the first time you patch.'));
  } catch { /* backups list is cosmetic */ }

  // Log
  try {
    const entries = await call(api.getLogHistory);
    const boxLog = $('logBox');
    boxLog.replaceChildren(...entries.slice(-120).map((entry) =>
      el('div', { class: entry.level }, `${entry.at.slice(11, 19)} [${entry.scope}] ${entry.message}`)));
    boxLog.scrollTop = boxLog.scrollHeight;
  } catch { /* ditto */ }
}

// ---------------------------------------------------------------------------
// Events + boot
// ---------------------------------------------------------------------------

api.on('progress', (p) => {
  if (p.operationId === 'publish') return; // publish uses toasts
  modal.progress(p);
});

api.on('updates', (u) => {
  state.updates = u;
  renderUpdates();
  renderHomeBanners();
});

api.on('publish:signedIn', ({ login }) => {
  state.publish.signedIn = true;
  state.publish.login = login;
  state.publish.device = null;
  toast(`Signed in as ${login}.`, 'ok');
  renderPublish();
  loadRepos();
});

api.on('publish:signInFailed', ({ error }) => {
  state.publish.device = null;
  toast(`Sign-in failed: ${error}`, 'err');
  renderPublish();
});

for (const btn of document.querySelectorAll('.nav-btn')) {
  btn.addEventListener('click', () => show(btn.dataset.view));
}
$('playBtn').addEventListener('click', launchGame);
$('modSearch').addEventListener('input', (e) => { state.search = e.target.value; renderBrowse(); });
$('refreshRegistry').addEventListener('click', async () => {
  await refresh({ forceRegistry: true });
  toast('Mod list refreshed.', 'ok');
});
$('openLogBtn').addEventListener('click', () => api.openLogFile());

function shortPath(p) {
  if (!p) return '';
  return p.length > 46 ? `…${p.slice(-44)}` : p;
}

(async function boot() {
  await refresh();
  const last = state.data?.settings?.lastView;
  const game = state.data?.game;
  // First run, or anything wrong with the game → land on Set up; otherwise
  // restore wherever the user was.
  if (game?.valid && game.state === 'patched' && last && last !== 'home') show(last);
  else show('home');
  await checkUpdatesQuiet();
  if (state.publish.signedIn || state.data?.settings?.githubSignedIn) loadRepos();
})();
