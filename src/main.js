import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { GPU } from './gpu.js';
import { terrainJS } from './common.js';
import { Surf, makeSwell } from './swe.js';
import { Ocean } from './ocean.js';
import { bakeSky, skyDome, sunIrradiance } from './sky.js';
import { polarGrid, makeUniforms, waterMaterial, sandMaterial, PHOTON_FS } from './render.js';
import { Caustics } from './caustics.js';
import { bakeTerrain } from './terrain.js';
import { buildTrees } from './trees.js';

const q = new URLSearchParams(location.search);
const DEG = Math.PI / 180;
const DT = 1 / 120;
const OFF = +(q.get('off') ?? 0);
const FLOW_T = 5.0;

const renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: 'high-performance', preserveDrawingBuffer: q.has('shot') });
renderer.setPixelRatio(Math.min(devicePixelRatio, q.has('hq') ? 2 : 1.25));
renderer.setSize(innerWidth, innerHeight);
renderer.toneMapping = THREE.NeutralToneMapping;
renderer.toneMappingExposure = +(q.get('exp') ?? 0.23);
document.body.appendChild(renderer.domElement);
const gl = renderer.getContext();
if (!gl.getExtension('EXT_color_buffer_float')) document.getElementById('load').textContent = 'This needs WebGL2 float render targets.';

const gpu = new GPU(renderer);
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(+(q.get('fov') ?? 44), innerWidth / innerHeight, 0.05, 20000);
camera.rotation.order = 'YXZ';

// high sun from the left and a little behind: boulders lit from the side, no glare on the lake
const sunEl = +(q.get('sunel') ?? 58) * DEG, sunAz = +(q.get('sunaz') ?? -115) * DEG;
const sunDir = new THREE.Vector3(Math.sin(sunAz) * Math.cos(sunEl), Math.sin(sunEl), -Math.cos(sunAz) * Math.cos(sunEl)).normalize();
const sunE = sunIrradiance(sunDir);
const skyMaps = bakeSky(gpu, sunDir, sunE);
const env = skyMaps.env;
const terr = bakeTerrain(gpu);

const swell = makeSwell(+(q.get('surf') ?? 1));
const surf = new Surf(gpu, { ...swell, ...terr.uniforms });
const ocean = new Ocean(gpu, { wind: +(q.get('wind') ?? 1.2), fetch: 5000, windAngle: 0.35, chop: 0.25 });

const tl = new THREE.TextureLoader();
const tex = (url, srgb) => {
  const t = tl.load(url);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = renderer.capabilities.getMaxAnisotropy();
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  return t;
};

const shared = { uSunDir: { value: sunDir }, uSunE: { value: sunE } };
const U = makeUniforms({
  ...shared, ...swell, ...ocean.uniforms(), ...terr.uniforms,
  uGranite: { value: tex('tex/granite.jpg', true) },
  uEnv: { value: env },
  uSand: { value: tex('tex/sand.jpg', true) },
  uSandN: { value: tex('tex/sand_n.png', false) },
  uFoamTex: { value: tex('tex/foam.png', false) },
});

U.uOff.value = +(q.get('off') ?? 0);
U.uDbg.value = +(q.get('dbgw') ?? 0) || (q.has('dbgw') ? 1 : 0);
U.uCaus = { value: null };
U.uCausDom = { value: new THREE.Vector4() };
const caustics = new Caustics(gpu, PHOTON_FS, U);
U.uCaus.value = caustics.tex.texture;
U.uCausDom.value = caustics.dom;

const mtn = new THREE.TextureLoader().load(q.has('nomtn') ? 'favicon.svg' : 'tex/mountains.webp?v=5');
mtn.colorSpace = THREE.SRGBColorSpace;
mtn.anisotropy = 8;
mtn.generateMipmaps = false;
mtn.minFilter = THREE.LinearFilter;
scene.add(skyDome(skyMaps.sky, shared, mtn));
const water = new THREE.Mesh(polarGrid(0.25, 15000, 1.012, 760, 2.45), waterMaterial(U));
water.frustumCulled = false;
if (!((+(q.get('off') ?? 0)) & 16)) scene.add(water);
const sand = new THREE.Mesh(polarGrid(0.25, 900, 1.01, 900, 2.45), sandMaterial(U));
sand.frustumCulled = false;
if (!((+(q.get('off') ?? 0)) & 8)) scene.add(sand);

// standard-material props (the pines) lit on the same scale as the custom shaders
const sunLum = sunE.x * 0.2126 + sunE.y * 0.7152 + sunE.z * 0.0722;
scene.add(new THREE.HemisphereLight(0x8fb6ff, 0x9a9080, Math.PI * 0.06 * sunLum));
const sunLight = new THREE.DirectionalLight(0xfff4e8, sunLum);
sunLight.position.copy(sunDir).multiplyScalar(100);
scene.add(sunLight);
const trees = buildTrees(scene, [[31, 68, 16, 0], [35.5, 71.5, 12, 1], [40, 70, 9, 1]].map(([x, d, h, k]) => ({ x, d, h, k, y: terr.heightAt(x, d) })), [tex('tex/pineA.png', true), tex('tex/pineB.png', true)], sunE);

// camera: standing at the top of the swash, handheld; drag to look, wheel to crouch/stand
const cam = { x: +(q.get('x') ?? 0), d: +(q.get('d') ?? -1.2), h: +(q.get('h') ?? 1.6), yaw: +(q.get('yaw') ?? 0), pitch: +(q.get('pitch') ?? -1) };
let drag = null;
addEventListener('pointerdown', (e) => { drag = { x: e.clientX, y: e.clientY, yaw: cam.yaw, pitch: cam.pitch }; });
addEventListener('pointerup', () => { drag = null; });
addEventListener('pointermove', (e) => {
  if (!drag) return;
  cam.yaw = Math.max(-80, Math.min(80, drag.yaw - (e.clientX - drag.x) * 0.12));
  cam.pitch = Math.max(-40, Math.min(12, drag.pitch - (e.clientY - drag.y) * 0.12));
});
addEventListener('wheel', (e) => { cam.h = Math.max(0.3, Math.min(4, cam.h - e.deltaY * 0.002)); });

function placeCamera(t) {
  const n = (f, p) => Math.sin(t * f + p);
  const still = q.has('freeze') ? 0 : 1;
  const yaw = cam.yaw + still * (0.35 * n(0.23, 1) + 0.12 * n(0.71, 2) + 0.04 * n(2.3, 3));
  const pitch = cam.pitch + still * (0.25 * n(0.31, 4) + 0.1 * n(0.93, 5) + 0.03 * n(2.9, 6));
  const roll = still * (0.3 * n(0.19, 7) + 0.08 * n(0.8, 8));
  camera.position.set(cam.x + 0.02 * still * n(0.4, 9), terrainJS(cam.x, cam.d) + cam.h + 0.012 * still * n(0.6, 1), -cam.d);
  camera.rotation.set(pitch * DEG, -yaw * DEG, roll * DEG);
}

// post: bloom on the glitter, filmic tone map, a touch of sensor grain
const size = renderer.getDrawingBufferSize(new THREE.Vector2());
const composer = new EffectComposer(renderer, new THREE.WebGLRenderTarget(size.x, size.y, { type: THREE.HalfFloatType, samples: 2 }));
composer.addPass(new RenderPass(scene, camera));
composer.addPass(new OutputPass());
const grain = new ShaderPass({
  uniforms: { tDiffuse: { value: null }, uT: { value: 0 } },
  vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix*modelViewMatrix*vec4(position, 1.0); }`,
  fragmentShader: `uniform sampler2D tDiffuse; uniform float uT; varying vec2 vUv;
    float h(vec2 p){ vec3 p3 = fract(vec3(p.xyx)*.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y)*p3.z); }
    void main(){ vec3 c = texture2D(tDiffuse, vUv).rgb; float l = dot(c, vec3(0.2126, 0.7152, 0.0722)); c = mix(vec3(l), c, 1.12); c = clamp((c - 0.5)*1.1 + 0.5, 0.0, 1.0); c = clamp((c - 0.5)*1.06 + 0.5, 0.0, 1.0); c += (h(gl_FragCoord.xy + fract(uT)*517.0) - 0.5)*0.012; gl_FragColor = vec4(c, 1.0); }`,
});
composer.addPass(grain);

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
  composer.setSize(innerWidth, innerHeight);
});

// warm the sea up so the first frame already has sets rolling in and wet sand
const WARM = +(q.get('t') ?? 45);
let simT = 0, acc = 0, last = performance.now(), fpsN = 0, fpsT = 0;
const loadEl = document.getElementById('load');

function simulate(steps) {
  for (let i = 0; i < steps; i++) {
    swell.uRamp.value = Math.min(1, simT / 10);
    surf.step(DT, simT);
    simT += DT;
  }
}
// resolution scaling: judge the average frame time over 2 s windows against the display's refresh,
// change by small steps with hysteresis, so render targets are rebuilt rarely (resizes are expensive)
let prMax = Math.min(devicePixelRatio, q.has('hq') ? 2 : 1.5), pr = Math.min(devicePixelRatio, 1.25);
let winT = 0, winN = 0, best = 1, cool = 0;
function adaptResolution(dt) {
  if (q.has('shot') || q.has('fixres')) return;
  winT += dt; winN++;
  if (winT < 2) return;
  const avg = winT / winN;
  winT = 0; winN = 0;
  best = Math.min(best * 1.02, avg);
  const refresh = Math.max(best, 1 / 144);
  if (cool-- > 0) return;
  let next = pr;
  if (avg > refresh * 1.35) next = Math.max(Math.min(devicePixelRatio, 1), pr * 0.85);
  else if (avg < refresh * 1.08 && pr < prMax) next = Math.min(prMax, pr * 1.1);
  if (Math.abs(next - pr) > 0.02) {
    pr = next;
    renderer.setPixelRatio(pr);
    composer.setPixelRatio(pr);
    composer.setSize(innerWidth, innerHeight);
    cool = 1;
  }
}
function flowWeights(t) {
  const s = (p) => Math.min(1, p / 0.18) * Math.min(1, (1 - p) / 0.18);
  const p1 = (t / FLOW_T) % 1, p2 = (t / FLOW_T + 0.5) % 1;
  const a = s(p1), b = s(p2), n = a + b || 1;
  U.uFlowW.value.set(a / n, b / n);
}

function frame(now) {
  const real = Math.min((now - last) / 1000, 1 / 20);
  last = now;
  let fdt;
  if (simT < WARM) {
    const before = simT;
    for (let k = 0; k < 12; k++) { simulate(25); surf.frame(25 * DT, simT, FLOW_T); }
    fdt = simT - before;
    if (loadEl) loadEl.textContent = `warming up the sea ${Math.min(99, Math.round(100 * simT / WARM))}%`;
  } else {
    if (loadEl && loadEl.style.display !== 'none') loadEl.style.display = 'none';
    // advance by exactly the real frame time in equal cfl-safe substeps: smooth at 60, 120 or any refresh
    const span = q.has('freeze') ? 0 : real;
    const n = span > 0 ? Math.min(12, Math.ceil(span / DT)) : 0;
    const h = n ? span / n : 0;
    for (let i = 0; i < n; i++) { swell.uRamp.value = Math.min(1, simT / 10); if (!(OFF & 32)) surf.step(h, simT); simT += h; }
    fdt = span;
    if (!(OFF & 32)) surf.frame(fdt, simT, FLOW_T);
    adaptResolution(real);
  }
  if (!(OFF & 64)) ocean.update(simT, Math.max(fdt, 1e-4));
  ocean.bind(U);
  flowWeights(simT);
  U.uSurfA.value = surf.surfA.texture;
  U.uM.value = surf.m0.texture;
  U.uFlow.value = surf.f0.texture;
  U.uTime.value = simT;

  placeCamera(simT);
  camera.updateMatrixWorld();
  trees.update(camera);
  U.uCamPos.value.copy(camera.position);
  if (!((+(q.get('off') ?? 0)) & 4)) caustics.update(camera.position, cam.yaw * DEG);
  grain.uniforms.uT.value = simT;
  if (OFF & 128) renderer.render(scene, camera); else composer.render();
  if (simT >= WARM) window.__ready = true;
  if (q.has('fps')) { fpsN++; if (now - fpsT > 2000) { console.log('fps', (fpsN * 1000 / (now - fpsT)).toFixed(1)); fpsN = 0; fpsT = now; } }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

// debug probe: depth and level along the beach profile at x=0 (read from the gpu)
window.__probe = () => {
  const b = new Float32Array(4), r = [];
  for (const [t, rt] of [['a', surf.a], ['raw', surf.etaRaw], ['A', surf.surfA]]) {
    renderer.readRenderTargetPixels(rt, 512, 200, 1, 1, b);
    r.push(t + ':' + Array.from(b).map((v) => v.toFixed(3)).join(','));
  }
  return r.join(' | ');
};
window.__rows = () => {
  const out = [];
  const buf = new Float32Array(1024 * 4);
  for (const d of [20, 30, 36, 40, 44, 48, 52, 55]) {
    const j = Math.floor((d + 8) / 0.125);
    renderer.readRenderTargetPixels(surf.surfA, 0, j, 1024, 1, buf);
    let mx = -1e9, mn = 1e9, nan = 0;
    for (let i = 0; i < 1024; i++) { const v = buf[i * 4]; if (!isFinite(v)) nan++; else { mx = Math.max(mx, v); mn = Math.min(mn, v); } }
    out.push(`d=${d}: eta ${mn.toFixed(2)}..${mx.toFixed(2)} nan=${nan}`);
  }
  return out.join('\n');
};
window.__dbg = () => {
  const out = [];
  const buf = new Float32Array(4);
  for (const d of [-6, -4, -3, -2, -1, 0, 2, 5, 10, 20, 30, 45, 54]) {
    const j = Math.floor((d + 8) / 0.125), i = 512;
    renderer.readRenderTargetPixels(surf.a, i, j, 1, 1, buf);
    out.push(`d=${d}: h=${buf[0].toFixed(3)} u=${buf[1].toFixed(2)} w=${buf[2].toFixed(2)} eta=${(buf[0] + terrainJS(0, d)).toFixed(3)}`);
  }
  return out.join('\n');
};
