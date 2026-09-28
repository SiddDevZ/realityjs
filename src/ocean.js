import * as THREE from 'three';

// tessendorf fft ocean: jonswap wind sea, three band-split cascades, gpu stockham ifft,
// choppy displacement, slopes, and jacobian foam that accumulates and decays over time.

const G = 9.81;
const N = 256, LOGN = 8;

const H = /* glsl */ `
precision highp float; precision highp int; precision highp sampler2D;
#define NN ${N}
#define TAU 6.28318530718
vec2 cmul(vec2 a, vec2 b){ return vec2(a.x*b.x - a.y*b.y, a.x*b.y + a.y*b.x); }
vec2 ci(vec2 a){ return vec2(-a.y, a.x); }
`;

const FS_TIME = H + /* glsl */ `
uniform sampler2D uH0; uniform float uL, uT;
layout(location=0) out vec4 o0; layout(location=1) out vec4 o1;
void main(){
  ivec2 id = ivec2(gl_FragCoord.xy);
  vec4 h0 = texelFetch(uH0, id, 0);
  vec2 m = vec2(id); m -= step(float(NN/2), m)*float(NN);
  vec2 k = m*TAU/uL; float kl = length(k);
  if(kl < 1e-6){ o0 = vec4(0); o1 = vec4(0); return; }
  float ph = mod(sqrt(9.81*kl)*uT, TAU);
  vec2 e = vec2(cos(ph), -sin(ph));
  vec2 h = cmul(h0.xy, e) + cmul(h0.zw, vec2(e.x, -e.y));
  vec2 ih = ci(h);
  vec2 Dx = ih*(k.x/kl), Dz = ih*(k.y/kl);
  vec2 hx = ih*k.x, hz = ih*k.y;
  vec2 Dxx = -h*(k.x*k.x/kl), Dzz = -h*(k.y*k.y/kl), Dxz = -h*(k.x*k.y/kl);
  o0 = vec4(Dx + ci(Dz), h + ci(hx));
  o1 = vec4(hz + ci(Dxx), Dzz + ci(Dxz));
}`;

// inverse stockham radix-2, natural order output, four complex signals across two targets
const FS_FFT = H + /* glsl */ `
uniform sampler2D uIn0, uIn1; uniform float uSub; uniform int uHoriz;
layout(location=0) out vec4 o0; layout(location=1) out vec4 o1;
void main(){
  ivec2 id = ivec2(gl_FragCoord.xy);
  float idx = float(uHoriz == 1 ? id.x : id.y);
  float hs = uSub*0.5;
  int ev = int(floor(idx/uSub)*hs + mod(idx, hs));
  ivec2 pe = uHoriz == 1 ? ivec2(ev, id.y) : ivec2(id.x, ev);
  ivec2 po = uHoriz == 1 ? ivec2(ev + NN/2, id.y) : ivec2(id.x, ev + NN/2);
  float a = TAU*idx/uSub; vec2 tw = vec2(cos(a), sin(a));
  vec4 e0 = texelFetch(uIn0, pe, 0), q0 = texelFetch(uIn0, po, 0);
  vec4 e1 = texelFetch(uIn1, pe, 0), q1 = texelFetch(uIn1, po, 0);
  o0 = vec4(e0.xy + cmul(tw, q0.xy), e0.zw + cmul(tw, q0.zw));
  o1 = vec4(e1.xy + cmul(tw, q1.xy), e1.zw + cmul(tw, q1.zw));
}`;

// displacement (+ persistent foam) and derivatives
const FS_DISP = H + /* glsl */ `
uniform sampler2D uA0, uA1, uPrev; uniform float uChop, uDt;
out vec4 o;
void main(){
  ivec2 id = ivec2(gl_FragCoord.xy);
  vec4 a0 = texelFetch(uA0, id, 0), a1 = texelFetch(uA1, id, 0);
  float Dxx = uChop*a1.y, Dzz = uChop*a1.z, Dxz = uChop*a1.w;
  float J = (1.0 + Dxx)*(1.0 + Dzz) - Dxz*Dxz;
  float prev = texelFetch(uPrev, id, 0).a;
  float foam = prev*exp(-uDt/2.2) + clamp((0.18 - J)/0.3, 0.0, 1.0)*3.0*uDt;
  o = vec4(uChop*a0.x, a0.z, uChop*a0.y, min(foam, 3.0));
}`;
const FS_DER = H + /* glsl */ `
uniform sampler2D uA0, uA1; uniform float uChop;
out vec4 o;
void main(){
  ivec2 id = ivec2(gl_FragCoord.xy);
  vec4 a0 = texelFetch(uA0, id, 0), a1 = texelFetch(uA1, id, 0);
  o = vec4(a0.w, a1.x, uChop*a1.y, uChop*a1.z);
}`;

function gauss(rng) {
  let u = 0, v = 0;
  while (u === 0) u = rng();
  v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}
function mulberry(a) {
  return () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
}
function gammaFn(z) {
  const g = 7, c = [0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7];
  if (z < 0.5) return Math.PI / (Math.sin(Math.PI * z) * gammaFn(1 - z));
  z -= 1; let x = c[0];
  for (let i = 1; i < g + 2; i++) x += c[i] / (z + i);
  const t = z + g + 0.5;
  return Math.sqrt(2 * Math.PI) * Math.pow(t, z + 0.5) * Math.exp(-t) * x;
}

export class Ocean {
  constructor(gpu, o = {}) {
    this.gpu = gpu;
    this.wind = o.wind ?? 6.5;
    this.fetch = o.fetch ?? 60000;
    this.windAngle = o.windAngle ?? 0.35;   // radians from shore-normal (+z toward the beach)
    this.chop = o.chop ?? 0.9;
    // non-integer ratios and per-cascade rotation keep the tiles from ever lining up into columns
    this.cascades = [{ L: 211, rot: 0.0 }, { L: 29.3, rot: 0.61 }, { L: 4.7, rot: -0.94 }];
    const Ls = this.cascades.map((c) => c.L);
    this.cascades.forEach((c, i) => {
      c.kLo = i === 0 ? 1e-4 : 6 * 2 * Math.PI / Ls[i - 1];
      c.kHi = i === Ls.length - 1 ? Math.PI * N / c.L : 6 * 2 * Math.PI / c.L;
    });

    const T = THREE, f32 = { type: T.FloatType };
    this.tA = gpu.target(N, N, { ...f32, count: 2 });
    this.tB = gpu.target(N, N, { ...f32, count: 2 });
    this.mTime = gpu.material(FS_TIME, { uH0: { value: null }, uL: { value: 0 }, uT: { value: 0 } });
    this.mFFT = gpu.material(FS_FFT, { uIn0: { value: null }, uIn1: { value: null }, uSub: { value: 2 }, uHoriz: { value: 1 } });
    this.mDisp = gpu.material(FS_DISP, { uA0: { value: null }, uA1: { value: null }, uPrev: { value: null }, uChop: { value: this.chop }, uDt: { value: 0 } });
    this.mDer = gpu.material(FS_DER, { uA0: { value: null }, uA1: { value: null }, uChop: { value: this.chop } });

    const out = { type: T.HalfFloatType, min: T.LinearMipmapLinearFilter, mag: T.LinearFilter, wrapS: T.RepeatWrapping, wrapT: T.RepeatWrapping, mips: true, aniso: 8 };
    for (const c of this.cascades) {
      c.h0 = this.spectrum(c);
      c.disp = [gpu.target(N, N, out), gpu.target(N, N, out)];
      c.der = gpu.target(N, N, out);
    }
  }

  // jonswap with cos-2s spreading; returns the h0 texture and records the slope variance of the band
  spectrum(c) {
    const U = this.wind, F = this.fetch;
    const wp = 22 * Math.pow(G * G / (U * F), 1 / 3);
    const alpha = 0.076 * Math.pow(U * U / (F * G), 0.22);
    const gamma = 3.3;
    const dk = 2 * Math.PI / c.L;
    const rng = mulberry(Math.round(c.L * 1000));
    const data = new Float32Array(N * N * 4);
    const re = new Float32Array(N * N), im = new Float32Array(N * N);
    let slopeVar = 0;
    for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
      const mx = i < N / 2 ? i : i - N, mz = j < N / 2 ? j : j - N;
      const kx = mx * dk, kz = mz * dk, k = Math.hypot(kx, kz);
      const g1 = gauss(rng), g2 = gauss(rng);
      const idx = j * N + i;
      if (k < c.kLo || k > c.kHi || k === 0) continue;
      const w = Math.sqrt(G * k);
      const sig = w <= wp ? 0.07 : 0.09;
      const r = Math.exp(-((w - wp) ** 2) / (2 * sig * sig * wp * wp));
      const Sw = alpha * G * G / w ** 5 * Math.exp(-1.25 * (wp / w) ** 4) * Math.pow(gamma, r);
      const dwdk = G / (2 * w);
      // spreading: s grows away from the peak (mitsuyasu/hasselmann shape)
      const s = w <= wp ? 6.97 * Math.pow(w / wp, 4.06) : 9.77 * Math.pow(w / wp, -2.33);
      const s2 = Math.max(s, 1) * 2;
      const norm = gammaFn(s2 / 2 + 1) / (2 * Math.sqrt(Math.PI) * gammaFn(s2 / 2 + 0.5));
      const th = Math.atan2(kz, kx) - (Math.PI / 2 + this.windAngle);
      const D = norm * Math.pow(Math.abs(Math.cos(th / 2)), s2);
      const Sk = Sw * dwdk * D / k * Math.exp(-((k * 0.004) ** 2));
      const amp = Math.sqrt(2 * Sk * dk * dk) / Math.SQRT2;
      re[idx] = g1 * amp; im[idx] = g2 * amp;
      slopeVar += k * k * (re[idx] ** 2 + im[idx] ** 2);
    }
    for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
      const idx = j * N + i, nidx = ((N - j) % N) * N + ((N - i) % N);
      data[idx * 4] = re[idx]; data[idx * 4 + 1] = im[idx];
      data[idx * 4 + 2] = re[nidx]; data[idx * 4 + 3] = -im[nidx];
    }
    c.slopeVar = slopeVar * 2;
    const tex = new THREE.DataTexture(data, N, N, THREE.RGBAFormat, THREE.FloatType);
    tex.needsUpdate = true;
    return tex;
  }

  update(t, dt) {
    const g = this.gpu;
    for (const c of this.cascades) {
      this.mTime.uniforms.uH0.value = c.h0;
      this.mTime.uniforms.uL.value = c.L;
      this.mTime.uniforms.uT.value = t;
      g.run(this.mTime, this.tA);
      let src = this.tA, dst = this.tB;
      for (let pass = 0; pass < 2 * LOGN; pass++) {
        const u = this.mFFT.uniforms;
        u.uIn0.value = src.textures[0]; u.uIn1.value = src.textures[1];
        u.uHoriz.value = pass < LOGN ? 1 : 0;
        u.uSub.value = 2 << (pass % LOGN);
        g.run(this.mFFT, dst);
        [src, dst] = [dst, src];
      }
      c.disp.reverse();
      Object.assign(this.mDisp.uniforms, {});
      this.mDisp.uniforms.uA0.value = src.textures[0];
      this.mDisp.uniforms.uA1.value = src.textures[1];
      this.mDisp.uniforms.uPrev.value = c.disp[1].texture;
      this.mDisp.uniforms.uDt.value = dt;
      g.run(this.mDisp, c.disp[0]);
      this.mDer.uniforms.uA0.value = src.textures[0];
      this.mDer.uniforms.uA1.value = src.textures[1];
      g.run(this.mDer, c.der);
    }
  }

  uniforms() {
    const c = this.cascades;
    return {
      uDisp0: { value: null }, uDisp1: { value: null }, uDisp2: { value: null },
      uDer0: { value: c[0].der.texture }, uDer1: { value: c[1].der.texture }, uDer2: { value: c[2].der.texture },
      uLen: { value: new THREE.Vector3(c[0].L, c[1].L, c[2].L) },
      uSig: { value: new THREE.Vector3(c[0].slopeVar, c[1].slopeVar, c[2].slopeVar) },
      uRot: { value: new THREE.Vector3(c[0].rot, c[1].rot, c[2].rot) },
    };
  }
  bind(u) {
    u.uDisp0.value = this.cascades[0].disp[0].texture;
    u.uDisp1.value = this.cascades[1].disp[0].texture;
    u.uDisp2.value = this.cascades[2].disp[0].texture;
  }
}
