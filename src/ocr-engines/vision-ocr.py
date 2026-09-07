#!/usr/bin/env python3
"""Reads all text from an image using the macOS Vision framework.

Vision is a general OCR engine built into the operating system, so it reads the
whole page rather than a hardcoded region. That matters for a passport, whose
printed zone sits on a security pattern that defeats simpler engines.

Prints {"lines": [...]} on stdout, in reading order.
"""
import sys
import json


def read_lines(path, accurate=True):
    import Vision
    import Quartz
    from Foundation import NSURL

    url = NSURL.fileURLWithPath_(path)
    source = Quartz.CGImageSourceCreateWithURL(url, None)
    if source is None:
        raise RuntimeError(f"could not open {path}")
    image = Quartz.CGImageSourceCreateImageAtIndex(source, 0, None)

    request = Vision.VNRecognizeTextRequest.alloc().init()
    # 0 selects the accurate recognizer; 1 is the fast one.
    request.setRecognitionLevel_(0 if accurate else 1)
    # Names and MRZ codes are not dictionary words, and correction rewrites them.
    request.setUsesLanguageCorrection_(False)

    handler = Vision.VNImageRequestHandler.alloc().initWithCGImage_options_(
        image, None
    )
    handler.performRequests_error_([request], None)

    lines = []
    for observation in request.results() or []:
        candidates = observation.topCandidates_(1)
        if candidates and len(candidates):
            lines.append(candidates[0].string())
    return lines


if __name__ == "__main__":
    accurate = "--fast" not in sys.argv
    targets = [a for a in sys.argv[1:] if not a.startswith("--")]
    if not targets:
        sys.stderr.write("usage: vision-ocr.py [--fast] <image>\n")
        sys.exit(2)
    print(json.dumps({"lines": read_lines(targets[0], accurate)}))
