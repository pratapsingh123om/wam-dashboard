"""
count_vehicles.py
Simple vehicle-type counting on a video using a pretrained YOLOv5 detector + centroid tracker.
Outputs: counts.csv (summary) and per_frame_detections.csv (detailed).
"""

import cv2
import numpy as np
import pandas as pd
import time
from tqdm import tqdm
import torch
from collections import OrderedDict

# --------- Parameters you can tweak ----------
VIDEO_PATH = "input_video.mp4"   # change to your file
OUTPUT_CSV = "counts.csv"
OUTPUT_DET = "per_frame_detections.csv"
FRAME_SKIP = 2          # process every 2nd frame (speed vs accuracy). For 25 fps -> ~12.5 FPS.
CONF_THRESH = 0.4
MAX_DISAPPEARED = 40    # frames before we deregister an object
MAX_DISTANCE = 60       # max centroid distance to match (in pixels) - tweak by resolution
COUNT_LINE_POSITION = 0.5  # fraction of frame height where counting line sits (0..1)
CLASSES_TO_COUNT = ["car","motorcycle","bus","truck","bicycle","autorickshaw","van","person"]  # autorickshaw may not be in default model classes

# ------------------------------------------------

# A very simple centroid tracker (keeps minimal state)
class CentroidTracker:
    def __init__(self, maxDisappeared=50, maxDistance=50):
        self.nextObjectID = 0
        self.objects = OrderedDict()   # objectID -> centroid
        self.bboxes = OrderedDict()    # objectID -> bbox
        self.classes = OrderedDict()   # objectID -> class_name
        self.disappeared = OrderedDict()
        self.counted = OrderedDict()   # objectID -> bool
        self.history = {}              # objectID -> [centroids]
        self.maxDisappeared = maxDisappeared
        self.maxDistance = maxDistance

    def register(self, centroid, bbox, cls):
        self.objects[self.nextObjectID] = centroid
        self.bboxes[self.nextObjectID] = bbox
        self.classes[self.nextObjectID] = cls
        self.disappeared[self.nextObjectID] = 0
        self.counted[self.nextObjectID] = False
        self.history[self.nextObjectID] = [centroid]
        self.nextObjectID += 1

    def deregister(self, objectID):
        del self.objects[objectID]
        del self.bboxes[objectID]
        del self.classes[objectID]
        del self.disappeared[objectID]
        del self.counted[objectID]
        del self.history[objectID]

    def update(self, rects, class_names):
        # rects: list of (startX, startY, endX, endY)
        if len(rects) == 0:
            # mark as disappeared
            for objectID in list(self.disappeared.keys()):
                self.disappeared[objectID] += 1
                if self.disappeared[objectID] > self.maxDisappeared:
                    self.deregister(objectID)
            return self.objects, self.bboxes, self.classes

        inputCentroids = []
        for (startX, startY, endX, endY) in rects:
            cX = int((startX + endX) / 2.0)
            cY = int((startY + endY) / 2.0)
            inputCentroids.append((cX, cY))

        if len(self.objects) == 0:
            for i, centroid in enumerate(inputCentroids):
                self.register(centroid, rects[i], class_names[i])
        else:
            # compute distance matrix between existing objects and new input centroids
            objectIDs = list(self.objects.keys())
            objectCentroids = list(self.objects.values())

            D = np.zeros((len(objectCentroids), len(inputCentroids)), dtype="float")
            for i, oc in enumerate(objectCentroids):
                for j, nc in enumerate(inputCentroids):
                    D[i, j] = np.linalg.norm(np.array(oc) - np.array(nc))

            # greedy matching: find smallest distance pairs
            rows = D.min(axis=1).argsort()
            cols = D.argmin(axis=1)[rows]

            assignedRows, assignedCols = set(), set()
            for (row, col) in zip(rows, cols):
                if row in assignedRows or col in assignedCols:
                    continue
                if D[row, col] > self.maxDistance:
                    continue
                objectID = objectIDs[row]
                # update
                self.objects[objectID] = inputCentroids[col]
                self.bboxes[objectID] = rects[col]
                self.classes[objectID] = class_names[col]
                self.history[objectID].append(inputCentroids[col])
                self.disappeared[objectID] = 0
                assignedRows.add(row)
                assignedCols.add(col)

            # any unassigned objectIDs -> disappeared
            for i, objectID in enumerate(objectIDs):
                if i not in assignedRows:
                    self.disappeared[objectID] += 1
                    if self.disappeared[objectID] > self.maxDisappeared:
                        self.deregister(objectID)

            # any unassigned inputCentroids -> register new object
            for j, centroid in enumerate(inputCentroids):
                if j not in assignedCols:
                    self.register(centroid, rects[j], class_names[j])

        return self.objects, self.bboxes, self.classes

# -----------------------
# Main processing
# -----------------------
def main():
    # load YOLOv5 via torch.hub
    print("Loading model (this may download weights first time)...")
    model = torch.hub.load('ultralytics/yolov5', 'yolov5s', pretrained=True)
    model.conf = CONF_THRESH

    cap = cv2.VideoCapture(VIDEO_PATH)
    if not cap.isOpened():
        print("Error opening video:", VIDEO_PATH)
        return

    W = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    H = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    fps = cap.get(cv2.CAP_PROP_FPS) or 25.0
    total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    print(f"Video: {W}x{H} @ {fps}fps, frames={total_frames}")

    line_y = int(H * COUNT_LINE_POSITION)

    tracker = CentroidTracker(maxDisappeared=MAX_DISAPPEARED, maxDistance=MAX_DISTANCE)
    counts = {}  # class -> count
    frame_records = []  # detailed per-frame record

    frame_idx = 0
    pbar = tqdm(total=total_frames//FRAME_SKIP + 1)

    while True:
        ret, frame = cap.read()
        if not ret:
            break
        frame_idx += 1
        if frame_idx % FRAME_SKIP != 0:
            continue

        # run detection
        results = model(frame)            # results is a yolov5 Results object
        det = results.xyxy[0].cpu().numpy()  # (N,6): x1,y1,x2,y2,conf,cls

        rects = []
        class_names = []
        for *xyxy, conf, cls in det:
            cls = int(cls)
            name = results.names[cls]
            # basic filter - keep vehicle related classes; adapt as needed
            if name not in ["car","motorcycle","bus","truck","bicycle","person","train","boat","truck","bus","traffic light","truck"]:
                # still allow unknown classes; but we'll only count classes in CLASSES_TO_COUNT when summarizing
                pass
            x1, y1, x2, y2 = map(int, xyxy)
            rects.append((x1,y1,x2,y2))
            class_names.append(name)

            # record per-detection
            frame_records.append({
                "frame": frame_idx,
                "x1": x1, "y1": y1, "x2": x2, "y2": y2,
                "conf": float(conf),
                "class": name
            })

        # update tracker
        objects, bboxes, classes = tracker.update(rects, class_names)

        # check crossing line for each tracked object
        for objectID, centroid in objects.items():
            hist = tracker.history[objectID]
            if len(hist) < 2:
                continue
            prev_y = hist[-2][1]
            cur_y = hist[-1][1]
            cls = tracker.classes[objectID]
            # crossing downward
            if (prev_y < line_y) and (cur_y >= line_y) and (not tracker.counted[objectID]):
                counts[cls] = counts.get(cls, 0) + 1
                tracker.counted[objectID] = True
            # crossing upward (if you want to count both directions, handle similarly)
            # elif (prev_y > line_y) and (cur_y <= line_y) and (not tracker.counted[objectID]):
            #     counts[cls] = counts.get(cls, 0) + 1
            #     tracker.counted[objectID] = True

        pbar.update(1)

    pbar.close()
    cap.release()

    # Summarize: only keep desired classes (you can modify)
    summary = []
    for cls, c in counts.items():
        if cls in CLASSES_TO_COUNT:
            summary.append({"class": cls, "count": c})
    # Also add classes we didn't see with zero
    for cls in CLASSES_TO_COUNT:
        if cls not in counts:
            summary.append({"class": cls, "count": 0})

    df = pd.DataFrame(summary).sort_values(by="class")
    df.to_csv(OUTPUT_CSV, index=False)
    pd.DataFrame(frame_records).to_csv(OUTPUT_DET, index=False)
    print("Done. Summary written to", OUTPUT_CSV)
    print(df)

if __name__ == "__main__":
    main()
