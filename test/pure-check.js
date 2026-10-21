'use strict';
// 隔离测试：仅用 webtorrent 自身验证本地 swarm 能否真正传数据
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const OUT = path.join(__dirname, 'out');

(async () => {
  const { default: WebTorrent } = await import('webtorrent');
  const swarm = JSON.parse(fs.readFileSync(path.join(OUT, 'swarm.json'), 'utf8'));
  const dl = path.join(OUT, 'pure-dl');
  fs.rmSync(dl, { recursive: true, force: true });
  fs.mkdirSync(dl, { recursive: true });

  const client = new WebTorrent({ dht: false, lsd: false });
  client.on('error', (e) => console.error('[client]', e.message));

  const torrent = client.add(swarm.torrentFile, { path: dl }, (t) => console.log('[ready]', t.name, t.length));
  torrent.on('wire', (wire, addr) => console.log('[wire]', addr));
  torrent.on('download', () => {});
  torrent.on('error', (e) => console.error('[torrent error]', e.message));
  torrent.on('warning', (e) => console.error('[warn]', e.message));

  const t0 = Date.now();
  const timer = setInterval(() => {
    console.log(`  ${((Date.now() - t0) / 1000).toFixed(0)}s peers=${torrent.numPeers} dl=${(torrent.downloaded / 1048576).toFixed(2)}MB ${(torrent.progress * 100).toFixed(1)}% speed=${(torrent.downloadSpeed / 1024).toFixed(0)}KB/s`);
    if (torrent.done) {
      clearInterval(timer);
      const f = torrent.files[0];
      const p = path.join(dl, f.path);
      const h = crypto.createHash('sha1').update(fs.readFileSync(p)).digest('hex');
      console.log('DONE', p, h === swarm.sha1 ? 'SHA1 PASS' : 'SHA1 FAIL (' + h + ')');
      client.destroy();
      process.exit(0);
    }
  }, 2000);
  setTimeout(() => { console.log('TIMEOUT, peers=', torrent.numPeers); process.exit(3); }, 60000);
})();
