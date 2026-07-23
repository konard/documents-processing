// ocr-lib.mjs — shared OCR toolkit for the document-verification scripts.
//
// One reusable library used by ocr-passports / ocr-cforms / ocr-entries and the
// tests/ experiments. Capabilities:
//
//   IMAGE I/O
//     renderImage(file)          -> canvas Image (jpg/png direct; pdf -> largest
//                                   embedded image extracted)
//     regionCanvas(img, box)     -> a canvas for a proportional sub-region
//   GEOMETRY
//     box(x,y,w,h,{rotate,scale})-> a region descriptor (fractions 0..1)
//     jitter(box, px, imgW, imgH)-> variants nudged by ±px (TL/center/BR) for
//                                   multi-offset consensus
//   PREPROCESSING (all operate on a canvas, return a new canvas)
//     grayscale, binarize (fixed/otsu), dropChannel ('r'|'g'|'b'),
//     contrast(gamma), blur(radius), vignetteBlur (sharp center, soft edges),
//     rotate(deg)
//   OCR
//     ocrCanvas(canvas,{whitelist,psm}) -> text
//     ocrData(canvas,{...})             -> word boxes via TSV (x,y,w,h,conf,text)
//     rowsFromWords(words)              -> words grouped into visual rows
//     readFieldConsensus(img, box, opts)-> {value, agree, candidates} using the
//                                   offset ×(preprocess) ladder; value wins when
//                                   >=2 variants agree.
//   MRZ
//     parseMrzLine1 / parseMrzLine2 (+ check digits)
//
// Also requires the `tesseract` CLI on PATH for the OCR steps.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import { loadImage, createCanvas } from '@napi-rs/canvas';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';

// ===========================================================================
// IMAGE I/O
// ===========================================================================

export async function renderImage(file) {
  const ext = path.extname(file).toLowerCase();
  if (ext !== '.pdf') {
    return await loadImage(file);
  }

  const data = new Uint8Array(fs.readFileSync(file));
  const doc = await pdfjs.getDocument({ data }).promise;
  const page = await doc.getPage(1);
  const ops = await page.getOperatorList();
  let best = null;
  for (let i = 0; i < ops.fnArray.length; i++) {
    const fn = ops.fnArray[i];
    if (
      fn === pdfjs.OPS.paintImageXObject ||
      fn === pdfjs.OPS.paintJpegXObject
    ) {
      const name = ops.argsArray[i][0];
      await new Promise((res) => {
        try {
          page.objs.get(name, (o) => {
            if (o?.width) {
              const a = o.width * o.height;
              if (!best || a > best.area) {
                best = { o, area: a };
              }
            }
            res();
          });
        } catch {
          res();
        }
      });
    }
  }
  if (!best) {
    throw new Error(`no embedded image in ${file}`);
  }
  const { o } = best;
  const canvas = createCanvas(o.width, o.height);
  const ctx = canvas.getContext('2d');
  const img = ctx.createImageData(o.width, o.height);
  if (o.kind === 3) {
    img.data.set(o.data);
  } else if (o.kind === 2) {
    for (let s = 0, d = 0; s < o.data.length; s += 3, d += 4) {
      img.data[d] = o.data[s];
      img.data[d + 1] = o.data[s + 1];
      img.data[d + 2] = o.data[s + 2];
      img.data[d + 3] = 255;
    }
  } else {
    const px = o.width * o.height;
    for (let p = 0; p < px; p++) {
      const v = o.data[p] ?? 0;
      img.data[p * 4] = img.data[p * 4 + 1] = img.data[p * 4 + 2] = v;
      img.data[p * 4 + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  // Return an object exposing width/height + a draw method so it behaves like an Image.
  return canvasAsImage(canvas);
}

// wrap a canvas so it can be used interchangeably with a loaded Image
function canvasAsImage(canvas) {
  return {
    width: canvas.width,
    height: canvas.height,
    _canvas: canvas,
    // params mirror the canvas drawImage(src, sx, sy, sw, sh, dx, dy, dw, dh)
    // signature exactly; grouping them into an object would obscure that.
    // eslint-disable-next-line max-params
    draw(ctx, sx, sy, sw, sh, dx, dy, dw, dh) {
      ctx.drawImage(canvas, sx, sy, sw, sh, dx, dy, dw, dh);
    },
  };
}
// params mirror the canvas drawImage(...) signature plus the source; keeping
// them positional matches the underlying context API one-to-one.
// eslint-disable-next-line max-params
function drawSource(ctx, src, sx, sy, sw, sh, dx, dy, dw, dh) {
  if (src.draw) {
    src.draw(ctx, sx, sy, sw, sh, dx, dy, dw, dh);
  } else {
    ctx.drawImage(src, sx, sy, sw, sh, dx, dy, dw, dh);
  }
}

// ===========================================================================
// GEOMETRY
// ===========================================================================

// A box is fractions of the image: {x,y,w,h} in [0..1], optional rotate (deg,
// applied after crop; use 90/-90 for vertical text) and scale (upscale factor).
export function box(x, y, w, h, { rotate = 0, scale = 3 } = {}) {
  return { x, y, w, h, rotate, scale };
}

// Crop a region to its own canvas (at native resolution, before upscale/rotate).
export function regionCanvas(img, b) {
  const W = img.width,
    H = img.height;
  const sx = Math.max(0, Math.round(W * b.x)),
    sy = Math.max(0, Math.round(H * b.y));
  const sw = Math.min(W - sx, Math.round(W * b.w)),
    sh = Math.min(H - sy, Math.round(H * b.h));
  const c = createCanvas(sw, sh);
  const ctx = c.getContext('2d');
  ctx.fillStyle = 'white';
  ctx.fillRect(0, 0, sw, sh);
  drawSource(ctx, img, sx, sy, sw, sh, 0, 0, sw, sh);
  return c;
}

// Produce jittered box variants (±px at top-left, center, bottom-right) for the
// multi-offset consensus read. px is in pixels, converted to fractions.
export function jitter(b, px, imgW, imgH) {
  const dx = px / imgW,
    dy = px / imgH;
  return [
    { ...b, _tag: 'center' },
    { ...b, x: b.x - dx, y: b.y - dy, _tag: 'tl-5' }, // nudge box up-left
    { ...b, x: b.x + dx, y: b.y + dy, _tag: 'br-5' }, // nudge box down-right
    { ...b, w: b.w + dx, h: b.h + dy, _tag: 'grow-5' }, // slightly larger
  ];
}

// ===========================================================================
// PREPROCESSING  (each takes & returns a canvas)
// ===========================================================================

const cloneCtx = (canvas) => {
  const c = createCanvas(canvas.width, canvas.height);
  c.getContext('2d').drawImage(canvas, 0, 0);
  return c;
};

export function grayscale(canvas) {
  const c = cloneCtx(canvas),
    ctx = c.getContext('2d');
  const id = ctx.getImageData(0, 0, c.width, c.height),
    d = id.data;
  for (let i = 0; i < d.length; i += 4) {
    const v = (d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114) | 0;
    d[i] = d[i + 1] = d[i + 2] = v;
  }
  ctx.putImageData(id, 0, 0);
  return c;
}

// Drop one channel so ink of that color becomes dark. 'r' -> red ink darkens
// (good for red-on-red passport/security print).
export function dropChannel(canvas, ch = 'r') {
  const idx = { r: 0, g: 1, b: 2 }[ch];
  const c = cloneCtx(canvas),
    ctx = c.getContext('2d');
  const id = ctx.getImageData(0, 0, c.width, c.height),
    d = id.data;
  for (let i = 0; i < d.length; i += 4) {
    const v = d[i + idx];
    d[i] = d[i + 1] = d[i + 2] = v;
  }
  ctx.putImageData(id, 0, 0);
  return c;
}

export function contrast(canvas, gamma = 0.6) {
  const c = cloneCtx(canvas),
    ctx = c.getContext('2d');
  const id = ctx.getImageData(0, 0, c.width, c.height),
    d = id.data;
  const lut = new Uint8Array(256);
  for (let i = 0; i < 256; i++) {
    lut[i] = Math.min(
      255,
      Math.max(0, Math.round(255 * Math.pow(i / 255, gamma)))
    );
  }
  for (let i = 0; i < d.length; i += 4) {
    d[i] = lut[d[i]];
    d[i + 1] = lut[d[i + 1]];
    d[i + 2] = lut[d[i + 2]];
  }
  ctx.putImageData(id, 0, 0);
  return c;
}

// Otsu automatic threshold (or fixed if `t` given). Operates on grayscale.
export function binarize(canvas, t = null) {
  const g = grayscale(canvas),
    ctx = g.getContext('2d');
  const id = ctx.getImageData(0, 0, g.width, g.height),
    d = id.data;
  if (t === null || t === undefined) {
    const hist = new Array(256).fill(0);
    for (let i = 0; i < d.length; i += 4) {
      hist[d[i]]++;
    }
    const total = d.length / 4;
    let sum = 0;
    for (let i = 0; i < 256; i++) {
      sum += i * hist[i];
    }
    let sumB = 0,
      wB = 0,
      max = 0;
    t = 127;
    for (let i = 0; i < 256; i++) {
      wB += hist[i];
      if (!wB) {
        continue;
      }
      const wF = total - wB;
      if (!wF) {
        break;
      }
      sumB += i * hist[i];
      const mB = sumB / wB,
        mF = (sum - sumB) / wF,
        between = wB * wF * (mB - mF) ** 2;
      if (between > max) {
        max = between;
        t = i;
      }
    }
  }
  for (let i = 0; i < d.length; i += 4) {
    const v = d[i] > t ? 255 : 0;
    d[i] = d[i + 1] = d[i + 2] = v;
  }
  ctx.putImageData(id, 0, 0);
  return g;
}

// Cheap separable box blur, `r` px radius.
export function blur(canvas, r = 1) {
  if (r <= 0) {
    return cloneCtx(canvas);
  }
  const c = cloneCtx(canvas),
    ctx = c.getContext('2d');
  const { width: W, height: H } = c;
  const id = ctx.getImageData(0, 0, W, H),
    s = id.data;
  const out = new Uint8ClampedArray(s.length);
  const pass = (src, dst, horiz) => {
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        let rr = 0,
          gg = 0,
          bb = 0,
          n = 0;
        for (let k = -r; k <= r; k++) {
          const xx = horiz ? x + k : x,
            yy = horiz ? y : y + k;
          if (xx < 0 || yy < 0 || xx >= W || yy >= H) {
            continue;
          }
          const i = (yy * W + xx) * 4;
          rr += src[i];
          gg += src[i + 1];
          bb += src[i + 2];
          n++;
        }
        const i = (y * W + x) * 4;
        dst[i] = rr / n;
        dst[i + 1] = gg / n;
        dst[i + 2] = bb / n;
        dst[i + 3] = 255;
      }
    }
  };
  pass(s, out, true);
  pass(out, s, false);
  ctx.putImageData(id, 0, 0);
  return c;
}

// Keep only near-BLACK ink: every pixel darker than `threshold` (on all
// channels) becomes black, everything else becomes white. This strips colored
// security print (guilloché) and lighter sub-labels, leaving just the dark
// printed value — the key to reading passport fields printed over guilloché.
export function keepBlack(canvas, threshold = 90) {
  const output = cloneCtx(canvas),
    context = output.getContext('2d');
  const imageData = context.getImageData(0, 0, output.width, output.height),
    pixels = imageData.data;
  for (let i = 0; i < pixels.length; i += 4) {
    const isBlack =
      pixels[i] < threshold &&
      pixels[i + 1] < threshold &&
      pixels[i + 2] < threshold;
    const value = isBlack ? 0 : 255;
    pixels[i] = pixels[i + 1] = pixels[i + 2] = value;
  }
  context.putImageData(imageData, 0, 0);
  return output;
}

// Vignette blur: keep the center sharp, blur toward the edges (reduces edge
// speckle / neighboring-cell bleed while preserving the field's own text).
export function vignetteBlur(canvas, r = 2) {
  const sharp = cloneCtx(canvas);
  const soft = blur(canvas, r);
  const c = createCanvas(canvas.width, canvas.height),
    ctx = c.getContext('2d');
  const W = c.width,
    H = c.height,
    cx = W / 2,
    cy = H / 2,
    maxD = Math.hypot(cx, cy);
  const sImg = sharp.getContext('2d').getImageData(0, 0, W, H).data;
  const bImg = soft.getContext('2d').getImageData(0, 0, W, H).data;
  const out = ctx.createImageData(W, H),
    d = out.data;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      const t = Math.min(1, Math.hypot(x - cx, y - cy) / maxD); // 0 center .. 1 edge
      for (let k = 0; k < 3; k++) {
        d[i + k] = sImg[i + k] * (1 - t) + bImg[i + k] * t;
      }
      d[i + 3] = 255;
    }
  }
  ctx.putImageData(out, 0, 0);
  return c;
}

// Rotate a canvas by degrees (90/-90 straighten vertical text). Upscale via s.
export function rotate(canvas, deg, s = 1) {
  const rad = (deg * Math.PI) / 180;
  const W = canvas.width * s,
    H = canvas.height * s;
  const rot90 = Math.abs(deg % 180) === 90;
  const outW = rot90 ? H : W,
    outH = rot90 ? W : H;
  const c = createCanvas(outW, outH),
    ctx = c.getContext('2d');
  ctx.fillStyle = 'white';
  ctx.fillRect(0, 0, outW, outH);
  ctx.translate(outW / 2, outH / 2);
  ctx.rotate(rad);
  ctx.scale(s, s);
  ctx.translate(-canvas.width / 2, -canvas.height / 2);
  ctx.drawImage(canvas, 0, 0);
  return c;
}

// Upscale a canvas by factor s (no smoothing -> crisper for OCR).
export function upscale(canvas, s = 3) {
  const c = createCanvas(canvas.width * s, canvas.height * s),
    ctx = c.getContext('2d');
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(canvas, 0, 0, c.width, c.height);
  return c;
}

// ===========================================================================
// OCR
// ===========================================================================

function runTesseract(canvas, { whitelist, psm = 6, tsv = false } = {}) {
  const tmp = path.join(
    os.tmpdir(),
    `ocr-${process.pid}-${Math.random().toString(36).slice(2)}`
  );
  fs.writeFileSync(`${tmp}.png`, canvas.toBuffer('image/png'));
  const args = [`${tmp}.png`, tsv ? tmp : '-', '--psm', String(psm)];
  if (whitelist) {
    args.push('-c', `tessedit_char_whitelist=${whitelist}`);
  }
  if (tsv) {
    args.push('tsv');
  }
  try {
    if (tsv) {
      execFileSync('tesseract', args, {
        stdio: ['ignore', 'ignore', 'ignore'],
      });
      return fs.readFileSync(`${tmp}.tsv`, 'utf8');
    }
    return execFileSync('tesseract', args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } finally {
    for (const e of ['.png', '.tsv']) {
      try {
        fs.unlinkSync(tmp + e);
      } catch {
        /* best-effort cleanup: temp file may already be gone */
      }
    }
  }
}

export function ocrCanvas(canvas, opts = {}) {
  return runTesseract(canvas, opts).trim();
}

// Word boxes with coordinates (in the given canvas's pixel space).
export function ocrData(canvas, opts = {}) {
  const tsv = runTesseract(canvas, { ...opts, tsv: true });
  const rows = tsv.split('\n').slice(1);
  const words = [];
  for (const r of rows) {
    const c = r.split('\t');
    if (c.length < 12) {
      continue;
    }
    const conf = parseFloat(c[10]);
    const text = c[11];
    if (!text || text.trim() === '' || isNaN(conf) || conf < 0) {
      continue;
    }
    words.push({
      x: +c[6],
      y: +c[7],
      w: +c[8],
      h: +c[9],
      conf,
      text: text.trim(),
    });
  }
  return words;
}

// Group words into visual rows by y-proximity; sort each row left-to-right.
export function rowsFromWords(words, yTol = null) {
  if (!words.length) {
    return [];
  }
  const hs = words.map((w) => w.h).sort((a, b) => a - b);
  const medH = hs[hs.length >> 1] || 20;
  const tol = yTol ?? medH * 0.6;
  const sorted = [...words].sort((a, b) => a.y - b.y);
  const rows = [];
  let cur = [];
  let curY = null;
  for (const w of sorted) {
    if (curY === null || curY === undefined || Math.abs(w.y - curY) <= tol) {
      cur.push(w);
      curY = curY === null || curY === undefined ? w.y : (curY + w.y) / 2;
    } else {
      rows.push(cur.sort((a, b) => a.x - b.x));
      cur = [w];
      curY = w.y;
    }
  }
  if (cur.length) {
    rows.push(cur.sort((a, b) => a.x - b.x));
  }
  return rows;
}

// Consensus read of one field box, aiming for a PERFECT read: try the field
// repeatedly from slightly different PERSPECTIVES (small random pixel offset +
// small random rotation angle, optionally different preprocessing), and stop as
// soon as `agreeTarget` (default 2) attempts produce the SAME normalized value.
// Two independent perspectives landing on the same value = trusted read.
//
// Returns { value, agree, attempts, candidates }:
//   value    - the agreed value (null if never reached agreeTarget)
//   agree    - how many attempts produced `value`
//   attempts - how many OCR attempts were run before stopping
//   candidates - every {attempt, offset, angle, preprocess, raw, value}
//
// A caller treats value!=null (i.e. agree>=agreeTarget) as a confident read; a
// null value means "could not read reliably" — honestly unread, not guessed.
// complex by nature: OCR consensus ladder (offsets × preprocessing × early
// stop); splitting it would hurt readability of the tuned read strategy.
// eslint-disable-next-line complexity
export function readFieldConsensus(
  image,
  fieldBox,
  {
    whitelist,
    psm = 7,
    maxAttempts = 20,
    agreeTarget = 2,
    jitterPx = 4,
    jitterDeg = 1.5,
    preprocess = ['grayscale', 'binarize', 'raw'],
    normalize = (text) => text.trim(),
  } = {}
) {
  const counts = new Map();
  const candidates = [];
  const offsetFractionX = jitterPx / image.width;
  const offsetFractionY = jitterPx / image.height;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    // First attempt is the exact box; later attempts add a random offset+angle.
    const randomOffsetX =
      attempt === 0 ? 0 : (Math.random() * 2 - 1) * offsetFractionX;
    const randomOffsetY =
      attempt === 0 ? 0 : (Math.random() * 2 - 1) * offsetFractionY;
    const randomAngle = attempt === 0 ? 0 : (Math.random() * 2 - 1) * jitterDeg;
    const preprocessName = preprocess[attempt % preprocess.length];

    const jitteredBox = {
      ...fieldBox,
      x: fieldBox.x + randomOffsetX,
      y: fieldBox.y + randomOffsetY,
    };
    let canvas = upscale(regionCanvas(image, jitteredBox), fieldBox.scale || 3);
    if (randomAngle) {
      canvas = rotate(canvas, randomAngle, 1);
    }
    if (preprocessName === 'grayscale') {
      canvas = grayscale(canvas);
    } else if (preprocessName === 'binarize') {
      canvas = binarize(canvas);
    } else if (preprocessName === 'dropR') {
      canvas = dropChannel(canvas, 'r');
    } else if (preprocessName === 'vignette') {
      canvas = vignetteBlur(canvas, 2);
    } else if (preprocessName === 'keepBlack') {
      canvas = keepBlack(canvas, 90);
    } else if (preprocessName === 'keepBlack110') {
      canvas = keepBlack(canvas, 110);
    }

    const rawText = ocrCanvas(canvas, { whitelist, psm });
    const value = normalize(rawText);
    candidates.push({
      attempt,
      offset: [randomOffsetX, randomOffsetY],
      angle: randomAngle,
      preprocess: preprocessName,
      raw: rawText,
      value,
    });
    if (!value) {
      continue;
    }

    counts.set(value, (counts.get(value) || 0) + 1);
    if (counts.get(value) >= agreeTarget) {
      return {
        value,
        agree: counts.get(value),
        attempts: attempt + 1,
        candidates,
      };
    }
  }

  // Never reached the agreement target — report the most frequent, but mark it
  // unconfident by returning value:null so callers don't trust a lone read.
  let bestValue = null,
    bestCount = 0;
  for (const [value, count] of counts) {
    if (count > bestCount) {
      bestValue = value;
      bestCount = count;
    }
  }
  return {
    value: bestCount >= agreeTarget ? bestValue : null,
    agree: bestCount,
    attempts: maxAttempts,
    candidates,
    bestGuess: bestValue,
  };
}

// ===========================================================================
// PASSPORT DATE OF ISSUE — the one field not in the MRZ, printed over the
// guilloché. Reading it reliably needs the whole toolkit: keepBlack (strip
// non-black ink), calibration (learn the row position from the crisp
// passports), a small perspective search (offset / scale / threshold), strict
// regex + date sanity to reject noise, and percentage consensus to pick a
// clear plurality winner. Fields that can't reach a confident plurality are
// returned as null (unread), never guessed. See tests/09-13 and
// OCR-APPROACHES.md for the exploration behind this.
// ===========================================================================

// Accept a date only if it is a real dd.mm.yyyy with a sane day/month/year.
export function parseSaneDate(text) {
  const match = text.replace(/\s/g, '').match(/(\d{2})\.(\d{2})\.(\d{4})/);
  if (!match) {
    return null;
  }
  const day = +match[1],
    month = +match[2],
    year = +match[3];
  if (
    day < 1 ||
    day > 31 ||
    month < 1 ||
    month > 12 ||
    year < 1980 ||
    year > 2035
  ) {
    return null;
  }
  return `${match[1]}.${match[2]}.${match[3]}`;
}

// One perspective read of a date at (x, y).
function readDateAt(
  image,
  x,
  y,
  {
    width = 0.34,
    height = 0.024,
    scale = 4,
    threshold = 100,
    mode = 'keepBlack',
  }
) {
  let canvas = upscale(
    regionCanvas(image, { x, y, w: width, h: height }),
    scale
  );
  if (mode === 'keepBlack') {
    canvas = keepBlack(canvas, threshold);
  } else if (mode === 'dropR') {
    canvas = keepBlack(dropChannel(canvas, 'r'), threshold);
  } else if (mode === 'grayscale') {
    canvas = grayscale(canvas);
  }
  return parseSaneDate(ocrCanvas(canvas, { whitelist: '0123456789.', psm: 7 }));
}

// Learn the date-of-issue row position by finding it on the passports where it
// reads easily, then averaging. `expected` optionally maps image->known value to
// lock onto the right row; without it, the first sane date found per image is used.
export function calibrateIssueDateY(
  images,
  { xLeft = 0.3, yFrom = 0.775, yTo = 0.805, step = 0.002, threshold = 90 } = {}
) {
  const found = [];
  for (const image of images) {
    for (let y = yFrom; y <= yTo; y += step) {
      if (readDateAt(image, xLeft, y, { threshold })) {
        found.push(y);
        break;
      }
    }
  }
  return found.length
    ? found.reduce((sum, value) => sum + value, 0) / found.length
    : (yFrom + yTo) / 2;
}

// Read the date of issue with a small perspective grid around the calibrated y.
// Returns { value, agree, validReads, share } — value is null when no candidate
// reaches the plurality bar (minShare of valid reads AND >= 2x the runner-up).
// complex by nature: perspective search grid plus plurality consensus; the
// nested tuning loops read best kept together.
// eslint-disable-next-line complexity
export function readIssueDate(
  image,
  {
    calibratedY = 0.791,
    xLeft = 0.3,
    yOffsets = [-0.01, -0.005, 0, 0.005, 0.01],
    scales = [4, 5],
    thresholds = [80, 110, 140, 170],
    modes = ['keepBlack', 'dropR'],
    minShare = 0.35,
    minAgree = 2,
  } = {}
) {
  const votes = new Map();
  let validReads = 0;
  for (const dy of yOffsets) {
    for (const scale of scales) {
      for (const threshold of thresholds) {
        for (const mode of modes) {
          const value = readDateAt(image, xLeft, calibratedY + dy, {
            scale,
            threshold,
            mode,
          });
          if (value) {
            votes.set(value, (votes.get(value) || 0) + 1);
            validReads++;
          }
        }
      }
    }
  }
  const ranked = [...votes.entries()].sort((a, b) => b[1] - a[1]);
  const [topValue, topCount] = ranked[0] || [null, 0];
  const share = validReads ? topCount / validReads : 0;
  // Accept a clear plurality: the top value must be a >=minShare fraction of all
  // valid reads and have at least minAgree independent hits. (No 2x-runner-up
  // rule — a strict-regex sane date that dominates is trustworthy.)
  const accepted =
    topValue && share >= minShare && topCount >= minAgree ? topValue : null;
  return { value: accepted, agree: topCount, validReads, share, ranked };
}

// ===========================================================================
// MRZ (TD3)
// ===========================================================================

function mrzVal(ch) {
  if (ch === '<') {
    return 0;
  }
  if (ch >= '0' && ch <= '9') {
    return ch.charCodeAt(0) - 48;
  }
  return ch.charCodeAt(0) - 55;
}
function mrzCheck(str) {
  const w = [7, 3, 1];
  let s = 0;
  for (let i = 0; i < str.length; i++) {
    s += mrzVal(str[i]) * w[i % 3];
  }
  return s % 10;
}
const yy = (y) => {
  const n = +y;
  return n <= 30 ? 2000 + n : 1900 + n;
};

// Force a substring to digits, fixing the common OCR letter->digit confusions
// that occur in numeric MRZ fields (O->0, I/L->1, B->8, S->5, etc.).
const L2D = {
  O: '0',
  Q: '0',
  D: '0',
  I: '1',
  L: '1',
  Z: '2',
  B: '8',
  S: '5',
  G: '6',
  T: '7',
  A: '4',
  '<': '0',
};
const toDigits = (s) =>
  s
    .split('')
    .map((c) => (/\d/.test(c) ? c : (L2D[c] ?? c)))
    .join('');

export function parseMrzLine2(raw) {
  const s = raw.replace(/[^A-Z0-9<]/g, '');
  // Match the TD3 line-2 shape allowing letters in numeric fields (OCR may have
  // misread digits as letters). The optional extra char after nationality
  // absorbs a stray inserted glyph seen on some scans.
  const shapes = [
    /^([A-Z0-9<]{9})([\dA-Z])([A-Z<]{3})([\dA-Z]{6})([\dA-Z])([MFX<])([\dA-Z]{6})([\dA-Z])/,
    /^([A-Z0-9<]{9})([\dA-Z])([A-Z<]{3})[\dA-Z]([\dA-Z]{6})([\dA-Z])([MFX<])([\dA-Z]{6})([\dA-Z])/,
  ];
  let g = null;
  for (const re of shapes) {
    g = s.match(re);
    if (g) {
      break;
    }
  }
  if (!g) {
    return null;
  }

  // Coerce the numeric fields to digits (fixing O->0, I->1, B->8, ...).
  const passport = toDigits(g[1]);
  const cP = toDigits(g[2]);
  const nat = g[3];
  const dob = toDigits(g[4]);
  const cD = toDigits(g[5]);
  const sex = g[6] === '<' ? '' : g[6];
  const exp = toDigits(g[7]);
  const cE = toDigits(g[8]);

  return {
    passportNumber: passport.replace(/</g, ''),
    passportCheckOk: mrzCheck(passport) === +cP,
    nationality: nat.replace(/</g, ''),
    dob: `${String(yy(dob.slice(0, 2))).padStart(4, '0')}-${dob.slice(2, 4)}-${dob.slice(4, 6)}`,
    dobCheckOk: mrzCheck(dob) === +cD,
    sex,
    expiry: `${yy(exp.slice(0, 2))}-${exp.slice(2, 4)}-${exp.slice(4, 6)}`,
    expiryCheckOk: mrzCheck(exp) === +cE,
  };
}

export function parseMrzLine1(raw) {
  const s = raw.replace(/[^A-Z<]/g, '');
  const m = s.match(/^P[A-Z<]?([A-Z]{3})([A-Z<]+)$/);
  if (!m) {
    return null;
  }
  const parts = m[2].replace(/<+$/, '').split(/<<+/);
  const clean = (t) =>
    (t || '')
      .replace(/</g, ' ')
      .split(/\s+/)
      .filter((w) => w.length > 1)
      .join(' ')
      .trim();
  return { issuer: m[1], surname: clean(parts[0]), given: clean(parts[1]) };
}

// convenience for tests: save any canvas to a file
export function save(canvas, file) {
  fs.writeFileSync(file, canvas.toBuffer('image/png'));
  return file;
}
export { createCanvas };

// ---- compatibility shims for the first-generation scripts -----------------
// ocr-passports.mjs uses crop(image, region, scale) -> PNG buffer, and
// ocr(pngBuffer, opts) -> text. Provide those on top of the core primitives.
export function crop(image, region, scale = 3) {
  const b = { x: region.x, y: region.y, w: region.w, h: region.h };
  return upscale(regionCanvas(image, b), scale).toBuffer('image/png');
}
export function ocr(pngBuffer, opts = {}) {
  // Write the buffer to a temp PNG and OCR it directly with tesseract.
  const tmp = path.join(
    os.tmpdir(),
    `shim-${process.pid}-${Math.random().toString(36).slice(2)}.png`
  );
  fs.writeFileSync(tmp, pngBuffer);
  try {
    const args = [tmp, '-', '--psm', String(opts.psm ?? 6)];
    if (opts.whitelist) {
      args.push('-c', `tessedit_char_whitelist=${opts.whitelist}`);
    }
    return execFileSync('tesseract', args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } finally {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* best-effort cleanup: temp file may already be gone */
    }
  }
}
