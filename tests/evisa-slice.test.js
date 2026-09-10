import { describe, it, expect } from 'test-anywhere';
import { gapCentres, planCuts } from '../src/evisa-slice.mjs';

/** A profile with ink everywhere except the given bands. */
function profile(height, blanks) {
  const rows = new Uint8Array(height);
  for (const [from, to] of blanks) {
    rows.fill(1, from, to);
  }
  return rows;
}

describe('finding somewhere to cut a page', () => {
  it('takes the middle of each blank band', () => {
    const rows = profile(100, [
      [10, 20],
      [50, 60],
    ]);
    expect(gapCentres(rows)).toEqual([15, 55]);
  });

  it('passes over a band too thin to be a gap between rows', () => {
    // Two rows of text almost touching leave a sliver of white that is not a
    // margin, and cutting there would crowd both.
    const rows = profile(100, [
      [10, 12],
      [50, 60],
    ]);
    expect(gapCentres(rows)).toEqual([55]);
  });

  it('closes a band that runs to the foot of the page', () => {
    expect(gapCentres(profile(100, [[80, 100]]))).toEqual([90]);
  });

  it('finds nothing on a page with ink throughout', () => {
    expect(gapCentres(profile(100, []))).toEqual([]);
  });
});

describe('planning the cuts for a tall capture', () => {
  const width = 1000;
  // The tallest a section may be is 1.6 widths, the shortest 0.45.
  const longest = 1600;

  it('leaves a page already short enough in one piece', () => {
    expect(planCuts(1200, width, [600])).toEqual([]);
  });

  it('cuts at the last gap that fits within the height limit', () => {
    const cuts = planCuts(3000, width, [500, 1400, 1550, 1700]);
    expect(cuts).toEqual([1550]);
  });

  it('cuts at the limit when the stretch holds no gap at all', () => {
    // A solid block of content offers no gap to cut at, so the height limit
    // applies and the section splits across a row.
    expect(planCuts(3000, width, [])).toEqual([longest]);
  });

  it('rejects a gap that would leave too short a section', () => {
    // The gap at 200 sits under the shortest section allowed, so the cut
    // goes to the height limit and no sliver is made.
    expect(planCuts(3000, width, [200])).toEqual([longest]);
  });

  it('keeps cutting until what is left fits', () => {
    const cuts = planCuts(6000, width, [1500, 3000, 4500]);
    expect(cuts).toEqual([1500, 3000, 4500]);
    // Every section, the last one included, is within the limit.
    const edges = [0, ...cuts, 6000];
    for (let i = 0; i < edges.length - 1; i++) {
      expect(edges[i + 1] - edges[i] <= longest).toBe(true);
    }
  });

  it('never places a cut outside the page', () => {
    const height = 5000;
    for (const cut of planCuts(height, width, [1000, 2000, 3000, 4000])) {
      expect(cut > 0 && cut < height).toBe(true);
    }
  });
});

describe('binding the sections into a PDF', () => {
  it('gives one page per section, sized as that section', async () => {
    const fs = await import('node:fs');
    const os = await import('node:os');
    const nodePath = await import('node:path');
    const sharp = (await import('sharp')).default;
    const { sliceImage, sectionsToPdf } =
      await import('../src/evisa-slice.mjs');
    const { PDFDocument } = await import('pdf-lib');

    const dir = fs.mkdtempSync(nodePath.join(os.tmpdir(), 'slice-test-'));
    try {
      // A page tall enough to need cutting, with blank bands to cut in.
      const width = 600;
      const height = 3000;
      const band = Buffer.alloc(width * height * 3, 255);
      for (let row = 0; row < height; row++) {
        // Ink on most rows, leaving a clear gap every 200 rows.
        if (row % 200 < 150) {
          band.fill(20, row * width * 3, (row + 1) * width * 3);
        }
      }
      const source = nodePath.join(dir, 'page.png');
      await sharp(band, { raw: { width, height, channels: 3 } })
        .png()
        .toFile(source);

      const sections = await sliceImage(source, dir);
      expect(sections.length > 1).toBe(true);

      const target = await sectionsToPdf(
        sections,
        nodePath.join(dir, 'form.pdf')
      );
      const pdf = await PDFDocument.load(fs.readFileSync(target));
      expect(pdf.getPageCount()).toBe(sections.length);
      // Each page is exactly its section, so nothing is scaled or cropped.
      pdf.getPages().forEach((page, at) => {
        expect(Math.round(page.getWidth())).toBe(width);
        expect(Math.round(page.getHeight())).toBe(sections[at].height);
      });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('a step that stalls', () => {
  it('yields its fallback when the step stalls', async () => {
    const { withDeadline } = await import('../src/evisa-slice.mjs');
    expect(await withDeadline(new Promise(() => {}), 40, 'left behind')).toBe(
      'left behind'
    );
  });

  it('passes a finished step straight through', async () => {
    const { withDeadline } = await import('../src/evisa-slice.mjs');
    expect(await withDeadline(Promise.resolve('sent'), 200, 'late')).toBe(
      'sent'
    );
  });
});
