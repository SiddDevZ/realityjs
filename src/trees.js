import * as THREE from 'three';

// jeffrey pines from photographed cutouts: each is a camera-facing card around its trunk axis, lit by the
// photo's own sunlight (from the left, like ours), rescaled to the scene's radiance and edge-antialiased
export function buildTrees(scene, spots, maps, sunE) {
  const lum = sunE.x * 0.2126 + sunE.y * 0.7152 + sunE.z * 0.0722;
  const cards = [];
  for (const s of spots) {
    const map = maps[s.k];
    const aspect = map.image ? map.image.width / map.image.height : 0.5;
    const mat = new THREE.ShaderMaterial({
      uniforms: { uMap: { value: map }, uGain: { value: lum * 0.25 } },
      transparent: false, alphaToCoverage: true, side: THREE.DoubleSide,
      vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix*modelViewMatrix*vec4(position, 1.0); }`,
      fragmentShader: `uniform sampler2D uMap; uniform float uGain; varying vec2 vUv;
        void main(){
          vec4 t = texture2D(uMap, vUv);
          if(t.a < 0.08) discard;
          // photo sRGB -> linear radiance; a touch cooler in the shade like the rest of the scene
          vec3 c = pow(t.rgb, vec3(2.2))*uGain;
          // tame the photo's saturated orange trunk toward weathered cinnamon grey
          float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
          c = mix(vec3(l), c, 0.8);
          c *= mix(vec3(0.9, 0.95, 1.08), vec3(1.0), smoothstep(0.05, 0.35, dot(t.rgb, vec3(0.333))));
          gl_FragColor = vec4(c, smoothstep(0.08, 0.6, t.a));
        }`,
    });
    const geo = new THREE.PlaneGeometry(1, 1).translate(0, 0.5, 0);
    const m = new THREE.Mesh(geo, mat);
    m.userData = { s, mat };
    m.position.set(s.x, s.y - 0.6, -s.d);
    m.scale.set(s.h * 0.5, s.h, 1);
    // fix the width once the image has loaded
    const fit = () => { const a = map.image.width / map.image.height; m.scale.set(s.h * a, s.h, 1); };
    if (map.image) fit(); else map.onUpdate = fit;
    scene.add(m);
    cards.push(m);
  }
  return {
    update(camera) {
      for (const m of cards) {
        const dx = camera.position.x - m.position.x, dz = camera.position.z - m.position.z;
        m.rotation.set(0, Math.atan2(dx, dz), 0);
      }
    },
  };
}
