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
  packDetail: null,    // modpack id whose detail page is open, or null
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
  packPublish: {
    entry: { mods: [] },
    submitting: false,
  },
  ui: {
    packMenuFor: null,   // mod id whose "add to modpack" dropdown is open
    instMenuOpen: false, // header instance-selector dropdown
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
  pack: pix('M4 1h4v4H4zM1 6h4v4H1zM7 6h4v4H7z'),
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
// Gambit cards - the in-game presentation, rebuilt in DOM/CSS
// ---------------------------------------------------------------------------
// Colors, layout and motion all come from the game itself (decompiled UI code
// + serialized Library colors), so a gambit here looks like it does in the
// collection screen: rounded wine tile, god-ray halo tinted by rarity, the
// sprite wiggling on hover, and the same name/rarity/description tooltip.

/** The game's Library rarity colors: capsule bg (main) + outline (secondary). */
const RARITY_COLORS = {
  common: { main: '#448446', secondary: '#E3FFE4' },
  rare: { main: '#445482', secondary: '#D4DCF3' },
  epic: { main: '#84444A', secondary: '#ECCCCE' },
  legendary: { main: '#FF9B00', secondary: '#FFE7C2' },
  strain: { main: '#7900AB', secondary: '#9B69B0' },
};

/**
 * The game's description markup uses single-character color aliases inside
 * <color=X> tags (LocalizationManager.RewriteDescription). This is that
 * table, hex values extracted from the game's serialized Library singleton.
 */
const GAMBIT_ALIAS_COLORS = {
  '&': '#AB723C', '|': '#A840FF', '∏': '#D15D00', '°': '#0079FF',
  '£': '#C00000', '^': '#36BC54', '*': '#FFA800', '§': '#C29077',
  '_': '#FF1200', '¨': '#B7B7B7', '€': '#D6BA94', '~': '#B75C5E',
  '}': '#FFF740', '@': '#DE00FF', 'Ø': '#1DFF00', '‡': '#448446',
  '∑': '#445482', 'π': '#84444A', '≈': '#FF9B00', 'µ': '#00FFDB',
  'æ': '#648FFF', 'ƒ': '#E35AFF', '◊': '#448547', '∞': '#FFC700',
  'ß': '#6C8383', '©': '#FF6600', '√': '#00B0FF', '∆': '#0DBE00',
  '∂': '#FF2400', '∫': '#F9A0FF', '≠': '#AAAAAA',
};

/** <sprite=N> piece glyphs from the game's tile font asset, as unicode. */
const GAMBIT_SPRITE_GLYPHS = { 5: '♟', 6: '♜', 7: '♞', 8: '♝', 9: '♚', 10: '♛', 11: '!' };

/**
 * Render the game's TextMeshPro-ish markup into safe DOM: <color=X>, <br>,
 * <i>, <b> and <sprite=N> are honoured; animation tags (<wave>, <bounce>)
 * and anything unknown are stripped. Never touches innerHTML - registry data
 * becomes text nodes and styled spans only.
 */
function renderGambitMarkup(text) {
  const root = el('span', {});
  let cur = root;
  const stack = [];
  const re = /<([^<>]{1,40})>/g;
  let last = 0;
  let m;
  const pushText = (s) => { if (s) cur.append(document.createTextNode(s)); };
  while ((m = re.exec(String(text)))) {
    pushText(String(text).slice(last, m.index));
    last = re.lastIndex;
    const tag = m[1];
    if (tag === 'br') { cur.append(el('br')); continue; }
    if (tag === 'i' || tag === 'b') {
      const node = el(tag);
      cur.append(node); stack.push(cur); cur = node;
      continue;
    }
    if (tag === '/i' || tag === '/b' || tag === '/color') { cur = stack.pop() || root; continue; }
    const color = /^color=(.+)$/.exec(tag);
    if (color) {
      const value = GAMBIT_ALIAS_COLORS[color[1]]
        || (/^#[0-9a-fA-F]{3,8}$/.test(color[1]) ? color[1] : null);
      const node = el('span', value ? { style: `color:${value}` } : {});
      cur.append(node); stack.push(cur); cur = node;
      continue;
    }
    const glyph = /^sprite=(\d+)$/.exec(tag);
    if (glyph) {
      const g = GAMBIT_SPRITE_GLYPHS[glyph[1]];
      if (g) cur.append(el('span', { class: 'gglyph' }, g));
      continue;
    }
    // <wave>, <bounce>, </wave>, </bounce>, anything else: stripped.
  }
  pushText(String(text).slice(last));
  return root;
}

/**
 * One gambit as an in-game collection tile + hover tooltip.
 * `index` staggers the pop-in and desyncs the idle bob so a shelf of cards
 * doesn't move in lockstep. `from` credits the mod on the tooltip.
 * `size: 'mini'` is the row/card chip variant.
 */
function gambitCard(g, { size = '', index = 0, from = null } = {}) {
  const rar = RARITY_COLORS[g.rarity] || RARITY_COLORS.common;
  const rarityLabel = (g.rarity || 'common').replace(/^./, (c) => c.toUpperCase());

  const tip = el('div', { class: 'gtip' },
    el('div', { class: 'gtip-name' }, g.name),
    el('div', { class: 'gtip-rarity', style: `background:${rar.main}; border-color:${rar.secondary}` }, rarityLabel),
    g.description ? el('div', { class: 'gtip-desc' }, renderGambitMarkup(g.description)) : null,
    from ? el('div', { class: 'gtip-from' }, `from ${from}`) : null);

  return el('div', {
    class: `gcard${size ? ` ${size}` : ''}`,
    style: `--rmain:${rar.main}; --pop:${(index * 0.06).toFixed(2)}s; --bob:${((index % 5) * 0.45).toFixed(2)}s`,
    // The tooltip centers under the tile, but a tile near the pane's edge
    // would push it past the scroller and get it clipped - shift it back
    // inside just before it shows. Measured per hover: layout shifts with
    // window size and scroll position.
    onmouseenter: (ev) => {
      const cardEl = ev.currentTarget;
      const tipEl = cardEl.querySelector('.gtip');
      const pane = document.querySelector('main.content');
      if (!tipEl || !pane) return;
      const half = (tipEl.offsetWidth || 252) / 2 + 8;
      const center = cardEl.getBoundingClientRect().left + cardEl.offsetWidth / 2;
      const bounds = pane.getBoundingClientRect();
      let shift = 0;
      if (center - half < bounds.left) shift = bounds.left - (center - half);
      else if (center + half > bounds.right) shift = bounds.right - (center + half);
      tipEl.style.left = `calc(50% + ${Math.round(shift)}px)`;
    },
  },
    el('div', { class: 'gclip' },
      el('div', { class: 'ghalo' }),
      el('div', { class: 'gbob' },
        // No loading="lazy": the pop-in animation starts at scale(0), which
        // the lazy-load intersection check reads as zero area - the image
        // then never loads. Sprites are a few KB each; eager is fine.
        el('img', {
          class: 'gspr',
          src: g.sprite,
          alt: g.name,
          draggable: 'false',
          onerror: (ev) => ev.target.closest('.gcard')?.classList.add('noimg'),
        }))),
    g.price != null && !size ? el('div', { class: 'gprice' }, `$${g.price}`) : null,
    tip);
}

// ---------------------------------------------------------------------------
// Toasts + modal
// ---------------------------------------------------------------------------

/**
 * Toasts, without the pile-up: firing the same message again bumps the
 * existing toast and restarts its clock instead of stacking a twin; at most
 * three live at once (oldest glides out early); each shows a draining life
 * bar and can be clicked away. Exits collapse their height so the rest of
 * the stack settles smoothly instead of jumping.
 */
const MAX_TOASTS = 3;

function toast(message, kind = '') {
  const box = $('toasts');

  for (const existing of box.children) {
    if (existing.dataset.message === message && !existing.dataset.leaving) {
      existing.classList.remove('bump');
      void existing.offsetWidth; // restart the bump animation
      existing.classList.add('bump');
      startToastClock(existing);
      return;
    }
  }

  const t = el('div', {
    class: `toast ${kind}`,
    'data-message': message,
    title: 'Click to dismiss',
    onclick: () => dismissToast(t),
  },
    message,
    el('div', { class: 'toast-life' }));
  box.append(t);

  const alive = [...box.children].filter((x) => !x.dataset.leaving);
  for (const old of alive.slice(0, Math.max(0, alive.length - MAX_TOASTS))) dismissToast(old);

  startToastClock(t);
}

function startToastClock(t) {
  clearTimeout(t.toastTimer);
  const life = t.classList.contains('err') ? 7000 : 4200;
  const bar = t.querySelector('.toast-life');
  if (bar) {
    bar.style.animation = 'none';
    void bar.offsetWidth;
    bar.style.animation = `toast-life ${life}ms linear forwards`;
  }
  t.toastTimer = setTimeout(() => dismissToast(t), life);
}

function dismissToast(t) {
  if (t.dataset.leaving) return;
  t.dataset.leaving = '1';
  clearTimeout(t.toastTimer);
  // Pin the current height so the transition has a number to collapse from.
  t.style.height = `${t.offsetHeight}px`;
  requestAnimationFrame(() => t.classList.add('out'));
  const drop = () => t.remove();
  t.addEventListener('transitionend', drop, { once: true });
  setTimeout(drop, 500); // in case the transition never fires (hidden tab)
}

const modal = {
  open({ title, body, progress = false, buttons = [] }) {
    $('modalTitle').textContent = title;
    $('modalBody').textContent = body || '';
    $('modalInput').hidden = true;
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

/** confirmModal with a text input; resolves the trimmed value, or null. */
function promptModal({ title, body, placeholder = '', initial = '', confirmLabel = 'OK' }) {
  return new Promise((resolve) => {
    const input = $('modalInput');
    const done = (value) => { input.hidden = true; input.onkeydown = null; modal.close(); resolve(value); };
    modal.open({
      title,
      body,
      buttons: [
        { label: 'Cancel', kind: 'btn-cream', onClick: () => done(null) },
        { label: confirmLabel, kind: 'btn-green', onClick: () => done(input.value.trim() || null) },
      ],
    });
    input.hidden = false;
    input.value = initial;
    input.placeholder = placeholder;
    input.onkeydown = (ev) => {
      if (ev.key === 'Enter') done(input.value.trim() || null);
      if (ev.key === 'Escape') done(null);
    };
    setTimeout(() => { input.focus(); input.select(); }, 0);
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
  renderModpacks();
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
  renderInstanceSelector();
}

// ---------------------------------------------------------------------------
// Instances
// ---------------------------------------------------------------------------

function instanceList() {
  return state.data?.instances?.instances || [];
}

function activeInstance() {
  const list = instanceList();
  return list.find((i) => i.active) || list[0] || null;
}

/**
 * The header dropdown between the game pill and Play: which instance the
 * game loads. Sits in the topbar because it answers the question Play asks -
 * "play WHAT?" - exactly like a Minecraft launcher's profile picker.
 */
function renderInstanceSelector() {
  const box = $('instSelect');
  const list = instanceList();
  const current = activeInstance();
  if (!current) { box.replaceChildren(); return; }
  const open = state.ui.instMenuOpen;

  const rows = list.map((i) => el('button', {
    class: `mi inst-mi${i.active ? ' current' : ''}`,
    onclick: (ev) => {
      ev.stopPropagation();
      state.ui.instMenuOpen = false;
      if (i.active) renderInstanceSelector();
      else selectInstance(i.id);
    },
  },
    el('span', { class: 'inst-check' }, i.active ? '✓' : ''),
    el('span', { class: 'inst-name' }, i.name),
    el('span', { class: 'inst-count' }, `${i.modCount} mod${i.modCount === 1 ? '' : 's'}`)));

  box.replaceChildren(el('span', { class: `dropdown inst-dd${open ? ' open' : ''}` },
    el('button', {
      class: 'btn btn-wine inst-btn',
      title: 'The instance the game will load - click to switch',
      onclick: (ev) => {
        ev.stopPropagation();
        state.ui.instMenuOpen = !open;
        renderInstanceSelector();
      },
    },
      el('span', { class: 'micon', html: ICONS.pack }),
      el('span', { class: 'inst-btn-name' }, current.name),
      el('span', { class: 'caret' }, '▾')),
    el('div', { class: 'menu' },
      el('div', { class: 'mhead' }, 'Instance to play'),
      rows,
      el('div', { class: 'msep' }),
      el('button', {
        class: 'mi',
        onclick: (ev) => { ev.stopPropagation(); state.ui.instMenuOpen = false; renderInstanceSelector(); createInstanceFlow(); },
      }, '＋ New instance…'),
      el('button', {
        class: 'mi',
        onclick: (ev) => { ev.stopPropagation(); state.ui.instMenuOpen = false; renderInstanceSelector(); show('installed'); },
      }, 'Manage instances →'))));
}

async function selectInstance(id) {
  const inst = instanceList().find((i) => i.id === id);
  // No cancel button on purpose: a half-done folder swap is the one state we
  // never want a user to create on purpose. Swaps are near-instant anyway.
  modal.open({ title: 'Switching instance', body: `Loading "${inst?.name || '…'}"…`, progress: true });
  try {
    await call(api.selectInstance, { id });
    modal.close();
    toast(`Now on "${inst?.name || 'instance'}" - its mods load next launch.`, 'ok');
  } catch (err) {
    modal.close();
    toast(err.message, 'err');
  }
  await refresh();
}

/** Create (and select) a new instance. Returns the record, or null. */
async function createInstanceFlow({ name = '', modpackId = null } = {}) {
  const chosen = await promptModal({
    title: 'New instance',
    body: 'An instance is its own set of mods - switch between them any time from the bar up top.',
    placeholder: 'e.g. Vanilla+, Gambit chaos…',
    initial: name,
    confirmLabel: 'Create',
  });
  if (!chosen) return null;
  try {
    const rec = await call(api.createInstance, { name: chosen, modpackId });
    await call(api.selectInstance, { id: rec.id });
    toast(`Instance "${rec.name}" created and selected - install something into it!`, 'ok');
    await refresh();
    return rec;
  } catch (err) {
    toast(err.message, 'err');
    return null;
  }
}

async function renameInstanceFlow(inst) {
  const name = await promptModal({
    title: 'Rename instance',
    body: '',
    placeholder: 'New name',
    initial: inst.name,
    confirmLabel: 'Rename',
  });
  if (!name || name === inst.name) return;
  try {
    await call(api.renameInstance, { id: inst.id, name });
  } catch (err) {
    toast(err.message, 'err');
  }
  await refresh();
}

async function deleteInstanceFlow(inst) {
  const yes = await confirmModal({
    title: `Delete "${inst.name}"?`,
    body: inst.modCount
      ? `Its ${inst.modCount} mod${inst.modCount === 1 ? '' : 's'} are deleted with it. Other instances keep their own copies of everything.`
      : 'The instance is empty - nothing else is touched.',
    confirmLabel: 'Delete',
  });
  if (!yes) return;
  try {
    await call(api.deleteInstance, { id: inst.id });
    toast(`Instance "${inst.name}" deleted.`, 'ok');
  } catch (err) {
    toast(err.message, 'err');
  }
  await refresh();
}

/** The instance cards on the Instances view. */
function renderInstanceCards() {
  const grid = $('instGrid');
  const packsById = new Map((state.data?.registry?.modpacks || []).map((p) => [p.id, p]));

  const cards = instanceList().map((i) => {
    const pack = i.modpackId ? packsById.get(i.modpackId) : null;
    const bits = [`${i.modCount} mod${i.modCount === 1 ? '' : 's'}`];
    if (pack) bits.push(`from ${pack.name}`);
    if (i.lastPlayedAt) bits.push(`played ${new Date(i.lastPlayedAt).toLocaleDateString()}`);
    return el('div', {
      class: `inst-card${i.active ? ' active' : ''}`,
      title: i.active ? 'The selected instance - the game loads these mods' : 'Click to switch to this instance',
      onclick: () => { if (!i.active) selectInstance(i.id); },
    },
      el('div', { class: 'head' },
        el('h3', {}, i.name),
        i.active ? el('span', { class: 'tag green' }, 'selected') : null),
      el('div', { class: 'meta' }, bits.join(' · ')),
      el('div', { class: 'foot' },
        pack ? el('button', {
          class: 'btn btn-cream small',
          title: 'Open the modpack this instance was made from',
          onclick: (ev) => { ev.stopPropagation(); openPackDetail(pack.id); },
        }, 'Pack') : null,
        el('button', { class: 'btn btn-cream small', onclick: (ev) => { ev.stopPropagation(); renameInstanceFlow(i); } }, 'Rename'),
        i.active
          ? el('button', { class: 'btn btn-green small', onclick: (ev) => { ev.stopPropagation(); launchGame(); } }, '▶ Play')
          : el('button', { class: 'btn btn-red small', onclick: (ev) => { ev.stopPropagation(); deleteInstanceFlow(i); } }, 'Delete')));
  });

  cards.push(el('button', { class: 'inst-card new', onclick: () => createInstanceFlow() },
    el('span', { class: 'plus' }, '＋'), 'New instance'));
  grid.replaceChildren(...cards);
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
    const inst = activeInstance();
    hint.textContent = modCount
      ? `${modCount} mod${modCount === 1 ? '' : 's'} from "${inst?.name || 'your instance'}" will load on the next launch.`
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

  // "Add to modpack": a dropdown feeding the pack draft in the Modpacks tab.
  // Only reviewed mods get the button - packs can never hold unreviewed ones.
  if (mod.reviewed !== false) {
    const draft = state.packPublish.entry.mods || [];
    const inDraft = draft.includes(mod.id);
    const open = state.ui.packMenuFor === mod.id;
    foot.append(el('span', { class: `dropdown${open ? ' open' : ''}` },
      el('button', {
        class: `btn btn-cream small${inDraft ? ' in-draft' : ''}`,
        title: inDraft ? 'In your modpack draft' : 'Add to a modpack',
        onclick: (ev) => {
          ev.stopPropagation();
          state.ui.packMenuFor = open ? null : mod.id;
          renderBrowse();
        },
      }, el('span', { class: 'micon', html: ICONS.pack }), ' ▾'),
      el('div', { class: 'menu' },
        el('div', { class: 'mhead' }, draft.length
          ? `Your modpack draft · ${draft.length} mod${draft.length === 1 ? '' : 's'}`
          : 'Your modpack draft is empty'),
        el('button', { class: 'mi', onclick: (ev) => { ev.stopPropagation(); togglePackDraft(mod); } },
          inDraft ? '✓ In the draft - remove' : '+ Add to the draft'),
        el('button', {
          class: 'mi',
          onclick: (ev) => { ev.stopPropagation(); state.ui.packMenuFor = null; show('modpacks'); renderBrowse(); },
        }, 'Finish the pack →'))));
  }

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
    (mod.gambits || []).length
      ? el('div', { class: 'gambit-minis' }, ...mod.gambits.map((g, i) => gambitCard(g, { size: 'mini', index: i })))
      : null,
    statsRow(mod, tiers),
    deps,
    foot);
}

// ---------------------------------------------------------------------------
// Modpacks
// ---------------------------------------------------------------------------

/** Add/remove a mod in the pack draft the Modpacks tab's form submits. */
function togglePackDraft(mod) {
  const e = state.packPublish.entry;
  const mods = e.mods || [];
  if (mods.includes(mod.id)) {
    e.mods = mods.filter((x) => x !== mod.id);
    toast(`${mod.name} removed from your modpack draft.`);
  } else if (mods.length >= 24) {
    toast('A modpack holds at most 24 mods.', 'err');
    return;
  } else {
    e.mods = [...mods, mod.id];
    toast(`${mod.name} added to your modpack draft (${e.mods.length} mod${e.mods.length === 1 ? '' : 's'}).`, 'ok');
  }
  renderBrowse();     // the card's button + open menu flip state in place
  renderModpacks();   // the publish form's picker chips stay in sync
}

/** Registry rows for a pack's members + what installing would actually do. */
function packMemberState(pack) {
  const registryById = new Map((state.data?.registry?.mods || [])
    .filter((m) => m.kind === 'registry').map((m) => [m.id, m]));
  const members = (pack.mods || []).map((id) => registryById.get(id)).filter(Boolean);
  return {
    members,
    missing: members.filter((m) => !m.installed && m.installable),
    updates: members.filter((m) => m.installed && m.updateAvailable),
    installedCount: members.filter((m) => m.installed).length,
    vanished: (pack.mods || []).filter((id) => !registryById.has(id)),
  };
}

function packBadges({ members, missing, updates, installedCount }) {
  const badges = [];
  if (members.length && installedCount === members.length && !updates.length) {
    badges.push(el('span', { class: 'tag green' }, 'installed'));
  } else if (installedCount > 0) {
    badges.push(el('span', { class: 'tag' }, `${installedCount}/${members.length} installed`));
  }
  if (updates.length) badges.push(el('span', { class: 'tag blue' }, 'update'));
  return badges;
}

/** The pack's install/update/installed button, shared by card and detail. */
function packActionButton(pack, ms, { size = 'small' } = {}) {
  const { members, missing, updates } = ms;
  const inst = activeInstance();
  if (!members.length || !pack.installable) {
    return el('button', { class: `btn btn-cream ${size}`, disabled: true }, 'Not installable yet');
  }
  if (!missing.length && !updates.length) {
    return el('button', { class: `btn btn-cream ${size}`, disabled: true }, 'All installed ✓');
  }
  const n = missing.length + updates.length;
  const label = missing.length
    ? (size === 'small' ? `Install pack (${n})` : `Install into "${inst?.name || 'instance'}" (${n})`)
    : `Update (${n})`;
  return el('button', {
    class: `btn btn-green ${size}`,
    title: inst ? `Installs into the selected instance: ${inst.name}` : '',
    onclick: (ev) => { ev.stopPropagation(); installModpack(pack, ms); },
  }, label);
}

function renderModpacks() {
  const packs = state.data?.registry?.modpacks || [];
  $('packCount').hidden = packs.length === 0;
  $('packCount').textContent = String(packs.length);

  // Detail page open? It replaces the browsing surface entirely.
  const detailPack = state.packDetail ? packs.find((p) => p.id === state.packDetail) : null;
  if (state.packDetail && !detailPack) state.packDetail = null; // pack vanished from the registry
  $('packBrowse').hidden = !!detailPack;
  $('packDetail').hidden = !detailPack;
  if (detailPack) {
    renderPackDetail(detailPack);
    return;
  }

  $('packsEmpty').hidden = packs.length > 0;
  $('packGrid').replaceChildren(...packs.map(renderPackCard));

  $('packPublishAuth').replaceChildren(authBox('modpack'));
  renderPackPublishForm();
}

function openPackDetail(id) {
  state.packDetail = id;
  if (state.view !== 'modpacks') show('modpacks');
  renderModpacks();
}

function closePackDetail() {
  state.packDetail = null;
  renderModpacks();
}

/**
 * The browsing card: a teaser, not the whole manifest. Name, what it's for,
 * how much is installed - the full mod list lives one click away on the
 * detail page, where each mod gets a real row instead of a cramped chip.
 */
function renderPackCard(pack) {
  const ms = packMemberState(pack);
  const { members } = ms;

  const previewNames = members.slice(0, 3).map((m) => m.name).join(', ');
  const more = members.length > 3 ? ` +${members.length - 3} more` : '';

  // No download stat on packs: summing the members' lifetime counts would
  // just re-count downloads that predate the pack - a meaningless number.
  const foot = el('div', { class: 'foot' },
    el('span', { class: 'grow' }),
    el('button', { class: 'btn btn-cream small', onclick: (ev) => { ev.stopPropagation(); openPackDetail(pack.id); } }, 'View pack'),
    packActionButton(pack, ms));

  return el('div', {
    class: 'mod-card pack-card',
    title: 'See everything inside this pack',
    onclick: () => openPackDetail(pack.id),
  },
    el('div', { class: 'head' },
      el('div', {},
        el('h3', {}, pack.name),
        el('div', { class: 'by' }, `by ${pack.author} · ${members.length} mods`)),
      el('div', { class: 'badges' }, packBadges(ms))),
    el('div', { class: 'sum' }, pack.summary || ''),
    members.length ? el('div', { class: 'tiny muted' }, `Includes ${previewNames}${more}`) : null,
    foot);
}

/**
 * The gambit shelf at the top of a pack page: every gambit the pack's mods
 * add, as in-game tiles. THIS is what the pack actually puts in your runs,
 * shown the way the game itself would show it.
 */
function packGambitShelf(members) {
  const gambits = members.flatMap((m) => (m.gambits || []).map((g) => ({ g, from: m.name })));
  if (!gambits.length) return null;
  return el('div', { class: 'gambit-shelf-wrap' },
    el('div', { class: 'section-band' }, `The gambits inside · ${gambits.length}`),
    el('div', { class: 'gambit-shelf' },
      ...gambits.map(({ g, from }, i) => gambitCard(g, { index: i, from }))),
    el('div', { class: 'tiny muted', style: 'margin-top:4px' },
      'Hover a card - these are the real in-game sprites, straight from each mod.'));
}

/**
 * The pack detail page: everything the chip wall couldn't say. Each member
 * is a full row - what it does, its version, its own install state and
 * buttons - plus the two pack-level actions: install into the selected
 * instance, or spin up a fresh instance around the pack.
 */
function renderPackDetail(pack) {
  const box = $('packDetail');
  const ms = packMemberState(pack);
  const { members, vanished } = ms;
  const registryMods = (state.data?.registry?.mods || []).filter((m) => m.kind === 'registry');
  const tiers = popularityTiers(registryMods);
  const wrappingInstances = instanceList().filter((i) => i.modpackId === pack.id);

  const rows = members.map((m) => {
    const badges = [];
    if (m.installed) badges.push(el('span', { class: 'tag green' }, 'installed'));
    if (m.updateAvailable) badges.push(el('span', { class: 'tag blue' }, 'update'));

    let action;
    if (m.installed && m.updateAvailable) {
      action = el('button', { class: 'btn btn-green small', onclick: () => installMod(m) }, 'Update');
    } else if (m.installed) {
      action = el('button', { class: 'btn btn-red small', onclick: () => uninstallMod(m.folder, m.name) }, 'Remove');
    } else if (m.installable) {
      action = el('button', { class: 'btn btn-green small', onclick: () => installMod(m) }, 'Install');
    } else {
      action = el('button', { class: 'btn btn-cream small', disabled: true }, 'No release yet');
    }

    return el('div', { class: 'mod-row pack-member' },
      (m.gambits || []).length
        ? el('div', { class: 'gambit-minis' }, ...m.gambits.map((g, i) => gambitCard(g, { size: 'mini', index: i })))
        : null,
      el('div', { class: 'info' },
        el('div', { class: 'nm' },
          m.name, ' ',
          m.latest?.version ? el('span', { class: 'ver' }, `v${m.latest.version}`) : null),
        el('div', { class: 'meta' }, `by ${m.author}`),
        el('div', { class: 'psum' }, m.summary || ''),
        statsRow(m, tiers)),
      el('div', { class: 'side' },
        el('div', { class: 'badges' }, badges),
        el('div', { class: 'row-btns' },
          el('button', {
            class: 'btn btn-cream small',
            title: 'Open the mod’s source code on GitHub',
            onclick: () => api.openExternal(m.homepage || `https://github.com/${m.repo}`),
          }, 'Source'),
          action)));
  });

  box.replaceChildren(el('div', { class: 'card-window' },
    el('span', { class: 'window-title' }, 'Modpack'),
    el('div', { class: 'pack-detail-top' },
      el('button', { class: 'btn btn-cream small', onclick: closePackDetail }, '← All modpacks')),
    el('div', { class: 'pack-detail-head' },
      el('h2', {}, pack.name),
      el('div', { class: 'badges' }, packBadges(ms)),
      el('div', { class: 'by' }, `by ${pack.author} · ${members.length} mods`)),
    (pack.description || pack.summary)
      ? el('p', { class: 'pack-desc' }, pack.description || pack.summary)
      : null,
    wrappingInstances.length
      ? el('div', { class: 'tiny muted', style: 'margin-bottom:10px' },
          `Instance${wrappingInstances.length === 1 ? '' : 's'} made from this pack: ${wrappingInstances.map((i) => i.name).join(', ')}`)
      : null,
    packGambitShelf(members),
    el('div', { class: 'pack-actions' },
      packActionButton(pack, ms, { size: '' }),
      pack.installable && members.length
        ? el('button', {
            class: 'btn btn-wine',
            title: 'A fresh instance with exactly this pack in it',
            onclick: () => newInstanceFromPack(pack),
          }, '+ New instance from this pack')
        : null),
    el('div', { class: 'section-band', style: 'margin:18px 0 12px' }, "What's inside"),
    ...rows,
    vanished.length
      ? el('div', { class: 'inset-row tiny', style: 'margin-top:6px' },
          `${vanished.length} mod${vanished.length === 1 ? ' is' : 's are'} no longer in the registry and will be skipped: ${vanished.join(', ')}`)
      : null));
}

/** Create a fresh instance wrapping `pack`, select it, install the pack. */
async function newInstanceFromPack(pack) {
  const name = await promptModal({
    title: 'New instance from pack',
    body: `Creates a fresh instance, switches to it, and installs ${pack.name} into it. Your other instances are untouched.`,
    placeholder: 'Instance name',
    initial: pack.name,
    confirmLabel: 'Create & install',
  });
  if (!name) return;
  try {
    const rec = await call(api.createInstance, { name, modpackId: pack.id });
    await call(api.selectInstance, { id: rec.id });
  } catch (err) {
    toast(err.message, 'err');
    return;
  }
  await refresh();
  // The instance is brand new, so the plan is simply "everything in the pack"
  // - no need to re-confirm what the user just asked for by name.
  await installModpackNow(pack);
}

async function installModpack(pack, { missing, updates }) {
  const inst = activeInstance();
  const lines = [
    inst ? `Into your "${inst.name}" instance.` : '',
    missing.length ? `Installs ${missing.map((m) => m.name).join(', ')}.` : '',
    updates.length ? `Updates ${updates.map((m) => m.name).join(', ')}.` : '',
    'Mods they depend on come along automatically. Anything you already have is left alone.',
  ].filter(Boolean).join(' ');
  const yes = await confirmModal({
    title: `Install ${pack.name}?`,
    body: lines,
    confirmLabel: 'Install',
    confirmKind: 'btn-green',
  });
  if (!yes) return;
  await installModpackNow(pack);
}

/** The actual pack install: progress modal + IPC + refresh. */
async function installModpackNow(pack) {
  const operationId = `pack-${++opCounter}`;
  modal.open({
    title: `Installing ${pack.name}`,
    body: 'Getting started…',
    progress: true,
    buttons: [{ label: 'Cancel', kind: 'btn-cream', onClick: () => api.cancelOperation({ operationId }) }],
  });
  try {
    const result = await call(api.installModpack, { id: pack.id, operationId });
    modal.close();
    toast(`${pack.name}: ${result.installed.length} mod${result.installed.length === 1 ? '' : 's'} installed.`, 'ok');
  } catch (err) {
    modal.close();
    toast(err.message, 'err');
  }
  await refresh();
}

function renderPackPublishForm() {
  const p = state.packPublish;
  const box = $('packPublishForm');
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

  // Only reviewed registry mods can go in a pack - the whole point of the
  // reviewed badge would evaporate if a pack could smuggle in an unreviewed
  // submission. The picker simply doesn't offer them.
  const eligible = (state.data?.registry?.mods || [])
    .filter((m) => m.kind === 'registry' && m.reviewed !== false)
    .sort((a, b) => a.name.localeCompare(b.name));
  const picked = e.mods || [];

  box.replaceChildren(
    el('div', { class: 'form-grid', style: 'margin-top:14px' },
      field('Pack name', 'name', { placeholder: 'My Perfect Loadout' }),
      field('Registry id', 'id', { placeholder: 'my-perfect-loadout', help: 'lowercase-with-dashes, permanent' }),
      field('Author', 'author', { placeholder: 'you' }),
      field('One-line summary', 'summary', { placeholder: 'What is this pack FOR?' }),
      el('div', { class: 'field full' },
        el('label', {}, `Mods in the pack (${picked.length} picked, at least 2)`),
        el('div', { class: 'chip-row' }, ...eligible.map((m) =>
          el('button', {
            class: `chip${picked.includes(m.id) ? ' on' : ''}`,
            title: m.summary || '',
            onclick: (ev) => {
              ev.preventDefault();
              e.mods = picked.includes(m.id) ? picked.filter((x) => x !== m.id) : [...picked, m.id].slice(0, 24);
              renderPackPublishForm();
            },
          }, m.name))),
        el('div', { class: 'help' }, 'Dependencies (like the Gambit API) install automatically - no need to pick them.')),
      field('Longer description', 'description', { full: true, textarea: true, placeholder: 'Why these mods together? (optional)' }),
    ),
    el('div', { style: 'display:flex; gap:10px; justify-content:center; margin-top:18px; flex-wrap:wrap' },
      state.publish.signedIn
        ? el('button', { class: 'btn btn-green', disabled: p.submitting, onclick: submitPackEntry },
            p.submitting ? 'Submitting…' : 'Submit to the registry')
        : null,
      el('button', { class: 'btn btn-cream', onclick: openPackIssueSubmission }, 'Open submission on GitHub'),
    ),
  );
}

async function submitPackEntry() {
  const p = state.packPublish;
  p.submitting = true;
  renderPackPublishForm();
  try {
    const result = await call(api.publishSubmitModpack, { entry: p.entry });
    toast('Modpack submitted! The maintainers will review it soon.', 'ok');
    api.openExternal(result.url);
  } catch (err) {
    toast(err.message, 'err');
  } finally {
    p.submitting = false;
    renderPackPublishForm();
  }
}

async function openPackIssueSubmission() {
  try {
    const url = await call(api.publishModpackIssueUrl, { entry: state.packPublish.entry });
    api.openExternal(url);
  } catch (err) {
    toast(err.message, 'err');
  }
}

// ---------------------------------------------------------------------------
// Installed
// ---------------------------------------------------------------------------

function renderInstalled() {
  renderInstanceCards();

  const installed = state.data?.installed || [];
  const inst = activeInstance();
  $('installedTitle').textContent = inst ? `Mods in "${inst.name}"` : 'My mods';
  // The nav badge counts INSTANCES - the tab is named after them, and the
  // selected instance's mod count already lives in the header selector.
  const instCount = instanceList().length;
  $('installedCount').hidden = instCount === 0;
  $('installedCount').textContent = String(instCount);
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
    // Both tabs show the auth box; repaint both so the device code appears
    // wherever the user actually clicked "Sign in".
    renderPublish();
    renderModpacks();
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
  renderModpacks();
  loadRepos();
});

api.on('publish:signInFailed', ({ error }) => {
  state.publish.device = null;
  toast(`Sign-in failed: ${error}`, 'err');
  renderPublish();
  renderModpacks();
});

for (const btn of document.querySelectorAll('.nav-btn')) {
  btn.addEventListener('click', () => show(btn.dataset.view));
}
// Click anywhere outside an open dropdown closes it.
document.addEventListener('click', (ev) => {
  if (state.ui.packMenuFor && !ev.target.closest('.dropdown')) {
    state.ui.packMenuFor = null;
    renderBrowse();
  }
  if (state.ui.instMenuOpen && !ev.target.closest('.inst-dd')) {
    state.ui.instMenuOpen = false;
    renderInstanceSelector();
  }
});
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
