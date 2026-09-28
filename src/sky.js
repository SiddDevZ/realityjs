import * as THREE from 'three';

// single-scattering atmosphere (rayleigh + mie + ozone) baked to an equal-area environment map.
// the lower hemisphere mirrors the upper, so low mips give the sky's mean radiance for ambient light.

export const ENV_GLSL = /* glsl */ `
vec2 dirToEnv(vec3 d){ return vec2(atan(d.z, d.x)/6.28318530718 + 0.5, clamp(d.y, -1.0, 1.0)*0.5 + 0.5); }
vec3 envToDir(vec2 uv){ float y = uv.y*2.0 - 1.0; float r = sqrt(max(1.0 - y*y, 0.0)); float ph = (uv.x - 0.5)*6.28318530718; return vec3(r*cos(ph), y, r*sin(ph)); }
`;

// snow-capped range across the lake (16-24 km away), raymarched as a heightfield in world space
export const MOUNT_GLSL = /* glsl */ `
float mh1(vec2 p){ vec3 p3 = fract(vec3(p.xyx)*.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y)*p3.z); }
float mn(vec2 p){ vec2 i = floor(p), f = fract(p); vec2 u = f*f*(3.0 - 2.0*f);
  return mix(mix(mh1(i), mh1(i + vec2(1,0)), u.x), mix(mh1(i + vec2(0,1)), mh1(i + vec2(1,1)), u.x), u.y); }
float ridged(vec2 p, int oct){
  float s = 0.0, a = 0.5, w = 1.0; mat2 m = mat2(1.6, 1.2, -1.2, 1.6);
  for(int i=0;i<8;i++){
    if(i >= oct) break;
    float n = 1.0 - abs(mn(p)*2.0 - 1.0); n *= n;
    s += a*n*w; w = clamp(n*1.9, 0.0, 1.0);
    p = m*p + 4.7; a *= 0.5;
  }
  return s;
}
float mountH(vec2 xz, int oct){
  float fwd = -xz.y;
  float az = atan(xz.x, fwd);
  float r = length(xz);
  float r0 = 17600.0 + 1300.0*sin(az*1.7 + 0.6) + 600.0*sin(az*4.3 + 1.1);
  float u = r - r0;
  if(u < 0.0) return -60.0 + u*0.01;
  float rise = smoothstep(0.0, 1800.0, u);
  float n = ridged(xz/5200.0 + vec2(3.7, 1.9), oct);
  float base = 260.0 + 700.0*mn(xz/2600.0 + 7.0);
  return rise*(base*0.25 + 1750.0*pow(n, 1.5)) + 40.0*smoothstep(0.0, 300.0, u) - 20.0;
}
// rgb and coverage of the range along a view ray from the camera
vec4 mountains(vec3 rd, vec3 L, vec3 sunE, vec3 amb, vec3 haze){
  if(rd.y < -0.004 || rd.y > 0.16) return vec4(0.0);
  vec3 ro = vec3(0.0, 1.8, 0.0);
  float t = 15500.0, tPrev = t;
  bool hit = false;
  for(int i=0;i<110;i++){
    vec3 p = ro + rd*t;
    float h = mountH(p.xz, 5);
    float dh = p.y - h;
    if(dh < 0.0){ hit = true; break; }
    tPrev = t;
    t += max(dh*0.55, 25.0 + t*0.002);
    if(t > 36000.0) break;
  }
  if(!hit) return vec4(0.0);
  float a0 = tPrev, a1 = t;
  for(int k=0;k<7;k++){
    float mt = 0.5*(a0 + a1);
    vec3 p = ro + rd*mt;
    if(p.y < mountH(p.xz, 5)) a1 = mt; else a0 = mt;
  }
  t = 0.5*(a0 + a1);
  vec3 p = ro + rd*t;
  float e = 18.0 + t*0.0012;
  float hC = mountH(p.xz, 7);
  vec3 n = normalize(vec3(mountH(p.xz - vec2(e, 0.0), 7) - mountH(p.xz + vec2(e, 0.0), 7), 2.0*e,
                          mountH(p.xz - vec2(0.0, e), 7) - mountH(p.xz + vec2(0.0, e), 7)));
  // spring snow: above a wandering snowline, thinning on steep faces into streaks and rock
  float line = -60.0 + 180.0*mn(p.xz/2200.0) + 120.0*mn(p.xz/520.0);
  float snow = smoothstep(line - 40.0, line + 70.0, hC)*smoothstep(0.42, 0.72, n.y);
  snow = max(snow, smoothstep(800.0, 1000.0, hC)*smoothstep(0.2, 0.45, n.y));
  snow *= smoothstep(0.25, 0.6, mn(p.xz/160.0)*0.6 + mn(p.xz/45.0)*0.4 + 0.25);
  vec3 forest = vec3(0.24, 0.27, 0.32)*(0.75 + 0.5*mn(p.xz/90.0));
  vec3 rock = vec3(0.16, 0.155, 0.15);
  vec3 alb = mix(mix(forest, rock, smoothstep(0.55, 0.3, n.y)*smoothstep(200.0, 500.0, hC)), vec3(0.8, 0.83, 0.88), snow);
  vec3 lit = alb*(sunE*max(dot(n, L), 0.0)/3.14159 + amb*(0.55 + 0.45*n.y));
  // distant air: bluish veil that swallows the dark forest faster than the bright snow
  float T = exp(-t/55000.0);
  vec3 col = lit*T + haze*(1.0 - T);
  float cov = smoothstep(-0.0045, -0.0035, rd.y) + (rd.y > -0.0035 ? 1.0 : 0.0);
  return vec4(col, clamp(cov, 0.0, 1.0));
}
`;

// the photographed range: lookup by view direction, graded to this sky and veiled in its air
const PHOTO_GLSL = (AZ, EL0, EL1) => /* glsl */ `
vec4 photoRange(sampler2D pano, sampler2D skyT, vec3 d){
  float az = atan(d.x, -d.z), el = asin(clamp(d.y, -1.0, 1.0));
  vec2 pu = vec2(az/${AZ.toFixed(3)}*0.5 + 0.5, (el - ${EL0.toFixed(4)})/${(EL1 - EL0).toFixed(4)});
  if(any(lessThan(pu, vec2(0.0))) || any(greaterThan(pu, vec2(1.0)))) return vec4(0.0);
  vec4 mc = textureLod(pano, pu, 0.0);
  vec3 hz = textureLod(skyT, dirToEnv(normalize(vec3(d.x, 0.03, d.z))), 0.0).rgb;
  float hl = dot(hz, vec3(0.2126, 0.7152, 0.0722));
  float pl = dot(mc.rgb, vec3(0.2126, 0.7152, 0.0722));
  // dark conifer slopes read green-grey, snow stays white
  vec3 g = mix(mc.rgb, pl*vec3(0.86, 1.04, 0.86), 0.7*(1.0 - smoothstep(0.25, 0.6, pl)));
  g = mix(g, vec3(pl), 0.25*smoothstep(0.5, 0.85, pl));
  vec3 m = g*hl/0.3;
  // 20 km of air: less contrast overall, a blue-grey veil thickening toward the base
  float veil = 0.1 + 0.22*(1.0 - smoothstep(0.0, 0.025, el));
  m = mix(m*vec3(0.78, 0.86, 1.02), hz*vec3(0.42, 0.55, 0.78), veil);
  float a = smoothstep(0.05, 0.7, mc.a)*smoothstep(0.97, 0.9, pu.y);
  return vec4(m, a);
}
`;

const FS_ATMO = /* glsl */ `
precision highp float;
uniform vec3 uSunDir, uSunE;
uniform float uMount;
uniform sampler2D uPano, uSkyT;
in vec2 vUv; out vec4 o;
${ENV_GLSL}
${PHOTO_GLSL(2.1, -0.006, 0.09)}
const float PI = 3.14159265359;
const float Re = 6360e3, Ra = 6420e3;
const vec3 bR = vec3(5.802e-6, 13.558e-6, 33.1e-6);
const float bM = 1.3e-6;
const vec3 bO = vec3(0.650e-6, 1.881e-6, 0.085e-6);
float ch(vec2 p){ vec3 p3 = fract(vec3(p.xyx)*.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y)*p3.z); }
float cn(vec2 p){ vec2 i = floor(p), f = fract(p); vec2 u = f*f*(3.0 - 2.0*f);
  return mix(mix(ch(i), ch(i + vec2(1,0)), u.x), mix(ch(i + vec2(0,1)), ch(i + vec2(1,1)), u.x), u.y); }
float cfbm(vec2 p){ float a = 0.5, s = 0.0; mat2 m = mat2(1.6, 1.2, -1.2, 1.6); for(int i=0;i<6;i++){ s += a*cn(p); p = m*p + 7.3; a *= 0.5; } return s; }
// cumulus deck at ~1.4 km: puffy tops lit by the sun, flat grey bases, thinning into haze at the horizon
vec4 clouds(vec3 rd, vec3 sky){
  if(rd.y <= 0.004) return vec4(0.0);
  float t = 1400.0/rd.y;
  vec2 p = rd.xz*t*0.00055 + vec2(3.1, 7.4);
  float base = cfbm(p*0.55);
  float cov = smoothstep(0.63, 0.71, base + 0.16*(cfbm(p*2.4) - 0.5));
  if(cov <= 0.0) return vec4(0.0);
  // billowed edges: cauliflower puffs rather than smooth streaks
  float bil = 1.0 - abs(cn(p*5.0)*2.0 - 1.0);
  float bil2 = 1.0 - abs(cn(p*11.0 + 3.0)*2.0 - 1.0);
  float dens = clamp(cov*1.25 - (1.0 - bil)*0.3 - (1.0 - bil2)*0.15, 0.0, 1.0);
  // sunlit tops several times brighter than the blue sky, blue-grey shaded bases
  vec2 sp = p + normalize(uSunDir.xz + 1e-4)*0.06;
  float shade = clamp(0.55 + (base - cfbm(sp*0.55))*7.0 + 0.25*bil, 0.15, 1.0);
  float mu = dot(rd, uSunDir);
  vec3 lit = vec3(1.0, 0.97, 0.93)*(3.2 + 2.0*pow(max(mu, 0.0), 8.0)*(1.0 - dens*0.5));
  vec3 dark = vec3(1.05, 1.12, 1.25);
  vec3 cloud = mix(dark, lit, shade);
  float haze = 1.0 - exp(-t/38000.0);
  cloud = mix(cloud, sky, haze);
  float a = dens*(1.0 - haze*0.9)*smoothstep(0.004, 0.03, rd.y);
  return vec4(cloud, a);
}
vec2 rs(vec3 ro, vec3 rd, float r){ float b = dot(ro, rd), c = dot(ro, ro) - r*r, d = b*b - c; if(d < 0.0) return vec2(-1.0); d = sqrt(d); return vec2(-b - d, -b + d); }
void main(){
  vec3 rd = envToDir(vUv);
  rd.y = abs(rd.y);
  rd = normalize(rd + vec3(0.0, 0.0012, 0.0));
  // lake tahoe sits at 1900 m: thinner air, a deeper blue sky
  vec3 ro = vec3(0.0, Re + 1900.0, 0.0);
  float tMax = rs(ro, rd, Ra).y;
  const int S = 32; float ds = tMax/float(S);
  float mu = dot(rd, uSunDir);
  float pR = 3.0/(16.0*PI)*(1.0 + mu*mu);
  float g = 0.78;
  float pM = 3.0/(8.0*PI)*((1.0 - g*g)*(1.0 + mu*mu))/((2.0 + g*g)*pow(1.0 + g*g - 2.0*g*mu, 1.5));
  vec3 sR = vec3(0.0), sM = vec3(0.0);
  float oR = 0.0, oM = 0.0, oO = 0.0;
  for(int i=0;i<S;i++){
    vec3 p = ro + rd*(float(i) + 0.5)*ds;
    float h = length(p) - Re;
    float hr = exp(-h/8000.0)*ds, hm = exp(-h/1200.0)*ds, ho = max(0.0, 1.0 - abs(h - 25000.0)/15000.0)*ds;
    oR += hr; oM += hm; oO += ho;
    float tl = rs(p, uSunDir, Ra).y; float dl = tl/10.0;
    float lR = 0.0, lM = 0.0, lO = 0.0; bool lit = true;
    for(int j=0;j<10;j++){
      vec3 q = p + uSunDir*(float(j) + 0.5)*dl;
      float hq = length(q) - Re;
      if(hq < 0.0){ lit = false; break; }
      lR += exp(-hq/8000.0)*dl; lM += exp(-hq/1200.0)*dl; lO += max(0.0, 1.0 - abs(hq - 25000.0)/15000.0)*dl;
    }
    if(lit){
      vec3 att = exp(-(bR*(oR + lR) + bM*1.1*(oM + lM) + bO*(oO + lO)));
      sR += att*hr; sM += att*hm;
    }
  }
  // cheap multiple-scattering lift so the horizon is not too dark
  vec3 ms = (sR*bR + sM*bM*0.5)*(1.3/(4.0*PI));
  vec3 col = 20.0*(sR*bR*pR + sM*bM*pM + ms);
  // multiple scattering whitens and cools the long horizon paths instead of leaving them olive
  float hz = exp(-rd.y*22.0);
  float l = dot(col, vec3(0.3, 0.5, 0.2));
  col = mix(col, l*vec3(0.8, 0.95, 1.15), hz*0.2);
  // the range reflects in the lake, so it is part of the environment too
  vec3 hazeC = col;
  if(uMount > 0.5){
    vec4 mc = photoRange(uPano, uSkyT, normalize(rd - vec3(0.0, 0.0012, 0.0)));
    col = mix(col, mc.rgb, mc.a);
  }
  o = vec4(col, 1.0);
}`;

// sun radiance reaching the ground (rayleigh + mie + ozone optical depth along the sun ray)
export function sunIrradiance(sunDir) {
  const Re = 6360e3, Ra = 6420e3;
  const bR = [5.802e-6, 13.558e-6, 33.1e-6], bM = 1.3e-6, bO = [0.65e-6, 1.881e-6, 0.085e-6];
  const ro = [0, Re + 1900, 0];
  const b = ro[1] * sunDir.y, c = ro[1] * ro[1] - Ra * Ra;
  const t = -b + Math.sqrt(b * b - c);
  let oR = 0, oM = 0, oO = 0; const n = 64, dl = t / n;
  for (let i = 0; i < n; i++) {
    const s = (i + 0.5) * dl;
    const p = [sunDir.x * s, ro[1] + sunDir.y * s, sunDir.z * s];
    const h = Math.hypot(p[0], p[1], p[2]) - Re;
    oR += Math.exp(-h / 8000) * dl; oM += Math.exp(-h / 1200) * dl; oO += Math.max(0, 1 - Math.abs(h - 25000) / 15000) * dl;
  }
  return new THREE.Vector3(...[0, 1, 2].map((k) => 20 * Math.exp(-(bR[k] * oR + bM * 1.1 * oM + bO[k] * oO))));
}

export function bakeSky(gpu, sunDir, sunE) {
  const rt = gpu.target(2048, 1024, {
    type: THREE.HalfFloatType, min: THREE.LinearMipmapLinearFilter, mag: THREE.LinearFilter,
    wrapS: THREE.RepeatWrapping, mips: true,
  });
  const m = new THREE.RawShaderMaterial({
    glslVersion: THREE.GLSL3,
    vertexShader: `in vec3 position; out vec2 vUv; void main(){ vUv = position.xy*0.5 + 0.5; gl_Position = vec4(position.xy, 0.0, 1.0); }`,
    fragmentShader: FS_ATMO,
    uniforms: { uSunDir: { value: sunDir }, uSunE: { value: sunE }, uMount: { value: 0 }, uPano: { value: null }, uSkyT: { value: null } },
    depthTest: false, depthWrite: false,
  });
  gpu.run(m, rt);
  // a sky-only copy for the dome, which draws the range itself at full resolution
  const sky = gpu.target(2048, 1024, {
    type: THREE.HalfFloatType, min: THREE.LinearMipmapLinearFilter, mag: THREE.LinearFilter,
    wrapS: THREE.RepeatWrapping, mips: true,
  });
  m.uniforms.uMount.value = 0;
  gpu.run(m, sky);
  // the range mirrored in the lake: bake it into the reflection map when the photo arrives
  const addRange = (pano) => {
    m.uniforms.uMount.value = 1; m.uniforms.uPano.value = pano; m.uniforms.uSkyT.value = sky.texture;
    gpu.run(m, rt);
  };
  return { env: rt.texture, sky: sky.texture, addRange };
}

const PANO = { W: 12288, H: 1024, AZ: 2.1, EL0: -0.006, EL1: 0.076 };
export function bakeMountains(gpu, sunDir, sunE, skyTex) {
  const rt = gpu.target(PANO.W, PANO.H, { type: THREE.HalfFloatType, min: THREE.LinearFilter, mag: THREE.LinearFilter });
  const m = new THREE.RawShaderMaterial({
    glslVersion: THREE.GLSL3,
    vertexShader: `in vec3 position; out vec2 vUv; void main(){ vUv = position.xy*0.5 + 0.5; gl_Position = vec4(position.xy, 0.0, 1.0); }`,
    fragmentShader: `precision highp float;
      uniform vec3 uSunDir, uSunE; uniform sampler2D uSky;
      in vec2 vUv; out vec4 o;
      ${ENV_GLSL}
      ${MOUNT_GLSL}
      void main(){
        float az = (vUv.x*2.0 - 1.0)*${PANO.AZ.toFixed(3)};
        float el = mix(${PANO.EL0.toFixed(4)}, ${PANO.EL1.toFixed(4)}, vUv.y);
        vec3 rd = vec3(sin(az)*cos(el), sin(el), -cos(az)*cos(el));
        vec3 amb = textureLod(uSky, vec2(0.5, 0.75), 9.0).rgb;
        vec3 haze = textureLod(uSky, dirToEnv(normalize(vec3(rd.x, 0.02, rd.z))), 0.0).rgb;
        o = mountains(rd, uSunDir, uSunE, amb, haze);
      }`,
    uniforms: { uSunDir: { value: sunDir }, uSunE: { value: sunE }, uSky: { value: skyTex } },
    depthTest: false, depthWrite: false,
  });
  gpu.run(m, rt);
  return rt.texture;
}

export function skyDome(env, shared, pano) {
  const mat = new THREE.ShaderMaterial({
    uniforms: { uEnv: { value: env }, uSkyT: { value: env }, uPano: { value: pano }, uSunDir: shared.uSunDir, uSunE: shared.uSunE },
    side: THREE.BackSide, depthWrite: false,
    vertexShader: /* glsl */ `
      varying vec3 vDir;
      void main(){
        vDir = position;
        vec4 p = projectionMatrix*mat4(mat3(viewMatrix))*vec4(position, 1.0);
        gl_Position = p.xyww;
      }`,
    fragmentShader: /* glsl */ `
      uniform sampler2D uEnv, uPano, uSkyT; uniform vec3 uSunDir, uSunE;
      varying vec3 vDir;
      ${ENV_GLSL}
      ${PHOTO_GLSL(PANO.AZ, PANO.EL0, PANO.EL1)}
      void main(){
        vec3 d = normalize(vDir);
        vec3 hd = normalize(vec3(d.x, 0.0015, d.z));
        vec3 c = d.y > 0.0015 ? textureLod(uEnv, dirToEnv(d), 0.0).rgb : textureLod(uEnv, dirToEnv(hd), 0.0).rgb;
        // mountains per pixel at full resolution (the env copy is only for reflections)
        vec4 mc = photoRange(uPano, uSkyT, d);
        c = mix(c, mc.rgb, mc.a);
        float r = acos(clamp(dot(d, uSunDir), -1.0, 1.0))/0.00465;
        if(r < 1.0) c += uSunE*9.0*(0.4 + 0.6*sqrt(max(1.0 - r*r, 0.0)));
        c += uSunE*(0.010*exp(-r*0.3) + 0.012*exp(-r*0.05));
        gl_FragColor = vec4(c, 1.0);
      }`,
  });
  const m = new THREE.Mesh(new THREE.SphereGeometry(10, 64, 32), mat);
  m.frustumCulled = false;
  m.renderOrder = -100;
  return m;
}
