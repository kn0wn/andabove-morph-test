import PoissonDiskSampling from "poisson-disk-sampling";
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
import { linearMap } from "../morphing-particles/linearMap";
import { SIMPLEX_NOISE_GLSL } from "../morphing-particles/simplexNoise.glsl";
import { ValueNoise1D } from "../morphing-particles/valueNoise1d";
import type { MorphingParticleSceneHost } from "../morphing-particles/types";

/**
 * Ring-attractor GPU particles (`iI` in the original site bundle).
 * No image masks — Poisson disk + ring field + simplex noise in the sim pass.
 */
export class RingParticlesGPU {
  scene: MorphingParticleSceneHost;
  renderer: WebGLRenderer;
  camera: PerspectiveCamera;
  lastTime = 0;
  everRendered = false;
  ringPos = new Vector2(0, 0);
  cursorPos = new Vector2(0, 0);
  colorScheme: number;
  particleScale: number;

  pointsData: number[] = [];
  count = 0;

  size = 256;
  length = 0;
  posTex!: DataTexture;
  rt1!: WebGLRenderTarget;
  rt2!: WebGLRenderTarget;

  noise: ValueNoise1D;

  simScene!: Scene;
  simCamera!: OrthographicCamera;
  simMaterial!: ShaderMaterial;
  renderMaterial!: ShaderMaterial;
  mesh!: Points;

  constructor(scene: MorphingParticleSceneHost) {
    this.scene = scene;
    this.renderer = scene.renderer;
    this.camera = scene.camera;
    this.colorScheme = scene.theme === "dark" ? 0 : 1;
    this.particleScale =
      scene.renderer.domElement.width / scene.pixelRatio / 2000 * scene.particlesScale;
    this.noise = new ValueNoise1D();
  }

  static create(scene: MorphingParticleSceneHost) {
    const p = new RingParticlesGPU(scene);
    p.createPoints();
    p.init();
    return p;
  }

  createPoints() {
    const pds = new PoissonDiskSampling({
      shape: [500, 500],
      minDistance: linearMap(this.scene.density, 0, 300, 10, 2),
      maxDistance: linearMap(this.scene.density, 0, 300, 11, 3),
      tries: 20,
    });
    const t = pds.fill() as [number, number][];
    this.pointsData = [];
    for (let i = 0; i < t.length; i++) {
      this.pointsData.push(t[i][0] - 250, t[i][1] - 250);
    }
    this.count = this.pointsData.length / 2;
  }

  createDataTexturePosition(): DataTexture {
    const data = new Float32Array(this.length * 4);
    for (let i = 0; i < this.count; i++) {
      const r = i * 4;
      data[r + 0] = this.pointsData[i * 2 + 0] * (1 / 250);
      data[r + 1] = this.pointsData[i * 2 + 1] * (1 / 250);
      data[r + 2] = 0;
      data[r + 3] = 0;
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

  init() {
    this.size = 256;
    this.length = this.size * this.size;
    this.posTex = this.createDataTexturePosition();
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
    const noise = SIMPLEX_NOISE_GLSL;

    this.simScene = new Scene();
    this.simCamera = new OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this.simMaterial = new ShaderMaterial({
      uniforms: {
        uPosition: { value: this.posTex },
        uPosRefs: { value: this.posTex },
        uRingPos: { value: new Vector2(0, 0) },
        uRingRadius: { value: 0.2 },
        uDeltaTime: { value: 0 },
        uRingWidth: { value: 0.05 },
        uRingWidth2: { value: 0.015 },
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
        uniform vec2 uRingPos;
        uniform float uTime;
        uniform float uDeltaTime;
        uniform float uRingRadius;

        uniform float uRingWidth;
        uniform float uRingWidth2;
        uniform float uRingDisplacement;

        ${noise}

        void main() {
          vec2 simTexCoords = gl_FragCoord.xy / vec2(${simSize}, ${simSize});
          vec4 pFrame = texture2D(uPosition, simTexCoords);

          float scale = pFrame.z;
          float velocity = pFrame.w;
          vec2 refPos = texture2D(uPosRefs, simTexCoords).xy;

          float time = uTime * .5;
          vec2 curentPos = refPos;

          vec2 pos = pFrame.xy;
          pos *= .8;

          float dist = distance(curentPos.xy, uRingPos);
          float noise0 = snoise(vec3(curentPos.xy * .2 + vec2(18.4924, 72.9744), time * 0.5));
          float dist1 = distance(curentPos.xy + (noise0 * .005), uRingPos);

          float t = smoothstep(uRingRadius - (uRingWidth * 2.), uRingRadius, dist) - smoothstep(uRingRadius, uRingRadius + uRingWidth, dist1);
          float t2 = smoothstep(uRingRadius - (uRingWidth2 * 2.), uRingRadius, dist) - smoothstep(uRingRadius, uRingRadius + uRingWidth2, dist1);
          float t3 = smoothstep(uRingRadius + uRingWidth2, uRingRadius, dist);

          t = pow(t, 2.);
          t2 = pow(t2, 3.);

          t += t2 * 3.;
          t += t3 * .4;
          t += snoise(vec3(curentPos.xy * 30. + vec2(11.4924, 12.9744), time * 0.5)) * t3 * .5;

          float nS = snoise(vec3(curentPos.xy * 2. + vec2(18.4924, 72.9744), time * 0.5));
          t += pow((nS + 1.5) * .5, 2.) * .6;

          float noise1 = snoise(vec3(curentPos.xy * 4. + vec2(88.494, 32.4397), time * 0.35));
          float noise2 = snoise(vec3(curentPos.xy * 4. + vec2(50.904, 120.947), time * 0.35));

          float noise3 = snoise(vec3(curentPos.xy * 20. + vec2(18.4924, 72.9744), time * .5));
          float noise4 = snoise(vec3(curentPos.xy * 20. + vec2(50.904, 120.947), time * .5));

          vec2 disp = vec2(noise1, noise2) * .03;
          disp += vec2(noise3, noise4) * .005;

          disp.x += sin((refPos.x * 20.) + (time * 4.)) * .02 * clamp(dist, 0., 1.);
          disp.y += cos((refPos.y * 20.) + (time * 3.)) * .02 * clamp(dist, 0., 1.);

          pos -= (uRingPos - (curentPos + disp)) * pow(t2, .75) * uRingDisplacement;

          float scaleDiff = t - scale;
          scaleDiff *= .2;
          scale += scaleDiff;

          vec2 finalPos = curentPos + disp + (pos * .25);

          velocity *= .5;
          velocity += scale * .25;

          vec4 frame = vec4(finalPos, scale, velocity);

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

    const fragNoise = SIMPLEX_NOISE_GLSL;

    this.renderMaterial = new ShaderMaterial({
      uniforms: {
        uPosition: { value: this.posTex },
        uTime: { value: 0 },
        uColor1: { value: new Color(this.scene.colorControls.color1) },
        uColor2: { value: new Color(this.scene.colorControls.color2) },
        uColor3: { value: new Color(this.scene.colorControls.color3) },
        uAlpha: { value: 1 },
        uRingPos: { value: new Vector2(0, 0) },
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

        varying vec4 vSeeds;
        varying float vVelocity;
        varying vec2 vLocalPos;
        varying vec2 vScreenPos;
        varying float vScale;

        void main() {
          vec4 pos = texture2D(uPosition, uv);
          vSeeds = seeds;

          vVelocity = pos.w;
          vScale = pos.z;
          vLocalPos = pos.xy;
          vec4 viewSpace  = modelViewMatrix * vec4(vec3(pos.xy, 0.), 1.0);

          gl_Position = projectionMatrix * viewSpace;
          vScreenPos = gl_Position.xy;

          gl_PointSize = ((vScale * 7.) * (uPixelRatio * 0.5) * uParticleScale);
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

        uniform vec2 uRingPos;
        uniform vec2 uRez;

        uniform float uAlpha;
        uniform float uTime;

        uniform int uColorScheme;

        ${fragNoise}

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
          float ratio = uRez.x / uRez.y;

          float noiseAngle = snoise(vec3(vLocalPos * 10. + vec2(18.4924, 72.9744), uTime * .85));
          float noiseColor = snoise(vec3(vLocalPos * 2. + vec2(74.664, 91.556), uTime * .5));
          noiseColor = (noiseColor + 1.) * .5;

          float angle = atan(vLocalPos.y - uRingPos.y, vLocalPos.x - uRingPos.x);

          vec2 uv = gl_PointCoord.xy;
          uv -= vec2(0.5);
          uv.y *= -1.;
          uv = rotate(uv, -angle + (noiseAngle * .5));

          vec2 tuv = vScreenPos;
          tuv = rotate(tuv, uTime * 1.);
          tuv.y *= 1./ratio;
          tuv += .5;

          float h = 0.8;
          float progress = smoothstep(0., .75, pow(noiseColor, 2.));
          vec3 col = mix(mix(uColor1, uColor2, progress/h), mix(uColor2, uColor3, (progress - h)/(1.0 - h)), step(h, progress));
          vec3 color = col;

          float dist = sqrt(dot(uv, uv));

          float dr = .5;
          float t = smoothstep(dr+(uBorderSize + .0001), dr-uBorderSize, dist);
          t = clamp(t, 0., 1.);

          float rounded = sdRoundBox(uv, vec2(0.5, 0.2), vec4(.25));
          rounded = smoothstep(.1, 0., rounded);

          float a = uAlpha * rounded * smoothstep(0.1, 0.2, vScale);

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
    this.mesh.scale.set(5, 5, 5);
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

    const t = (this.noise.getVal(this.scene.time * 0.66 + 94.234) - 0.5) * 2;
    const i = (this.noise.getVal(this.scene.time * 0.75 + 21.028) - 0.5) * 2;
    this.cursorPos.set(t * 0.2, i * 0.1);

    if (this.scene.isIntersecting) {
      this.cursorPos.set(
        this.scene.intersectionPoint.x * 0.175 + t * 0.1,
        this.scene.intersectionPoint.y * 0.175 + i * 0.1,
      );
      this.ringPos.set(
        this.ringPos.x + (this.cursorPos.x - this.ringPos.x) * 0.02,
        this.ringPos.y + (this.cursorPos.y - this.ringPos.y) * 0.02,
      );
    } else {
      this.cursorPos.set(t * 0.2, i * 0.1);
      this.ringPos.set(
        this.ringPos.x + (this.cursorPos.x - this.ringPos.x) * 0.01,
        this.ringPos.y + (this.cursorPos.y - this.ringPos.y) * 0.01,
      );
    }

    this.particleScale =
      this.scene.renderer.domElement.width / this.scene.pixelRatio / 2000 * this.scene.particlesScale;

    const sim = this.simMaterial.uniforms as Record<string, { value: unknown }>;
    sim.uPosition.value = this.everRendered ? this.rt1.texture : this.posTex;
    sim.uTime.value = this.scene.clock.getElapsedTime();
    sim.uDeltaTime.value = e;
    sim.uRingRadius.value =
      0.175 + Math.sin(this.scene.time * 1) * 0.03 + Math.cos(this.scene.time * 3) * 0.02;
    sim.uRingPos.value = this.ringPos;
    sim.uRingWidth.value = this.scene.ringWidth;
    sim.uRingWidth2.value = this.scene.ringWidth2;
    sim.uRingDisplacement.value = this.scene.ringDisplacement;

    this.renderer.setRenderTarget(this.rt2);
    this.renderer.render(this.simScene, this.simCamera);
    this.renderer.setRenderTarget(null);

    const ren = this.renderMaterial.uniforms as Record<string, { value: unknown }>;
    ren.uPosition.value = this.everRendered ? this.rt2.texture : this.posTex;
    ren.uTime.value = this.scene.clock.getElapsedTime();
    ren.uRingPos.value = this.ringPos;
    ren.uParticleScale.value = this.particleScale;
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
