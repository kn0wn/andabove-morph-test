/// <reference lib="webworker" />
import PoissonDiskSampling from "poisson-disk-sampling";
import { linearMap } from "./linearMap";

/** Phase 1: luminance-weighted Poisson field (expensive; run once per mask). */
export type NearestWorkerPoissonMsg = {
  phase: "poisson";
  imageData: ImageData;
  density: number;
};

/** Phase 2: nearest snap targets for a slice of base points (parallelize many of these). */
export type NearestWorkerChunkMsg = {
  phase: "nearest";
  points: [number, number][];
  imageData: ImageData;
  pointsBase: [number, number][];
  /** Texture index in the original textures[] array */
  textureIndex: number;
};

export type NearestWorkerIn = NearestWorkerPoissonMsg | NearestWorkerChunkMsg;

function distanceFunction(point: [number, number], imageData: ImageData): number {
  const pixelRedIndex = (Math.round(point[0]) + Math.round(point[1]) * imageData.width) * 4;
  const pixel = imageData.data[pixelRedIndex] / 255;
  return pixel * pixel * pixel;
}

function runPoisson(imageData: ImageData, density: number): [number, number][] {
  const maxDistance = linearMap(density, 0, 300, 10, 50);
  const poissonDisk = new PoissonDiskSampling({
    shape: [500, 500],
    minDistance: 1,
    maxDistance,
    tries: 20,
    distanceFunction(point: [number, number]) {
      return distanceFunction(point, imageData);
    },
  });
  return poissonDisk.fill() as [number, number][];
}

/** Same inner loop as the original bundle — preserves hover “snap to mask” behavior. */
function runNearestForSlice(
  points: [number, number][],
  imageData: ImageData,
  pointsBase: [number, number][],
): number[] {
  const nearestPoints: number[] = [];
  for (let i = 0; i < pointsBase.length; i++) {
    let nearestPoint: [number, number] | null = null;
    let nearestDistance = Infinity;
    for (let j = 0; j < points.length; j++) {
      if (Math.random() < 0.75) continue;
      const distance = Math.sqrt(
        (points[j][0] - pointsBase[i][0]) ** 2 + (points[j][1] - pointsBase[i][1]) ** 2,
      );
      const pixelRedValue = distanceFunction(points[j], imageData);
      if (pixelRedValue < 1 && distance < nearestDistance) {
        nearestDistance = distance;
        nearestPoint = points[j];
      }
    }
    const px = nearestPoint ? nearestPoint[0] - 250 : pointsBase[i][0] - 250;
    const py = nearestPoint ? nearestPoint[1] - 250 : pointsBase[i][1] - 250;
    nearestPoints.push(px, py);
  }
  return nearestPoints;
}

self.onmessage = (e: MessageEvent<NearestWorkerIn>) => {
  const msg = e.data;
  if (msg.phase === "poisson") {
    const points = runPoisson(msg.imageData, msg.density);
    self.postMessage({ phase: "poisson", points });
    return;
  }
  if (msg.phase === "nearest") {
    const nearestPoints = runNearestForSlice(msg.points, msg.imageData, msg.pointsBase);
    self.postMessage({ phase: "nearest", nearestPoints, textureIndex: msg.textureIndex });
  }
};
