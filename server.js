const express = require('express');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');
const Database = require('better-sqlite3');
const { z } = require('zod');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(morgan('dev'));

const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
});
app.use(limiter);

const dbPath = path.join(__dirname, 'counter.db');
const db = new Database(dbPath);

db.exec(`
  CREATE TABLE IF NOT EXISTS counters (
    name TEXT PRIMARY KEY,
    value INTEGER NOT NULL DEFAULT 0
  );
`);

const getCounterStmt = db.prepare(
  'SELECT value FROM counters WHERE name = ?'
);
const insertCounterStmt = db.prepare(
  'INSERT INTO counters (name, value) VALUES (?, ?)'
);
const updateCounterStmt = db.prepare(
  'UPDATE counters SET value = ? WHERE name = ?'
);

function getAndIncrementCounter(name) {
  const row = getCounterStmt.get(name);
  if (!row) {
    insertCounterStmt.run(name, 1);
    return 1;
  }
  const nextValue = row.value + 1;
  updateCounterStmt.run(nextValue, name);
  return nextValue;
}

function peekCounter(name) {
  const row = getCounterStmt.get(name);
  if (!row) return 0;
  return row.value;
}

const querySchema = z.object({
  theme: z.string().optional().default('southpark'),
  padding: z
    .string()
    .optional()
    .transform((v) => (v == null ? undefined : Number(v)))
    .pipe(z.number().int().min(1).max(16).optional())
    .default(7),
  offset: z
    .string()
    .optional()
    .transform((v) => (v == null ? undefined : Number(v)))
    .pipe(z.number().int().min(-500).max(500).optional())
    .default(0),
  scale: z
    .string()
    .optional()
    .transform((v) => (v == null ? undefined : Number(v)))
    .pipe(z.number().min(0.1).max(2).optional())
    .default(1),
  align: z
    .enum(['top', 'center', 'bottom'])
    .optional()
    .default('top'),
  pixelated: z
    .string()
    .optional()
    .transform((v) => (v == null ? undefined : Number(v)))
    .pipe(z.number().int().min(0).max(1).optional())
    .default(1),
  darkmode: z
    .enum(['0', '1', 'auto'])
    .optional()
    .default('auto'),
  num: z
    .string()
    .optional()
    .transform((v) => (v == null ? undefined : Number(v)))
    .pipe(z.number().int().min(0).optional())
    .default(0),
  prefix: z.string().optional().default(''),
  inc: z
    .string()
    .optional()
    .transform((v) => (v == null ? undefined : Number(v)))
    .pipe(z.number().int().min(0).max(1).optional())
    .default(1),
});

const lightPalette = {
  bg: '#f4efe0',
  frame: '#222222',
  digitBg: '#ffe6b3',
  digitBorder: '#111111',
  text: '#222222',
};

const darkPalette = {
  bg: '#1f242b',
  frame: '#f8f8f8',
  digitBg: '#384453',
  digitBorder: '#f8f8f8',
  text: '#fdfdfd',
};

function pickPalette(darkmode, prefersDark = false) {
  if (darkmode === '1') return darkPalette;
  if (darkmode === '0') return lightPalette;
  return prefersDark ? darkPalette : lightPalette;
}

function renderSouthParkCounter({
  value,
  padding,
  offset,
  scale,
  align,
  darkmode,
  pixelated,
  prefix,
}) {
  const prefersDark = false;
  const palette = pickPalette(darkmode, prefersDark);

  const strValue = String(value).padStart(padding, '0');
  const displayStr = `${prefix || ''}${strValue}`;

  const digitWidth = 32;
  const digitHeight = 42;
  const digitGap = 4;
  const paddingX = 12;
  const paddingY = 12;

  const totalWidth =
    paddingX * 2 + displayStr.length * digitWidth + (displayStr.length - 1) * digitGap;
  const totalHeight = paddingY * 2 + digitHeight * 2.2;

  const scaledWidth = totalWidth * scale;
  const scaledHeight = totalHeight * scale;

  const baselineOffset = (() => {
    if (align === 'top') return 0;
    if (align === 'center') return (totalHeight * (1 - scale)) / 2;
    return totalHeight * (1 - scale);
  })();

  const shapeRendering = pixelated === 1 ? 'crispEdges' : 'auto';

  const digitAccents = [
    '#f6b7b7',
    '#f6e0b7',
    '#f6f2b7',
    '#c0f6b7',
    '#b7f6e9',
    '#b7d5f6',
    '#cdb7f6',
    '#f6b7e6',
    '#f6c5b7',
    '#b7f6c7',
  ];

  let digitsSvg = '';
  Array.from(displayStr).forEach((char, idx) => {
    const x =
      paddingX + idx * (digitWidth + digitGap) + offset;
    const charBaseY = paddingY;
    const isDigit = /[0-9]/.test(char);
    const accentColor = isDigit
      ? digitAccents[Number(char) % digitAccents.length]
      : '#f4e0b7';

    digitsSvg += `
      <g transform="translate(${x}, ${charBaseY})">
        <circle
          cx="${digitWidth / 2}"
          cy="${digitHeight * -0.1}"
          r="${digitWidth / 2.3}"
          fill="${accentColor}"
          stroke="${palette.digitBorder}"
          stroke-width="2"
        />
        <rect
          x="${digitWidth * 0.18}"
          y="${digitHeight * 0.12}"
          rx="6"
          ry="6"
          width="${digitWidth * 0.64}"
          height="${digitHeight * 0.8}"
          fill="${palette.digitBg}"
          stroke="${palette.digitBorder}"
          stroke-width="2"
        />
        <rect
          x="0"
          y="${digitHeight * 0.32}"
          rx="4"
          ry="4"
          width="${digitWidth}"
          height="${digitHeight * 0.75}"
          fill="${accentColor}"
          opacity="0.95"
        />
        <text
          x="${digitWidth / 2}"
          y="${digitHeight * 0.85}"
          text-anchor="middle"
          font-family="system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif"
          font-size="22"
          font-weight="700"
          fill="${palette.text}"
        >
          ${char}
        </text>
      </g>
    `;
  });

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg
  xmlns="http://www.w3.org/2000/svg"
  width="${scaledWidth}"
  height="${scaledHeight}"
  viewBox="0 0 ${totalWidth} ${totalHeight}"
  shape-rendering="${shapeRendering}"
>
  <defs>
    <filter id="soft-shadow" x="-20%" y="-20%" width="140%" height="140%">
      <feDropShadow dx="0" dy="3" stdDeviation="3" flood-color="#000000" flood-opacity="0.35" />
    </filter>
  </defs>
  <g transform="translate(0, ${baselineOffset}) scale(${scale})">
    <rect
      x="0"
      y="0"
      rx="10"
      ry="10"
      width="${totalWidth}"
      height="${totalHeight}"
      fill="${palette.bg}"
      stroke="${palette.frame}"
      stroke-width="2"
      filter="url(#soft-shadow)"
    />
    ${digitsSvg}
  </g>
</svg>
`;
}

app.get('/', (req, res) => {
  res.type('text/plain').send(
    [
      'South Park Profile Counter',
      '',
      'Usage:',
      '  GET /@:name',
      '',
      'Example:',
      '  /@masonliiu?theme=southpark&padding=7&darkmode=auto',
      '',
      'Query params:',
      '  theme      = southpark (for now, only theme implemented)',
      '  padding    = 1-16 (min digits, default 7)',
      '  offset     = -500..500 (horizontal shift per digit, default 0)',
      '  scale      = 0.1-2 (image scale, default 1)',
      '  align      = top|center|bottom (vertical alignment, default top)',
      '  pixelated  = 0|1 (shape rendering hint, default 1)',
      '  darkmode   = 0|1|auto (palette, default auto)',
      '  num        = override display number (0 to disable, default 0)',
      '  prefix     = optional prefix string (like "SP-")',
      '  inc        = 0|1 (increment on view, default 1)',
      '',
      'Embed in Markdown:',
      '  ![southpark-counter](http://localhost:' +
        PORT +
        '/@your-name?theme=southpark)',
    ].join('\n')
  );
});

app.get('/@:name', (req, res) => {
  const name = req.params.name;
  if (!name || typeof name !== 'string' || name.length > 128) {
    return res.status(400).type('text/plain').send('Invalid name');
  }

  let parsed;
  try {
    parsed = querySchema.parse(req.query);
  } catch (err) {
    return res.status(400).type('text/plain').send('Invalid query params');
  }

  const { num, prefix, inc, padding, offset, scale, align, darkmode, pixelated } =
    parsed;

  let value;
  if (num && num > 0) {
    value = num;
  } else {
    value = inc === 1 ? getAndIncrementCounter(name) : peekCounter(name);
  }

  const svg = renderSouthParkCounter({
    value,
    padding,
    offset,
    scale,
    align,
    darkmode,
    pixelated,
    prefix,
  });

  res.setHeader('Content-Type', 'image/svg+xml');
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');

  return res.send(svg);
});

app.use((req, res) => {
  res.status(404).type('text/plain').send('Not found');
});

app.listen(PORT, () => {
  console.log(`South Park counter listening on http://localhost:${PORT}`);
});


