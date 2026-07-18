// pdf-image-tools.js
//
// Shared helpers for extracting and re-encoding the images inside a PDF page,
// using pdf-lib (to read raw image streams), pako (to inflate Flate streams),
// and sharp (the ONLY reliable encoder here — @napi-rs/canvas's JPEG/PNG
// encoder ignores the quality argument and produces ~8 KB mush, so it must NOT
// be used to encode). We read the ORIGINAL compressed bytes straight from the
// PDF (a JPEG stays the exact original JPEG), so nothing is decoded-then-
// re-encoded unless we explicitly choose to.

import sharp from 'sharp';
import pako from 'pako';
import { PDFDocument, PDFName, PDFRawStream } from 'pdf-lib';

export { sharp };

// Find the single biggest image XObject on page 1 of `pdfBytes` and return it
// as a sharp pipeline plus metadata about its ORIGINAL encoding.
//   { sharp, width, height, isJpeg, jpegBytes|null, channels }
// - isJpeg=true  → jpegBytes is the ORIGINAL JPEG stream (embed as-is for 0 loss)
// - isJpeg=false → a lossless (Flate) raster; `sharp` wraps its raw pixels
// complex by nature: walks PDF operators and branches over image encodings to
// pick the largest embedded image; splitting would obscure the scan.
// eslint-disable-next-line complexity
export async function extractBiggestImage(pdfBytes) {
  const document = await PDFDocument.load(pdfBytes);
  let biggest = null;
  for (const [
    ,
    indirectObject,
  ] of document.context.enumerateIndirectObjects()) {
    if (!(indirectObject instanceof PDFRawStream)) {
      continue;
    }
    const dictionary = indirectObject.dict;
    if (dictionary.get(PDFName.of('Subtype'))?.toString() !== '/Image') {
      continue;
    }
    const width = Number(dictionary.get(PDFName.of('Width')));
    const height = Number(dictionary.get(PDFName.of('Height')));
    if (!width || !height) {
      continue;
    }
    const filter = dictionary.get(PDFName.of('Filter'))?.toString() || '';
    const colorSpace =
      dictionary.get(PDFName.of('ColorSpace'))?.toString() || '';
    const pixelArea = width * height;
    if (!biggest || pixelArea > biggest.pixelArea) {
      biggest = {
        stream: indirectObject,
        width,
        height,
        filter,
        colorSpace,
        pixelArea,
      };
    }
  }
  if (!biggest) {
    return null;
  }

  const { stream, width, height, filter, colorSpace } = biggest;
  const streamBytes = Buffer.from(stream.contents);

  if (filter.includes('DCTDecode')) {
    // Original JPEG — hand back the exact bytes and a sharp pipeline over them.
    const channels = colorSpace.includes('Gray') ? 1 : 3;
    return {
      width,
      height,
      isJpeg: true,
      jpegBytes: streamBytes,
      channels,
      sharp: () => sharp(streamBytes),
    };
  }
  if (filter.includes('FlateDecode')) {
    // Lossless raster stored deflated — inflate to raw pixels for sharp.
    const rawPixels = Buffer.from(pako.inflate(streamBytes));
    const channels = Math.max(
      1,
      Math.round(rawPixels.length / (width * height))
    );
    return {
      width,
      height,
      isJpeg: false,
      jpegBytes: null,
      channels,
      sharp: () => sharp(rawPixels, { raw: { width, height, channels } }),
    };
  }
  // Other filters (CCITT/JPX/…): let sharp try the raw stream; caller can fall back.
  return {
    width,
    height,
    isJpeg: false,
    jpegBytes: null,
    channels: 3,
    sharp: () => sharp(streamBytes),
  };
}

// Resize a sharp pipeline so its longest side is <= maxLongest (never upscales).
export function fitLongest(pipeline, sourceWidth, sourceHeight, maxLongest) {
  const longestSide = Math.max(sourceWidth, sourceHeight);
  if (longestSide <= maxLongest) {
    return pipeline;
  }
  const scale = maxLongest / longestSide;
  return pipeline.resize({
    width: Math.round(sourceWidth * scale),
    height: Math.round(sourceHeight * scale),
  });
}

// List every image XObject in a loaded pdf-lib document, with the metadata
// needed to recompress it IN PLACE (we mutate the existing stream — pages,
// text and all other content are left byte-for-byte untouched).
//   returns [{ stream, width, height, filter, colorSpace, bitsPerComponent, byteLength }]
export function listImageStreams(document) {
  const images = [];
  for (const [
    ,
    indirectObject,
  ] of document.context.enumerateIndirectObjects()) {
    if (!(indirectObject instanceof PDFRawStream)) {
      continue;
    }
    const dictionary = indirectObject.dict;
    if (dictionary.get(PDFName.of('Subtype'))?.toString() !== '/Image') {
      continue;
    }
    const width = Number(dictionary.get(PDFName.of('Width')));
    const height = Number(dictionary.get(PDFName.of('Height')));
    if (!width || !height) {
      continue;
    }
    images.push({
      stream: indirectObject,
      width,
      height,
      filter: dictionary.get(PDFName.of('Filter'))?.toString() || '',
      colorSpace: dictionary.get(PDFName.of('ColorSpace'))?.toString() || '',
      bitsPerComponent:
        Number(dictionary.get(PDFName.of('BitsPerComponent'))) || 8,
      byteLength: indirectObject.contents.length,
    });
  }
  return images;
}

// Decode ONE image XObject to its ORIGINAL pixels ONCE, so it can be re-encoded
// at many qualities WITHOUT generational loss (every attempt starts from the
// original pixels, never from an already-compressed JPEG). Returns a reusable source
//   { encodeJpeg(quality) → Buffer, willResize, targetWidth, targetHeight }
// or null if the image can't be safely recompressed in place (masks, exotic
// codecs, palettes, predictors, unexpected raw layout). We never risk
// corrupting the file to save a few KB — when in doubt we skip.
//
// `maxLongestSide` (optional): if the image's longest side exceeds it, every
// encode DOWNSAMPLES to that cap first (keeping the aspect ratio, never
// upscaling). This matters for strict viewers like eFRRO, which refuse to
// render a page whose embedded image is too many megapixels — the accepted
// passport scans are 1280 px on their long side, so that is the safe ceiling.
// complex by nature: guards every unsafe-to-recompress image variant (masks,
// palettes, predictors, exotic codecs) before decoding; the branch ladder is
// the safety contract and reads best in one place.
// eslint-disable-next-line complexity
export async function decodeImageSource(imageEntry, maxLongestSide = Infinity) {
  const { stream, width, height, filter, colorSpace, bitsPerComponent } =
    imageEntry;
  const dictionary = stream.dict;

  if (
    dictionary.get(PDFName.of('SMask')) ||
    dictionary.get(PDFName.of('Mask'))
  ) {
    return null;
  } // transparency mask — skip
  if (
    filter.includes('JPX') ||
    filter.includes('CCITT') ||
    filter.includes('JBIG')
  ) {
    return null;
  } // exotic codecs — skip
  if (
    colorSpace.includes('Indexed') ||
    colorSpace.includes('CMYK') ||
    colorSpace.includes('DeviceN') ||
    colorSpace.includes('Separation')
  ) {
    return null;
  } // palettes/CMYK — skip
  if (
    dictionary.get(PDFName.of('DecodeParms')) ||
    dictionary.get(PDFName.of('DP'))
  ) {
    return null;
  } // predictor — skip

  const streamBytes = Buffer.from(stream.contents);
  let makePipeline; // () → fresh sharp pipeline over the ORIGINAL pixels

  if (filter.includes('DCTDecode')) {
    makePipeline = () => sharp(streamBytes);
  } else if (filter.includes('FlateDecode')) {
    if (bitsPerComponent !== 8) {
      return null;
    } // 1-bit / 16-bit raw — skip
    let rawPixels;
    try {
      rawPixels = Buffer.from(pako.inflate(streamBytes));
    } catch {
      return null;
    } // stream we can't cleanly inflate — leave it unchanged
    // Derive channel count from the ACTUAL inflated length. Covers DeviceGray
    // (1), DeviceRGB (3) and ICCBased streams — more reliable than the CS name.
    const pixelCount = width * height;
    let channels;
    if (rawPixels.length === pixelCount) {
      channels = 1;
    } else if (rawPixels.length === pixelCount * 3) {
      channels = 3;
    } else if (rawPixels.length === pixelCount * 4) {
      channels = 4;
    } else {
      return null;
    } // unexpected layout — skip to stay safe
    makePipeline = () => sharp(rawPixels, { raw: { width, height, channels } });
  } else {
    return null;
  }

  // Prove the source decodes before we commit to using it.
  try {
    await makePipeline().metadata();
  } catch {
    return null;
  }

  // Work out the downsample target (if any): scale the longest side down to
  // maxLongestSide, keep aspect ratio, never upscale.
  const longestSide = Math.max(width, height);
  const willResize = longestSide > maxLongestSide;
  const resizeScale = willResize ? maxLongestSide / longestSide : 1;
  const targetWidth = Math.round(width * resizeScale);
  const targetHeight = Math.round(height * resizeScale);

  return {
    willResize,
    targetWidth,
    targetHeight,
    encodeJpeg(quality) {
      let pipeline = makePipeline();
      if (willResize) {
        pipeline = pipeline.resize({
          width: targetWidth,
          height: targetHeight,
        });
      }
      return pipeline.jpeg({ quality, progressive: false }).toBuffer();
    },
  };
}

// Write a baseline-JPEG buffer into an image XObject's stream IN PLACE, fixing
// its dictionary (Filter/ColorSpace/Width/Height). Only this image's own bytes
// and dict change; every page, its content stream and its text stay untouched.
export async function writeJpegToImageStream(imageEntry, jpegBuffer) {
  const { stream } = imageEntry;
  const dictionary = stream.dict;
  const context = dictionary.context;
  const metadata = await sharp(jpegBuffer).metadata();
  dictionary.set(PDFName.of('Filter'), PDFName.of('DCTDecode'));
  dictionary.delete(PDFName.of('DecodeParms'));
  dictionary.set(PDFName.of('Width'), context.obj(metadata.width));
  dictionary.set(PDFName.of('Height'), context.obj(metadata.height));
  dictionary.set(PDFName.of('BitsPerComponent'), context.obj(8));
  dictionary.set(
    PDFName.of('ColorSpace'),
    PDFName.of(metadata.channels === 1 ? 'DeviceGray' : 'DeviceRGB')
  );
  stream.contents = new Uint8Array(jpegBuffer);
  return jpegBuffer.length;
}
