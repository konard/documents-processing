import { describe, it, expect } from 'test-anywhere';
import { existsSync, mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { cropPassportPage, findFoldAbove } from '../src/evisa-passport.mjs';

// A page the size of a small scan, in grey, with marks painted on it. Real
// scans are private, so the shapes a seam has to be told from are drawn here:
// a crease across the whole width, and print that stops short of the margins.
const WIDTH = 600;
const HEIGHT = 840;
const PAPER = 215;
const MRZ_TOP = 740;

const CREASE = { top: 400, bottom: 413, grey: 175 };
const SIGNATURE_RULE = {
  top: 360,
  bottom: 363,
  left: 150,
  right: 450,
  grey: 90,
};
const HEADING = { top: 440, bottom: 452, left: 200, right: 400, grey: 80 };

async function paint(marks, name) {
  const pixels = Buffer.alloc(WIDTH * HEIGHT, PAPER);
  for (const { top, bottom, left = 0, right = WIDTH, grey } of marks) {
    for (let y = top; y < bottom; y++) {
      pixels.fill(grey, y * WIDTH + left, y * WIDTH + right);
    }
  }
  const dir = mkdtempSync(path.join(tmpdir(), 'evisa-fold-'));
  const file = path.join(dir, `${name}.png`);
  await sharp(pixels, { raw: { width: WIDTH, height: HEIGHT, channels: 1 } })
    .png()
    .toFile(file);
  return file;
}

describe('finding the fold of an open passport', () => {
  it('cuts on the lower edge of the crease, where the data page begins', async () => {
    // The crease is a band, and a cut through its middle leaves half of it
    // as a dark strip along the top of the upload.
    const file = await paint([CREASE], 'crease');
    expect(await findFoldAbove(file, MRZ_TOP)).toBe(CREASE.bottom);
  });

  it('is not drawn to print that is darker than the crease', async () => {
    // A heading and the signature rule are both far darker than a shadow,
    // and both sit within reach of the seam on a Russian passport.
    const file = await paint([SIGNATURE_RULE, CREASE, HEADING], 'spread');
    expect(await findFoldAbove(file, MRZ_TOP)).toBe(CREASE.bottom);
  });

  it('finds no fold on a page that only carries print', async () => {
    // A single page scanned flat has no seam, and cutting on a heading would
    // take the top of the page off.
    const file = await paint([SIGNATURE_RULE, HEADING], 'print');
    expect(await findFoldAbove(file, MRZ_TOP)).toBe(null);
  });

  it('finds no fold on a blank page', async () => {
    const file = await paint([], 'blank');
    expect(await findFoldAbove(file, MRZ_TOP)).toBe(null);
  });

  it('wants the crease to reach both margins', async () => {
    // A line that stops short of one edge is a mark on the page, not the
    // edge of it, however long it is.
    const file = await paint([{ ...CREASE, right: 400 }], 'partial');
    expect(await findFoldAbove(file, MRZ_TOP)).toBe(null);
  });

  it('ignores a crease that sits inside the machine-readable zone', async () => {
    // The zone's own rows of glyphs dip dark across the width too, and they
    // are the bottom of the page, not the top.
    const file = await paint([CREASE], 'low');
    expect(await findFoldAbove(file, CREASE.top - 10)).toBe(null);
  });
});

describe('on real scans, when a folder of them is named', () => {
  // Real passports stay outside the repository. Point EVISA_SCANS_DIR at a
  // folder of them to run this; the check itself carries no data.
  const dir = process.env.EVISA_SCANS_DIR ?? '';
  // Deno refuses an empty path outright, so it is not asked about one.
  const scans =
    dir && existsSync(dir)
      ? readdirSync(dir).filter((name) => /\.jpe?g$/i.test(name))
      : [];

  it('cuts every spread where the crease brightens into the page', async () => {
    const out = mkdtempSync(path.join(tmpdir(), 'evisa-scans-'));
    for (const name of scans) {
      const file = path.join(dir, name);
      const cut = await cropPassportPage(file, path.join(out, name));
      expect(`${name}: ${cut.cropped}`).toBe(`${name}: true`);
      // The row above the cut is the last of the crease and the row on it is
      // paper, so the image brightens across the cut.
      const { data, info } = await sharp(file)
        .greyscale()
        .raw()
        .toBuffer({ resolveWithObject: true });
      const mean = (y) => {
        let sum = 0;
        for (let x = 0; x < info.width; x++) {
          sum += data[y * info.width + x];
        }
        return sum / info.width;
      };
      const step = mean(cut.top) - mean(cut.top - 1);
      expect(`${name}: ${step > 5}`).toBe(`${name}: true`);
    }
  });
});
