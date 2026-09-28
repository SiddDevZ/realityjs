import * as THREE from 'three';
import { HEAD, groundJS } from './common.js';

// the lake bed and its granite boulders, baked once into a 10 cm height texture that the surf sim,
// the water, the caustics, the shadows and the reflections all read.
// texel: r = height, g = rock weight, b = rock seed

export const TERR = { X0: -102.4, D0: -25.6, W: 204.8, D: 153.6, NX: 2048, ND: 1536 };
const NB = 400;

function rng(seed) { return () => ((seed = (seed * 16807) % 2147483647) / 2147483647); }

// x, d, radius across, radius along, top height, height (top to base), rotation
function boulderList() {
  const B = [];
  const add = (x, d, rx, rd, top, h, rot = 0) => B.push([x, d, rx, rd, top, h ?? Math.max(rx, rd) * 1.1 + Math.max(top, 0), rot]);
  // the slab you stand beside
  add(5.2, 2.6, 5.8, 3.2, 1.45, 3.2, 0.5);
  // near field, like the photo: a big rounded dome left of centre, a small one in front
  add(-3.4, 12.5, 2.3, 1.6, 0.95, 1.9, -0.2);
  add(0.9, 9.5, 0.95, 0.75, 0.42, 0.9, 0.4);
  // centre group: a tall boulder with lower ones around its foot
  add(3.2, 27.5, 2.6, 2.0, 3.3, 4.2, 0.1);
  add(3.9, 30.0, 2.0, 1.6, 4.3, 3.2, 0.5);
  add(1.2, 25.5, 2.4, 1.5, 0.95, 1.7, -0.3);
  add(5.9, 26.0, 1.7, 1.3, 1.35, 2.0, 0.2);
  add(-1.6, 22.5, 1.8, 1.3, 0.9, 1.6, 0.1);
  add(0.4, 21.5, 0.8, 0.6, 0.28, 0.8, 0.0);
  add(7.4, 22.0, 1.3, 1.1, 0.8, 1.4, 0.6);
  add(10.5, 24.5, 1.2, 1.0, 1.0, 1.5, -0.4);
  add(9.4, 18.0, 1.4, 0.7, 0.3, 0.8, 0.9);
  // far groups
  add(1.0, 60, 3.2, 2.2, 2.3); add(4.3, 62, 2.6, 2.1, 1.9); add(-1.8, 58, 2.1, 1.6, 1.4);
  add(6.5, 57, 1.6, 1.3, 1.0); add(8.6, 63.5, 2.2, 1.7, 2.6); add(-3.4, 63, 1.3, 1.1, 0.8); add(3.0, 56, 1.1, 0.9, 0.6);
  add(-13, 72, 1.5, 1.1, 0.6); add(-9.5, 74, 1.0, 0.8, 0.4); add(-2.5, 69, 1.9, 1.3, 0.9); add(-6.5, 66, 0.9, 0.7, 0.35);
  // submerged: the dark patches seen through clear water
  const sub = [[-5, 6, 1.2, 0.9, -0.35], [-8, 16, 1.7, 1.2, -0.6], [-1, 15, 1.1, 0.8, -0.45], [5.5, 15, 1.3, 1.0, -0.55],
    [-10, 28, 2.1, 1.5, -0.8], [-3, 33, 1.6, 1.2, -0.7], [8.5, 34, 1.5, 1.3, -0.9], [-6, 43, 1.9, 1.4, -1.0],
    [12, 41, 2.1, 1.6, -1.2], [0, 41, 1.3, 1.0, -0.9], [-14, 20, 1.4, 1.0, -0.5], [14, 30, 1.6, 1.2, -0.9],
    [-9, 10, 1.6, 1.1, -0.8], [7, 9, 1.1, 0.9, -0.6], [-12, 35, 1.8, 1.3, -1.1], [4, 37, 1.4, 1.0, -1.0]];
  for (const s of sub) add(s[0], s[1], s[2], s[3], s[4], Math.max(s[2], s[3]) * 1.1);
  const r = rng(9173);
  // scattered small rocks in the shallows
  for (let i = 0; i < 26; i++) {
    const x = -30 + r() * 55, d = 4 + r() * 40;
    const g = groundJS(x, d), s = 0.3 + r() * 0.9;
    add(x, d, s, s * (0.6 + r() * 0.4), g + s * (0.3 + r() * 0.9), s * 1.2, r() * 3);
  }
  // the rocky point on the right, heaped with boulders
  for (let i = 0; i < 115; i++) {
    const a = r() * Math.PI * 2, rr = Math.sqrt(r());
    const x = 34 + Math.cos(a) * rr * 21, d = 64 + Math.sin(a) * rr * 16.5;
    const g = Math.max(groundJS(x, d), -1.5), s = 1.4 + r() * 2.6;
    add(x, d, s, s * (0.65 + r() * 0.35), g + s * (0.55 + r() * 0.6), s * 1.6 + Math.max(0, -g), r() * 3);
  }
  const out = [];
  const rl = rng(777);
  for (const b of B) {
    out.push(b);
    const size = Math.max(b[2], b[3]);
    if (size < 0.7) continue;
    const lobes = 1 + Math.floor(rl() * 2.2);
    for (let i = 0; i < lobes; i++) {
      const a = rl() * Math.PI * 2, off = size * (0.35 + 0.35 * rl());
      const k = 0.45 + 0.35 * rl();
      // a lobe top just under the surface reads as a pale shelf ringed in dark: keep tops clear of that band
      let top = b[4] - b[5] * (0.12 + 0.35 * rl());
      if (top > -0.5 && top < 0.3) top = top < -0.05 ? -0.55 : 0.35;
      out.push([b[0] + Math.cos(a) * off, b[1] + Math.sin(a) * off, b[2] * k, b[3] * k * (0.8 + 0.4 * rl()),
        top, b[5] * k, rl() * 3]);
    }
  }
  // no rock top may sit just under the surface (pale shelf with a dark rim): push it under or above
  // only rocks that break the surface: fully submerged ones read as dark blotches in open water
  for (const b of out) if (b[4] > -0.5 && b[4] < 0.3) b[4] = 0.35;
  return out.filter((b) => b[4] > 0.3).slice(0, NB);
}

const FS_BAKE = HEAD + /* glsl */ `
uniform vec4 uBA[${NB}], uBB[${NB}];
uniform int uNB;
in vec2 vUv;
out vec4 o;
void main(){
  vec2 xd = vec2(${TERR.X0.toFixed(2)}, ${TERR.D0.toFixed(2)}) + vUv*vec2(${TERR.W.toFixed(2)}, ${TERR.D.toFixed(2)});
  float g = groundB(xd);
  float best = -1e4, seed = 0.0;
  for(int i=0;i<${NB};i++){
    if(i >= uNB) break;
    vec4 A = uBA[i], B = uBB[i];
    vec2 p = xd - A.xy;
    if(abs(p.x) > A.z*1.3 + A.w*1.3 || abs(p.y) > A.z*1.3 + A.w*1.3) continue;
    float c = cos(B.z), s = sin(B.z);
    vec2 lp = vec2(c*p.x + s*p.y, -s*p.x + c*p.y);
    vec2 q = lp/A.zw;
    // irregular outline and lumpy skin: no two boulders the same
    // blocky, irregular footprint: a squarish superellipse, warped, never a clean circle
    float pe = 2.0 + 0.5*fract(B.w*23.0);
    vec2 aq = abs(q) + 1e-4;
    float r = pow(pow(aq.x, pe) + pow(aq.y, pe), 1.0/pe);
    r *= 1.0 + 0.14*(vnoise(q*1.1 + B.w*17.0) - 0.5) + 0.04*(vnoise(q*3.3 + B.w*5.0) - 0.5);
    if(r >= 1.0) continue;
    // weathered granite: broad flattened crown, rounded shoulders, a flared foot
    float h = B.x - B.y + B.y*pow(max(1.0 - pow(r, 2.0), 0.0), 0.42);
    h += B.y*0.06*(vnoise(lp*0.9 + B.w*11.0) - 0.5) + B.y*0.03*(vnoise(lp*2.3 + B.w*3.0) - 0.5) + 0.02*(vnoise(lp*6.0 + B.w) - 0.5);
    // jointed granite: a few random planes cut the dome into flat faces with sharp edges
    float kr = 0.045*B.y + 0.03;
    #define SMIN(a, b) (min(a, b) - pow(max(kr - abs((a) - (b)), 0.0), 2.0)/(4.0*kr))
    for(int k=0;k<1;k++){
      float fk = float(k);
      float ang = B.w*61.0 + fk*1.9 + 0.7*fract(B.w*(13.0 + fk));
      vec2 gdir = vec2(cos(ang), sin(ang));
      float steep = mix(0.25, 0.5, fract(B.w*(7.0 + 3.0*fk)));
      float off = mix(0.05, 0.6, fract(B.w*(19.0 + 5.0*fk)));
      float cut = B.x - B.y*0.06 - steep*(dot(lp/max(A.z, A.w), gdir) - off)*max(A.z, A.w)*0.9;
      h = SMIN(h, cut);
    }
    // joint cracks: a few straight-ish fractures cut across the rock, some splitting it into blocks
    vec2 cd = vec2(cos(B.w*40.0), sin(B.w*40.0));
    float j1 = abs(dot(lp, cd) - (fract(B.w*13.0) - 0.5)*A.z + 0.25*(vnoise(lp*1.3 + B.w*3.0) - 0.5));
    float j2 = abs(dot(lp, vec2(-cd.y, cd.x)) - (fract(B.w*29.0) - 0.5)*A.w + 0.2*(vnoise(lp*1.7 + B.w*9.0) - 0.5));
    float crack = max(1.0 - smoothstep(0.0, 0.05 + 0.03*B.y, j1), (1.0 - smoothstep(0.0, 0.035, j2))*step(0.55, fract(B.w*7.0)));
    h -= crack*min(B.y*0.03, 0.03)*(fract(B.w*17.0) > 0.7 ? 1.0 : 0.0);
    if(h > best){ best = h; seed = B.w; }
  }
  float hgt = max(g, best);
  o = vec4(hgt, smoothstep(-0.02, 0.05, best - g), seed, 0.0);
}`;

export function bakeTerrain(gpu) {
  const B = boulderList();
  const A = [], Bb = [];
  const r = rng(51);
  for (let i = 0; i < NB; i++) {
    const b = B[i] ?? [0, -999, 0.1, 0.1, -99, 0.1, 0];
    A.push(new THREE.Vector4(b[0], b[1], b[2], b[3]));
    Bb.push(new THREE.Vector4(b[4], b[5], b[6], r()));
  }
  const lin = gpu.r.extensions.has('OES_texture_float_linear');
  const rt = gpu.target(TERR.NX, TERR.ND, {
    type: THREE.HalfFloatType, min: THREE.LinearFilter, mag: THREE.LinearFilter,
  });
  const m = gpu.material(FS_BAKE, { uBA: { value: A }, uBB: { value: Bb }, uNB: { value: B.length } });
  gpu.run(m, rt);
  const dom = new THREE.Vector4(TERR.X0, TERR.D0, 1 / TERR.W, 1 / TERR.D);
  // exact baked height at a point (for placing trees and the camera)
  const buf = new Float32Array(4);
  const heightAt = (x, d) => {
    const i = Math.round((x - TERR.X0) / TERR.W * TERR.NX - 0.5), j = Math.round((d - TERR.D0) / TERR.D * TERR.ND - 0.5);
    if (i < 0 || j < 0 || i >= TERR.NX || j >= TERR.ND) return groundJS(x, d);
    gpu.r.readRenderTargetPixels(rt, i, j, 1, 1, buf);
    return buf[0];
  };
  return { rt, tex: rt.texture, dom, heightAt, uniforms: { uTerr: { value: rt.texture }, uTerrDom: { value: dom } } };
}
