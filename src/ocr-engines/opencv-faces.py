#!/usr/bin/env python3
"""Find faces with OpenCV when macOS Vision cannot start its model."""

import json
import sys


def find_faces(path):
    import cv2

    image = cv2.imread(path)
    if image is None:
        raise RuntimeError(f"could not open {path}")
    height, width = image.shape[:2]
    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    gray = cv2.equalizeHist(gray)
    cascade = cv2.CascadeClassifier(
        cv2.data.haarcascades + "haarcascade_frontalface_default.xml"
    )
    boxes = cascade.detectMultiScale(
        gray,
        scaleFactor=1.1,
        minNeighbors=5,
        minSize=(max(30, width // 15), max(30, height // 15)),
    )
    faces = [
        {
            "width": float(face_width / width),
            "height": float(face_height / height),
            "area": float(face_width * face_height / (width * height)),
        }
        for _, _, face_width, face_height in boxes
    ]
    faces.sort(key=lambda face: face["area"], reverse=True)
    return faces


def main():
    if len(sys.argv) < 2:
        print(json.dumps({"error": "usage: opencv-faces.py <image>"}))
        return 1
    try:
        print(json.dumps({"faces": find_faces(sys.argv[1])}))
        return 0
    except Exception as error:  # noqa: BLE001 - returned as structured data
        print(json.dumps({"error": str(error)}))
        return 1


if __name__ == "__main__":
    sys.exit(main())
