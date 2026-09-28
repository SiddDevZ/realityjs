import * as THREE from 'three';
import { HEAD, SIM, NSWELL, groundJS } from './common.js';

// nearshore surf: nonlinear shallow water on a staggered grid (chentanez & muller 2010 style).
// state texel (i,j): r = depth h at the cell centre, g = u on the +x face, b = w on the +d face, a = foam.
// the offshore band relaxes toward the incoming linear swell, so waves enter and leave cleanly.

const G = 9.81;

const SIM_HEAD = HEAD + /* glsl */ `
uniform sampler2D uS, uT;
uniform float uDt, uTime;
ivec2 wr(ivec2 p){ return ivec2((p.x + NX) % NX, clamp(p.y, 0, NZ - 1)); }
vec4 S(ivec2 p){ return texelFetch(uS, wr(p), 0); }
float Bt(ivec2 p){ return texelFetch(uT, wr(p), 0).r; }
vec2 cellXD(vec2 q){ return vec2(X0, D0) + q*DX; }  // q in index space, cell centre at +0.5
float sponge(float d){ float s = clamp((d - SPONGE0)/(SPONGE1 - SPONGE0), 0.0, 1.0); return s*s; }
`;

const FS_TERRAIN = SIM_HEAD + /* glsl */ `
out vec4 o;
// the sim's bed stops at 3 m: deeper water changes nothing for these short waves but breaks the explicit step
void main(){ vec2 q = gl_FragCoord.xy; o = vec4(max(terrainB(cellXD(q)), -3.0), 0.0, 0.0, 1.0); }
`;

const FS_INIT = SIM_HEAD + /* glsl */ `
out vec4 o;
void main(){ ivec2 id = ivec2(gl_FragCoord.xy); o = vec4(max(-Bt(id), 0.0), 0.0, 0.0, 0.0); }
`;

// 1. semi-lagrangian velocity advection on the staggered faces
const FS_ADVECT = SIM_HEAD + /* glsl */ `
out vec4 o;
float bil(vec2 g, int c){
  vec2 f = fract(g); ivec2 i = ivec2(floor(g));
  float a = S(i)[c], b = S(i + ivec2(1,0))[c], cc = S(i + ivec2(0,1))[c], d = S(i + ivec2(1,1))[c];
  return mix(mix(a, b, f.x), mix(cc, d, f.x), f.y);
}
void main(){
  ivec2 id = ivec2(gl_FragCoord.xy);
  vec4 s = S(id);
  float k = uDt/DX;
  // u lives at (i+1, j+0.5) in index space
  float wU = 0.25*(S(id).b + S(id + ivec2(1,0)).b + S(id + ivec2(0,-1)).b + S(id + ivec2(1,-1)).b);
  vec2 pu = vec2(id) + vec2(1.0, 0.5) - k*vec2(s.g, wU);
  float un = bil(pu - vec2(1.0, 0.5), 1);
  // w lives at (i+0.5, j+1)
  float uW = 0.25*(S(id).g + S(id + ivec2(-1,0)).g + S(id + ivec2(0,1)).g + S(id + ivec2(-1,1)).g);
  vec2 pw = vec2(id) + vec2(0.5, 1.0) - k*vec2(uW, s.b);
  float wn = bil(pw - vec2(0.5, 1.0), 2);
  o = vec4(s.r, un, wn, s.a);
}
`;

// 2. mass: upwind fluxes, foam transport + generation (kennedy-style breaking on fast-rising fronts)
const FS_HEIGHT = SIM_HEAD + /* glsl */ `
out vec4 o;
float bilA(vec2 g){
  vec2 f = fract(g); ivec2 i = ivec2(floor(g));
  return mix(mix(S(i).a, S(i + ivec2(1,0)).a, f.x), mix(S(i + ivec2(0,1)).a, S(i + ivec2(1,1)).a, f.x), f.y);
}
void main(){
  ivec2 id = ivec2(gl_FragCoord.xy);
  vec4 s = S(id);
  vec4 sL = S(id - ivec2(1,0)), sR = S(id + ivec2(1,0)), sB = S(id - ivec2(0,1)), sT = S(id + ivec2(0,1));
  float h = s.r;
  float uR = s.g, uL = sL.g, wT = s.b, wB = sB.b;
  float fR = uR*(uR > 0.0 ? h : sR.r);
  float fL = uL*(uL > 0.0 ? sL.r : h);
  float fT = wT*(wT > 0.0 ? h : sT.r);
  float fB = wB*(wB > 0.0 ? sB.r : h);
  if(id.y == 0) fB = 0.0;
  if(id.y == NZ - 1) fT = 0.0;
  float dh = -uDt/DX*(fR - fL + fT - fB);
  float hn = max(h + dh, 0.0);

  vec2 xd = cellXD(vec2(id) + 0.5);
  float b = Bt(id);

  // foam rides the depth-averaged flow
  vec2 vc = vec2(0.5*(uL + uR), 0.5*(wB + wT));
  float foam = bilA(vec2(id) - uDt/DX*vc);
  float c = sqrt(9.81*max(h, 0.01));
  float etaT = dh/uDt;                                  // rate of rise of the surface
  float brk = smoothstep(0.35*c, 0.75*c, etaT)*smoothstep(0.04, 0.15, h);
  // the swash tip churns air in as it races up the sand
  float tip = smoothstep(0.35, 1.0, length(vc))*(1.0 - smoothstep(0.02, 0.08, h))*step(0.004, h)*step(0.0, -vc.y);
  // slope-steepened fronts spill before the rise-rate test trips
  float gx = (sR.r + Bt(id + ivec2(1,0)) - sL.r - Bt(id - ivec2(1,0)))/(2.0*DX);
  float gd = (sT.r + Bt(id + ivec2(0,1)) - sB.r - Bt(id - ivec2(0,1)))/(2.0*DX);
  float spill = smoothstep(0.38, 0.7, length(vec2(gx, gd)))*step(0.08, h)*step(0.0, -vc.y);
  // advancing swash front: wet cell with dry sand ahead, running up the beach
  // and water slapping against a boulder or the shore from any side
  bool dryNear = sB.r < 0.001 || sT.r < 0.001 || sL.r < 0.001 || sR.r < 0.001;
  float front = (h > 0.002 && dryNear) ? smoothstep(0.12, 0.5, length(vc)) : 0.0;
  tip += 1.0*front;
  float tau = mix(0.7, 2.6, smoothstep(0.01, 0.35, hn));
  foam = foam*exp(-uDt/tau) + uDt*(1.0*brk + 0.25*tip + 0.3*spill);
  foam = min(foam, 1.3);

  // relaxation zone toward the incoming swell
  float sp = sponge(xd.y);
  if(sp > 0.0){
    float a = 1.0 - exp(-uDt*10.0*sp);
    vec3 f = swell(xd, uTime);
    hn = mix(hn, max(f.x - b, 0.0), a);
    foam *= 1.0 - a;
  }
  o = vec4(hn, s.g, s.b, foam);
}
`;

// 3. momentum: pressure gradient, wet/dry walls, bed friction, light viscosity, clamps
const FS_VEL = SIM_HEAD + /* glsl */ `
out vec4 o;
const float EPS = 0.0008;
float face(float u, float h0, float h1, float b0, float b1, float lapU, vec2 vel, bool outerFace){
  float e0 = b0 + h0, e1 = b1 + h1;
  bool w0 = h0 > EPS, w1 = h1 > EPS;
  if(!w0 && !w1) return 0.0;
  if(!w0 && e1 <= b0) return 0.0;
  if(!w1 && e0 <= b1) return 0.0;
  u -= 9.81*uDt/DX*(e1 - e0);
  float hf = max(0.5*(h0 + h1), 0.0);
  float sp = length(vel);
  // manning bed friction, stronger in thin swash
  u /= 1.0 + uDt*9.81*0.022*0.022*sp/pow(max(hf, 0.004), 1.3333);
  u += 0.12*lapU;
  float lim = 0.45*DX/uDt;
  return clamp(u, -lim, lim);
}
void main(){
  ivec2 id = ivec2(gl_FragCoord.xy);
  vec4 s = S(id);
  vec4 sR = S(id + ivec2(1,0)), sT = S(id + ivec2(0,1));
  vec4 sL = S(id - ivec2(1,0)), sB = S(id - ivec2(0,1));
  float b = Bt(id), bR = Bt(id + ivec2(1,0)), bT = Bt(id + ivec2(0,1));
  float lapU = 0.25*(sR.g + sL.g + sT.g + sB.g) - s.g;
  float lapW = 0.25*(sR.b + sL.b + sT.b + sB.b) - s.b;
  float wAtU = 0.25*(s.b + sR.b + sB.b + S(id + ivec2(1,-1)).b);
  float uAtW = 0.25*(s.g + sL.g + sT.g + S(id + ivec2(-1,1)).g);
  float u = face(s.g, s.r, sR.r, b, bR, lapU, vec2(s.g, wAtU), false);
  float w = id.y == NZ - 1 ? s.b : face(s.b, s.r, sT.r, b, bT, lapW, vec2(uAtW, s.b), false);

  float d = X0*0.0 + D0 + (float(id.y) + 0.5)*DX;
  float sp = sponge(d);
  if(sp > 0.0){
    float a = 1.0 - exp(-uDt*10.0*sp);
    vec2 xu = vec2(X0 + (float(id.x) + 1.0)*DX, d);
    vec2 xw = vec2(X0 + (float(id.x) + 0.5)*DX, d + 0.5*DX);
    u = mix(u, swell(xu, uTime).y, a);
    w = mix(w, swell(xw, uTime).z, a);
  }
  o = vec4(s.r, u, w, s.a);
}
`;

// per-frame derived fields for rendering (half float, linearly filtered)
// A: eta, d(eta)/dx, d(eta)/dd, h     B: foam, wetness, stranded foam, seconds since drained
// per-frame derived fields for rendering (linearly filtered)
// A: water level (extended ~2 cells into the dry sand), d/dx, d/dd, depth
const FS_ETA = SIM_HEAD + /* glsl */ `
float etaExt(ivec2 id){
  vec4 s = S(id);
  float b = Bt(id);
  if(s.r > 0.0008) return b + s.r;
  float sum = 0.0, n = 0.0;
  for(int j=-2;j<=2;j++) for(int i=-2;i<=2;i++){
    ivec2 p = id + ivec2(i, j);
    float hp = S(p).r;
    if(hp > 0.0008){ float w = 1.0/(1.0 + float(i*i + j*j)); sum += (hp + Bt(p))*w; n += w; }
  }
  float e = n > 0.0 ? sum/n - 0.003 : b - 0.05;
  return min(e, b - 0.0004);
}
out vec4 o;
void main(){ ivec2 id = ivec2(gl_FragCoord.xy); o = vec4(etaExt(id), 0.0, 0.0, 0.0); }
`;
const FS_SURF = SIM_HEAD + /* glsl */ `
uniform sampler2D uR;
out vec4 oA;
float R(ivec2 p){ return texelFetch(uR, wr(p), 0).x; }
void main(){
  ivec2 id = ivec2(gl_FragCoord.xy);
  float e = R(id);
  float gx = (R(id + ivec2(1,0)) - R(id - ivec2(1,0)))/(2.0*DX);
  float gd = (R(id + ivec2(0,1)) - R(id - ivec2(0,1)))/(2.0*DX);
  float h = S(id).r;
  // a shallow-water bore is a numerical step one or two cells wide; real fronts are rounded over
  // roughly half a metre, so the rendered surface is a gaussian (sigma 2.5 cells) of the level there
  float wsum = 0.0, es = 0.0; vec2 gs = vec2(0.0);
  const float SG = 2.5;
  for(int j=-6;j<=6;j+=2) for(int i=-6;i<=6;i+=2){
    vec2 o = vec2(float(i), float(j));
    float w = exp(-dot(o, o)/(2.0*SG*SG));
    float v = R(id + ivec2(i, j));
    es += w*v; gs += w*o*v; wsum += w;
  }
  es /= wsum;
  gs = gs/(wsum*SG*SG*DX);
  float k = smoothstep(0.04, 0.3, h);
  e = mix(e, es, k);
  gx = mix(gx, gs.x, k); gd = mix(gd, gs.y, k);
  if(h < 0.0008){ gx = 0.0; gd = 0.0; }
  oA = vec4(e, gx, gd, h);
}
`;

// memory of the water: foam, slow max level (wet sand), fast max level (glassy just-drained sand), stranded foam
// B: depth-averaged velocity (x, d) at cell centres and a breaker mask for the crest lean
const FS_BRK = SIM_HEAD + /* glsl */ `
uniform sampler2D uA;
out vec4 o;
void main(){
  ivec2 id = ivec2(gl_FragCoord.xy);
  vec4 s = S(id);
  vec2 u = vec2(0.5*(S(id - ivec2(1,0)).g + s.g), 0.5*(S(id - ivec2(0,1)).b + s.b));
  vec4 A = texelFetch(uA, id, 0);
  vec2 g = A.yz;
  float gl = length(g);
  // a front: steep surface whose downslope faces the direction the water is moving
  float facing = -dot(g, u)/(gl*max(length(u), 0.05) + 1e-5);
  float brk = smoothstep(0.18, 0.5, gl)*smoothstep(0.2, 0.7, facing)*smoothstep(0.12, 0.35, s.r)*smoothstep(0.4, 1.5, length(u));
  o = vec4(u, brk, 0.0);
}
`;

const FS_MISC = SIM_HEAD + /* glsl */ `
uniform sampler2D uM, uA;
out vec4 o;
void main(){
  ivec2 id = ivec2(gl_FragCoord.xy);
  vec4 s = S(id);
  vec4 m = texelFetch(uM, id, 0);
  float e = texelFetch(uA, id, 0).x;
  bool wet = s.r > 0.004;
  float slow = max(m.g - 0.0012*uDt, e);
  float fast = max(m.b - 0.005*uDt, e);
  float strand = wet ? 0.0 : max(m.a*exp(-uDt/3.0), s.a*0.8);
  o = vec4(s.a, slow, fast, strand);
}
`;

// foam texture coordinates advected by the flow (two phases, reset alternately), stored as offsets
const FS_FLOW = SIM_HEAD + /* glsl */ `
uniform sampler2D uF;
uniform vec2 uReset;
out vec4 o;
vec4 bilF(vec2 g){
  vec2 f = fract(g); ivec2 i = ivec2(floor(g));
  ivec2 a = wr(i), b = wr(i + ivec2(1,0)), c = wr(i + ivec2(0,1)), d = wr(i + ivec2(1,1));
  return mix(mix(texelFetch(uF, a, 0), texelFetch(uF, b, 0), f.x), mix(texelFetch(uF, c, 0), texelFetch(uF, d, 0), f.x), f.y);
}
void main(){
  ivec2 id = ivec2(gl_FragCoord.xy);
  vec4 s = S(id);
  vec2 vc = vec2(0.5*(S(id - ivec2(1,0)).g + s.g), 0.5*(S(id - ivec2(0,1)).b + s.b));
  if(s.r < 0.002) vc = vec2(0.0);
  vec2 step = uDt*vc;
  vec4 f = bilF(vec2(id) - step/DX) - vec4(step, step);
  if(uReset.x > 0.5) f.xy = vec2(0.0);
  if(uReset.y > 0.5) f.zw = vec2(0.0);
  o = f;
}
`;

export class Surf {
  constructor(gpu, swellUniforms) {
    this.gpu = gpu;
    const { NX, NZ } = SIM;
    const f32 = { wrapS: THREE.RepeatWrapping };
    this.terrain = gpu.target(NX, NZ, f32);
    this.a = gpu.target(NX, NZ, f32);
    this.b = gpu.target(NX, NZ, f32);
    const half = { type: THREE.HalfFloatType, min: THREE.LinearFilter, mag: THREE.LinearFilter, wrapS: THREE.RepeatWrapping };
    const fl = gpu.r.extensions.has('OES_texture_float_linear') ? { ...half, type: THREE.FloatType } : half;
    this.surfA = gpu.target(NX, NZ, fl);
    this.surfB = gpu.target(NX, NZ, half);
    this.etaRaw = gpu.target(NX, NZ, { wrapS: THREE.RepeatWrapping });
    this.m0 = gpu.target(NX, NZ, fl); this.m1 = gpu.target(NX, NZ, fl);
    this.f0 = gpu.target(NX, NZ, half); this.f1 = gpu.target(NX, NZ, half);

    const U = (extra = {}) => ({
      uS: { value: null }, uT: { value: this.terrain.texture }, uDt: { value: 0 }, uTime: { value: 0 },
      ...swellUniforms, ...extra,
    });
    this.mTerrain = gpu.material(FS_TERRAIN, U());
    this.mInit = gpu.material(FS_INIT, U());
    this.mAdvect = gpu.material(FS_ADVECT, U());
    this.mHeight = gpu.material(FS_HEIGHT, U());
    this.mVel = gpu.material(FS_VEL, U());
    this.mEta = gpu.material(FS_ETA, U());
    this.mSurf = gpu.material(FS_SURF, U({ uR: { value: null } }));
    this.mBrk = gpu.material(FS_BRK, U({ uA: { value: null } }));
    this.mMisc = gpu.material(FS_MISC, U({ uM: { value: null }, uA: { value: null } }));
    this.mFlow = gpu.material(FS_FLOW, U({ uF: { value: null }, uReset: { value: new THREE.Vector2() } }));

    gpu.run(this.mTerrain, this.terrain);
    this.mInit.uniforms.uS.value = this.a.texture;
    gpu.run(this.mInit, this.a);
    this.flowPhase = [0, 0];
    this.time = 0;
  }

  step(dt, t) {
    const g = this.gpu;
    for (const m of [this.mAdvect, this.mHeight, this.mVel]) { m.uniforms.uDt.value = dt; m.uniforms.uTime.value = t; }
    this.mAdvect.uniforms.uS.value = this.a.texture; g.run(this.mAdvect, this.b);
    this.mHeight.uniforms.uS.value = this.b.texture; g.run(this.mHeight, this.a);
    this.mVel.uniforms.uS.value = this.a.texture; g.run(this.mVel, this.b);
    [this.a, this.b] = [this.b, this.a];
  }

  // derived render fields, wetness memory and flow-advected foam coordinates, once per frame
  frame(dt, t, period) {
    const g = this.gpu;
    this.mEta.uniforms.uS.value = this.a.texture;
    g.run(this.mEta, this.etaRaw);
    this.mSurf.uniforms.uS.value = this.a.texture;
    this.mSurf.uniforms.uR.value = this.etaRaw.texture;
    g.run(this.mSurf, this.surfA);
    this.mBrk.uniforms.uS.value = this.a.texture;
    this.mBrk.uniforms.uA.value = this.surfA.texture;
    g.run(this.mBrk, this.surfB);

    this.mMisc.uniforms.uS.value = this.a.texture;
    this.mMisc.uniforms.uM.value = this.m0.texture;
    this.mMisc.uniforms.uA.value = this.surfA.texture;
    this.mMisc.uniforms.uDt.value = dt;
    g.run(this.mMisc, this.m1);
    [this.m0, this.m1] = [this.m1, this.m0];

    const ph0 = Math.floor(t / period), ph1 = Math.floor(t / period + 0.5);
    const r = this.mFlow.uniforms.uReset.value;
    r.set(ph0 !== this.flowPhase[0] ? 1 : 0, ph1 !== this.flowPhase[1] ? 1 : 0);
    this.flowPhase = [ph0, ph1];
    this.mFlow.uniforms.uS.value = this.a.texture;
    this.mFlow.uniforms.uF.value = this.f0.texture;
    this.mFlow.uniforms.uDt.value = dt;
    g.run(this.mFlow, this.f1);
    [this.f0, this.f1] = [this.f1, this.f0];
  }
}

// incoming sea: a random, short-crested sea sampled from two spectra, random phases, so waves arrive in irregular sets with no fixed beat
export function makeSwell(scale = 1) {
  const H0 = Math.min(3, -groundJS(0, 48));
  let seed = 424242;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const gauss = () => Math.sqrt(-2 * Math.log(rnd() + 1e-9)) * Math.cos(2 * Math.PI * rnd());
  const seas = [
    // a lake on a breezy afternoon: short wind waves and a little leftover chop from across the lake
    { n: 18, Tp: 2.8, Hs: 0.022, dir: 0.1, spread: 0.35 },
    { n: 10, Tp: 2.0, Hs: 0.008, dir: -0.6, spread: 0.4 },
  ];
  const sw = [], ph = [];
  for (const sea of seas) {
    const fp = 1 / sea.Tp;
    // jonswap-shaped frequency samples, stratified so every part of the spectrum is present
    const fs = [];
    for (let i = 0; i < sea.n; i++) fs.push(fp * (0.72 + 1.2 * (i + rnd()) / sea.n));
    const S = fs.map((f) => {
      const sig = f <= fp ? 0.07 : 0.09;
      return f ** -5 * Math.exp(-1.25 * (fp / f) ** 4) * 3.3 ** Math.exp(-((f - fp) ** 2) / (2 * sig * sig * fp * fp));
    });
    const sum = S.reduce((x, y) => x + y, 0);
    const m0 = (sea.Hs / 4) ** 2;
    fs.forEach((f, i) => {
      const a = Math.sqrt(2 * m0 * S[i] / sum) * scale;
      const w = 2 * Math.PI * f;
      let k = w * w / G;
      for (let j = 0; j < 40; j++) {
        const th = Math.tanh(k * H0);
        k -= (G * k * th - w * w) / (G * th + G * k * H0 * (1 - th * th));
      }
      const th = sea.dir + gauss() * sea.spread;
      const n = Math.round(k * Math.sin(th) * SIM.W / (2 * Math.PI));
      const kx = n * 2 * Math.PI / SIM.W;
      const kd = -Math.sqrt(Math.max(k * k - kx * kx, 1e-6));
      sw.push(new THREE.Vector4(kx, kd, w, a));
      ph.push(rnd() * Math.PI * 2);
    });
  }
  return {
    uSw: { value: sw }, uSwP: { value: ph }, uSwH0: { value: H0 }, uRamp: { value: 1 },
  };
}
export { NSWELL };
