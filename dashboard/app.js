// dashboard/app.js — Semantic 4DGS v3
/* global THREE, Chart */
'use strict';

// ── Three.js globals ──────────────────────────────────────────────────────────
let scene, camera, renderer, controls, pointsMesh = null;
let sceneData = null;
let ablationChart = null;
const visibleObjects = new Set();
let minConfidence = 0.0;

// ── Label colour palette ──────────────────────────────────────────────────────
const PALETTE = [
  [56, 189, 248], [52, 211, 153], [251, 191, 36],  [248, 113, 113],
  [167, 139, 250],[251, 146,  60],[34,  211, 238],  [244, 114, 182],
  [163, 230,  53],[129, 140, 248],[250, 204,  21],  [74,  222, 128],
];
const UNKNOWN_COLOR = [80, 90, 110];

const $ = id => document.getElementById(id);

// ── Tab switching ─────────────────────────────────────────────────────────────
function switchTab(name) {
  document.querySelectorAll('.ntab').forEach(b =>
    b.classList.toggle('active', b.dataset.tab === name));
  document.querySelectorAll('.tab-pane').forEach(p =>
    p.classList.toggle('active', p.id === `tab-${name}`));
  if (name === 'viewer3d') setTimeout(onResize, 60);
}

function initTabs() {
  document.querySelectorAll('.ntab').forEach(btn =>
    btn.addEventListener('click', () => switchTab(btn.dataset.tab)));
}

// expose for inline onclick in HTML
window.switchTab = switchTab;

// ── Toast ─────────────────────────────────────────────────────────────────────
function toast(msg, ok = false) {
  const el = $('toast');
  el.textContent = msg;
  el.className = ok ? 'ok' : '';
  el.hidden = false;
  clearTimeout(el._t);
  el._t = setTimeout(() => { el.hidden = true; }, 5000);
}

// ── API helper ────────────────────────────────────────────────────────────────
async function api(path, opts) {
  const res  = await fetch(path, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

function labelColor(label) {
  return label < 0 ? UNKNOWN_COLOR : PALETTE[label % PALETTE.length];
}

// ── Three.js init ─────────────────────────────────────────────────────────────
function initThree() {
  const container = $('canvas-container');
  const w = container.clientWidth  || 900;
  const h = container.clientHeight || 600;

  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x050710);
  scene.fog = new THREE.FogExp2(0x050710, 0.016);

  camera = new THREE.PerspectiveCamera(58, w / h, 0.01, 1000);
  camera.position.set(0, 2, 7);

  renderer = new THREE.WebGLRenderer({ antialias: true, logarithmicDepthBuffer: true });
  renderer.setSize(w, h);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  container.appendChild(renderer.domElement);

  controls = new THREE.OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.055;
  controls.minDistance  = 0.3;
  controls.maxDistance  = 500;

  // Grid
  const grid = new THREE.GridHelper(24, 48, 0x151c2e, 0x0d1220);
  grid.material.opacity     = 0.55;
  grid.material.transparent = true;
  scene.add(grid);

  // Lights
  scene.add(new THREE.AmbientLight(0xffffff, 1.1));
  const dir = new THREE.DirectionalLight(0x7dd3fc, 0.5);
  dir.position.set(5, 10, 5);
  scene.add(dir);

  // Axes
  const axes = new THREE.AxesHelper(0.6);
  axes.position.set(-11, 0, -11);
  scene.add(axes);

  window.addEventListener('resize', onResize);
  (function animate() {
    requestAnimationFrame(animate);
    controls.update();
    renderer.render(scene, camera);
  })();
}

function onResize() {
  const c = $('canvas-container');
  if (!c || !renderer) return;
  const w = c.clientWidth, h = c.clientHeight;
  if (!w || !h) return;
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  renderer.setSize(w, h);
}

// ── Point cloud ───────────────────────────────────────────────────────────────
function cloudCenter(xyz) {
  if (!xyz.length) return [0, 0, 0];
  const c = [0, 0, 0];
  xyz.forEach(p => { c[0] += p[0]; c[1] += p[1]; c[2] += p[2]; });
  return c.map(v => v / xyz.length);
}

function cloudRadius(xyz, ctr) {
  let mx = 0;
  xyz.forEach(p => {
    const d = Math.hypot(p[0]-ctr[0], p[1]-ctr[1], p[2]-ctr[2]);
    if (d > mx) mx = d;
  });
  return mx || 5;
}

function updatePointCloud() {
  if (!sceneData) return;
  const { xyz, labels, confidence } = sceneData;

  if (pointsMesh) {
    scene.remove(pointsMesh);
    pointsMesh.geometry.dispose();
    pointsMesh.material.dispose();
    pointsMesh = null;
  }

  // Hide empty overlay once we have data
  const ov = $('scene-empty-overlay');
  if (ov) ov.style.display = 'none';

  const positions = [], colors = [];
  let shown = 0;

  for (let i = 0; i < xyz.length; i++) {
    if (confidence[i] < minConfidence) continue;
    const lab = labels[i];
    if (visibleObjects.size > 0 && !visibleObjects.has(lab)) continue;
    positions.push(xyz[i][0], xyz[i][1], xyz[i][2]);
    const c = labelColor(lab);
    colors.push(c[0]/255, c[1]/255, c[2]/255);
    shown++;
  }

  if (shown === 0) { $('stat-shown').textContent = '0'; return; }

  const ctr  = cloudCenter(xyz);
  const r    = cloudRadius(xyz, ctr);
  const pSz  = Math.max(0.007, Math.min(0.055, r / 70));

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('color',    new THREE.Float32BufferAttribute(colors, 3));

  const mat = new THREE.PointsMaterial({
    size: pSz, vertexColors: true,
    opacity: 0.96, transparent: true, sizeAttenuation: true,
  });

  pointsMesh = new THREE.Points(geo, mat);
  scene.add(pointsMesh);
  $('stat-shown').textContent = shown.toLocaleString();
}

function frameCamera(view) {
  if (!sceneData?.xyz?.length) return;
  const ctr = cloudCenter(sceneData.xyz);
  const r   = cloudRadius(sceneData.xyz, ctr);
  controls.target.set(...ctr);
  if (view === 'top')
    camera.position.set(ctr[0], ctr[1] + r * 2.0, ctr[2] + 0.001);
  else if (view === 'side')
    camera.position.set(ctr[0] + r * 2.0, ctr[1], ctr[2]);
  else
    camera.position.set(ctr[0] + r * 0.9, ctr[1] + r * 0.65, ctr[2] + r * 1.5);
  controls.update();

  ['btn-view-orbit','btn-view-top','btn-view-side'].forEach(id => {
    const el = $(id); if (el) el.classList.remove('active');
  });
  const map = { orbit:'btn-view-orbit', top:'btn-view-top', side:'btn-view-side' };
  if (map[view]) $(map[view])?.classList.add('active');
}

// ── Render scene data ─────────────────────────────────────────────────────────
function renderScene(sd) {
  sceneData = sd;
  const names = sd.label_names || {};

  $('mode-line') && ($('mode-line').textContent = sd.mode === 'single_image_2.5d'
    ? 'single-image 2.5D — real segmentation, plane-assumption depth'
    : 'multi-view 2D→3D label transfer on Gaussian Splats');

  const modeEl = $('badge-mode');
  if (modeEl) {
    modeEl.textContent = `mode: ${sd.mode}`;
    modeEl.className   = 'nbadge ' + (sd.mode === 'single_image_2.5d' ? 'warn' : 'ok');
  }

  const ids    = Object.keys(names).map(Number).sort((a,b) => a-b);
  const counts = {};
  for (const l of sd.labels) counts[l] = (counts[l] || 0) + 1;

  // ─── 3D viewer object list ───
  visibleObjects.clear();
  const list = $('object-list');
  list.innerHTML = '';
  for (const id of ids) {
    const li  = document.createElement('li');
    const dot = document.createElement('span'); dot.className = 'dot';
    const c   = labelColor(id);
    dot.style.background = `rgb(${c.join(',')})`;
    dot.style.boxShadow  = `0 0 7px rgb(${c.join(',')})`;

    const inp = document.createElement('input'); inp.type = 'text'; inp.value = names[id]; inp.title = 'Click to rename';
    inp.addEventListener('change', async () => {
      try {
        const r = await api('/api/labels/rename', {
          method:'POST', headers:{'Content-Type':'application/json'},
          body: JSON.stringify({id, label: inp.value}),
        });
        sceneData = r.scene; toast('Renamed ✓', true);
      } catch (e) { toast(`Rename failed: ${e.message}`); inp.value = names[id]; }
    });

    const cnt = document.createElement('span'); cnt.className = 'count';
    cnt.textContent = (counts[id]||0).toLocaleString();

    const chk = document.createElement('input'); chk.type = 'checkbox'; chk.checked = true;
    chk.addEventListener('change', () => {
      if (chk.checked) visibleObjects.delete(id); else visibleObjects.add(id);
      updatePointCloud();
    });

    li.append(chk, dot, inp, cnt);
    list.appendChild(li);
  }

  // ─── Segment tab object cards ───
  const grid  = $('obj-grid');
  const empty = $('seg-empty');
  if (grid) {
    grid.innerHTML = '';
    if (!ids.length) { if (empty) empty.style.display = 'block'; }
    else {
      if (empty) empty.style.display = 'none';
      for (const id of ids) {
        const div  = document.createElement('div'); div.className = 'obj-card';
        const dot  = document.createElement('div'); dot.className = 'dot';
        const c    = labelColor(id);
        dot.style.background = `rgb(${c.join(',')})`;
        dot.style.boxShadow  = `0 0 12px rgb(${c.join(',')})`;
        const name = document.createElement('div'); name.className = 'obj-card-name'; name.textContent = names[id];
        const pts  = document.createElement('div'); pts.className  = 'obj-card-pts';  pts.textContent = `${(counts[id]||0).toLocaleString()} pts`;
        div.append(dot, name, pts); grid.appendChild(div);
      }
    }
  }

  $('stat-points').textContent  = (sd.n_points||0).toLocaleString();
  $('stat-objects').textContent = ids.length;
  updatePointCloud();
  frameCamera('orbit');
}

// ── Render metrics ────────────────────────────────────────────────────────────
function renderMetrics(m) {
  const ablation = m.ablation || [];
  const aLabels  = ablation.map(a => (a.name||a.strategy||'?').replace(/_/g,' '));
  const aRates   = ablation.map(a => +(a.label_rate*100).toFixed(1));

  if (ablationChart) ablationChart.destroy();
  ablationChart = new Chart($('ablation-chart'), {
    type: 'bar',
    data: {
      labels: aLabels,
      datasets: [{
        data: aRates,
        backgroundColor: ['rgba(56,189,248,.55)','rgba(129,140,248,.55)','rgba(52,211,153,.65)'],
        borderColor:     ['rgb(56,189,248)',     'rgb(129,140,248)',     'rgb(52,211,153)'],
        borderWidth: 1.5, borderRadius: 6,
      }],
    },
    options: {
      responsive:true, maintainAspectRatio:false,
      scales:{
        y:{ beginAtZero:true, max:100,
            ticks:{color:'#5a6680',font:{size:11}},
            grid: {color:'rgba(255,255,255,0.04)'} },
        x:{ ticks:{color:'#9aa3b5',font:{size:11}},
            grid:{display:false} },
      },
      plugins:{
        legend:{display:false},
        tooltip:{
          backgroundColor:'#131829', borderColor:'rgba(255,255,255,.1)', borderWidth:1,
          titleColor:'#e2e8f8', bodyColor:'#9aa3b5',
          callbacks:{label: ctx => ` ${ctx.parsed.y}% labeled`},
        },
      },
    },
  });

  const tbody = $('ablation-table').querySelector('tbody');
  tbody.innerHTML = '';
  ablation.forEach(a => {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td>${(a.name||a.strategy||'').replace(/_/g,' ')}</td>
      <td class="num">${a.n_labeled}</td><td class="num">${a.n_gaussians}</td>
      <td class="num">${(a.label_rate*100).toFixed(1)}%</td>`;
    tbody.appendChild(tr);
  });

  const evTbody = $('eval-table').querySelector('tbody');
  evTbody.innerHTML = '';
  const ev = m.evaluation || {};
  const evKeys = Object.keys(ev);
  if (!evKeys.length) {
    evTbody.innerHTML = '<tr><td colspan="4" style="color:var(--muted);font-style:italic">No eval_results.json yet</td></tr>';
  } else {
    evKeys.forEach(name => {
      const s = ev[name];
      const tr = document.createElement('tr');
      tr.innerHTML = `<td>${name}</td>
        <td class="num">${(+s.mean_iou).toFixed(3)}</td>
        <td class="num">${(+s.mean_precision).toFixed(3)}</td>
        <td class="num">${(+s.mean_recall).toFixed(3)}</td>`;
      evTbody.appendChild(tr);
    });
  }

  $('metrics-pre').textContent = m.run_metrics
    ? JSON.stringify(m.run_metrics, null, 2)
    : (m.metadata?.mode ? `mode: ${m.metadata.mode}\n(single-image run)` : 'no run yet');
}

// ── Render status / checklist ─────────────────────────────────────────────────
function renderStatus(st) {
  const b = st.backends || {};
  const bel = $('badge-backend');
  if (bel) {
    bel.textContent = `segmenter: ${b.sam2 ? 'SAM 2' : 'classical CPU'}`;
    bel.className   = 'nbadge ' + (b.sam2 ? 'ok' : '');
  }
  if (!b.torch) {
    const opt = $('backend-select')?.querySelector('option[value="sam2"]');
    if (opt) { opt.disabled = true; opt.textContent = 'SAM 2 (torch not installed)'; }
  }

  const inp = st.inputs || {};
  function setCI(id, ok) {
    const el = $(id); if (!el) return;
    el.classList.toggle('ok',  ok);
    el.classList.toggle('err', !ok);
  }
  setCI('ci-colmap',  inp.colmap_data);
  setCI('ci-ply',     inp.trained_ply);
  setCI('ci-masks',   inp.masks);
  setCI('ci-outputs', inp.semantic_outputs);
}

// ── Refresh all ───────────────────────────────────────────────────────────────
async function refreshAll() {
  const st = await api('/api/status');
  renderStatus(st);
  try {
    renderScene(await api('/api/scene'));
  } catch {
    sceneData = null;
    $('stat-points').textContent  = '–';
    $('stat-shown').textContent   = '–';
    $('stat-objects').textContent = '–';
    const ov = $('scene-empty-overlay');
    if (ov) ov.style.display = '';
  }
  renderMetrics(await api('/api/metrics'));
}

// ── Events ────────────────────────────────────────────────────────────────────
function bindEvents() {
  // Confidence
  $('conf-slider').addEventListener('input', e => {
    minConfidence = parseFloat(e.target.value);
    $('conf-val').textContent = minConfidence.toFixed(2);
    updatePointCloud();
  });

  // File upload + drag-drop
  const zone = $('upload-zone');
  $('btn-choose').addEventListener('click', () => $('file-input').click());

  zone.addEventListener('dragover',  e => { e.preventDefault(); zone.style.borderColor='var(--sky)'; });
  zone.addEventListener('dragleave', ()=> { zone.style.borderColor=''; });
  zone.addEventListener('drop', e => {
    e.preventDefault(); zone.style.borderColor = '';
    const f = e.dataTransfer.files[0];
    if (f?.type.startsWith('image/')) loadPreview(f);
  });
  $('file-input').addEventListener('change', e => {
    const f = e.target.files[0]; if (f) loadPreview(f);
  });

  function loadPreview(f) {
    window._pendingFile = f;
    const img = $('preview');
    img.src = URL.createObjectURL(f);
    img.hidden = false;
    $('upload-ph').style.display = 'none';
    $('btn-segment').disabled = false;
  }

  // Segment
  $('btn-segment').addEventListener('click', async () => {
    const f = window._pendingFile; if (!f) return;
    const st = $('segment-status');
    st.className   = 'status-pill';
    st.textContent = '⏳ Segmenting…';
    $('btn-segment').disabled = true;
    try {
      const dataURI = await new Promise((res, rej) => {
        const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(f);
      });
      const r = await api('/api/segment', {
        method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({
          image: dataURI, filename: f.name,
          backend: $('backend-select').value,
          max_objects: parseInt($('max-objects').value,10)||8,
        }),
      });
      st.className   = 'status-pill ok';
      st.textContent = `✓ ${r.n_objects} objects · backend=${r.backend} · ${r.mode}`;
      renderScene(r.scene);
      toast('Segmentation complete ✓', true);
    } catch (e) {
      st.className   = 'status-pill err';
      st.textContent = `✗ ${e.message}`;
      toast(`Segmentation failed: ${e.message}`);
    } finally {
      $('btn-segment').disabled = false;
    }
  });

  // Pipeline run
  $('btn-run').addEventListener('click', async () => {
    const st = $('pipeline-status');
    st.className   = 'status-pill';
    st.textContent = '⏳ Running 2D→3D association…';
    try {
      const r = await api('/api/pipeline/run', {
        method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({
          strategy: $('strategy-select').value,
          min_views: parseInt($('min-views').value,10)||1,
        }),
      });
      st.className   = 'status-pill ok';
      st.textContent = `✓ ${(r.metrics.label_rate*100).toFixed(1)}% labeled (${r.metrics.n_labeled}/${r.metrics.n_gaussians})`;
      renderScene(await api('/api/scene'));
      renderMetrics(await api('/api/metrics'));
    } catch (e) {
      st.className   = 'status-pill err';
      st.textContent = `✗ ${e.message}`;
      toast(`Pipeline failed: ${e.message}`);
    }
  });

  // Ablation
  $('btn-ablation').addEventListener('click', async () => {
    const st = $('pipeline-status');
    st.className='status-pill'; st.textContent='⏳ Ablation sweep…';
    try {
      await api('/api/pipeline/ablation',{method:'POST'});
      st.className='status-pill ok'; st.textContent='✓ Ablation complete';
      renderScene(await api('/api/scene'));
      renderMetrics(await api('/api/metrics'));
    } catch (e) {
      st.className='status-pill err'; st.textContent=`✗ ${e.message}`;
      toast(`Ablation failed: ${e.message}`);
    }
  });

  // Object visibility
  $('btn-show-all').addEventListener('click', () => { visibleObjects.clear(); updatePointCloud(); });
  $('btn-hide-all').addEventListener('click', () => {
    Object.keys(sceneData?.label_names||{}).forEach(id=>visibleObjects.add(Number(id)));
    updatePointCloud();
  });

  // Camera
  $('btn-view-orbit').addEventListener('click', () => frameCamera('orbit'));
  $('btn-view-top').addEventListener('click',   () => frameCamera('top'));
  $('btn-view-side').addEventListener('click',  () => frameCamera('side'));
  $('btn-reset-cam').addEventListener('click',  () => {
    camera.position.set(0,2,7); controls.target.set(0,0,0); controls.update();
  });
}

// ── Boot ─────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  initTabs();
  initThree();
  bindEvents();
  try { await refreshAll(); }
  catch (e) { toast(`Server unreachable: ${e.message}`); }
});
