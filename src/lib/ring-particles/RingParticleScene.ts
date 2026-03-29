import { gsap } from "gsap";
import {
  Clock,
  Color,
  DoubleSide,
  Mesh,
  MeshBasicMaterial,
  PerspectiveCamera,
  PlaneGeometry,
  Raycaster,
  Scene,
  Vector2,
  Vector3,
  WebGLRenderer,
} from "three";
import { globalCursor } from "../morphing-particles/globalCursor";
import type { MorphingParticleSceneHost } from "../morphing-particles/types";
import { RingParticlesGPU } from "./RingParticlesGPU";

export type RingParticleSceneOptions = {
  container: HTMLElement;
  theme?: "dark" | "light";
  color1?: string;
  color2?: string;
  color3?: string;
  pixelRatio?: number;
  particlesScale?: number;
  density?: number;
  cameraZoom?: number;
  /** Sim uniforms — defaults match original `rI` ring scene in the bundle. */
  ringWidth?: number;
  ringWidth2?: number;
  ringDisplacement?: number;
  /** World-size raycast plane (original uses 12.5×12.5). */
  raycastPlaneSize?: number;
  interactive?: boolean;
  onLoaded?: (scene: RingParticleScene) => void;
};

/** Scene wrapper for ring-attractor particles (`iI` in the original bundle). */
export class RingParticleScene implements MorphingParticleSceneHost {
  loaded = false;
  color1: string;
  color2: string;
  color3: string;
  options: RingParticleSceneOptions;
  theme: "dark" | "light";
  interactive: boolean;
  background: Color;
  pixelRatio: number;
  particlesScale: number;
  density: number;
  cameraZoom: number;
  onLoadedCallback?: (scene: RingParticleScene) => void;

  isHovering = false;
  hoverProgress = 0;
  pushProgress = 0;

  scene: Scene;
  canvas: HTMLCanvasElement;
  renderer: WebGLRenderer;
  gl: WebGLRenderingContext | WebGL2RenderingContext;
  camera: PerspectiveCamera;
  clock: Clock;
  time = 0;
  lastTime = 0;
  dt = 0;
  skipFrame = false;
  isPaused = false;

  raycaster = new Raycaster();
  mouse = new Vector2();
  intersectionPoint = new Vector3();
  isIntersecting = false;
  mouseIsOver = false;

  raycastPlane: Mesh | null = null;

  colorControls: { color1: string; color2: string; color3: string };

  particles!: RingParticlesGPU;

  /** Bundle `rI` defaults: .107 / .05 / .15 — not the morphing `nI` defaults. */
  ringWidth = 0.107;
  ringWidth2 = 0.05;
  ringDisplacement = 0.15;

  private raycastPlaneSize: number;

  private onWindowResize: () => void;

  constructor(opts: RingParticleSceneOptions) {
    this.options = opts;
    this.color1 = opts.color1 ?? "#aecbfa";
    this.color2 = opts.color2 ?? "#aecbfa";
    this.color3 = opts.color3 ?? "#93bbfc";
    this.theme = opts.theme ?? "dark";
    this.interactive = opts.interactive ?? false;
    this.background = new Color(this.theme === "dark" ? 0x121257 : 0xffffff);
    this.pixelRatio = opts.pixelRatio ?? (typeof window !== "undefined" ? window.devicePixelRatio : 1);
    this.particlesScale = opts.particlesScale ?? 1;
    this.density = opts.density ?? 200;
    this.cameraZoom = opts.cameraZoom ?? 3.1;
    this.ringWidth = opts.ringWidth ?? 0.107;
    this.ringWidth2 = opts.ringWidth2 ?? 0.05;
    this.ringDisplacement = opts.ringDisplacement ?? 0.15;
    this.raycastPlaneSize = opts.raycastPlaneSize ?? 12.5;
    this.onLoadedCallback = opts.onLoaded;

    this.scene = new Scene();
    this.scene.background = this.background;

    this.canvas = document.createElement("canvas");
    opts.container.appendChild(this.canvas);
    this.canvas.width = opts.container.offsetWidth;
    this.canvas.height = opts.container.offsetHeight;

    this.renderer = new WebGLRenderer({
      canvas: this.canvas,
      antialias: true,
      alpha: true,
      powerPreference: "high-performance",
      preserveDrawingBuffer: true,
      stencil: false,
      precision: "highp",
    });
    this.gl = this.renderer.getContext();
    this.renderer.extensions.get("EXT_color_buffer_float");
    this.renderer.setSize(this.canvas.width, this.canvas.height);
    this.renderer.setPixelRatio(this.pixelRatio);

    this.onWindowResize = this.onWindowResizeImpl.bind(this);
    window.addEventListener("resize", this.onWindowResize);

    this.camera = new PerspectiveCamera(
      40,
      this.gl.drawingBufferWidth / this.gl.drawingBufferHeight,
      0.1,
      1000,
    );
    this.camera.position.z = this.cameraZoom;

    this.clock = new Clock();

    this.colorControls =
      this.theme === "dark"
        ? {
            color1: "#7189ff",
            color2: "#3074f9",
            color3: "#000000",
          }
        : {
            color1: this.color1,
            color2: this.color2,
            color3: this.color3,
          };

    this.bootstrap();
  }

  private bootstrap() {
    if (this.interactive) {
      const plane = new Mesh(
        new PlaneGeometry(this.raycastPlaneSize, this.raycastPlaneSize),
        new MeshBasicMaterial({
          transparent: true,
          opacity: 0,
          depthWrite: false,
          side: DoubleSide,
        }),
      );
      plane.position.z = 0;
      this.scene.add(plane);
      this.raycastPlane = plane;
    }

    this.particles = RingParticlesGPU.create(this);
    this.loaded = true;
    this.onLoadedCallback?.(this);
  }

  private onWindowResizeImpl() {
    this.canvas.width = this.options.container.offsetWidth;
    this.canvas.height = this.options.container.offsetHeight;
    this.renderer.setSize(this.canvas.width, this.canvas.height);
    this.camera.aspect = this.canvas.width / this.canvas.height;
    this.camera.updateProjectionMatrix();
    this.particles?.resize();
  }

  onHoverStart() {
    gsap.to(this, { hoverProgress: 1, duration: 0.5, ease: "power3.out" });
    gsap.fromTo(this, { pushProgress: 0 }, { pushProgress: 1, duration: 2, delay: 0.1, ease: "power2.out" });
  }

  onHoverEnd() {
    gsap.to(this, { hoverProgress: 0, duration: 0.5, ease: "power3.out" });
    gsap.fromTo(this, { pushProgress: 0 }, { pushProgress: 1, duration: 2, delay: 0, ease: "power2.out" });
  }

  stop() {
    this.isPaused = true;
    this.clock.stop();
  }

  resume() {
    this.isPaused = false;
    this.clock.start();
  }

  kill() {
    this.stop();
    if (this.loaded && this.particles) {
      this.scene.remove(this.particles.mesh);
      this.particles.kill();
    }
    window.removeEventListener("resize", this.onWindowResize);
    if (this.raycastPlane) {
      this.scene.remove(this.raycastPlane);
      this.raycastPlane.geometry.dispose();
      (this.raycastPlane.material as MeshBasicMaterial).dispose();
    }
    this.renderer.dispose();
    this.canvas.parentElement?.removeChild(this.canvas);
  }

  preRender() {
    this.dt = this.clock.getElapsedTime() - this.lastTime;
    this.lastTime = this.clock.getElapsedTime();
    this.time += this.dt;

    this.particles?.update();

    if (this.interactive && !this.skipFrame) {
      const rect = this.canvas.getBoundingClientRect();
      const c = globalCursor.cursor;
      this.mouse.x = ((c.x - rect.left) * globalCursor.screenWidth) / rect.width;
      this.mouse.y = ((c.y - rect.top) * globalCursor.screenHeight) / rect.height;
      this.mouse.x = (this.mouse.x / globalCursor.screenWidth) * 2 - 1;
      this.mouse.y = -((this.mouse.y / globalCursor.screenHeight) * 2) + 1;
      this.mouseIsOver =
        this.mouse.x >= -1 && this.mouse.x <= 1 && this.mouse.y >= -1 && this.mouse.y <= 1;
    }

    this.skipFrame = !this.skipFrame;

    if (!this.skipFrame && this.raycastPlane) {
      this.raycaster.setFromCamera(this.mouse, this.camera);
      const hits = this.raycaster.intersectObject(this.raycastPlane);
      if (hits.length > 0 && this.mouseIsOver) {
        this.intersectionPoint.copy(hits[0].point);
        this.isIntersecting = true;
      } else {
        this.isIntersecting = false;
      }
    }
  }

  render() {
    if (!this.loaded || this.isPaused) return;
    this.preRender();
    this.renderer.setRenderTarget(null);
    this.renderer.autoClear = false;
    this.renderer.clear();
    this.renderer.render(this.scene, this.camera);
    this.postRender();
  }

  postRender() {
    this.particles?.postRender();
  }
}
