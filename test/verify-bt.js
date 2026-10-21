'use strict';
/**
 * BT 真实下载端到端验证：种子解析 → 连接 peer → 下载分片 → 写入文件 → SHA1 校验
 * 前置：node test/swarm.js（本地 tracker + seeder）
 * 用法：node test/verify-bt.js [baseUrl]
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const BASE = process.argv[2] || 'http://127.0.0.1:7799';
const OUT = process.argv[3] ? path.resolve(process.argv[3]) : path.join(__dirname, 'out');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function sha1(buf) {
  return crypto.createHash('sha1').update(buf).digest('hex');
}

async function waitReady(base, tries = 40) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(`${base}/api/state`, { signal: AbortSignal.timeout(2000) });
      if (r.ok) return true;
    } catch (_) {}
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

(async () => {
  if (!(await waitReady(BASE))) throw new Error('服务未就绪: ' + BASE);
  const swarm = JSON.parse(fs.readFileSync(path.join(OUT, 'swarm.json'), 'utf8'));
  const torrentBuf = fs.readFileSync(swarm.torrentFile);
  console.log('种子文件 :', swarm.torrentFile, `(${torrentBuf.length} bytes)`);
  console.log('种子 infoHash:', swarm.infoHash);
  console.log('预期 SHA1:', swarm.sha1, `(${swarm.size} bytes)`);

  const t0 = Date.now();
  const add = await fetch(`${BASE}/api/tasks`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      links: '',
      torrents: [{ name: 'test.torrent', base64: torrentBuf.toString('base64') }],
      autoStart: true,
    }),
  }).then((r) => r.json());

  if (!add.ok) throw new Error('添加任务失败: ' + JSON.stringify(add));
  const task = add.state.tasks.find((t) => t.protocol === 'bt' && t.engine === 'webtorrent');
  console.log('任务已创建:', task.id, task.name);
  const taskId = add.state.tasks[0].id;

  let last = 0;
  let done = null;
  let peakPeers = 0;
  while (Date.now() - t0 < 180000) {
    await sleep(1000);
    const st = await fetch(`${BASE}/api/state`).then((r) => r.json());
    const t = st.tasks.find((x) => x.id === taskId) || st.tasks.find((x) => x.protocol === 'bt');
    if (!t) continue;
    peakPeers = Math.max(peakPeers, t.peers || 0);
    const pct = t.size ? ((t.downloaded / t.size) * 100).toFixed(1) : '0.0';
    if (t.downloaded !== last || t.status !== 'downloading') {
      console.log(`  [${((Date.now() - t0) / 1000).toFixed(0)}s] ${t.status} ${pct}% ${(t.downloaded / 1048576).toFixed(2)}MB peers=${t.peers} speed=${(t.speed / 1024).toFixed(0)}KB/s`);
      last = t.downloaded;
    }
    if (t.status === 'completed') { done = t; break; }
    if (t.status === 'error') { throw new Error('任务失败: ' + t.errorText); }
  }

  if (!done) throw new Error('超时未完成');

  // 校验落盘文件
  const detail = await fetch(`${BASE}/api/state`).then((r) => r.json());
  const t = detail.tasks.find((x) => x.id === taskId);
  const filePath = t.filePath;
  if (!filePath || !fs.existsSync(filePath)) throw new Error('文件未找到: ' + filePath);

  const actualBuf = fs.readFileSync(filePath);
  const actualSha1 = sha1(actualBuf);
  const ok = actualSha1 === swarm.sha1 && actualBuf.length === swarm.size;

  console.log('\n=== 结果 ===');
  console.log('状态      :', t.status);
  console.log('节点峰值  :', peakPeers);
  console.log('落盘文件  :', filePath);
  console.log('文件大小  :', actualBuf.length, 'bytes (预期', swarm.size, ')');
  console.log('实际 SHA1 :', actualSha1);
  console.log('源 SHA1   :', swarm.sha1);
  console.log('校验      :', ok ? 'PASS ✅ 内容与源文件完全一致' : 'FAIL ❌');
  console.log('耗时      :', ((Date.now() - t0) / 1000).toFixed(1), 's');
  process.exit(ok ? 0 : 2);
})().catch((e) => {
  console.error('验证失败:', e.message);
  process.exit(1);
});
