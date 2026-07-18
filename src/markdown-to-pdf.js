#!/usr/bin/env node
// markdown-to-pdf.js
//
// Renders a Markdown file to a clean, printable A4 PDF using pdf-lib only (no
// heavy HTML/headless-browser dependency, so the project stays self-contained).
//
// Supported Markdown (enough for our letters):
//   # / ## / ###  headings
//   plain paragraphs with **bold** inline spans
//   - bullet lists
//   blank lines as spacing
//
// Usage:  node markdown-to-pdf.js <input.md> [output.pdf]
//   If output.pdf is omitted, writes alongside the input with a .pdf extension.
//
// Requires: pdf-lib, @pdf-lib/fontkit.

import fs from 'node:fs';
import path from 'node:path';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';

// ---- args -----------------------------------------------------------------

// Positional args are the paths; a --fit-one-page flag may appear anywhere.
// With the flag set, the letter is shrunk (typography scaled down, never up)
// just enough to fit on a single page — but never below a readability floor.
const positional = process.argv
  .slice(2)
  .filter((argument) => !argument.startsWith('--'));
const flags = new Set(
  process.argv.slice(2).filter((argument) => argument.startsWith('--'))
);
const INPUT = positional[0];
if (!INPUT) {
  console.error(
    'Usage: node markdown-to-pdf.js <input.md> [output.pdf] [--fit-one-page]'
  );
  process.exit(1);
}
const OUTPUT = positional[1] || `${INPUT.replace(/\.md$/i, '')}.pdf`;
const FIT_ONE_PAGE = flags.has('--fit-one-page');
// --font=<path.ttf>: embed a TrueType font (needed for non-Latin scripts like
// Cyrillic — the built-in Helvetica only covers Latin-1). pdf-lib subsets the
// font, so only the glyphs actually used are embedded and the PDF stays small.
const fontArgument = [...flags].find((flag) => flag.startsWith('--font='));
const FONT_PATH = fontArgument ? fontArgument.slice('--font='.length) : null;

// ---- page + typography constants ------------------------------------------

const PAGE = { width: 595.28, height: 841.89 }; // A4 in points
const MARGIN = 64;
const CONTENT_WIDTH = PAGE.width - MARGIN * 2;
const COLOR = rgb(0.1, 0.1, 0.1);

// Per-style: font, size, line height, space above/below.
const STYLES = {
  h1: { size: 20, lineHeight: 26, spaceBefore: 6, spaceAfter: 12, bold: true },
  h2: { size: 14, lineHeight: 20, spaceBefore: 14, spaceAfter: 6, bold: true },
  h3: { size: 12, lineHeight: 17, spaceBefore: 10, spaceAfter: 4, bold: true },
  body: {
    size: 11,
    lineHeight: 16,
    spaceBefore: 0,
    spaceAfter: 8,
    bold: false,
  },
  bullet: {
    size: 11,
    lineHeight: 16,
    spaceBefore: 0,
    spaceAfter: 4,
    bold: false,
  },
};

// ---- markdown → a flat list of blocks -------------------------------------

// Each block: { style, spans } where spans = [{ text, bold }]. Bullets also
// carry an indent + marker.
function parseInlineBold(text) {
  // Split on **bold** markers, alternating plain / bold spans.
  const spans = [];
  const parts = text.split(/(\*\*[^*]+\*\*)/g);
  for (const part of parts) {
    if (!part) {
      continue;
    }
    const m = part.match(/^\*\*([^*]+)\*\*$/);
    if (m) {
      spans.push({ text: m[1], bold: true });
    } else {
      spans.push({ text: part, bold: false });
    }
  }
  return spans.length ? spans : [{ text: '', bold: false }];
}

function parseMarkdown(md) {
  const blocks = [];
  const lines = md.replace(/\r\n/g, '\n').split('\n');
  let paragraph = null; // accumulating body text
  let lastBullet = null; // the most recent bullet block (for wrapped continuation lines)

  const flushParagraph = () => {
    if (paragraph && paragraph.trim()) {
      blocks.push({ style: 'body', spans: parseInlineBold(paragraph.trim()) });
    }
    paragraph = null;
  };

  for (const rawLine of lines) {
    const line = rawLine.replace(/\s+$/, '');
    if (line.trim() === '') {
      flushParagraph();
      lastBullet = null;
      continue;
    }

    const isIndentedContinuation =
      /^\s{2,}\S/.test(rawLine) && !/^\s*[-*]\s+/.test(rawLine);

    let m;
    if ((m = line.match(/^#\s+(.*)$/))) {
      flushParagraph();
      lastBullet = null;
      blocks.push({ style: 'h1', spans: parseInlineBold(m[1]) });
    } else if ((m = line.match(/^##\s+(.*)$/))) {
      flushParagraph();
      lastBullet = null;
      blocks.push({ style: 'h2', spans: parseInlineBold(m[1]) });
    } else if ((m = line.match(/^###\s+(.*)$/))) {
      flushParagraph();
      lastBullet = null;
      blocks.push({ style: 'h3', spans: parseInlineBold(m[1]) });
    } else if ((m = line.match(/^\s*[-*]\s+(.*)$/))) {
      flushParagraph();
      const block = { style: 'bullet', text: m[1] };
      blocks.push(block);
      lastBullet = block;
    } else if (isIndentedContinuation && lastBullet && paragraph === null) {
      lastBullet.text += ` ${line.trim()}`;
    } // wrapped bullet line
    else {
      paragraph = paragraph ? `${paragraph} ${line.trim()}` : line.trim();
      lastBullet = null;
    }
  }
  flushParagraph();

  // Resolve accumulated bullet text into spans (done after continuation joins).
  return blocks.map((block) =>
    block.style === 'bullet'
      ? { style: 'bullet', spans: parseInlineBold(block.text) }
      : block
  );
}

// ---- layout: wrap spans to the content width -------------------------------

// Break the block's spans into lines of {text, bold} runs that each fit in maxWidth.
function wrapSpans(spans, fonts, size, maxWidth) {
  const lines = [];
  let current = []; // array of {text, bold}
  let currentWidth = 0;

  const widthOf = (text, bold) =>
    (bold ? fonts.bold : fonts.regular).widthOfTextAtSize(text, size);

  for (const span of spans) {
    const words = span.text.split(/(\s+)/); // keep the whitespace tokens
    for (const word of words) {
      if (word === '') {
        continue;
      }
      const w = widthOf(word, span.bold);
      if (
        currentWidth + w > maxWidth &&
        current.length > 0 &&
        word.trim() !== ''
      ) {
        lines.push(current);
        current = [];
        currentWidth = 0;
        if (/^\s+$/.test(word)) {
          continue;
        } // don't start a line with a space
      }
      current.push({ text: word, bold: span.bold });
      currentWidth += w;
    }
  }
  if (current.length) {
    lines.push(current);
  }
  return lines.length ? lines : [[]];
}

// ---- render ---------------------------------------------------------------

const markdown = fs.readFileSync(INPUT, 'utf8');
const blocks = parseMarkdown(markdown);

const pdf = await PDFDocument.create();
let fonts;
if (FONT_PATH) {
  // Embed a custom TrueType font (e.g. Arial Unicode for Cyrillic). One file
  // serves both weights — a plain unicode font has no separate bold face, so
  // bold spans render in the same weight, which is fine for a reference copy.
  pdf.registerFontkit(fontkit);
  const embedded = await pdf.embedFont(fs.readFileSync(FONT_PATH), {
    subset: true,
  });
  fonts = { regular: embedded, bold: embedded };
} else {
  fonts = {
    regular: await pdf.embedFont(StandardFonts.Helvetica),
    bold: await pdf.embedFont(StandardFonts.HelveticaBold),
  };
}

// Lay every block out at a given typography scale (1.0 = the constants above).
// When `draw` is false this is a dry run that only counts how many pages the
// content needs, so we can search for the largest scale that still fits one
// page. Every size and spacing value is multiplied by `scale`, so the letter
// keeps its exact proportions — it just gets uniformly smaller.
function layout(scale, draw) {
  let page = draw ? pdf.addPage([PAGE.width, PAGE.height]) : null;
  let pageCount = 1;
  let cursorY = PAGE.height - MARGIN;

  const newPage = () => {
    pageCount += 1;
    if (draw) {
      page = pdf.addPage([PAGE.width, PAGE.height]);
    }
    cursorY = PAGE.height - MARGIN;
  };

  for (const block of blocks) {
    const style = STYLES[block.style];
    const fontSize = style.size * scale;
    const lineHeight = style.lineHeight * scale;
    // Bullets are indented; wrapped continuation lines align under the text,
    // not the marker, so the list reads as a clean hanging indent.
    const bulletIndent = (block.style === 'bullet' ? 20 : 0) * scale;
    const textLeft = MARGIN + bulletIndent;
    const textWidth = CONTENT_WIDTH - bulletIndent;

    cursorY -= style.spaceBefore * scale;
    const lines = wrapSpans(block.spans, fonts, fontSize, textWidth);

    for (let i = 0; i < lines.length; i++) {
      if (cursorY - lineHeight < MARGIN) {
        newPage();
      }

      // Bullet marker on the first wrapped line, slightly inset from the margin.
      if (draw && block.style === 'bullet' && i === 0) {
        page.drawText('•', {
          x: MARGIN + 6 * scale,
          y: cursorY - fontSize,
          size: fontSize,
          font: fonts.regular,
          color: COLOR,
        });
      }
      let x = textLeft; // every line (including wrapped ones) starts at the text indent
      for (const run of lines[i]) {
        const font = run.bold || style.bold ? fonts.bold : fonts.regular;
        if (draw) {
          page.drawText(run.text, {
            x,
            y: cursorY - fontSize,
            size: fontSize,
            font,
            color: COLOR,
          });
        }
        x += font.widthOfTextAtSize(run.text, fontSize);
      }
      cursorY -= lineHeight;
    }
    cursorY -= style.spaceAfter * scale;
  }
  return pageCount;
}

// Choose the typography scale. Default 1.0; with --fit-one-page, shrink in
// small steps until the content fits one page, but never below MIN_SCALE so
// the text stays comfortably readable. If even MIN_SCALE overflows, the content
// flows onto more pages to keep the letter readable.
const MIN_SCALE = 0.8; // 11pt body → ~8.8pt, still clearly readable
let renderScale = 1.0;
if (FIT_ONE_PAGE) {
  while (renderScale > MIN_SCALE && layout(renderScale, false) > 1) {
    renderScale = Math.max(
      MIN_SCALE,
      Math.round((renderScale - 0.02) * 100) / 100
    );
  }
}
layout(renderScale, true);

fs.mkdirSync(path.dirname(OUTPUT), { recursive: true });
// useObjectStreams:false → classic xref table, maximally compatible with
// stricter PDF parsers (e.g. eFRRO), which can reject ObjStm-based PDFs.
fs.writeFileSync(OUTPUT, await pdf.save({ useObjectStreams: false }));
const scaleNote =
  renderScale < 1
    ? `, scaled to ${Math.round(renderScale * 100)}% to fit one page`
    : '';
console.log(
  `✓ ${path.basename(INPUT)} → ${OUTPUT}  (${pdf.getPageCount()} page${pdf.getPageCount() > 1 ? 's' : ''}${scaleNote})`
);
