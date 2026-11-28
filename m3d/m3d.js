/* 3D muscle viewer engine (three.js r147). Data: anat.json + anat.bin (BodyParts3D, CC BY 4.0).
   One SkinnedMesh per muscle part, all sharing one 14-segment rig, so joint animations move bones and stretch muscles. */
(function(){
const T = window.THREE;
const M3D = window.M3D = {ready:false, onPick:null, onLength:null, onFrame:null};
let renderer, scene, camera, controls, skeleton, segBones = [], meta, root;
let muscles = [], boneMesh, skinMesh, canvas, box;
let others = 'ghost', hl = {sel:[], ag:[], sy:[]};
let anim = null, mode = 'con', speed = 1, paused = false, t0 = 0, phase = 0;
let lenTarget = null, restLen = 0;
const COL = {muscle:0xc96a62, sel:0xa25ee0, ag:0xe0446e, sy:0xf0a04b, bone:0xece4d2, tendon:0xe9dfc7};
const mats = {};
function mat(name, color, opts){
  const m = new T.MeshStandardMaterial(Object.assign({color, roughness:.62, metalness:0}, opts||{}));
  mats[name] = m; return m;
}

M3D.init = async function(base){
  if (M3D._init) return M3D._init;
  M3D._init = (async () => {
    const [mj, bin] = await Promise.all([
      fetch(base + 'anat.json').then(r => r.json()),
      fetch(base + 'anat.txt').then(r => r.text()).then(t => { const s = atob(t.trim()), u = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i); return u.buffer; })
    ]);
    meta = mj; build(bin); M3D.ready = true;
  })();
  return M3D._init;
};

function build(bin){
  canvas = document.createElement('canvas'); canvas.className = 'm3dcanvas';
  renderer = new T.WebGLRenderer({canvas, antialias:true, alpha:false, powerPreference:'high-performance'});
  renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
  renderer.outputEncoding = T.sRGBEncoding; if (T.ColorManagement) T.ColorManagement.legacyMode = false;
  scene = new T.Scene(); scene.background = new T.Color(0x171b20);
  camera = new T.PerspectiveCamera(32, 1, 0.02, 20);
  camera.position.set(0, 1.05, 3.1);
  controls = new T.OrbitControls(camera, canvas);
  controls.target.set(0, 0.95, 0); controls.enableDamping = true; controls.dampingFactor = .12;
  controls.minDistance = .25; controls.maxDistance = 5; controls.rotateSpeed = .8;
  scene.add(new T.HemisphereLight(0xffffff, 0x3a3f46, .85));
  const head = new T.DirectionalLight(0xffffff, .95); head.position.set(.3, .4, 1); camera.add(head); scene.add(camera);
  const rim = new T.DirectionalLight(0xbcd4ff, .35); rim.position.set(-1, 2, -2); scene.add(rim);

  // rig
  const piv = meta.pivot.map(p => new T.Vector3(...p));
  segBones = meta.segs.map((s, i) => { const b = new T.Bone(); b.name = s; return b; });
  meta.parent.forEach((p, i) => {
    const b = segBones[i];
    if (p < 0) { b.position.copy(piv[i]); }
    else { b.position.copy(piv[i]).sub(piv[p]); segBones[p].add(b); }
  });
  root = segBones[meta.parent.indexOf(-1)];
  const holder = new T.Group(); holder.add(root); scene.add(holder);
  holder.updateMatrixWorld(true);
  skeleton = new T.Skeleton(segBones);
  segBones.forEach(b => b.userData.rest = {p:b.position.clone()});

  const lo = meta.lo, sc = meta.scale;
  const geomOf = (pt) => {
    const q = new Uint16Array(bin, pt.p, pt.vc * 3), pos = new Float32Array(pt.vc * 3);
    for (let i = 0; i < pt.vc; i++) for (let a = 0; a < 3; a++) pos[i*3+a] = lo[a] + q[i*3+a] * sc[a];
    const sw = new Uint8Array(bin, pt.s, pt.vc * 4);
    const si = new Uint16Array(pt.vc * 4), ww = new Float32Array(pt.vc * 4);
    for (let i = 0; i < pt.vc; i++) { si[i*4] = sw[i*4]; si[i*4+1] = sw[i*4+1]; const w = sw[i*4+2] / 255; ww[i*4] = w; ww[i*4+1] = 1 - w; }
    const g = new T.BufferGeometry();
    g.setAttribute('position', new T.BufferAttribute(pos, 3));
    g.setAttribute('skinIndex', new T.Uint16BufferAttribute(si, 4));
    g.setAttribute('skinWeight', new T.BufferAttribute(ww, 4));
    g.setIndex(new T.BufferAttribute(new Uint16Array(bin, pt.i, pt.ic).slice(), 1));
    g.computeVertexNormals();
    return g;
  };
  mat('bone', COL.bone, {roughness:.75});
  mat('boneGhost', COL.bone, {roughness:.75, transparent:true, opacity:.28, depthWrite:false});
  mat('skin', 0xdfe6ee, {transparent:true, opacity:.06, depthWrite:false, side:T.FrontSide, roughness:.4});
  const boneGeoms = [];
  for (const pt of meta.parts) {
    const g = geomOf(pt);
    if (pt.k === 'bone') { boneGeoms.push(g); continue; }
    if (pt.k === 'skin') { skinMesh = skinned(g, mats.skin); skinMesh.renderOrder = 5; continue; }
    const m = new T.MeshStandardMaterial({color: pt.k === 'tendon' ? COL.tendon : COL.muscle, roughness:.55, transparent:true, opacity:1, side: pt.ax ? T.DoubleSide : T.FrontSide, polygonOffset: !!pt.ax, polygonOffsetFactor: -2, polygonOffsetUnits: -4});
    if (pt.k === 'muscle') { fiberAttr(g, pt.key, pt.sd); fiberShader(m); }
    const mesh = skinned(g, m);
    mesh.userData = {key: pt.key, side: pt.sd, name: pt.n, approx: !!pt.ax, kind: pt.k};
    muscles.push(mesh);
  }
  boneMesh = skinned(mergeGeoms(boneGeoms), mats.bone);
  boneMesh.renderOrder = 0;
  for (const m of muscles) m.geometry.computeBoundingSphere();
  applyLook();
  setupPick();
  const loop = (ts) => { requestAnimationFrame(loop); frame(ts); };
  requestAnimationFrame(loop);
}
function skinned(g, m){
  const s = new T.SkinnedMesh(g, m); s.frustumCulled = false;
  s.bind(skeleton, new T.Matrix4()); scene.add(s); return s;
}
function mergeGeoms(gs){
  let nv = 0, ni = 0; for (const g of gs) { nv += g.attributes.position.count; ni += g.index.count; }
  const pos = new Float32Array(nv*3), nor = new Float32Array(nv*3), si = new Uint16Array(nv*4), sw = new Float32Array(nv*4), idx = new Uint32Array(ni);
  let ov = 0, oi = 0;
  for (const g of gs) {
    const c = g.attributes.position.count;
    pos.set(g.attributes.position.array, ov*3); nor.set(g.attributes.normal.array, ov*3);
    si.set(g.attributes.skinIndex.array, ov*4); sw.set(g.attributes.skinWeight.array, ov*4);
    const ix = g.index.array; for (let i = 0; i < ix.length; i++) idx[oi+i] = ix[i] + ov;
    ov += c; oi += ix.length; g.dispose();
  }
  const g = new T.BufferGeometry();
  g.setAttribute('position', new T.BufferAttribute(pos, 3)); g.setAttribute('normal', new T.BufferAttribute(nor, 3));
  g.setAttribute('skinIndex', new T.Uint16BufferAttribute(si, 4)); g.setAttribute('skinWeight', new T.BufferAttribute(sw, 4));
  g.setIndex(new T.BufferAttribute(idx, 1)); return g;
}


/* ---------- fiber directions ----------
   axis: along the muscle's long axis (parallel/fusiform); fan: toward the insertion point (convergent);
   cyl: trunk wall, given as [toward-midline, up] in the wall's own surface frame; dir: fixed direction.
   Points/directions are for the RIGHT side (x<0); the left side is mirrored. */
const FIB = {
  pecMajUp:{t:'fan',p:[-0.165,1.335,0.01]}, pecMajLow:{t:'fan',p:[-0.165,1.33,0.01]},
  deltAnt:{t:'fan',p:[-0.212,1.265,0.0]}, deltMid:{t:'fan',p:[-0.214,1.265,-0.01]}, deltPost:{t:'fan',p:[-0.212,1.265,-0.02]},
  lat:{t:'fan',p:[-0.165,1.33,0.0]}, trapUp:{t:'fan',p:[-0.15,1.43,-0.03]}, trapMid:{t:'fan',p:[-0.14,1.42,-0.06]}, trapLow:{t:'fan',p:[-0.09,1.37,-0.09]},
  pecMin:{t:'fan',p:[-0.12,1.39,0.025]}, infraspinatus:{t:'fan',p:[-0.18,1.39,-0.03]}, subscapularis:{t:'fan',p:[-0.155,1.37,0.01]},
  serratus:{t:'fan',p:[-0.075,1.31,-0.09]}, gluteMed:{t:'fan',p:[-0.14,0.89,-0.03]}, gluteMin:{t:'fan',p:[-0.14,0.89,-0.025]},
  rhomboids:{t:'dir',d:[-0.75,-0.62,-0.1]},
  extObl:{t:'cyl',d:[0.6,-0.8]}, intObl:{t:'cyl',d:[0.6,0.8]}, transversus:{t:'cyl',d:[1,0]}, rectusAb:{t:'dir',d:[0,1,0]}, ql:{t:'dir',d:[0.15,1,0]}
};
function fiberAttr(g, key, side){
  const pos = g.attributes.position, n = pos.count, out = new Float32Array(n * 3);
  const cfg = FIB[key] || {t:'axis'}, mir = side === 'L' ? -1 : 1, v = new T.Vector3(), d = new T.Vector3();
  let axis = null;
  if (cfg.t === 'axis') { // principal axis by power iteration on the covariance
    const c = new T.Vector3(); for (let i = 0; i < n; i++) c.add(v.fromBufferAttribute(pos, i)); c.divideScalar(n);
    const C = [0,0,0,0,0,0]; // xx xy xz yy yz zz
    for (let i = 0; i < n; i++) { v.fromBufferAttribute(pos, i).sub(c); C[0]+=v.x*v.x; C[1]+=v.x*v.y; C[2]+=v.x*v.z; C[3]+=v.y*v.y; C[4]+=v.y*v.z; C[5]+=v.z*v.z; }
    axis = new T.Vector3(0.1, 1, 0.1);
    for (let k = 0; k < 30; k++) axis.set(C[0]*axis.x+C[1]*axis.y+C[2]*axis.z, C[1]*axis.x+C[3]*axis.y+C[4]*axis.z, C[2]*axis.x+C[4]*axis.y+C[5]*axis.z).normalize();
  }
  const P = cfg.p ? new T.Vector3(cfg.p[0] * mir, cfg.p[1], cfg.p[2]) : null, up = new T.Vector3(0, 1, 0);
  for (let i = 0; i < n; i++) {
    v.fromBufferAttribute(pos, i);
    if (axis) d.copy(axis);
    else if (cfg.t === 'fan') d.copy(P).sub(v);
    else if (cfg.t === 'dir') d.set(cfg.d[0] * mir, cfg.d[1], cfg.d[2]);
    else { // cyl: tangent around the trunk axis, pointing toward the front midline
      const r = new T.Vector3(v.x * mir, 0, v.z + 0.01).normalize();
      const t = new T.Vector3().crossVectors(up, r); // for the right side: toward anterior / medial
      d.copy(t).multiplyScalar(cfg.d[0]).addScaledVector(up, cfg.d[1]); d.x *= mir;
    }
    d.normalize(); out[i*3] = d.x; out[i*3+1] = d.y; out[i*3+2] = d.z;
  }
  g.setAttribute('fib', new T.BufferAttribute(out, 3));
}
const fibU = {value: 1};
function fiberShader(m){
  m.onBeforeCompile = sh => {
    sh.uniforms.uFib = fibU;
    sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nattribute vec3 fib;\nvarying vec3 vFib;\nvarying vec3 vRest;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvFib = fib; vRest = position;');
    sh.fragmentShader = sh.fragmentShader.replace('#include <common>', `#include <common>
uniform float uFib; varying vec3 vFib; varying vec3 vRest;
float h3(vec3 p){ return fract(sin(dot(p, vec3(127.1, 311.7, 74.7))) * 43758.5453); }
float vn(vec3 p){ vec3 i = floor(p), f = fract(p); f = f*f*(3.0-2.0*f);
  return mix(mix(mix(h3(i), h3(i+vec3(1,0,0)), f.x), mix(h3(i+vec3(0,1,0)), h3(i+vec3(1,1,0)), f.x), f.y),
             mix(mix(h3(i+vec3(0,0,1)), h3(i+vec3(1,0,1)), f.x), mix(h3(i+vec3(0,1,1)), h3(i+vec3(1,1,1)), f.x), f.y), f.z); }`)
      .replace('#include <color_fragment>', `#include <color_fragment>
if (uFib > 0.5) { vec3 f = normalize(vFib); vec3 q = vRest - f * dot(vRest, f);
  float s = vn(q * 115.0) * 0.75 + vn(q * 330.0) * 0.25;
  float line = smoothstep(0.56, 0.7, s);
  diffuseColor.rgb *= mix(1.0, 0.55, line); diffuseColor.rgb += vec3(0.06) * smoothstep(0.3, 0.15, s); }`);
  };
  m.customProgramCacheKey = () => 'fib1';
}
M3D.setFibers = function(on){ fibU.value = on ? 1 : 0; };

/* ---------- layers: 1 superficial, 2 middle, 3 deep ---------- */
const LAYER = {pecMin:2, serratus:2, rhomboids:2, levator:2, supraspinatus:2, infraspinatus:2, teresMin:2, teresMaj:2, coracobrachialis:2, brachialis:2,
  intObl:2, erector:2, gluteMed:2, soleus:2,
  subscapularis:3, transversus:3, ql:3, gluteMin:3, piriformis:3, iliopsoas:3};
const layerOf = m => LAYER[m.userData.key] || 1;
let peel = 1;
M3D.setPeel = function(n){ peel = n; if (M3D.ready) applyLook(); };
M3D.layerOf = key => LAYER[key] || 1;

/* ---------- look ---------- */
const keyIn = (list, m) => list.some(h => h.key === m.userData.key && (h.side === 'B' || h.side === m.userData.side || m.userData.side === 'C'));
function roleOf(m){
  if (keyIn(hl.sel, m)) return 'sel';
  if (keyIn(hl.ag, m)) return 'ag';
  if (keyIn(hl.sy, m)) return 'sy';
  return '';
}
function applyLook(){
  const any = hl.sel.length || hl.ag.length || hl.sy.length;
  // the deepest selected muscle: everything above it turns see-through so it can be seen
  let selDepth = 0; for (const m of muscles) if (keyIn(hl.sel, m)) selDepth = Math.max(selDepth, layerOf(m));
  for (const m of muscles) {
    const r = roleOf(m), mt = m.material;
    if (!r && layerOf(m) < peel) { m.visible = false; m.userData.role = ''; continue; }
    if (!r && others === 'full' && layerOf(m) < selDepth) { m.visible = true; m.userData.role = ''; mt.color.setHex(COL.muscle); mt.transparent = true; mt.opacity = .14; mt.depthWrite = false; m.renderOrder = 3; mt.emissive.setHex(0); mt.needsUpdate = true; continue; }
    m.userData.role = r;
    if (r) {
      mt.color.setHex(COL[r]); m.visible = true;
      // with a selected muscle, agonists/synergists turn see-through so the selected one is never hidden behind them
      if (r !== 'sel' && hl.sel.length) { mt.transparent = true; mt.opacity = .42; mt.depthWrite = false; m.renderOrder = 4; }
      else { mt.opacity = 1; mt.transparent = false; mt.depthWrite = true; m.renderOrder = 2; }
    } else {
      mt.color.setHex(m.userData.kind === 'tendon' ? COL.tendon : COL.muscle);
      const ghost = others === 'ghost' || (others === 'full' && false);
      if (others === 'hidden') { m.visible = false; }
      else if (others === 'ghost' || (any && others === 'full' && false)) { m.visible = true; mt.transparent = true; mt.opacity = any ? .14 : .32; mt.depthWrite = false; m.renderOrder = 3; }
      else { m.visible = true; mt.transparent = false; mt.opacity = 1; mt.depthWrite = true; m.renderOrder = 1; }
    }
    mt.emissive && mt.emissive.setHex(0x000000);
    mt.needsUpdate = true;
  }
}
M3D.setHighlight = function(h){ hl = {sel:h.sel||[], ag:h.ag||[], sy:h.sy||[]}; if (M3D.ready) applyLook(); };
M3D.setOthers = function(v){ others = v; if (M3D.ready) applyLook(); };
M3D.setBones = function(v){ if (!M3D.ready) return; boneMesh.material = v === 'ghost' ? mats.boneGhost : mats.bone; boneMesh.visible = v !== 'hidden'; };
M3D.setSkin = function(on){ if (M3D.ready) skinMesh.visible = !!on; };

/* ---------- attach / size ---------- */
let ro = null;
M3D.attach = function(el){
  box = el; el.prepend(canvas);
  if (ro) ro.disconnect();
  ro = new ResizeObserver(resize); ro.observe(el); resize();
};
function resize(){
  if (!box) return; const w = box.clientWidth, h = box.clientHeight; if (!w || !h) return;
  renderer.setSize(w, h, false); camera.aspect = w / h; camera.updateProjectionMatrix();
}

/* ---------- camera focus ---------- */
let fly = null;
function flyTo(target, dist, dir){
  const d = dir || camera.position.clone().sub(controls.target).normalize();
  fly = {t0: performance.now(), fromT: controls.target.clone(), toT: target.clone(), fromP: camera.position.clone(), toP: target.clone().add(d.multiplyScalar(dist))};
}
M3D.resetView = function(dir){
  const d = dir === 'back' ? new T.Vector3(0, .05, -1) : dir === 'side' ? new T.Vector3(-1, .05, 0) : dir === 'sideL' ? new T.Vector3(1, .05, 0) : new T.Vector3(0, .05, 1);
  flyTo(new T.Vector3(0, .95, 0), 3.1, d.normalize());
};
M3D.focus = function(list, minD, viewList){
  const bb = new T.Box3(), v = new T.Vector3(); let n = 0;
  for (const m of muscles) if (keyIn(list, m)) { m.updateMatrixWorld(); const s = m.geometry.boundingSphere; bb.expandByPoint(s.center.clone().addScalar(s.radius)); bb.expandByPoint(s.center.clone().subScalar(s.radius)); n++; }
  if (!n) return; bb.getCenter(v); const size = bb.getSize(new T.Vector3()).length();
  // which side to look from: the selected muscle (viewList) wins over the rest
  const vc = v.clone();
  if (viewList && viewList.length) { const b2 = new T.Box3(); for (const m of muscles) if (keyIn(viewList, m)) { const s = m.geometry.boundingSphere; b2.expandByPoint(s.center.clone().addScalar(s.radius)); b2.expandByPoint(s.center.clone().subScalar(s.radius)); } if (!b2.isEmpty()) b2.getCenter(vc); }
  // look from the side where the muscle is: back muscles from behind
  const dir = camera.position.clone().sub(controls.target).normalize();
  const backish = vc.z < -0.035, frontish = vc.z > 0.0;
  if (backish && dir.z > 0) dir.set(dir.x * .5, .08, -1);
  if (frontish && dir.z < 0) dir.set(dir.x * .5, .08, 1);
  flyTo(v, Math.min(3.1, Math.max(minD || .55, size * 2.1)), dir.normalize());
};

/* ---------- picking ---------- */
function setupPick(){
  const ray = new T.Raycaster(); let down = null;
  canvas.addEventListener('pointerdown', e => { down = {x:e.clientX, y:e.clientY, t:performance.now()}; });
  canvas.addEventListener('pointerup', e => {
    if (!down) return; const dx = e.clientX - down.x, dy = e.clientY - down.y; const quick = performance.now() - down.t < 450; down = null;
    if (dx*dx + dy*dy > 64 || !quick) return;
    const r = canvas.getBoundingClientRect();
    const p = new T.Vector2((e.clientX - r.left) / r.width * 2 - 1, -(e.clientY - r.top) / r.height * 2 + 1);
    ray.setFromCamera(p, camera);
    const cands = muscles.filter(m => m.visible && m.userData.kind === 'muscle');
    // skinned raycast in r147 uses the posed vertices
    let best = null;
    for (const m of cands) { const h = ray.intersectObject(m, false)[0]; if (h && (!best || h.distance < best.d)) best = {d:h.distance, m, op: m.material.opacity}; }
    // prefer an opaque (highlighted) hit when a ghosted one is just in front
    if (best && M3D.onPick) M3D.onPick(best.m.userData.key, best.m.userData.side);
  });
}

/* ---------- animation ---------- */
const AX = {x:new T.Vector3(1,0,0), y:new T.Vector3(0,1,0), z:new T.Vector3(0,0,1)};
function poseAt(spec, side, t){
  // spec: {segs:{humS:[['x',a0,a1],...], ...}}; S -> R/L; left side mirrors y/z rotations and x translations
  segBones.forEach(b => { b.quaternion.identity(); b.position.copy(b.userData.rest.p); });
  if (!spec) return;
  for (const k in spec.segs) {
    const isSided = k.endsWith('S'); const sides = isSided ? (side === 'B' ? ['R','L'] : [side]) : [null];
    for (const sd of sides) {
      const name = isSided ? k.slice(0, -1) + sd : k; const bi = meta.segs.indexOf(name); if (bi < 0) continue;
      const b = segBones[bi]; const mir = sd === 'L' && !spec.noMirror;
      const q = new T.Quaternion();
      for (const st of spec.segs[k]) {
        if (st[0] === 't') { const a = st[1], c = st[2]; const v = [0,1,2].map(i => a[i] + (c[i]-a[i]) * t); if (mir) v[0] = -v[0]; b.position.add(new T.Vector3(...v)); continue; }
        let ang = (st[1] + (st[2] - st[1]) * t) * Math.PI / 180; if (mir && st[0] !== 'x') ang = -ang;
        q.premultiply(new T.Quaternion().setFromAxisAngle(AX[st[0]], ang));
      }
      // fixed (parent) axes: convert to local by conjugating with parent's accumulated rotation is not needed
      // because rest orientation of every segment is identity.
      b.quaternion.copy(q);
    }
  }
}
M3D.play = function(spec, side, m){ anim = spec ? {spec, side} : null; if (m) mode = m; t0 = performance.now(); phase = 0; paused = false; if (!spec) poseAt(null); };
M3D.setMode = function(m){ mode = m; t0 = performance.now(); };
M3D.setSpeed = function(s){ speed = s; };
M3D.setPaused = function(p){ paused = p; if (!p) t0 = performance.now() - phase * cycleMs(); };
M3D.isPaused = () => paused;
const cycleMs = () => 3600 / speed;
let lastT = 0;
function animT(now){
  if (!anim) return 0;
  if (!paused) phase = ((now - t0) / cycleMs()) % 1;
  const p = phase;
  // movement 0..0.45, hold 0.45..0.6, return 0.6..0.95, rest
  const ease = x => x < 0 ? 0 : x > 1 ? 1 : x * x * (3 - 2 * x);
  if (mode === 'iso') return 0.5;
  if (mode === 'con') return p < .5 ? ease(p / .5) : p < .62 ? 1 : ease(1 - (p - .62) / .3);
  // eccentric: slow controlled return from the end position
  return p < .12 ? 1 : p < .82 ? 1 - ease((p - .12) / .7) : ease((p - .82) / .18);
}
M3D.phaseInfo = function(){
  if (!anim) return null; const p = phase;
  if (mode === 'iso') return 'hold';
  if (mode === 'con') return p < .5 ? 'work' : p < .62 ? 'hold' : 'back';
  return p < .12 ? 'hold' : p < .82 ? 'work' : 'back';
};

/* ---------- muscle length ---------- */
M3D.setLengthTarget = function(list){
  lenTarget = null; if (!list || !list.length || !M3D.ready) return;
  const ms = muscles.filter(m => keyIn(list, m) && m.userData.kind === 'muscle'); if (!ms.length) return;
  // two far-apart vertices (along the main axis) of the biggest part
  const m = ms.reduce((a, b) => a.geometry.attributes.position.count > b.geometry.attributes.position.count ? a : b);
  const pos = m.geometry.attributes.position; const c = m.geometry.boundingSphere.center;
  let ia = 0, da = -1; const v = new T.Vector3();
  for (let i = 0; i < pos.count; i++) { v.fromBufferAttribute(pos, i); const d = v.distanceToSquared(c); if (d > da) { da = d; ia = i; } }
  const a = new T.Vector3().fromBufferAttribute(pos, ia); let ib = 0, db = -1;
  for (let i = 0; i < pos.count; i++) { v.fromBufferAttribute(pos, i); const d = v.distanceToSquared(a); if (d > db) { db = d; ib = i; } }
  lenTarget = {m, ia, ib}; restLen = Math.sqrt(db);
};
function curLen(){
  if (!lenTarget) return null; const {m, ia, ib} = lenTarget;
  const a = new T.Vector3().fromBufferAttribute(m.geometry.attributes.position, ia), b = new T.Vector3().fromBufferAttribute(m.geometry.attributes.position, ib);
  m.boneTransform(ia, a); m.boneTransform(ib, b); return a.distanceTo(b) / restLen;
}

function frame(now){
  if (!canvas.isConnected) return;
  if (fly) {
    const k = Math.min(1, (now - fly.t0) / 650), e = k * k * (3 - 2 * k);
    controls.target.lerpVectors(fly.fromT, fly.toT, e); camera.position.lerpVectors(fly.fromP, fly.toP, e);
    if (k >= 1) fly = null;
  }
  const t = animT(now);
  if (anim) poseAt(anim.spec, anim.side, t);
  // isometric: pulse the working muscles; concentric/eccentric: glow while working
  const ph = M3D.phaseInfo();
  const glow = !anim ? 0 : mode === 'iso' ? .25 + .25 * Math.sin(now / 160) : ph === 'work' ? .3 : .08;
  for (const m of muscles) if (m.userData.role === 'ag' || m.userData.role === 'sel') m.material.emissive.setRGB(glow * .55, glow * .1, glow * .3);
  controls.update();
  renderer.render(scene, camera);
  if (M3D.onLength) { const l = curLen(); M3D.onLength(l); }
  if (M3D.onFrame) M3D.onFrame(ph);
}
})();
