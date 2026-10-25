// dashboard/app.js — Semantic 3DGS viewer (real API only) — v2
/* global THREE, Chart */

'use strict';

// ─────────────────────────────────────────────
//  Three.js state
// ─────────────────────────────────────────────
let scene, camera, renderer, controls, pointsMesh = null;
let sceneData = null;   // {xyz, labels, confidence, label_names, mode}
let ablationChart = null;
const visibleObjects = new Set();
let minConfidence = 0.0;

// ─────────────────────────────────────────────
//  Colour palette (label colours)
// ─────────────────────────────────────────────
const PALETTE = [
  [56,  189, 248], // sky blue
  [52,  211, 153], // emerald
  [251, 191,  36], // amber
  [248, 113, 113], // red
  [167, 139, 250], // violet
  [251, 146,  60], // orange
  [34,  211, 238], // cyan
  [244, 114, 182], // pink
  [163, 230,  53], // lime
  [129, 140, 248], // indigo
  [250, 204,  21], // yellow
  [74,  222, 128], // green
];
const UNKNOWN_COLOR = [90, 100, 120];

// ─────────────────────────────────────────────
//  Utilities
// ─────────────────────────────────────────────
const $ = (id) => document.getElementById(id);

function labelColor(label) {
  if (label < 0) return UNKNOWN_COLOR;
  return PALETTE[label % PALETTE.length];
}

function toast(msg, ok = false) {
  const el = $('toast');
  el.textContent = msg;
  el.className = ok ? 'ok' : '';
  el.hidden = false;
  clearTimeout(el._t);
  el._t = setTimeout(() => { el.hidden = true; }, 5000);
}

async function api(path, opts) {
  const res = await fetch(path, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

// ─────────────────────────────────────────────
//  Tab switching
// ─────────────────────────────────────────────
function initTabs() {
  const btns  = document.querySelectorAll('.tab-btn');
  const panels = document.querySelectorAll('.tab-panel');

  btns.forEach(btn => {
    btn.addEventListener('click', () => {
      const target = btn.dataset.tab;
      btns.forEach(b => b.classList.toggle('active', b === btn));
      panels.forEach(p => {
        p.classList.toggle('active', p.id === `tab-${target}`);
      });
      // Force Three.js resize whenever the viewer tab becomes visible
      if (target === 'viewer') {
        setTimeout(() => onResize(), 50);
      }
    });
  });
}

// ─────────────────────────────────────────────
//  Three.js — initialise
// ─────────────────────────────────────────────
function initThree() {
  const container = $('canvas-container');
  const w = container.clientWidth  || 800;
  const h = container.clientHeight || 600;

  // Scene
  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x060a14);
  scene.fog = new THREE.FogExp2(0x060a14, 0.018);

  // Camera
  camera = new THREE.PerspectiveCamera(60, w / h, 0.01, 1000);
  camera.position.set(0, 2, 6);

  // Renderer — high quality
  renderer = new THREE.WebGLRenderer({ antialias: true, logarithmicDepthBuffer: true });
  renderer.setSize(w, h);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.outputEncoding = THREE.sRGBEncoding;
  container.appendChild(renderer.domElement);

  // Orbit controls
  controls = new THREE.OrbitControls(camera, renderer.domElement);
  controls.enableDamping   = true;
  controls.dampingFactor   = 0.06;
  controls.screenSpacePanning = false;
  controls.minDistance     = 0.5;
  controls.maxDistance     = 200;
  controls.autoRotate      = false;

  // Grid — subtle
  const grid = new THREE.GridHelper(20, 40, 0x1a2035, 0x101520);
  grid.material.opacity = 0.6;
  grid.material.transparent = true;
  scene.add(grid);

  // Ambient + directional light (helps with normal rendering)
  scene.add(new THREE.AmbientLight(0xffffff, 1.2));
  const dir = new THREE.DirectionalLight(0x7dd3fc, 0.6);
  dir.position.set(5, 10, 5);
  scene.add(dir);

  // Axes helper (small, bottom of scene)
  const axes = new THREE.AxesHelper(0.5);
  axes.position.set(-9, 0, -9);
  scene.add(axes);

  // Resize
  window.addEventListener('resize', onResize);

  // Animate
  (function animate() {
    requestAnimationFrame(animate);
    controls.update();
    renderer.render(scene, camera);
  })();
}

function onResize() {
  const container = $('canvas-container');
  if (!container || !renderer) return;
  const w = container.clientWidth;
  const h = container.clientHeight;
  if (w === 0 || h === 0) return;
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  renderer.setSize(w, h);
}

// ─────────────────────────────────────────────
//  Three.js — point cloud
// ─────────────────────────────────────────────
function sceneCenter(xyz) {
  if (!xyz.length) return [0, 0, 0];
  const c = [0, 0, 0];
  for (const p of xyz) { c[0] += p[0]; c[1] += p[1]; c[2] += p[2]; }
  return c.map(v => v / xyz.length);
}

function sceneRadius(xyz, center) {
  if (!xyz.length) return 5;
  let maxD = 0;
  for (const p of xyz) {
    const d = Math.hypot(p[0]-center[0], p[1]-center[1], p[2]-center[2]);
    if (d > maxD) maxD = d;
  }
  return maxD || 5;
}

function updatePointCloud() {
  if (!sceneData) return;
  const { xyz, labels, confidence } = sceneData;

  // Remove old cloud
  if (pointsMesh) {
    scene.remove(pointsMesh);
    pointsMesh.geometry.dispose();
    pointsMesh.material.dispose();
    pointsMesh = null;
  }

  // Hide empty overlay once we have data
  const overlay = $('scene-overlay-empty');
  if (overlay) overlay.style.display = 'none';

  const positions = [], colors = [];
  let shown = 0;

  for (let i = 0; i < xyz.length; i++) {
    if (confidence[i] < minConfidence) continue;
    const lab = labels[i];
    if (visibleObjects.size > 0 && !visibleObjects.has(lab)) continue;
    positions.push(xyz[i][0], xyz[i][1], xyz[i][2]);
    const c = labelColor(lab);
    colors.push(c[0] / 255, c[1] / 255, c[2] / 255);
    shown++;
  }

  if (shown === 0) {
    $('stat-shown').textContent = '0';
    return;
  }

  // Dynamic point size based on cloud density
  const center = sceneCenter(xyz);
  const radius = sceneRadius(xyz, center);
  const pointSize = Math.max(0.008, Math.min(0.06, radius / 80));

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('color',    new THREE.Float32BufferAttribute(colors, 3));

  const mat = new THREE.PointsMaterial({
    size: pointSize,
    vertexColors: true,
    opacity: 0.95,
    transparent: true,
    sizeAttenuation: true,
  });

  pointsMesh = new THREE.Points(geo, mat);
  scene.add(pointsMesh);

  $('stat-shown').textContent = shown.toLocaleString();
}

// ─────────────────────────────────────────────
//  Camera framing
// ─────────────────────────────────────────────
function frameCamera(view) {
  if (!sceneData || !sceneData.xyz.length) return;
  const c = sceneCenter(sceneData.xyz);
  const r = sceneRadius(sceneData.xyz, c);

  controls.target.set(c[0], c[1], c[2]);

  if (view === 'top') {
    camera.position.set(c[0], c[1] + r * 1.8, c[2] + 0.001);
  } else if (view === 'side') {
    camera.position.set(c[0] + r * 1.8, c[1], c[2]);
  } else {
    // Orbit — nice 3/4 angle
    camera.position.set(c[0] + r * 0.9, c[1] + r * 0.6, c[2] + r * 1.4);
  }
  controls.update();

  // Highlight active button
  ['btn-view-orbit','btn-view-top','btn-view-side'].forEach(id => {
    const el = $(id);
    if (el) el.classList.remove('active');
  });
  const map = { orbit: 'btn-view-orbit', top: 'btn-view-top', side: 'btn-view-side' };
  if (map[view] && $(map[view])) $(map[view]).classList.add('active');
}

// ─────────────────────────────────────────────
//  Data rendering
// ─────────────────────────────────────────────
function renderScene(sd) {
  sceneData = sd;
  const names = sd.label_names || {};

  $('mode-line').textContent = sd.mode === 'single_image_2.5d'
    ? 'single-image 2.5D — real segmentation, plane-assumption depth'
    : 'multi-view 2D→3D label transfer on Gaussian Splats';

  $('badge-mode').textContent  = `mode: ${sd.mode}`;
  $('badge-mode').className    = 'badge ' + (sd.mode === 'single_image_2.5d' ? 'warn' : 'ok');

  const ids    = Object.keys(names).map(Number).sort((a, b) => a - b);
  const counts = {};
  for (const l of sd.labels) counts[l] = (counts[l] || 0) + 1;

  // ── 3D viewer sidebar list ──
  visibleObjects.clear();
  const list = $('object-list');
  list.innerHTML = '';
  for (const id of ids) {
    const li  = document.createElement('li');
    const dot = document.createElement('span');
    dot.className = 'dot';
    const c = labelColor(id);
    dot.style.background = `rgb(${c[0]},${c[1]},${c[2]})`;
    dot.style.boxShadow  = `0 0 6px rgb(${c[0]},${c[1]},${c[2]})`;

    const inp = document.createElement('input');
    inp.type  = 'text';
    inp.value = names[id];
    inp.title = 'Click to rename';
    inp.addEventListener('change', async () => {
      try {
        const r = await api('/api/labels/rename', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id, label: inp.value }),
        });
        sceneData = r.scene;
        toast('Renamed ✓', true);
      } catch (e) { toast(`Rename failed: ${e.message}`); inp.value = names[id]; }
    });

    const cnt = document.createElement('span');
    cnt.className   = 'count';
    cnt.textContent = (counts[id] || 0).toLocaleString();

    const chk = document.createElement('input');
    chk.type    = 'checkbox';
    chk.checked = true;
    chk.title   = 'Show / hide';
    chk.addEventListener('change', () => {
      if (chk.checked) visibleObjects.delete(id); else visibleObjects.add(id);
      updatePointCloud();
    });

    li.append(chk, dot, inp, cnt);
    list.appendChild(li);
  }

  // ── Segment tab object grid ──
  const grid = $('object-list-segment');
  const hint = $('obj-empty-hint');
  if (grid) {
    grid.innerHTML = '';
    if (ids.length === 0) {
      if (hint) hint.style.display = 'block';
    } else {
      if (hint) hint.style.display = 'none';
      for (const id of ids) {
        const li  = document.createElement('li');
        const dot = document.createElement('div');
        dot.className = 'dot';
        const c = labelColor(id);
        dot.style.background = `rgb(${c[0]},${c[1]},${c[2]})`;
        dot.style.boxShadow  = `0 0 10px rgb(${c[0]},${c[1]},${c[2]})`;

        const name = document.createElement('div');
        name.className   = 'obj-name';
        name.textContent = names[id];

        const pts = document.createElement('div');
        pts.className   = 'obj-pts';
        pts.textContent = `${(counts[id] || 0).toLocaleString()} pts`;

        li.append(dot, name, pts);
        grid.appendChild(li);
      }
    }
  }

  // Stats
  $('stat-points').textContent  = (sd.n_points || 0).toLocaleString();
  $('stat-objects').textContent = ids.length;

  updatePointCloud();
  frameCamera('orbit');
}

function renderMetrics(m) {
  // ── Ablation chart ──
  const ablation = m.ablation || [];
  const aLabels  = ablation.map(a => (a.name || a.strategy || '?').replace(/_/g, ' '));
  const aRates   = ablation.map(a => +(a.label_rate * 100).toFixed(1));

  if (ablationChart) ablationChart.destroy();
  ablationChart = new Chart($('ablation-chart'), {
    type: 'bar',
    data: {
      labels: aLabels,
      datasets: [{
        data: aRates,
        backgroundColor: [
          'rgba(56,189,248,0.6)',
          'rgba(129,140,248,0.6)',
          'rgba(52,211,153,0.7)',
        ],
        borderColor: [
          'rgba(56,189,248,1)',
          'rgba(129,140,248,1)',
          'rgba(52,211,153,1)',
        ],
        borderWidth: 1.5,
        borderRadius: 6,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      scales: {
        y: {
          beginAtZero: true,
          max: 100,
          ticks: { color: '#6b7a99', font: { size: 11 } },
          grid:  { color: 'rgba(255,255,255,0.04)' },
        },
        x: {
          ticks: { color: '#9aa3b5', font: { size: 11 } },
          grid:  { display: false },
        },
      },
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: '#161b28',
          borderColor: 'rgba(255,255,255,0.1)',
          borderWidth: 1,
          titleColor: '#e4e8f4',
          bodyColor: '#9aa3b5',
          callbacks: { label: ctx => ` ${ctx.parsed.y}% labeled` },
        },
      },
    },
  });

  // Ablation table
  const tbody = $('ablation-table').querySelector('tbody');
  tbody.innerHTML = '';
  ablation.forEach(a => {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td>${(a.name || a.strategy || '').replace(/_/g, ' ')}</td>
      <td class="num">${a.n_labeled}/${a.n_gaussians}</td>
      <td class="num">${(a.label_rate * 100).toFixed(1)}%</td>`;
    tbody.appendChild(tr);
  });

  // Evaluation table
  const evTbody = $('eval-table').querySelector('tbody');
  evTbody.innerHTML = '';
  const evaluation = m.evaluation || {};
  const evalObjs   = Object.keys(evaluation);
  if (!evalObjs.length) {
    evTbody.innerHTML = '<tr><td colspan="4" style="color:var(--muted);font-style:italic">No eval_results.json yet — annotate GT then run scripts/run_evaluation.py</td></tr>';
  } else {
    evalObjs.forEach(name => {
      const s  = evaluation[name];
      const tr = document.createElement('tr');
      tr.innerHTML = `<td>${name}</td>
        <td class="num">${(+s.mean_iou).toFixed(3)}</td>
        <td class="num">${(+s.mean_precision).toFixed(3)}</td>
        <td class="num">${(+s.mean_recall).toFixed(3)}</td>`;
      evTbody.appendChild(tr);
    });
  }

  // Run metrics
  const rm = m.run_metrics;
  $('metrics-pre').textContent = rm
    ? JSON.stringify(rm, null, 2)
    : (m.metadata && m.metadata.mode
        ? `mode: ${m.metadata.mode}\n(single-image run — no multi-view metrics)`
        : 'no run yet');
}

// ─────────────────────────────────────────────
//  Status / pipeline inputs
// ─────────────────────────────────────────────
function renderStatus(st) {
  const b = st.backends || {};
  $('badge-backend').textContent = `segmenter: ${b.sam2 ? 'SAM2' : 'classical (CPU)'}`;
  $('badge-backend').className   = 'badge ' + (b.sam2 ? 'ok' : '');

  if (!b.torch) {
    const opt = $('backend-select').querySelector('option[value="sam2"]');
    if (opt) { opt.disabled = true; opt.textContent = 'SAM2 (torch missing)'; }
  }

  // Pipeline input checklist
  const inp = st.inputs || {};
  function setCheck(elId, ok) {
    const el = $(elId);
    if (!el) return;
    el.classList.toggle('ok', ok);
    el.classList.toggle('err', !ok);
  }
  setCheck('ci-colmap',  inp.colmap_data);
  setCheck('ci-ply',     inp.trained_ply);
  setCheck('ci-masks',   inp.masks);
  setCheck('ci-outputs', inp.semantic_outputs);
}

// ─────────────────────────────────────────────
//  Full refresh
// ─────────────────────────────────────────────
async function refreshAll() {
  const st = await api('/api/status');
  renderStatus(st);

  try {
    renderScene(await api('/api/scene'));
  } catch {
    sceneData = null;
    $('mode-line').textContent = 'no semantic outputs yet — segment an image or run the pipeline';
    $('stat-points').textContent  = '–';
    $('stat-shown').textContent   = '–';
    $('stat-objects').textContent = '–';
    const overlay = $('scene-overlay-empty');
    if (overlay) overlay.style.display = '';
  }
  renderMetrics(await api('/api/metrics'));
}

// ─────────────────────────────────────────────
//  Events
// ─────────────────────────────────────────────
function bindEvents() {
  // ── Confidence slider ──
  $('conf-slider').addEventListener('input', e => {
    minConfidence = parseFloat(e.target.value);
    $('conf-val').textContent = minConfidence.toFixed(2);
    updatePointCloud();
  });

  // ── File upload ──
  const uploadZone = $('upload-zone');
  $('btn-choose').addEventListener('click', () => $('file-input').click());

  // Drag-and-drop
  uploadZone.addEventListener('dragover', e => { e.preventDefault(); uploadZone.style.borderColor = 'var(--accent)'; });
  uploadZone.addEventListener('dragleave', ()=> { uploadZone.style.borderColor = ''; });
  uploadZone.addEventListener('drop', e => {
    e.preventDefault();
    uploadZone.style.borderColor = '';
    const f = e.dataTransfer.files[0];
    if (f && f.type.startsWith('image/')) loadPreview(f);
  });

  $('file-input').addEventListener('change', e => {
    const f = e.target.files[0];
    if (f) loadPreview(f);
  });

  function loadPreview(f) {
    window._pendingFile = f;
    const img = $('preview');
    img.src = URL.createObjectURL(f);
    img.hidden = false;
    $('upload-placeholder').style.display = 'none';
    $('btn-segment').disabled = false;
  }

  // ── Segment button ──
  $('btn-segment').addEventListener('click', async () => {
    const f = window._pendingFile;
    if (!f) return;
    const status = $('segment-status');
    status.className   = 'status-bar';
    status.textContent = '⏳ Segmenting — real backend, may take a moment…';
    $('btn-segment').disabled = true;

    try {
      const dataURI = await new Promise((resolve, reject) => {
        const r = new FileReader();
        r.onload  = () => resolve(r.result);
        r.onerror = reject;
        r.readAsDataURL(f);
      });
      const r = await api('/api/segment', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          image:       dataURI,
          filename:    f.name,
          backend:     $('backend-select').value,
          max_objects: parseInt($('max-objects').value, 10) || 8,
        }),
      });
      status.className   = 'status-bar ok';
      status.textContent = `✓ ${r.n_objects} objects · backend=${r.backend} · ${r.mode}`;
      renderScene(r.scene);
      toast('Segmentation complete ✓', true);
    } catch (e) {
      status.className   = 'status-bar err';
      status.textContent = `✗ ${e.message}`;
      toast(`Segmentation failed: ${e.message}`);
    } finally {
      $('btn-segment').disabled = false;
    }
  });

  // ── Pipeline run ──
  $('btn-run').addEventListener('click', async () => {
    const status = $('pipeline-status');
    status.className   = 'status-bar';
    status.textContent = '⏳ Running 2D→3D association…';
    try {
      const r = await api('/api/pipeline/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          strategy:  $('strategy-select').value,
          min_views: parseInt($('min-views').value, 10) || 1,
        }),
      });
      status.className   = 'status-bar ok';
      status.textContent = `✓ ${(r.metrics.label_rate * 100).toFixed(1)}% labeled (${r.metrics.n_labeled}/${r.metrics.n_gaussians})`;
      renderScene(await api('/api/scene'));
      renderMetrics(await api('/api/metrics'));
    } catch (e) {
      status.className   = 'status-bar err';
      status.textContent = `✗ ${e.message}`;
      toast(`Pipeline failed: ${e.message}`);
    }
  });

  // ── Ablation ──
  $('btn-ablation').addEventListener('click', async () => {
    const status = $('pipeline-status');
    status.className   = 'status-bar';
    status.textContent = '⏳ Running ablation sweep…';
    try {
      await api('/api/pipeline/ablation', { method: 'POST' });
      status.className   = 'status-bar ok';
      status.textContent = '✓ Ablation complete';
      renderScene(await api('/api/scene'));
      renderMetrics(await api('/api/metrics'));
    } catch (e) {
      status.className   = 'status-bar err';
      status.textContent = `✗ ${e.message}`;
      toast(`Ablation failed: ${e.message}`);
    }
  });

  // ── Object visibility ──
  $('btn-show-all').addEventListener('click', () => { visibleObjects.clear(); updatePointCloud(); });
  $('btn-hide-all').addEventListener('click', () => {
    Object.keys(sceneData?.label_names || {}).forEach(id => visibleObjects.add(Number(id)));
    updatePointCloud();
  });

  // ── Camera views ──
  $('btn-view-orbit').addEventListener('click', () => frameCamera('orbit'));
  $('btn-view-top').addEventListener('click',   () => frameCamera('top'));
  $('btn-view-side').addEventListener('click',  () => frameCamera('side'));
  $('btn-reset-cam').addEventListener('click',  () => {
    camera.position.set(0, 2, 6);
    controls.target.set(0, 0, 0);
    controls.update();
  });
}

// ─────────────────────────────────────────────
//  Boot
// ─────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  initTabs();
  initThree();
  bindEvents();

  try {
    await refreshAll();
  } catch (e) {
    toast(`Server unreachable: ${e.message}`);
  }
});
