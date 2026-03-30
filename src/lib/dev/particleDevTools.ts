import { Pane } from "tweakpane";
import type { MorphingParticleScene } from "../morphing-particles/MorphingParticleScene";
import type { RingParticleScene } from "../ring-particles/RingParticleScene";

export type ParticleDevToolsHandle = {
  dispose(): void;
};

/** Match original Angular `?gui=true` toggle for lil-gui. */
export function shouldShowParticleGui(): boolean {
  if (typeof window === "undefined") return false;
  const v = new URLSearchParams(window.location.search).get("gui");
  return v === "true" || v === "1";
}

function mountPane(title: string): { pane: Pane; wrap: HTMLDivElement } {
  const wrap = document.createElement("div");
  wrap.style.cssText =
    "position:fixed;top:12px;right:12px;z-index:1000;max-height:calc(100vh - 24px);overflow:auto;pointer-events:auto;";
  document.body.appendChild(wrap);
  const pane = new Pane({ container: wrap, title });
  return { pane, wrap };
}

/**
 * Dev panel for the morphing mask scene (original bundle `nI` / `eI` controls).
 * Enable with `?gui=true` on the page URL.
 */
export function attachMorphingDevTools(scene: MorphingParticleScene): ParticleDevToolsHandle {
  const { pane, wrap } = mountPane("Morphing particles");
  const colors = pane.addFolder({ title: "Colors" });
  colors.addBinding(scene.colorControls, "color1", { label: "Color 1", view: "color" });
  colors.addBinding(scene.colorControls, "color2", { label: "Color 2", view: "color" });
  colors.addBinding(scene.colorControls, "color3", { label: "Color 3", view: "color" });

  const params = {
    particlesScale: scene.particlesScale,
    density: scene.density,
  };

  pane
    .addBinding(params, "particlesScale", { label: "Particles scale", min: 0.1, max: 4, step: 0.01 })
    .on("change", () => {
      scene.particlesScale = params.particlesScale;
    });

  let densityBusy = false;
  pane
    .addBinding(params, "density", { label: "Density", min: 50, max: 250, step: 10 })
    .on("change", () => {
      scene.density = params.density;
      if (densityBusy) return;
      densityBusy = true;
      void scene
        .recreateParticles()
        .catch(() => {})
        .finally(() => {
          densityBusy = false;
        });
    });

  return {
    dispose() {
      pane.dispose();
      wrap.remove();
    },
  };
}

/**
 * Dev panel for the ring attractor scene (original bundle `rI` / `iI` controls).
 */
export function attachRingDevTools(scene: RingParticleScene): ParticleDevToolsHandle {
  const { pane, wrap } = mountPane("Ring particles");
  const colors = pane.addFolder({ title: "Colors" });
  colors.addBinding(scene.colorControls, "color1", { label: "Color 1", view: "color" });
  colors.addBinding(scene.colorControls, "color2", { label: "Color 2", view: "color" });
  colors.addBinding(scene.colorControls, "color3", { label: "Color 3", view: "color" });

  const params = {
    ringWidth: scene.ringWidth,
    ringWidth2: scene.ringWidth2,
    particlesScale: scene.particlesScale,
    ringDisplacement: scene.ringDisplacement,
    density: scene.density,
  };

  const syncRingScalars = () => {
    scene.ringWidth = params.ringWidth;
    scene.ringWidth2 = params.ringWidth2;
    scene.particlesScale = params.particlesScale;
    scene.ringDisplacement = params.ringDisplacement;
  };

  pane
    .addBinding(params, "ringWidth", { label: "Ring width", min: 0.01, max: 0.5, step: 0.001 })
    .on("change", syncRingScalars);
  pane
    .addBinding(params, "ringWidth2", { label: "Ring width 2", min: 0.01, max: 0.5, step: 0.001 })
    .on("change", syncRingScalars);
  pane
    .addBinding(params, "particlesScale", { label: "Particles scale", min: 0.1, max: 2, step: 0.01 })
    .on("change", syncRingScalars);
  pane
    .addBinding(params, "ringDisplacement", { label: "Displacement", min: 0.01, max: 1, step: 0.01 })
    .on("change", syncRingScalars);

  let densityBusy = false;
  pane
    .addBinding(params, "density", { label: "Density", min: 100, max: 400, step: 10 })
    .on("change", () => {
      scene.density = params.density;
      if (densityBusy) return;
      densityBusy = true;
      try {
        scene.recreateParticles();
      } finally {
        densityBusy = false;
      }
    });

  return {
    dispose() {
      pane.dispose();
      wrap.remove();
    },
  };
}
