import * as THREE from 'three';

// photon-traced caustics, ported from caustic-volume (scottiefox, mit):
// one photon per grid vertex on the water surface refracts the sun through the real surface normal,
// lands on the sand, and the photon grid drawn as a mesh gives irradiance = source area / landed area.

export const PN = 768;
export const CAUS_RES = 1536;
export const CAUS_SIZE = 24;

export function causticsGLSL() {
  return /* glsl */ `
uniform sampler2D uCaus;
uniform vec4 uCausDom;   // x0, d0, 1/size, active
// sun irradiance on the bed relative to flat water, including absorption; -1 when outside the traced area
float causAt(vec2 xd){
  vec2 uv = (xd - uCausDom.xy)*uCausDom.z;
  if(uCausDom.w < 0.5 || any(lessThan(uv, vec2(0.002))) || any(greaterThan(uv, vec2(0.998)))) return -1.0;
  vec2 px = vec2(1.0/${CAUS_RES}.0);
  // a light tent filter keeps the finest filaments from shimmering
  float c = texture(uCaus, uv).r*0.4
          + (texture(uCaus, uv + vec2(px.x, 0.0)).r + texture(uCaus, uv - vec2(px.x, 0.0)).r
          +  texture(uCaus, uv + vec2(0.0, px.y)).r + texture(uCaus, uv - vec2(0.0, px.y)).r)*0.15;
  float edge = smoothstep(0.0, 0.06, uv.x)*smoothstep(1.0, 0.94, uv.x)*smoothstep(0.0, 0.06, uv.y)*smoothstep(1.0, 0.94, uv.y);
  return mix(-1.0, c, edge);
}
`;
}

export class Caustics {
  constructor(gpu, photonFS, uniforms) {
    this.gpu = gpu;
    this.photons = gpu.target(PN, PN, { count: 2 });
    this.tex = gpu.target(CAUS_RES, CAUS_RES, { type: THREE.HalfFloatType, min: THREE.LinearFilter, mag: THREE.LinearFilter });
    this.dom = new THREE.Vector4(0, 0, 1 / CAUS_SIZE, 0);
    this.uPDom = new THREE.Vector4();
    this.photonMat = gpu.material(photonFS, { ...uniforms, uPDom: { value: this.uPDom }, uPN: { value: PN } });

    // the photon grid, drawn straight into the caustic texture with additive blending
    const idx = new Uint32Array((PN - 1) * (PN - 1) * 6);
    let k = 0;
    for (let j = 0; j < PN - 1; j++) for (let i = 0; i < PN - 1; i++) {
      const a = j * PN + i;
      idx[k++] = a; idx[k++] = a + 1; idx[k++] = a + PN;
      idx[k++] = a + 1; idx[k++] = a + PN + 1; idx[k++] = a + PN;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(PN * PN * 3), 3));
    g.setIndex(new THREE.BufferAttribute(idx, 1));
    this.mesh = new THREE.Mesh(g, new THREE.RawShaderMaterial({
      glslVersion: THREE.GLSL3,
      uniforms: {
        ...uniforms,
        tP0: { value: this.photons.textures[0] }, tP1: { value: this.photons.textures[1] },
        uCausDom: { value: this.dom },
      },
      vertexShader: /* glsl */ `
        precision highp float; precision highp int; precision highp sampler2D;
        in vec3 position;
        uniform sampler2D tP0, tP1;
        uniform vec3 uSunDir;
        uniform vec4 uCausDom;
        out vec2 vOld, vNew;
        out float vW;
        out vec3 vAtt;
        const int PNI = ${PN};
        void main(){
          ivec2 c = ivec2(gl_VertexID % PNI, gl_VertexID / PNI);
          vec4 a = texelFetch(tP0, c, 0), b = texelFetch(tP1, c, 0);
          vec3 p = a.xyz;
          vec3 n = normalize(vec3(-b.x, 1.0, -b.y));
          vec3 d = refract(-uSunDir, n, 1.0/1.333);
          if(dot(d, d) < 0.5) d = vec3(0.0, -1.0, 0.0);
          // land on the bed (bed height under the entry point, refined once along the ray)
          float t = max((b.z - p.y)/min(d.y, -1e-3), 0.0);
          vec3 q = p + d*t;
          t = max((b.w - p.y)/min(d.y, -1e-3), 0.0);
          q = p + d*t;
          // flat-water landing for the same depth: the reference footprint (intensity 1 on flat water)
          vec3 dF = refract(-uSunDir, vec3(0.0, 1.0, 0.0), 1.0/1.333);
          float tf = max((b.z - 0.0)/min(dF.y, -1e-3), 0.0);
          vOld = vec2(p.x, -p.z) + vec2(dF.x, -dF.z)*tf;
          vNew = vec2(q.x, -q.z);
          vW = a.w;
          vAtt = exp(-vec3(0.39, 0.088, 0.064)*t);
          vec2 uv = (vNew - uCausDom.xy)*uCausDom.z;
          gl_Position = vec4(uv*2.0 - 1.0, 0.0, 1.0);
        }`,
      fragmentShader: /* glsl */ `
        precision highp float;
        in vec2 vOld, vNew;
        in float vW;
        in vec3 vAtt;
        out vec4 o;
        void main(){
          vec2 ox = dFdx(vOld), oy = dFdy(vOld), nx = dFdx(vNew), ny = dFdy(vNew);
          float aO = abs(ox.x*oy.y - ox.y*oy.x);
          float aN = abs(nx.x*ny.y - nx.y*ny.x);
          float I = aO/max(aN, 1e-14);
          if((floatBitsToUint(I) & 0x7F800000u) == 0x7F800000u) I = 0.0;
          I = min(I, 16.0);
          float v = I*vW;
          if((floatBitsToUint(v) & 0x7F800000u) == 0x7F800000u) v = 0.0;
          o = vec4(v, v, v, 1.0);
        }`,
      blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor,
      depthTest: false, depthWrite: false, side: THREE.DoubleSide,
    }));
    this.mesh.frustumCulled = false;
    this.scene = new THREE.Scene();
    this.scene.add(this.mesh);
    this.cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  }

  // trace a square in front of the camera; the caustic texture covers the same square
  update(camPos, yaw) {
    const fx = Math.sin(yaw), fd = Math.cos(yaw);
    const cx = camPos.x + fx * 11, cd = -camPos.z + fd * 11;
    const x0 = cx - CAUS_SIZE / 2, d0 = cd - CAUS_SIZE / 2;
    // photons start a little beyond the texture so sloped rays still fill its edges
    this.uPDom.set(x0 - 0.8, d0 - 0.8, x0 + CAUS_SIZE + 0.8, d0 + CAUS_SIZE + 0.8);
    this.dom.set(x0, d0, 1 / CAUS_SIZE, 1);
    this.gpu.run(this.photonMat, this.photons);
    const r = this.gpu.r, prev = r.getRenderTarget(), ac = r.autoClear;
    r.setRenderTarget(this.tex);
    r.setClearColor(0x000000, 0);
    r.clear(true, false, false);
    r.autoClear = false;
    r.render(this.scene, this.cam);
    r.autoClear = ac;
    r.setRenderTarget(prev);
  }
}
