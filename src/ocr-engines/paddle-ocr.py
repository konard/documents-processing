#!/usr/bin/env python3
"""Reads all text from an image using PaddleOCR.

A general OCR engine that reads the whole page. It runs on CPU, so it needs no
GPU and no network once the models are cached locally.

Prints {"lines": [...]} on stdout.
"""
import sys
import json
import contextlib


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


def read_lines(path):
    result = get_engine().predict(path)

    lines = []
    for page in result or []:
        texts = page.get("rec_texts") if isinstance(page, dict) else None
        if texts:
            lines.extend(texts)
    return lines


if __name__ == "__main__":
    # The library logs to stdout, which would corrupt the JSON.
    with contextlib.redirect_stdout(sys.stderr):
        results = [read_lines(target) for target in sys.argv[1:]]
    if len(results) == 1:
        print(json.dumps({"lines": results[0]}))
    else:
        print(json.dumps({"pages": results}))
