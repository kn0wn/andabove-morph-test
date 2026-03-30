import type { Color, OrthographicCamera, Scene, Vector3, WebGLRenderer } from "three";

/** Subset of the original Angular scene object passed into GPU particles (`nI`). */
export type MorphingParticleSceneHost = {
  theme: "dark" | "light" | string;
  renderer: WebGLRenderer;
  scene: Scene;
  camera: OrthographicCamera;
  clock: { getElapsedTime(): number };
  /** Mapped density → Poisson min/max distances */
  density: number;
  particlesScale: number;
  pixelRatio: number;
  colorControls: { color1: string; color2: string; color3: string };
  time: number;
  hoverProgress: number;
  pushProgress: number;
  isIntersecting: boolean;
  intersectionPoint: Vector3;
  /** Shader uniforms — match original defaults from sim material init */
  ringWidth: number;
  ringWidth2: number;
  ringDisplacement: number;
};
