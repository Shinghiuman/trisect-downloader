'use strict';
/**
 * 三栖下载器 / Trisect Downloader — 服务端
 *  · HTTP(S)：原生引擎，真实落盘 + Range 断点续传
 *  · BitTorrent / 磁力：WebTorrent 真实协议栈（种解析、Tracker/DHT 找 peer、TCP 互联、
 *    分片下载与 SHA1 校验、文件写入），支持 .torrent 文件与 magnet 链接
 *  · eD2K：链接解析 + 源/排队/分块模型（真实 eD2K 网络需 aMule EC 适配）
 * 无外部服务依赖，可作为 CLI 运行，也可被 Electron 主进程内嵌。
 */
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { URL } = require('url');

const APP_DIR = __dirname;
const PORT = Number(process.env.TD_PORT || process.env.PORT || 7788);
const PUB = path.join(APP_DIR, 'public');
const DATA = process.env.TD_DATA_DIR || path.join(APP_DIR, 'data');
const DOWNLOADS = process.env.TD_DOWNLOAD_DIR || path.join(APP_DIR, 'downloads');
const TORRENTS = path.join(DATA, 'torrents');
for (const d of [PUB, DOWNLOADS, DATA, TORRENTS]) fs.mkdirSync(d, { recursive: true });

const STATE_FILE = path.join(DATA, 'tasks.json');

let tasks = [];
let settings = { maxConcurrent: 3 };
try {
  const raw = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  if (Array.isArray(raw.tasks)) tasks = raw.tasks;
  if (raw.settings) settings = Object.assign(settings, raw.settings);
} catch (_) {}

for (const t of tasks) {
  if (t.status === 'downloading') t.status = 'waiting';
  t.speed = 0;
  t.btTorrent = null;
}

const runtime = new Map();

/* ------------------------------------------------------------------ utils */
const MB = 1024 * 1024;
const rid = () => crypto.randomBytes(5).toString('hex');
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const safeName = (s) => String(s || 'download.bin').replace(/[\\/:*?"<>|\r\n]+/g, '_').slice(0, 160);

function detectProtocol(link) {
  const s = String(link || '').trim();
  if (/^magnet:\?/i.test(s)) return 'bt';
  if (/^ed2k:\/\//i.test(s)) return 'ed2k';
  if (/^https?:\/\//i.test(s)) return 'http';
  return null;
}

function parseEd2k(link) {
  const parts = link.split('|');
  const i = parts.findIndex((p) => /^(file|server)$/i.test(p));
  if (i < 0 || parts[i].toLowerCase() !== 'file') return null;
  return {
    name: decodeURIComponent(parts[i + 1] || 'ed2k-file.bin'),
    size: Number(parts[i + 2]) || 0,
    hash: String(parts[i + 3] || '').toUpperCase(),
  };
}

function parseMagnet(link) {
  const params = new URLSearchParams(link.slice(link.indexOf('?') + 1));
  const dn = params.get('dn') || '';
  const xt = params.get('xt') || '';
  const hash = (/urn:btih:([a-z0-9]+)/i.exec(xt) || [, ''])[1].toUpperCase();
  const trackers = params.getAll('tr');
  return { name: dn || (hash ? hash.slice(0, 16) + '…' : 'magnet-task'), hash, trackers };
}

function hashNum(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h;
}

function json(res, obj, code = 200) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

function readJson(req, cb, limit = 24 * MB) {
  let buf = '';
  let size = 0;
  req.on('data', (d) => {
    size += d.length;
    if (size > limit) { req.destroy(); return; }
    buf += d;
  });
  req.on('end', () => {
    try { cb(JSON.parse(buf || '{}')); } catch (e) { cb({}); }
  });
}

/* --------------------------------------------------------------- persist */
let persistTimer = null;
function persist() {
  if (persistTimer) return;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    const snap = {
      settings,
      tasks: tasks.map((t) => {
        const c = { ...t };
        delete c.errorText;
        delete c.btTorrent;
        delete c.runtime;
        return c;
      }),
    };
    fs.writeFile(STATE_FILE, JSON.stringify(snap, null, 2), () => {});
  }, 400);
}

/* ------------------------------------------------------------------- SSE */
const clients = new Set();
function sse(req, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write(': connected\n\n');
  clients.add(res);
  res.write(`data: ${JSON.stringify(snapshot())}\n\n`);
  const ping = setInterval(() => res.write(': ping\n\n'), 15000);
  req.on('close', () => {
    clearInterval(ping);
    clients.delete(res);
  });
}

function broadcast() {
  if (!clients.size) return;
  const payload = `data: ${JSON.stringify(snapshot())}\n\n`;
  for (const c of clients) {
    try { c.write(payload); } catch (_) {}
  }
}

function stats() {
  const active = tasks.filter((t) => t.status === 'downloading');
  return {
    speed: active.reduce((s, t) => s + (t.speed || 0), 0),
    active: active.length,
    waiting: tasks.filter((t) => t.status === 'waiting').length,
    completed: tasks.filter((t) => t.status === 'completed').length,
    error: tasks.filter((t) => t.status === 'error').length,
    paused: tasks.filter((t) => t.status === 'paused').length,
    total: tasks.length,
    byProto: {
      http: tasks.filter((t) => t.protocol === 'http').length,
      bt: tasks.filter((t) => t.protocol === 'bt').length,
      ed2k: tasks.filter((t) => t.protocol === 'ed2k').length,
    },
    engine: { bt: btClient ? 'webtorrent' : 'webtorrent-pending', ed2k: 'model', http: 'native' },
  };
}

function snapshot() {
  return {
    tasks: tasks.map((t) => ({
      id: t.id,
      name: t.name,
      url: t.url,
      protocol: t.protocol,
      size: Math.round(t.size || 0),
      downloaded: Math.round(t.downloaded || 0),
      status: t.status,
      speed: Math.round(t.speed || 0),
      peers: t.peers || 0,
      seeds: t.seeds || 0,
      queue: t.queue || 0,
      hash: t.hash || '',
      addedAt: t.addedAt,
      completedAt: t.completedAt || 0,
      filePath: t.filePath || '',
      engine: t.engine || '',
      errorText: t.errorText || '',
      files: t.files ? t.files.length : 0,
      pieceCount: t.pieceCount || 0,
    })),
    stats: stats(),
    settings,
  };
}

/* ------------------------------------------------------------- task build */
function buildTask(link, proto, body) {
  const base = {
    id: rid(),
    url: link,
    protocol: proto,
    size: 0,
    downloaded: 0,
    status: 'waiting',
    speed: 0,
    peers: 0,
    seeds: 0,
    queue: 0,
    hash: '',
    addedAt: Date.now(),
    completedAt: 0,
    filePath: '',
    engine: proto === 'http' ? 'native' : proto === 'bt' ? 'webtorrent' : 'model',
    savePath: body.savePath || DOWNLOADS,
    files: [],
    pieceCount: 0,
  };
  if (proto === 'http') {
    let u;
    try { u = new URL(link); } catch (_) { u = null; }
    let nm = (u && u.searchParams.get('name')) || (u ? decodeURIComponent(u.pathname.split('/').pop() || '') : '');
    if (!nm) nm = 'index.html';
    base.name = nm;
    base.fileName = safeName(nm);
    base.host = u ? u.host : '';
  } else if (proto === 'bt') {
    const m = parseMagnet(link);
    base.name = m.name;
    base.hash = m.hash;
    base.trackers = m.trackers.length;
    base.fileName = safeName(m.name) + '.bt';
  } else {
    const e = parseEd2k(link);
    base.name = e ? e.name : 'ed2k-file.bin';
    base.size = e ? e.size : 0;
    base.hash = e ? e.hash : '';
    base.fileName = safeName(base.name) + '.ed2k';
    base.queue = 20 + (hashNum(base.hash) % 90);
  }
  return base;
}

/* ------------------------------------------------------ HTTP real engine */
function fail(t, msg) {
  if (t.status === 'completed') return;
  t.status = 'error';
  t.speed = 0;
  t.errorText = msg || '下载失败';
  cleanupRuntime(t.id);
  broadcast();
}

function complete(t) {
  if (t.status === 'completed') return;
  t.status = 'completed';
  if (t.size) t.downloaded = t.size;
  t.speed = 0;
  t.completedAt = Date.now();
  t.queue = 0;
  cleanupRuntime(t.id);
  broadcast();
}

function cleanupRuntime(id) {
  const rt = runtime.get(id);
  if (!rt) return;
  try { rt.req && rt.req.destroy(); } catch (_) {}
  try { rt.ws && rt.ws.destroy(); } catch (_) {}
  runtime.delete(id);
}

function startHttp(t) {
  const rt = { lastBytes: 0 };
  runtime.set(t.id, rt);
  const target = path.join(DOWNLOADS, t.fileName || safeName(t.name));
  t.filePath = target;
  let existing = 0;
  try { existing = fs.statSync(target).size; } catch (_) {}
  if (t.size && existing >= t.size) existing = 0;

  const headers = { 'User-Agent': 'Mozilla/5.0 TrisectDownloader/1.0', Accept: '*/*' };
  if (existing > 0) headers.Range = `bytes=${existing}-`;
  const mod = /^https:/i.test(t.url) ? https : http;

  const onResponse = (res) => {
    if (t.status !== 'downloading') { res.destroy(); return; }
    if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
      try { t.url = new URL(res.headers.location, t.url).href; } catch (_) {}
      res.resume();
      return startHttp(t);
    }
    if (res.statusCode === 416) { res.resume(); return complete(t); }
    if (res.statusCode >= 400) { res.resume(); return fail(t, `HTTP ${res.statusCode}`); }

    const cd = res.headers['content-disposition'];
    if (cd) {
      const m = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(cd);
      if (m) { try { t.name = decodeURIComponent(m[1]); } catch (_) {} }
    }
    let total = Number(res.headers['content-length'] || 0);
    if (res.statusCode === 206) {
      const cr = /bytes\s+(\d+)-(\d+)\/(\d+|\*)/i.exec(res.headers['content-range'] || '');
      if (cr && cr[3] !== '*') total = Number(cr[3]);
      if (total) t.size = total;
    } else {
      existing = 0;
      if (total) t.size = total;
    }

    const ws = fs.createWriteStream(target, { flags: existing > 0 ? 'a' : 'w' });
    rt.ws = ws;
    ws.on('error', (e) => fail(t, e.message));
    res.on('data', (d) => { t.downloaded = (t.downloaded || 0) + d.length; });
    res.on('error', (e) => fail(t, e.message));
    res.pipe(ws);
    ws.on('finish', () => {
      if (t.status !== 'downloading') return;
      if (!t.size || t.downloaded >= t.size) complete(t);
      else fail(t, '连接提前结束，可点击继续重试');
    });
  };

  let req;
  try {
    req = mod.get(t.url, { headers }, onResponse);
  } catch (e) {
    return fail(t, e.message);
  }
  rt.req = req;
  req.setTimeout(25000, () => fail(t, '连接超时'));
  req.on('error', (e) => fail(t, e.message));
}

/* ------------------------------------------------ BitTorrent real engine */
let btClient = null;
let btBoot = null;

async function ensureBtClient() {
  if (btClient) return btClient;
  if (!btBoot) {
    btBoot = (async () => {
      const mod = await import('webtorrent');
      const WebTorrent = mod.default || mod;
      btClient = new WebTorrent({ maxConns: 120 });
      btClient.on('error', (e) => console.error('[bt] client error:', e && e.message));
      console.log('[bt] WebTorrent engine ready');
      return btClient;
    })().catch((e) => {
      btBoot = null;
      throw e;
    });
  }
  return btBoot;
}

async function startBtReal(t) {
  let client;
  try {
    client = await ensureBtClient();
  } catch (e) {
    return fail(t, 'BT 引擎加载失败：' + e.message);
  }

  if (t.btTorrent && !t.btTorrent.destroyed) {
    t.status = 'downloading';
    t.btTorrent.resume();
    return;
  }

  const fromFile = t.torrentPath && fs.existsSync(t.torrentPath);
  const source = fromFile ? t.torrentPath : t.url;

  let torrent;
  try {
    torrent = client.add(source, { path: t.savePath || DOWNLOADS }, (ready) => {
      attachTorrent(t, ready);
    });
  } catch (e) {
    const msg = e && e.message ? e.message : '';
    const dup = /duplicate torrent ([0-9a-f]{40})/i.exec(msg);
    if (dup && client.get) {
      const exist = client.get(dup[1]);
      if (exist) {
        // 同一 infoHash 已在客户端中：复用已有 torrent（共享同一份数据）
        t.btTorrent = exist;
        t.engine = 'webtorrent';
        t.status = 'downloading';
        attachTorrent(t, exist);
        if (exist.done) complete(t);
        return;
      }
    }
    return fail(t, '种子解析失败：' + msg);
  }
  t.btTorrent = torrent;
  t.engine = 'webtorrent';
  t.status = 'downloading';
  t.errorText = '';

  torrent.on('ready', () => attachTorrent(t, torrent));
  torrent.on('metadata', () => attachTorrent(t, torrent));
  torrent.on('error', (e) => fail(t, e.message || 'BT 下载失败'));
  torrent.on('warning', (e) => console.warn('[bt] warn:', e && e.message));
  torrent.on('done', () => complete(t));
  if (torrent.ready) attachTorrent(t, torrent);

  broadcast();
}

function attachTorrent(t, torrent) {
  if (!torrent || !torrent.ready) return;
  t.size = torrent.length || t.size;
  if (torrent.name) t.name = torrent.name;
  t.hash = torrent.infoHash || t.hash;
  t.pieceCount = torrent.pieces ? torrent.pieces.length : 0;

  // 首个文件路径（用于「打开文件」）
  const files = (torrent.files || []).map((f) => ({
    name: f.name,
    length: f.length,
    path: f.path ? path.join(t.savePath || DOWNLOADS, f.path) : '',
  }));
  t.files = files;
  if (files.length && files[0].path) t.filePath = files[0].path;

  // 持久化 .torrent，供重启后续传（磁力链接也能拿到完整元数据）
  if (!t.torrentPath || !fs.existsSync(t.torrentPath)) {
    try {
      const buf = torrent.torrentFile;
      if (buf) {
        const p = path.join(TORRENTS, t.id + '.torrent');
        fs.writeFileSync(p, buf);
        t.torrentPath = p;
      }
    } catch (e) {
      console.warn('[bt] torrent 持久化失败:', e.message);
    }
  }
  persist();
  broadcast();
}

/* -------------------------------------------------------------- eD2K 模型 */
function initSim(t) {
  const h = hashNum(t.hash || t.url);
  const size = t.size || (120 + (h % 900)) * MB;
  return {
    startedAt: Date.now(),
    size,
    base: (90 + (h % 780)) * 1024,
    peerTarget: 12 + (h % 90),
  };
}

function simulateEd2k(t, rt, dt, now) {
  const sim = rt.sim || (rt.sim = initSim(t));
  if (!t.size) t.size = sim.size;
  if (t.queue > 0) {
    t.queue = Math.max(0, t.queue - Math.max(1, Math.round(t.queue * 0.22 + 1)));
    t.speed = 0;
    return;
  }
  const age = (now - sim.startedAt) / 1000;
  const p = t.size ? t.downloaded / t.size : 0;
  const curve = 0.30 + 1.05 * Math.sin(Math.PI * clamp(p, 0.02, 0.98));
  const jitter = 0.82 + Math.random() * 0.36;
  const speed = clamp(sim.base * curve * jitter, 0, sim.base * 1.6);
  t.speed = speed;
  t.downloaded = Math.min(t.size, t.downloaded + speed * dt);
  const ramp = Math.min(1, age / 7);
  t.peers = Math.round(sim.peerTarget * (0.25 + 0.75 * ramp) * (0.9 + Math.random() * 0.2));
  if (t.downloaded >= t.size - 1) complete(t);
}

/* ------------------------------------------------------------- 任务控制 */
function startTask(t) {
  if (t.status === 'completed') return;
  t.status = 'downloading';
  t.errorText = '';
  if (t.protocol === 'http') startHttp(t);
  else if (t.protocol === 'bt') startBtReal(t);
  else {
    const rt = runtime.get(t.id) || {};
    runtime.set(t.id, rt);
    t.engine = 'model';
  }
  broadcast();
}

function enforceConcurrency() {
  const activeCount = () => tasks.filter((t) => t.status === 'downloading').length;
  const max = Number(settings.maxConcurrent) || 3;
  for (const t of tasks) {
    if (activeCount() >= max) break;
    if (t.status === 'waiting') startTask(t);
  }
}

/* ------------------------------------------------------------------ tick */
let lastTick = Date.now();
const tickHandle = setInterval(() => {
  const now = Date.now();
  const dt = Math.min(2, (now - lastTick) / 1000);
  lastTick = now;

  for (const t of tasks) {
    if (t.status !== 'downloading') { t.speed = 0; continue; }

    if (t.protocol === 'http') {
      const rt = runtime.get(t.id);
      if (!rt) continue;
      const delta = (t.downloaded || 0) - (rt.lastBytes || 0);
      rt.lastBytes = t.downloaded || 0;
      const inst = delta / dt;
      t.speed = t.speed ? t.speed * 0.55 + inst * 0.45 : inst;
    } else if (t.protocol === 'bt') {
      const tr = t.btTorrent;
      if (!tr) continue;
      t.downloaded = tr.downloaded || 0;
      t.size = tr.length || t.size;
      t.speed = tr.downloadSpeed || 0;
      t.peers = tr.numPeers || 0;
      if (tr.done && t.status === 'downloading') complete(t);
    } else {
      const rt = runtime.get(t.id) || {};
      runtime.set(t.id, rt);
      simulateEd2k(t, rt, dt, now);
    }
  }
  enforceConcurrency();
  broadcast();
  persist();
}, 500);

/* ------------------------------------------------------------------ 动作 */
function taskAction(body) {
  const t = tasks.find((x) => x.id === body.id);
  if (!t) return { ok: false, msg: '任务不存在' };
  const a = body.action;

  if (a === 'pause') {
    if (t.status === 'downloading' || t.status === 'waiting') {
      t.status = 'paused';
      t.speed = 0;
      if (t.protocol === 'http') cleanupRuntime(t.id);
      if (t.protocol === 'bt' && t.btTorrent) { try { t.btTorrent.pause(); } catch (_) {} }
    }
  } else if (a === 'resume') {
    if (t.status !== 'completed') {
      if (t.protocol === 'http') {
        let existing = 0;
        try { existing = fs.statSync(path.join(DOWNLOADS, t.fileName || safeName(t.name))).size; } catch (_) {}
        t.downloaded = existing;
      }
      if (t.protocol === 'ed2k') t.queue = Math.max(3, Math.round((t.queue || 0) / 3));
      startTask(t);
    }
  } else if (a === 'remove') {
    cleanupRuntime(t.id);
    if (t.protocol === 'bt' && t.btTorrent) {
      const shared = tasks.some((x) => x.id !== t.id && x.btTorrent === t.btTorrent);
      if (!shared) {
        try { t.btTorrent.destroy({ destroyStore: !!body.withFile }); } catch (_) {}
      }
      t.btTorrent = null;
    }
    if (t.protocol === 'http' && body.withFile) {
      try { fs.unlinkSync(path.join(DOWNLOADS, t.fileName || safeName(t.name))); } catch (_) {}
    }
    if (t.torrentPath) { try { fs.unlinkSync(t.torrentPath); } catch (_) {} }
    tasks = tasks.filter((x) => x.id !== t.id);
  } else if (a === 'retry') {
    t.downloaded = 0;
    t.status = 'waiting';
    startTask(t);
  }
  persist();
  broadcast();
  return { ok: true };
}

function bulkAction(body) {
  const a = body.action;
  if (a === 'pauseAll') {
    for (const t of tasks) {
      if (t.status === 'downloading' || t.status === 'waiting') {
        t.status = 'paused';
        t.speed = 0;
        if (t.protocol === 'http') cleanupRuntime(t.id);
        if (t.protocol === 'bt' && t.btTorrent) { try { t.btTorrent.pause(); } catch (_) {} }
      }
    }
  } else if (a === 'resumeAll') {
    for (const t of tasks) if (t.status === 'paused' || t.status === 'error') t.status = 'waiting';
  } else if (a === 'clearCompleted') {
    tasks = tasks.filter((t) => t.status !== 'completed');
  } else if (a === 'clearAll') {
    for (const t of tasks) {
      cleanupRuntime(t.id);
      if (t.btTorrent) { try { t.btTorrent.destroy(); } catch (_) {} }
    }
    tasks = [];
  }
  persist();
  broadcast();
  return { ok: true };
}

/* --------------------------------------------------------------- 演示文件 */
function demoStream(req, res) {
  const u = new URL(req.url, 'http://localhost');
  const mb = clamp(Number(u.searchParams.get('mb') || 60), 1, 2000);
  const size = Math.floor(mb * MB);
  const name = safeName(u.searchParams.get('name') || `demo-package-${mb}MB.bin`);

  let start = 0;
  const range = req.headers.range;
  if (range) {
    const m = /bytes=(\d+)-/.exec(range);
    if (m) start = Number(m[1]);
  }
  const head = {
    'Content-Type': 'application/octet-stream',
    'Accept-Ranges': 'bytes',
    'Content-Disposition': `attachment; filename="${name}"`,
  };
  if (range) head['Content-Range'] = `bytes ${start}-${size - 1}/${size}`;
  head['Content-Length'] = size - start;
  res.writeHead(range ? 206 : 200, head);

  const buf = crypto.randomBytes(64 * 1024);
  let sent = start;
  const tick = () => {
    if (res.writableEnded || res.destroyed) return;
    const rounds = 1 + (Math.random() < 0.35 ? 1 : 0);
    for (let i = 0; i < rounds; i++) {
      const n = Math.min(buf.length, size - sent);
      if (n <= 0) { res.end(); return; }
      res.write(n === buf.length ? buf : buf.subarray(0, n));
      sent += n;
      if (sent >= size) { res.end(); return; }
    }
    setTimeout(tick, 16 + Math.random() * 12);
  };
  tick();
}

function serveFile(req, res, id) {
  const t = tasks.find((x) => x.id === id);
  const p = pickFile(t);
  if (!p) { res.writeHead(404); return res.end('not found'); }
  fs.stat(p, (err, st) => {
    if (err) { res.writeHead(404); return res.end('file missing'); }
    res.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'Content-Length': st.size,
      'Content-Disposition': `attachment; filename="${encodeURIComponent(path.basename(p))}"`,
    });
    fs.createReadStream(p).pipe(res);
  });
}

function pickFile(t) {
  if (!t) return null;
  if (t.files && t.files.length) {
    const f = t.files.find((x) => x.path && fs.existsSync(x.path)) || t.files[0];
    return f && f.path;
  }
  return t.filePath || null;
}

/* ------------------------------------------------------------ 静态与路由 */
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
};

function staticServe(req, res, p) {
  const rel = p === '/' ? '/index.html' : p;
  const file = path.join(PUB, path.normalize(rel).replace(/^([/\\])+/, ''));
  if (!file.startsWith(PUB)) { res.writeHead(403); return res.end('forbidden'); }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404); return res.end('404'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream' });
    res.end(buf);
  });
}

function addTasksFromBody(body) {
  const links = String(body.links || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  const added = [];
  const skipped = [];

  for (const link of links) {
    const proto = detectProtocol(link);
    if (!proto) { skipped.push(link.slice(0, 60)); continue; }
    const t = buildTask(link, proto, body || {});
    t.status = body.autoStart === false ? 'paused' : 'waiting';
    tasks.unshift(t);
    added.push(t);
  }

  // .torrent 文件（base64），优先级高于同批次链接
  const torrents = Array.isArray(body.torrents) ? body.torrents : [];
  for (const item of torrents) {
    if (!item || !item.base64) continue;
    const t = buildTask('bt://' + (item.name || 'local.torrent'), 'bt', body || {});
    t.name = String(item.name || 'local.torrent').replace(/\.torrent$/i, '');
    t.url = 'file://' + t.name + '.torrent';
    t.engine = 'webtorrent';
    t.status = body.autoStart === false ? 'paused' : 'waiting';
    try {
      const buf = Buffer.from(item.base64, 'base64');
      const p = path.join(TORRENTS, t.id + '.torrent');
      fs.writeFileSync(p, buf);
      t.torrentPath = p;
      t.size = 0;
    } catch (e) {
      skipped.push(item.name || 'torrent');
      continue;
    }
    tasks.unshift(t);
    added.push(t);
  }

  persist();
  enforceConcurrency();
  broadcast();
  return { ok: true, added: added.length, skipped, state: snapshot() };
}

const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://localhost');
  const p = u.pathname;

  if (p === '/api/state') return json(res, snapshot());
  if (p === '/api/events') return sse(req, res);
  if (p === '/api/demo') return demoStream(req, res);

  if (p === '/api/tasks' && req.method === 'POST') {
    return readJson(req, (body) => json(res, addTasksFromBody(body || {})));
  }
  if (p === '/api/task' && req.method === 'POST') return readJson(req, (b) => json(res, taskAction(b)));
  if (p === '/api/bulk' && req.method === 'POST') return readJson(req, (b) => json(res, bulkAction(b)));
  if (p === '/api/settings' && req.method === 'POST') {
    return readJson(req, (b) => {
      if (b.maxConcurrent) settings.maxConcurrent = clamp(Number(b.maxConcurrent), 1, 8);
      persist();
      enforceConcurrency();
      broadcast();
      json(res, snapshot());
    });
  }
  if (p.startsWith('/api/file/')) return serveFile(req, res, p.slice('/api/file/'.length));

  return staticServe(req, res, p);
});

/* --------------------------------------------------------------- 首次种子 */
function seed() {
  if (tasks.length) return;
  const demos = [
    `http://127.0.0.1:${PORT}/api/demo?mb=48&name=ubuntu-24.04.1-live-server-amd64.iso`,
    'ed2k://|file|Fedora-Workstation-Live-x86_64-41.iso|2415919104|A3F5E6B1C4D8F2C1D7A4E9B3C6D5A1F0|/',
  ];
  for (const link of demos) {
    const t = buildTask(link, detectProtocol(link), {});
    t.status = 'waiting';
    tasks.unshift(t);
  }
  persist();
}
seed();

/* ------------------------------------------------------------------ 导出 */
function start(port = PORT) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      server.removeListener('error', reject);
      const actual = server.address().port;
      console.log(`[trisect] http://127.0.0.1:${actual}`);
      resolve(actual);
    });
  });
}

function stop() {
  clearInterval(tickHandle);
  return new Promise((resolve) => {
    if (btClient) { try { btClient.destroy(); } catch (_) {} btClient = null; }
    server.close(() => resolve());
  });
}

module.exports = { start, stop, server, snapshot, DOWNLOADS, DATA, tasks: () => tasks };

if (require.main === module) {
  start(PORT).then(() => {
    console.log('[trisect] HTTP 原生 / BitTorrent(WebTorrent) / eD2K 模型引擎已就绪');
  }).catch((e) => {
    console.error('[trisect] 启动失败:', e.message);
    process.exit(1);
  });
}
