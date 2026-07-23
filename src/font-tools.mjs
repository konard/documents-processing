// font-tools.mjs — locate a wide-coverage (Latin + Cyrillic) TrueType font for
// embedding into PDFs, without shipping any font binary in this repository.
//
// pdf-lib can embed a plain .ttf but not a .ttc collection, so only .ttf
// candidates are considered. Resolution order:
//   1. an explicit path (e.g. from a --font= flag), if it exists
//   2. a font already cached under <dataDir>/fonts/
//   3. a system font with Latin+Cyrillic coverage (macOS / Linux common paths)
//   4. download a legally-redistributable font (DejaVu Sans, a permissive
//      Bitstream-Vera-derived license) into <dataDir>/fonts/ and cache it
//
// Returns an absolute path to a usable .ttf, or null if none could be obtained
// (callers then fall back to a built-in standard font such as Helvetica).

import fs from 'node:fs';
import path from 'node:path';

// System fonts that cover Latin + Cyrillic and are plain .ttf (embeddable).
const SYSTEM_FONT_CANDIDATES = [
  // macOS
  '/System/Library/Fonts/Supplemental/Arial Unicode.ttf',
  '/Library/Fonts/Arial Unicode.ttf',
  '/System/Library/Fonts/Supplemental/Arial.ttf',
  // Linux (DejaVu / Liberation are the usual wide-coverage .ttf fonts)
  '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
  '/usr/share/fonts/dejavu/DejaVuSans.ttf',
  '/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf',
  '/usr/share/fonts/liberation/LiberationSans-Regular.ttf',
];

// A legally redistributable fallback (DejaVu Sans, permissive license) fetched
// on demand only when no local font is found. jsDelivr mirrors the dejavu-fonts
// package; the file is a plain .ttf with full Latin + Cyrillic coverage.
const DOWNLOAD_URL =
  'https://cdn.jsdelivr.net/npm/dejavu-fonts-ttf@2.37.3/ttf/DejaVuSans.ttf';
const DOWNLOAD_BASENAME = 'DejaVuSans.ttf';

function firstExisting(paths) {
  return paths.find((candidate) => fs.existsSync(candidate)) || null;
}

async function downloadFont(destPath) {
  const response = await fetch(DOWNLOAD_URL);
  if (!response.ok) {
    throw new Error(`font download failed: HTTP ${response.status}`);
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  fs.writeFileSync(destPath, bytes);
  return destPath;
}

// Resolve a usable Unicode .ttf. dataDir is the folder that holds this run's
// document data (real config, fonts cache); explicitPath wins if it exists.
export async function resolveUnicodeFont(dataDir, explicitPath = null) {
  if (explicitPath && fs.existsSync(explicitPath)) {
    return explicitPath;
  }

  const cacheDir = path.join(dataDir, 'fonts');
  const cached = firstExisting([
    path.join(cacheDir, 'ArialUnicode.ttf'),
    path.join(cacheDir, DOWNLOAD_BASENAME),
  ]);
  if (cached) {
    return cached;
  }

  const system = firstExisting(SYSTEM_FONT_CANDIDATES);
  if (system) {
    return system;
  }

  try {
    return await downloadFont(path.join(cacheDir, DOWNLOAD_BASENAME));
  } catch (error) {
    console.warn(`⚠ could not obtain a Unicode font: ${error.message}`);
    return null;
  }
}
