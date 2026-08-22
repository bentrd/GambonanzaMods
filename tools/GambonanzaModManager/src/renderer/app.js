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
  share: {
    entry: { mods: [] },   // the registry entry the selected modpack would become
    submitting: false,
    prefilledFor: null,
    suggested: null,
  },
  tpPublish: {
    entry: {},
    submitting: false,
    prefilledFor: null,
  },
  ui: {
    mpMenuOpen: false,    // header modpack-selector dropdown
    mpModMenu: null,      // folder of the mod tile whose menu is open
    mpSkinMenu: false,    // the active modpack's texture-pack picker
    mpAddMenu: false,     // the modpack "+" tile's Mods/Textures menu
    tpAddMenuOpen: false, // the texture-pack "+" tile's Image/Text menu
  },
  mp: {
    selectedId: null,    // modpack the contents panel is showing
  },
  tp: {
    selectedId: null,    // texture pack the bottom panel is showing
    detail: null,        // its full manifest
    catalog: null,       // the game's sprites + textures (fetched once)
    texts: null,         // the game's localised strings (fetched once)
    previews: new Map(), // assetId -> data URL, or null when the site has none
    pending: new Set(),
    browser: null,       // open asset-browser modal state
  },
};

const $ = (id) => document.getElementById(id);
/**
 * replaceChildren() stringifies anything that is not a Node, so a `cond ? x :
 * null` hole renders the word "null" on screen. el() already filters those out
 * of its own children; this does the same for a container being repainted.
 */
const fill = (node, ...children) => node.replaceChildren(...children.flat().filter((c) => c != null && c !== false));
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
  warn: pix('M5 1h2v1H5zM4 2h4v1H4zM4 3h4v1H4zM3 4h6v1H3zM3 5h2v1H3zM7 5h2v1H7zM2 6h3v1H2zM7 6h3v1H7zM2 7h3v1H2zM7 7h3v1H7zM1 8h4v1H1zM7 8h4v1H7zM1 9h10v1H1z'),
  modchip: pix('M2 2h8v1H2zM2 9h8v1H2zM2 3h1v6H2zM9 3h1v6H9zM4 4h4v4H4zM0 4h2v1H0zM0 7h2v1H0zM10 4h2v1h-2zM10 7h2v1h-2z'),
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
  /** Set while a dismissable dialog is open, so Escape knows what to undo. */
  escape: null,

  /**
   * `content` takes real nodes, for the dialogs that are more than a sentence
   * and two buttons (the asset browser). `wide` widens the frame for them.
   */
  open({ title, body, progress = false, buttons = [], content = null, wide = false }) {
    $('modalTitle').textContent = title;
    $('modalBody').textContent = body || '';
    $('modalBody').hidden = !body;
    $('modalInput').hidden = true;
    const custom = $('modalCustom');
    custom.hidden = !content;
    custom.replaceChildren(...(content ? [content].flat().filter(Boolean) : []));
    document.querySelector('.modal').classList.toggle('wide', !!wide);
    // Only a button that says so is the way out. Inferring it from position
    // would make Escape press "Delete" on a confirmation dialog, which is the
    // exact opposite of what Escape means.
    this.escape = buttons.find((b) => b.dismiss)?.onClick || null;
    $('modalProgress').hidden = !progress;
    $('modalProgressFill').classList.add('indeterminate');
    $('modalProgressFill').style.width = '0%';
    const row = $('modalButtons');
    row.replaceChildren(...buttons.map(({ label, kind = 'btn-cream', onClick }) =>
      el('button', { class: `btn ${kind}`, onclick: onClick }, label)));
    $('modalBackdrop').classList.add('open');
    // Tab must not walk out of a modal into the app behind the backdrop.
    document.querySelector('.app').setAttribute('inert', '');
    setTimeout(() => {
      const first = document.querySelector('.modal input:not([hidden]), .modal textarea, .modal button');
      first?.focus();
    }, 0);
  },
  progress({ message, percent }) {
    if (message) $('modalBody').textContent = message;
    const bar = $('modalProgressFill');
    if (percent == null) {
      bar.classList.add('indeterminate');
    } else {
      bar.classList.remove('indeterminate');
      bar.style.width = `${percent}%`;
    }
  },
  close() {
    this.escape = null;
    document.querySelector('.app').removeAttribute('inert');
    $('modalBackdrop').classList.remove('open');
    $('modalCustom').replaceChildren();
    $('modalCustom').hidden = true;
    $('modalBody').hidden = false;
    document.querySelector('.modal').classList.remove('wide');
  },
};

function confirmModal({ title, body, confirmLabel, confirmKind = 'btn-red' }) {
  return new Promise((resolve) => {
    modal.open({
      title,
      body,
      buttons: [
        { label: 'Cancel', kind: 'btn-cream', dismiss: true, onClick: () => { modal.close(); resolve(false); } },
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
        { label: 'Cancel', kind: 'btn-cream', dismiss: true, onClick: () => done(null) },
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

/** Views that used to exist and now live somewhere else. */
const MOVED_VIEWS = { installed: 'modpacks' };

function show(view) {
  // A settings file written by an older version can still name a tab this
  // one no longer has; landing on a blank content pane is not an option.
  view = MOVED_VIEWS[view] || view;
  if (!document.getElementById(`view-${view}`)) view = 'home';
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
  renderTexturePacks();
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
  renderModpackSelector();
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
    const mp = activeModpack();
    hint.textContent = modCount
      ? `${modCount} mod${modCount === 1 ? '' : 's'} from "${mp?.name || 'your modpack'}" will load on the next launch.`
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
    // Say where it lands. Installs always go into the active modpack, and the
    // header picker is the only other place that fact is visible.
    foot.append(el('button', {
      class: 'btn btn-green small',
      title: `Installs into "${activeModpack()?.name || 'your modpack'}"`,
      onclick: () => installMod(mod),
    }, 'Install'));
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
// A modpack is a whole setup: the mods it loads AND the texture packs it wears.
// One is active at a time, its mods live in the game's Mods/ folder, and
// installing anything lands in it - so "the active modpack" and "my game right
// now" are the same sentence.
//
// This tab is laid out like Texture packs, because they answer the same kind
// of question: a shelf of the setups you own on top, the contents of the one
// you are looking at underneath, then the ones other people published, then
// the form that turns yours into one of those.

/** Every setup in the library, active one included. */
function mpList() {
  return state.data?.modpacks?.modpacks || [];
}

function activeModpack() {
  const list = mpList();
  return list.find((p) => p.active) || list[0] || null;
}

/** Which setup the contents panel is describing. Follows the active one. */
function selectedModpack() {
  const list = mpList();
  if (!list.length) return null;
  return list.find((p) => p.id === state.mp.selectedId) || activeModpack();
}

/** Registry rows keyed by id, for turning a mod's receipt into its entry. */
function registryModsById() {
  return new Map((state.data?.registry?.mods || []).map((m) => [m.id, m]));
}

/**
 * Which registry entry an installed mod is, if any. The receipt answers first;
 * failing that, the install folder does - mods that predate receipts, or that
 * someone unzipped by hand, are still recognisably the registry's mod, and
 * mods.mergeState() has always matched them that way. Without the fallback
 * they would show a blank chip instead of their gambit, never offer an
 * update, and quietly drop out of a shared setup.
 */
function registryEntryFinder() {
  const rows = (state.data?.registry?.mods || []).filter((m) => m.kind === 'registry');
  const byId = new Map(rows.map((m) => [m.id, m]));
  const byFolder = new Map(rows.map((m) => [String(m.folder).toLowerCase(), m]));
  return (mod) => (mod.registryId ? byId.get(mod.registryId) : null)
    || byFolder.get(String(mod.folder).toLowerCase())
    || null;
}

/**
 * The header dropdown between the game pill and Play: which setup the game
 * loads. Sits in the topbar because it answers the question Play asks -
 * "play WHAT?" - exactly like a Minecraft launcher's profile picker.
 */
function renderModpackSelector() {
  const box = $('mpSelect');
  const list = mpList();
  const current = activeModpack();
  if (!current) { box.replaceChildren(); return; }
  const open = state.ui.mpMenuOpen;

  const rows = list.map((p) => el('button', {
    class: `mi setup-mi${p.active ? ' current' : ''}`,
    onclick: (ev) => {
      ev.stopPropagation();
      state.ui.mpMenuOpen = false;
      if (p.active) renderModpackSelector();
      else selectModpack(p.id);
    },
  },
    el('span', { class: 'setup-check' }, p.active ? '✓' : ''),
    el('span', { class: 'setup-name' }, p.name),
    el('span', { class: 'setup-count' }, `${p.modCount} mod${p.modCount === 1 ? '' : 's'}`)));

  box.replaceChildren(el('span', { class: `dropdown setup-dd${open ? ' open' : ''}` },
    el('button', {
      class: 'btn btn-wine setup-btn',
      title: 'The modpack the game will load - click to switch',
      onclick: (ev) => {
        ev.stopPropagation();
        state.ui.mpMenuOpen = !open;
        renderModpackSelector();
      },
    },
      el('span', { class: 'micon', html: ICONS.pack }),
      el('span', { class: 'setup-btn-name' }, current.name),
      el('span', { class: 'caret' }, '▾')),
    el('div', { class: 'menu' },
      el('div', { class: 'mhead' }, 'Modpack to play'),
      rows,
      el('div', { class: 'msep' }),
      el('button', {
        class: 'mi',
        onclick: (ev) => { ev.stopPropagation(); state.ui.mpMenuOpen = false; renderModpackSelector(); createModpackFlow(); },
      }, '＋ New modpack…'),
      el('button', {
        class: 'mi',
        onclick: (ev) => { ev.stopPropagation(); state.ui.mpMenuOpen = false; renderModpackSelector(); show('modpacks'); },
      }, 'Manage modpacks →'))));
}

// ---- switching, creating, editing -----------------------------------------

async function selectModpack(id) {
  const mp = mpList().find((p) => p.id === id);
  // No cancel button on purpose: a half-done folder swap is the one state we
  // never want a user to create on purpose. Swaps are near-instant anyway.
  modal.open({ title: 'Switching modpack', body: `Loading "${mp?.name || '…'}"…`, progress: true });
  try {
    await call(api.selectModpack, { id });
    state.mp.selectedId = id;
    modal.close();
    toast(`Now on "${mp?.name || 'that modpack'}" - its mods load next launch.`, 'ok');
  } catch (err) {
    modal.close();
    toast(err.message, 'err');
  }
  await refresh();
}

/** Create (and switch to) an empty modpack. Returns the record, or null. */
async function createModpackFlow({ name = '' } = {}) {
  const chosen = await promptModal({
    title: 'New modpack',
    body: 'A modpack is its own set of mods and its own texture packs - switch between them any time from the bar up top.',
    placeholder: 'e.g. Vanilla+, Gambit chaos…',
    initial: name,
    confirmLabel: 'Create',
  });
  if (!chosen) return null;
  try {
    const rec = await call(api.createModpack, { name: chosen });
    await call(api.selectModpack, { id: rec.id });
    state.mp.selectedId = rec.id;
    toast(`"${rec.name}" created and selected - install something into it!`, 'ok');
    await refresh();
    return rec;
  } catch (err) {
    toast(err.message, 'err');
    return null;
  }
}

async function renameModpackFlow(mp) {
  const name = await promptModal({
    title: 'Rename modpack', body: '', placeholder: 'New name', initial: mp.name, confirmLabel: 'Rename',
  });
  if (!name || name === mp.name) return;
  try { await call(api.renameModpack, { id: mp.id, name }); } catch (err) { toast(err.message, 'err'); }
  await refresh();
}

async function deleteModpackFlow(mp) {
  const yes = await confirmModal({
    title: `Delete "${mp.name}"?`,
    body: mp.modCount
      ? `Its ${mp.modCount} mod${mp.modCount === 1 ? '' : 's'} are deleted with it. Your other modpacks keep their own copies of everything, and no texture pack is touched.`
      : 'The modpack is empty - nothing else is touched.',
    confirmLabel: 'Delete',
  });
  if (!yes) return;
  try {
    await call(api.deleteModpack, { id: mp.id });
    if (state.mp.selectedId === mp.id) state.mp.selectedId = null;
    toast(`"${mp.name}" deleted.`, 'ok');
  } catch (err) {
    toast(err.message, 'err');
  }
  await refresh();
}

// ---- the tab ---------------------------------------------------------------

function renderModpacks() {
  const mine = mpList();
  $('packCount').hidden = mine.length === 0;
  $('packCount').textContent = String(mine.length);

  // Detail page open? It replaces the browsing surface entirely.
  const packs = registryModpacks();
  const detailPack = state.packDetail ? packs.find((p) => p.id === state.packDetail) : null;
  if (state.packDetail && !detailPack) state.packDetail = null; // pack vanished from the registry
  $('packBrowse').hidden = !!detailPack;
  $('packDetail').hidden = !detailPack;
  if (detailPack) {
    renderPackDetail(detailPack);
    return;
  }

  renderModpackCards();
  renderModpackPanel();
  renderCommunityPacks();
  $('packPublishAuth').replaceChildren(authBox('modpack'));
  renderSharePackForm();
}

/** The shelf: one card per setup you own, plus the ＋ card. */
function renderModpackCards() {
  const grid = $('mpGrid');
  if (!grid) return;
  const chosen = selectedModpack();
  const skins = new Map(tpList().map((p) => [p.id, p]));
  const entryFor = registryEntryFinder();

  const cards = mpList().map((mp) => {
    const worn = (mp.texturePackIds || []).map((id) => skins.get(id)).filter(Boolean);
    const unreviewed = mp.mods.filter((m) => entryFor(m)?.reviewed === false);
    const bits = [`${mp.modCount} mod${mp.modCount === 1 ? '' : 's'}`];
    if (worn.length === 1) bits.push(worn[0].name);
    else if (worn.length) bits.push(`${worn.length} texture packs`);
    if (mp.lastPlayedAt) bits.push(`played ${new Date(mp.lastPlayedAt).toLocaleDateString()}`);

    return el('div', {
      class: `shelf-card${mp.active ? ' active' : ''}${chosen && chosen.id === mp.id && !mp.active ? ' sel' : ''}`,
      title: mp.active ? 'The active modpack - the game loads this' : 'Click to look inside this modpack',
      onclick: () => { state.mp.selectedId = mp.id; renderModpacks(); },
    },
      el('div', { class: 'head' },
        el('h3', {}, mp.name),
        mp.active ? el('span', { class: 'tag green' }, 'playing') : null,
        unreviewed.length ? unreviewedMark(unreviewed.map((m) => m.name)) : null),
      el('div', { class: 'meta' }, bits.join(' · ')),
      el('div', { class: 'foot' },
        mp.active
          ? el('button', { class: 'btn btn-green small', onclick: (ev) => { ev.stopPropagation(); launchGame(); } }, '▶ Play')
          : el('button', { class: 'btn btn-green small', title: 'Make the game load this modpack', onclick: (ev) => { ev.stopPropagation(); selectModpack(mp.id); } }, 'Switch to'),
        el('button', { class: 'btn btn-cream small', onclick: (ev) => { ev.stopPropagation(); renameModpackFlow(mp); } }, 'Rename'),
        el('button', {
          class: 'btn btn-cream small',
          title: 'Publish this whole setup so other people can install it in one click',
          onclick: (ev) => { ev.stopPropagation(); shareModpack(mp); },
        }, 'Share'),
        mp.active
          ? null
          : el('button', { class: 'btn btn-red small', onclick: (ev) => { ev.stopPropagation(); deleteModpackFlow(mp); } }, 'Delete')));
  });

  cards.push(el('button', { class: 'shelf-card new', onclick: () => createModpackFlow() },
    el('span', { class: 'plus' }, '＋'), 'New modpack'));
  grid.replaceChildren(...cards);
}

/** The small red triangle that says "this contains code nobody reviewed". */
function unreviewedMark(names) {
  const list = names.slice(0, 4).join(', ');
  const more = names.length > 4 ? `, and ${names.length - 4} more` : '';
  return el('span', {
    class: 'warn-mark',
    title: `${names.length} mod${names.length === 1 ? '' : 's'} in here nobody has reviewed: ${list}${more}. Read the source before playing with them.`,
    html: ICONS.warn,
  });
}

/**
 * The contents of the selected setup: the texture packs it wears in the head,
 * then one small tile per mod. Deliberately mute - someone with twenty mods
 * should see a shelf, not a table - with every detail on hover and the
 * actions one click in.
 *
 * Editing is only offered for the ACTIVE setup: the others have their mods
 * parked outside the game folder, and "enable this mod over there" is a
 * promise the park/swap model would have to fake.
 */
function renderModpackPanel() {
  const title = $('mpPanelTitle');
  const head = $('mpPanelHead');
  const tiles = $('mpTiles');
  const foot = $('mpFootnote');
  if (!tiles) return;

  const mp = selectedModpack();
  if (!mp) {
    title.textContent = 'Contents';
    head.replaceChildren();
    tiles.replaceChildren(el('div', { class: 'empty-note' }, 'No modpacks yet. Make one above.'));
    foot.hidden = true;
    return;
  }

  title.textContent = mp.name;
  const skins = new Map(tpList().map((p) => [p.id, p]));
  const worn = (mp.texturePackIds || []).map((id) => skins.get(id)).filter(Boolean);

  // fill(), not replaceChildren(): a `cond ? x : null` hole would otherwise
  // print the word "null" into the panel head.
  fill(head,
    el('div', { class: 'grow' },
      el('div', { class: 'pname' }, mp.name),
      el('div', { class: 'pmeta' }, mp.active
        ? 'The active modpack - installs land here and the game loads it.'
        : 'Not active. Switch to it to add, remove or turn mods on and off.')),
    mp.active ? skinPicker(mp) : (worn.length
      ? el('span', { class: 'tiny muted' }, `wears ${worn.map((p) => p.name).join(' over ')}`)
      : null),
    mp.active
      ? null
      : el('button', { class: 'btn btn-green small', onclick: () => selectModpack(mp.id) }, 'Switch to this'));

  const entryFor = registryEntryFinder();
  const squares = mp.mods.map((m) => modTile(mp, m, entryFor(m)));
  if (mp.active) squares.push(mpAddTile());
  tiles.replaceChildren(...(squares.length ? squares : [
    el('div', { class: 'empty-note' }, 'Nothing in this modpack yet - grab something from Browse mods.'),
  ]));

  foot.hidden = false;
  if (!mp.mods.length) {
    foot.textContent = 'An empty modpack is still a modpack: give it a texture pack and it re-skins the game on its own.';
  } else if (!mp.active) {
    foot.textContent = 'You are looking at a modpack the game is not loading. Switch to it and its mods move back into the game folder.';
  } else {
    foot.textContent = 'Click a mod for what you can do with it. Turning one on or off takes effect the next time the game starts.';
  }
}

/**
 * One mod as a square. The icon is the mod's own first gambit sprite when it
 * has one - the thing it actually puts in your run - and a generic chip
 * otherwise. Clicking opens the small menu that used to be a row of buttons.
 */
function modTile(mp, mod, entry) {
  const open = state.ui.mpModMenu === mod.folder;
  const sprite = entry?.gambits?.[0]?.sprite || null;
  const unreviewed = entry?.reviewed === false;
  const updatable = mp.active && entry?.updateAvailable;

  const bits = [];
  if (mod.version) bits.push(`v${String(mod.version).replace(/^v/, '')}`);
  if (entry) bits.push(mod.managed ? 'from the mod registry' : 'unzipped by hand');
  else bits.push('not in the registry');
  if (!mod.enabled) bits.push('turned off');
  if (updatable) bits.push('update available');

  const chip = () => el('span', { class: 'glyph', html: ICONS.modchip });
  const tile = el('button', {
    class: `mp-tile${mod.enabled ? '' : ' off'}`,
    onclick: (ev) => {
      ev.stopPropagation();
      state.ui.mpModMenu = open ? null : mod.folder;
      renderModpackPanel();
    },
  },
    sprite
      ? el('img', {
          class: 'art',
          src: sprite,
          alt: '',
          draggable: 'false',
          onerror: (ev) => ev.target.replaceWith(chip()),
        })
      : chip(),
    updatable ? el('span', { class: 'dot blue' }) : null,
    unreviewed ? el('span', { class: 'dot red', title: 'Nobody has reviewed this mod' }) : null,
    open ? null : el('span', { class: 'tp-tip' },
      el('div', { class: 't' }, mod.name),
      el('div', { class: 'd' }, bits.join(' · ')),
      unreviewed ? el('div', { class: 'warn' }, 'Nobody has reviewed this mod’s code') : null,
      !mod.hasManifest ? el('div', { class: 'warn' }, 'No mod.json - the game ignores this folder') : null));

  if (!mp.active) return el('span', { class: 'mp-tile-wrap' }, tile);

  const items = [];
  if (mod.hasManifest) {
    items.push(el('button', {
      class: 'mi',
      onclick: (ev) => { ev.stopPropagation(); state.ui.mpModMenu = null; toggleMod({ folder: mod.folder, enabled: mod.enabled }); },
    }, mod.enabled ? 'Turn off' : 'Turn on'));
  }
  if (updatable) {
    items.push(el('button', {
      class: 'mi',
      onclick: (ev) => { ev.stopPropagation(); state.ui.mpModMenu = null; installMod(entry); },
    }, `Update to v${entry.latest?.version || '?'}`));
  }
  if (entry) {
    items.push(el('button', {
      class: 'mi',
      onclick: (ev) => { ev.stopPropagation(); state.ui.mpModMenu = null; renderModpackPanel(); api.openExternal(entry.homepage || `https://github.com/${entry.repo}`); },
    }, 'Source ↗'));
  }
  items.push(el('button', {
    class: 'mi danger',
    onclick: (ev) => { ev.stopPropagation(); state.ui.mpModMenu = null; uninstallMod(mod.folder, mod.name); },
  }, 'Remove'));

  return el('span', { class: `mp-tile-wrap dropdown${open ? ' open' : ''}` },
    tile,
    el('div', { class: 'menu' }, el('div', { class: 'mhead' }, mod.name), ...items));
}

/** The ＋ square: the two places new things come from. */
function mpAddTile() {
  const open = state.ui.mpAddMenu;
  return el('span', { class: `mp-tile-wrap dropdown${open ? ' open' : ''}` },
    el('button', {
      class: 'mp-tile add',
      title: 'Add something to this modpack',
      onclick: (ev) => { ev.stopPropagation(); state.ui.mpAddMenu = !open; renderModpackPanel(); },
    },
      el('span', { class: 'plus' }, '＋'),
      open ? null : el('span', { class: 'tp-tip' },
        el('div', { class: 't' }, 'Add to this modpack'),
        el('div', { class: 'd' }, 'A mod, or a texture pack'))),
    el('div', { class: 'menu' },
      el('button', {
        class: 'mi',
        onclick: (ev) => { ev.stopPropagation(); state.ui.mpAddMenu = false; show('browse'); },
      }, el('span', { class: 'micon', html: ICONS.modchip }), 'Browse mods →'),
      el('button', {
        class: 'mi',
        onclick: (ev) => { ev.stopPropagation(); state.ui.mpAddMenu = false; show('textures'); },
      }, el('span', { class: 'micon', html: TP_ICONS.image }), 'Texture packs →')));
}

/**
 * The active setup's texture packs, as a checklist in the panel head. Several
 * can be on at once; the order lives on the Texture packs tab, where the cards
 * you are reordering are the ones you can see.
 */
function skinPicker(mp) {
  const open = state.ui.mpSkinMenu;
  const packs = tpList();
  const stack = mp.texturePackIds || [];
  const worn = stack.map((id) => packs.find((p) => p.id === id)).filter(Boolean);

  const label = worn.length === 0 ? 'No texture pack'
    : (worn.length === 1 ? worn[0].name : `${worn.length} texture packs`);

  const row = (p) => {
    const at = stack.indexOf(p.id);
    return el('button', {
      class: `mi${at >= 0 ? ' current' : ''}`,
      title: at >= 0 ? `Worn ${ordinal(at)} - click to take it off` : 'Click to put it on',
      onclick: (ev) => { ev.stopPropagation(); toggleTp(p.id); },
    },
      el('span', { class: 'setup-check' }, at >= 0 ? '✓' : ''),
      el('span', { class: 'setup-name' }, p.name),
      at >= 0 && stack.length > 1 ? el('span', { class: 'setup-count' }, ordinal(at)) : null);
  };

  return el('span', { class: `dropdown mp-skin${open ? ' open' : ''}` },
    el('button', {
      class: 'btn btn-cream small',
      title: 'The texture packs this modpack wears - switch modpacks and the look switches with them',
      onclick: (ev) => { ev.stopPropagation(); state.ui.mpSkinMenu = !open; renderModpackPanel(); },
    },
      el('span', { class: 'micon', html: TP_ICONS.image }),
      label,
      el('span', { class: 'caret' }, '▾')),
    el('div', { class: 'menu' },
      el('div', { class: 'mhead' }, packs.length ? 'Texture packs · tick as many as you like' : 'Texture packs'),
      ...packs.map(row),
      worn.length
        ? el('button', {
            class: 'mi',
            onclick: (ev) => { ev.stopPropagation(); state.ui.mpSkinMenu = false; wearTp([]); },
          }, el('span', { class: 'setup-check' }), 'Take them all off')
        : null,
      el('div', { class: 'msep' }),
      worn.length > 1
        ? el('div', { class: 'mnote' }, `Wearing ${worn.map((p) => p.name).join(' over ')}. Reorder on the Texture packs tab.`)
        : null,
      el('button', {
        class: 'mi',
        onclick: (ev) => { ev.stopPropagation(); state.ui.mpSkinMenu = false; show('textures'); },
      }, 'Make or import one →')));
}

// ---- community setups ------------------------------------------------------

function registryModpacks() {
  return state.data?.registry?.modpacks || [];
}

/** Registry rows for a pack's members + what installing would actually do. */
function packMemberState(pack) {
  const registryById = registryModsById();
  const members = (pack.mods || []).map((id) => registryById.get(id)).filter(Boolean);
  const skins = state.data?.registry?.texturepacks || [];
  return {
    members,
    missing: members.filter((m) => !m.installed && m.installable),
    updates: members.filter((m) => m.installed && m.updateAvailable),
    installedCount: members.filter((m) => m.installed).length,
    unreviewed: members.filter((m) => m.reviewed === false),
    skins: (pack.texturepacks || []).map((id) => skins.find((t) => t.id === id)).filter(Boolean),
    skinsMissing: (pack.texturepacks || []).filter((id) => !skins.some((t) => t.id === id)),
    vanished: (pack.mods || []).filter((id) => !registryById.has(id)),
    mine: mpList().find((p) => p.registryId === pack.id) || null,
  };
}

function packBadges(ms) {
  const { members, updates, installedCount, mine } = ms;
  const badges = [];
  if (mine) badges.push(el('span', { class: 'tag green' }, 'in your library'));
  else if (members.length && installedCount === members.length && !updates.length) {
    badges.push(el('span', { class: 'tag green' }, 'all installed'));
  } else if (installedCount > 0) {
    badges.push(el('span', { class: 'tag' }, `${installedCount}/${members.length} installed`));
  }
  if (updates.length) badges.push(el('span', { class: 'tag blue' }, 'update'));
  if (ms.unreviewed.length) badges.push(unreviewedMark(ms.unreviewed.map((m) => m.name)));
  return badges;
}

/** The pack's "get it" button, shared by the card and the detail page. */
function packActionButton(pack, ms, { size = 'small' } = {}) {
  const { members, skins } = ms;
  if (!members.length && !skins.length) {
    return el('button', { class: `btn btn-cream ${size}`, disabled: true }, 'Nothing to install yet');
  }
  if (!pack.installable) {
    return el('button', { class: `btn btn-cream ${size}`, disabled: true, title: 'One of its mods has no downloadable release' }, 'Not installable yet');
  }
  return el('button', {
    class: `btn btn-green ${size}`,
    title: 'Builds it as its own modpack and switches to it - your own setups are untouched',
    onclick: (ev) => { ev.stopPropagation(); installModpack(pack, ms); },
  }, ms.mine ? 'Install again' : 'Get this modpack');
}

function renderCommunityPacks() {
  const packs = registryModpacks();
  $('communityEmpty').hidden = packs.length > 0;
  $('communityGrid').replaceChildren(...packs.map(renderCommunityCard));
}

/**
 * The browsing card: a teaser, not the whole manifest. Name, what it's for,
 * what's in it - the full mod list lives one click away on the detail page,
 * where each mod gets a real row instead of a cramped chip.
 */
function renderCommunityCard(pack) {
  const ms = packMemberState(pack);
  const { members, skins } = ms;

  const previewNames = members.slice(0, 3).map((m) => m.name).join(', ');
  const more = members.length > 3 ? ` +${members.length - 3} more` : '';
  const what = [`${members.length} mod${members.length === 1 ? '' : 's'}`];
  if (skins.length === 1) what.push(`the ${skins[0].name} texture pack`);
  else if (skins.length) what.push(`${skins.length} texture packs`);

  return el('div', {
    class: 'mod-card pack-card',
    title: 'See everything inside this modpack',
    onclick: () => openPackDetail(pack.id),
  },
    el('div', { class: 'head' },
      el('div', {},
        el('h3', {}, pack.name),
        el('div', { class: 'by' }, `by ${pack.author} · ${what.join(' + ')}`)),
      el('div', { class: 'badges' }, packBadges(ms))),
    el('div', { class: 'sum' }, pack.summary || ''),
    members.length ? el('div', { class: 'tiny muted' }, `Includes ${previewNames}${more}`) : null,
    // No download stat on packs: summing the members' lifetime counts would
    // just re-count downloads that predate the pack - a meaningless number.
    el('div', { class: 'foot' },
      el('span', { class: 'grow' }),
      el('button', { class: 'btn btn-cream small', onclick: (ev) => { ev.stopPropagation(); openPackDetail(pack.id); } }, 'View'),
      packActionButton(pack, ms)));
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
 * The pack detail page: everything the card couldn't say. Each member is a
 * full row - what it does, its version, its own install state and buttons -
 * plus the pack-level action that installs the whole setup at once.
 */
function renderPackDetail(pack) {
  const box = $('packDetail');
  const ms = packMemberState(pack);
  const { members, vanished, skins, unreviewed } = ms;
  const registryMods = (state.data?.registry?.mods || []).filter((m) => m.kind === 'registry');
  const tiers = popularityTiers(registryMods);

  const rows = members.map((m) => {
    const badges = [];
    if (m.reviewed === false) badges.push(el('span', { class: 'tag red', title: 'Community submission awaiting review - nobody has checked this code yet' }, 'unreviewed'));
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
      el('div', { class: 'by' }, `by ${pack.author} · ${members.length} mods${skins.length ? ` · ${skins.length} texture pack${skins.length === 1 ? '' : 's'}` : ''}`)),
    (pack.description || pack.summary)
      ? el('p', { class: 'pack-desc' }, pack.description || pack.summary)
      : null,
    unreviewed.length
      ? el('div', { class: 'inset-row tiny warn-row' },
          el('span', { class: 'micon', html: ICONS.warn }),
          ` ${unreviewed.length} of these mods ${unreviewed.length === 1 ? 'has' : 'have'} not been reviewed by anyone: ${unreviewed.map((m) => m.name).join(', ')}. Installing this modpack runs their code. Read the source first if you don't know the author.`)
      : null,
    ms.skinsMissing.length
      ? el('div', { class: 'inset-row tiny', style: 'margin-top:6px' },
          `${ms.skinsMissing.length} of its texture packs ${ms.skinsMissing.length === 1 ? 'is' : 'are'} no longer in the registry and will be skipped: ${ms.skinsMissing.join(', ')}.`)
      : null,
    packGambitShelf(members),
    el('div', { class: 'pack-actions' },
      packActionButton(pack, ms, { size: '' }),
      pack.installable && (members.length || skins.length)
        ? el('button', {
            class: 'btn btn-wine',
            title: `Add its mods to "${activeModpack()?.name || 'the active modpack'}" instead of making a new one`,
            onclick: () => installModpack(pack, ms, { into: 'active' }),
          }, `Add to "${activeModpack()?.name || 'my modpack'}"`)
        : null),
    el('div', { class: 'section-band', style: 'margin:18px 0 12px' }, "What's inside"),
    ...rows,
    // Listed in precedence order, because that is part of what is being
    // shared: the same two packs stacked the other way look different.
    ...skins.map((t, i) => el('div', { class: 'mod-row pack-member' },
      el('div', { class: 'info' },
        el('div', { class: 'nm' }, t.name, ' ',
          el('span', { class: 'ver' }, skins.length > 1 ? `texture pack · worn ${ordinal(i)}` : 'texture pack')),
        el('div', { class: 'meta' }, `by ${t.author || 'unknown'}`),
        el('div', { class: 'psum' }, t.summary || 'Art and wording only - a texture pack cannot contain code.')),
      el('div', { class: 'side' },
        el('div', { class: 'row-btns' },
          el('button', {
            class: 'btn btn-cream small',
            onclick: () => api.openExternal(`https://github.com/${t.repo}`),
          }, 'Source'))))),
    vanished.length
      ? el('div', { class: 'inset-row tiny', style: 'margin-top:6px' },
          `${vanished.length} mod${vanished.length === 1 ? ' is' : 's are'} no longer in the registry and will be skipped: ${vanished.join(', ')}`)
      : null));
}

async function installModpack(pack, ms, { into = 'new' } = {}) {
  const { missing, updates, skins, unreviewed } = ms;
  const target = into === 'new' ? `a new modpack called "${pack.name}"` : `your "${activeModpack()?.name || 'active'}" modpack`;
  const lines = [
    `Everything goes into ${target}.`,
    missing.length ? `Installs ${missing.map((m) => m.name).join(', ')}.` : '',
    updates.length ? `Updates ${updates.map((m) => m.name).join(', ')}.` : '',
    skins.length ? `Puts on ${skins.map((t) => t.name).join(' over ')}.` : '',
    'Mods they depend on come along automatically. Anything you already have is left alone.',
  ].filter(Boolean).join(' ');
  const yes = await confirmModal({
    title: `Install ${pack.name}?`,
    body: unreviewed.length
      ? `${lines}\n\n⚠ ${unreviewed.map((m) => m.name).join(', ')} ${unreviewed.length === 1 ? 'has' : 'have'} not been reviewed by anyone. Their code runs in your game.`
      : lines,
    confirmLabel: unreviewed.length ? 'Install anyway' : 'Install',
    confirmKind: unreviewed.length ? 'btn-red' : 'btn-green',
  });
  if (!yes) return;
  await installModpackNow(pack, { into });
}

/** The actual pack install: progress modal + IPC + refresh. */
async function installModpackNow(pack, { into = 'new' } = {}) {
  const operationId = `pack-${++opCounter}`;
  modal.open({
    title: `Installing ${pack.name}`,
    body: 'Getting started…',
    progress: true,
    buttons: [{ label: 'Cancel', kind: 'btn-cream', onClick: () => api.cancelOperation({ operationId }) }],
  });
  try {
    const result = await call(api.installModpack, { id: pack.id, operationId, into });
    modal.close();
    if (result.modpackId) state.mp.selectedId = result.modpackId;
    const n = result.installed.length;
    const tp = result.texturePacks;
    const on = tp?.names?.length ? ` ${tp.names.join(' over ')} ${tp.names.length === 1 ? 'is' : 'are'} on.` : '';
    const failed = tp?.error ? ` Some texture packs could not be installed: ${tp.error}` : '';
    toast(`${pack.name}: ${n} mod${n === 1 ? '' : 's'} installed.${on}${failed}`, tp?.error ? 'warn' : 'ok');
    closePackDetail();
  } catch (err) {
    modal.close();
    toast(err.message, 'err');
  }
  await refresh();
}

// ---- sharing your own ------------------------------------------------------

/** Jump to the share form with `mp` selected, so the fields fill themselves. */
function shareModpack(mp) {
  state.mp.selectedId = mp.id;
  state.packDetail = null;
  show('modpacks');
  renderModpacks();
  $('packPublishForm').scrollIntoView({ behavior: 'smooth', block: 'center' });
}

/**
 * "Share my setup" - the form that turns the selected modpack into a registry
 * entry. The mod list is not something to pick here: it IS what is installed,
 * because the whole point is sharing what you actually play.
 */
function renderSharePackForm() {
  const p = state.share;
  const box = $('packPublishForm');
  const e = p.entry;
  const mp = selectedModpack();

  const field = (label, key, { placeholder = '', help = '', full = false, textarea = false } = {}) => {
    const input = el(textarea ? 'textarea' : 'input', {
      class: 'game-input',
      placeholder,
      oninput: (ev) => { e[key] = ev.target.value; },
    });
    input.value = e[key] || '';
    return el('div', { class: `field${full ? ' full' : ''}` },
      el('label', {}, label), input,
      help ? el('div', { class: 'help' }, help) : null);
  };

  if (!mp) {
    fill(box, el('div', { class: 'empty-note' }, 'Make a modpack first - then this is where you share it.'));
    return;
  }

  // Prefill from the modpack open above, the same way the texture-pack form
  // does: a value the user typed survives switching packs, a suggestion does not.
  if (p.prefilledFor !== mp.id) {
    const suggestion = {
      name: mp.name,
      author: mp.author || state.publish.login || '',
      id: mp.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40),
      summary: mp.summary || '',
      description: mp.description || '',
    };
    for (const [key, value] of Object.entries(suggestion)) {
      if (!e[key] || e[key] === p.suggested?.[key]) e[key] = value;
    }
    p.suggested = suggestion;
    p.prefilledFor = mp.id;
  }

  // What can actually be shared: registry mods only. A mod you built yourself
  // and never published has no id for anyone else to install, and a texture
  // pack that only exists on your disk cannot be downloaded - so both are
  // listed as "left out" rather than silently dropped.
  const entryFor = registryEntryFinder();
  const shareable = [];
  const notShareable = [];
  for (const m of mp.mods) {
    const entry = entryFor(m);
    if (entry) shareable.push(entry);
    else notShareable.push(m.name);
  }
  const worn = (mp.texturePackIds || []).map((id) => tpList().find((t) => t.id === id)).filter(Boolean);
  const shareableSkins = worn.filter((t) => t.registryId);
  const privateSkins = worn.filter((t) => !t.registryId);
  const unreviewed = shareable.filter((m) => m.reviewed === false);

  e.mods = shareable.map((m) => m.id);
  e.texturepacks = shareableSkins.map((t) => t.registryId);

  fill(box,
    el('div', { class: 'inset-row tiny', style: 'margin-bottom:4px' },
      'Sharing ', el('b', {}, mp.name), ' - the modpack open above. Pick another one to switch.'),
    el('div', { class: 'form-grid', style: 'margin-top:14px' },
      field('Modpack name', 'name', { placeholder: 'My Perfect Loadout' }),
      field('Registry id', 'id', { placeholder: 'my-perfect-loadout', help: 'lowercase-with-dashes, permanent' }),
      field('Author', 'author', { placeholder: 'you' }),
      field('One-line summary', 'summary', { placeholder: 'What is this modpack FOR?' }),
      el('div', { class: 'field full' },
        el('label', {}, `What gets shared (${shareable.length} mod${shareable.length === 1 ? '' : 's'}${shareableSkins.length ? ` + ${shareableSkins.length} texture pack${shareableSkins.length === 1 ? '' : 's'}` : ''})`),
        el('div', { class: 'chip-row' },
          ...shareable.map((m) => el('span', { class: `chip on${m.reviewed === false ? ' warn' : ''}`, title: m.summary || '' }, m.name)),
          ...shareableSkins.map((t, i) => el('span', {
            class: 'chip on',
            title: shareableSkins.length > 1
              ? `Texture pack, worn ${ordinal(i)} - the order goes with the modpack`
              : 'The texture pack this modpack wears',
          }, `🎨 ${t.name}`))),
        el('div', { class: 'help' },
          'This is what you have installed - there is no list to curate. Dependencies (like the Gambit API) install automatically.')),
      field('Longer description', 'description', { full: true, textarea: true, placeholder: 'Why these mods together? (optional)' })),
    notShareable.length
      ? el('div', { class: 'inset-row tiny', style: 'margin-top:10px' },
          `Left out, because nobody else could download them: ${notShareable.join(', ')}. Publish them to the registry first and they will be included.`)
      : null,
    privateSkins.length
      ? el('div', { class: 'inset-row tiny', style: 'margin-top:6px' },
          `${privateSkins.map((t) => `"${t.name}"`).join(' and ')} ${privateSkins.length === 1 ? 'is' : 'are'} only on this computer. Publish ${privateSkins.length === 1 ? 'it' : 'them'} from the Texture packs tab and ${privateSkins.length === 1 ? 'it' : 'they'} will ship with this modpack.`)
      : null,
    unreviewed.length
      ? el('div', { class: 'inset-row tiny warn-row', style: 'margin-top:6px' },
          el('span', { class: 'micon', html: ICONS.warn }),
          ` ${unreviewed.map((m) => m.name).join(', ')} ${unreviewed.length === 1 ? 'has' : 'have'} not been reviewed. That is allowed - your modpack will simply carry a warning so people know before they install it.`)
      : null,
    el('div', { class: 'inset-row tiny', style: 'margin-top:6px' },
      'Modpacks are listed as soon as the submission is open: a modpack is only a list of things already in the registry, each downloaded and checksum-verified on its own.'),
    el('div', { style: 'display:flex; gap:10px; justify-content:center; margin-top:18px; flex-wrap:wrap' },
      state.publish.signedIn
        ? el('button', { class: 'btn btn-green', disabled: p.submitting, onclick: submitPackEntry },
            p.submitting ? 'Submitting…' : 'Share it')
        : null,
      el('button', { class: 'btn btn-cream', onclick: openPackIssueSubmission }, 'Share it on GitHub')));
}

async function submitPackEntry() {
  const p = state.share;
  p.submitting = true;
  renderSharePackForm();
  try {
    const result = await call(api.publishSubmitModpack, { entry: p.entry });
    // Keep the local record in step with what was just published, so the card
    // above and the next prefill say the same thing as the registry.
    const mp = selectedModpack();
    if (mp) {
      await call(api.describeModpack, {
        id: mp.id, author: p.entry.author, summary: p.entry.summary, description: p.entry.description,
      }).catch(() => {});
    }
    toast('Shared! Your modpack shows up in everyone’s manager once the registry refreshes.', 'ok');
    api.openExternal(result.url);
    await refresh();
  } catch (err) {
    toast(err.message, 'err');
  } finally {
    p.submitting = false;
    renderSharePackForm();
  }
}

async function openPackIssueSubmission() {
  try {
    const url = await call(api.publishModpackIssueUrl, { entry: state.share.entry });
    api.openExternal(url);
  } catch (err) {
    toast(err.message, 'err');
  }
}

// ---------------------------------------------------------------------------
// Texture packs
// ---------------------------------------------------------------------------

// A pack re-skins the game: replacement art for any sprite or sheet, and
// replacement wording for any of the 1229 strings the game ships. The tab is
// laid out like Modpacks on purpose - a shelf of packs on top, the contents
// of the one you're looking at underneath - because they answer the same kind
// of question ("which set of things is the game using?"). A modpack points at
// one of these, so switching modpacks switches the art too.
//
// The contents panel is deliberately mute: one square per override with an
// icon for art or text, and every detail on hover. Someone with forty edits
// should see a shelf, not a table.

const TP_ICONS = {
  image: pix('M1 2h10v1H1zM1 3h1v6H1zM10 3h1v6h-1zM1 9h10v1H1zM8 4h1v1H8zM5 5h1v1H5zM4 6h3v1H4zM3 7h5v1H3zM2 8h8v1H2z'),
  text: pix('M2 2h2v1H2zM1 3h1v7H1zM4 3h1v7H4zM2 6h2v1H2zM8 4h2v1H8zM7 5h1v1H7zM10 5h1v5h-1zM8 7h2v1H8zM7 8h1v1H7zM8 9h2v1H8z'),
};

/** The game's own language codes - the ones its trad_<code> tables use. */
const GAME_LANGS = {
  en: 'English', fr: 'Français', ge: 'Deutsch', sp: 'Español', pt_br: 'Português (BR)',
  ru: 'Русский', pl: 'Polski', tr: 'Türkçe', jp: '日本語', ko: '한국어', zh: '简体中文',
};

function fmtBytes(n) {
  if (!n) return '0 KB';
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(n / 1000))} KB`;
}

function tpList() {
  return state.data?.texturePacks?.packs || [];
}

/** The worn stack, highest precedence first. */
function activeTpIds() {
  return state.data?.texturePacks?.activeIds || [];
}

/** 0, 1, 2 -> "1st", "2nd", "3rd" - the badge on a worn card. */
function ordinal(n) {
  const i = n + 1;
  const suffix = (i % 100 >= 11 && i % 100 <= 13) ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' }[i % 10] || 'th');
  return `${i}${suffix}`;
}

/** Which pack the bottom panel is describing. Follows the worn one by default. */
function selectedTp() {
  const list = tpList();
  if (!list.length) return null;
  return list.find((p) => p.id === state.tp.selectedId)
    || list.find((p) => p.active)
    || list[0];
}

function renderTexturePacks() {
  const badge = $('packsCount');
  const list = tpList();
  badge.hidden = !list.length;
  badge.textContent = String(list.length);
  renderTpCards();
  renderTpPanel();
  renderRegistryTps();
  renderTpPublish();
}

/**
 * The shelf. Worn packs come first, in the order they are worn, so the ▲▼
 * buttons move a card somewhere you can see - a grid sorted by name while the
 * arrows changed an invisible list would be a puzzle, not a control.
 */
function renderTpCards() {
  const grid = $('tpGrid');
  if (!grid) return;
  const chosen = selectedTp();
  const worn = activeTpIds();

  const ordered = [...tpList()].sort((a, b) => {
    if (a.active !== b.active) return a.active ? -1 : 1;
    if (a.active) return a.order - b.order;
    return String(a.name).localeCompare(String(b.name));
  });

  const cards = ordered.map((p) => {
    const bits = [];
    if (p.imageCount) bits.push(`${p.imageCount} image${p.imageCount === 1 ? '' : 's'}`);
    if (p.textCount) bits.push(`${p.textCount} text${p.textCount === 1 ? '' : 's'}`);
    if (!bits.length) bits.push('empty');
    bits.push(fmtBytes(p.bytes));

    return el('div', {
      class: `shelf-card${p.active ? ' active' : ''}${chosen && chosen.id === p.id && !p.active ? ' sel' : ''}`,
      title: p.active ? `Worn, ${ordinal(p.order)} in the stack` : 'Click to open this pack',
      onclick: () => { state.tp.selectedId = p.id; state.tp.detail = null; renderTexturePacks(); loadTpDetail(p.id); },
    },
      el('div', { class: 'head' },
        el('h3', {}, p.name),
        p.active && worn.length > 1
          ? el('span', { class: 'stack-arrows' },
              el('button', {
                class: 'stack-arrow',
                disabled: p.order === 0,
                title: 'Let this pack win over the one above it',
                onclick: (ev) => { ev.stopPropagation(); moveTp(p.id, -1); },
              }, '▲'),
              el('button', {
                class: 'stack-arrow',
                disabled: p.order === worn.length - 1,
                title: 'Let the pack below it win instead',
                onclick: (ev) => { ev.stopPropagation(); moveTp(p.id, 1); },
              }, '▼'))
          : null,
        p.active
          ? el('span', {
              class: 'tag green',
              title: worn.length > 1
                ? `${ordinal(p.order)} of ${worn.length} - the higher a pack sits, the more it wins`
                : 'The game is wearing this pack',
            }, worn.length > 1 ? `worn ${ordinal(p.order)}` : 'worn')
          : null),
      el('div', { class: 'meta' }, bits.join(' · ')),
      el('div', { class: 'foot' },
        p.active
          ? el('button', { class: 'btn btn-cream small', title: 'Take this pack off - the others stay on', onclick: (ev) => { ev.stopPropagation(); toggleTp(p.id); } }, 'Take off')
          : el('button', { class: 'btn btn-green small', title: 'Add this pack to what the game is wearing', onclick: (ev) => { ev.stopPropagation(); toggleTp(p.id); } }, 'Wear'),
        el('button', { class: 'btn btn-cream small', onclick: (ev) => { ev.stopPropagation(); renameTpFlow(p); } }, 'Rename'),
        el('button', { class: 'btn btn-cream small', title: 'Save this pack as a zip you can send to anyone', onclick: (ev) => { ev.stopPropagation(); exportTpFlow(p); } }, 'Share'),
        el('button', { class: 'btn btn-red small', onclick: (ev) => { ev.stopPropagation(); deleteTpFlow(p); } }, 'Delete')));
  });

  cards.push(el('button', { class: 'shelf-card new', onclick: () => createTpFlow() },
    el('span', { class: 'plus' }, '＋'), 'New texture pack'));
  grid.replaceChildren(...cards);
}

function renderTpPanel() {
  const title = $('tpPanelTitle');
  const head = $('tpPanelHead');
  const tiles = $('tpTiles');
  const foot = $('tpFootnote');
  if (!tiles) return;

  const chosen = selectedTp();
  if (!chosen) {
    title.textContent = 'Contents';
    head.replaceChildren();
    tiles.replaceChildren(el('div', { class: 'empty-note' },
      'No texture packs yet. Make one above, or import one someone sent you.'));
    foot.hidden = true;
    return;
  }

  title.textContent = chosen.name;
  const detail = state.tp.detail && state.tp.detail.id === chosen.id ? state.tp.detail : null;

  const game = state.data?.game;
  const ready = game?.valid && game.state === 'patched';
  const worn = activeTpIds();
  const place = worn.length > 1 ? ` ${ordinal(chosen.order)} of ${worn.length} in the stack.` : '';
  let status;
  if (!chosen.active) status = 'Not worn. Press Wear on its card to put it on.';
  else if (!game?.valid) status = `Worn, but no game folder is set up yet - open Set up first.${place}`;
  else if (!ready) status = `Worn, but the game is not patched - texture packs need the framework (Set up).${place}`;
  else status = `Worn - the game loads this the next time it starts.${place}`;

  head.replaceChildren(
    el('div', { class: 'grow' },
      el('div', { class: 'pname' }, chosen.name),
      el('div', { class: `pmeta${chosen.active && !ready ? ' warn' : ''}` }, status)),
    el('button', {
      class: 'btn btn-cream small',
      title: 'Look inside this pack. images/ holds your artwork - to change it, drop a new PNG in through ＋ rather than editing in place.',
      onclick: () => api.openPackFolder({ id: chosen.id }),
    }, 'Open folder'));

  if (!detail) {
    tiles.replaceChildren(el('div', { class: 'empty-note' }, el('span', { class: 'spin' }), ' Loading…'));
    foot.hidden = true;
    loadTpDetail(chosen.id);
    return;
  }

  const squares = [];
  for (const image of detail.images) squares.push(imageTile(chosen, image));
  for (const text of detail.texts) squares.push(textTile(chosen, text));
  squares.push(tpAddTile(chosen));
  tiles.replaceChildren(...squares);

  foot.hidden = false;
  if (!detail.images.length && !detail.texts.length) {
    foot.textContent = 'Nothing in this pack yet. Press ＋ to replace a picture or reword some text.';
  } else if (chosen.active && worn.length > 1 && chosen.order > 0) {
    foot.textContent = `Every change is saved and applied straight away. ${worn.length} packs are on: where another one higher up the stack changes the same thing, that one wins.`;
  } else if (!chosen.active) {
    foot.textContent = 'Changes are saved as you make them, but this pack is not worn - press Wear on its card to put it on the game.';
  } else if (!ready) {
    foot.textContent = 'Changes are saved, but the game is not set up for mods yet - open Set up to patch it.';
  } else {
    foot.textContent = 'Every change is saved and applied straight away - there is no Apply button. Restart the game to see it.';
  }

  // Tiles show the user's own art, fetched one pack at a time. Skipping what is
  // already in flight matters: without it a repaint that lands mid-fetch asks
  // for the same keys, loadTpPreviews skips them all without ever awaiting,
  // and its tail repaint calls straight back into here until the stack blows.
  const missing = detail.images.filter((i) => {
    const key = `pack:${chosen.id}:${i.assetId}`;
    return !state.tp.previews.has(key) && !state.tp.pending.has(key);
  });
  if (missing.length) loadTpPreviews(chosen.id, missing.map((i) => i.assetId));
}

function imageTile(pack, image) {
  const key = `pack:${pack.id}:${image.assetId}`;
  const art = state.tp.previews.get(key);
  return el('button', {
    class: 'tp-tile image',
    onclick: () => openImageBrowser(pack, image.assetId),
  },
    art
      ? el('img', { class: 'art', src: art, alt: '' })
      : el('span', { class: 'glyph', html: TP_ICONS.image }),
    el('span', { class: 'tp-tip' },
      el('div', { class: 't' }, image.label || image.name),
      el('div', { class: 'd' },
        `${image.width}×${image.height} · ${image.category}`,
        image.kind === 'sprite' ? ` · on ${image.atlasName}` : ' · whole sheet',
        image.compressed ? ' · compressed sheet' : '')));
}

function textTile(pack, text) {
  const shown = text.values.find((v) => v.lang === '*') || text.values[0];
  return el('button', {
    class: 'tp-tile text',
    onclick: () => openTextBrowser(pack, `${text.section}/${text.key}`),
  },
    el('span', { class: 'glyph', html: TP_ICONS.text }),
    el('span', { class: 'tp-tip' },
      el('div', { class: 't' }, `${text.section} / ${text.key}`),
      text.original ? el('div', { class: 'was' }, text.original) : null,
      el('div', { class: 'now' }, shown ? shown.value : ''),
      el('div', { class: 'd' }, text.values.map((v) => (v.lang === '*' ? 'every language' : GAME_LANGS[v.lang] || v.lang)).join(', '))));
}

/** The ＋ square: a two-item menu, because art and text are different dialogs. */
function tpAddTile(pack) {
  const open = state.ui.tpAddMenuOpen;
  return el('span', { class: `tp-add-wrap${open ? ' open' : ''}` },
    el('button', {
      class: 'tp-tile add',
      title: 'Add something to this pack',
      onclick: (ev) => { ev.stopPropagation(); state.ui.tpAddMenuOpen = !open; renderTpPanel(); },
    },
      el('span', { class: 'plus' }, '＋'),
      open ? null : el('span', { class: 'tp-tip' },
        el('div', { class: 't' }, 'Add an override'),
        el('div', { class: 'd' }, 'A picture, or a line of text'))),
    el('span', { class: 'menu' },
      el('button', {
        class: 'mi',
        onclick: (ev) => { ev.stopPropagation(); state.ui.tpAddMenuOpen = false; renderTpPanel(); openImageBrowser(pack); },
      }, el('span', { class: 'micon', html: TP_ICONS.image }), 'Image'),
      el('button', {
        class: 'mi',
        onclick: (ev) => { ev.stopPropagation(); state.ui.tpAddMenuOpen = false; renderTpPanel(); openTextBrowser(pack); },
      }, el('span', { class: 'micon', html: TP_ICONS.text }), 'Text')));
}

// ---- pack actions ---------------------------------------------------------

async function loadTpDetail(id) {
  // renderAll() repaints the panel on every state refresh; without this a slow
  // fetch would be started once per repaint.
  if (state.tp.loading === id) return;
  state.tp.loading = id;
  try {
    const detail = await call(api.packDetail, { id });
    // Two clicks in quick succession: only the pack still on screen wins.
    if (selectedTp()?.id !== id) return;
    state.tp.detail = detail;
    renderTpPanel();
  } catch (err) {
    toast(err.message, 'err');
  } finally {
    if (state.tp.loading === id) state.tp.loading = null;
  }
}

async function loadTpPreviews(packId, assetIds) {
  let fetched = 0;
  for (const assetId of assetIds) {
    const key = `pack:${packId}:${assetId}`;
    if (state.tp.pending.has(key)) continue;
    state.tp.pending.add(key);
    try {
      state.tp.previews.set(key, await call(api.packPreview, { id: packId, assetId }));
      fetched++;
    } catch {
      state.tp.previews.set(key, null);
      fetched++;
    } finally {
      state.tp.pending.delete(key);
    }
  }
  // Only repaint when something actually changed - a repaint that found nothing
  // to do would otherwise ask for the same keys again on the next frame.
  if (fetched) renderTpPanel();
}

async function createTpFlow() {
  const name = await promptModal({
    title: 'New texture pack',
    body: 'A texture pack is your own art and wording layered over the game. You can wear one at a time, and share it as a zip.',
    placeholder: 'e.g. Midnight chess, Cursed pieces…',
    confirmLabel: 'Create',
  });
  if (!name) return;
  try {
    const rec = await call(api.createPack, { name });
    state.tp.selectedId = rec.id;
    state.tp.detail = null;
    toast(`"${rec.name}" created - add some art to it.`, 'ok');
    await refresh();
    loadTpDetail(rec.id);
  } catch (err) {
    toast(err.message, 'err');
  }
}

async function renameTpFlow(pack) {
  const name = await promptModal({
    title: 'Rename texture pack', body: '', placeholder: 'New name', initial: pack.name, confirmLabel: 'Rename',
  });
  if (!name || name === pack.name) return;
  try { await call(api.renamePack, { id: pack.id, name }); } catch (err) { toast(err.message, 'err'); }
  await refresh();
}

async function deleteTpFlow(pack) {
  const count = pack.imageCount + pack.textCount;
  const yes = await confirmModal({
    title: `Delete "${pack.name}"?`,
    body: count
      ? `Its ${count} override${count === 1 ? '' : 's'} go with it. Export it first if you want to keep a copy.`
      : 'The pack is empty - nothing else is touched.',
    confirmLabel: 'Delete',
  });
  if (!yes) return;
  try {
    await call(api.deletePack, { id: pack.id });
    if (state.tp.selectedId === pack.id) { state.tp.selectedId = null; state.tp.detail = null; }
    toast(`"${pack.name}" deleted.`, 'ok');
  } catch (err) {
    toast(err.message, 'err');
  }
  await refresh();
}

/**
 * Set the whole worn stack. One call for wearing, taking off and reordering,
 * matching the single IPC primitive - three verbs that had to agree about the
 * order would be three chances to disagree.
 */
async function wearTp(ids) {
  const previous = activeTpIds();
  try {
    const result = await call(api.setWornPacks, { ids });
    const worn = result.activeIds;
    const game = state.data?.game;
    const many = worn.length > 1 ? ` ${worn.length} packs on, top of the stack wins.` : '';
    if (!worn.length) toast('Texture packs off - the game’s own art is back.', 'ok');
    else if (!game?.valid) toast(`Saved.${many} Set up your game folder and it will be applied.`, 'ok');
    else if (game.state !== 'patched') toast(`Saved.${many} Patch the game and it will be applied.`, 'ok');
    else if (worn.length === previous.length) toast(`Order changed.${many} Restart the game to see it.`, 'ok');
    else toast(`Applied.${many} Restart the game to see it.`, 'ok');
  } catch (err) {
    toast(err.message, 'err');
  }
  await refresh();
}

/** Add a pack to the top of the stack, or take it off. */
function toggleTp(id) {
  const worn = activeTpIds();
  // New packs go on top: you just chose it, so you almost certainly want to
  // see it win. Demoting it afterwards is one arrow away.
  return wearTp(worn.includes(id) ? worn.filter((x) => x !== id) : [id, ...worn]);
}

/** Move a worn pack one place up (-1) or down (+1) the precedence order. */
function moveTp(id, delta) {
  const worn = [...activeTpIds()];
  const from = worn.indexOf(id);
  const to = from + delta;
  if (from < 0 || to < 0 || to >= worn.length) return Promise.resolve();
  worn.splice(to, 0, ...worn.splice(from, 1));
  return wearTp(worn);
}

async function exportTpFlow(pack) {
  try {
    const result = await call(api.exportPack, { id: pack.id });
    if (result) toast(`Exported ${fmtBytes(result.bytes)} - send that zip to anyone with the manager.`, 'ok');
  } catch (err) {
    toast(err.message, 'err');
  }
}

async function importTpFlow() {
  try {
    const result = await call(api.importPack, {});
    if (!result) return;
    state.tp.selectedId = result.id;
    state.tp.detail = null;
    const skipped = result.skipped ? ` ${result.skipped} override${result.skipped === 1 ? '' : 's'} didn't match this version of the game and were dropped.` : '';
    toast(`Imported "${result.name}" - ${result.images} image(s), ${result.texts} text(s).${skipped}`, 'ok');
    await refresh();
    loadTpDetail(result.id);
  } catch (err) {
    toast(err.message, 'err');
  }
}


// ---- community packs ------------------------------------------------------

function registryTps() {
  return state.data?.registry?.texturepacks || [];
}

function renderRegistryTps() {
  const grid = $('tpRegistryGrid');
  const empty = $('tpRegistryEmpty');
  if (!grid) return;

  const list = registryTps().filter((p) => p.latest);
  empty.hidden = list.length > 0;
  // Already in the library? Then say whether it is current, rather than
  // quietly making a second copy of the same pack.
  const have = new Map(tpList().filter((p) => p.registryId).map((p) => [p.registryId, p]));

  grid.replaceChildren(...list.map((p) => {
    const mine = have.get(p.id);
    const installed = !!mine;
    const behind = installed && p.latest?.version && mine.version
      && compareVersionStrings(p.latest.version, mine.version) > 0;
    const bits = [p.author ? `by ${p.author}` : null, p.latest?.version ? `v${p.latest.version}` : null,
      p.latest?.asset?.size ? fmtBytes(p.latest.asset.size) : null].filter(Boolean);
    return el('div', { class: `shelf-card${installed ? ' active' : ''}` },
      el('div', { class: 'head' },
        el('h3', {}, p.name),
        behind ? el('span', { class: 'tag blue' }, `v${p.latest.version}`) : null,
        installed && !behind ? el('span', { class: 'tag green' }, 'in library') : null,
        p.official ? el('span', { class: 'tag gold' }, 'official') : null),
      el('div', { class: 'meta' }, bits.join(' · ')),
      el('div', { class: 'meta', style: 'flex:1' }, p.summary || ''),
      el('div', { class: 'foot' },
        el('button', {
          class: 'btn btn-cream small',
          title: 'Open the pack’s repository',
          onclick: () => api.openExternal(`https://github.com/${p.repo}`),
        }, 'Source'),
        el('button', {
          class: !installed || behind ? 'btn btn-green small' : 'btn btn-cream small',
          title: installed
            ? 'Downloads a fresh copy alongside the one you already have - your edits to that copy are untouched'
            : 'Add it to your library',
          onclick: () => installRegistryTp(p, mine),
        }, behind ? `Update to v${p.latest.version}` : (installed ? 'Get a fresh copy' : 'Install'))));
  }));
}

/** Numeric-segment version compare; good enough for "is there a newer one". */
function compareVersionStrings(a, b) {
  const parse = (v) => String(v || '').split(/[.-]/).map((x) => parseInt(x, 10)).map((x) => (Number.isFinite(x) ? x : 0));
  const left = parse(a);
  const right = parse(b);
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const diff = (left[i] || 0) - (right[i] || 0);
    if (diff) return diff > 0 ? 1 : -1;
  }
  return 0;
}

async function installRegistryTp(entry, existing = null) {
  if (existing) {
    const yes = await confirmModal({
      title: `Download ${entry.name} again?`,
      body: `You already have "${existing.name}" from this pack. This adds a second copy - the one you have, and any edits you made to it, is left alone.`,
      confirmLabel: 'Download',
      confirmKind: 'btn-green',
    });
    if (!yes) return;
  }
  const operationId = `tp-install-${entry.id}-${Date.now()}`;
  modal.open({
    title: `Installing ${entry.name}`,
    body: 'Starting…',
    progress: true,
    buttons: [{ label: 'Cancel', kind: 'btn-cream', onClick: () => api.cancelOperation({ operationId }) }],
  });
  try {
    const result = await call(api.installRegistryPack, { id: entry.id, operationId });
    modal.close();
    state.tp.selectedId = result.id;
    state.tp.detail = null;
    const skipped = result.skipped
      ? ` ${result.skipped} override${result.skipped === 1 ? '' : 's'} didn't match this version of the game and were dropped.`
      : '';
    toast(`"${result.name}" is in your library - press Wear to put it on.${skipped}`, 'ok');
    await refresh();
    loadTpDetail(result.id);
  } catch (err) {
    modal.close();
    toast(err.message, 'err');
  }
}

// ---- sharing your own -----------------------------------------------------

function renderTpPublish() {
  const auth = $('tpPublishAuth');
  if (!auth) return;
  auth.replaceChildren(authBox('texture pack'));
  renderTpPublishFields();
}

function renderTpPublishFields() {
  const p = state.tpPublish;
  const box = $('tpPublishForm');
  const e = p.entry;

  const field = (label, key, { placeholder = '', help = '', full = false, textarea = false } = {}) => {
    const input = el(textarea ? 'textarea' : 'input', {
      class: 'game-input',
      placeholder,
      oninput: (ev) => { e[key] = ev.target.value; },
    });
    input.value = e[key] || '';
    return el('div', { class: `field${full ? ' full' : ''}` },
      el('label', {}, label), input,
      help ? el('div', { class: 'help' }, help) : null);
  };

  // Prefill from whichever pack is open, so the form is mostly filled in
  // before anyone types: the name and author are already known.
  const chosen = selectedTp();
  if (chosen && p.prefilledFor !== chosen.id) {
    const suggest = (key, value) => {
      // Replace a value only while it is still the last pack's suggestion -
      // anything typed by hand survives switching packs.
      if (!e[key] || e[key] === p.suggested?.[key]) e[key] = value;
    };
    const suggestion = {
      name: chosen.name,
      author: chosen.author || '',
      id: chosen.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40),
      summary: chosen.summary || '',
      description: chosen.description || '',
    };
    for (const [key, value] of Object.entries(suggestion)) suggest(key, value);
    p.suggested = suggestion;
    p.prefilledFor = chosen.id;
  }

  fill(box,
    chosen ? el('div', { class: 'inset-row tiny', style: 'margin-bottom:4px' },
      'Filled in from ', el('b', {}, chosen.name), ' - the pack open above. Pick another pack to switch.') : null,
    el('div', { class: 'form-grid', style: 'margin-top:14px' },
      field('Pack name', 'name', { placeholder: 'Midnight Chess' }),
      field('Registry id', 'id', { placeholder: 'midnight-chess', help: 'lowercase-with-dashes, permanent' }),
      field('Author', 'author', { placeholder: 'you' }),
      field('One-line summary', 'summary', { placeholder: 'What does it re-skin?' }),
      field('Your repository', 'repo', { placeholder: 'you/my-texture-packs', help: 'owner/name - downloads are pinned to it' }),
      field('Release asset', 'asset', { placeholder: 'midnight-chess-*.zip', help: 'the zip you exported, attached to a release' }),
      field('Longer description', 'description', { full: true, textarea: true, placeholder: 'What it changes, and what it looks like. (optional)' })),
    el('div', { style: 'display:flex; gap:10px; justify-content:center; margin-top:18px; flex-wrap:wrap' },
      state.publish.signedIn
        ? el('button', { class: 'btn btn-green', disabled: p.submitting, onclick: submitTpToRegistry },
          p.submitting ? 'Submitting…' : 'Submit to the registry')
        : null,
      el('button', { class: 'btn btn-cream', onclick: openTpIssue }, 'Open submission on GitHub')));
}

async function submitTpToRegistry() {
  const p = state.tpPublish;
  p.submitting = true;
  renderTpPublishFields();
  try {
    const result = await call(api.publishPack, { entry: p.entry });
    toast('Submitted! Your pull request is open on GitHub.', 'ok');
    api.openExternal(result.url);
  } catch (err) {
    toast(err.message, 'err');
  } finally {
    p.submitting = false;
    renderTpPublishFields();
  }
}

async function openTpIssue() {
  try {
    api.openExternal(await call(api.packIssueUrl, { entry: state.tpPublish.entry }));
  } catch (err) {
    toast(err.message, 'err');
  }
}

// ---------------------------------------------------------------------------
// The asset browser
// ---------------------------------------------------------------------------

// The gambonanzaassets gallery, rebuilt inside the manager: every sprite and
// texture in the game on the left, the one you picked on the right, with its
// original next to your replacement. The catalogue metadata and the previews
// both come through the main process, so the sandboxed UI still never talks to
// the network itself.

/**
 * TextMeshPro markup is part of the string the game parses - <color=...>,
 * <sprite=9>, <wave>. Showing it as chips makes it obvious that it is
 * structure rather than words, so a replacement keeps it.
 */
function tmpMarkup(text) {
  const nodes = [];
  const tag = /<\/?[^<>]{1,48}>/g;
  let last = 0;
  let match = tag.exec(text);
  while (match) {
    if (match.index > last) nodes.push(text.slice(last, match.index));
    nodes.push(el('span', { class: 'tmp-tag' }, match[0]));
    last = match.index + match[0].length;
    match = tag.exec(text);
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes.length ? nodes : [text];
}

async function ensureCatalog() {
  if (state.tp.catalog) return state.tp.catalog;
  state.tp.catalog = await call(api.assetCatalog, {});
  return state.tp.catalog;
}

async function ensureTexts() {
  if (state.tp.texts) return state.tp.texts;
  state.tp.texts = await call(api.assetTexts, {});
  return state.tp.texts;
}

/** Fetch previews for a batch of ids, then repaint whatever asked for them. */
async function ensurePreviews(ids, repaint) {
  const missing = ids.filter((id) => !state.tp.previews.has(id) && !state.tp.pending.has(id));
  if (!missing.length) return;
  missing.forEach((id) => state.tp.pending.add(id));
  try {
    const map = await call(api.assetPreviews, { ids: missing });
    for (const id of missing) state.tp.previews.set(id, map[id] ?? null);
  } catch {
    missing.forEach((id) => state.tp.previews.set(id, null));
  } finally {
    missing.forEach((id) => state.tp.pending.delete(id));
  }
  repaint?.();
}

/** The panel shown when the catalogue could not be fetched. */
function browserError(err, retry) {
  return el('div', { class: 'ab-blank', style: 'flex-direction:column; gap:10px; text-align:center; padding:24px' },
    el('div', { class: 'ph' },
      'Could not load the game\u2019s asset list.', el('br'),
      el('span', { class: 'tiny muted' }, err.message)),
    el('button', { class: 'btn btn-cream small', onclick: retry }, '\u21bb Try again'));
}

function browserFrame({ title, head, left, right, onClose }) {
  // Search and filters span the dialog; the two panes share what is left.
  const root = el('div', { class: 'ab' },
    el('div', { class: 'ab-head' }, head),
    el('div', { class: 'ab-body' }, left, right));
  modal.open({
    title,
    wide: true,
    content: root,
    buttons: [{ label: 'Done', kind: 'btn-cream', dismiss: true, onClick: () => { onClose?.(); modal.close(); } }],
  });
  return root;
}

// ---- images ---------------------------------------------------------------

async function openImageBrowser(pack, preselect = null) {
  const grid = el('div', { class: 'ab-grid' });
  const detail = el('div', { class: 'ab-right' });
  const search = el('input', {
    class: 'game-input', type: 'search', placeholder: 'Search the game’s art…',
    oninput: (ev) => { session.search = ev.target.value; paintGrid(); },
  });
  const chips = el('div', { class: 'chip-row' });
  const head = [
    el('div', { class: 'toolbar' }, el('div', { class: 'search', style: 'flex:1' }, search)),
    chips,
  ];
  const left = el('div', { class: 'ab-left' }, grid);

  state.tp.browser = { mode: 'image', packId: pack.id, search: '', category: '', selected: preselect };
  // Closing the dialog nulls state.tp.browser, and opening the other one
  // replaces it. Every continuation below compares against this object, so a
  // slow save that lands after either can bail instead of painting into
  // detached DOM (or throwing on a null it still expects to be there).
  const session = state.tp.browser;
  const live = () => state.tp.browser === session;

  browserFrame({
    title: 'Replace a picture',
    head,
    left,
    right: detail,
    onClose: () => { state.tp.browser = null; },
  });
  grid.replaceChildren(el('div', { class: 'ab-cell' }, el('span', { class: 'ph' }, 'Loading…')));

  let catalog;
  try {
    catalog = await ensureCatalog();
  } catch (err) {
    // A 74px thumbnail cell is no place for "check your internet connection".
    fill(left, browserError(err, async () => {
      state.tp.catalog = null;
      modal.close();
      state.tp.browser = null;
      openImageBrowser(pack, preselect);
    }));
    fill(detail, el('div', { class: 'ab-blank' }, el('span', { class: 'ph' }, 'Nothing to show until the catalogue loads.')));
    return;
  }
  if (!live()) return; // closed while we were fetching

  const observer = new IntersectionObserver((entries) => {
    const wanted = entries.filter((e) => e.isIntersecting).map((e) => e.target.dataset.assetId).filter(Boolean);
    if (wanted.length) ensurePreviews(wanted, paintGrid);
  }, { root: grid, rootMargin: '160px' });

  function matches(entry) {
    const { search: q, category } = session;
    if (category && entry.category !== category) return false;
    if (!q) return true;
    const needle = q.toLowerCase();
    return entry.label.toLowerCase().includes(needle)
      || entry.name.toLowerCase().includes(needle)
      || (entry.atlas || '').toLowerCase().includes(needle);
  }

  function paintChips() {
    if (!live()) return;
    const { category } = session;
    chips.replaceChildren(
      el('button', {
        class: `chip${category ? '' : ' on'}`,
        onclick: () => { session.category = ''; paintChips(); paintGrid(); },
      }, `Everything (${catalog.counts.total})`),
      ...catalog.categories.map((c) => el('button', {
        class: `chip${category === c.name ? ' on' : ''}`,
        onclick: () => { session.category = c.name; paintChips(); paintGrid(); },
      }, `${c.name} (${c.count})`)));
  }

  const GRID_CAP = 400;

  function paintGrid() {
    if (!live()) return;
    observer.disconnect();
    const all = catalog.entries.filter(matches);
    const shown = all.slice(0, GRID_CAP);
    if (!shown.length) {
      grid.replaceChildren(el('div', { class: 'ab-cell' }, el('span', { class: 'ph' }, 'Nothing matches')));
      return;
    }
    const edited = new Set((state.tp.detail?.images || []).map((i) => i.assetId));
    grid.replaceChildren(...shown.map((entry) => {
      const preview = state.tp.previews.get(entry.id);
      const cell = el('button', {
        class: `ab-cell${session.selected === entry.id ? ' on' : ''}${edited.has(entry.id) ? ' edited' : ''}`,
        'data-asset-id': entry.id,
        title: `${entry.label} · ${entry.width}×${entry.height}${entry.kind === 'texture' ? ' · whole sheet' : ''}`,
        onclick: () => { session.selected = entry.id; session.confirmRemove = null; paintGrid(); paintDetail(); },
      }, preview
        ? el('img', { src: preview, alt: '' })
        : el('span', { class: 'ph' }, preview === null && state.tp.previews.has(entry.id) ? entry.label : '…'));
      observer.observe(cell);
      return cell;
    }));
    // Say so rather than quietly stopping at 400 while the chip claims 682.
    if (all.length > shown.length) {
      grid.append(el('div', { class: 'ab-cell more' },
        el('span', { class: 'ph' }, `+${all.length - shown.length} more`, el('br'), 'search or pick a category')));
    }
  }

  function paintDetail() {
    if (!live()) return;
    const id = session.selected;
    if (!id) {
      fill(detail, el('div', { class: 'ab-blank' },
        el('span', { class: 'ph' }, 'Pick a picture on the left.', el('br'),
          'You’ll get its original to paint over, and somewhere to drop yours back in.')));
      return;
    }
    const entry = catalog.entries.find((e) => e.id === id);
    if (!entry) return;
    ensurePreviews([id], paintDetail);
    const original = state.tp.previews.get(id);
    // `null` means we asked and the site had nothing; `undefined` means we
    // haven't asked yet. Only the first is a dead end.
    const unavailable = state.tp.previews.get(id) === null && state.tp.previews.has(id);
    const mine = state.tp.previews.get(`pack:${pack.id}:${id}`);
    const existing = (state.tp.detail?.images || []).find((i) => i.assetId === id);
    if (existing && mine === undefined) loadTpPreviews(pack.id, [id]);

    fill(detail,
      el('div', { class: 'ab-pair' },
        el('div', {},
          el('div', { class: 'cap' }, 'In the game'),
          el('div', { class: 'ab-preview' }, original
            ? el('img', { src: original, alt: '' })
            : el('span', { class: 'ph' }, original === null ? 'no preview published yet' : 'loading…'))),
        el('div', {},
          el('div', { class: 'cap' }, 'Your version'),
          el('div', { class: 'ab-preview' }, mine
            ? el('img', { src: mine, alt: '' })
            : el('span', { class: 'ph' }, 'nothing yet')))),

      el('div', { class: 'ab-facts' },
        el('b', {}, entry.label), el('br'),
        `${entry.width}×${entry.height} · ${entry.format || 'unknown format'}`,
        entry.kind === 'sprite' ? ` · one sprite on ${entry.atlas}` : ` · a whole sheet${entry.spriteCount ? ` (${entry.spriteCount} sprites on it)` : ''}`,
        el('br'), el('span', { class: 'muted' }, entry.name)),

      // Order by what someone came here to do: drop art in, then the buttons
      // beside it, and only then the notes. On a short window it is the
      // reading matter that scrolls out of sight, never the controls.
      unavailable
        ? el('div', { class: 'ab-note' },
          'The game’s own copy of this one isn’t published yet, so it can’t be re-composited. '
          + 'It usually means the art site is a game update behind; try again after the next catalogue refresh.')
        : el('button', {
          class: 'ab-drop',
          onclick: () => pickImage(entry),
          ondragover: (ev) => { ev.preventDefault(); ev.currentTarget.classList.add('over'); },
          ondragleave: (ev) => ev.currentTarget.classList.remove('over'),
          ondrop: (ev) => { ev.preventDefault(); ev.currentTarget.classList.remove('over'); dropImage(ev, entry); },
        },
          el('b', {}, existing ? 'Replace your image' : 'Drop a PNG here'),
          `or click to choose one · ${entry.width}×${entry.height} fits exactly`),

      el('div', { class: 'ab-actions' },
        el('button', {
          class: 'btn btn-cream small',
          disabled: unavailable,
          title: unavailable ? 'Not published for this game build yet' : 'Save the game’s own version, to paint over',
          onclick: () => saveOriginal(entry),
        }, '⬇ Save the original'),
        existing ? el('button', {
          class: `btn small ${session.confirmRemove === entry.id ? 'btn-red' : 'btn-cream'}`,
          title: 'Deletes your image for this asset from the pack',
          onclick: () => {
            // Two-step in place rather than a confirm dialog: this app has one
            // modal backdrop, and opening a second would replace the browser.
            if (session.confirmRemove !== entry.id) {
              session.confirmRemove = entry.id;
              paintDetail();
              return;
            }
            session.confirmRemove = null;
            dropOverride(entry);
          },
        }, session.confirmRemove === entry.id ? 'Delete my image?' : 'Remove from pack') : null),

      entry.compressed ? el('div', { class: 'ab-note' },
        'This sheet is block-compressed. Replacing anything on it re-encodes the whole sheet, so colours elsewhere on it can shift very slightly.') : null,

      entry.kind === 'texture' && entry.spriteCount ? el('div', { class: 'ab-note' },
        `Replacing this sheet replaces all ${entry.spriteCount} sprites on it at once. To change just one, search for it by name instead.`) : null);
  }

  async function applyBytes(entry, bytes, from) {
    try {
      const result = await call(api.setPackImage, { id: pack.id, assetId: entry.id, bytes });
      state.tp.detail = result.pack;
      state.tp.previews.delete(`pack:${pack.id}:${entry.id}`);
      await loadTpPreviews(pack.id, [entry.id]);
      paintGrid();
      paintDetail();
      await refresh();
      toast(result.resized
        ? `${from || 'Image'} was ${result.given.width}×${result.given.height} - scaled to ${entry.width}×${entry.height}.`
        : `${entry.label} replaced.`, 'ok');
    } catch (err) {
      toast(err.message, 'err');
    }
  }

  async function pickImage(entry) {
    try {
      const result = await call(api.pickPackImage, { id: pack.id, assetId: entry.id });
      if (!result) return;
      state.tp.detail = result.pack;
      state.tp.previews.delete(`pack:${pack.id}:${entry.id}`);
      await loadTpPreviews(pack.id, [entry.id]);
      paintGrid();
      paintDetail();
      await refresh();
      toast(result.resized
        ? `${result.from} was ${result.given.width}×${result.given.height} - scaled to ${entry.width}×${entry.height}.`
        : `${entry.label} replaced.`, 'ok');
    } catch (err) {
      toast(err.message, 'err');
    }
  }

  async function dropImage(ev, entry) {
    const file = ev.dataTransfer?.files?.[0];
    if (!file) return;
    if (!/\.png$/i.test(file.name)) { toast('Texture packs take PNG files.', 'err'); return; }
    const bytes = new Uint8Array(await file.arrayBuffer());
    await applyBytes(entry, bytes, file.name);
  }

  async function saveOriginal(entry) {
    try {
      const result = await call(api.downloadOriginal, { assetId: entry.id, name: entry.name });
      if (result) toast('Saved. Paint over it and drop it back in.', 'ok');
    } catch (err) {
      toast(err.message, 'err');
    }
  }

  async function dropOverride(entry) {
    try {
      state.tp.detail = await call(api.removePackImage, { id: pack.id, assetId: entry.id });
      state.tp.previews.delete(`pack:${pack.id}:${entry.id}`);
      paintGrid();
      paintDetail();
      await refresh();
      toast(`${entry.label} is back to the game’s own art.`, 'ok');
    } catch (err) {
      toast(err.message, 'err');
    }
  }

  paintChips();
  paintGrid();
  paintDetail();
  setTimeout(() => search.focus(), 0);
}

// ---- texts ----------------------------------------------------------------

async function openTextBrowser(pack, preselect = null) {
  const rows = el('div', { class: 'ab-rows' });
  const detail = el('div', { class: 'ab-right' });
  const search = el('input', {
    class: 'game-input', type: 'search', placeholder: 'Search every string, in every language…',
    oninput: (ev) => { session.search = ev.target.value; paintRows(); },
  });
  const head = [el('div', { class: 'toolbar' }, el('div', { class: 'search', style: 'flex:1' }, search))];
  const left = el('div', { class: 'ab-left' }, rows);

  state.tp.browser = { mode: 'text', packId: pack.id, search: '', selected: preselect, lang: '*', drafts: {} };
  const session = state.tp.browser;
  const live = () => state.tp.browser === session;

  browserFrame({
    title: 'Reword some text',
    head,
    left,
    right: detail,
    onClose: () => { state.tp.browser = null; },
  });
  rows.replaceChildren(el('div', { class: 'ab-sec' }, 'Loading…'));

  let texts;
  try {
    texts = await ensureTexts();
    if (!texts.sections.length) throw new Error('the text catalogue came back empty');
  } catch (err) {
    fill(rows, browserError(err, async () => {
      state.tp.texts = null;
      modal.close();
      state.tp.browser = null;
      openTextBrowser(pack, preselect);
    }));
    fill(detail, el('div', { class: 'ab-blank' }, el('span', { class: 'ph' }, 'Nothing to show until the strings load.')));
    return;
  }
  if (!live()) return;

  /** English first - it is the column people recognise while searching. */
  const baseIndex = Math.max(0, texts.languages.indexOf('en'));

  const ROW_CAP = 500;

  function overrideFor(section, key) {
    return (state.tp.detail?.texts || []).find((t) => t.section === section && t.key === key) || null;
  }

  function paintRows() {
    if (!live()) return;
    const q = session.search.trim().toLowerCase();
    const chunks = [];
    let shown = 0;
    let total = 0;
    let capped = false;
    for (const section of texts.sections) {
      const hits = section.entries.filter((entry) => !q
        || entry.key.toLowerCase().includes(q)
        || section.name.toLowerCase().includes(q)
        || entry.values.some((v) => (v || '').toLowerCase().includes(q)));
      total += hits.length;
      if (!hits.length) continue;
      // Count first, THEN decide: a header with no rows under it looks broken.
      if (shown >= ROW_CAP) { capped = true; continue; }
      chunks.push(el('div', { class: 'ab-sec' }, `${section.name} · ${hits.length}`));
      for (const entry of hits) {
        if (shown++ >= ROW_CAP) { capped = true; break; }
        const id = `${section.name}/${entry.key}`;
        const mine = overrideFor(section.name, entry.key);
        chunks.push(el('button', {
          class: `ab-row${session.selected === id ? ' on' : ''}`,
          onclick: () => selectRow(id),
        },
          el('span', { class: 'k' }, entry.key),
          el('span', { class: 'v' }, entry.values[baseIndex] || entry.values[0] || ''),
          Object.keys(session.drafts).some((k) => k.startsWith(`${id}::`))
            ? el('span', { class: 'edited unsaved', title: 'unsaved wording' }, '●')
            : (mine ? el('span', { class: 'edited' }, '✎') : null)));
      }
    }
    if (capped) {
      chunks.push(el('div', { class: 'ab-sec' },
        `showing the first ${ROW_CAP} of ${total} - type to narrow it down`));
    }
    fill(rows, chunks.length ? chunks : [el('div', { class: 'ab-sec' }, 'Nothing matches')]);
  }

  /**
   * Drafts are kept per string and per language rather than in one slot, so
   * clicking another row - or flipping the language picker to check a
   * translation - never throws away what someone typed. (A confirm dialog was
   * the other option, but this app has a single modal backdrop: opening one
   * from inside the browser would replace the browser.)
   */
  const draftKey = (id, lang) => `${id}::${lang}`;
  const getDraft = (id, lang) => session.drafts[draftKey(id, lang)];
  const setDraft = (id, lang, value) => { session.drafts[draftKey(id, lang)] = value; };
  const clearDraft = (id, lang) => { delete session.drafts[draftKey(id, lang)]; };

  function selectRow(id) {
    if (!live() || session.selected === id) return;
    session.selected = id;
    session.confirmRemove = null;
    paintRows();
    paintDetail();
  }

  function find(id) {
    if (!id) return null;
    const cut = id.indexOf('/');
    const sectionName = id.slice(0, cut);
    const key = id.slice(cut + 1);
    const section = texts.sections.find((s) => s.name === sectionName);
    const entry = section?.entries.find((e) => e.key === key);
    return entry ? { sectionName, key, entry } : null;
  }

  function paintDetail() {
    if (!live()) return;
    const found = find(session.selected);
    if (!found) {
      fill(detail, el('div', { class: 'ab-blank' },
        el('span', { class: 'ph' }, 'Pick a line on the left.', el('br'),
          'You’ll see what the game says and can type what it should say instead.')));
      return;
    }
    const { sectionName, key, entry } = found;
    const mine = overrideFor(sectionName, key);
    const lang = session.lang;
    const langIndex = lang === '*' ? baseIndex : Math.max(0, texts.languages.indexOf(lang));
    const original = entry.values[langIndex] || '';
    const current = mine?.values.find((v) => v.lang === lang);
    const id = `${sectionName}/${key}`;
    const saved = current?.value ?? original;
    const draft = getDraft(id, lang) ?? saved;
    const dirty = draft !== saved;

    const box = el('textarea', {
      class: 'game-input', rows: 4,
      oninput: (ev) => {
        setDraft(id, lang, ev.target.value);
        // Only the Save button's look changes, so typing never repaints the box
        // out from under the cursor.
        const button = detail.querySelector('.js-save-text');
        if (button) button.classList.toggle('btn-green', ev.target.value !== saved);
      },
    });
    box.value = draft;

    const picker = el('select', {
      class: 'game-input',
      onchange: (ev) => { session.lang = ev.target.value; paintDetail(); },
    },
      el('option', { value: '*' }, 'Every language'),
      ...texts.languages.map((code) => el('option', { value: code }, GAME_LANGS[code] || code)));
    picker.value = lang;

    fill(detail,
      el('div', { class: 'ab-facts' }, el('b', {}, `${sectionName} / ${key}`)),
      el('div', { class: 'cap' }, 'What the game says'),
      el('div', { class: 'ab-orig' }, ...tmpMarkup(original || '(empty)')),
      el('div', { class: 'ab-lang' },
        el('span', { class: 'tiny' }, 'Apply to'),
        picker),
      el('div', { class: 'cap' }, 'What it should say'),
      box,
      /^\s*$/.test(draft) ? null : markupNote(draft),
      el('div', { class: 'ab-actions' },
        // `draft` is what is in the box right now; pass it explicitly so Save
        // can never fall back past the override the box is showing.
        el('button', {
          class: `btn small js-save-text ${dirty || !mine ? 'btn-green' : 'btn-cream'}`,
          onclick: () => save(sectionName, key, original, box.value),
        }, 'Save override'),
        mine ? el('button', {
          class: `btn small ${session.confirmRemove === `${sectionName}/${key}` ? 'btn-red' : 'btn-cream'}`,
          title: mine.values.length > 1 ? 'Removes this override in every language it has' : '',
          onclick: () => {
            const rowId = `${sectionName}/${key}`;
            if (session.confirmRemove !== rowId) { session.confirmRemove = rowId; paintDetail(); return; }
            session.confirmRemove = null;
            drop(sectionName, key);
          },
        }, session.confirmRemove === `${sectionName}/${key}`
          ? (mine.values.length > 1 ? `Remove all ${mine.values.length} languages?` : 'Remove it?')
          : 'Remove from pack') : null),
      mine ? el('div', { class: 'ab-facts' },
        'In this pack for: ',
        mine.values.map((v) => (v.lang === '*' ? 'every language' : GAME_LANGS[v.lang] || v.lang)).join(', ')) : null);
  }

  /** The game turns a handful of characters into colour codes before drawing. */
  function markupNote(text) {
    const sentinels = ['&', '|', '∏', '°', '£', '^', '*', '§', '_', '¨', '€', '~', '}', '@', 'Ø', '‡', '∑', 'π', '≈', 'µ', 'æ', 'ƒ', '◊', '∞', '√', '∆', '∂', '©', '∫', '≠'];
    const found = sentinels.filter((c) => text.includes(c));
    if (!found.length) return null;
    return el('div', { class: 'ab-note' },
      `The game reads ${found.join(' ')} as colour markup and swaps ${found.length === 1 ? 'it' : 'them'} for a colour code before drawing. `
      + 'That is how the game colours words - keep it if you meant it.');
  }

  async function save(sectionName, key, original, typed) {
    const value = typed ?? original;
    try {
      const result = await call(api.setPackText, {
        id: pack.id, section: sectionName, key, lang: session.lang, value, original,
      });
      state.tp.detail = result.pack;
      if (live()) clearDraft(`${sectionName}/${key}`, session.lang);
      paintRows();
      paintDetail();
      await refresh();
      toast('Text override saved.', 'ok');
    } catch (err) {
      toast(err.message, 'err');
    }
  }

  async function drop(sectionName, key) {
    try {
      state.tp.detail = await call(api.removePackText, { id: pack.id, section: sectionName, key });
      if (live()) clearDraft(`${sectionName}/${key}`, session.lang);
      paintRows();
      paintDetail();
      await refresh();
      toast('Back to the game’s own wording.', 'ok');
    } catch (err) {
      toast(err.message, 'err');
    }
  }

  paintRows();
  paintDetail();
  setTimeout(() => search.focus(), 0);
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
  renderTexturePacks();
  loadRepos();
});

api.on('publish:signInFailed', ({ error }) => {
  state.publish.device = null;
  toast(`Sign-in failed: ${error}`, 'err');
  renderPublish();
  renderModpacks();
  renderTexturePacks();
});

for (const btn of document.querySelectorAll('.nav-btn')) {
  btn.addEventListener('click', () => show(btn.dataset.view));
}
// Click anywhere outside an open dropdown closes it.
document.addEventListener('click', (ev) => {
  if (state.ui.mpMenuOpen && !ev.target.closest('.setup-dd')) {
    state.ui.mpMenuOpen = false;
    renderModpackSelector();
  }
  if ((state.ui.mpModMenu || state.ui.mpAddMenu || state.ui.mpSkinMenu) && !ev.target.closest('.dropdown')) {
    state.ui.mpModMenu = null;
    state.ui.mpAddMenu = false;
    state.ui.mpSkinMenu = false;
    renderModpackPanel();
  }
  if (state.ui.tpAddMenuOpen && !ev.target.closest('.tp-add-wrap')) {
    state.ui.tpAddMenuOpen = false;
    renderTpPanel();
  }
});
$('tpImportBtn').addEventListener('click', importTpFlow);
document.addEventListener('keydown', (ev) => {
  // promptModal wires its own Escape on the input; this covers the rest,
  // including the asset browser, whose only other exit is a small Done button.
  if (ev.key !== 'Escape') return;
  if (!$('modalBackdrop').classList.contains('open')) return;
  if (!$('modalInput').hidden) return;
  const out = modal.escape;
  if (!out) return;
  ev.preventDefault();
  out();
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
