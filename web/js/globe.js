/* ============================================================
   CRYPTO AGENT X — AGENT CORE (three.js)
   輝く球体 + ネットワークノード + 軌道リング + データストリーム
   ============================================================ */
(function () {
  const canvas = document.getElementById('globe');
  if (!canvas || !window.THREE) return;

  const scene = new THREE.Scene();
  const host = canvas.parentElement;
  let W = host.clientWidth, H = host.clientHeight;

  const camera = new THREE.PerspectiveCamera(45, W / H, 0.1, 100);
  camera.position.set(0, 0, 7.2);

  const renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(W, H);

  const world = new THREE.Group();
  scene.add(world);

  const CYAN = 0x22d3ee, BLUE = 0x3b82f6, PURPLE = 0x8b5cf6;
  const R = 2.05; // globe radius

  /* ---- inner glowing core sphere ---- */
  const core = new THREE.Mesh(
    new THREE.SphereGeometry(R * 0.62, 32, 32),
    new THREE.MeshBasicMaterial({ color: BLUE, transparent: true, opacity: 0.10 })
  );
  world.add(core);

  const coreGlow = new THREE.Mesh(
    new THREE.SphereGeometry(R * 0.42, 24, 24),
    new THREE.MeshBasicMaterial({ color: CYAN, transparent: true, opacity: 0.22 })
  );
  world.add(coreGlow);

  /* ---- wireframe latitude/longitude sphere ---- */
  const wire = new THREE.Mesh(
    new THREE.SphereGeometry(R, 30, 22),
    new THREE.MeshBasicMaterial({ color: BLUE, wireframe: true, transparent: true, opacity: 0.14 })
  );
  world.add(wire);

  /* ---- surface nodes (points on the sphere) ---- */
  const NODE_N = 220;
  const nodePos = [];
  const nodeVecs = [];
  for (let i = 0; i < NODE_N; i++) {
    // fibonacci sphere for even distribution
    const y = 1 - (i / (NODE_N - 1)) * 2;
    const rad = Math.sqrt(1 - y * y);
    const theta = i * 2.399963; // golden angle
    const v = new THREE.Vector3(Math.cos(theta) * rad, y, Math.sin(theta) * rad).multiplyScalar(R);
    nodeVecs.push(v);
    nodePos.push(v.x, v.y, v.z);
  }
  const pGeo = new THREE.BufferGeometry();
  pGeo.setAttribute('position', new THREE.Float32BufferAttribute(nodePos, 3));
  const sprite = makeDot();
  const points = new THREE.Points(
    pGeo,
    new THREE.PointsMaterial({ color: CYAN, size: 0.13, map: sprite, transparent: true,
      opacity: 0.95, depthWrite: false, blending: THREE.AdditiveBlending })
  );
  world.add(points);

  /* ---- connecting network lines between near nodes ---- */
  const linePos = [];
  for (let i = 0; i < NODE_N; i++) {
    for (let j = i + 1; j < NODE_N; j++) {
      if (nodeVecs[i].distanceTo(nodeVecs[j]) < 0.62 && Math.random() < 0.5) {
        linePos.push(nodeVecs[i].x, nodeVecs[i].y, nodeVecs[i].z);
        linePos.push(nodeVecs[j].x, nodeVecs[j].y, nodeVecs[j].z);
      }
    }
  }
  const lGeo = new THREE.BufferGeometry();
  lGeo.setAttribute('position', new THREE.Float32BufferAttribute(linePos, 3));
  const netLines = new THREE.LineSegments(
    lGeo,
    new THREE.LineBasicMaterial({ color: CYAN, transparent: true, opacity: 0.16,
      blending: THREE.AdditiveBlending })
  );
  world.add(netLines);

  /* ---- orbital rings (tilted torus) ---- */
  const rings = [];
  function addRing(radius, tiltX, tiltY, color, op) {
    const ring = new THREE.Mesh(
      new THREE.TorusGeometry(radius, 0.012, 8, 120),
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity: op })
    );
    ring.rotation.x = tiltX; ring.rotation.y = tiltY;
    world.add(ring); rings.push(ring); return ring;
  }
  addRing(R * 1.35, Math.PI / 2.2, 0.3, BLUE, 0.5);
  addRing(R * 1.62, Math.PI / 1.7, -0.5, PURPLE, 0.4);
  addRing(R * 1.5, Math.PI / 2.6, 0.9, CYAN, 0.35);

  /* ---- orbiting satellites travelling on the rings ---- */
  const sats = [];
  function addSat(radius, tiltX, tiltY, speed, color) {
    const m = new THREE.Mesh(
      new THREE.SphereGeometry(0.055, 12, 12),
      new THREE.MeshBasicMaterial({ color })
    );
    world.add(m);
    sats.push({ m, radius, tiltX, tiltY, speed, ang: Math.random() * 6.28 });
  }
  addSat(R * 1.35, Math.PI / 2.2, 0.3, 0.55, CYAN);
  addSat(R * 1.62, Math.PI / 1.7, -0.5, -0.4, PURPLE);
  addSat(R * 1.5, Math.PI / 2.6, 0.9, 0.7, BLUE);

  /* ---- floating outer particles (data cloud) ---- */
  const cloudN = 90, cloudPos = [];
  for (let i = 0; i < cloudN; i++) {
    const r = R * (1.7 + Math.random() * 1.4), t = Math.random() * 6.28, p = Math.acos(2 * Math.random() - 1);
    cloudPos.push(r * Math.sin(p) * Math.cos(t), r * Math.sin(p) * Math.sin(t), r * Math.cos(p));
  }
  const cGeo = new THREE.BufferGeometry();
  cGeo.setAttribute('position', new THREE.Float32BufferAttribute(cloudPos, 3));
  const cloud = new THREE.Points(cGeo,
    new THREE.PointsMaterial({ color: BLUE, size: 0.06, map: sprite, transparent: true,
      opacity: 0.5, depthWrite: false, blending: THREE.AdditiveBlending }));
  scene.add(cloud);

  /* ---- helpers ---- */
  function makeDot() {
    const c = document.createElement('canvas'); c.width = c.height = 64;
    const g = c.getContext('2d');
    const grd = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    grd.addColorStop(0, 'rgba(255,255,255,1)');
    grd.addColorStop(0.25, 'rgba(120,230,255,1)');
    grd.addColorStop(1, 'rgba(120,230,255,0)');
    g.fillStyle = grd; g.beginPath(); g.arc(32, 32, 32, 0, 6.28); g.fill();
    const tex = new THREE.CanvasTexture(c); return tex;
  }

  /* ---- interaction: subtle parallax on mouse ---- */
  let targX = 0, targY = 0;
  host.addEventListener('mousemove', (e) => {
    const r = host.getBoundingClientRect();
    targX = ((e.clientX - r.left) / r.width - 0.5) * 0.5;
    targY = ((e.clientY - r.top) / r.height - 0.5) * 0.5;
  });
  host.addEventListener('mouseleave', () => { targX = targY = 0; });

  /* ---- animate ---- */
  let t = 0;
  function animate() {
    requestAnimationFrame(animate);
    t += 0.008;
    world.rotation.y += 0.0026;
    world.rotation.x += (targY * 0.4 - world.rotation.x) * 0.05;
    world.rotation.y += (targX * 0.02);
    core.material.opacity = 0.08 + Math.sin(t * 2) * 0.04;
    coreGlow.scale.setScalar(1 + Math.sin(t * 2.2) * 0.06);
    points.material.opacity = 0.7 + Math.sin(t * 3) * 0.25;
    cloud.rotation.y -= 0.0009;

    sats.forEach(s => {
      s.ang += s.speed * 0.012;
      const x = Math.cos(s.ang) * s.radius, z = Math.sin(s.ang) * s.radius;
      const v = new THREE.Vector3(x, 0, z);
      v.applyEuler(new THREE.Euler(s.tiltX, s.tiltY, 0));
      s.m.position.copy(v);
    });
    renderer.render(scene, camera);
  }
  animate();

  /* ---- resize ---- */
  window.addEventListener('resize', () => {
    W = host.clientWidth; H = host.clientHeight;
    camera.aspect = W / H; camera.updateProjectionMatrix();
    renderer.setSize(W, H);
  });
})();
