'use strict';
/**
 * 打包后 exe 的端到端验证：
 *  1) 启动 dist/TrisectDownloader-win32-x64/TrisectDownloader.exe（带 CDP 调试端口）
 *  2) 通过内嵌引擎添加真实 BT 种子（.torrent）
 *  3) 轮询进度 → 中途截图（证明真实传输中）→ 完成
 *  4) 校验落盘文件 SHA1
 * 用法：node test/verify-packaged.js [swarmDir]
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const SWARM = process.argv[2] || path.join(__dirname, 'out3');
const PORT = 7800;
const CDP = 9333;
const EXE = path.join(__dirname, '..', 'dist', 'TrisectDownloader-win32-x64', 'TrisectDownloader.exe');
const SHOT_DIR = path.join(__dirname, 'shots');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function rpc(ws, id, method, params) {
  return new Promise((res, rej) => {
    const on = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id === id) { ws.removeEventListener('message', on); m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result); }
    };
    ws.addEventListener('message', on);
    ws.send(JSON.stringify({ id, method, params: params || {} }));
  });
}

async function waitCdp(tries = 40) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${CDP}/json/version`, { signal: AbortSignal.timeout(1500) });
      if (r.ok) return true;
    } catch (_) {}
    await sleep(400);
  }
  return false;
}

async function screenshot(name) {
  try {
    const list = await (await fetch(`http://127.0.0.1:${CDP}/json/list`)).json();
    const page = list.find((t) => t.type === 'page');
    if (!page) return null;
    const ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((r) => ws.addEventListener('open', r, { once: true }));
    const { data } = await rpc(ws, 1, 'Page.captureScreenshot', { format: 'png' });
    ws.close();
    fs.mkdirSync(SHOT_DIR, { recursive: true });
    const p = path.join(SHOT_DIR, name + '.png');
    fs.writeFileSync(p, Buffer.from(data, 'base64'));
    return p;
  } catch (e) {
    console.warn('截图失败:', e.message);
    return null;
  }
}

(async () => {
  if (!fs.existsSync(EXE)) throw new Error('未找到 exe: ' + EXE);
  const swarm = JSON.parse(fs.readFileSync(path.join(SWARM, 'swarm.json'), 'utf8'));
  const torrentBuf = fs.readFileSync(swarm.torrentFile);
  console.log('exe        :', EXE);
  console.log('种子       :', swarm.infoHash, `${(swarm.size / 1048576).toFixed(0)}MB`);
  console.log('预期 SHA1  :', swarm.sha1);

  const dataDir = path.join(__dirname, 'pkg-data');
  const dlDir = path.join(__dirname, 'pkg-downloads');
  fs.rmSync(dataDir, { recursive: true, force: true });
  fs.rmSync(dlDir, { recursive: true, force: true });

  try { require('child_process').execSync('taskkill /F /IM TrisectDownloader.exe', { stdio: 'ignore' }); } catch (_) {}
  await sleep(1200);

  const childEnv = { ...process.env, TD_PORT: String(PORT), TD_DATA_DIR: dataDir, TD_DOWNLOAD_DIR: dlDir };
  // 父进程若带 ELECTRON_RUN_AS_NODE（IDE 注入），会让 exe 以 Node 模式启动而非 GUI
  delete childEnv.ELECTRON_RUN_AS_NODE;
  const child = spawn(EXE, [`--remote-debugging-port=${CDP}`], {
    env: childEnv,
    detached: false,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (d) => process.stdout.write('  [exe] ' + d.toString()));
  child.stderr.on('data', (d) => {
    const s = d.toString();
    if (!/DevTools listening|GPU|Autofill|vulkan/i.test(s)) process.stdout.write('  [exe:err] ' + s);
  });

  const BASE = `http://127.0.0.1:${PORT}`;
  let ready = false;
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`${BASE}/api/state`, { signal: AbortSignal.timeout(1500) });
      if (r.ok) { ready = true; break; }
    } catch (_) {}
    await sleep(500);
  }
  if (!ready) throw new Error('桌面应用内嵌引擎未就绪');
  console.log('内嵌引擎已就绪:', BASE);

  console.log('CDP 就绪:', await waitCdp());
  await sleep(2500);
  const shotIdle = await screenshot('packaged-01-idle');
  console.log('截图(启动):', shotIdle);

  const t0 = Date.now();
  const post = () => fetch(`${BASE}/api/tasks`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ links: '', torrents: [{ name: 'payload.torrent', base64: torrentBuf.toString('base64') }], autoStart: true }),
  }).then((r) => r.json());
  let add;
  for (let i = 0; i < 5; i++) {
    try { add = await post(); break; } catch (e) { console.log('  POST 重试', i + 1, e.message); await sleep(800); }
  }
  if (!add) throw new Error('无法连接内嵌引擎');
  if (!add.ok) throw new Error('添加失败');
  const task = add.state.tasks.find((t) => t.protocol === 'bt');
  console.log('BT 任务已创建:', task.id, task.name);

  let midShot = null;
  let done = null;
  let peakPeers = 0;
  let peakSpeed = 0;
  const samples = [];
  while (Date.now() - t0 < 300000) {
    await sleep(400);
    const st = await fetch(`${BASE}/api/state`).then((r) => r.json());
    const t = st.tasks.find((x) => x.id === task.id);
    if (!t) continue;
    peakPeers = Math.max(peakPeers, t.peers || 0);
    peakSpeed = Math.max(peakSpeed, t.speed || 0);
    const pct = t.size ? (t.downloaded / t.size) * 100 : 0;
    if (!samples.length || Date.now() - samples[samples.length - 1].at > 900) {
      samples.push({ at: Date.now(), pct, peers: t.peers, speed: t.speed, status: t.status });
      console.log(`  [${((Date.now() - t0) / 1000).toFixed(1)}s] ${t.status} ${pct.toFixed(1)}% ${(t.downloaded / 1048576).toFixed(1)}MB peers=${t.peers} ${(t.speed / 1048576).toFixed(2)}MB/s`);
    }
    if (!midShot && pct > 25) {
      midShot = await screenshot('packaged-02-downloading');
      console.log('截图(下载中):', midShot);
    }
    if (t.status === 'completed') { done = t; break; }
    if (t.status === 'error') throw new Error('下载失败: ' + t.errorText);
  }
  if (!done) throw new Error('超时未完成');
  await sleep(1200);
  const shotDone = await screenshot('packaged-03-completed');
  console.log('截图(完成):', shotDone);

  const file = done.filePath;
  const buf = fs.readFileSync(file);
  const sha = crypto.createHash('sha1').update(buf).digest('hex');
  console.log('\n=== 打包版验证结果 ===');
  console.log('状态          :', done.status);
  console.log('落盘文件      :', file);
  console.log('文件大小      :', buf.length, '/ 预期', swarm.size);
  console.log('SHA1          :', sha);
  console.log('预期 SHA1     :', swarm.sha1);
  console.log('内容校验      :', sha === swarm.sha1 && buf.length === swarm.size ? 'PASS ✅' : 'FAIL ❌');
  console.log('节点峰值      :', peakPeers);
  console.log('速度峰值      :', (peakSpeed / 1048576).toFixed(2), 'MB/s');
  console.log('总耗时        :', ((Date.now() - t0) / 1000).toFixed(1), 's');
  console.log('进度采样      :', samples.map((s) => s.pct.toFixed(0) + '%').join(' → '));

  const ok = sha === swarm.sha1 && buf.length === swarm.size;
  try { child.kill(); } catch (_) {}
  process.exit(ok ? 0 : 2);
})().catch((e) => {
  console.error('验证失败:', e.message);
  process.exit(1);
});
