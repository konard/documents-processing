// mrz-variants.mjs
//
// Reads one image several times through different image transformations and
// keeps what the readings agree on.
//
// A single OCR engine is deterministic: run it twice on the same pixels and it
// makes the same mistake twice, so repeating it proves nothing. Change the
// pixels first — resample, rotate a fraction of a degree, soften, adjust
// tone — and the errors move, because each transform lands the glyph edges on
// the sampling grid differently. Agreement across those readings is then real
// evidence, from one engine under one licence.

import {
  renderImage,
  regionCanvas,
  upscale,
  rotate,
  grayscale,
  contrast,
  blur,
  ocrCanvas,
} from './ocr-lib.mjs';

/** The band of a TD3 data page that holds the machine-readable zone. */
export const MRZ_REGION = { x: 0, y: 0.883, w: 1, h: 0.112 };
const MRZ_WHITELIST = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789<';

/**
 * Ranges for each transform, measured by sweeping them over real passports.
 *
 * `optimum` is where accuracy peaked; `min` and `max` bound the range that
 * stayed usable. Values outside these did real damage: rotating by 1.5° read
 * nothing at all, and thresholding hard enough to drop the security pattern
 * took the glyphs with it.
 *
 * `blur` is listed in whole pixels because its kernel steps one pixel at a
 * time; a fractional radius samples between pixels and destroys the image.
 */
export const TRANSFORM_RANGES = {
  scale: { min: 1.5, optimum: 3, max: 4, integer: false },
  rotateDegrees: { min: -1, optimum: 0.25, max: 1, integer: false },
  contrastGamma: { min: 0.6, optimum: 0.7, max: 0.8, integer: false },
  blurRadius: { min: 1, optimum: 2, max: 4, integer: true },
};

/**
 * Nudges a value by a small random fraction, staying inside its range.
 *
 * The jitter is deliberately tiny. Its purpose is to stop every run landing on
 * exactly the same pixel grid, which is what makes two readings of one image
 * fail identically. A larger nudge would test a different transform, not the
 * same one seen slightly differently.
 */
export function jitterValue(range, amount = 0.01, random = Math.random) {
  const { min, optimum, max, integer } = range;
  if (integer) {
    return optimum;
  }
  const spread = optimum * amount;
  const value = optimum + (random() - 0.5) * 2 * spread;
  return Math.min(max, Math.max(min, value));
}

/** Builds one set of transform parameters, jittered around the optimum. */
export function sampleParameters({ amount = 0.01, random = Math.random } = {}) {
  const out = {};
  for (const [name, range] of Object.entries(TRANSFORM_RANGES)) {
    out[name] = jitterValue(range, amount, random);
  }
  return out;
}

/**
 * The transformations tried, each a pipeline over the cropped MRZ band.
 *
 * Each applies a different kind of change: resampling, small rotations either
 * way, softening, and tonal adjustment. Two variants that differ only slightly
 * tend to fail together, inflating agreement without adding evidence.
 *
 * Each receives jittered parameters, so repeated runs sample a small
 * neighbourhood around the optimum.
 */
export const VARIANTS = {
  plain: (canvas, p) => upscale(canvas, p.scale),
  'rotate-left': (canvas, p) =>
    rotate(upscale(canvas, p.scale), -Math.abs(p.rotateDegrees)),
  'rotate-right': (canvas, p) =>
    rotate(upscale(canvas, p.scale), Math.abs(p.rotateDegrees)),
  grayscale: (canvas, p) => grayscale(upscale(canvas, p.scale)),
  contrast: (canvas, p) => contrast(upscale(canvas, p.scale), p.contrastGamma),
  soften: (canvas, p) => blur(upscale(canvas, p.scale), p.blurRadius),
  'soften-contrast': (canvas, p) =>
    contrast(blur(upscale(canvas, p.scale), p.blurRadius), p.contrastGamma),
  'rotate-contrast': (canvas, p) =>
    contrast(
      rotate(upscale(canvas, p.scale), Math.abs(p.rotateDegrees)),
      p.contrastGamma
    ),
  'small-scale': (canvas, p) => upscale(canvas, Math.max(1.5, p.scale / 2)),
  'large-scale': (canvas, p) => upscale(canvas, Math.min(4, p.scale * 1.3)),
};

/**
 * The variants worth running when time is limited.
 *
 * Measured over repeated jittered runs, only `rotate-contrast` held a perfect
 * score every time; the rest swing by several fields between runs. That is why
 * these are voted on: individually they are unreliable, but they do not fail on
 * the same images, so together they are stable.
 *
 * This subset settled 14 or 15 of 15 fields per run. The full set settled all
 * 15 every time, so prefer it unless the extra second matters.
 */
export const RECOMMENDED_VARIANTS = [
  'rotate-contrast',
  'soften-contrast',
  'soften',
  'contrast',
  'plain',
];

/**
 * Runs one variant and returns the MRZ lines it produced.
 *
 * A failure yields an empty list: a transform that defeats the engine should
 * drop out of the vote, not stop the run.
 */
export function readVariant(image, transform, parameters) {
  try {
    const canvas = transform(regionCanvas(image, MRZ_REGION), parameters);
    const text = ocrCanvas(canvas, { whitelist: MRZ_WHITELIST, psm: 6 });
    return text
      .split('\n')
      .map((line) => line.replace(/\s/g, ''))
      .filter((line) => line.length > 25);
  } catch {
    return [];
  }
}

/**
 * Reads an image through several variants, each with its own jittered
 * parameters so no two runs share a sampling grid.
 */
export async function readAllVariants(imagePath, options = {}) {
  // Defaults to every variant: the full set settled all fields on every run,
  // where the smaller subset occasionally left one disputed.
  const { only = Object.keys(VARIANTS), jitter = 0.01, random } = options;
  const image = await renderImage(imagePath);
  const readings = {};
  for (const name of only) {
    const transform = VARIANTS[name];
    if (transform) {
      readings[name] = readVariant(
        image,
        transform,
        sampleParameters({ amount: jitter, random })
      );
    }
  }
  return readings;
}
