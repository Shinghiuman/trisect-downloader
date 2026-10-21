'use strict';
/**
 * 磁力链接真实下载验证（无 .torrent 文件，元数据通过 ut_metadata 从 peer 交换获得）
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const BASE = process.argv[2] || 'http://127.0.0.1:7799';
const OUT = process.argv[3] ? path.resolve(process.argv[3]) : path.join(__dirname, 'out');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
  console.log('磁力链接 :', swarm.magnet);
  console.log('预期 SHA1:', swarm.sha1);

  const t0 = Date.now();
  const add = await fetch(`${BASE}/api/tasks`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ links: swarm.magnet, autoStart: true }),
  }).then((r) => r.json());
  if (!add.ok) throw new Error('添加失败');
  const btTask = add.state.tasks.find((t) => t.protocol === 'bt');
  console.log('任务已创建:', btTask.id);

  let sawMetadata = false;
  let done = null;
  while (Date.now() - t0 < 120000) {
    await sleep(600);
    const st = await fetch(`${BASE}/api/state`).then((r) => r.json());
    const t = st.tasks.find((x) => x.id === btTask.id);
    if (!t) continue;
    if (t.size && !sawMetadata) {
      sawMetadata = true;
      console.log(`  [${((Date.now() - t0) / 1000).toFixed(1)}s] 元数据已就绪 name=${t.name} size=${t.size} hash=${t.hash}`);
    }
    if (t.status === 'completed') { done = t; break; }
    if (t.status === 'error') throw new Error(t.errorText);
  }
  if (!done) throw new Error('超时');

  const buf = fs.readFileSync(done.filePath);
  const sha = crypto.createHash('sha1').update(buf).digest('hex');
  console.log('\n=== 结果 ===');
  console.log('磁力→元数据交换 :', sawMetadata ? 'PASS ✅' : 'FAIL ❌');
  console.log('落盘文件        :', done.filePath, buf.length, 'bytes');
  console.log('SHA1 校验       :', sha === swarm.sha1 ? 'PASS ✅' : 'FAIL ❌');
  console.log('耗时            :', ((Date.now() - t0) / 1000).toFixed(1), 's');
  process.exit(sha === swarm.sha1 ? 0 : 2);
})().catch((e) => {
  console.error('验证失败:', e.message);
  process.exit(1);
});
