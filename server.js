const express = require('express');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');
const { z } = require('zod');
const path = require('path');
const fs = require('fs');
let sharp;
try {
  sharp = require('sharp');
} catch (e) {
  console.warn('sharp not available, using original images (may be large)');
}
let Redis;
let redisClient;
try {
  const upstashRedis = require('@upstash/redis');
  Redis = upstashRedis.Redis;
} catch (e) {
  console.warn('@upstash/redis package not available, using file system storage');
}

const app = express();
const PORT = process.env.PORT || 3000;

app.set('trust proxy', 1);
app.use(morgan('dev'));
app.use('/assets', express.static(path.join(__dirname, 'assets'), {
  setHeaders: (res, path) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 'public, max-age=31536000');
  }
}));

const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
});
app.use(limiter);

const jsonPath = process.env.VERCEL === '1' || process.env.VERCEL_ENV
  ? '/tmp/counters.json' 
  : path.join(__dirname, 'counters.json');
const assetsPath = path.join(__dirname, 'assets');

const useRedis = Redis && (
  process.env.UPSTASH_REDIS_REST_URL || 
  process.env.UPSTASH_REDIS_REST_TOKEN ||
  process.env.KV_REST_API_URL ||
  process.env.KV_REST_API_TOKEN ||
  (process.env.REDIS_URL && process.env.REDIS_URL.startsWith('https://'))
);

if (useRedis && Redis) {
  try {
    if (process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN) {
      redisClient = new Redis({
        url: process.env.KV_REST_API_URL,
        token: process.env.KV_REST_API_TOKEN,
      });
      console.log('Upstash Redis initialized successfully (KV_REST_API_URL)');
      console.log('   Redis URL: Set');
      console.log('   Redis Token: Set');
    } else if (process.env.UPSTASH_REDIS_REST_URL || process.env.UPSTASH_REDIS_REST_TOKEN) {
      redisClient = Redis.fromEnv();
      console.log('Upstash Redis initialized successfully (fromEnv)');
      console.log('   Redis URL:', process.env.UPSTASH_REDIS_REST_URL ? 'Set' : 'Not set');
      console.log('   Redis Token:', process.env.UPSTASH_REDIS_REST_TOKEN ? 'Set' : 'Not set');
    } else if (process.env.REDIS_URL && process.env.REDIS_URL.startsWith('https://')) {
      redisClient = new Redis({
        url: process.env.REDIS_URL,
        token: process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || process.env.REDIS_TOKEN,
      });
      console.log('Redis initialized successfully (REDIS_URL - Upstash REST API)');
      console.log('   Redis URL: Set');
      console.log('   Redis Token:', (process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || process.env.REDIS_TOKEN) ? 'Set' : 'Not set');
    } else {
      console.warn('Redis environment variables not properly configured');
      console.warn('   KV_REST_API_URL:', process.env.KV_REST_API_URL ? 'Set' : 'Not set');
      console.warn('   KV_REST_API_TOKEN:', process.env.KV_REST_API_TOKEN ? 'Set' : 'Not set');
      redisClient = null;
    }
  } catch (err) {
    console.error('Failed to initialize Redis:', err);
    console.error('   Error details:', err.message);
    redisClient = null;
  }
} else {
  console.log('Using file system storage (Redis not configured)');
  console.log('   Redis package:', Redis ? 'Loaded' : 'Not loaded');
  console.log('   useRedis condition:', useRedis);
  if (!Redis) {
    console.log('   @upstash/redis package not installed');
  } else {
    console.log('   Environment variables not set:');
    console.log('   - UPSTASH_REDIS_REST_URL:', process.env.UPSTASH_REDIS_REST_URL ? 'Set' : 'Not set');
    console.log('   - UPSTASH_REDIS_REST_TOKEN:', process.env.UPSTASH_REDIS_REST_TOKEN ? 'Set' : 'Not set');
    console.log('   - KV_REST_API_URL:', process.env.KV_REST_API_URL ? 'Set' : 'Not set');
    console.log('   - KV_REST_API_TOKEN:', process.env.KV_REST_API_TOKEN ? 'Set' : 'Not set');
    console.log('   - REDIS_URL:', process.env.REDIS_URL ? 'Set' : 'Not set');
  }
}

const imageDataUriCache = new Map();

async function imageToDataUri(imagePath) {
  if (imageDataUriCache.has(imagePath)) {
    return imageDataUriCache.get(imagePath);
  }

  try {
    const fullPath = path.join(assetsPath, path.basename(imagePath));
    let imageBuffer;
    
    if (sharp) {
      try {
        imageBuffer = await sharp(fullPath)
          .resize(120, null, { 
            withoutEnlargement: true,
            fit: 'inside',
            kernel: sharp.kernel.lanczos3
          })
          .png({ 
            compressionLevel: 9,
            adaptiveFiltering: true,
            palette: true,
            quality: 70
          })
          .toBuffer();
      } catch (sharpErr) {
        console.warn(`Sharp compression failed for ${imagePath}, using original:`, sharpErr);
        imageBuffer = fs.readFileSync(fullPath);
      }
    } else {
      imageBuffer = fs.readFileSync(fullPath);
    }
    
    const mimeType = imagePath.endsWith('.png') ? 'image/png' : 'image/jpeg';
    const base64 = imageBuffer.toString('base64');
    const dataUri = `data:${mimeType};base64,${base64}`;
    
    imageDataUriCache.set(imagePath, dataUri);
    return dataUri;
  } catch (err) {
    console.error(`Failed to load image ${imagePath}:`, err);
    return imagePath;
  }
}

async function readStore() {
  if (useRedis && redisClient) {
    try {
      const data = await redisClient.get('counters');
      if (data) {
        const parsed = typeof data === 'string' ? JSON.parse(data) : data;
        if (parsed && typeof parsed === 'object') {
          console.log('📖 Read from Redis:', Object.keys(parsed).length, 'counters');
          return parsed;
        }
      }
      return {};
    } catch (err) {
      console.error('Failed to read from Redis:', err);
      return {};
    }
  }
  
  try {
    const raw = fs.readFileSync(jsonPath, 'utf8');
    const data = JSON.parse(raw);
    if (data && typeof data === 'object') return data;
    return {};
  } catch {
    return {};
  }
}

async function writeStore(store) {
  if (useRedis && redisClient) {
    try {
      await redisClient.set('counters', JSON.stringify(store));
      console.log('Wrote to Redis:', Object.keys(store).length, 'counters');
    } catch (err) {
      console.error('Failed to write to Redis:', err);
    }
    return;
  }
  
  try {
    if (jsonPath.startsWith('/tmp')) {
      try {
        fs.mkdirSync('/tmp', { recursive: true });
      } catch {
      }
    }
    fs.writeFileSync(jsonPath, JSON.stringify(store), 'utf8');
  } catch (err) {
    console.error('Failed to write store:', err);
  }
}

async function getAndIncrementCounter(name) {
  const store = await readStore();
  const current = typeof store[name] === 'number' && Number.isFinite(store[name]) ? store[name] : 0;
  const nextValue = current + 1;
  store[name] = nextValue;
  await writeStore(store);
  return nextValue;
}

async function peekCounter(name) {
  const store = await readStore();
  const current = typeof store[name] === 'number' && Number.isFinite(store[name]) ? store[name] : 0;
  return current;
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
  order: z.string().optional().default(''),
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

const characterKeyToPath = {
  stan: '/assets/stan.png',
  kyle: '/assets/kyle.png',
  'mr-mackey': '/assets/mr mackey.png',
  kenny: '/assets/kenny.png',
  cartman: '/assets/cartman.png',
  timmy: '/assets/timmy.png',
  wendy: '/assets/wendy.png',
};

function parseOrder(orderStr) {
  if (!orderStr) return null;
  const keys = orderStr
    .split(',')
    .map((k) => k.trim().toLowerCase())
    .filter(Boolean);
  const seen = new Set();
  const resolved = [];
  for (const rawKey of keys) {
    const key = rawKey.replace(/\s+/g, '-');
    const path = characterKeyToPath[key];
    if (path && !seen.has(path)) {
      seen.add(path);
      resolved.push(path);
    }
  }
  return resolved.length ? resolved : null;
}

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
  characterOrder,
}) {
  const prefersDark = false;
  const palette = pickPalette(darkmode, prefersDark);

  const strValue = String(value).padStart(padding, '0');
  const displayStr = `${prefix || ''}${strValue}`;

  const digitWidth = 140;
  const digitHeight = 112;
  const digitGap = 0;
  const paddingX = 0;
  const paddingY = 0;

  const defaultCharacterImages = [
    '/assets/stan.png',
    '/assets/kyle.png',    
    '/assets/mr mackey.png',
    '/assets/kenny.png',
    '/assets/cartman.png',
    '/assets/timmy.png',
    '/assets/wendy.png',
  ];

  const characterImages = characterOrder && characterOrder.length
    ? characterOrder
    : defaultCharacterImages;

  const getImageHref = (relativePath) => {
    if (imageDataUriCache.has(relativePath)) {
      return imageDataUriCache.get(relativePath);
    }
    return relativePath;
  };

  const characterScales = {
    '/assets/cartman.png': 0.6,
    '/assets/mr mackey.png': 0.7,
    '/assets/stan.png': 0.6,
    '/assets/kenny.png': 0.6,
    '/assets/timmy.png': 0.8,
    '/assets/wendy.png': 0.6,
    '/assets/kyle.png': 0.7,
  };

  let totalWidth = paddingX * 2;
  Array.from(displayStr).forEach((char, idx) => {
    const imgHref = characterImages[idx % characterImages.length];
    const charScale = characterScales[imgHref] || 1.0;
    totalWidth += digitWidth * charScale;
    if (idx < displayStr.length - 1) {
      totalWidth += digitGap;
    }
  });
  
  let maxHeight = digitHeight;
  Array.from(displayStr).forEach((char, idx) => {
    const imgHref = characterImages[idx % characterImages.length];
    const charScale = characterScales[imgHref] || 1.0;
    maxHeight = Math.max(maxHeight, digitHeight * charScale);
  });
  const totalHeight = maxHeight;
  const bottomAlignY = maxHeight;

  const scaledWidth = totalWidth * scale;
  const scaledHeight = totalHeight * scale;

  const baselineOffset = (() => {
    if (align === 'top') return 0;
    if (align === 'center') return (totalHeight * (1 - scale)) / 2;
    return totalHeight * (1 - scale);
  })();

  const shapeRendering = pixelated === 1 ? 'crispEdges' : 'auto';

  const characterPositions = {
    '/assets/cartman.png': { x: 0.68, y: 0.7 },
    '/assets/mr mackey.png': { x: 0.67, y: 0.57 },
    '/assets/stan.png': { x: 0.7, y: 0.7 },
    '/assets/kenny.png': { x: 0.7, y: 0.7 },
    '/assets/timmy.png': { x: 0.75, y: 0.49 },
    '/assets/wendy.png': { x: 0.69, y: 0.7 },
    '/assets/kyle.png': { x: 0.75, y: 0.56 },
  };

  const characterRotations = {
    '/assets/cartman.png': 0,
    '/assets/mr mackey.png': 0,
    '/assets/stan.png': 0,
    '/assets/kenny.png': 0,
    '/assets/timmy.png': 0,
    '/assets/wendy.png': 0,
    '/assets/kyle.png': 5,
  };

  let digitsSvg = '';
  let currentX = paddingX + offset;
  Array.from(displayStr).forEach((char, idx) => {
    const isDigit = /[0-9]/.test(char);
    const imgPath = characterImages[idx % characterImages.length];
    const imgHref = getImageHref(imgPath);
    const pos = characterPositions[imgPath] || { x: 0.5, y: 0.75 };
    const rotation = characterRotations[imgPath] || 0;
    const charScale = characterScales[imgPath] || 1.0;
    
    const charWidth = digitWidth * charScale;
    const charHeight = digitHeight * charScale;
    const charBaseY = bottomAlignY - charHeight;
    
    const textX = charWidth * pos.x;
    const textY = charHeight * pos.y;
    const textTransform = rotation !== 0 
      ? `rotate(${rotation} ${textX} ${textY})`
      : '';

    digitsSvg += `
      <g transform="translate(${currentX}, ${charBaseY})">
        <image
          xlink:href="${imgHref}"
          href="${imgHref}"
          x="0"
          y="0"
          width="${charWidth}"
          height="${charHeight}"
          preserveAspectRatio="meet"
        />
        <text
          x="${textX}"
          y="${textY}"
          transform="${textTransform}"
          text-anchor="middle"
          dominant-baseline="middle"
          font-family="'Press Start 2P', 'VT323', 'Courier New', monospace"
          font-size="${charHeight * 0.28}"
          font-weight="normal"
          fill="${palette.text}"
        >
          ${char}
        </text>
      </g>
    `;
    
    currentX += charWidth + digitGap;
  });

  return `<?xml version="1.0" encoding="UTF-8" standalone="no"?>
<svg
  xmlns="http://www.w3.org/2000/svg"
  xmlns:xlink="http://www.w3.org/1999/xlink"
  width="${scaledWidth}"
  height="${scaledHeight}"
  viewBox="0 0 ${totalWidth} ${totalHeight}"
  shape-rendering="${shapeRendering}"
  role="img"
>
  <defs>
    <style type="text/css"><![CDATA[
      @font-face {
        font-family: 'Press Start 2P';
        src: url('data:font/woff2;base64,d09GMgABAAAAADCYAA8AAAAAoSAAADA4AAEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAHIJkBmAAhGwIgWIJmhYRCAqCiRiB6zULg0IAATYCJAODRgQgBYRKB4RQDIExG2+PFdwYuhnjMAAeGYwoShRtURTlonUIAlW9HlCRsWU83QUEbQxGbD9lb1mbkzovhlN2CnGb707/9NLGVlp2whJSSy3TpN4mx7MulOHZ/Fo5xrrpgYxNgnNPOykR/i8oZs3zMseCX2AqNiKti3SJlFIeobFPcuF5eO/13CQFnMqTVQAZQPZz9iPIKeglBh7zQOykqqpuE0O3GqTTmpVWJkqiAMmWJYPWiLfxWgFA+4C6ey6pAi7qL0l5oOqq8oue/Edd+r4IbMmAFx6W4k7gXreAC6ysXZbywP8x/64a9J3xBNYc7cO10HwkVf+TdgMowNbP/NlY87+ZVfUlaFySoO3HhLjxeGwvDnlCCFxPC9/jfv/vUyVhPhDfV0JO4aSQKexVJHYVssbgPSYxmQR/S4P/f5dmCoEiT+cH2aNJa1tne5NSJdu7OGEBWAxdTTrENFEOsMHgpO00TdO03yP6O/smxv1Szf7/tEMDDYCckfzuMzayP0k1NatMIXktFKpY+RSi/3+mWqW/GiABzjpqjYus3kK7dz5IZM+ZzL/cRJeB/1dXEVXobrJBAAIgcE6AzI5oZDDSGpnX1d3ggJT2SP+odQaj81xjIw1l3Zxd46NzPvMmu8uinexcmlySJAdv76n5id1RC4at7WhEe7OxJo5DzRYlzj6f7vfD7GESbVvd1SUjIiKOiDjBibH5+MndMaZZfS+fzhEFoxuUccdQSNp+gRHAWgtjUZq1t48R93Z8y3vY4440rR1rsIbJhIqCGeZ/MxUEDc0uzgUVi/+LwTzUkn7IeVddz1Rp/bK3iIFrFAnlSytoLGWQWqxpgGCJ4I+CK9YEjX4U5iBoBALnKujoa6S9y00VbDGn/E/eVxmFrgShk/5EDAV367eaicoqxqBgjzkzQD39oke5eulIRmN+vEIIaypgY3Ha1Rem1gVdQ3srO7wFIVaS31R9KTMxA2Wy0gu0la8oA1SJnAYwo/ZNLfgEm04PbZyEoCn1JYD6UgoDWAGgvFcJFJrLy11REa05/NWtRoeGK2AnXm3DmaRypGv0qHJeeaw81Tt90U/1S80M7TAMb4XvAsvxrwP3QVMmExhvqqOSOlamury81Sf9sPVWq5i+AR1J8usWjP8+/13/a/9VqFgKFblyFGr9t2eFw4udL2p/1/rahABQCbRzF2QmtRGZ3IwW/28DKgtZzmIOc4lrrGADG5nFCeazhSWsYh4rOctpzrCUq2jYYscBJ9zxwBMv/AlARxCChSJWvEoqq6KqWmqro676WMds1nOf1TylgRZaao22Oumsi656666Ov/gYYJFmqNOkyZclXoFCRUmu4y1rOc4BFHOQohzjGPW7whJsYtnGBrdziGXc4x2Sm8JCLXGcOj5jEcNuZwXRmsgxLzDDHmgVWbLDHDWdccMUPb3zwxZEQkcKEI1qEk0SpqZrqaqgnDhmaaKiRZhqjqeZopSPaaa+DXrqjh57aGGiYwYZINNQpEuTJliNXsRQlYiTZzCZ2s4dd1P5j/Oa3kmMpBuOjSP/rJcbnewyoL/9L4CdgpElWGhXBT43qj6kDJnASty6kg38IHRzgOvoQqc476ZTvtHoSkYzy3wMPHs1tNh/34AII2xxBIPIQIAwt3+WQmBbi9T7U/DCm7/vE1iPbcdnRIxvp/OO5N+8+ORf7p9dOnpxiNcebF0nNaPd4QdraYHbMKqqiAbw+RHeqn4xL4MvlhtJ0lA+w6lD/HTBKKTmHWCkZ2I+3KQVkpi1BjbIQijiNKPqASx9c3CfIKECZefNaNOXhoBKR5x0SlHZCR2m3I2d91+dHqGrVIVYrKgbUPIv51I0PU7Tkk+AXEWK5Odo4sv5EheEW0xFSwMA16Lb3bwL6UJAe3kEeQUYo2YCbacqH+8X8D4qHvQNHleckCnnzciUPG91+iK3BxMcAvGZM8j5rFWJZ+1JQI2ur6kWLsPmYD+1BNOfwYD0K2bCyOdaZ+IcZJrnMEHmFAM7sbke/T7ajd7pPEx8IsiZJNo+Hv0YgxCAjVQNif5iBwgF9SARBdsiCrYEwE5GleR39o3hU9bL+EpFVR4OhTrDzRdjBZWz08WZ6NNv/RP8xGG3sOYsHF7+HXTwlJjJjrCEsrtYJhwVkPCBsUfcIJGNogR8suB5E1YVsnMa2iENQV6ufaONXst7mBZR3eiANSCoPTQTEDkEz0AxZszgrecMGTOibEAH6PxFC/l59gt27h2RfRsL6oC38r883Ph06GpQh41+jUYIQBkMdtZjL4mPLJS4Ck6xhwgpMsUYKUC0Jpi0ZZiwKs5YCc5YL5i03LFgeWLS8oxlm4V8X1+jgMpp6h9w8KNnYme2UUpOvNrdSZvKND+slds8JWn6yZbbENJQhbkmQsGTQLQpJSwHDcoFpuSFleSBteZus09J2hdzhmehIG1ZGSqjyCCpG2dfJM3JTchN+SaGTdmJEs2HljTFjfE3lggBF+9eFieoUJk0hU3Z8cjFTXQpQvG7NMtNL3LnK+CLEHq0KsSYRrb4u1F8AAMMV/c19mUzN8oNSZVrSzsR3AhH+EgVqrJ/uBup9hiADA3Ov22BNgmqo5yrQH4/X7H3yyZqJA0VxNs+w2eo1xzohU5PZQJMB1YmYYWrcqfv58Yrpbc3r0lJt9m6lNaLe5hC0gQZVMdo9rsvP4k9Je6i5nyXz4dzFsKOOeYSqbvR+2naGirRUeVfjx8cTSCIvdGRRFttuSRSnqfwVanpPRZegpm2XN07HI7aRjCc5WzTrmre9c5CeuBo/uWIUFOtVqOmZNiaTNjLfMwMu96VAOxw5NYuKKXbaUrMn1Sng0RvcNjg6RtHt6tCs7EBfCcex15J550itq4SyFsMuQ522d8jzVYzc3nbElE5xt/eNURClyq8CoXMX6zzUZ4rqg5mVV4+IeOoOU9RS6lueTFpDWz747udu//TcRmzDn/ZKR9Ma+dBBR8uqWkaaLbE2+xwGFT35RRAFqBRlptjI2Ti0pMN5Y/2QYdc81NhWFOrv/xQ79EVvcK86d8nezMeJUvQJK9ijaFrhyK2q2Vz0drM9krNna/mpB90fkdKDE+10Nbs966/Z6BpIcdip+d2bHY0nbF0Oqm3qte2ql4D5291WHmardNhON9IBzbing0UdS6CTRZ0XNKeLRV1LoJvl3539DDQGPSLq2QK9Iuq9QegTUd8W6Bd5+rumqQecTANLYJBFgxe0YIhFQ0tgmGUS8NHEifeipBZIjkyKOILUiNJaID3yZVSizkpOJvg6DaJFlMxiDVX24lPGGu3NqSS6kNsjibwegfwyda2zgmRdVpisq4sEfbFi+wtKegRKewTKytT7YuXJesxI1mPDk/XYCFvAyB6BUT0Co8vUF2xMsj4bm6zPxiXrs/G2gAk9AhN75JhJMWerory0XmZgzTLhoIZ03juOf31zBDGZcACgAkBOgvwCp0y4vAfMgRC060EFAGZMg8HgEmuM2OCVtoIyEhK2y+lmiZk0NvU8wjPR0DOXna7Bq85myWpCiqgE+nD3SeOyqW+6khZaNxD2EID0XhpLmbSiGsKJ6S4HZoPDWK0m9jxLmA5QdxUKFtPc86D0BOaDbwefh7uJ32Cu3HaPg+nSD/98gmGb6dvZ3U1Bd+/S9fB83Pc+z6u5/GJAgBPQyPTb+TXl6ePgB/3DId0zI4rK3bv/rvRv7465AwFOANzO3XWoq9IGOg7rmrkdPV3ylT8wH9Zd/V2Ouu1YrKEw+u19yQefH+YAje3gQ4W//fnA/rXT5yEfPtz28+zz3PezhS2v9Q2uepkKEF5FYT20p5AfeuT6Fswwy7/KF60wzG1DD1MgaAsxEA2599+7D/MiWgcuyEf1w9B7jwgjQA5qt71fbO/ASOKj8IlK91LSYfg8LzH1z8sSBbWg2AWDhUC4mLCiKGgViWNVNGXBhgUtrRqKSkc2lHTIaPIyqCNbaAosfzVXVuvlDwLiJ6mMdmPacFSAHRNXEJ9Zs7oNEwTaBEnB6txMisOF50W6VMsIEjUNlG++7BJWuBdMvMHN1MvbyGZC/EIIN/1hUsvEylbqnv80zNbZx4hCYkLgvUOwsu3KBKMkNVa9Dga4s7PzfUF8J910NA/rE9K764jVuIlWFr1MtxqdAgZOqEhfj9NGp3oBZGRISyKiUk8qzDqvbSRqgI9EdeGCaxFhrUYidH5NLBFekn7uSz5Cr4iWKqepNiDs2RQROU5OPfEgT22W1ZGoygUQpqNduKmRRH8eRgJ2K1uNG7SlsL/DWcnpcUFmz2pgROYoYbqlBUxnm9RCwJWgVMAhc2FBELf6PjqCUV5J2CCGwSmYUa8Ec9O8kR70sk5ABMNME3AyLooqQquQUjylnSdkIDzaY0e0yO2kc+0xkqfzMl2cMxW6lAEzMhwXfwftqCe4CCIz0scGua+1sMrxdNsLgeluF5JGLIRu8YlZ5la9hj+YuGgDaDc2JvehfNG1yWJGuv6+oIs7qu2sf7chVJI0PN+MhFulrD1BStOyoWWQR3/PLdpBSk+A9HHCmNAU1DKKts5CY39s3FEbMYXHynGe+yG9sWL070lOcQtnWvZWv0PPrXKecp+HjUAzMYSJyWvoJTuSItwqhS1aYMS5yIuTPJJaO7PLZEGOQ0f5l6zEmgAkvXOvmDOjKbjK4DvTwivBwDPUrf5k6Qm2i6AqYmAduEcATppgN2HWagowl85kDFupuwibjPRlzmyGvo5ZLTvIamCCnC+9CdMh+ZkHr/VSwt4U0dxnvsObgJq6KCRJHRe85ayMiUpq6gZCVyyQhYjiLrzkOTu8EZTTwnPP8w7PTeZpYmm0YLxU/X2rGcZgnMbctsm8jAZ1BLaZfpp1ktdkHkwVv5xeQqGmI5XIBKecxgOHewNjzs8sHTpBGGcZzMstTgbgQWZ1cbSY7MpgI+2YglDCE+aj5KoIz00RMqzbaPGGFqBzPSEKqBsO9My9CIFudoIe2Q52JeIUmR1jJQ/BYtNp0Dk1TkdDCAthCStLtl39wgALTJyffNeQmnRa5c7CdIkKRWaVf/KkXjRGQ6lrd5gX6cbC8wpPkDoqdHJoxjN2l5SRyWs38zzxnsmhGD9l4MmwDGvhkoEjqN1H2pl/2qUB7DRYGKOlPT7MhL6DpK1S6KAW8ygypa+o1tO2R2JjoYnFTkKUEZfzFFPs6Owh93EOCUnKGZaE5eeSY6IgDwbXvXnKUi1lVqsZ95vPOeXUubgNYwJKuCJjRzCwBPHQIWJ3Afy4yI/6CyikXGZrbNi5tCyynsXw38avGiSYgc7/SMJMiFdN5jdRjy266HNWskIhwgBgJ+wYbUlK2sFy0lQQwCUkmRuZQRfOOOQ2qYuuKMXQ67DEdBJz7o3ccMUpM9BxHz/tEFNBhSy4G2pEvt90vMBAtotfYm4jhbQH9H9hFtvyBMt/epbwd5sWfYD4dGT3CWrJDAyEHYG+eCvf1QJIS60uo1Ytf3IrRu7atbbRCmG7QjxF+SYD4z6qbuJEa4R8IwjRmHoxhtpm7RxSgWeOhkGWENF8KHBgTdbVAZcmgXRBXwfe7K06jAXG6f0NKAtpUjo2Fs59UZFjZtoZDp+aptvR6th7ADKizQl/2ieb6N9YtCOLE9+8zpjD+SAbmuL4FSz5k62ccHlk6rWPnQi/fgEpYEQaUy1SQ1jAXjKAALItSwbgoTUTCehV/hte26gPEfIO9euL4blRdYdfd/8rYcBMp7qaI7zolzk3/33Gw7iJ7y0vAY/5rj6c3DdLYDCTX+OHU6zm/wzAWMZ20282bjGvkMYbZpvUKis/fJTwQDcdss7lcU6ZnH67bhNoAerbV6erriKFvVhiqMZzEWr1WhcaVXh9iy9IiexGc2ZLfAZ7gwGsnbKAe1dUdumvA9MeXYdyTpVzytKHWvSeHneO1s2eBKFWRnzceyRLsvT110TgbEZvHdKCpcprYdTB2iD5TWD+epQJBw2rxy05TEyr1pjYCWk4UqNH2DydToY2aXkJ/xGRPDaWyIeVYnv7ag/ZQ7cplNtsKxO/N9EOmL45ESKzBBCd+u9zhqHUWRNzc/2oGsraFYhCkcoTqRqSHu3naROBdCFybhjpODFie4cpWKHB69JZ6xYpZnwZC02XJNQoc/Ho071URJOJLOnFgbwxKYaH0PVBXyDV1tvXrsXKtxbFbWK/+s/UEiOfp6fztSUKcKIVHvkSuu7DejuWOa8zm2DznBJj5P1xmX5t9BhzQS8IfIS441Oam9pBMU0azGDQoui7EBwfWOqH4+njIky3TlnUx663AqSKsJHI3z6lQqOB0xKiY5+kL9tymGLkq5Lo2g0Epl/kledeyrWOR+O1upEg9YegUrfJHzOE0OHbrtzGTrwajn50fGwqyFdsNf9u6JMIF+5VWQyx2Y8d1Aw3HV9rGtsQM14+G31v760jmd14Ty/wI/9YBAYgH4n8/tt6mPGbRzJbJmMBPGLmiQhebHwYU8NOQ/+W2UnNjMXghK+BdkP60ZR1vTHXVnn/nixCBwSa2kKS8Gz06qPN+/MKbcx8pjDHcC+uosXExyWaZ6j8t9h2LTq4OmZsjVmHkMJEVFabtnjV1F0Vvw+aAyKgaWu2366BMRALar9HibefZY4ppTXn6BL/pGr1iCWHmaAjfLhyAiKc38zSfLOr17CxzEaPeyp26ua+8jgr3nQ33P/J1NbIez61Yz54rw1jzqfifizUmNyW08wsnzeYuCwehBfWQCwqh82MV9LgF838bcuW4n6v8sY4DqUjeeTL7XWx4QDXyHax97DJafquI0MaygEf4XTyYe0Y3NZFMOj0vI28iM+ZHMDE01smrQWFp1IdxcHGXrmXi3qfL24Hp/k+f19bSspmoT9LFjGdd5FhdgarIXfsOAktdg+x0HFe1LwEvOiRiGanZ7rlh91mVSpv/oE8jvdRcxqaPFXKBP0w0qvN9tetTp0FKb7HNN6KYJ1qZgNiyQ2C14D9NH49YB1dOscl2vV2jaQUL50N1+LKvb//kHK2w1CFw5X2c15LopMxi6G3u5Fh0KbUUaCnIgrRy7eZQhlVoddXrtUXRAyq8x3UBXmvLxqaOWtBz+8YuZ0N5udBe+iaf/ht75n1/z73RNfGrwi//3czmnHUx00vrdP7gkjJpfJq/2KJ+dBV1gafmOWE0RqSm87p4XKJaJD6m9E7OzQNsHnk7n/9PWjsH/79nU1XLy79Qa+s6UOLOrhbzhx6lf92c3DLyIEs4df3EXYdJX6ZRnk074iFkcIELyeO6mF7Xi/bczMfUTri5aVRejoJK4Ee1fdj2LYD0l/ZAT1vysVS0b5Rk/iuARKrKwE9Z4sfF8pmj9TeWJxV7y+jLa2KvTlPonWEcr3G3yxuJBbHU9CWFuj9WWeCphcr84UNZqiDJ1j8gVAWS52vk2W9818p7VWxs9yOWph2fWIAYLkgSFGI9Ioyzc87E1Q9xtYZQDqsvcFbhIRy1ZVMgxdAkTNLckuw1OtrX/6SN+oy5OJ8Z4LzLoNx+rDWqV0fNnF7iLxrHk73H1O6D7gRb/RAZ7zmonLIac11bilTTO2MtycwB2cSEwx6Shr9TXDpP1WtuaVMisZZe/+hguAhf4L4hA4dihujlvRujEcPFUNz2zabEfssa+/s/Eg19yzPnnEjFt5DzwUp9rvtpnueuj3gbpv/m0wEmcmYW5aMqH9CKWQuGMpeaVCFhIiyb+9M43xfw90eyQlzIMQjURNPk8BuiHUuR7kn4nlq2XxqtNr37dyoHinjIdobzAQmYsdV+WsAp33JdG+vTbb9ocJuPy10tiGaX/cqM76LD2u3H69IWfnP9hscVSI5zStcpvqxNn3j6egKu77LhhPXtK+Nbv/WH5UZtpsEXkz09oeZ01Tt3T6RWd2Hi8u3PnhiZOh6nh+k/QpQWEXt6QrXNa602MsDv4vulpQg/2dt7fETXr8qpyBDUUBHUhDlSyJZTkMFb5TftgJw3Waw2UWe9Sm97AkqE5aFG0zuZ0bwbwDGsWI9f1Hv5Xtv7rrrI/Vm6ZDoKffhBeFV0C+gNPSJbVrz7cb9uj3NZrxTmC/srE+PTdd7ahMm97Pk+pcKavqsPeY9PerufDqXP779XTMM6LSCjpcVpxU3BUnETXi4EWWJ4eq6cX3bvE9ts9t16wBljzWXcrFnfWx2j9uJ1gmn7icB+Xsirg3geXiG/YV3X0Dv82lLVzu+6Lr0LxtRWozXTkKE7RPgbXMvaTPTHeep9lw/4LNnsT5hpfQG1OevmvekKjCan7NYiP8OeRt19WQQyPm+PPY/vnTAEwZbe1P9KWZE7yE7H3g1O+/mS+ru2l0FWjroKPBKHWwyNrK33NpVNibzBZGuWL8B+B5Z7H7RAk1sur1Qn4DlMwV4XYV7yEWgvN9Vb1M76fSiq+jXr5szus3T1b9AuKORpOTbxB3/Li/rapth1+2nWAS7BHDBWZ81ho+H6XqDE/eTnvsD/pkU7Mq3P35LOJSz8Ih3qcdPvQWpoEND6heHhdpQyCnyYKKQlErripxs1eHRFKoTlo8byKkGNXyKWf+E+RDgRDxMFEllMGgWHcKx2SgtmW0bKMcSRKKaqKif7r+W13/x3YpkSixpJKURooCV0AsFqJNwvW1F30P0fokHgu9Y/cCVrXfJH8de3JnQOkZFgpJKsuf1Qp7VP0EL+u6l2FXlNGS+aCA4j3/O7/m8G8Wf8TZW8WnUJXHJhxBNfgCaSIdVZsKeY5revbb7MC6qyaBBmSd0RVwn0MJEzyjvWSZHida43rKUyzGhTjDCKkGCVOq66oVhk03zsNf3EHKjBqwaEjqhy1bShOZ+FmSdoqwhWy/PGRSiLAM07klX25rQyCGmPLMo4Z7XNKiJ2ryvQ9m3sbhmmHL2L8qGY93uIPuErMV87zn3ahhTNV2++ireHxOek09HK7bhDLzuLXsAo6IrtbtTCRNi7z53l9vqtDBJcjmIX8/GrdFbkO+zBUr105amGIaAbWWqPDW1iYD4wDRHWRfWFuGmgBxRUb0I2Xh2Qamn8lJl9k1hSxcMQvZDoVBoJABgkWHq5DqZ6x6g1os/68MZNSTxhK6SYwItmaQkZqGSe5sJX6r3tw0WuXAZX5ObMkR0MtZmKPPexEthntuA1oqI7pi0eB++hqkgyiw4Nj8A5CZol+uTX52q8Z6r8ATcOPMF8mrVGdbldCiAQZmm6v18vjl+GBK2kW3J2eUsANCHACAZy1DWP+66sJ0vqVPuE6s3YscLncRbQS/Ux6bOl11Z2k1k0hX18M1i17tp8OxyL20Cqdo3iz/CULET/RmX3sIuIz0cZb/Bdmp5colCs6E6H/lrg6RyETWBVFLJ3tDyS1UvKFNySqOHzwgfGcsDipSI49oAWSgbEWZTxuTaxwlDgmW44Kk7UBoS9YIyx/a8mkRcSXlt96JwfrKw25+bEbfuuJ9DGn1MCYkwh70Jd5rJ93bTzqZKtSyQEjvelylxNbYtR1SkrSPtgsT6F24LsHaX4GkClg+5mhuaCn+roI/1C+epQIkQhAuXa+QFuZBZbnb5HrDM8RzTvyk/DiyThulY1vZuXddqpwq/+Sam8Xavt9oXpzJrW1sw40Jvdarqo6MoOhhHD1jLRW7slXq0PpKc5tYhEs9cpRQ+lygcyX3I9Au8fBelb69zagpL6vSp1Aqc3PnoUCF0wpikJFvFr2n6lhjJG1w99jARF3fWp968a4l9AqkEeX3TeEShutjfQgGMuHzzXnfHxR3SEiYpVlVlwm9ZxoCoSXEmG90bOOXCTrP8b4g3AWfyYUIt6UC3MTfc9fiWKgQKjDVZtY+vtF/B0sOOT3LmbW9WWYcMP8DTqyi9PC/NPnR0zOl+81fvD0VMwRPmSeUw1dPX+KwytuBSCFoQlY7ugYwFTeuzabqkCSuhNxjdz/Q+XI0zyAL84UKnUi1/aAx78UkpSA0ZmlA/QCOwjNKmJLu13L75Qw8vKamaUgGDbHB4xcozc5WavJamXPxoXRjYhcczVbm7p1W+Se1ASguFUFV48hsSaMbikHHjQSl7Glx5Eq56+rbWDhtoz22fyYotofjC7zgPLGjHTl358a/RIHGW4W01iW/EZUCtt/IsaZ9E1gsZmI6GBqEqRodZttjC+4fVDX9qq9Z7Y4QJ8Ykm6Y3WyEngLCkHaKvG4xmZ7cbHYCBQ9HD4E4SPhNbFvWmulFYt0dCtQ//2PSzLTL/hBOh77MMyiCiaGDWN04QurrRMoOBeFuZrrPICmosgTjgqIWWF1Mqob92B1fE/fY8EPuHc/UQEag6KsO9vEFgktUPmtygCuWKQj0xiwBXSldrdCUsTcFlLmQODcsMEVudLvWWqaDqEsDhPaBbONyRJphsoQuUGKRE4uOpGgQNstCgFLr/DdXky4b0oiAnxRfLIFQxhsZbGkImzyWE+ysRDLYcjtQUgGjsVDndJ/7UWkSyFTQxUtTo4pOmuHdhERBPRMtspHuquOA6PCS+M5PuuMnmWPmqQPLUovoFXl6LrNYxmafxWLVXMab9JIXFYp2veg+R8Md0lVo9LaJmQtf2zgggLYy2f0WMsT17SxESz1IYBraZjW9elJuUpd6UWXJPip7coP+YQdurkrKze9m9YcaF3MNXM5HtIloFXAw9GkNQjBoE13fsDsSBlHWBJLFYv7WZ8UZp/0kxWpW5aMOt+M53QPpLj3R4TDc2ixyoRsCZWtvgLy1UOPhYmMHkvdY9oBj3kpnL5GL03I/BCMUQVqqQdLs923HCjRJw+oTwAP5FEuT3cskZpt3b7++GjtBggHwIXCd9vh64+Z11gKhFs7HglhpXWhVGyASUWgghS2Ia8or/Cw3Q/Hau8W9TNqgC6M4m7aP89HKY77v7EXiLCwm16UCyiy+ezWJiwCoYZKiSiWB72o6+5W99eer8e/1ppB3QhZwdXOODwmN65dXe5NgIK18+LTpcy9xdbak/b97T+djbYGn+u4gSTZCr6WV1p/WkORtenrS+mlkl8/f4L40cFjhJcJhoJNX1WjFmpwssu7aaQnxUe93r8jUbWmj+J/sxFDQstAdfHYZXYipna07qVDSsupDpTy2VqFO8EL3OdSq9FcuBaVkZp4dcy7zsgEFVzEjfqARXjl41A5rbjvcSzPlmdNu0uSbaAbF/bLdw4qXAwMsbDDiMXFWVcoOs4rdKRDBPnLsM0Kno9lzdHBqkzSa66nUZ7ftGfKp9zpUKgcquGVZZx5SAFP+Bs1GKbUsS9qUUe28Xq39P2WfFEaFnU8paiLYpFz/liteaAFkcqalCbD/5pwXO+sLoI70++XGWxANv5LvfBSwaT2pObUTwdQCSKQVGcSwhCCKK9g+uBZsOjukwabDShW5HKhNjYWIrG9r91NP4cB80Pju2GybiMKyB69FY5WEWlo0M0h3BFZhjiEBFfuSGsvEASDarVuYo+XLl8ToYMoGNi5k3R+eRkTgY0oFvzWMrLTm37NSlLJgrxnMkSoP3fz+sbLoL/NhqCIvthVaRyqE61xGrnZT4ddwMH66rFoUEeE7pSCyYgpT3k+wF4eBYLPz0Gd/97Wt6szbGgKGisPAA/gN6MCJGyFjPAm7huz/sPSyGJpT+cng5t8x3v+yoKMiaABRKX2MXXSENADCq6GnEy6P6FWctazfXKcThaWStlTJAnWjuQ4Xkck6cFiRF98PQnOdgXVyBVDEq/bmb6QBZizayfKH3ENg16hFjjR2S1qeQDUddsjuNGzEniT38alHW3HG57uNLu2uS7mZyS1l2O7nhCRmVPg2rlYy/NTyuT9yIxZClsWFsZ8T/GDBbu6HXHrgd4ozmjyAO5wlQSdV9WCHSejg4753bf5ksKJ2si8TNOzPWjB3aiBbaETiM+bKMfm9HUf0AXNMNBSWlEWUvRmhLd5rME7xFXbzsI+j4KruHrWc4cC8Wl5CZdUxRxoqEfm59LWGQ7lTQCP/heXdieUrdNre9e2HjR5tkkncXrg44X/Hb+firdAEBfNdAQnhbh1k7ww+u/gxBu0H6SREfVKdpK8M3MlbfhUlqxty5z/UTtDdDC5K0S0/X+BCw4O6tPBLF/mZks2a+UeZd++b986veUx+ms0ZLpBjTcMLXPorNggjkb9xd092Z+idNQovqXtHCrLRch+pEnWENIQA00LCuFDqnZztdrQxcNFbl0hzom0LLBXHRSKaxokUDTYFoKVpZhewLJgxUTB01QmeoNUlvD4WJ/Ah+GhMKpDIoKrp9cfRPuD1F0U6Y9vrn12WDZ3Yo2gcYa02bxAfzddbCSpXIMFFJVPg8lkeqJ+/QNe6YyLQVxWWmb0H43r1sAYUYHQ5DEELGTCW74tMpSExlyU/mrYsOuBNkEcu/C8yas9rdYQRD8A2QCU6bYKJP3S1QmGzJd/f6haso2MUjty0T1VIdAO1JTJDqwZTYRQONg8lkhukH8ZEOZ43p4Q4VFoVgVXGaCDPpicjYRwNWmynSaDObyhPeQKd8gvtbMXz43YIWq18YyglWw+jO7ll5rWu/Q1U3yaT9R/LgO8Aw6UOOnhRssVD5QYA8eDYWT+tB1GHMF66G6XLrslCfET/l0DbVDurRhsF/1b0j8ioUqZXkwgnZuJocra9TTM33Ybgg+fDA2sDGvP/pLAaS9Vr8fd+bN25dhE0z6ZLaYuSgsRCxMB+V2ck4YiVRLt70HwjRh9X6CRJiF+zBbVObWtiRK5JLcwxoxhN1JKbI88O1IoBDXMMfUU9JwH/fz93/8iz97FYGy6GgyjRd518/TJL4vVbAGXFdQJ4q5jqWljKbLTRkH1vV9d/19Fr/w7zPUd/2nmckY4GGxkM8xK5tJp8ynAfqnkyksxwgJZdHZ5A12aN4rvOrgD/yDSY67PSHx18qU0NSpuVrdUdXX1T36GPtrHH8m8dtAsY9HjwF6JfZOvA9bzL/3vjlIxsTKOSlGBUoTrEJxxHoy0ZqSqhMeawpdDKWnDkPbDWWkdqJmbpt7zDnP15jn/G2hPOfjZL3bp9VKecLojCJ20XNKJ2cPpIlLwYshZokCo+IIfL1x/wshRN3OPODGrfd+TRxMclay38Ts364hC+OtKS15uOid4JFHlEjNSYpROV3sQ+DjzNR1KYWAWvlQePChktqU6qEOPoSJYFl/HBbxeQERPlqDzzHQD8hNluSTdIsZ4hKuYSO8TGAjSh71pIrwB9lfm+WHcODeVnIT8UnyA3zZcom2+t5gVBla+nBJ5hPxcYaPxyp/FuUKkxDLRPRXN4c3Rv7pWcVKLdtFTrpoBHOKBpWUf8wcxmBZ84VJeOzF1IJR54kyU/SVS2sbiWgJsM6uOvE4PvE+GLQqItaDCZc5RpcljUqgfFJW/aWKXCe0lMihm0J5ApKkQMzKtBzeUra0ePJE4O8kyb9uJIir8JjTKbW3ndMuOzi9zWOF5AYi3Bfz6TEqzuFxxdS7W5SOBJZVbdWc/kvyCklEAhpUIE2XDirOWc6r2jbLTxGjEX+3kmKaef2xgx+hgpypnBkhRSfaOyIDkoTAVDTKjIEMyyUTlt92QTmBNSbdEJ01KNWC9Rb9xwJBhjyc0c4TFUYZOkttsYhfyl7xAIzAehGzVAon7yF4NnSiY7Jou4wvJV+mNwmi++sQIwt7Pn4ohChHQ8/koj4eeCUqTGMTD51r1F8nQCQoB6N7XJqSeUK3qGDC5H5MiBmPp3jhUfR5dwS2oA72tQCV3JpXv8k9Gc7FWrBQjIhAKlcQl6ZxntClQjFhal9mKMk8EnImcnu3ZlDJ5ded45jVGSvi3mbj+JK+tVLBMWapF46VoILya1prlqkvYULeZuNY8n3z0h1ZRAksGA3msBYRggkgr1lx2vqCxTAvjrcaEdMvRWKI1Vsqb6g7vdJgzlZDObFbvOiyQEkgv1COTc7I9Ju8obyVY9VQJQjaBw0M4nF5QH5YkZUySx6qEpWgsR9sZV2oDRF90k/Uoz0k8gldvkNOSsoMJ4y9Oe7XLjXqL3cwxe9fKcsNdQ7/CPPHgD/8Wcz70x/NloEvpeliD+vxWze2UlbLHW45E0dh28io+kBDYDRvpiN69/td/J3C7n89+Cj24RXgFWOilczVhgjKyfMAnTbv09u2EOFtw5zNrVVth65P5gqCxJKQPkPgIeL9AyCJNdY1v4p2GHk5+ECCufWWPdpNvF8rQ8n4A5WL3Po3yfajan01YXdCfLvhvY09dq7LMhy/PJ15XdZfokeHtG82uxr/XPORDlcF/qJrV0yvyETh1vO+HiT5ASNOxKjhZhoyomS4t1jtB4p/oQm1jSy/FE5/pXFcO226yj2bPlQbRF/xjIXgEscqGriNLBTz+aW5grCiWmfYcM0TulmpTZi6EGPmqjT1fPsmtHoYKGJlMMShGmgBURNtzoGQo9F7ZNiwrBO6SxUT2n+Zx1vHi273AoPHJoWLPs/j6kAKIwuirm7DAPzJxkpi2ZlhPJDFcTsAvae3r2qX6lQRrT1lwYjB/49A4wx41jAjj2Gy0bmZHwxWQbyp3o9xUXnbZ0B0pPT6HyWlQuwpHLHRl9Z3xAvvaL3HwMFxD3R+vD+Pa+zVv87aO5dZpFr+Q/rD4+PTPsvT02U4asYRInA9Op/ZYhYnfy8v//p5gf7vu5vwy5sElaSfK/iRROOZNGkmubuW3Nk4L+fMgoCNMpwHmULdIl0IxxS80GqyTRqL1uViHdo/mk+Iwk0s7hZAf8cviF6QV7c7ZIIsRxOaplzMqRKrz+7Fw5CXXRy5HIo8vvDLFRM3gjo+JwdW9TU53VBVa+/mEhPvPQfdQO0oV/bIPOFiy5eev4klKkUnPETjFktOACe4qrSZOaTKpYIqkq8rX0A0Aa7yHBylwEKgSM37H2uA5iomLcaBHOtoA93oUxDACUUQHyRL7rvS5M0oNGzQVo4fFNVcO65ypUqzsNxS6nIqiBDmwMPf4I88atrCoetsufjAlyRg14VUGR9pA61a7RyS6/y2dz3ziw+VWay6tT6h5Opk71n+oiOfNnENUnVZlf6MdQO1Y9cWjNM0XmMcp2+YxulomonE0umyRLLE9qqYGTNVEkYiVJYulgL/lyYPpzktXli3e87Hf+agB1Pa2y1YhVDaqRzjWqtrnBgVlLZQwsbJDADmkClFbL6V99u74BlKTm5CRtov6hPLfg0BEoURHoVrRkD2yULg1lzOPt8catquryb2zylTqKrzz9QbFmT/q7MuuF9ryrWspCgBmBGvU6jKgB5h8rFoOPXDpfYKEg3FZwQU0FkUFEOUDXWug4wjgRhl/HoDLp2z5vE9W3lzrQZ2Sm2ketWUlNJDyAZUVDqS5NMoeiQTO4a8GmJCad229ihvKcA99hMKHwKo4Dzh6JSBpXq3VNWXAHfDtf85+UDh/+y/9z+JgdQvtUCBqgCMUnaIIBCzhvbAIJ0pzFzjJsA2DSNtTY1T0zWv2hOOYdomlq0bzu9GhIoZXCPx2zEEgxkBuNNQMzoN20lDVqYcHawLG35LUaSIASm6aAP89TEYBKigFltCWKDQSGdTgIN2vxEEsCSRimhW4LFY5xsFX95vVLCnYqNKA6s3asQo3GiGN/02mhOhWs6eH4Fk+eKl2eqIPzzPULlS9Fy+2xCHvF+ddHHIkitJvI5ooZ1OciXIk6erfIPlyldFJ7G6SJCkQLpyrIcEubYulCWTjqriUKkRKDv1TOvFVvSg8V81dTXVWxfNUReLCcZ339pUlmwlYagnSVbzTxWp6OjWYAmxLXGt1iypEgwtK41RYHRyGNGwEmGo1jpMiUZKg8MSarXElRfKFymGjiIpxjwgOi+YuUI3NoyOFhd0MdbBYBnYzjyocIIYpoJpnx5Z+91RAaKgoBLiEhcYYhtDbWcmoQgzTDheESHBRS5zhUhRosW4yjWuc4NYcYiPqAHLJYZb3+QWSe4wix3spKp3H0hyqZpqucs9kt3/7JPj63lDfTST8kEnudQwlmElzX1tbek1rWSH7/dQjtZoo612HpCvUJEC7XXQkWh00lmxLkqUKVdqFYZddPWebrqjh0n01MtwIxnFCD4k5RfWz1sO099JTrGM5bjgitvHqvAPPfk/XMzEXCzEkqN85RvfsdPQGSbghwNb0FiDOU4EYTVmWPPHmSYGGKSBRmywZQ+7cRQrm9jMcU5wjr3sYz8HOCvWxnIMC7FhHPPFFns+chAdgQKYw2BrxY6l2IsDwaxMZDxTmMxUxjDQSxoTR6bxnIdMp6nHPOOR1mG4vU3bzb7F0x8nbQqWr7YWBy25p2xV9mwvNqpwcWUo/CL9j1dTp3q5VOuVtV9v8PbzB30b9vDjdai6eXkg0PbBxS6Te5HpvQ/ynzdYf/0/Fk2u6YNukhIFXbLazbB9uey0VbFs+Xovkp2TtZNByrVsmnx6jHQaaTPSHDSsAA5FTjZInF+l2TEkMrHzxGm066XCMCvskL8sRyJarg4dnHfNTW93yRunW3sqp30sNNuoh5jG7dSm7VJGjjybDUvSrAkAAAA=') format('woff2');
      }
    ]]></style>
    <filter id="soft-shadow" x="-20%" y="-20%" width="140%" height="140%">
      <feDropShadow dx="0" dy="3" stdDeviation="3" flood-color="#000000" flood-opacity="0.35" />
    </filter>
  </defs>
  <g transform="translate(0, ${baselineOffset}) scale(${scale})">
    ${digitsSvg}
  </g>
</svg>
`;
}

app.get('/debug-redis', async (req, res) => {
  const debug = {
    hasRedisPackage: !!Redis,
    useRedis: useRedis,
    redisClient: !!redisClient,
    envVars: {
      KV_REST_API_URL: process.env.KV_REST_API_URL ? 'Set (length: ' + process.env.KV_REST_API_URL.length + ')' : 'Not set',
      KV_REST_API_TOKEN: process.env.KV_REST_API_TOKEN ? 'Set (length: ' + process.env.KV_REST_API_TOKEN.length + ')' : 'Not set',
      UPSTASH_REDIS_REST_URL: process.env.UPSTASH_REDIS_REST_URL ? 'Set' : 'Not set',
      UPSTASH_REDIS_REST_TOKEN: process.env.UPSTASH_REDIS_REST_TOKEN ? 'Set' : 'Not set',
      REDIS_URL: process.env.REDIS_URL ? 'Set (type: ' + (process.env.REDIS_URL.startsWith('https://') ? 'rest-api' : 'standard') + ')' : 'Not set',
    },
    testResult: null,
    error: null
  };

  if (redisClient) {
    try {
      await redisClient.set('__test__', 'ok');
      const result = await redisClient.get('__test__');
      debug.testResult = result === 'ok' ? 'Success' : 'Failed (wrong value)';
    } catch (err) {
      debug.testResult = 'Failed';
      debug.error = err.message;
    }
  }

  res.json(debug);
});

app.get('/health', async (req, res) => {
  const health = {
    status: 'ok',
    storage: 'file',
    redis: {
      configured: false,
      connected: false,
      error: null,
      envVars: {
        hasRedisPackage: !!Redis,
        hasUpstashRedisRestUrl: !!process.env.UPSTASH_REDIS_REST_URL,
        hasUpstashRedisRestToken: !!process.env.UPSTASH_REDIS_REST_TOKEN,
        hasKvRestApiUrl: !!process.env.KV_REST_API_URL,
        hasKvRestApiToken: !!process.env.KV_REST_API_TOKEN,
        hasRedisUrl: !!process.env.REDIS_URL,
        redisUrlType: process.env.REDIS_URL ? (process.env.REDIS_URL.startsWith('https://') ? 'rest-api' : 'standard') : null
      }
    }
  };

  if (useRedis && redisClient) {
    health.storage = 'redis';
    health.redis.configured = true;
    
    try {
      await redisClient.get('__health_check__');
      health.redis.connected = true;
    } catch (err) {
      health.redis.connected = false;
      health.redis.error = err.message;
      health.status = 'degraded';
    }
  }

  res.json(health);
});

app.get('/', (req, res) => {
  const runtimeBaseUrl = process.env.VERCEL_URL
    ? `https://${process.env.VERCEL_URL}`
    : `${req.protocol}://${req.get('host')}`;

  const baseUrl = 'https://southpark-view-counter.vercel.app';
  const exampleUrl = `${baseUrl}/@demo?theme=southpark&padding=7&darkmode=auto&inc=0&num=1234567`;

  res.type('text/html').send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>South Park Profile Counter</title>
  <style>
    * {
      box-sizing: border-box;
    }
    body {
      margin: 0;
      padding: 24px 16px;
      font-family: "Comic Sans MS", "Comic Sans", cursive, sans-serif;
      background-image: url('/assets/southpark.jpg');
      background-size: cover;
      background-position: top;
      background-attachment: fixed;
      min-height: 100vh;
      display: flex;
      justify-content: center;
      align-items: flex-start;
    }
    ::-webkit-scrollbar {
      width: 16px;
    }
    ::-webkit-scrollbar-track {
      background: #fff;
      border-left: 2px solid #000;
    }
    ::-webkit-scrollbar-thumb {
      background: #4caf50;
      border: 2px solid #000;
      border-radius: 0;
    }
    ::-webkit-scrollbar-thumb:hover {
      background: #45a049;
    }
    html {
      scrollbar-width: thick;
      scrollbar-color: #4caf50 #fff;
    }
    main {
      max-width: 700px;
      width: 100%;
      background: #fff;
      border-radius: 12px;
      padding: 24px;
      border: 4px solid #000;
      box-shadow: 8px 8px 0 #000;
      margin-top: 20px;
    }
    h1 {
      margin: 0 0 8px;
      font-size: 1.6rem;
      color: #000;
      text-transform: uppercase;
    }
    h2 {
      margin: 20px 0 8px;
      font-size: 1.1rem;
      color: #000;
    }
    p {
      margin: 6px 0;
      line-height: 1.4;
      color: #333;
      font-size: 0.95rem;
    }
    code {
      font-family: "Courier New", monospace;
      font-size: 0.85rem;
      background: #ffeb3b;
      color: #000;
      padding: 2px 6px;
      border-radius: 3px;
      border: 1px solid #000;
    }
    pre {
      margin: 8px 0;
      padding: 10px;
      background: #e3f2fd;
      border: 2px solid #000;
      border-radius: 6px;
      overflow-x: auto;
      font-size: 0.85rem;
    }
    pre code {
      background: transparent;
      border: none;
      padding: 0;
    }
    .example-image {
      margin: 12px 0;
      padding: 8px;
      background: #fff;
      border: 2px solid #000;
      border-radius: 6px;
      display: inline-block;
    }
    .example-image img {
      display: block;
      max-width: 100%;
      height: auto;
    }
    .char-order {
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
      margin: 12px 0;
      padding: 12px;
      background: #f5f5f5;
      border: 2px solid #000;
      border-radius: 6px;
    }
    .char-item {
      width: 60px;
      height: 60px;
      cursor: grab;
      border: 2px solid #000;
      border-radius: 4px;
      background: #fff;
      display: flex;
      align-items: center;
      justify-content: center;
      transition: transform 0.15s ease, box-shadow 0.15s ease, border-color 0.15s ease;
      position: relative;
      user-select: none;
    }
    .char-item:hover {
      transform: translateY(-2px);
      box-shadow: 0 4px 8px rgba(0,0,0,0.3);
    }
    .char-item:active {
      cursor: grabbing;
    }
    .char-item.dragging {
      opacity: 0.8;
      transform: scale(1.15) rotate(2deg);
      box-shadow: 0 8px 16px rgba(0,0,0,0.5);
      border-color: #4caf50;
      z-index: 1000;
      cursor: grabbing;
    }
    .char-item.drag-over {
      border-color: #4caf50;
      background: #e8f5e9;
    }
    .char-item img {
      width: 100%;
      height: 100%;
      object-fit: contain;
      pointer-events: none;
    }
    .builder {
      margin-top: 12px;
      padding: 16px;
      background: #fff3cd;
      border: 2px solid #000;
      border-radius: 6px;
    }
    .builder-row {
      display: flex;
      flex-wrap: wrap;
      gap: 10px;
      margin-bottom: 12px;
    }
    .builder-field {
      flex: 1 1 140px;
      min-width: 140px;
    }
    .builder-field label {
      display: block;
      font-size: 0.75rem;
      font-weight: bold;
      margin-bottom: 4px;
      color: #000;
    }
    .builder-field input,
    .builder-field select {
      width: 100%;
      padding: 6px 8px;
      font-size: 0.9rem;
      border: 2px solid #000;
      border-radius: 4px;
      background: #fff;
      color: #000;
      font-family: inherit;
    }
    .builder button {
      border: 3px solid #000;
      border-radius: 6px;
      padding: 10px 20px;
      font-size: 0.95rem;
      font-weight: bold;
      cursor: pointer;
      background: #4caf50;
      color: #000;
      font-family: inherit;
      text-transform: uppercase;
      transition: transform 0.1s;
      box-shadow: 3px 3px 0 #000;
    }
    .builder button:hover {
      transform: translate(-2px, -2px);
      box-shadow: 5px 5px 0 #000;
    }
    .builder button:active {
      transform: translate(0, 0);
      box-shadow: 2px 2px 0 #000;
    }
    .builder-output {
      margin-top: 12px;
      padding-top: 12px;
      border-top: 2px dashed #000;
    }
    .builder-output-row {
      margin-bottom: 10px;
    }
    .builder-output-row span {
      display: block;
      font-size: 0.85rem;
      font-weight: bold;
      margin-bottom: 4px;
      color: #000;
    }
    .builder-output-row code {
      display: block;
      white-space: nowrap;
      overflow-x: auto;
      padding: 6px;
      margin-top: 4px;
    }
    .builder-preview {
      margin-top: 12px;
      padding: 8px;
      background: #fff;
      border: 2px solid #000;
      border-radius: 6px;
    }
    .builder-preview img {
      max-width: 100%;
      height: auto;
      display: block;
    }
    .small-note {
      font-size: 0.8rem;
      color: #666;
      font-style: italic;
    }
    .github-link {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      padding: 10px 16px;
      background: #fff;
      color: #000;
      text-decoration: none;
      border-radius: 6px;
      font-size: 0.9rem;
      font-weight: bold;
      border: 2px solid #000;
      transition: transform 0.1s, box-shadow 0.1s, background 0.1s;
      margin-top: 12px;
      box-shadow: 2px 2px 0 #000;
    }
    .github-link:hover {
      transform: translate(-2px, -2px);
      box-shadow: 4px 4px 0 #000;
      background: #ffeb3b;
    }
    .github-link:active {
      transform: translate(0, 0);
      box-shadow: 2px 2px 0 #000;
    }
    .github-link svg {
      width: 18px;
      height: 18px;
    }
    .star-badge {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 6px 12px;
      background: #ffeb3b;
      color: #000;
      border: 2px solid #000;
      border-radius: 6px;
      font-size: 0.85rem;
      font-weight: bold;
      margin-left: 12px;
      text-decoration: none;
      transition: transform 0.1s, box-shadow 0.1s;
    }
    .star-badge:hover {
      transform: translate(-1px, -1px);
      box-shadow: 2px 2px 0 #000;
    }
    .copy-btn {
      display: inline-block;
      padding: 4px 10px;
      margin-left: 8px;
      background: #2196f3;
      color: #fff;
      border: 2px solid #000;
      border-radius: 4px;
      font-size: 0.75rem;
      font-weight: bold;
      cursor: pointer;
      font-family: inherit;
      transition: transform 0.1s, box-shadow 0.1s;
    }
    .copy-btn:hover {
      transform: translate(-1px, -1px);
      box-shadow: 2px 2px 0 #000;
    }
    .copy-btn:active {
      transform: translate(0, 0);
      box-shadow: 1px 1px 0 #000;
    }
    .copy-btn.copied {
      background: #4caf50;
    }
    footer {
      margin-top: 32px;
      padding-top: 20px;
      border-top: 2px solid #000;
      text-align: center;
    }
    footer p {
      margin: 8px 0;
      font-size: 0.85rem;
    }
    .footer-links {
      display: flex;
      justify-content: center;
      align-items: center;
      gap: 16px;
      flex-wrap: wrap;
      margin-top: 12px;
    }
    .footer-links a {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      color: #000;
      text-decoration: none;
      font-weight: bold;
      font-size: 0.9rem;
      padding: 6px 12px;
      border-radius: 4px;
      transition: background 0.2s;
      border: 2px solid #000;
    }
    .footer-links a:hover {
      background: #ffeb3b;
    }
    .footer-links svg {
      width: 16px;
      height: 16px;
    }
    .trademark {
      margin-top: 16px;
      padding-top: 12px;
      border-top: 1px dashed #000;
      font-size: 0.75rem;
      color: #666;
    }
    .trademark strong {
      color: #000;
    }
  </style>
</head>
<body>
  <main>
    <header>
      <h1>South Park View Counter</h1>
      <p>Track your profile views with South Park characters!</p>
      <div style="display: flex; align-items: left; justify-content: left; flex-wrap: wrap; gap: 8px; margin-top: 12px;">
        <a href="https://github.com/masonliiu/southpark-view-counter" target="_blank" rel="noopener noreferrer" class="github-link">
          <svg viewBox="0 0 24 24" fill="currentColor">
            <path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z"/>
          </svg>
          View Source Code
        </a>
      </div>
    </header>

    <section>
      <h2>How to use</h2>
      <p>Change <code>demo</code> to a unique id and add this to your README:</p>
      <pre><code>![profile-views](${exampleUrl})</code></pre>
      <div class="example-image">
        <img src="${exampleUrl}" alt="South Park profile counter example" />
      </div>
    </section>

    <section>
      <h2>Create Your Counter</h2>
      <div class="builder">
        <div class="builder-row">
          <div class="builder-field">
            <label for="b-name">Name</label>
            <input id="b-name" type="text" placeholder="your-github-username" value="your-github-username" />
          </div>
          <div class="builder-field">
            <label for="b-padding">Digits</label>
            <input id="b-padding" type="number" min="1" max="16" value="7" />
          </div>
          <div class="builder-field">
            <label for="b-darkmode">Dark Mode</label>
            <select id="b-darkmode">
              <option value="auto" selected>Auto</option>
              <option value="1">Dark</option>
              <option value="0">Light</option>
            </select>
          </div>
          <div class="builder-field">
            <label for="b-prefix">Prefix (optional)</label>
            <input id="b-prefix" type="text" placeholder="SP-" />
          </div>
        </div>
        <div style="margin: 16px 0;">
          <p style="margin: 0 0 8px; font-weight: bold; font-size: 0.9rem;">Customization</p>
          <p style="margin: 0 0 8px; font-size: 0.85rem;">Drag to reorder. Characters save from the left side.</p>
          <div id="char-order" class="char-order">
            <div class="char-item" draggable="true" data-key="stan">
              <img src="/assets/stan.png" alt="Stan" />
            </div>
            <div class="char-item" draggable="true" data-key="kyle">
              <img src="/assets/kyle.png" alt="Kyle" />
            </div>
            <div class="char-item" draggable="true" data-key="mr-mackey">
              <img src="/assets/mr mackey.png" alt="Mr. Mackey" />
            </div>
            <div class="char-item" draggable="true" data-key="kenny">
              <img src="/assets/kenny.png" alt="Kenny" />
            </div>
            <div class="char-item" draggable="true" data-key="cartman">
              <img src="/assets/cartman.png" alt="Cartman" />
            </div>
            <div class="char-item" draggable="true" data-key="timmy">
              <img src="/assets/timmy.png" alt="Timmy" />
            </div>
            <div class="char-item" draggable="true" data-key="wendy">
              <img src="/assets/wendy.png" alt="Wendy" />
            </div>
          </div>
        </div>
        <input id="b-order" type="hidden" value="stan,kyle,mr-mackey,kenny,cartman,timmy,wendy" />
        <button type="button" id="b-generate">Generate</button>
        <div class="builder-output">
          <div class="builder-output-row">
            <span>URL:</span>
            <div style="display: flex; align-items: center; gap: 4px;">
              <code id="b-url" style="flex: 1;">${exampleUrl}</code>
              <button type="button" class="copy-btn" onclick="copyUrl(this)">Copy</button>
            </div>
          </div>
          <div class="builder-output-row">
            <span>Copy & Paste to your README:</span>
            <div style="display: flex; align-items: center; gap: 4px;">
              <code id="b-md" style="flex: 1;">![profile-views](${exampleUrl})</code>
              <button type="button" class="copy-btn" onclick="copyMarkdown(this)">Copy</button>
            </div>
          </div>
          <div class="builder-preview">
            <span>Preview:</span>
            <img id="b-preview" src="${exampleUrl}" alt="Preview" />
          </div>
        </div>
      </div>
    </section>

    <footer>
      <p><strong>Made with ❤️ and original artwork</strong></p>
      <div class="footer-links">
        <a href="https://github.com/masonliiu/southpark-view-counter" target="_blank" rel="noopener noreferrer">
          <svg viewBox="0 0 24 24" fill="currentColor">
            <path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z"/>
          </svg>
          Source code
        </a>
        <a href="https://github.com/masonliiu/southpark-view-counter/stargazers" target="_blank" rel="noopener noreferrer">
          <svg viewBox="0 0 24 24" fill="currentColor">
            <path d="M12 .587l3.668 7.431 8.2 1.191-5.934 5.785 1.401 8.168L12 18.897l-7.335 3.856 1.401-8.168L.132 9.209l8.2-1.191L12 .587z"/>
          </svg>
          Star on GitHub
        </a>
      </div>
      <div class="trademark">
        <p><strong>South Park</strong> is a trademark of Comedy Partners. This project is not affiliated with, endorsed by, or associated with Comedy Partners or South Park Digital Studios.</p>
        <p style="margin-top: 8px;">© 2025 South Park View Counter. MIT License.</p>
      </div>
    </footer>
  </main>
  <script>
    (function () {
      var baseUrl = ${JSON.stringify(baseUrl)};
      var btn = document.getElementById('b-generate');
      if (!btn) return;

      function buildUrl(forPreview) {
        var name = (document.getElementById('b-name').value || '').trim() || 'your-github-username';
        var padding = parseInt(document.getElementById('b-padding').value, 10);
        if (!Number.isFinite(padding) || padding < 1 || padding > 16) padding = 7;
        var darkmode = document.getElementById('b-darkmode').value || 'auto';
        var prefix = document.getElementById('b-prefix').value || '';
        var order = (document.getElementById('b-order').value || '').trim();

        var params = new URLSearchParams();
        params.set('theme', 'southpark');
        params.set('padding', String(padding));
        params.set('darkmode', darkmode);
        if (prefix) params.set('prefix', prefix);
        if (order) params.set('order', order);
        
        if (forPreview) {
          params.set('inc', '0');
          var previewNum = '';
          for (var i = 1; i <= padding; i++) {
            previewNum += String(i % 10);
          }
          params.set('num', previewNum);
        }

        var url = baseUrl + '/@' + encodeURIComponent(name) + '?' + params.toString();
        return url;
      }

      function update() {
        var url = buildUrl(false);
        var previewUrl = buildUrl(true);
        var md = '![profile-views](' + url + ')';
        var urlEl = document.getElementById('b-url');
        var mdEl = document.getElementById('b-md');
        var imgEl = document.getElementById('b-preview');
        if (urlEl) urlEl.textContent = url;
        if (mdEl) mdEl.textContent = md;
        if (imgEl) imgEl.src = previewUrl;
      }

      window.copyUrl = function(btn) {
        var urlEl = document.getElementById('b-url');
        if (!urlEl) return;
        var text = urlEl.textContent || urlEl.innerText;
        navigator.clipboard.writeText(text).then(function() {
          if (btn) {
            var originalText = btn.textContent;
            btn.textContent = 'Copied!';
            btn.classList.add('copied');
            setTimeout(function() {
              btn.textContent = originalText;
              btn.classList.remove('copied');
            }, 2000);
          }
        }).catch(function(err) {
          console.error('Failed to copy:', err);
        });
      };

      window.copyMarkdown = function(btn) {
        var mdEl = document.getElementById('b-md');
        if (!mdEl) return;
        var text = mdEl.textContent || mdEl.innerText;
        navigator.clipboard.writeText(text).then(function() {
          if (btn) {
            var originalText = btn.textContent;
            btn.textContent = 'Copied!';
            btn.classList.add('copied');
            setTimeout(function() {
              btn.textContent = originalText;
              btn.classList.remove('copied');
            }, 2000);
          }
        }).catch(function(err) {
          console.error('Failed to copy:', err);
        });
      };

      btn.addEventListener('click', update);
      
      var paddingInput = document.getElementById('b-padding');
      if (paddingInput) {
        paddingInput.addEventListener('input', function() {
          if (document.getElementById('b-preview').src) {
            update();
          }
        });
      }

      var orderContainer = document.getElementById('char-order');
      if (orderContainer) {
        var dragEl = null;
        var dragOverEl = null;
        
        var emptyImg = document.createElement('img');
        emptyImg.src = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
        
        orderContainer.addEventListener('dragstart', function (e) {
          var target = e.target.closest('.char-item');
          if (!target) return;
          dragEl = target;
          target.classList.add('dragging');
          e.dataTransfer.effectAllowed = 'move';
          e.dataTransfer.setDragImage(emptyImg, 0, 0);
        });
        
        orderContainer.addEventListener('dragover', function (e) {
          if (!dragEl) return;
          e.preventDefault();
          e.dataTransfer.dropEffect = 'move';
          
          var target = e.target.closest('.char-item');
          if (!target || target === dragEl) {
            if (dragOverEl && dragOverEl !== dragEl) {
              dragOverEl.classList.remove('drag-over');
            }
            dragOverEl = null;
            return;
          }
          
          if (dragOverEl && dragOverEl !== target && dragOverEl !== dragEl) {
            dragOverEl.classList.remove('drag-over');
          }
          
          if (target !== dragEl) {
            target.classList.add('drag-over');
            dragOverEl = target;
          }
          
          var rect = target.getBoundingClientRect();
          var before = (e.clientX - rect.left) / rect.width < 0.5;
          if (before) {
            orderContainer.insertBefore(dragEl, target);
          } else {
            orderContainer.insertBefore(dragEl, target.nextSibling);
          }
        });
        
        orderContainer.addEventListener('dragleave', function (e) {
          var target = e.target.closest('.char-item');
          if (target && target !== dragEl) {
            target.classList.remove('drag-over');
          }
        });
        
        orderContainer.addEventListener('dragend', function () {
          if (dragEl) dragEl.classList.remove('dragging');
          var allItems = orderContainer.querySelectorAll('.char-item');
          allItems.forEach(function (el) {
            el.classList.remove('drag-over');
          });
          dragEl = null;
          dragOverEl = null;
          
          var items = orderContainer.querySelectorAll('.char-item');
          var keys = [];
          items.forEach(function (el) {
            var key = el.getAttribute('data-key');
            if (key) keys.push(key);
          });
          var hiddenOrder = document.getElementById('b-order');
          if (hiddenOrder) hiddenOrder.value = keys.join(',');
        });
      }
    })();
  </script>
</body>
</html>`);
});

app.get('/@:name', async (req, res) => {
  const name = req.params.name;
  if (!name || typeof name !== 'string' || name.length > 128) {
    return res.status(400).type('text/plain').send('Invalid name');
  }

  const userAgent = req.get('user-agent') || '';
  const isGitHub = userAgent.includes('github-camo') || 
                   req.get('referer')?.includes('github.com') ||
                   req.get('x-forwarded-for')?.includes('github');
  
  if (isGitHub) {
    console.log('Request detected from GitHub, using optimized settings');
  }

  let parsed;
  try {
    parsed = querySchema.parse(req.query);
  } catch (err) {
    return res.status(400).type('text/plain').send('Invalid query params');
  }

  const { num, prefix, inc, padding, offset, scale, align, darkmode, pixelated, order } =
    parsed;

  let value;
  if (num && num > 0) {
    value = num;
  } else {
    value = inc === 1 ? await getAndIncrementCounter(name) : await peekCounter(name);
  }

  const customOrder = parseOrder(order);
  const imagesToLoad = customOrder && customOrder.length
    ? customOrder
    : [
        '/assets/stan.png',
        '/assets/kyle.png',
        '/assets/mr mackey.png',
        '/assets/kenny.png',
        '/assets/cartman.png',
        '/assets/timmy.png',
        '/assets/wendy.png',
      ];
  
  for (const imgPath of imagesToLoad) {
    if (!imageDataUriCache.has(imgPath)) {
      try {
        await imageToDataUri(imgPath);
      } catch (err) {
        console.error(`Failed to load ${imgPath}:`, err);
      }
    }
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
    characterOrder: imagesToLoad,
  });

  res.setHeader('Content-Type', 'image/svg+xml; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('X-Content-Type-Options', 'nosniff');

  const svgSize = Buffer.byteLength(svg, 'utf8') / 1024;
  console.log(`SVG size: ${svgSize.toFixed(2)}KB`);

  return res.send(svg);
});

app.use((req, res) => {
  res.status(404).type('text/plain').send('Not found');
});

const characterImages = [
  '/assets/stan.png',
  '/assets/kyle.png',    
  '/assets/mr mackey.png',
  '/assets/kenny.png',
  '/assets/cartman.png',
  '/assets/timmy.png',
  '/assets/wendy.png',
];

async function preloadImages() {
  console.log('Pre-loading and compressing images...');
  for (const imgPath of characterImages) {
    try {
      await imageToDataUri(imgPath);
      const cached = imageDataUriCache.get(imgPath);
      const sizeKB = cached ? (cached.length * 3 / 4 / 1024).toFixed(0) : 0;
      console.log(`Loaded ${imgPath}: ${sizeKB}KB`);
    } catch (err) {
      console.error(`Failed to pre-load ${imgPath}:`, err);
    }
  }
  const totalSize = Array.from(imageDataUriCache.values())
    .reduce((sum, uri) => sum + (uri.length * 3 / 4), 0) / 1024 / 1024;
  console.log(`All images loaded. Total size: ${totalSize.toFixed(2)}MB`);
}

preloadImages().catch(console.error);

module.exports = app;

if (process.env.VERCEL !== '1') {
  app.listen(PORT, () => {
    console.log(`South Park counter listening on http://localhost:${PORT}`);
  });
}

