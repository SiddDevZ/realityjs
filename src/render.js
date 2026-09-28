import * as THREE from 'three';
import { HEAD } from './common.js';
import { ENV_GLSL } from './sky.js';
import { causticsGLSL } from './caustics.js';

// camera-centred polar grid: even screen-space density from the feet to the horizon
export function polarGrid(r0, r1, grow, segs, spread = Math.PI) {
  const rings = [];
  for (let r = r0; r < r1; r *= grow) rings.push(r);
  rings.push(r1);
  const pos = new Float32Array(rings.length * segs * 3);
  let k = 0;
  // a forward wedge (toward -z) holds all the triangles; the camera never turns past it
  for (const r of rings) for (let s = 0; s < segs; s++) {
    const a = -Math.PI / 2 + (s / (segs - 1) * 2 - 1) * spread;
    pos[k++] = Math.cos(a) * r; pos[k++] = 0; pos[k++] = Math.sin(a) * r;
  }
  const idx = new Uint32Array((rings.length - 1) * (segs - 1) * 6);
  k = 0;
  for (let i = 0; i < rings.length - 1; i++) for (let s = 0; s < segs - 1; s++) {
    const a = i * segs + s, b = a + 1, c = a + segs, d = b + segs;
    idx[k++] = a; idx[k++] = b; idx[k++] = c;
    idx[k++] = b; idx[k++] = d; idx[k++] = c;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setIndex(new THREE.BufferAttribute(idx, 1));
  return g;
}

// everything the water and sand shaders share: sim lookups, fft sampling, sky, sand shading
const SHARED = HEAD + ENV_GLSL + causticsGLSL() + /* glsl */ `
uniform float uTime, uDbg, uOff;
uniform vec3 uSunDir, uSunE, uCamPos;
uniform sampler2D uEnv;
uniform sampler2D uSurfA, uM, uFlow;
uniform vec2 uFlowW;
uniform sampler2D uDisp0, uDisp1, uDisp2, uDer0, uDer1, uDer2;
uniform vec3 uLen, uSig, uRot;
vec2 rotv(vec2 v, float a){ float c = cos(a), s = sin(a); return vec2(c*v.x - s*v.y, s*v.x + c*v.y); }
// sample a cascade in its rotated frame: uv in, world-aligned xz vectors out
vec2 cuv(vec2 xz, int i){ return rotv(xz, -uRot[i])/uLen[i]; }
vec4 derBand(sampler2D t, vec2 xz, int i){
  vec2 u0 = cuv(xz, i);
  vec2 u1 = rotv(u0, 0.5)*0.763 + 0.37;
  float w = smoothstep(0.3, 0.7, vnoise(xz*0.013 + float(i)*7.1));
  vec4 a = texture(t, u0), b = texture(t, u1);
  b.xy = rotv(b.xy, -0.5);
  return (a*(1.0 - w) + b*w)*inversesqrt((1.0 - w)*(1.0 - w) + w*w);
}
uniform sampler2D uSand, uSandN, uFoamTex, uGranite;

vec2 simUV(vec2 xd){ return vec2((xd.x - X0)/SIMW, (xd.y - D0)/SIMD); }
float inside(vec2 xd){
  vec2 uv = simUV(xd);
  return smoothstep(0.0, 0.03, uv.x)*smoothstep(1.0, 0.97, uv.x)*step(0.0, uv.y)*smoothstep(1.0, 0.975, uv.y);
}
// cubic b-spline filtering from 4 bilinear taps: smooth contours from the 12.5 cm sim grid
vec4 texCubic(sampler2D t, vec2 uv){
  vec2 res = vec2(float(NX), float(NZ));
  vec2 p = uv*res - 0.5, i = floor(p), f = p - i;
  vec2 f2 = f*f, f3 = f2*f;
  vec2 w0 = (-f3 + 3.0*f2 - 3.0*f + 1.0)/6.0, w1 = (3.0*f3 - 6.0*f2 + 4.0)/6.0;
  vec2 w2 = (-3.0*f3 + 3.0*f2 + 3.0*f + 1.0)/6.0, w3 = f3/6.0;
  vec2 g0 = w0 + w1, g1 = w2 + w3;
  vec2 p0 = (i - 1.0 + w1/g0 + 0.5)/res, p1 = (i + 1.0 + w3/g1 + 0.5)/res;
  return g0.y*(g0.x*texture(t, p0) + g1.x*texture(t, vec2(p1.x, p0.y)))
       + g1.y*(g0.x*texture(t, vec2(p0.x, p1.y)) + g1.x*texture(t, p1));
}
// wind ripples in the shallows: lambda 1.4 m -> 10 cm, golden-angle headings, equal slope per wave
vec2 capRipples(vec2 xz, float t, float fp, out float lostVar){
  vec2 s = vec2(0.0); lostVar = 0.0;
  float lam = 1.3;
  for(int i=0;i<14;i++){
    float fi = float(i);
    float a = fi*2.39996 + 0.6;
    vec2 dir = vec2(cos(a), sin(a));
    float k = TAU/lam;
    float w = sqrt(9.81*k + 0.074*k*k*k);
    // steeper as they shorten (cox-munk-like light-wind slopes): focus lands ~1-2 m down, on the sand
    float sa = 0.034*sqrt(1.3/lam)*(0.8 + 0.4*fract(fi*0.618));
    float ph = k*dot(dir, xz) - w*t + fi*1.7 + 0.8*sin(0.13*t + fi);
    float keep = 1.0 - smoothstep(lam*0.2, lam*0.6, fp);
    s += dir*sa*cos(ph)*keep;
    lostVar += 0.5*sa*sa*(1.0 - keep);
    lam *= 0.83;
  }
  return s;
}
vec2 randRipples(vec2 xz, float t, float target){
  float sn = inversesqrt(max(uSig.z, 1e-6));
  vec2 u1 = rotv(xz, 0.83)/1.35 + vec2(0.013, -0.021)*t;
  vec2 u2 = rotv(xz, -1.9)/0.87 + vec2(-0.017, 0.011)*t + 0.37;
  vec2 a = rotv(texture(uDer2, u1).xy, -0.83)*(4.7/1.35);
  vec2 b = rotv(texture(uDer2, u2).xy, 1.9)*(4.7/0.87);
  float gust = 0.55 + 0.9*smoothstep(0.25, 0.75, vnoise(xz*0.09 + vec2(0.03, 0.02)*t));
  return (a*0.6 + b*0.45)*sn*target*gust/5.0;
}
vec3 envL(vec3 d, float lod){ d.y = abs(d.y); return textureLod(uEnv, dirToEnv(d), lod).rgb; }
vec3 ambientL(){ return textureLod(uEnv, vec2(0.5, 0.75), 9.0).rgb; }

// still-water depth is used to fade the offshore swell where the sim is not running
void farField(vec2 xd, float b, out float eta, out vec2 grad){
  vec3 s = swellGrad(xd, uTime);
  float calm = smoothstep(0.2, 1.6, -b);
  eta = s.x*calm; grad = s.yz*calm;
}
// eta, depth, d(eta)/dx, d(eta)/dd
vec4 waterField(vec2 xd, float b, bool smoothC){
  float m = inside(xd);
  // the 28-component swell only matters where the sim is not running
  float fe = 0.0; vec2 fg = vec2(0.0);
  if(m < 0.999) farField(xd, b, fe, fg);
  vec4 A = smoothC ? texCubic(uSurfA, simUV(xd)) : texture(uSurfA, simUV(xd));
  float eta = mix(fe, A.x, m);
  // depth against the exact sand height at this point, so the waterline follows the sand, not the grid
  float depth = max(eta - b, 0.0);
  vec2 g = mix(fg, A.yz, m);
  return vec4(eta, depth, g);
}
// per-band attenuation in shallow water (crest-style), deepening offshore beyond the beach
vec3 bandAtt(float depth, float d){
  float dd = depth + max(d - 38.0, 0.0)*0.35;
  return clamp(2.0*dd/vec3(40.0, 12.0, 0.6), 0.0, 1.0)*vec3(1.0, 1.0, 0.7);
}

vec3 sandAlbedo(vec2 xz){
  // fine grains at true scale; large-scale variation from gentle tone noise, never a magnified texture
  vec3 a = texture(uSand, xz/0.55).rgb;
  a = mix(a, texture(uSand, xz/0.37 + 0.37).rgb, 0.4);
  float v = fbm(xz*0.18), w = fbm(xz*0.9 + 5.0);
  return a*(0.9 + 0.16*v + 0.06*w)*vec3(1.02, 1.0, 0.97);
}
vec3 sandNormal(vec2 xz, vec3 Nt, float s){
  vec2 n = texture(uSandN, xz/0.55).xy*2.0 - 1.0;
  return normalize(Nt + vec3(n.x, 0.0, n.y)*s);
}
vec3 terrN(vec2 xd){
  const float e = 0.1;
  float gx = terrainB(xd + vec2(e, 0.0)) - terrainB(xd - vec2(e, 0.0));
  float gd = terrainB(xd + vec2(0.0, e)) - terrainB(xd - vec2(0.0, e));
  return normalize(vec3(-gx/(2.0*e), 1.0, gd/(2.0*e)));
}
// granite: photo texture projected three ways, dark weathering stains, drip streaks, algae underwater
vec3 rockAlbedo(vec3 p, vec3 N, float seed){
  vec3 w = pow(abs(N), vec3(4.0)); w /= w.x + w.y + w.z;
  // two scales at different rotations, blended by slow noise, so the lichen never forms a repeating grid
  vec3 a1 = texture(uGranite, p.zy/2.6).rgb*w.x + texture(uGranite, p.xz/2.6).rgb*w.y + texture(uGranite, p.xy/2.6).rgb*w.z;
  vec2 rxz = mat2(0.8, -0.6, 0.6, 0.8)*p.xz;
  vec3 a2 = texture(uGranite, p.zy/5.3 + 0.31).rgb*w.x + texture(uGranite, rxz/5.3 + 0.17).rgb*w.y + texture(uGranite, p.xy/5.3 + 0.53).rgb*w.z;
  vec3 a = mix(a1, a2, smoothstep(0.3, 0.7, vnoise(p.xz*0.23 + seed*7.0)));
  // each boulder its own tone: some warm and pale, some cooler and darker
  // smooth grey granite: the crystal speckle softened toward its mean
  a = mix(a, vec3(dot(a, vec3(0.333))), 0.6);
  a = mix(a, vec3(dot(a, vec3(0.333))), 0.5)*1.0;
  a *= (0.84 + 0.26*seed)*mix(vec3(1.0), vec3(1.02, 1.0, 0.97), fract(seed*7.0));
  // dark lichen crusts spread over the crowns, as on the photo's boulders
  float dk = smoothstep(0.48, 0.66, fbm(p.xz*0.9 + seed*13.0) + 0.25*(N.y - 0.5))*smoothstep(0.3, 0.8, N.y)*smoothstep(0.2, 0.7, p.y);
  a = mix(a, a*0.6, dk*0.3);
  // broad mottling at several scales, as sun and weather bleach granite unevenly
  float mo = fbm(p.xz*0.35 + seed*9.0)*0.6 + fbm(vec2(p.x + p.z, p.y)*1.3 + seed*3.0)*0.4;
  a *= 0.9 + 0.2*mo;
  // pale grey-green lichen on the upward faces above the splash zone
  float li = smoothstep(0.62, 0.78, fbm(p.xz*2.1 + seed*5.0))*smoothstep(0.5, 0.9, N.y)*smoothstep(0.5, 1.0, p.y);
  a = mix(a, vec3(0.62, 0.64, 0.56), li*0.55);
  // faint mineral streaks down the sides where rain runs off
  float streak = smoothstep(0.55, 0.8, vnoise(vec2((p.x - p.z)*1.8, p.y*0.25) + seed*7.0))*(1.0 - w.y);
  a *= 1.0 - 0.18*streak;
  // wet, darker band at the waterline and olive algae below it
  a *= mix(vec3(1.0), vec3(0.97, 0.99, 0.96), smoothstep(-0.05, -0.6, p.y));
  a *= mix(1.0, 0.68, smoothstep(0.28, 0.0, p.y)*step(-0.05, p.y));
  return a;
}
// how much a point sits in a hollow or on a ridge of the rock, from the height field itself
float rockCavity(vec2 xd, float h){
  float s = 0.0;
  for(int i=0;i<6;i++){
    float a = float(i)*1.0472;
    s += terrainB(xd + 0.35*vec2(cos(a), sin(a)));
  }
  return h - s/6.0;
}
vec3 groundAlbedo(vec3 p, vec3 N, vec3 info){
  vec3 sand = sandAlbedo(p.xz);
  float land = smoothstep(0.1, 0.6, p.y);
  if(land > 0.0){
    vec3 duff = mix(vec3(0.24, 0.23, 0.21), vec3(0.17, 0.19, 0.13), smoothstep(0.45, 0.7, fbm(p.xz*0.7)));
    sand = mix(sand, duff*(0.8 + 0.4*vnoise(p.xz*3.0)), land);
  }
  if(info.g < 0.01) return sand;
  return mix(sand, rockAlbedo(p, N, info.b), info.g);
}
// soft sun shadow cast by the boulders and the point, marched through the baked height field
float sunShadow(vec3 p, vec3 N){
  if(mod(uOff, 2.0) > 0.5) return 1.0;
  vec3 o = p + N*0.04;
  float s = 1.0;
  for(int i=1;i<=14;i++){
    float t = 0.08 + 0.075*float(i*i);
    vec3 q = o + uSunDir*t;
    vec2 qd = vec2(q.x, -q.z);
    if(!inTerr(terrUV(qd))) break;
    s = min(s, clamp((q.y - terrainB(qd))/(0.04*t) + 0.15, 0.0, 1.0));
    if(s <= 0.0) break;
  }
  return s;
}
vec3 envL(vec3 d, float lod);
vec3 ambientL();
// boulders and shore mirrored in the water: march the reflected ray against the height field
vec4 traceRefl(vec3 p, vec3 R){
  if(mod(floor(uOff/2.0), 2.0) > 0.5) return vec4(0.0);
  if(R.y > 0.5 || R.y < 0.004) return vec4(0.0);
  float t = 0.3, tp = 0.0;
  for(int i=0;i<20;i++){
    vec3 q = p + R*t;
    vec2 qd = vec2(q.x, -q.z);
    if(!inTerr(terrUV(qd))) return vec4(0.0);
    if(q.y < terrainB(qd)){
      float a = tp, b = t;
      for(int k=0;k<5;k++){ float m = 0.5*(a + b); vec3 r = p + R*m; if(r.y < terrainB(vec2(r.x, -r.z))) b = m; else a = m; }
      vec3 h = p + R*b; vec2 hd = vec2(h.x, -h.z);
      if(b > 40.0 || h.y < 0.02) return vec4(0.0);
      vec3 N = terrN(hd);
      vec3 alb = groundAlbedo(h, N, terrainInfo(hd));
      vec3 c = alb*(uSunE*max(dot(N, uSunDir), 0.0)/PI + ambientL()*(0.6 + 0.4*N.y) + uSunE*max(uSunDir.y, 0.0)*vec3(0.5, 0.47, 0.42)*(0.25 + 0.3*(1.0 - N.y))/PI);
      return vec4(c, 1.0);
    }
    tp = t; t *= 1.32;
  }
  return vec4(0.0);
}
float ggx(vec3 N, vec3 V, vec3 L, float a2){
  vec3 H = normalize(L + V);
  float NH = max(dot(N, H), 0.0), NL = max(dot(N, L), 0.0), NV = max(dot(N, V), 1e-3), VH = max(dot(V, H), 0.0);
  float D = a2/(PI*sq(NH*NH*(a2 - 1.0) + 1.0));
  float Vis = 0.5/(NL*sqrt(NV*NV*(1.0 - a2) + a2) + NV*sqrt(NL*NL*(1.0 - a2) + a2) + 1e-5);
  float F = 0.02 + 0.98*pow(1.0 - VH, 5.0);
  return min(D*Vis*F*NL, 14.0);
}
// foam lace texture carried along by the flow: two phases, cross-faded between resets
float foamLace(vec2 xz, vec4 fl, float tile){
  vec2 xd = vec2(xz.x, -xz.y);
  float a = texture(uFoamTex, (xd + fl.xy)/tile).r;
  float b = texture(uFoamTex, (xd + fl.zw)/tile + 0.5).r;
  return a*uFlowW.x + b*uFlowW.y;
}
`;

export function makeUniforms(extra) {
  return {
    uTime: { value: 0 }, uDbg: { value: 0 }, uOff: { value: 0 }, uCamPos: { value: new THREE.Vector3() },
    uFlowW: { value: new THREE.Vector2(1, 0) },
    uSurfA: { value: null }, uM: { value: null }, uFlow: { value: null },
    ...extra,
  };
}

const WATER_VS = SHARED + /* glsl */ `
in vec3 position;
uniform mat4 projectionMatrix, viewMatrix;
out vec3 vW;
out vec2 vXZ;
void main(){
  vec2 xz = position.xz + uCamPos.xz;
  vec2 xd = vec2(xz.x, -xz.y);
  float b = terrainB(xd);
  vec4 wf = waterField(xd, b, false);
  float r = length(position.xz);
  float spacing = max(r, 0.3)*0.0055*1.3;
  vec3 lod = log2(max(spacing*256.0/uLen, vec3(1.0)));
  vec3 att = bandAtt(wf.y, xd.y);
  vec3 q0 = textureLod(uDisp0, cuv(xz, 0), lod.x).xyz*att.x;
  vec3 q1 = textureLod(uDisp1, cuv(xz, 1), lod.y).xyz*att.y;
  vec3 q2 = textureLod(uDisp2, cuv(xz, 2), lod.z).xyz*att.z;
  vec3 D = vec3(0.0, q0.y + q1.y + q2.y, 0.0);
  // no sideways wave motion in shallow water against rock or sand, so the surface never slides up a wall
  D.xz = (rotv(q0.xz, uRot.x) + rotv(q1.xz, uRot.y) + rotv(q2.xz, uRot.z))*smoothstep(0.15, 1.2, wf.y);
  vec3 P = vec3(xz.x + D.x, wf.x + D.y, xz.y + D.z);
  // dry vertices sink well inside the rock or sand, so edge triangles dive under it instead of skinning it
  if(wf.y < 0.0008) P.y = b - 0.6;
  vW = P; vXZ = xz;
  gl_Position = projectionMatrix*viewMatrix*vec4(P, 1.0);
}`;

const WATER_FS = SHARED + /* glsl */ `
in vec3 vW;
in vec2 vXZ;
out vec4 o;

// foam lace projected along the surface: from above on flat water, from the side on steep faces
float laceAt(vec2 c, vec4 fl, float tile){
  float a = texture(uFoamTex, (c + fl.xy)/tile).r;
  float b = texture(uFoamTex, (c + fl.zw)/tile + 0.5).r;
  return a*uFlowW.x + b*uFlowW.y;
}
void main(){
  vec2 xz = vXZ, xd = vec2(xz.x, -xz.y);
  float b = terrainB(xd);
  vec4 wf = waterField(xd, b, true);
  float m = inside(xd);
  float depth = wf.y;
  if(abs(uDbg - 4.0) < 0.5){
    vec4 Ac = texCubic(uSurfA, simUV(xd));
    o = vec4(clamp(-Ac.x, 0.0, 1.0)*4.0, (Ac.x - b > 0.0) ? 4.0 : 0.0, clamp(b + 1.0, 0.0, 1.0)*4.0, 1.0); return;
  }
  if(abs(uDbg - 3.0) < 0.5){
    float fe; vec2 fg; farField(xd, b, fe, fg);
    bool bad = isnan(fe) || isinf(fe);
    o = vec4(bad ? vec3(30.0, 0.0, 30.0) : vec3(0.0, clamp(fe + 0.5, 0.0, 1.0)*4.0, clamp(wf.y, 0.0, 1.0)*4.0), 1.0); return;
  }
  if(uDbg > 0.5 && uDbg < 1.5){
    vec4 Ad = texCubic(uSurfA, simUV(xd)), Al = texture(uSurfA, simUV(xd));
    bool bad = any(isnan(Ad)) || any(isinf(Ad));
    o = vec4(bad ? vec3(30.0, 0.0, 0.0) : vec3(clamp(Al.x + 0.5, 0.0, 1.0)*4.0, m*4.0, clamp(Ad.x + 0.5, 0.0, 1.0)*4.0), 1.0); return;
  }
  if(depth < 0.0004 || vW.y < terrainB(vec2(vW.x, -vW.z)) + 0.001) discard;

  vec3 toCam = uCamPos - vW; float dist = length(toCam); vec3 V = toCam/dist;
  vec3 att = bandAtt(depth, xd.y);
  vec2 uvS = simUV(xd);

  // fft slopes and curvature, faded per band with depth
  vec4 d0 = texture(uDer0, cuv(xz, 0)), d1 = derBand(uDer1, xz, 1), d2 = derBand(uDer2, xz, 2);
  vec2 sl = rotv(d0.xy, uRot.x)*att.x + rotv(d1.xy, uRot.y)*att.y + rotv(d2.xy, uRot.z)*att.z;
  float tr = (d0.z + d0.w)*att.x + (d1.z + d1.w)*att.y + (d2.z + d2.w)*att.z;
  sl /= max(1.0 + 0.5*tr, 0.5);
  vec2 simSl = vec2(wf.z, -wf.w);
  sl += simSl;
  // surf-zone chop: the finest ocean band sampled at flow-carried coordinates, so it rides the current
  vec4 mmT = texture(uM, uvS);
  vec4 flT = texture(uFlow, uvS)*m;
  vec2 cp = vec2(xd.x, -xd.y);
  vec2 r1 = texture(uDer2, (cp - vec2(flT.x, -flT.y))/0.8).xy, r2 = texture(uDer2, (cp - vec2(flT.z, -flT.w))/0.8 + 0.5).xy;
  float turb = m*(0.35 + 0.9*smoothstep(0.05, 0.9, mmT.r))*mix(0.35, 1.0, smoothstep(0.01, 0.08, depth))*smoothstep(0.0008, 0.004, depth);
  sl += (r1*uFlowW.x + r2*uFlowW.y)*0.005*turb;
  float ripAmt = m*mix(0.12, 1.0, smoothstep(0.03, 0.25, depth))*smoothstep(0.003, 0.02, depth)*(1.0 - smoothstep(0.3, 1.0, mmT.r*m));
  vec2 dxw0 = dFdx(xz), dyw0 = dFdy(xz);
  float fp0 = sqrt(max(dot(dxw0, dxw0), dot(dyw0, dyw0)));
  float ripLost;
  // the visible surface keeps the ripples' shape but not every sun-facing facet (no white flecks);
  // the photons above use them at full strength for crisp caustics on the sand
  ripLost = 0.0072*smoothstep(0.004, 0.05, fp0)*m;
  sl += randRipples(xz, uTime, 0.12)*ripAmt*0.05*(1.0 - smoothstep(0.02, 0.2, fp0));
  vec3 N = normalize(vec3(-sl.x, 1.0, -sl.y));
  vec3 Ng = normalize(vec3(-simSl.x, 1.0, -simSl.y));

  // slope variance below the pixel footprint becomes roughness (no sparkle aliasing);
  // thin swash is never a mirror: capillaries and bubbles scatter the sun
  vec2 dxw = dFdx(xz), dyw = dFdy(xz);
  float fp = sqrt(max(dot(dxw, dxw), dot(dyw, dyw)));
  vec3 lost = clamp(log2(fp/(2.0*uLen/256.0))/7.0, 0.0, 1.0);
  vec4 mm = texture(uM, uvS);
  float simFoam = mm.r*m;
  float a2 = 0.002 + 0.012*ripAmt + 2.0*ripLost*ripAmt*ripAmt + dot(uSig*att*att, lost) + 0.035*(1.0 - smoothstep(0.03, 0.4, depth)) + 0.04*smoothstep(0.2, 0.8, simFoam);
  float NV = dot(N, V);
  N = normalize(mix(N, vec3(0.0, 1.0, 0.0), smoothstep(0.08, -0.25, NV)*0.8));
  NV = dot(N, V);
  if(NV < 0.03){ N = normalize(N + V*(0.03 - NV)); NV = dot(N, V); }
  vec3 L = uSunDir;

  vec3 R = reflect(-V, N);
  R.y = max(R.y, mix(0.0, 0.14, smoothstep(25.0, 400.0, dist)));
  R = normalize(R);
  float alpha = sqrt(a2);
  vec3 refl = envL(R, clamp(log2(alpha*1.25/0.0061), 0.0, 7.0));
  float F = 0.02 + 0.98*pow(1.0 - NV, 5.0)/(1.0 + 6.0*a2);
  vec3 spec = ggx(N, V, L, a2)*uSunE*0.025;
  if(uDbg > 5.5){ o = vec4(refl, 1.0); return; }
  spec *= mix(0.6, 1.0, smoothstep(0.02, 0.3, depth));

  // clear alpine water (caustic-volume's clear-pool coefficients, 1/m): red dies within metres, blue
  // carries, so white sand shows turquoise and deep water turns navy
  vec3 sigA = vec3(0.475, 0.08, 0.032);
  vec3 sigS = vec3(0.005, 0.017, 0.044);
  vec3 sigT = sigA + sigS;
  // look through the water with a calmed normal: tiny ripples no longer shred what lies below
  vec3 Tn = refract(-V, normalize(mix(N, Ng, 0.75)), 0.75);
  float cosT = max(-Tn.y, 0.12);
  // refracted ray to the bed: one refinement so the bed we see and the water column we attenuate agree
  // march the refracted ray to where it really meets the bed, so a rock is seen where it is,
  // not smeared into a pale ghost in front of it
  vec3 P0 = vec3(xz.x, wf.x, xz.y);
  float tMax = min(depth/cosT + 0.3, 9.0), tA = 0.0, tB = tMax;
  bool hit = false;
  for(int i=1;i<=14;i++){
    float t = tMax*float(i)/14.0;
    vec3 q = P0 + Tn*t;
    if(q.y < terrainB(vec2(q.x, -q.z))){ tB = t; hit = true; break; }
    tA = t;
  }
  if(hit){ for(int k=0;k<5;k++){ float tm = 0.5*(tA + tB); vec3 q = P0 + Tn*tm; if(q.y < terrainB(vec2(q.x, -q.z))) tB = tm; else tA = tm; } }
  float lView = hit ? tB : tMax;
  vec2 bz = (P0 + Tn*lView).xz;
  float dRay = max(wf.x - terrainB(vec2(bz.x, -bz.y)), 0.0);
  vec3 Lw = normalize(refract(-L, vec3(0.0, 1.0, 0.0), 0.75));
  float lSun = dRay/max(-Lw.y, 0.2);
  vec3 Tview = exp(-sigT*lView), Tsun = exp(-sigT*lSun);
  vec3 amb = ambientL();

  // the bed: sand or granite, sun through the water with photon-traced caustics and boulder shadows
  vec2 bxd = vec2(bz.x, -bz.y);
  vec3 binfo = terrainInfo(bxd);
  vec3 bp = vec3(bz.x, binfo.r, bz.y);
  vec3 Nb = terrN(bxd);
  Nb = normalize(mix(sandNormal(bz, Nb, 0.25), Nb, binfo.g));
  float cz = causAt(bxd);
  cz = mix(cz, 1.0, step(0.0, cz)*smoothstep(0.1, 0.6, binfo.g));
  cz = cz < 0.0 ? 1.0 : mix(1.0, 0.82 + 0.18*min(cz, 2.0), smoothstep(0.003, 0.03, depth));
  float shB = (depth < 5.0 && dist < 25.0) ? mix(1.0, mix(0.995, 1.0, sunShadow(bp, Nb)), 1.0 - smoothstep(15.0, 25.0, dist)) : 1.0;
  float bedL = mix(max(dot(Nb, -Lw), 0.0), 0.88 + 0.12*max(dot(Nb, -Lw), 0.0), binfo.g);
  // seen through water, rock is a soft, smooth, slightly darker shape: no crystal speckle
  // only a faint darkening of the sand where the actual rock body is
  vec3 subRock = sandAlbedo(bp.xz)*vec3(0.22, 0.26, 0.3)*(0.96 + 0.08*vnoise(bp.xz*0.7 + binfo.b*9.0));
  vec3 bedAlb = mix(sandAlbedo(bp.xz), subRock, smoothstep(0.1, 0.9, binfo.g));
  vec3 bott = bedAlb*vec3(0.46, 0.6, 0.64)*(uSunE*bedL*cz*shB/PI*Tsun + amb*1.1*(0.85 + 0.15*Nb.y));
  vec3 Ein = uSunE*max(L.y, 0.0)/PI + amb;
  vec3 Linf = sigS/sigT*Ein*0.42;
  vec3 under = bott*Tview + Linf*(1.0 - Tview);

  // light through thin crests
  float Hc = max(wf.x + 0.05, 0.0);
  float bl = pow(max(dot(L, -V), 0.0), 4.0)*pow(max(0.5 - 0.5*dot(L, N), 0.0), 3.0);
  under += vec3(0.015, 0.1, 0.18)*uSunE/PI*(1.4*Hc*bl + 0.03*sq(max(dot(V, N), 0.0)))*smoothstep(0.1, 0.5, depth);

  if(dist < 45.0 && F*clamp(depth, 0.0, 1.0) > 0.035){
    vec4 tr = traceRefl(vW + vec3(0.0, 0.01, 0.0), R);
    refl = mix(refl, tr.rgb, tr.a*(1.0 - smoothstep(30.0, 45.0, dist)));
  }

  if(abs(uDbg - 7.0) < 0.5){ o = vec4(under, 1.0); return; }
  // shallow film: surface effects fade in, so the waterline dissolves into the wet sand
  float film = smoothstep(0.0004, 0.006, depth);
  float clear = mix(0.12, 0.45, smoothstep(0.5, 4.0, depth));
  if(abs(uDbg - 2.0) < 0.5){ o = vec4(vec3(F*4.0, film*4.0, clamp(depth/3.0, 0.0, 1.0)*4.0), 1.0); return; }
  vec3 col = under*(1.0 - F*film*clear) + (refl*F*clear + spec)*film;

  // foam: sim foam (bores, swash tips) + sparse fft whitecaps offshore, textured with flow-advected lace
  float fd = simFoam;
  if(fd > 0.03 && abs(uDbg - 8.0) > 0.5){
    vec4 fl = texture(uFlow, uvS)*m;
    float top = pow(clamp(Ng.y, 0.0, 1.0), 8.0);
    vec2 cTop = xd, cSide = vec2(xd.x, vW.y*1.6 + xd.y*0.25);
    float lace = mix(laceAt(cSide, fl, 1.5), laceAt(cTop, fl, 1.7), top);
    float wl = lace;
    float thr = 0.95 - 0.5*clamp(fd, 0.0, 1.2);
    float fa = smoothstep(thr, thr + 0.14, lace)*smoothstep(0.03, 0.15, fd)*mix(0.35, 1.0, top);
    float dense = smoothstep(1.1, 1.5, fd);
    fa = mix(fa, smoothstep(0.35, 0.6, wl + 0.2*fd), dense);
    fa = mix(fa, clamp(fd*0.45, 0.0, 0.8), smoothstep(0.03, 0.15, fp));
    float lit = 0.35 + 0.65*max(dot(normalize(Ng + vec3(0.0, 0.5, 0.0)), L), 0.0);
    float ao = mix(1.0, 0.5 + 0.5*smoothstep(0.2, 0.8, wl), dense);
    vec3 foamCol = 0.85*ao*(uSunE*lit/PI + amb);
    col = mix(col, foamCol, fa*film*0.04);
  }

  vec3 hd = normalize(vec3(-V.x, 0.0, -V.z) + vec3(0.0, 0.12, 0.0));
  col = mix(col, envL(hd, 1.0)*0.55, (1.0 - exp(-dist/20000.0))*0.5);
  if(any(isnan(col)) || any(isinf(col))) col = vec3(40.0, 0.0, 0.0);
  o = vec4(col, 1.0);
}`;

const SAND_VS = SHARED + /* glsl */ `
in vec3 position;
uniform mat4 projectionMatrix, viewMatrix;
out vec3 vW;
out vec3 vN0;
void main(){
  vec2 xz = position.xz + uCamPos.xz;
  vec2 xd = vec2(xz.x, -xz.y);
  float b = terrainB(xd);
  float e = 0.06;
  float bx = terrainB(xd + vec2(e, 0.0)), bd = terrainB(xd + vec2(0.0, e));
  vN0 = normalize(vec3(-(bx - b)/e, 1.0, (bd - b)/e));
  vW = vec3(xz.x, b, xz.y);
  gl_Position = projectionMatrix*viewMatrix*vec4(vW, 1.0);
}`;

const SAND_FS = SHARED + /* glsl */ `
in vec3 vW;
in vec3 vN0;
out vec4 o;
void main(){
  vec3 vN = vN0;
  vec2 xz = vW.xz, xd = vec2(xz.x, -xz.y);
  vec3 toCam = uCamPos - vW; float dist = length(toCam); vec3 V = toCam/dist;
  float m = inside(xd);
  float b = vW.y;
  vec2 uvS = simUV(xd);
  vec4 mm = texCubic(uM, uvS);
  // wet where the water has recently stood above this exact spot; glassy right after it drains
  float wn = (fbm(xd*2.3) - 0.5)*0.012 + (vnoise(xd*14.0) - 0.5)*0.004;
  float wet = smoothstep(-0.03, 0.006, mm.g - b + wn)*m;
  // sand touching the water right now is always wet, so the film never sits on dry sand
  float lvlNow = texCubic(uSurfA, uvS).x;
  wet = max(wet, smoothstep(-0.02, 0.0, lvlNow - b)*m);
  // sand right at the waterline is saturated and glassy
  float gloss = smoothstep(-0.003, 0.004, mm.b - b)*m;
  gloss = max(gloss, smoothstep(-0.015, 0.0, lvlNow - b)*m);
  float strand = mm.a*m;
  vec3 info = terrainInfo(xd);
  float rockW = info.g;
  vec3 Nt = terrN(xd);
  vec3 N = normalize(mix(sandNormal(xz, Nt, mix(0.55, 0.2, wet)), Nt + 0.08*vec3(vnoise(xz*9.0) - 0.5, 0.0, vnoise(xz*9.0 + 4.0) - 0.5), rockW));
  // fine relief on the granite from the photo itself: crystals, pits and weathered grain
  if(rockW > 0.01 && dist < 60.0){
    vec2 tp = xz/2.6; const float te = 0.003;
    float l0 = dot(texture(uGranite, tp).rgb, vec3(0.333));
    float lx = dot(texture(uGranite, tp + vec2(te, 0.0)).rgb, vec3(0.333));
    float lz = dot(texture(uGranite, tp + vec2(0.0, te)).rgb, vec3(0.333));
    N = normalize(N - vec3(lx - l0, 0.0, lz - l0)*2.2*rockW);
  }
  vec3 L = uSunDir;
  vec3 alb = groundAlbedo(vW, Nt, info);
  alb *= mix(1.0, mix(0.5, 1.0, rockW), wet)*mix(vec3(1.0), vec3(0.96, 0.97, 1.0), wet*(1.0 - rockW));
  vec3 amb = ambientL();
  // light, nearby-only rock shadows: the coarse march turns into jagged fragments further out
  float sh = dist < 35.0 ? mix(1.0, mix(0.97, 1.0, sunShadow(vW, Nt)), 1.0 - smoothstep(20.0, 35.0, dist)) : 1.0;
  // crevices and the undersides of boulders see less sky
  float cav = rockW > 0.01 && dist < 90.0 ? rockCavity(xd, vW.y) : 0.0;
  float ao = mix(1.0, (0.7 + 0.3*smoothstep(-0.3, 0.9, Nt.y))*clamp(1.0 + cav*0.2, 0.96, 1.02), rockW);
  vec3 bounce = uSunE*max(L.y, 0.0)*vec3(0.5, 0.47, 0.42)*(0.25 + 0.3*(1.0 - N.y))/PI;
  vec3 col = alb*(uSunE*max(dot(N, L), 0.0)*sh/PI + (amb*(0.7 + 0.3*N.y) + bounce)*ao);
  vN = Nt;
  // wet film: sharper reflections the more recently the water drained
  float NV = max(dot(vN, V), 0.0);
  float F = 0.02 + 0.98*pow(1.0 - NV, 5.0);
  // grains poke through the film, breaking the sun's glare into grit
  float a2 = mix(mix(0.5, 0.09, gloss), 0.55, rockW);
  vec3 Ns = normalize(mix(N, vN, gloss*0.55));
  col += envL(reflect(-V, Ns), mix(6.0, 3.0, gloss))*F*mix(0.08, 0.38, wet)*mix(0.6, 1.0, gloss);
  col += ggx(Ns, V, L, a2)*uSunE*mix(0.03, 0.3, wet);

  // bubbles left stranded on the sand as the backwash drains
  if(strand > 0.02){
    vec4 fl = texture(uFlow, uvS);
    float lace = foamLace(xz, fl, 1.7);
    float fa = smoothstep(0.75 - 0.5*strand, 0.9 - 0.5*strand, lace)*smoothstep(0.02, 0.15, strand);
    col = mix(col, 0.9*(uSunE*0.8/PI + amb*1.1), fa*0.35);
  }
  vec3 hd = normalize(vec3(-V.x, 0.0, -V.z) + vec3(0.0, 0.003, 0.0));
  col = mix(col, envL(hd, 1.0), 1.0 - exp(-dist/9000.0));
  o = vec4(col, 1.0);
}`;

export const PHOTON_FS = SHARED + /* glsl */ `
uniform vec4 uPDom;
uniform float uPN;
layout(location=0) out vec4 o0;
layout(location=1) out vec4 o1;
void main(){
  vec2 uv = (gl_FragCoord.xy - 0.5)/(uPN - 1.0);
  vec2 xd = mix(uPDom.xy, uPDom.zw, uv);
  vec2 xz = vec2(xd.x, -xd.y);
  float b = terrainB(xd);
  vec4 wf = waterField(xd, b, true);
  float depth = wf.y, m = inside(xd);
  vec2 uvS = simUV(xd);
  vec3 att = bandAtt(depth, xd.y);
  vec4 d0 = texture(uDer0, cuv(xz, 0)), d1 = derBand(uDer1, xz, 1), d2 = derBand(uDer2, xz, 2);
  vec2 sl = rotv(d0.xy, uRot.x)*att.x + rotv(d1.xy, uRot.y)*att.y + rotv(d2.xy, uRot.z)*att.z;
  float tr = (d0.z + d0.w)*att.x + (d1.z + d1.w)*att.y + (d2.z + d2.w)*att.z;
  sl /= max(1.0 + 0.5*tr, 0.5);
  sl += vec2(wf.z, -wf.w);
  vec4 mmT = texture(uM, uvS);
  vec4 flT = texture(uFlow, uvS)*m;
  vec2 r1 = texture(uDer2, (xz - vec2(flT.x, -flT.y))/0.8).xy, r2 = texture(uDer2, (xz - vec2(flT.z, -flT.w))/0.8 + 0.5).xy;
  float turb = m*(0.35 + 0.9*smoothstep(0.05, 0.9, mmT.r))*mix(0.35, 1.0, smoothstep(0.01, 0.08, depth))*smoothstep(0.0008, 0.004, depth);
  sl += (r1*uFlowW.x + r2*uFlowW.y)*0.16*turb;
  float ripAmt = m*mix(0.12, 1.0, smoothstep(0.03, 0.25, depth))*smoothstep(0.003, 0.02, depth)*(1.0 - smoothstep(0.3, 1.0, mmT.r*m));
  float ripLost;
  ripLost = 0.0;
  sl += randRipples(xz, uTime, 0.12)*ripAmt;
  vec3 n = normalize(vec3(-sl.x, 1.0, -sl.y));
  float ci = dot(n, uSunDir);
  float Fi = 0.02 + 0.98*pow(1.0 - clamp(ci, 0.0, 1.0), 5.0), F0 = 0.02 + 0.98*pow(1.0 - uSunDir.y, 5.0);
  float T = ci > 0.0 ? (1.0 - Fi)/(1.0 - F0) : 0.0;
  T *= 1.0 - 0.85*clamp(mmT.r*m, 0.0, 1.0);
  if(depth < 0.002) T = 0.0;
  vec3 d = refract(-uSunDir, n, 1.0/1.333);
  vec2 q = xd + vec2(d.x, -d.z)*depth/max(-d.y, 0.1);
  o0 = vec4(xz.x, wf.x, xz.y, T);
  o1 = vec4(sl, b, terrainB(q));
}`;

function raw(vs, fs, uniforms, extra = {}) {
  return new THREE.RawShaderMaterial({ glslVersion: THREE.GLSL3, vertexShader: vs, fragmentShader: fs, uniforms, ...extra });
}
export function waterMaterial(u) {
  return raw(WATER_VS, WATER_FS, u, { polygonOffset: true, polygonOffsetFactor: -0.5, polygonOffsetUnits: -1 });
}
export function sandMaterial(u) { return raw(SAND_VS, SAND_FS, u); }
