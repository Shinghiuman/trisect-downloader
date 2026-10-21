'use strict';
/**
 * 本地真实 BT 种子群（用于离线验证真实下载流程）
 *  - 启动一个真实的 BitTorrent HTTP Tracker（bittorrent-tracker）
 *  - 生成一个 8MB 的种子文件并作为 Seeder 持续做种
 *  - 输出 .torrent 与 magnet，供下载器客户端连接
 * 用法：node test/swarm.js [--mb 8] [--port 8000] [--out test/out]
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const args = process.argv.slice(2);
const getArg = (name, def) => {
  const i = args.indexOf('--' + name);
  return i >= 0 ? args[i + 1] : def;
};

const MB = getArg('mb', '8');
const TRACKER_PORT = Number(getArg('port', '8000'));
const OUT_DIR = path.resolve(getArg('out', path.join(__dirname, 'out')));

(async () => {
  const { default: WebTorrent } = await import('webtorrent');
  const { default: TrackerServer } = await import('bittorrent-tracker/server');

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const dataDir = path.join(OUT_DIR, 'seed-data');
  fs.mkdirSync(dataDir, { recursive: true });

  // 1) 造一个真实文件（内容随机，便于 SHA1 校验）
  const total = Number(MB) * 1024 * 1024;
  const fileName = `sample-payload-${MB}MB.bin`;
  const filePath = path.join(dataDir, fileName);
  if (!fs.existsSync(filePath) || fs.statSync(filePath).size !== total) {
    const fd = fs.openSync(filePath, 'w');
    let written = 0;
    while (written < total) {
      const n = Math.min(1024 * 1024, total - written);
      fs.writeSync(fd, crypto.randomBytes(n));
      written += n;
    }
    fs.closeSync(fd);
  }
  const sourceSha1 = crypto.createHash('sha1').update(fs.readFileSync(filePath)).digest('hex');

  // 2) 真实 Tracker
  const tracker = new TrackerServer({ http: true, udp: false, ws: false, stats: false });
  await new Promise((res, rej) => {
    tracker.once('error', rej);
    tracker.listen(TRACKER_PORT, '127.0.0.1', res);
  });
  const announce = `http://127.0.0.1:${TRACKER_PORT}/announce`;
  const trackerInfo = tracker.http.address();
  console.log(`[tracker] http://127.0.0.1:${trackerInfo.port}/announce`);

  // 3) Seeder（真实做种客户端）
  const client = new WebTorrent({ dht: false, lsd: false, tracker: { announce: [announce] } });
  client.on('error', (e) => console.error('[seeder] error', e.message));

  client.seed(filePath, { announce: [announce], private: true }, (torrent) => {
    const torrentFile = path.join(OUT_DIR, 'test.torrent');
    fs.writeFileSync(torrentFile, torrent.torrentFile);
    console.log('[seeder] ready');
    console.log('  file      :', filePath);
    console.log('  size      :', total, 'bytes');
    console.log('  sha1      :', sourceSha1);
    console.log('  infoHash  :', torrent.infoHash);
    console.log('  torrent   :', torrentFile);
    console.log('  magnet    :', torrent.magnetURI);
    fs.writeFileSync(
      path.join(OUT_DIR, 'swarm.json'),
      JSON.stringify({ fileName, filePath, size: total, sha1: sourceSha1, infoHash: torrent.infoHash, torrentFile, magnet: torrent.magnetURI, announce }, null, 2)
    );
    console.log('[seeder] 做种中，Ctrl+C 结束');
  });

  process.on('SIGINT', () => {
    try { client.destroy(); } catch (_) {}
    try { tracker.close(); } catch (_) {}
    process.exit(0);
  });
})().catch((e) => {
  console.error('swarm 启动失败:', e);
  process.exit(1);
});
