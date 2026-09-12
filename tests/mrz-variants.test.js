import { describe, it, expect } from 'test-anywhere';
import {
  TRANSFORM_RANGES,
  VARIANTS,
  RECOMMENDED_VARIANTS,
  jitterValue,
  sampleParameters,
  MRZ_REGION,
} from '../src/mrz-variants.mjs';

describe('transform ranges', () => {
  it('puts every optimum inside its own bounds', () => {
    for (const [name, range] of Object.entries(TRANSFORM_RANGES)) {
      expect(`${name}:${range.min <= range.optimum}`).toBe(`${name}:true`);
      expect(`${name}:${range.optimum <= range.max}`).toBe(`${name}:true`);
    }
  });

  it('keeps rotation to a fraction of a degree', () => {
    // A degree and a half read nothing at all on the passports measured.
    expect(Math.abs(TRANSFORM_RANGES.rotateDegrees.max) <= 1).toBe(true);
    expect(Math.abs(TRANSFORM_RANGES.rotateDegrees.optimum) < 0.5).toBe(true);
  });

  it('marks the blur radius as whole pixels', () => {
    // Its kernel steps one pixel at a time, so a fractional radius samples
    // between pixels and destroys the image.
    expect(TRANSFORM_RANGES.blurRadius.integer).toBe(true);
    expect(Number.isInteger(TRANSFORM_RANGES.blurRadius.optimum)).toBe(true);
  });
});

describe('jitterValue', () => {
  it('stays within one percent of the optimum by default', () => {
    const range = TRANSFORM_RANGES.scale;
    for (let i = 0; i < 200; i++) {
      const value = jitterValue(range);
      const drift = Math.abs(value - range.optimum) / range.optimum;
      expect(drift <= 0.01 + 1e-9).toBe(true);
    }
  });

  it('never leaves the usable range', () => {
    const range = { min: 2.99, optimum: 3, max: 3.01, integer: false };
    for (let i = 0; i < 100; i++) {
      const value = jitterValue(range, 0.5);
      expect(value >= range.min && value <= range.max).toBe(true);
    }
  });

  it('leaves an integer parameter alone', () => {
    // Nudging it would land between pixels, which is worse than not varying it.
    for (let i = 0; i < 20; i++) {
      expect(jitterValue(TRANSFORM_RANGES.blurRadius, 0.5)).toBe(
        TRANSFORM_RANGES.blurRadius.optimum
      );
    }
  });

  it('actually varies, so two runs do not share a sampling grid', () => {
    const seen = new Set();
    for (let i = 0; i < 50; i++) {
      seen.add(jitterValue(TRANSFORM_RANGES.scale));
    }
    expect(seen.size > 1).toBe(true);
  });

  it('is reproducible when given a fixed source of randomness', () => {
    const fixed = () => 0.25;
    const a = jitterValue(TRANSFORM_RANGES.scale, 0.01, fixed);
    const b = jitterValue(TRANSFORM_RANGES.scale, 0.01, fixed);
    expect(a).toBe(b);
  });
});

describe('sampleParameters', () => {
  it('produces a value for every transform', () => {
    const parameters = sampleParameters();
    for (const name of Object.keys(TRANSFORM_RANGES)) {
      expect(`${name}:${typeof parameters[name]}`).toBe(`${name}:number`);
    }
  });

  it('keeps every value inside its range', () => {
    for (let i = 0; i < 50; i++) {
      const parameters = sampleParameters();
      for (const [name, range] of Object.entries(TRANSFORM_RANGES)) {
        const value = parameters[name];
        expect(`${name}:${value >= range.min && value <= range.max}`).toBe(
          `${name}:true`
        );
      }
    }
  });
});

describe('variant set', () => {
  it('offers several kinds of change, not one repeated', () => {
    const names = Object.keys(VARIANTS);
    expect(names.length >= 8).toBe(true);
    for (const kind of ['rotate', 'contrast', 'soften', 'scale']) {
      expect(`${kind}:${names.some((n) => n.includes(kind))}`).toBe(
        `${kind}:true`
      );
    }
  });

  it('recommends only variants that exist', () => {
    for (const name of RECOMMENDED_VARIANTS) {
      expect(`${name}:${typeof VARIANTS[name]}`).toBe(`${name}:function`);
    }
  });

  it('reads the bottom band, where a TD3 machine-readable zone sits', () => {
    expect(MRZ_REGION.y > 0.8).toBe(true);
    expect(MRZ_REGION.y + MRZ_REGION.h <= 1).toBe(true);
  });
});
