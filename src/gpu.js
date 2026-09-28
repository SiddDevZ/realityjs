import * as THREE from 'three';

// fullscreen-pass helper for gpgpu work on render targets
const VS = /* glsl */ `
in vec3 position;
out vec2 vUv;
void main(){ vUv = position.xy*0.5 + 0.5; gl_Position = vec4(position.xy, 0.0, 1.0); }
`;

export class GPU {
  constructor(renderer) {
    this.r = renderer;
    this.cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this.scene = new THREE.Scene();
    this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2));
    this.quad.frustumCulled = false;
    this.scene.add(this.quad);
  }

  target(w, h, o = {}) {
    const rt = new THREE.WebGLRenderTarget(w, h, {
      type: o.type ?? THREE.FloatType,
      format: THREE.RGBAFormat,
      minFilter: o.min ?? THREE.NearestFilter,
      magFilter: o.mag ?? THREE.NearestFilter,
      wrapS: o.wrapS ?? THREE.ClampToEdgeWrapping,
      wrapT: o.wrapT ?? THREE.ClampToEdgeWrapping,
      generateMipmaps: !!o.mips,
      depthBuffer: false,
      stencilBuffer: false,
      count: o.count ?? 1,
    });
    if (o.count > 1) for (const t of rt.textures) {
      t.type = o.type ?? THREE.FloatType; t.minFilter = t.magFilter = THREE.NearestFilter; t.generateMipmaps = false;
    }
    if (o.aniso) rt.texture.anisotropy = o.aniso;
    return rt;
  }

  material(fs, uniforms = {}, defines = {}) {
    return new THREE.RawShaderMaterial({
      glslVersion: THREE.GLSL3, vertexShader: VS, fragmentShader: fs, uniforms, defines,
      depthTest: false, depthWrite: false,
    });
  }

  run(material, target) {
    this.quad.material = material;
    const prev = this.r.getRenderTarget();
    this.r.setRenderTarget(target);
    this.r.render(this.scene, this.cam);
    this.r.setRenderTarget(prev);
  }
}
