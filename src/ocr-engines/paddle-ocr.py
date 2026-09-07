#!/usr/bin/env python3
"""Reads all text from an image using PaddleOCR.

A general OCR engine that reads the whole page. On Apple Silicon it runs on CPU:
PaddlePaddle ships no Metal or CUDA build for this platform, so there is no GPU
option to enable.

Inference cost scales with the area searched, so `--band` narrows the search to
the bottom strip of the page where a passport's machine-readable zone sits. That
is about six times faster and, on the passports measured, just as accurate.

Prints {"lines": [...]} on stdout.
"""
import sys
import json
import contextlib
import tempfile
import os


_ENGINE = None


def get_engine():
    """Builds the engine once, since loading its models dominates the runtime."""
    global _ENGINE
    if _ENGINE is None:
        from paddleocr import PaddleOCR

        # Angle classification and document unwarping are off: a passport scan
        # is already upright and flat, and each costs a model load.
        _ENGINE = PaddleOCR(
            use_textline_orientation=False,
            use_doc_orientation_classify=False,
            use_doc_unwarping=False,
            lang="en",
        )
    return _ENGINE


def crop_band(path, top=0.83):
    """Writes the bottom strip of an image to a temporary file and returns it.

    The default keeps a margin above the machine-readable zone. Cropping tighter
    clips the tops of the glyphs, which cost a leading letter of a name on one
    of the passports measured.
    """
    from PIL import Image

    with Image.open(path) as image:
        width, height = image.size
        band = image.crop((0, int(height * top), width, height))
        handle, out = tempfile.mkstemp(suffix=".jpg")
        os.close(handle)
        band.save(out, quality=95)
    return out


def read_lines(path, band=False):
    target = crop_band(path) if band else path
    try:
        result = get_engine().predict(target)
    finally:
        if band and os.path.exists(target):
            os.unlink(target)

    lines = []
    for page in result or []:
        texts = page.get("rec_texts") if isinstance(page, dict) else None
        if texts:
            lines.extend(texts)
    return lines


if __name__ == "__main__":
    # The library logs to stdout, which would corrupt the JSON.
    band = "--band" in sys.argv
    targets = [a for a in sys.argv[1:] if not a.startswith("--")]
    with contextlib.redirect_stdout(sys.stderr):
        results = [read_lines(target, band) for target in targets]
    if len(results) == 1:
        print(json.dumps({"lines": results[0]}))
    else:
        print(json.dumps({"pages": results}))
