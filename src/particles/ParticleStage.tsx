import { useEffect, useRef } from "react";
import * as THREE from "three";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";
import { OutputPass } from "three/examples/jsm/postprocessing/OutputPass.js";
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
const CUBE_SIZE = 0.09;
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
// Frustum sized to give each hand room to wander across the screen without
// the helix clipping off the far edge.
const FRUSTUM_HEIGHT = 18;
// Lifetime / fade. At steady state count/LIFETIME particles respawn per second
// per helix. Respawn rewrites pre-allocated typed arrays in place — no
// allocation, no GC churn.
const LIFETIME = 5.0;
const FADE = 0.3;
// Strand tube radius. Each particle gets a constant (offsetU, offsetV) inside
// a disk of radius TUBE_R; eU = world +Z, eV = radial-in-XY at the particle's
// current θ. ~23% of R_MINOR — visible volume without losing the double-helix
// silhouette.
const TUBE_R = 0.55;
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
// (R_MAJOR + R_MINOR + TUBE_R) is ~7.15, so at ±8 the strands are visibly
// separated; users have to bring their hands together to overlap them.
const HOME_OFFSET = 8;

// Cross-system overlap via center distance. Each helix is a torus (mostly empty
// interior), so a voxel metric caps low even when they visibly interpenetrate —
// center-distance gives a clean analytic alternative.
//   HELIX_OUTER = farthest particle radius from center (main + minor + tube).
//   Per-helix effective outer radius = HELIX_OUTER × radiusScale.
const HELIX_OUTER = R_MAJOR + R_MINOR + TUBE_R;
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
const BLOOM_STRENGTH_MAX = 1.8;
const BLOOM_STRENGTH_RIM = 0.3;
const RIM_RAMP_DURATION = 0.5;
const BLOOM_RADIUS = 0.8;
const BLOOM_THRESHOLD = 0.6;
const AMBIENT_BASE = 0.3;
const AMBIENT_FLASH_PEAK = 3.0;
const EMISSIVE_MAX = 2.5;

// Ejected neutron: a single pale, emissive sphere launched from the fusion
// point at flash start, flying off mostly in-plane and fading out over its
// lifetime.
const NEUTRON_SPEED = 16;
const NEUTRON_LIFE = 1.8;
const NEUTRON_FADE = 0.5;
const NEUTRON_SIZE = 0.55;

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

export default function ParticleStage() {
  const containerRef = useRef<HTMLDivElement>(null);
  const chargeFillRef = useRef<HTMLDivElement>(null);
  const chargeTrackRef = useRef<HTMLDivElement>(null);
  const burstLabelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const initialRect = container.getBoundingClientRect();
    let viewW = Math.max(1, Math.floor(initialRect.width));
    let viewH = Math.max(1, Math.floor(initialRect.height));

    const isMobile = isMobileDevice();
    const countPerHelix = isMobile ? 1000 : 4000;
    const pixelRatio = Math.min(window.devicePixelRatio, 2);

    const renderer = new THREE.WebGLRenderer({
      antialias: true,
      alpha: true,
      powerPreference: "high-performance",
    });
    renderer.setPixelRatio(pixelRatio);
    renderer.setClearColor(0x000000, 0);
    renderer.setSize(viewW, viewH);
    container.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    const initialAspect = viewW / viewH;
    const camera = new THREE.OrthographicCamera(
      (-FRUSTUM_HEIGHT * initialAspect) / 2,
      (FRUSTUM_HEIGHT * initialAspect) / 2,
      FRUSTUM_HEIGHT / 2,
      -FRUSTUM_HEIGHT / 2,
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

    const cubeGeom = new THREE.BoxGeometry(CUBE_SIZE, CUBE_SIZE, CUBE_SIZE);

    // Re-randomize a single particle in-place and snap its position to its
    // freshly computed target. Used both at init and at end-of-life respawn.
    // φ is preserved across respawn — each particle owns a fixed slot on the
    // strand and flows continuously, so a respawn just rerolls offset / spin /
    // scale / age without teleporting the particle to a new slot.
    const respawnParticle = (h: Helix, i: number) => {
      const phi = h.phi[i];

      // Disk-uniform offset in (eU, eV). sqrt(u) keeps density flat out to
      // r = TUBE_R; without it the tube would be denser near the axis.
      const u = Math.random();
      const tau = Math.random() * Math.PI * 2;
      const r = TUBE_R * Math.sqrt(u);
      const oU = r * Math.cos(tau);
      const oV = r * Math.sin(tau);
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
      h.angVel[ix] = (Math.random() - 0.5) * 1.2;
      h.angVel[ix + 1] = (Math.random() - 0.5) * 1.2;
      h.angVel[ix + 2] = (Math.random() - 0.5) * 1.2;
      h.scales[i] = 0.7 + Math.random() * 0.8;
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

    const dummy = new THREE.Object3D();
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

    // Post-processing: RenderPass → UnrealBloomPass → OutputPass. Bloom starts
    // disabled (and stays disabled outside the reward window to skip its
    // bright-pixel extraction). OutputPass maps emissive HDR cleanly to LDR.
    const composer = new EffectComposer(renderer);
    composer.setPixelRatio(pixelRatio);
    composer.setSize(viewW, viewH);
    composer.addPass(new RenderPass(scene, camera));
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
      renderer.setSize(w, h);
      composer.setSize(w, h);
      bloomPass.setSize(w, h);
      const aspect = w / h;
      camera.left = (-FRUSTUM_HEIGHT * aspect) / 2;
      camera.right = (FRUSTUM_HEIGHT * aspect) / 2;
      camera.top = FRUSTUM_HEIGHT / 2;
      camera.bottom = -FRUSTUM_HEIGHT / 2;
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

    let stage: Stage = "idle";
    let stageTime = 0;
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
        const s = h.scales[i] * fade;

        dummy.position.set(px, py, pz);
        dummy.rotation.set(rotX, rotY, rotZ);
        dummy.scale.set(s, s, s);
        dummy.updateMatrix();
        h.mesh.setMatrixAt(i, dummy.matrix);
      }
      h.mesh.instanceMatrix.needsUpdate = true;
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

    const loop = () => {
      const now = performance.now();
      const dt = Math.min(1 / 30, Math.max(1 / 120, (now - prevT) / 1000));
      prevT = now;
      const tNoise = (now - startT) / 1000;

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

      // During flash + lock, both helices are pinned to world origin with unit
      // radius (the fused ⁴He); hand input is ignored. Smoothing pulls them
      // toward (0,0) without a snap, and back to the hands at lock-end.
      const locked = stage === "flash" || stage === "lock";
      const tDX = locked ? 0 : leftTargetX;
      const tDY = locked ? 0 : leftTargetY;
      const tDS = locked ? 1 : leftTargetScale;
      const tTX = locked ? 0 : rightTargetX;
      const tTY = locked ? 0 : rightTargetY;
      const tTS = locked ? 1 : rightTargetScale;

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

      composer.render();
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);

    return () => {
      cancelAnimationFrame(raf);
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
