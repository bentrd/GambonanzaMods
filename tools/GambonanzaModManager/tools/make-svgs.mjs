#!/usr/bin/env node
// Generates the inline pixel-art SVGs used by the renderer (and the site):
// the brand knight - from the SAME sprite as build/icon.png so the in-app
// logo matches the dock icon - and the sidebar icon set, drawn on a 12x12
// grid in a single style. Run after editing a grid:
//
//     node tools/make-svgs.mjs        # prints the <svg> snippets to stdout

// Same sprite as tools/make-icon.mjs - keep the two in sync.
export const KNIGHT_SPRITE = [
  '................',
  '......####......',
  '.....#CCCC#.....',
  '....#CCCCCC#....',
  '...#CCYCCCCC#...',
  '...#CCCCCCCC#...',
  '..#CCCCCCCCCC#..',
  '..#CCC#CCCCCC#..',
  '...##.#CCCCC#...',
  '......#CCCC#....',
  '.....#CCCCCC#...',
  '....#CCCCCCCC#..',
  '...#CCCCCCCCCC#.',
  '...############.',
  '..#DDDDDDDDDDDD#',
  '..##############',
];

const KNIGHT_COLORS = {
  '#': '#1a0e12', // ink outline
  C: '#f4e5c2',   // cream piece
  Y: '#f4c530',   // yellow eye
  D: '#5a2230',   // base shadow
};

// 12x12 one-colour icons ('#' = filled). Drawn to read at 17-20px.
export const ICONS = {
  home: [
    '............',
    '.....##.....',
    '....####....',
    '...######...',
    '..########..',
    '.##########.',
    '..########..',
    '..########..',
    '..###..###..',
    '..###..###..',
    '..###..###..',
    '............',
  ],
  shop: [
    '............',
    '.####..####.',
    '.####..####.',
    '.####..####.',
    '.####..####.',
    '............',
    '............',
    '.####..####.',
    '.####..####.',
    '.####..####.',
    '.####..####.',
    '............',
  ],
  mods: [
    '............',
    '.....##.....',
    '.....##.....',
    '....####....',
    '...######...',
    '.##########.',
    '.##########.',
    '...######...',
    '....####....',
    '.....##.....',
    '.....##.....',
    '............',
  ],
  updates: [
    '.....##.....',
    '.....##.....',
    '.....##.....',
    '.##########.',
    '..########..',
    '...######...',
    '....####....',
    '.....##.....',
    '............',
    '.##########.',
    '.##########.',
    '............',
  ],
  publish: [
    '............',
    '........##..',
    '.......####.',
    '......#####.',
    '.....#####..',
    '....#####...',
    '...#####....',
    '..#####.....',
    '.#####......',
    '.###........',
    '.#..........',
    '............',
  ],
  settings: [
    '....####....',
    '.#..####..#.',
    '.##########.',
    '..########..',
    '#####..#####',
    '#####..#####',
    '#####..#####',
    '..########..',
    '.##########.',
    '.#..####..#.',
    '....####....',
    '............',
  ],
};

/** Merge a grid's filled cells into one crisp path. */
export function gridToPath(grid, match = (c) => c === '#') {
  let d = '';
  grid.forEach((row, y) => {
    // run-length encode each row into horizontal bars
    let x = 0;
    while (x < row.length) {
      if (!match(row[x])) { x++; continue; }
      let w = 0;
      while (x + w < row.length && match(row[x + w])) w++;
      d += `M${x} ${y}h${w}v1h-${w}z`;
      x += w;
    }
  });
  return d;
}

export function knightSvg(size = 26) {
  const layers = Object.entries(KNIGHT_COLORS)
    .map(([ch, color]) => {
      const d = gridToPath(KNIGHT_SPRITE, (c) => c === ch);
      return d ? `<path fill="${color}" d="${d}"/>` : '';
    })
    .join('');
  return `<svg class="pix" width="${size}" height="${size}" viewBox="0 0 16 16" shape-rendering="crispEdges" aria-hidden="true">${layers}</svg>`;
}

export function iconSvg(name, size = 17) {
  const d = gridToPath(ICONS[name]);
  return `<svg class="pix" width="${size}" height="${size}" viewBox="0 0 12 12" shape-rendering="crispEdges" fill="currentColor" aria-hidden="true"><path d="${d}"/></svg>`;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  console.log('=== brand knight (matches build/icon.png) ===');
  console.log(knightSvg());
  for (const name of Object.keys(ICONS)) {
    console.log(`=== ${name} ===`);
    console.log(iconSvg(name));
  }
}
