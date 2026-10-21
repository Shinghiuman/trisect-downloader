'use strict';

/* ------------------------------------------------------------------ 状态 */
const state = {
  tasks: [],
  stats: { speed: 0, active: 0, waiting: 0, completed: 0, error: 0, paused: 0, total: 0, byProto: {}, engine: {} },
  settings: { maxConcurrent: 3 },
  cat: 'all',
  proto: 'all',
  q: '',
  selected: null,
  history: [],
};

const rows = new Map();
const $ = (s) => document.querySelector(s);

/* ------------------------------------------------------------------ 工具 */
const KB = 1024;
function fmtBytes(n, digits = 1) {
  if (!n) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (n >= KB && i < u.length - 1) { n /= KB; i++; }
  return `${n.toFixed(i === 0 ? 0 : digits)} ${u[i]}`;
}
function fmtSpeed(n) {
  if (!n || n < 1) return '—';
  return fmtBytes(n, 1) + '/s';
}
function fmtEta(sec) {
  if (!isFinite(sec) || sec <= 0) return '—';
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  if (h > 0) return `${h} 小时 ${m} 分`;
  if (m > 0) return `${m} 分 ${s} 秒`;
  return `${s} 秒`;
}
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function hashStr(s) {
  let h = 2166136261;
  for (let i = 0; i < String(s).length; i++) { h ^= String(s).charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const PROTO_LABEL = { http: 'HTTP', bt: 'BT', ed2k: 'ED2K' };
const PROTO_COLOR = { http: '#3b82f6', bt: '#f59e0b', ed2k: '#22c55e' };
const ENGINE_LABEL = {
  native: '原生引擎',
  webtorrent: 'WebTorrent 真实引擎',
  model: '协议模型',
  sim: '协议模型',
  aria2: 'aria2',
  '': '原生引擎',
};

function statusInfo(t) {
  if (t.status === 'downloading') {
    if (t.queue > 0) return { cls: 'waiting', text: `排队 #${t.queue}`, bar: 'idle' };
    if (t.protocol === 'bt' && !t.size) return { cls: 'waiting', text: '获取元数据…', bar: 'idle' };
    return { cls: 'downloading', text: '下载中', bar: '' };
  }
  if (t.status === 'waiting') return { cls: 'waiting', text: '等待中', bar: 'idle' };
  if (t.status === 'paused') return { cls: 'paused', text: '已暂停', bar: 'idle' };
  if (t.status === 'completed') return { cls: 'completed', text: '已完成', bar: 'done' };
  return { cls: 'error', text: '失败', bar: 'err' };
}

/* ------------------------------------------------------------------ 渲染 */
function render() {
  renderStats();
  renderList();
  if (state.selected) renderDrawer();
  drawSpark();
}

function renderStats() {
  const s = state.stats;
  $('#mSpeed').textContent = fmtSpeed(s.speed);
  $('#mActive').textContent = s.active;
  $('#mDone').textContent = s.completed;
  $('#cAll').textContent = s.total;
  $('#cActive').textContent = s.active + (s.waiting || 0);
  const cUn = $('#cUnfinished');
  if (cUn) cUn.textContent = Math.max(0, s.total - (s.completed || 0));
  $('#cPaused').textContent = s.paused;
  $('#cDone').textContent = s.completed;
  $('#cErr').textContent = s.error;

  $('#engHttp').textContent = '原生';
  $('#engBt').textContent = 'WebTorrent';
  $('#engEd2k').textContent = '协议模型';

  const catTitle = { all: '全部任务', active: '正在下载', unfinished: '未完成任务', paused: '已暂停', completed: '已完成', error: '失败任务' };
  $('#viewTitle').textContent = catTitle[state.cat] || '全部任务';

  const sel = $('#concurrency');
  if (document.activeElement !== sel) sel.value = String(state.settings.maxConcurrent || 3);
}

function filterTasks() {
  const q = state.q.trim().toLowerCase();
  return state.tasks.filter((t) => {
    if (state.cat === 'active' && !['downloading', 'waiting'].includes(t.status)) return false;
    if (state.cat === 'unfinished' && t.status === 'completed') return false;
    if (state.cat === 'paused' && t.status !== 'paused') return false;
    if (state.cat === 'completed' && t.status !== 'completed') return false;
    if (state.cat === 'error' && t.status !== 'error') return false;
    if (state.proto !== 'all' && t.protocol !== state.proto) return false;
    if (q) {
      const hay = `${t.name} ${t.url} ${t.hash || ''}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}

function renderList() {
  const list = $('#list');
  const visible = filterTasks();
  $('#viewSub').textContent = `${visible.length} 个任务`;

  const ids = new Set(visible.map((t) => t.id));
  for (const [id, el] of rows) {
    if (!ids.has(id)) { el.remove(); rows.delete(id); }
  }

  visible.forEach((t, idx) => {
    let el = rows.get(t.id);
    if (!el) {
      el = buildRow(t);
      rows.set(t.id, el);
      list.appendChild(el);
    }
    updateRow(el, t);
    if (list.children[idx] !== el) list.insertBefore(el, list.children[idx] || null);
  });

  const empty = $('#empty');
  empty.hidden = visible.length > 0;
  list.style.display = visible.length ? 'flex' : 'none';
}

function buildRow(t) {
  const el = document.createElement('div');
  el.className = 'row';
  el.dataset.id = t.id;
  el.style.setProperty('--pc', PROTO_COLOR[t.protocol]);
  el.innerHTML = `
    <div class="cell-proto"><span class="pbadge ${t.protocol}">${PROTO_LABEL[t.protocol]}</span></div>
    <div class="cell-name">
      <div class="name-line"><span class="name"></span><span class="status-chip"></span></div>
      <div class="meta"><span class="m1"></span><span class="sep">·</span><span class="m2"></span></div>
    </div>
    <div class="cell-progress">
      <div class="bar"><i></i></div>
      <div class="progress-text"><b class="pct">0%</b><span class="sz">—</span></div>
    </div>
    <div class="cell-speed"><div class="spd zero">—</div><div class="eta">—</div></div>
    <div class="cell-act">
      <button class="act primary-act" title="暂停/继续">⏸</button>
      <button class="act danger del-act" title="移除任务">✕</button>
    </div>`;

  el.addEventListener('click', (e) => {
    const btn = e.target.closest('.act');
    if (btn) { e.stopPropagation(); handleAct(btn, el.dataset.id); return; }
    state.selected = el.dataset.id;
    for (const [, r] of rows) r.classList.toggle('selected', r.dataset.id === state.selected);
    $('#drawer').classList.add('open');
    renderDrawer();
  });
  return el;
}

function updateRow(el, t) {
  const info = statusInfo(t);
  const nameEl = el.querySelector('.name');
  if (nameEl.textContent !== t.name) nameEl.textContent = t.name;
  nameEl.title = t.name;

  const chip = el.querySelector('.status-chip');
  chip.className = `status-chip ${info.cls}`;
  chip.textContent = info.text;

  const m1 = el.querySelector('.m1');
  const m2 = el.querySelector('.m2');
  if (t.protocol === 'http') {
    let host = '';
    try { host = new URL(t.url).host; } catch (_) {}
    m1.textContent = host || 'HTTP 直连';
    m2.textContent = t.errorText || '支持断点续传';
  } else if (t.protocol === 'bt') {
    m1.textContent = t.size ? `节点 ${t.peers || 0}` : `节点 ${t.peers || 0} · 求种中`;
    m2.textContent = t.hash ? t.hash.slice(0, 12) + '…' : (t.errorText || '磁力链接');
  } else {
    m1.textContent = `源 ${t.peers || 0}`;
    m2.textContent = t.hash ? t.hash.slice(0, 12) + '…' : 'eD2K';
  }

  const bar = el.querySelector('.bar');
  bar.className = 'bar ' + info.bar;
  const p = t.size ? Math.min(1, t.downloaded / t.size) : 0;
  el.querySelector('.bar > i').style.width = (t.size ? p * 100 : 2).toFixed(2) + '%';

  el.querySelector('.pct').textContent = t.size ? (p * 100).toFixed(p > 0.999 ? 0 : 1) + '%' : '—';
  el.querySelector('.sz').textContent = t.size ? `${fmtBytes(t.downloaded)} / ${fmtBytes(t.size)}` : fmtBytes(t.downloaded);

  const spd = el.querySelector('.spd');
  const hasSpd = t.speed > 0;
  spd.textContent = hasSpd ? fmtSpeed(t.speed) : t.status === 'completed' ? '完成' : '—';
  spd.className = 'spd' + (hasSpd ? '' : ' zero');

  let eta = '—';
  if (t.status === 'completed') eta = t.completedAt ? new Date(t.completedAt).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : '已完成';
  else if (t.queue > 0) eta = `队列第 ${t.queue} 位`;
  else if (t.size && t.speed > 0) eta = '剩 ' + fmtEta((t.size - t.downloaded) / t.speed);
  else if (t.status === 'paused') eta = '已暂停';
  else if (t.status === 'error') eta = '点击重试';
  el.querySelector('.eta').textContent = eta;

  const pa = el.querySelector('.primary-act');
  if (t.status === 'completed') { pa.textContent = '⤓'; pa.title = '下载文件到本机'; }
  else if (t.status === 'error') { pa.textContent = '↻'; pa.title = '重试'; }
  else if (t.status === 'paused') { pa.textContent = '▶'; pa.title = '继续下载'; }
  else { pa.textContent = '⏸'; pa.title = '暂停'; }

  el.classList.toggle('selected', state.selected === t.id);
}

/* ------------------------------------------------------------------ 动作 */
function toast(msg) {
  let el = document.querySelector('.toast');
  if (!el) { el = document.createElement('div'); el.className = 'toast'; document.body.appendChild(el); }
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.remove('show'), 2600);
}

async function handleAct(btn, id) {
  const t = state.tasks.find((x) => x.id === id);
  if (!t) return;
  if (btn.classList.contains('del-act')) {
    await api('/api/task', { id, action: 'remove', withFile: false });
    if (state.selected === id) { state.selected = null; $('#drawer').classList.remove('open'); }
    return;
  }
  if (t.status === 'completed') {
    if (t.engine === 'model' || t.engine === 'sim') { toast('该任务由协议模型驱动，仅演示传输过程，无实体文件'); return; }
    window.location.href = '/api/file/' + id;
    return;
  }
  if (t.status === 'error') { await api('/api/task', { id, action: 'retry' }); return; }
  await api('/api/task', { id, action: t.status === 'paused' ? 'resume' : 'pause' });
}

async function api(url, body) {
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const json = await res.json();
  if (json && json.state) { state.tasks = json.state.tasks; state.stats = json.state.stats; render(); }
  else if (json && json.tasks) { state.tasks = json.tasks; state.stats = json.stats || state.stats; render(); }
  return json;
}

/* -------------------------------------------------------------- 详情抽屉 */
function renderDrawer() {
  const t = state.tasks.find((x) => x.id === state.selected);
  const body = $('#drawerBody');
  if (!t) { body.innerHTML = '<div class="d-empty">任务已不存在</div>'; return; }

  const info = statusInfo(t);
  const p = t.size ? Math.min(1, t.downloaded / t.size) : 0;
  const pieceCount = 400;
  const filled = Math.round(p * pieceCount);
  const rnd = mulberry32(hashStr(t.hash || t.name));
  const ahead = new Set();
  if (t.status === 'downloading' && t.peers > 0) {
    const n = Math.min(pieceCount - filled, Math.max(0, Math.round(t.peers / 2)));
    for (let i = 0; i < n; i++) ahead.add(filled + Math.floor(rnd() * Math.max(1, pieceCount - filled)));
  }
  let cells = '';
  for (let i = 0; i < pieceCount; i++) {
    const cls = i < filled ? 'on' : ahead.has(i) ? 'hot' : '';
    cells += `<i class="${cls}"></i>`;
  }

  const peerCount = Math.min(6, Math.max(0, Math.round((t.peers || 0) / 4)));
  let peers = '';
  for (let i = 0; i < peerCount; i++) {
    const r = mulberry32(hashStr(t.id + i));
    const ip = `10.${Math.floor(r() * 250)}.${Math.floor(r() * 250)}.${Math.floor(r() * 250)}`;
    const port = 1024 + Math.floor(r() * 64000);
    const sp = t.speed ? t.speed / peerCount * (0.4 + r()) : 0;
    peers += `<div class="peer"><i class="${r() > 0.8 ? 'slow' : ''}"></i><span>${ip}:${port}</span><em>${fmtSpeed(sp)}</em></div>`;
  }

  const rowsHtml = [
    ['状态', `<span class="status-chip ${info.cls}">${info.text}</span>`],
    ['协议', PROTO_LABEL[t.protocol] + '（' + ENGINE_LABEL[t.engine] + '）'],
    ['大小', t.size ? fmtBytes(t.size) : '未知'],
    ['已下载', fmtBytes(t.downloaded)],
    ['速度', fmtSpeed(t.speed)],
    ['剩余', t.speed > 0 ? fmtEta((t.size - t.downloaded) / t.speed) : '—'],
    ['保存位置', t.filePath || 'downloads/' + t.name],
    ['添加时间', t.addedAt ? new Date(t.addedAt).toLocaleString('zh-CN') : '—'],
  ];
  if (t.hash) rowsHtml.push(['哈希', `<span class="mono">${esc(t.hash)}</span>`]);
  if (t.files) rowsHtml.push(['文件数', t.files + ' 个']);

  body.innerHTML = `
    <div class="d-sec">
      <div class="d-title">${esc(t.name)}</div>
      <div class="kv">${rowsHtml.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('')}</div>
    </div>
    <div class="d-sec">
      <h4>分片进度 ${t.size ? '· ' + (p * 100).toFixed(1) + '%' : ''}</h4>
      <div class="pieces">${cells}</div>
    </div>
    <div class="d-sec">
      <h4>已连接节点 ${t.peers || 0}</h4>
      <div class="peers">${peers || '<div class="d-empty">尚无可用节点</div>'}</div>
    </div>
    <div class="d-sec">
      <h4>链接</h4>
      <div class="kv"><dd class="mono" style="grid-column:1/-1">${esc(t.url)}</dd></div>
    </div>`;
}

/* ------------------------------------------------------------ 速度曲线图 */
function drawSpark() {
  const cv = $('#spark');
  if (!cv) return;
  const dpr = window.devicePixelRatio || 1;
  const w = 260, h = 48;
  if (cv.width !== w * dpr) { cv.width = w * dpr; cv.height = h * dpr; cv.style.width = w + 'px'; cv.style.height = h + 'px'; }
  const ctx = cv.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);

  state.history.push(state.stats.speed || 0);
  if (state.history.length > 90) state.history.shift();
  const arr = state.history;
  const max = Math.max(1, ...arr) * 1.15;

  ctx.beginPath();
  arr.forEach((v, i) => {
    const x = (i / Math.max(1, arr.length - 1)) * w;
    const y = h - 4 - (v / max) * (h - 8);
    i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
  });
  const grad = ctx.createLinearGradient(0, 0, 0, h);
  grad.addColorStop(0, 'rgba(76,141,255,0.55)');
  grad.addColorStop(1, 'rgba(76,141,255,0)');
  ctx.lineTo(w, h); ctx.lineTo(0, h); ctx.closePath();
  ctx.fillStyle = grad;
  ctx.fill();

  ctx.beginPath();
  arr.forEach((v, i) => {
    const x = (i / Math.max(1, arr.length - 1)) * w;
    const y = h - 4 - (v / max) * (h - 8);
    i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
  });
  ctx.strokeStyle = '#6ea1ff';
  ctx.lineWidth = 1.6;
  ctx.lineJoin = 'round';
  ctx.stroke();
}

/* -------------------------------------------------------------- 交互绑定 */
document.querySelectorAll('#catNav .nav-item').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('#catNav .nav-item').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    state.cat = btn.dataset.cat;
    renderList();
  });
});

document.querySelectorAll('#protoFilter .pchip').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('#protoFilter .pchip').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    state.proto = btn.dataset.proto;
    renderList();
  });
});

document.querySelectorAll('[data-bulk]').forEach((btn) => {
  btn.addEventListener('click', () => api('/api/bulk', { action: btn.dataset.bulk }));
});

$('#search').addEventListener('input', (e) => { state.q = e.target.value; renderList(); });

$('#concurrency').addEventListener('change', (e) => api('/api/settings', { maxConcurrent: Number(e.target.value) }));

$('#closeDrawer').addEventListener('click', () => {
  $('#drawer').classList.remove('open');
  state.selected = null;
  for (const [, r] of rows) r.classList.remove('selected');
});

/* ------------------------------------------------------------------ 弹窗 */
const modal = $('#modal');
function openModal() {
  modal.hidden = false;
  $('#links').focus();
}
function closeModal() { modal.hidden = true; }
$('#addBtn').addEventListener('click', openModal);
$('#emptyAdd').addEventListener('click', openModal);
$('#closeModal').addEventListener('click', closeModal);
$('#cancelModal').addEventListener('click', closeModal);
modal.addEventListener('click', (e) => { if (e.target === modal) closeModal(); });
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { closeModal(); $('#drawer').classList.remove('open'); }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'n') { e.preventDefault(); openModal(); }
});

function detectProtocol(link) {
  const s = link.trim();
  if (/^magnet:\?/i.test(s)) return 'bt';
  if (/^ed2k:\/\//i.test(s)) return 'ed2k';
  if (/^https?:\/\//i.test(s)) return 'http';
  return null;
}

$('#links').addEventListener('input', () => {
  const lines = $('#links').value.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  const box = $('#detect');
  if (!lines.length) { box.innerHTML = '<span class="detect-idle">等待输入链接…</span>'; return; }
  let http = 0, bt = 0, ed2k = 0, bad = 0;
  for (const l of lines) {
    const p = detectProtocol(l);
    if (p === 'http') http++;
    else if (p === 'bt') bt++;
    else if (p === 'ed2k') ed2k++;
    else bad++;
  }
  box.innerHTML = [
    http ? `<span class="d-tag http">HTTP × ${http}</span>` : '',
    bt ? `<span class="d-tag bt">BT / 磁力 × ${bt}</span>` : '',
    ed2k ? `<span class="d-tag ed2k">eD2K × ${ed2k}</span>` : '',
    bad ? `<span class="d-tag bad">无法识别 × ${bad}</span>` : '',
  ].join('');
});

/* -------------------------------------------------------------- 种子文件 */
const pendingTorrents = [];

function renderTorrentChips() {
  const box = $('#torrentChips');
  box.innerHTML = pendingTorrents
    .map((t, i) => `<span class="tchip">📄 ${esc(t.name)}<b data-i="${i}">✕</b></span>`)
    .join('');
  box.querySelectorAll('b').forEach((b) => {
    b.addEventListener('click', () => { pendingTorrents.splice(Number(b.dataset.i), 1); renderTorrentChips(); });
  });
  $('#dropHint').innerHTML = pendingTorrents.length
    ? `已选择 ${pendingTorrents.length} 个种子文件，可继续追加`
    : '拖拽 .torrent 到此处，或 <b>点击选择文件</b>';
}

function addTorrentFiles(fileList) {
  const files = Array.from(fileList).filter((f) => /\.torrent$/i.test(f.name));
  let left = files.length;
  if (!left) return;
  for (const f of files) {
    const fr = new FileReader();
    fr.onload = () => {
      const b64 = String(fr.result).split(',')[1] || '';
      if (b64) pendingTorrents.push({ name: f.name, base64: b64 });
      if (--left === 0) renderTorrentChips();
    };
    fr.readAsDataURL(f);
  }
  toast(`已读取 ${files.length} 个种子文件`);
}

$('#dropzone').addEventListener('click', () => $('#torrentFile').click());
$('#torrentFile').addEventListener('change', (e) => { addTorrentFiles(e.target.files); e.target.value = ''; });

window.addEventListener('dragover', (e) => { e.preventDefault(); $('#dropzone').classList.add('drag'); });
window.addEventListener('dragleave', (e) => {
  if (e.relatedTarget === null) $('#dropzone').classList.remove('drag');
});
window.addEventListener('drop', (e) => {
  e.preventDefault();
  $('#dropzone').classList.remove('drag');
  if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length) {
    if (modal.hidden) openModal();
    addTorrentFiles(e.dataTransfer.files);
  }
});

$('#submitModal').addEventListener('click', async () => {
  const links = $('#links').value.trim();
  if (!links && !pendingTorrents.length) { $('#links').focus(); return; }
  const res = await fetch('/api/tasks', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ links, autoStart: $('#autoStart').checked, torrents: pendingTorrents.slice() }),
  });
  const data = await res.json();
  if (data.state) { state.tasks = data.state.tasks; state.stats = data.state.stats; render(); }
  $('#links').value = '';
  $('#detect').innerHTML = '<span class="detect-idle">等待输入链接…</span>';
  pendingTorrents.length = 0;
  renderTorrentChips();
  closeModal();
  if (data.added) toast(`已添加 ${data.added} 个任务`);
});

/* ------------------------------------------------------------------- SSE */
async function bootstrap() {
  try {
    const data = await (await fetch('/api/state')).json();
    state.tasks = data.tasks;
    state.stats = data.stats;
    state.settings = data.settings;
    render();
  } catch (_) {}
}

function connect() {
  const es = new EventSource('/api/events');
  es.onmessage = (ev) => {
    try {
      const data = JSON.parse(ev.data);
      state.tasks = data.tasks;
      state.stats = data.stats;
      state.settings = data.settings;
      render();
    } catch (_) {}
  };
  es.onerror = () => {
    es.close();
    setTimeout(connect, 2000);
  };
}

bootstrap();
connect();
