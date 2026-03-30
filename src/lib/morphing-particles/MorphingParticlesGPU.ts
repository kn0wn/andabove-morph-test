import PoissonDiskSampling from "poisson-disk-sampling";
import NearestPointsWorker from "./nearestPoints.worker?worker";
import {
  BufferAttribute,
  BufferGeometry,
  Color,
  DataTexture,
  FloatType,
  Mesh,
  NearestFilter,
  OrthographicCamera,
  PerspectiveCamera,
  PlaneGeometry,
  Points,
  RGBAFormat,
  RepeatWrapping,
  Scene,
  ShaderMaterial,
  Vector2,
  WebGLRenderTarget,
  WebGLRenderer,
} from "three";
import { linearMap } from "./linearMap";
import { SIMPLEX_NOISE_GLSL } from "./simplexNoise.glsl";
import type { MorphingParticleSceneHost } from "./types";

/** Split `arr` into up to `parts` contiguous slices (for parallel nearest-neighbor workers). */
function chunkArray<T>(arr: T[], parts: number): T[][] {
  if (arr.length === 0) return [[]];
  if (parts <= 1) return [arr];
  const size = Math.max(1, Math.ceil(arr.length / parts));
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    out.push(arr.slice(i, i + size));
  }
  return out;
}

export class MorphingParticlesGPU {
  scene: MorphingParticleSceneHost;
  renderer: WebGLRenderer;
  camera: PerspectiveCamera;
  textures: string[];
  lastTime = 0;
  everRendered = false;
  mousePos = new Vector2();
  cursorPos = new Vector2();
  colorScheme: number;
  particleScale: number;

  pointsBaseData: [number, number][] = [];
  pointsData: number[] = [];
  nearestPointsData: number[][] = [];
  count = 0;

  size = 256;
  length = 0;
  posTex!: DataTexture;
  posNearestTex!: DataTexture;
  rt1!: WebGLRenderTarget;
  rt2!: WebGLRenderTarget;

  simScene!: Scene;
  simCamera!: OrthographicCamera;
  simMaterial!: ShaderMaterial;
  renderMaterial!: ShaderMaterial;
  mesh!: Points;

  constructor(scene: MorphingParticleSceneHost, textures: string[]) {
    this.scene = scene;
    this.renderer = scene.renderer;
    this.camera = scene.camera;
    this.textures = textures;
    this.colorScheme = scene.theme === "dark" ? 0 : 1;
    this.particleScale =
      scene.renderer.domElement.width / scene.pixelRatio / 2000 * scene.particlesScale;
  }

  static async create(scene: MorphingParticleSceneHost, textures: string[]) {
    const p = new MorphingParticlesGPU(scene, textures);
    p.createPoints();
    await p.createPointsFromImage();
    p.init();
    return p;
  }

  private getImageData(url: string): Promise<ImageData> {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.crossOrigin = "anonymous";
      img.src = url;
      img.onload = () => {
        const c = document.createElement("canvas");
        c.width = 500;
        c.height = 500;
        const ctx = c.getContext("2d")!;
        ctx.drawImage(img, 0, 0, 500, 500);
        resolve(ctx.getImageData(0, 0, 500, 500));
      };
      img.onerror = reject;
    });
  }

  createPoints() {
    const pds = new PoissonDiskSampling({
      shape: [500, 500],
      minDistance: linearMap(this.scene.density, 0, 300, 10, 2),
      maxDistance: linearMap(this.scene.density, 0, 300, 11, 3),
      tries: 20,
    });
    const t = pds.fill() as [number, number][];
    this.pointsBaseData = t;
    this.pointsData = [];
    for (let i = 0; i < t.length; i++) {
      this.pointsData.push(t[i][0] - 250, t[i][1] - 250);
    }
    this.count = this.pointsData.length / 2;
  }

  async createPointsFromImage() {
    const images: ImageData[] = [];
    for (let r = 0; r < this.textures.length; r++) {
      images.push(await this.getImageData(this.textures[r]));
    }
    this.nearestPointsData = [];

    /** Parallel nearest pass count (Poisson runs once per mask, then N workers × same inner loop). */
    const parallelNearest = Math.min(
      8,
      Math.max(1, typeof navigator !== "undefined" && navigator.hardwareConcurrency
        ? navigator.hardwareConcurrency - 1
        : 3),
    );

    for (let r = 0; r < images.length; r++) {
      const imageData = images[r];
      const points = await this.runPoissonPhaseWorker(imageData);
      const slices = chunkArray(this.pointsBaseData, parallelNearest);
      const partials = await Promise.all(
        slices.map((slice) => this.runNearestChunkWorker(points, imageData, slice, r)),
      );
      this.nearestPointsData.push(partials.flat());
    }
  }

  /** Phase 1: variable-density Poisson (slow; once per texture). */
  private runPoissonPhaseWorker(imageData: ImageData): Promise<[number, number][]> {
    return new Promise((resolve, reject) => {
      const worker = new NearestPointsWorker();
      worker.onmessage = (ev: MessageEvent<{ phase: string; points?: [number, number][] }>) => {
        const { phase, points } = ev.data;
        worker.terminate();
        if (phase !== "poisson" || !points) {
          reject(new Error("nearestPoints worker: expected poisson phase"));
          return;
        }
        resolve(points);
      };
      worker.onerror = (err) => {
        worker.terminate();
        reject(err);
      };
      worker.postMessage({
        phase: "poisson",
        imageData,
        density: this.scene.density,
      });
    });
  }

  /** Phase 2: original O(n×m) inner loop for one slice of base points (run many in parallel). */
  private runNearestChunkWorker(
    points: [number, number][],
    imageData: ImageData,
    pointsBase: [number, number][],
    textureIndex: number,
  ): Promise<number[]> {
    return new Promise((resolve, reject) => {
      const worker = new NearestPointsWorker();
      worker.onmessage = (ev: MessageEvent<{ phase: string; nearestPoints?: number[] }>) => {
        const { phase, nearestPoints } = ev.data;
        worker.terminate();
        if (phase !== "nearest" || !nearestPoints) {
          reject(new Error("nearestPoints worker: expected nearest phase"));
          return;
        }
        resolve(nearestPoints);
      };
      worker.onerror = (err) => {
        worker.terminate();
        reject(err);
      };
      worker.postMessage({
        phase: "nearest",
        points,
        imageData,
        pointsBase,
        textureIndex,
      });
    });
  }

  createDataTexturePosition(flat: number[]): DataTexture {
    const data = new Float32Array(this.length * 4);
    for (let r = 0; r < this.count; r++) {
      const o = r * 4;
      data[o + 0] = flat[r * 2 + 0] * (1 / 250);
      data[o + 1] = flat[r * 2 + 1] * (1 / 250);
      data[o + 2] = 0;
      data[o + 3] = 0;
    }
    const tex = new DataTexture(data, this.size, this.size, RGBAFormat, FloatType);
    tex.needsUpdate = true;
    return tex;
  }

  createRenderTarget(): WebGLRenderTarget {
    return new WebGLRenderTarget(this.size, this.size, {
      wrapS: RepeatWrapping,
      wrapT: RepeatWrapping,
      minFilter: NearestFilter,
      magFilter: NearestFilter,
      format: RGBAFormat,
      type: FloatType,
      depthBuffer: false,
      stencilBuffer: false,
    });
  }

  setPointsTextureFromIndex(i: number) {
    this.posNearestTex = this.createDataTexturePosition(this.nearestPointsData[i]);
    this.posNearestTex.needsUpdate = true;
    (this.simMaterial.uniforms as Record<string, { value: unknown }>).uPosNearest.value =
      this.posNearestTex;
  }

  init() {
    this.size = 256;
    this.length = this.size * this.size;
    this.posTex = this.createDataTexturePosition(this.pointsData);
    this.posNearestTex = this.createDataTexturePosition(this.nearestPointsData[0]);
    this.rt1 = this.createRenderTarget();
    this.rt2 = this.createRenderTarget();

    this.renderer.setRenderTarget(this.rt1);
    this.renderer.setClearColor(0, 0);
    this.renderer.clear();
    this.renderer.setRenderTarget(this.rt2);
    this.renderer.setClearColor(0, 0);
    this.renderer.clear();
    this.renderer.setRenderTarget(null);

    const simSize = this.size.toFixed(1);
    this.simScene = new Scene();
    this.simCamera = new OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this.simMaterial = new ShaderMaterial({
      uniforms: {
        uPosition: { value: this.posTex },
        uPosRefs: { value: this.posTex },
        uPosNearest: { value: this.posNearestTex },
        uMousePos: { value: new Vector2(0, 0) },
        uRingRadius: { value: 0.2 },
        uDeltaTime: { value: 0 },
        uRingWidth: { value: 0.05 },
        uRingWidth2: { value: 0.015 },
        uIsHovering: { value: 0 },
        uRingDisplacement: { value: this.scene.ringDisplacement },
        uTime: { value: 0 },
      },
      vertexShader: `
        void main() {
          gl_Position = vec4(position, 1.0);
        }
      `,
      fragmentShader: `
        precision highp float;
        uniform sampler2D uPosition;
        uniform sampler2D uPosRefs;
        uniform sampler2D uPosNearest;

        uniform vec2 uMousePos;
        uniform float uTime;
        uniform float uDeltaTime;
        uniform float uIsHovering;

        vec2 hash( vec2 p ){
          p = vec2( dot(p,vec2(2127.1,81.17)), dot(p,vec2(1269.5,283.37)) );
          return fract(sin(p)*43758.5453);
        }

        void main() {
          vec2 simTexCoords = gl_FragCoord.xy / vec2(${simSize}, ${simSize});
          vec4 pFrame = texture2D(uPosition, simTexCoords);

          float scale = pFrame.z;
          float velocity = pFrame.w;
          vec2 refPos = texture2D(uPosRefs, simTexCoords).xy;
          vec2 nearestPos = texture2D(uPosNearest, simTexCoords).xy;
          float seed = hash(simTexCoords).x;
          float seed2 = hash(simTexCoords).y;

          float time = uTime * .5;
          float lifeEnd = 3. + sin(seed2 * 100.) * 1.;
          float lifeTime = mod((seed * 100.) + time, lifeEnd);

          vec2 disp = vec2(0., 0.);
          vec2 pos = pFrame.xy;

          float distRadius = 0.15;

          vec2 targetPos = refPos;
          targetPos = mix(targetPos, nearestPos, uIsHovering * uIsHovering);

          vec2 direction = normalize(targetPos - pos);
          direction *= .01;

          float dist = length(targetPos - pos);
          float distStrength = smoothstep(distRadius, 0., dist);

          if(dist > 0.005){
            pos += direction * distStrength;
          }

          if(lifeTime < .01){
            pos = refPos;
            pFrame.xy = refPos;
            scale = 0.;
          }

          float targetScale = smoothstep(.01, 0.5, lifeTime) - smoothstep(0.5, 1., lifeTime/lifeEnd);
          targetScale += smoothstep(0.1, 0., smoothstep(0.001, .1, dist)) * 1.5 * uIsHovering;

          float scaleDiff = targetScale - scale;
          scaleDiff *= .1;
          scale += scaleDiff;

          vec2 finalPos = pos + (disp * smoothstep(0.001, distRadius, dist));
          vec2 diff = finalPos - pFrame.xy;
          diff *= .2;

          velocity = smoothstep(distRadius, .001, dist) * uIsHovering;

          vec4 frame = vec4(pFrame.xy + diff, scale, velocity);

          gl_FragColor = frame;
        }
      `,
    });

    const quad = new Mesh(new PlaneGeometry(2, 2), this.simMaterial);
    this.simScene.add(quad);

    const geom = new BufferGeometry();
    const uv = new Float32Array(this.count * 2);
    const position = new Float32Array(this.count * 3);
    const seeds = new Float32Array(this.count * 4);
    for (let s = 0; s < this.count; s++) {
      const a = s % this.size;
      const l = Math.floor(s / this.size);
      uv[s * 2] = a / this.size;
      uv[s * 2 + 1] = l / this.size;
    }
    for (let s = 0; s < this.count; s++) {
      seeds[s * 4] = Math.random();
      seeds[s * 4 + 1] = Math.random();
      seeds[s * 4 + 2] = Math.random();
      seeds[s * 4 + 3] = Math.random();
    }
    geom.setAttribute("position", new BufferAttribute(position, 3));
    geom.setAttribute("uv", new BufferAttribute(uv, 2));
    geom.setAttribute("seeds", new BufferAttribute(seeds, 4));

    const noise = SIMPLEX_NOISE_GLSL;

    this.renderMaterial = new ShaderMaterial({
      uniforms: {
        uPosition: { value: this.posTex },
        uTime: { value: 0 },
        uColor1: { value: new Color(this.scene.colorControls.color1) },
        uColor2: { value: new Color(this.scene.colorControls.color2) },
        uColor3: { value: new Color(this.scene.colorControls.color3) },
        uAlpha: { value: 1 },
        uIsHovering: { value: 0 },
        uPulseProgress: { value: 0 },
        uMousePos: { value: new Vector2(0, 0) },
        uRez: {
          value: new Vector2(this.scene.renderer.domElement.width, this.scene.renderer.domElement.height),
        },
        uParticleScale: { value: this.particleScale },
        uPixelRatio: { value: this.scene.pixelRatio },
        uColorScheme: { value: this.colorScheme },
      },
      vertexShader: `
        precision highp float;
        attribute vec4 seeds;

        uniform sampler2D uPosition;
        uniform float uTime;
        uniform float uParticleScale;
        uniform float uPixelRatio;
        uniform int uColorScheme;
        uniform float uIsHovering;
        uniform float uPulseProgress;

        varying vec4 vSeeds;
        varying float vVelocity;
        varying vec2 vLocalPos;
        varying vec2 vScreenPos;
        varying float vScale;

        ${noise}

        void main() {
          vec4 pos = texture2D(uPosition, uv);
          vSeeds = seeds;

          float noiseX = snoise(vec3( vec2(pos.xy * 10.), uTime * .2 + 100.));
          float noiseY = snoise(vec3( vec2(pos.xy * 10.), uTime * .2));

          float noiseX2 = snoise(vec3( vec2(pos.xy * .5), uTime * .15 + 45.));
          float noiseY2 = snoise(vec3( vec2(pos.xy * .5), uTime * .15 + 87.));

          float cDist = length(pos.xy) * 1.;
          float progress = uPulseProgress;
          float t = smoothstep(progress - .25, progress, cDist) - smoothstep(progress, progress + .25, cDist);
          t *= smoothstep(1., .0, cDist);
          pos.xy *= 1. + (t * .02);

          float dist = smoothstep(0., 0.9, pos.w);
          dist = mix(0., dist, uIsHovering);

          pos.y += noiseY * 0.005 * dist;
          pos.x += noiseX * 0.005 * dist;
          pos.y += noiseY2 * 0.02;
          pos.x += noiseX2 * 0.02;

          vVelocity = pos.w;
          vScale = pos.z;
          vLocalPos = pos.xy;
          vec4 viewSpace  = modelViewMatrix * vec4(vec3(pos.xy, 0.), 1.0);

          gl_Position = projectionMatrix * viewSpace;
          vScreenPos = gl_Position.xy;

          float minScale = .25;
          minScale += float(uColorScheme) * .75;

          gl_PointSize = ((vScale * 7.) * (uPixelRatio * 0.5) * uParticleScale) + (minScale * uPixelRatio);
        }
      `,
      fragmentShader: `
        precision highp float;

        varying vec4 vSeeds;
        varying vec2 vScreenPos;
        varying vec2 vLocalPos;
        varying float vScale;
        varying float vVelocity;

        uniform vec3 uColor1;
        uniform vec3 uColor2;
        uniform vec3 uColor3;

        uniform vec2 uMousePos;
        uniform vec2 uRez;

        uniform float uAlpha;
        uniform float uTime;

        uniform int uColorScheme;

        ${noise}

        float sdRoundBox( in vec2 p, in vec2 b, in vec4 r )
        {
          r.xy = (p.x>0.0)?r.xy : r.zw;
          r.x  = (p.y>0.0)?r.x  : r.y;
          vec2 q = abs(p)-b+r.x;
          return min(max(q.x,q.y),0.0) + length(max(q,0.0)) - r.x;
        }

        vec2 rotate(vec2 v, float a) {
          float s = sin(a);
          float c = cos(a);
          mat2 m = mat2(c, s, -s, c);
          return m * v;
        }

        void main() {
          float uBorderSize = 0.2;
          vec2 ratioVec = uRez;
          float ratio = ratioVec.x / ratioVec.y;

          vec2 uv = gl_PointCoord.xy;
          uv -= vec2(0.5);
          uv.y *= -1.;

          vec2 tuv = vScreenPos;
          tuv = rotate(tuv, uTime * 1.);
          tuv.y *= 1./ratio;
          tuv += .5;

          float h = 0.8;
          float progress = vVelocity;
          vec3 col = mix(mix(uColor1, uColor2, progress/h), mix(uColor2, uColor3, (progress - h)/(1.0 - h)), step(h, progress));
          vec3 color = col;

          float dist = sqrt(dot(uv, uv));

          float dr = .5;
          float t = smoothstep(dr+(uBorderSize + .0001), dr-uBorderSize, dist);
          t = clamp(t, 0., 1.);

          float rounded = sdRoundBox(uv, vec2(0.5, 0.2), vec4(.25));
          rounded = smoothstep(.1, 0., rounded);

          float disc = smoothstep(.5, .45, length(uv));

          float a = uAlpha * disc * smoothstep(0.1, 0.2, vScale);

          if(a < 0.01){
            discard;
          }

          color = clamp(color, 0., 1.);
          color = mix(color, color * clamp(vVelocity, 0., 1.), float(uColorScheme));

          gl_FragColor = vec4(color, clamp(a, 0., 1.));
        }
      `,
      transparent: true,
      depthTest: false,
      depthWrite: false,
    });

    this.mesh = new Points(geom, this.renderMaterial);
    this.mesh.position.set(0, 0, 0);
    this.mesh.scale.set(5, -5, 5);
    this.scene.scene.add(this.mesh);
  }

  resize() {
    const u = this.renderMaterial.uniforms as Record<string, { value: unknown }>;
    u.uRez.value = new Vector2(this.scene.renderer.domElement.width, this.scene.renderer.domElement.height);
    u.uPixelRatio.value = this.scene.pixelRatio;
    this.renderMaterial.needsUpdate = true;
  }

  update() {
    const e = this.scene.clock.getElapsedTime() - this.lastTime;
    this.lastTime = this.scene.clock.getElapsedTime();
    this.mousePos.set(
      this.scene.intersectionPoint.x * 0.175,
      this.scene.intersectionPoint.y * 0.175,
    );
    this.particleScale =
      this.scene.renderer.domElement.width / this.scene.pixelRatio / 2000 * this.scene.particlesScale;

    const sim = this.simMaterial.uniforms as Record<string, { value: unknown }>;
    sim.uPosition.value = this.everRendered ? this.rt1.texture : this.posTex;
    sim.uTime.value = this.scene.clock.getElapsedTime();
    sim.uDeltaTime.value = e;
    sim.uRingRadius.value = 0.175 + Math.sin(this.scene.time * 1) * 0.03 + Math.cos(this.scene.time * 3) * 0.02;
    sim.uMousePos.value = this.mousePos;
    sim.uRingWidth.value = this.scene.ringWidth;
    sim.uRingWidth2.value = this.scene.ringWidth2;
    sim.uRingDisplacement.value = this.scene.ringDisplacement;
    sim.uIsHovering.value = this.scene.hoverProgress;
    sim.uPosNearest.value = this.posNearestTex;

    this.renderer.setRenderTarget(this.rt2);
    this.renderer.render(this.simScene, this.simCamera);
    this.renderer.setRenderTarget(null);

    const ren = this.renderMaterial.uniforms as Record<string, { value: unknown }>;
    ren.uPosition.value = this.everRendered ? this.rt2.texture : this.posTex;
    ren.uTime.value = this.scene.clock.getElapsedTime();
    ren.uMousePos.value = this.mousePos;
    ren.uParticleScale.value = this.particleScale;
    ren.uIsHovering.value = this.scene.hoverProgress;
    ren.uPulseProgress.value = this.scene.pushProgress;
  }

  postRender() {
    const tmp = this.rt1;
    this.rt1 = this.rt2;
    this.rt2 = tmp;
    this.everRendered = true;
  }

  kill() {
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
    this.rt1.dispose();
    this.rt2.dispose();
    this.posTex.dispose();
    this.simMaterial.dispose();
    this.renderMaterial.dispose();
  }
}
