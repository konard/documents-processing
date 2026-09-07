#!/usr/bin/env python3
"""Reads all text from an image using RapidOCR (ONNX runtime).

A general, cross-platform OCR engine: it reads the whole page, so both the
printed zone and the machine-readable zone come from one pass.

Prints {"lines": [...]} on stdout.
"""
import sys
import json


def read_lines(path):
    from rapidocr_onnxruntime import RapidOCR

    engine = RapidOCR()
    result, _ = engine(path)
    return [row[1] for row in (result or [])]


if __name__ == "__main__":
    print(json.dumps({"lines": read_lines(sys.argv[1])}))
