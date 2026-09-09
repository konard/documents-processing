#!/usr/bin/env python3
"""Finds faces in an image using the macOS Vision framework.

A portrait for the e-visa is one face, looking straight ahead, filling much of
the frame. A screenshot of a hotel booking has none, and a passport data page
has one small face beside a great deal of print. Telling those apart is what
keeps a booking screenshot out of the portrait upload.

Prints {"faces": [{"width": w, "height": h, "area": a}, ...]} on stdout, each
box given as a fraction of the image, largest first.
"""
import sys
import json


def find_faces(path):
    import Vision
    import Quartz
    from Foundation import NSURL

    url = NSURL.fileURLWithPath_(path)
    source = Quartz.CGImageSourceCreateWithURL(url, None)
    if source is None:
        raise RuntimeError(f"could not open {path}")
    image = Quartz.CGImageSourceCreateImageAtIndex(source, 0, None)

    request = Vision.VNDetectFaceRectanglesRequest.alloc().init()
    handler = Vision.VNImageRequestHandler.alloc().initWithCGImage_options_(
        image, None
    )
    ok, error = handler.performRequests_error_([request], None)
    if not ok:
        raise RuntimeError(str(error))

    faces = []
    for observation in request.results() or []:
        box = observation.boundingBox()
        # Vision reports the box as a fraction of the image already.
        width = float(box.size.width)
        height = float(box.size.height)
        faces.append({"width": width, "height": height, "area": width * height})
    faces.sort(key=lambda face: face["area"], reverse=True)
    return faces


def main():
    if len(sys.argv) < 2:
        print(json.dumps({"error": "usage: vision-faces.py <image>"}))
        return 1
    try:
        print(json.dumps({"faces": find_faces(sys.argv[1])}))
        return 0
    except Exception as error:  # noqa: BLE001 - reported to the caller as JSON
        print(json.dumps({"error": str(error)}))
        return 1


if __name__ == "__main__":
    sys.exit(main())
