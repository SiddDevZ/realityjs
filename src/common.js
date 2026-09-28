// shared constants and glsl used by the simulation and the renderers.
// world: x lateral, y up, z toward the viewer. d = -z is distance offshore from the still-water line.

export const SIM = {
  NX: 1024, NZ: 512, DX: 0.125,
  X0: -64, D0: -8,
  SPONGE0: 42, SPONGE1: 55.5,
};
SIM.W = SIM.NX * SIM.DX;
SIM.DZ = SIM.NZ * SIM.DX;
export const NSWELL = 28;

// lake bed: a pale sandy shelf that drops into deep water, and the rocky point on the right.
// mirrored on the cpu without the fine noise (camera, trees, forcing depth)
export function groundJS(x, d) {
  const s = d + 4;
  let b = s > 0 ? 0.6 - 3.6 * (1 - Math.exp(-s / 12)) : 0.6 - 0.06 * s;
  const sm = Math.min(1, Math.max(0, (d - 28) / 70));
  b -= 30 * sm * sm * (3 - 2 * sm);
  const r = Math.hypot((x - 34) / 22, (d - 64) / 18);
  const k = Math.min(1, Math.max(0, (r - 0.35) / 0.9));
  b = Math.max(b, 2.4 - 14 * k * k * (3 - 2 * k));
  return b;
}
export const terrainJS = groundJS;

export const HEAD = /* glsl */ `
precision highp float; precision highp int; precision highp sampler2D;
#define PI 3.14159265359
#define TAU 6.28318530718
const float X0 = ${SIM.X0.toFixed(3)}, D0 = ${SIM.D0.toFixed(3)}, DX = ${SIM.DX.toFixed(4)};
const int NX = ${SIM.NX}, NZ = ${SIM.NZ};
const float SIMW = ${SIM.W.toFixed(3)}, SIMD = ${SIM.DZ.toFixed(3)};
const float SPONGE0 = ${SIM.SPONGE0.toFixed(2)}, SPONGE1 = ${SIM.SPONGE1.toFixed(2)};
#define NSW ${NSWELL}

float hash12(vec2 p){ vec3 p3 = fract(vec3(p.xyx)*.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y)*p3.z); }
float vnoise(vec2 p){
  vec2 i = floor(p), f = fract(p);
  vec2 u = f*f*f*(f*(f*6.0 - 15.0) + 10.0);
  return mix(mix(hash12(i), hash12(i + vec2(1,0)), u.x), mix(hash12(i + vec2(0,1)), hash12(i + vec2(1,1)), u.x), u.y);
}
float fbm(vec2 p){ float a = 0.5, s = 0.0; mat2 m = mat2(1.6, 1.2, -1.2, 1.6); for(int i=0;i<5;i++){ s += a*vnoise(p); p = m*p + 3.1; a *= 0.5; } return s; }
float sq(float x){ return x*x; }
float softplus(float x, float k){ return log(1.0 + exp(k*x))/k; }

float groundB(vec2 xd){
  float x = xd.x, d = xd.y;
  float s = d + 4.0;
  float b = s > 0.0 ? 0.6 - 3.6*(1.0 - exp(-s/12.0)) : 0.6 - 0.06*s;
  b -= 30.0*smoothstep(28.0, 98.0, d);
  float r = length(vec2((x - 34.0)/22.0, (d - 64.0)/18.0));
  b = max(b, 2.4 - 14.0*smoothstep(0.35, 1.25, r));
  b += 0.05*(vnoise(xd*0.06) - 0.5) + 0.012*(vnoise(xd*0.5 + 3.1) - 0.5);
  return b;
}
// baked bed with boulders where it exists, the analytic bed beyond it
uniform sampler2D uTerr;
uniform vec4 uTerrDom;
vec2 terrUV(vec2 xd){ return (xd - uTerrDom.xy)*uTerrDom.zw; }
bool inTerr(vec2 uv){ return all(greaterThan(uv, vec2(0.001))) && all(lessThan(uv, vec2(0.999))); }
float terrainB(vec2 xd){
  vec2 uv = terrUV(xd);
  return inTerr(uv) ? texture(uTerr, uv).r : groundB(xd);
}
vec3 terrainInfo(vec2 xd){
  vec2 uv = terrUV(xd);
  return inTerr(uv) ? texture(uTerr, uv).rgb : vec3(groundB(xd), 0.0, 0.0);
}

// incoming swell (linear, finite depth): the far field, and the forcing for the surf sim
uniform vec4 uSw[NSW];    // kx, kd, omega, amplitude
uniform float uSwP[NSW];  // phase
uniform float uSwH0;      // reference depth at the forcing zone
uniform float uRamp;
vec3 swell(vec2 xd, float t){
  float eta = 0.0; vec2 U = vec2(0.0);
  for(int i=0;i<NSW;i++){
    vec4 w = uSw[i];
    float e = w.w*cos(w.x*xd.x + w.y*xd.y - w.z*t + uSwP[i]);
    vec2 k = w.xy; float kl = length(k);
    eta += e; U += e*w.z/(kl*uSwH0)*k/kl;
  }
  return vec3(eta, U)*uRamp;
}
vec3 swellGrad(vec2 xd, float t){
  float eta = 0.0; vec2 g = vec2(0.0);
  for(int i=0;i<NSW;i++){
    vec4 w = uSw[i];
    float ph = w.x*xd.x + w.y*xd.y - w.z*t + uSwP[i];
    float a = w.w;
    eta += a*cos(ph); g -= a*sin(ph)*w.xy;
  }
  return vec3(eta, g)*uRamp;
}
`;
