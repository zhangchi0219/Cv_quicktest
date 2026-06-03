import { useEffect, useRef } from "react";
import * as THREE from "three";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";
import { OutputPass } from "three/examples/jsm/postprocessing/OutputPass.js";
import { AfterimagePass } from "three/examples/jsm/postprocessing/AfterimagePass.js";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { landmarkBus } from "./landmarkBus";

// Deuterium–tritium fusion, driven by two hands, drawn as two DNA-style
// particle helices. The LEFT hand drives the deuterium strand (²H, cyan), the
// RIGHT hand the tritium strand (³H, violet) — each helix has its own
// world-space center (smoothly tweened toward the unprojected palm) and its
// own radius scale (driven by that hand's thumb-tip ↔ index-tip pinch
// distance: closed → contract, open → expand). Each particle owns a private
// arc parameter φ that advances at a constant rate dφ/dt = flowDir · FLOW_OMEGA,
// so particles flow along their helical strand. Deuterium flows forward,
// tritium backward, evoking DNA's anti-parallel strands. Each particle has
// tube thickness, a 5s lifetime with fade in/out so the cloud constantly
// churns, and a divergence-free curl-noise velocity perturbation for organic
// micro-motion. A stiff spring pulls every particle to its (φ, helixIndex,
// offset)-derived target so the helix shape stays readable. Camera is a tilted
// ortho (~35° around X). When a hand isn't detected the corresponding helix
// smoothly returns to its idle home at default radius.
//
// Bring the two helices together and the center-distance "overlap" metric
// climbs; hold them overlapping and a charge meter (the Coulomb barrier) fills.
// When it tops out the reaction fires:
//   flash — both helices collapse to world origin and turn gold (the new ⁴He /
//           alpha nucleus), bloom + an ambient flashbulb burst; a fast neutron
//           is ejected from the fusion point.
//   lock  — the gold helix holds with a tight rim glow while an energy label
//           (+17.6 MeV) shows, then everything returns to the hands.
//
// A "textbook" layer is drawn alongside the helices: a small labeled Bohr atom
// model floats above each helix (氘 ²H = 1 proton + 1 neutron, 氚 ³H = 1p + 2n,
// each with an orbiting electron), and on fusion a ⁴He model (2p + 2n, 2
// electrons) fades in to the RIGHT of the merged nucleus. The reward is kept
// calm so both stay framed and sharp: the gold nucleus settles to a moderate
// size and the camera only eases a gentle tilt (no zoom, no orbit pan), easing
// back to the default over CAM_RETURN_DURATION when the window ends.

const R_MAJOR = 5;
const R_MINOR = 1.6;
const WINDINGS = 8;
// Flow speed along the helical strand: dφ/dt. Arclength variation along φ is
// only ~8% for these (R_MAJOR, R_MINOR, WINDINGS), so uniform dφ/dt reads as
// uniform flow without arclength reparametrization.
const FLOW_OMEGA = 0.45;
const TWO_PI = Math.PI * 2;
const SPRING_K = 9.0;
const DAMPING = 0.92;
const CUBE_SIZE = 0.06;
// Pinch (cm) → helix radius scale. Closed pinch ⇒ contracted helix, opened
// pinch ⇒ slightly larger than default. Missing hand falls back to default
// scale 1.0 (smoothly).
const RADIUS_MIN = 0.35;
const RADIUS_MAX = 1.15;
const PINCH_FULL_CM = 8;
// Exponential smoothing rate for each helix's center + radius. alpha =
// 1 - exp(-SMOOTH_K * dt) per frame; with k=6 the half-life is ~0.12s.
const SMOOTH_K = 6.0;
// Camera tilt around X. World +X stays screen +X; world +Z projects to
// screen +Y with weight sin(TILT); world +Y projects with weight cos(TILT).
const TILT = (35 * Math.PI) / 180;
const CAM_DIST = 30;
// Reward-window camera move, kept calm so the fused nucleus and the ⁴He model
// to its right both stay framed: no orbit pan, no zoom — just a gentle eased
// tilt from TILT up to PAN_TILT, eased back over CAM_RETURN_DURATION at the end.
const PAN_TILT = (40 * Math.PI) / 180;
const CAM_RETURN_DURATION = 1.0;
// On fusion the merged ⁴He settles to this radius scale at world origin —
// moderate (not frame-filling) so the ⁴He atomic model fits to its right.
const FUSION_RADIUS_SCALE = 1.2;
// Camera framing is a "contain-fit": the view always shows at least
// [±FIT_HALF_W, ±FIT_HALF_H] world units, expanding the shorter axis to fill the
// canvas. The stage panel is roughly square-to-portrait (not the old full-window
// 16:9), so fitting WIDTH first keeps the two idle helices (parked at
// ±HOME_OFFSET, dense radius ~7) fully on-screen instead of clipping off the
// left/right edges; portrait panels just show more empty space above/below.
// FIT_HALF_W = HOME_OFFSET + dense radius + margin.
const FIT_HALF_W = 16;
const FIT_HALF_H = 8;

// Ortho half-bounds for a given canvas aspect, applying the contain-fit above.
function computeFrustum(aspect: number): { halfW: number; halfH: number } {
  const halfH = Math.max(FIT_HALF_H, FIT_HALF_W / aspect);
  return { halfW: halfH * aspect, halfH };
}
// Lifetime / fade. At steady state count/LIFETIME particles respawn per second
// per helix. Respawn rewrites pre-allocated typed arrays in place — no
// allocation, no GC churn.
const LIFETIME = 5.0;
const FADE = 0.3;
// Strand tube cross-section. Each particle gets a constant (offsetU, offsetV)
// inside an ELLIPSE: eU = world +Z (out-of-plane "thickness"), eV = radial-in-XY
// (in-plane "width"). Flattened into a thin, wide ribbon — small thickness, large
// width — so the strand reads as a broad flowing band rather than a round rope.
const TUBE_THICK = 0.25; // z half-axis (offsetU) — thin
const TUBE_WIDE = 0.95; // radial half-axis (offsetV) — wide
// Divergence-free curl noise from a sin-based stream function. Each ψ-component
// depends on a single coordinate so the curl collapses to one cos per axis; the
// field is divergence-free, so it perturbs velocity without inflating or
// imploding the cloud.
const NOISE_K = 0.35;
const NOISE_OMEGA = 0.6;
const NOISE_AMP = 1.4;
const NOISE_PHI1 = 1.337;
const NOISE_PHI2 = 2.718;

// Idle home offset (world units): deuterium parks left, tritium right, so the
// first paint already shows them separated. Each helix's max radius
// (R_MAJOR + R_MINOR + TUBE_WIDE) is ~7.55, so at ±8 the strands are visibly
// separated; users have to bring their hands together to overlap them.
const HOME_OFFSET = 8;

// Cross-system overlap via center distance. Each helix is a torus (mostly empty
// interior), so a voxel metric caps low even when they visibly interpenetrate —
// center-distance gives a clean analytic alternative.
//   HELIX_OUTER = farthest particle radius from center (main + minor + tube).
//   Per-helix effective outer radius = HELIX_OUTER × radiusScale.
const HELIX_OUTER = R_MAJOR + R_MINOR + TUBE_WIDE;
// rawPct = (1 − d / (FAR_MULT · sumR)) × 100, clamped to [0, 100].
// FAR_MULT = 5/3 puts d = sumR (outer edges just touching) at ~40%;
// d = 0 (concentric) is 100%.
const OVERLAP_FAR_MULT = 5 / 3;
const OVERLAP_SMOOTH_K = 4;

// Mood light during charging — sky-blue intensifying as the user holds the
// strands together, telegraphing the Coulomb barrier being overcome.
const MOOD_MAX_INTENSITY = 1.6;
const MOOD_COLOR = 0x38bdf8;
const GOLD_COLOR = 0xfbbf24; // ⁴He / energy reward tint

// Strand colors (the two nuclei).
const COLOR_DEUTERIUM = 0x38bdf8; // cyan
const COLOR_TRITIUM = 0xa78bfa; // violet

// Stage machine. Entering `charging` requires smoothed overlap to cross
// OVERLAP_TRIGGER; dropping below it during `charging` resets the timer. After
// CHARGE_DURATION the reaction fires: flash (FLASH_DURATION) is a sub-stage of
// the LOCK_DURATION-long reward window — both start together. During flash +
// lock the helices are pinned to world (0,0), turn gold, and bloom. Hand input
// is ignored for the full LOCK_DURATION.
const OVERLAP_TRIGGER = 40;
const CHARGE_DURATION = 5.0;
const FLASH_DURATION = 2.0;
const LOCK_DURATION = 10.0;

// Bloom + ambient flash tuning. Two bloom levels: BLOOM_STRENGTH_MAX is the
// burst during the 2s flash; BLOOM_STRENGTH_RIM is the much-lower hold during
// the remaining lock, giving a tight rim glow on the gold helix instead of a
// wide halo. The drop happens over RIM_RAMP_DURATION at the flash → lock edge.
const BLOOM_STRENGTH_MAX = 0.9;
const BLOOM_STRENGTH_RIM = 0.15;
const RIM_RAMP_DURATION = 0.5;
const BLOOM_RADIUS = 0.8;
const BLOOM_THRESHOLD = 0.6;
const AMBIENT_BASE = 0.3;
const AMBIENT_FLASH_PEAK = 3.0;
const EMISSIVE_MAX = 2.5;
// Feedback trail (AfterimagePass): a restrained screen-space afterimage so the
// flowing particles leave short tails. damp = persistence (higher = longer). We
// ride damp to ~0 while the camera is moving (orbit / scripted pan) so the whole
// frame doesn't smear, then ease it back up when the camera settles.
const AFTERIMAGE_DAMP = 0.85;
// Random per-particle twinkle: a fraction of particles pulse brighter (via
// instanceColor, multiplied into the diffuse) + slightly larger on their own
// cycle, like sparkling highlights along the strands.
const FLICKER_FRACTION = 0.08; // share of particles that twinkle
const FLICKER_BRIGHT = 3.0; // peak instanceColor multiplier at a flash

// Ejected neutron: a single pale, emissive sphere launched from the fusion
// point at flash start, flying off mostly in-plane and fading out over its
// lifetime.
const NEUTRON_SPEED = 16;
const NEUTRON_LIFE = 1.8;
const NEUTRON_FADE = 0.5;
const NEUTRON_SIZE = 0.55;

// ── Bohr atomic models (the "textbook" layer over the helices) ────────────
// Nucleus = red protons + slate neutrons in a tight cluster; cyan electrons
// orbit on faint tilted rings. Slight emissive so the colors read as a diagram
// regardless of the dramatic scene lighting.
const PROTON_COLOR = 0xef4444; // red
const NEUTRON_COLOR = 0x94a3b8; // slate
// Both nucleons use a rough, matte surface (no reflections / envMap). They
// differ only in tint + self-emissive: protons carry a strong red glow so they
// read as the "hot" nucleus; neutrons keep a small emissive baseline so the
// slate stays visible on the dark stage.
const PROTON_GLOW = 1.0; // doubled emissive glow on the matte protons
const NEUTRON_EMISSIVE = 0.18;
const NUCLEON_METALNESS = 0.1;
const NUCLEON_ROUGHNESS = 0.9;
const ELECTRON_COLOR = 0x7dd3fc; // cyan-white
const NUCLEON_R = 0.42;
const ELECTRON_R = 0.18;
const ORBIT_R = 2.2; // electron orbit radius (world units)
const ELECTRON_SPEED = 1.6; // base orbital rate (rad/s)
const MODEL_SPIN = 0.5; // whole-model turntable spin around its own Y axis (rad/s)
const MODEL_Y = 10; // model height above its helix center (clears the helix)
const LABEL_Y = 3.3; // label height above the model nucleus
const HE_MODEL_X = 12; // ⁴He model x, to the right of the origin nucleus
const MODEL_FADE_K = 8; // opacity smoothing rate for show/hide

function isMobileDevice(): boolean {
  return (
    window.matchMedia("(pointer: coarse)").matches || window.innerWidth < 768
  );
}

type Helix = {
  mesh: THREE.InstancedMesh;
  material: THREE.MeshStandardMaterial;
  phi: Float32Array;
  positions: Float32Array;
  velocities: Float32Array;
  rotations: Float32Array;
  angVel: Float32Array;
  scales: Float32Array;
  ages: Float32Array;
  offsetU: Float32Array;
  offsetV: Float32Array;
  // Per-particle twinkle: flickerFreq[i] = pulse rate (rad/s; 0 = steady),
  // flickerPhase[i] = phase offset. Drives instanceColor brightness + a scale pop.
  flickerFreq: Float32Array;
  flickerPhase: Float32Array;
  phase: number;
  // +1 = forward flow along φ, -1 = reverse. Deuterium forward, tritium reverse
  // gives the anti-parallel DNA-strand look.
  flowDir: 1 | -1;
  // Idle "home" position the helix returns to when its hand isn't detected.
  homeX: number;
  homeY: number;
  // Smoothed XY translation of this helix's center (z=0 plane) and uniform
  // radius scale, updated each frame from the hand's palm + pinch with
  // exponential smoothing so a re-appearing hand doesn't snap.
  centerX: number;
  centerY: number;
  radiusScale: number;
};

type Stage = "idle" | "charging" | "flash" | "lock";

export default function ParticleStage({ interactive }: { interactive: boolean }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chargeFillRef = useRef<HTMLDivElement>(null);
  const chargeTrackRef = useRef<HTMLDivElement>(null);
  const burstLabelRef = useRef<HTMLDivElement>(null);

  // Mirror the prop into a ref so the persistent rAF loop (built once in the
  // mount effect below) can read the latest value without rebuilding the scene.
  const interactiveRef = useRef(interactive);
  useEffect(() => {
    interactiveRef.current = interactive;
  }, [interactive]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const initialRect = container.getBoundingClientRect();
    let viewW = Math.max(1, Math.floor(initialRect.width));
    let viewH = Math.max(1, Math.floor(initialRect.height));

    const isMobile = isMobileDevice();
    const countPerHelix = isMobile ? 1500 : 4000;
    const pixelRatio = Math.min(window.devicePixelRatio, 2);

    const renderer = new THREE.WebGLRenderer({
      antialias: true,
      alpha: true,
      powerPreference: "high-performance",
    });
    renderer.setPixelRatio(pixelRatio);
    renderer.setClearColor(0x000000, 0);
    // updateStyle=false: don't let three.js write an inline px width/height onto
    // the canvas. The CSS rule (.particle-stage canvas { width:100%; height:100% })
    // drives the display size instead. An inline px width would otherwise become
    // the grid item's min-content floor, so the 63fr column couldn't shrink below
    // the canvas's last pixel width — the canvas would stop following the window.
    renderer.setSize(viewW, viewH, false);
    container.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    const initial = computeFrustum(viewW / viewH);
    const camera = new THREE.OrthographicCamera(
      -initial.halfW,
      initial.halfW,
      initial.halfH,
      -initial.halfH,
      0.1,
      200,
    );
    camera.position.set(0, -CAM_DIST * Math.sin(TILT), CAM_DIST * Math.cos(TILT));
    camera.up.set(0, 0, 1);
    camera.lookAt(0, 0, 0);
    camera.updateMatrixWorld();

    // Named so the stage machine can pulse intensity during the reward flash.
    const ambientLight = new THREE.AmbientLight(0xffffff, AMBIENT_BASE);
    scene.add(ambientLight);
    const dirLight = new THREE.DirectionalLight(0xeaf2ff, 1.2);
    dirLight.position.set(14, 6, 4);
    dirLight.target.position.set(0, 0, 0);
    scene.add(dirLight);
    scene.add(dirLight.target);

    // Backdrop plane + mood light: keeps the charging "background flash" inside
    // the canvas (not the page). Plane sits past the helices in the camera's
    // forward direction, faces the camera, stays a dark base color; the mood
    // light tints it sky-blue as overlap rises so the wash reads as a lit
    // surface rather than a flat fill.
    const camForward = new THREE.Vector3()
      .subVectors(new THREE.Vector3(), camera.position)
      .normalize();
    const backdropGeom = new THREE.PlaneGeometry(80, 80);
    const backdropMat = new THREE.MeshStandardMaterial({
      color: 0x0b0d10,
      roughness: 0.92,
      metalness: 0.04,
    });
    const backdrop = new THREE.Mesh(backdropGeom, backdropMat);
    backdrop.position.copy(camForward).multiplyScalar(28);
    backdrop.lookAt(camera.position);
    scene.add(backdrop);

    const moodLight = new THREE.DirectionalLight(MOOD_COLOR, 0);
    moodLight.position.copy(camForward).multiplyScalar(-8);
    moodLight.target.position.copy(backdrop.position);
    scene.add(moodLight);
    scene.add(moodLight.target);

    // Place the camera on a sphere of radius CAM_DIST about world origin, by
    // azimuth ψ (around world +Z, the torus disk's axis) and tilt τ (elevation):
    // horizontal radius CAM_DIST·sin(τ), height CAM_DIST·cos(τ). ψ=0, τ=TILT
    // reproduces the default view exactly, so easing back there is snap-free.
    // setCameraPose also re-parks the dark backdrop + mood light behind the
    // scene relative to the new view so the wash stays put as the camera moves.
    const camForwardPose = new THREE.Vector3();
    // Re-park the dark backdrop + mood light behind the scene relative to the
    // current camera position so the wash stays put as the camera moves —
    // whether moved by setCameraPose (scripted reward) or OrbitControls (the
    // user-draggable intro view).
    const parkBackdrop = () => {
      camForwardPose.copy(camera.position).multiplyScalar(-1).normalize();
      backdrop.position.copy(camForwardPose).multiplyScalar(28);
      backdrop.lookAt(camera.position);
      moodLight.position.copy(camForwardPose).multiplyScalar(-8);
      moodLight.target.position.copy(backdrop.position);
      moodLight.target.updateMatrixWorld();
    };
    const setCameraPose = (azimuth: number, tilt: number, zoom: number) => {
      const hRadius = CAM_DIST * Math.sin(tilt);
      camera.position.set(
        hRadius * Math.sin(azimuth),
        -hRadius * Math.cos(azimuth),
        CAM_DIST * Math.cos(tilt),
      );
      camera.up.set(0, 0, 1);
      camera.lookAt(0, 0, 0);
      camera.updateMatrixWorld();
      // zoom shrinks the effective ortho frustum (framed height / zoom) so the
      // fused helix fills the canvas. applyResize leaves camera.zoom alone, so
      // it persists across resizes and composes with the frustum bounds.
      camera.zoom = zoom;
      camera.updateProjectionMatrix();
      parkBackdrop();
    };

    // User-draggable camera for the intro page: orbit (rotate) + zoom around the
    // scene center, no pan so (0,0,0) stays framed. Disabled while the demo is
    // active — there the scripted reward camera (setCameraPose) owns the view.
    // Enabled on touch/mobile too: OrbitControls sets touch-action:none on the
    // canvas, but on mobile the scene is pinned (position:fixed, 60vh) at the top
    // and the copy scrolls *below* it, so dragging on the canvas rotates without
    // fighting the page's vertical scroll.
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.target.set(0, 0, 0);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.enablePan = false; // no pan, (0,0,0) stays centered
    controls.enableZoom = true; // wheel (desktop) / pinch (mobile) to zoom
    controls.minZoom = 0.6;
    controls.maxZoom = 3;
    controls.enabled = interactiveRef.current;

    const cubeGeom = new THREE.BoxGeometry(CUBE_SIZE, CUBE_SIZE, CUBE_SIZE);

    // Re-randomize a single particle in-place and snap its position to its
    // freshly computed target. Used both at init and at end-of-life respawn.
    // φ is preserved across respawn — each particle owns a fixed slot on the
    // strand and flows continuously, so a respawn just rerolls offset / spin /
    // scale / age without teleporting the particle to a new slot.
    const respawnParticle = (h: Helix, i: number) => {
      const phi = h.phi[i];

      // Elliptical cross-section offset in (eU, eV). sqrt(u) keeps density flat
      // across the disk; the two half-axes flatten it into a thin (z), wide
      // (radial) ribbon.
      const u = Math.random();
      const tau = Math.random() * Math.PI * 2;
      const r = Math.sqrt(u);
      const oU = TUBE_THICK * r * Math.cos(tau);
      const oV = TUBE_WIDE * r * Math.sin(tau);
      h.offsetU[i] = oU;
      h.offsetV[i] = oV;

      const theta = phi;
      const alpha = WINDINGS * phi + h.phase;
      const rho = R_MAJOR + R_MINOR * Math.cos(alpha);
      const cosTheta = Math.cos(theta);
      const sinTheta = Math.sin(theta);
      const s = h.radiusScale;
      const ix = i * 3;
      h.positions[ix] = (rho * cosTheta + oV * cosTheta) * s + h.centerX;
      h.positions[ix + 1] = (rho * sinTheta + oV * sinTheta) * s + h.centerY;
      h.positions[ix + 2] = (R_MINOR * Math.sin(alpha) + oU) * s;
      h.velocities[ix] = 0;
      h.velocities[ix + 1] = 0;
      h.velocities[ix + 2] = 0;
      h.rotations[ix] = Math.random() * Math.PI * 2;
      h.rotations[ix + 1] = Math.random() * Math.PI * 2;
      h.rotations[ix + 2] = Math.random() * Math.PI * 2;
      h.angVel[ix] = (Math.random() - 0.5) * 3.6;
      h.angVel[ix + 1] = (Math.random() - 0.5) * 3.6;
      h.angVel[ix + 2] = (Math.random() - 0.5) * 3.6;
      h.scales[i] = 0.25 + Math.random() * 1.55;
      // ~FLICKER_FRACTION of particles are "sparklers": they pulse brighter +
      // larger on their own cycle. freq 0 means a steady (non-flickering) one.
      const sparkle = Math.random() < FLICKER_FRACTION;
      h.flickerFreq[i] = sparkle ? 1.5 + Math.random() * 3.5 : 0;
      h.flickerPhase[i] = Math.random() * Math.PI * 2;
      h.ages[i] = 0;
    };

    const createHelix = (helixIndex: 0 | 1, color: number): Helix => {
      const material = new THREE.MeshStandardMaterial({
        color,
        roughness: 0.55,
        metalness: 0.15,
        // emissive starts at black; the stage machine ramps it to gold during
        // flash/lock so UnrealBloomPass picks the pixels up over its threshold.
        emissive: 0x000000,
        emissiveIntensity: 0,
        transparent: true,
      });
      const mesh = new THREE.InstancedMesh(cubeGeom, material, countPerHelix);
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      // InstancedMesh's bounding sphere is computed from instance 0 — disable
      // culling so the whole cloud doesn't pop when the seed wanders.
      mesh.frustumCulled = false;
      // Per-instance color (white = no change) so the twinkle can brighten
      // individual particles; rewritten each frame in stepHelix.
      const initColor = new THREE.Color(1, 1, 1);
      for (let i = 0; i < countPerHelix; i++) mesh.setColorAt(i, initColor);
      mesh.instanceColor!.setUsage(THREE.DynamicDrawUsage);

      const homeX = helixIndex === 0 ? -HOME_OFFSET : HOME_OFFSET;
      const homeY = 0;
      const h: Helix = {
        mesh,
        material,
        phi: new Float32Array(countPerHelix),
        positions: new Float32Array(countPerHelix * 3),
        velocities: new Float32Array(countPerHelix * 3),
        rotations: new Float32Array(countPerHelix * 3),
        angVel: new Float32Array(countPerHelix * 3),
        scales: new Float32Array(countPerHelix),
        ages: new Float32Array(countPerHelix),
        offsetU: new Float32Array(countPerHelix),
        offsetV: new Float32Array(countPerHelix),
        flickerFreq: new Float32Array(countPerHelix),
        flickerPhase: new Float32Array(countPerHelix),
        phase: helixIndex === 0 ? 0 : Math.PI,
        flowDir: helixIndex === 0 ? 1 : -1,
        homeX,
        homeY,
        // Start centered at home so the first paint already shows the helices
        // separated. respawnParticle reads centerX/Y to seed positions.
        centerX: homeX,
        centerY: homeY,
        radiusScale: 1,
      };

      // φ slots are evenly distributed once at init and then advance with the
      // flow each frame — respawn does not touch them.
      const step = TWO_PI / countPerHelix;
      for (let i = 0; i < countPerHelix; i++) {
        const jitter = (Math.random() - 0.5) * step * 0.6;
        h.phi[i] = i * step + jitter;
      }

      for (let i = 0; i < countPerHelix; i++) {
        respawnParticle(h, i);
        // Stagger initial ages so respawns don't sync into a death wave at
        // t = LIFETIME. respawnParticle just set this to 0.
        h.ages[i] = Math.random() * LIFETIME;
      }

      return h;
    };

    const deuterium = createHelix(0, COLOR_DEUTERIUM);
    const tritium = createHelix(1, COLOR_TRITIUM);
    scene.add(deuterium.mesh, tritium.mesh);

    // Ejected neutron — a single pale emissive sphere, hidden until a reaction
    // fires. Reused across reactions (no per-event allocation).
    const neutronGeom = new THREE.SphereGeometry(NEUTRON_SIZE, 20, 20);
    const neutronMat = new THREE.MeshStandardMaterial({
      color: 0xe8edf5,
      emissive: 0xbcd0ff,
      emissiveIntensity: 1.6,
      roughness: 0.4,
      metalness: 0.1,
      transparent: true,
      opacity: 1,
    });
    const neutron = new THREE.Mesh(neutronGeom, neutronMat);
    neutron.visible = false;
    scene.add(neutron);
    const neutronVel = new THREE.Vector3();
    let neutronAge = NEUTRON_LIFE + 1; // inactive

    // ── Atomic-model layer ────────────────────────────────────────────────
    // Shared small-sphere + orbit-ring geometries, reused across all three
    // models (disposed once at unmount).
    const nucleonGeom = new THREE.SphereGeometry(NUCLEON_R, 16, 16);
    const electronGeom = new THREE.SphereGeometry(ELECTRON_R, 12, 12);
    const orbitPts: number[] = [];
    for (let i = 0; i <= 64; i++) {
      const a = (i / 64) * TWO_PI;
      orbitPts.push(Math.cos(a) * ORBIT_R, Math.sin(a) * ORBIT_R, 0);
    }
    const orbitGeom = new THREE.BufferGeometry();
    orbitGeom.setAttribute(
      "position",
      new THREE.Float32BufferAttribute(orbitPts, 3),
    );

    type Electron = {
      mesh: THREE.Mesh;
      u: THREE.Vector3;
      v: THREE.Vector3;
      angle: number;
      speed: number;
    };
    type AtomModel = {
      group: THREE.Group;
      electrons: Electron[];
      opacity: number;
      setOpacity: (o: number) => void;
      dispose: () => void;
    };

    // Tight nucleon cluster offsets for up to 4 nucleons (world units).
    const clusterOffsets = (n: number): Array<[number, number, number]> => {
      const d = NUCLEON_R * 0.92;
      if (n <= 1) return [[0, 0, 0]];
      if (n === 2) return [[-d, 0, 0], [d, 0, 0]];
      if (n === 3) return [[0, d, 0], [-d, -d * 0.6, 0], [d, -d * 0.6, 0]];
      return [[d, d, d], [-d, -d, d], [-d, d, -d], [d, -d, -d]];
    };

    const makeLabel = (text: string, color: string) => {
      const canvas = document.createElement("canvas");
      canvas.width = 320;
      canvas.height = 140;
      const ctx = canvas.getContext("2d")!;
      ctx.font = "600 64px 'Microsoft YaHei','PingFang SC',sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillStyle = color;
      ctx.fillText(text, canvas.width / 2, canvas.height / 2);
      const texture = new THREE.CanvasTexture(canvas);
      texture.colorSpace = THREE.SRGBColorSpace;
      const material = new THREE.SpriteMaterial({
        map: texture,
        transparent: true,
        depthTest: false,
        depthWrite: false,
      });
      const sprite = new THREE.Sprite(material);
      sprite.scale.set(4.6, 2.0, 1);
      sprite.renderOrder = 10;
      return { sprite, material, texture };
    };

    const makeAtomModel = (
      protons: number,
      neutrons: number,
      electrons: number,
      labelText: string,
      labelColor: string,
    ): AtomModel => {
      const group = new THREE.Group();
      const mats: THREE.Material[] = []; // faded to full opacity o
      const rings: THREE.LineBasicMaterial[] = []; // faded to a fainter o
      const textures: THREE.Texture[] = [];

      const total = protons + neutrons;
      const offsets = clusterOffsets(total);
      for (let i = 0; i < total; i++) {
        const isProton = i < protons;
        const c = isProton ? PROTON_COLOR : NEUTRON_COLOR;
        // Both nucleons are a rough, matte surface; they differ only in tint +
        // self-emissive (protons glow red, neutrons a faint slate baseline).
        const mat = new THREE.MeshStandardMaterial({
          color: c,
          emissive: c,
          emissiveIntensity: isProton ? PROTON_GLOW : NEUTRON_EMISSIVE,
          roughness: NUCLEON_ROUGHNESS,
          metalness: NUCLEON_METALNESS,
          transparent: true,
        });
        mats.push(mat);
        const mesh = new THREE.Mesh(nucleonGeom, mat);
        mesh.position.set(...offsets[i]);
        group.add(mesh);
      }

      const els: Electron[] = [];
      for (let e = 0; e < electrons; e++) {
        // Orbit normal ~34° off +Z, spread in azimuth so multiple electrons
        // cross rather than coincide.
        const az = electrons === 1 ? 0 : (e / electrons) * TWO_PI;
        const n = new THREE.Vector3(
          Math.sin(0.6) * Math.cos(az),
          Math.sin(0.6) * Math.sin(az),
          Math.cos(0.6),
        ).normalize();
        const u = new THREE.Vector3(0, 0, 1).cross(n);
        if (u.lengthSq() < 1e-4) u.set(1, 0, 0);
        u.normalize();
        const v = new THREE.Vector3().crossVectors(n, u).normalize();

        const ringMat = new THREE.LineBasicMaterial({
          color: ELECTRON_COLOR,
          transparent: true,
          opacity: 0.3,
        });
        rings.push(ringMat);
        const ring = new THREE.LineLoop(orbitGeom, ringMat);
        ring.quaternion.setFromRotationMatrix(
          new THREE.Matrix4().makeBasis(u, v, n),
        );
        group.add(ring);

        const elMat = new THREE.MeshStandardMaterial({
          color: ELECTRON_COLOR,
          emissive: ELECTRON_COLOR,
          emissiveIntensity: 0.9,
          roughness: 0.4,
          metalness: 0,
          transparent: true,
        });
        mats.push(elMat);
        const mesh = new THREE.Mesh(electronGeom, elMat);
        group.add(mesh);
        els.push({
          mesh,
          u,
          v,
          angle: Math.random() * TWO_PI,
          speed: ELECTRON_SPEED * (1 + e * 0.3),
        });
      }

      const label = makeLabel(labelText, labelColor);
      label.sprite.position.set(0, LABEL_Y, 0);
      group.add(label.sprite);
      mats.push(label.material);
      textures.push(label.texture);

      const setOpacity = (o: number) => {
        for (const m of mats) m.opacity = o;
        for (const r of rings) r.opacity = o * 0.3;
        group.visible = o > 0.01;
      };

      const dispose = () => {
        for (const m of mats) m.dispose();
        for (const r of rings) r.dispose();
        for (const t of textures) t.dispose();
      };

      return { group, electrons: els, opacity: 1, setOpacity, dispose };
    };

    const dModel = makeAtomModel(1, 1, 1, "氘 ²H", "#38bdf8");
    const tModel = makeAtomModel(1, 2, 1, "氚 ³H", "#a78bfa");
    const heModel = makeAtomModel(2, 2, 2, "氦 ⁴He", "#fbbf24");
    heModel.opacity = 0;
    heModel.setOpacity(0); // hidden until fusion
    scene.add(dModel.group, tModel.group, heModel.group);

    const dummy = new THREE.Object3D();
    const flickerColor = new THREE.Color(); // reused for per-instance twinkle
    const seedMatrices = (h: Helix) => {
      for (let i = 0; i < countPerHelix; i++) {
        const ix = i * 3;
        dummy.position.set(h.positions[ix], h.positions[ix + 1], h.positions[ix + 2]);
        dummy.rotation.set(h.rotations[ix], h.rotations[ix + 1], h.rotations[ix + 2]);
        const s = h.scales[i];
        dummy.scale.set(s, s, s);
        dummy.updateMatrix();
        h.mesh.setMatrixAt(i, dummy.matrix);
      }
      h.mesh.instanceMatrix.needsUpdate = true;
    };
    seedMatrices(deuterium);
    seedMatrices(tritium);

    // Post-processing: RenderPass → AfterimagePass → UnrealBloomPass → OutputPass.
    // Bloom starts disabled and is enabled only during the reward window.
    // AfterimagePass adds the feedback trail (its damp is driven per-frame in the
    // loop). OutputPass maps emissive HDR cleanly to LDR.
    const composer = new EffectComposer(renderer);
    composer.setPixelRatio(pixelRatio);
    composer.setSize(viewW, viewH);
    composer.addPass(new RenderPass(scene, camera));
    const afterimagePass = new AfterimagePass();
    afterimagePass.uniforms.damp.value = 0; // ramps up in the loop once camera is still
    composer.addPass(afterimagePass);
    const bloomPass = new UnrealBloomPass(
      new THREE.Vector2(viewW, viewH),
      0,
      BLOOM_RADIUS,
      BLOOM_THRESHOLD,
    );
    bloomPass.enabled = false;
    composer.addPass(bloomPass);
    composer.addPass(new OutputPass());

    let pendingResize = false;
    const applyResize = () => {
      pendingResize = false;
      const w = Math.max(1, Math.floor(container.clientWidth));
      const h = Math.max(1, Math.floor(container.clientHeight));
      if (w === viewW && h === viewH) return;
      viewW = w;
      viewH = h;
      renderer.setSize(w, h, false); // CSS drives display size (see mount setSize)
      composer.setSize(w, h);
      bloomPass.setSize(w, h);
      const { halfW, halfH } = computeFrustum(w / h);
      camera.left = -halfW;
      camera.right = halfW;
      camera.top = halfH;
      camera.bottom = -halfH;
      camera.updateProjectionMatrix();
    };
    const resizeObserver = new ResizeObserver(() => {
      if (pendingResize) return;
      pendingResize = true;
      requestAnimationFrame(applyResize);
    });
    resizeObserver.observe(container);

    let raf = 0;
    const startT = performance.now();
    let prevT = startT;
    const nearVec = new THREE.Vector3();
    const farVec = new THREE.Vector3();
    let overlapSmoothed = 0;

    // Afterimage trail gating: kill the trail (damp→0) while the camera moves so
    // the whole frame doesn't smear; ease it back up when the camera is still.
    const prevCamPos = camera.position.clone();
    const prevCamQuat = camera.quaternion.clone();
    let prevZoom = camera.zoom;
    let trailDamp = 0;

    let stage: Stage = "idle";
    let stageTime = 0;
    // Camera-move bookkeeping. rewardTime drives the A→B pan over the reward
    // window; camPanning latches so the pan→return edge fires once; camReturning
    // + camReturnTime drive the eased return to the default view afterward.
    let rewardTime = 0;
    let camPanning = false;
    let camReturning = false;
    let camReturnTime = 0;
    const tmpColor = new THREE.Color();
    const colorCharging = new THREE.Color(MOOD_COLOR);
    const colorGold = new THREE.Color(GOLD_COLOR);
    // Originals so the lerp back at the end of lock lands exactly on
    // construction colors — the live material.color drifts during flash/lock.
    const deuteriumOriginalColor = new THREE.Color(COLOR_DEUTERIUM);
    const tritiumOriginalColor = new THREE.Color(COLOR_TRITIUM);

    const stepHelix = (h: Helix, dt: number, tNoise: number) => {
      const noiseT = NOISE_OMEGA * tNoise;
      const noiseAK = NOISE_AMP * NOISE_K;
      const helixScale = h.radiusScale;
      const cx = h.centerX;
      const cy = h.centerY;
      const dPhi = h.flowDir * FLOW_OMEGA * dt;
      for (let i = 0; i < countPerHelix; i++) {
        // Age + maybe respawn. φ is preserved across respawn.
        h.ages[i] += dt;
        if (h.ages[i] >= LIFETIME) {
          respawnParticle(h, i);
        }

        // Advance this particle along its strand. Wrap to [0, 2π) so Float32
        // doesn't drift after many minutes of accumulation.
        let phi = h.phi[i] + dPhi;
        if (phi >= TWO_PI) phi -= TWO_PI;
        else if (phi < 0) phi += TWO_PI;
        h.phi[i] = phi;

        const ix = i * 3;
        const theta = phi;
        const alpha = WINDINGS * phi + h.phase;
        const cosA = Math.cos(alpha);
        const sinA = Math.sin(alpha);
        const cosTheta = Math.cos(theta);
        const sinTheta = Math.sin(theta);
        const rho = R_MAJOR + R_MINOR * cosA;
        // Target = (path point + tube offset) scaled by this helix's radius,
        // translated by its center. eU = ẑ, eV = (cosθ, sinθ, 0).
        const oU = h.offsetU[i];
        const oV = h.offsetV[i];
        const tx = (rho * cosTheta + oV * cosTheta) * helixScale + cx;
        const ty = (rho * sinTheta + oV * sinTheta) * helixScale + cy;
        const tz = (R_MINOR * sinA + oU) * helixScale;

        let px = h.positions[ix];
        let py = h.positions[ix + 1];
        let pz = h.positions[ix + 2];
        let vx = h.velocities[ix];
        let vy = h.velocities[ix + 1];
        let vz = h.velocities[ix + 2];

        // Stiff spring toward target — keeps helix shape readable while the
        // target itself drifts with the hand.
        vx += (tx - px) * SPRING_K * dt;
        vy += (ty - py) * SPRING_K * dt;
        vz += (tz - pz) * SPRING_K * dt;

        // Curl noise: analytical curl of the sin stream function.
        vx += -noiseAK * Math.cos(NOISE_K * pz + noiseT + NOISE_PHI1) * dt;
        vy += -noiseAK * Math.cos(NOISE_K * px + noiseT + NOISE_PHI2) * dt;
        vz += -noiseAK * Math.cos(NOISE_K * py + noiseT) * dt;

        vx *= DAMPING;
        vy *= DAMPING;
        vz *= DAMPING;

        px += vx * dt;
        py += vy * dt;
        pz += vz * dt;

        h.positions[ix] = px;
        h.positions[ix + 1] = py;
        h.positions[ix + 2] = pz;
        h.velocities[ix] = vx;
        h.velocities[ix + 1] = vy;
        h.velocities[ix + 2] = vz;

        const rotX = h.rotations[ix] + h.angVel[ix] * dt;
        const rotY = h.rotations[ix + 1] + h.angVel[ix + 1] * dt;
        const rotZ = h.rotations[ix + 2] + h.angVel[ix + 2] * dt;
        h.rotations[ix] = rotX;
        h.rotations[ix + 1] = rotY;
        h.rotations[ix + 2] = rotZ;

        // Endpoint fade: ramps scale in over FADE seconds at birth, out over
        // FADE seconds before death, so respawns don't pop.
        const age = h.ages[i];
        const fade =
          age < FADE
            ? age / FADE
            : age > LIFETIME - FADE
              ? (LIFETIME - age) / FADE
              : 1;
        let s = h.scales[i] * fade;

        // Twinkle: sparklers pulse brighter (instanceColor multiplier) + larger
        // on their own cycle. Non-sparklers (freq 0) stay white / unscaled.
        let cm = 1;
        const ff = h.flickerFreq[i];
        if (ff > 0) {
          const tw = Math.sin(tNoise * ff + h.flickerPhase[i]) * 0.5 + 0.5; // [0,1]
          const pulse = tw * tw * tw * tw; // sharpen into brief flashes
          cm = 1 + pulse * (FLICKER_BRIGHT - 1);
          s *= 1 + pulse * 0.6;
        }
        flickerColor.setScalar(cm);
        h.mesh.setColorAt(i, flickerColor);

        dummy.position.set(px, py, pz);
        dummy.rotation.set(rotX, rotY, rotZ);
        dummy.scale.set(s, s, s);
        dummy.updateMatrix();
        h.mesh.setMatrixAt(i, dummy.matrix);
      }
      h.mesh.instanceMatrix.needsUpdate = true;
      h.mesh.instanceColor!.needsUpdate = true;
    };

    // Ortho ray ∩ z=0 plane: unproject NDC at near and far, build a ray, solve
    // for the t where z=0. Mirror x for the selfie view; flip y (image y grows
    // down, NDC y grows up). Returns null if input is null or the ray is
    // degenerate.
    const palmToWorld = (
      palm: { x: number; y: number } | null,
    ): { x: number; y: number } | null => {
      if (!palm) return null;
      const ndcX = (1 - palm.x) * 2 - 1;
      const ndcY = 1 - palm.y * 2;
      nearVec.set(ndcX, ndcY, 0).unproject(camera);
      farVec.set(ndcX, ndcY, 1).unproject(camera);
      const dz = farVec.z - nearVec.z;
      if (Math.abs(dz) <= 1e-6) return null;
      const t = -nearVec.z / dz;
      return {
        x: nearVec.x + (farVec.x - nearVec.x) * t,
        y: nearVec.y + (farVec.y - nearVec.y) * t,
      };
    };

    const pinchToScale = (cm: number | null): number => {
      if (cm == null) return 1;
      const c = Math.max(0, Math.min(PINCH_FULL_CM, cm));
      return RADIUS_MIN + (c / PINCH_FULL_CM) * (RADIUS_MAX - RADIUS_MIN);
    };

    let wasInteractive = controls !== null && interactiveRef.current;
    const loop = () => {
      const now = performance.now();
      const dt = Math.min(1 / 30, Math.max(1 / 120, (now - prevT) / 1000));
      prevT = now;
      const tNoise = (now - startT) / 1000;

      // Toggle between the user-draggable intro camera (OrbitControls) and the
      // scripted demo camera on view change. On every transition snap back to
      // the default framed pose so the demo always starts centered and the
      // intro re-enters from a known orbit.
      const interactive = interactiveRef.current && controls !== null;
      if (controls && interactive !== wasInteractive) {
        controls.enabled = interactive;
        setCameraPose(0, TILT, 1);
        controls.target.set(0, 0, 0);
        controls.update();
        // A view switch mid-reward must not leave the scripted-camera latches
        // set, or re-entering the demo replays a stale tilt. Reset on toggle.
        camPanning = false;
        camReturning = false;
        rewardTime = 0;
        camReturnTime = 0;
        wasInteractive = interactive;
      }

      const frame = landmarkBus.latest;
      const leftWorld = palmToWorld(frame?.leftPalm ?? null);
      const rightWorld = palmToWorld(frame?.rightPalm ?? null);
      // Missing hand ⇒ helix target is its own home + default radius.
      const leftTargetX = leftWorld ? leftWorld.x : deuterium.homeX;
      const leftTargetY = leftWorld ? leftWorld.y : deuterium.homeY;
      const leftTargetScale = frame?.leftPalm ? pinchToScale(frame.leftPinchCm) : 1;
      const rightTargetX = rightWorld ? rightWorld.x : tritium.homeX;
      const rightTargetY = rightWorld ? rightWorld.y : tritium.homeY;
      const rightTargetScale = frame?.rightPalm ? pinchToScale(frame.rightPinchCm) : 1;

      // During flash + lock, both helices are pinned to world origin and grow to
      // FUSION_RADIUS_SCALE (the big fused ⁴He); hand input is ignored. Smoothing
      // pulls them toward (0,0) and up to 2× without a snap, and back to the
      // hands / hand-driven radius at lock-end.
      const locked = stage === "flash" || stage === "lock";
      const tDX = locked ? 0 : leftTargetX;
      const tDY = locked ? 0 : leftTargetY;
      const tDS = locked ? FUSION_RADIUS_SCALE : leftTargetScale;
      const tTX = locked ? 0 : rightTargetX;
      const tTY = locked ? 0 : rightTargetY;
      const tTS = locked ? FUSION_RADIUS_SCALE : rightTargetScale;

      const smoothAlpha = 1 - Math.exp(-SMOOTH_K * dt);
      deuterium.centerX += (tDX - deuterium.centerX) * smoothAlpha;
      deuterium.centerY += (tDY - deuterium.centerY) * smoothAlpha;
      deuterium.radiusScale += (tDS - deuterium.radiusScale) * smoothAlpha;
      tritium.centerX += (tTX - tritium.centerX) * smoothAlpha;
      tritium.centerY += (tTY - tritium.centerY) * smoothAlpha;
      tritium.radiusScale += (tTS - tritium.radiusScale) * smoothAlpha;

      stepHelix(deuterium, dt, tNoise);
      stepHelix(tritium, dt, tNoise);

      // Center-distance overlap → smoothed %. With FAR_MULT = 5/3 the
      // OVERLAP_TRIGGER = 40 lands at d = sumR (outer edges just touch).
      const rD = HELIX_OUTER * deuterium.radiusScale;
      const rT = HELIX_OUTER * tritium.radiusScale;
      const sumR = rD + rT;
      const dx = tritium.centerX - deuterium.centerX;
      const dy = tritium.centerY - deuterium.centerY;
      const d = Math.hypot(dx, dy);
      const dFar = OVERLAP_FAR_MULT * sumR;
      const rawPct =
        dFar > 0 ? Math.max(0, Math.min(100, (1 - d / dFar) * 100)) : 0;
      const smoothAlphaMetric = 1 - Math.exp(-OVERLAP_SMOOTH_K * dt);
      overlapSmoothed += (rawPct - overlapSmoothed) * smoothAlphaMetric;

      // Stage transitions.
      stageTime += dt;
      const overlappingNow = overlapSmoothed >= OVERLAP_TRIGGER;
      if (stage === "idle") {
        if (overlappingNow) {
          stage = "charging";
          stageTime = 0;
        }
      } else if (stage === "charging") {
        if (!overlappingNow) {
          stage = "idle";
          stageTime = 0;
        } else if (stageTime >= CHARGE_DURATION) {
          stage = "flash";
          stageTime = 0;
          // Fire the neutron from the fusion point (world origin), mostly
          // in-plane so it reads on the tilted ortho camera.
          const ang = Math.random() * TWO_PI;
          neutronVel.set(
            Math.cos(ang) * NEUTRON_SPEED,
            Math.sin(ang) * NEUTRON_SPEED,
            (Math.random() - 0.5) * 0.4 * NEUTRON_SPEED,
          );
          neutron.position.set(0, 0, 0);
          neutronAge = 0;
        }
      } else if (stage === "flash") {
        if (stageTime >= FLASH_DURATION) {
          stage = "lock";
          stageTime = 0;
        }
      } else if (stage === "lock") {
        // Flash ran in parallel inside the first FLASH_DURATION of lock;
        // remaining lock time is LOCK_DURATION − FLASH_DURATION.
        if (stageTime >= LOCK_DURATION - FLASH_DURATION) {
          stage = "idle";
          stageTime = 0;
        }
      }

      // Camera move through the reward window. While flash/lock, tilt to
      // PAN_TILT and pan azimuth A→B; rewardTime maps [0, LOCK_DURATION] → [0,1]
      // eased by smootherstep (ease in/out). When the window ends, ease back to
      // the default view (azimuth 0, TILT) over CAM_RETURN_DURATION. idle with
      // no return in flight leaves the camera untouched (zero per-frame cost).
      if (interactive && controls) {
        // Intro page: the user owns the camera via OrbitControls. Advance the
        // damping and keep the backdrop parked behind the freely-orbited view.
        controls.update();
        parkBackdrop();
      } else {
        const panning = stage === "flash" || stage === "lock";
        if (panning) {
          rewardTime += dt;
          const t = Math.min(1, rewardTime / LOCK_DURATION);
          const e = t * t * t * (t * (t * 6 - 15) + 10);
          // Calm reward: no azimuth pan, no zoom (the ⁴He model sits to the
          // right and must stay framed + sharp) — just a gentle eased tilt-up.
          setCameraPose(0, TILT + (PAN_TILT - TILT) * e, 1);
          camPanning = true;
          camReturning = false; // a fresh reaction cancels any in-flight return
        } else {
          if (camPanning) {
            // Window just ended — ease the return from preset B / PAN_TILT.
            camReturning = true;
            camReturnTime = 0;
            camPanning = false;
            rewardTime = 0;
          }
          if (camReturning) {
            camReturnTime += dt;
            const t = Math.min(1, camReturnTime / CAM_RETURN_DURATION);
            const e = t * t * t * (t * (t * 6 - 15) + 10);
            // Ease the gentle tilt back down to the default view.
            setCameraPose(0, PAN_TILT + (TILT - PAN_TILT) * e, 1);
            if (t >= 1) camReturning = false;
          }
        }
      }

      // Neutron flight + fade.
      if (neutronAge <= NEUTRON_LIFE) {
        neutronAge += dt;
        neutron.position.addScaledVector(neutronVel, dt);
        const remaining = NEUTRON_LIFE - neutronAge;
        neutronMat.opacity =
          remaining < NEUTRON_FADE ? Math.max(0, remaining / NEUTRON_FADE) : 1;
        neutron.visible = neutronAge <= NEUTRON_LIFE;
      } else if (neutron.visible) {
        neutron.visible = false;
      }

      // Per-stage visual ramps. colorMix lerps each helix's material color and
      // emissive between its original (cyan / violet) and gold; emissiveI pushes
      // pixels above the bloom threshold during flash/lock.
      let bloomStrength = 0;
      let emissiveI = 0;
      let colorMix = 0;

      if (stage === "charging") {
        const t = stageTime / CHARGE_DURATION;
        const e = t * t * (3 - 2 * t);
        moodLight.intensity = e * MOOD_MAX_INTENSITY;
        moodLight.color.copy(colorCharging);
        ambientLight.intensity = AMBIENT_BASE;
      } else if (stage === "flash") {
        const t = stageTime / FLASH_DURATION;
        bloomStrength = BLOOM_STRENGTH_MAX * t;
        emissiveI = EMISSIVE_MAX * t;
        colorMix = t;
        // Flashbulb: instant spike decaying exponentially over the 2s window.
        ambientLight.intensity = AMBIENT_BASE + AMBIENT_FLASH_PEAK * Math.exp(-t * 4);
        moodLight.intensity = MOOD_MAX_INTENSITY * (1 - t);
        moodLight.color.copy(colorCharging);
      } else if (stage === "lock") {
        // Bloom ramps MAX → RIM over the first RIM_RAMP_DURATION seconds, then
        // holds at RIM. Emissive stays at max so the gold pops.
        const t = Math.min(1, stageTime / RIM_RAMP_DURATION);
        bloomStrength = BLOOM_STRENGTH_MAX + (BLOOM_STRENGTH_RIM - BLOOM_STRENGTH_MAX) * t;
        emissiveI = EMISSIVE_MAX;
        colorMix = 1;
        ambientLight.intensity = AMBIENT_BASE;
        moodLight.intensity = 0;
      } else {
        // idle — neutral baseline; mood light color reset to charging tint so
        // the next charge starts sky-blue.
        ambientLight.intensity = AMBIENT_BASE;
        moodLight.intensity = 0;
        moodLight.color.copy(colorCharging);
      }

      // Skip the bloom pass entirely outside the reward window.
      bloomPass.enabled = bloomStrength > 0;
      bloomPass.strength = bloomStrength;

      tmpColor.copy(deuteriumOriginalColor).lerp(colorGold, colorMix);
      deuterium.material.color.copy(tmpColor);
      deuterium.material.emissive.copy(colorGold).multiplyScalar(colorMix);
      deuterium.material.emissiveIntensity = emissiveI;

      tmpColor.copy(tritiumOriginalColor).lerp(colorGold, colorMix);
      tritium.material.color.copy(tmpColor);
      tritium.material.emissive.copy(colorGold).multiplyScalar(colorMix);
      tritium.material.emissiveIntensity = emissiveI;

      // Atomic models: D & T ride above their helix and fade out while merged
      // (flash/lock); the ⁴He model fades in during lock to the right of the
      // fused nucleus. Electrons orbit continuously.
      const dtTarget = locked ? 0 : 1;
      const heTarget = stage === "lock" ? 1 : 0;
      const modelAlpha = 1 - Math.exp(-MODEL_FADE_K * dt);
      dModel.opacity += (dtTarget - dModel.opacity) * modelAlpha;
      tModel.opacity += (dtTarget - tModel.opacity) * modelAlpha;
      heModel.opacity += (heTarget - heModel.opacity) * modelAlpha;
      dModel.setOpacity(dModel.opacity);
      tModel.setOpacity(tModel.opacity);
      heModel.setOpacity(heModel.opacity);
      dModel.group.position.set(deuterium.centerX, deuterium.centerY + MODEL_Y, 0);
      tModel.group.position.set(tritium.centerX, tritium.centerY + MODEL_Y, 0);
      heModel.group.position.set(HE_MODEL_X, 0, 0);
      for (const model of [dModel, tModel, heModel]) {
        // Slow turntable spin around the model's own vertical (Y) axis. The
        // label sits on +Y, so spinning around Y keeps it anchored (and the
        // sprite always faces the camera) while the nucleus + electrons turn.
        model.group.rotation.y += MODEL_SPIN * dt;
        if (!model.group.visible) continue;
        for (const el of model.electrons) {
          el.angle += el.speed * dt;
          el.mesh.position
            .copy(el.u)
            .multiplyScalar(Math.cos(el.angle) * ORBIT_R)
            .addScaledVector(el.v, Math.sin(el.angle) * ORBIT_R);
        }
      }

      // Charge meter: fills 0→1 during charging; stays full through the reward.
      const fill = chargeFillRef.current;
      const track = chargeTrackRef.current;
      if (fill && track) {
        const fillT =
          stage === "charging"
            ? stageTime / CHARGE_DURATION
            : stage === "idle"
              ? 0
              : 1;
        fill.style.transform = `scaleX(${fillT})`;
        track.style.opacity = stage === "idle" ? "0" : "1";
      }

      // Energy label: shown during the reward window (flash + lock).
      const burst = burstLabelRef.current;
      if (burst) {
        burst.style.opacity = locked ? "1" : "0";
      }

      // Drive the afterimage trail: damp→0 when the camera is moving (orbit or
      // scripted pan) so nothing smears, easing back to AFTERIMAGE_DAMP when it
      // settles. Riding damp (not .enabled) avoids a stale ghost on re-enable —
      // at damp≈0 the buffer just holds the current frame.
      const camMoved =
        camera.position.distanceTo(prevCamPos) > 1e-3 ||
        camera.quaternion.angleTo(prevCamQuat) > 1e-4 ||
        Math.abs(camera.zoom - prevZoom) > 1e-4;
      prevCamPos.copy(camera.position);
      prevCamQuat.copy(camera.quaternion);
      prevZoom = camera.zoom;
      // The trail belongs to the intro (draggable) page and the fusion reward
      // window (flash/lock) only. During hand-driven demo interaction
      // (idle/charging) the helices chase the user's moving hands, so the
      // afterimage smears the tracked shapes — keep it off there. The camMoved
      // gate is retained so fusion looks exactly as before.
      const trailAllowed =
        interactive || stage === "flash" || stage === "lock";
      const dampTarget = trailAllowed && !camMoved ? AFTERIMAGE_DAMP : 0;
      trailDamp += (dampTarget - trailDamp) * (1 - Math.exp(-8 * dt));
      afterimagePass.uniforms.damp.value = trailDamp;

      composer.render();
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);

    return () => {
      cancelAnimationFrame(raf);
      controls?.dispose();
      resizeObserver.disconnect();
      deuterium.mesh.dispose();
      tritium.mesh.dispose();
      deuterium.material.dispose();
      tritium.material.dispose();
      cubeGeom.dispose();
      neutronGeom.dispose();
      neutronMat.dispose();
      backdropGeom.dispose();
      backdropMat.dispose();
      dModel.dispose();
      tModel.dispose();
      heModel.dispose();
      nucleonGeom.dispose();
      electronGeom.dispose();
      orbitGeom.dispose();
      bloomPass.dispose();
      composer.dispose();
      renderer.dispose();
      if (renderer.domElement.parentNode) {
        renderer.domElement.parentNode.removeChild(renderer.domElement);
      }
    };
  }, []);

  return (
    <div ref={containerRef} className="particle-stage" aria-hidden="true">
      <div ref={chargeTrackRef} className="charge-bar">
        <div ref={chargeFillRef} className="charge-bar-fill" />
        <span className="charge-bar-label">库仑势垒 · 蓄能中</span>
      </div>
      <div ref={burstLabelRef} className="fusion-burst-label">
        <span className="fusion-burst-eq">D + T → ⁴He + n</span>
        <span className="fusion-burst-energy">+17.6 MeV 能量释放</span>
      </div>
    </div>
  );
}
