/// <reference lib="webworker" />
import PoissonDiskSampling from "poisson-disk-sampling";
import { linearMap } from "./linearMap";

export type NearestPointsWorkerInput = {
  imageData: ImageData;
  pointsBase: [number, number][];
  index: number;
  density: number;
};

function distanceFunction(point: [number, number], imageData: ImageData): number {
  const pixelRedIndex = (Math.round(point[0]) + Math.round(point[1]) * imageData.width) * 4;
  const pixel = imageData.data[pixelRedIndex] / 255;
  return pixel * pixel * pixel;
}

self.onmessage = (e: MessageEvent<NearestPointsWorkerInput>) => {
  const { imageData, pointsBase, index, density } = e.data;

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
  const points = poissonDisk.fill() as [number, number][];

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

  self.postMessage({ nearestPoints, index });
};
