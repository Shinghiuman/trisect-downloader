# 运行验证报告 — BT 真实下载 & Electron 打包

验证时间：2026-10-21 23:35–23:45（GMT+8）
运行环境：Windows 11 x64 · Node v22.22.2 · Electron 33.4.11（Chromium 130）
BT 引擎：WebTorrent 3.0.21（纯 JS BitTorrent 协议栈：BEP 3 / BEP 6 / BEP 9 / BEP 10 / BEP 19）

> 结论：**种子解析 → Tracker 找 peer → TCP 握手 → 分片请求与 SHA1 校验 → 落盘写入** 全链路在
> Web 引擎与打包后的 exe 中均真实跑通，落盘文件与做种源文件逐字节一致（SHA1 相同）。

---

## 一、验证方法

没有可用的公网 BT 环境时，用**本机真实种子群**验证（不是模拟进度条）：

1. `test/swarm.js` 启动一个**真实的 BitTorrent HTTP Tracker**（bittorrent-tracker），
   并把一个真实文件（随机字节）作为 **Seeder 持续做种**，导出 `.torrent` 与 magnet。
2. 下载器（Web 引擎或打包后的 exe）作为 **Leecher** 加入同一 swarm。
3. 双方通过 **真实 TCP 连接**交换握手、bitfield、request/piece 消息；
   下载器对每个分片做 **SHA1 校验**，全部通过后写入文件。
4. 用**源文件 SHA1** 与**落盘文件 SHA1** 对比，作为“真的下载到了正确数据”的判据。

---

## 二、验证 1：Web 引擎 + .torrent 文件（6MB）

```
$ node test/swarm.js --mb 6 --port 8000 --out test/out
[tracker] http://127.0.0.1:8000/announce
[seeder] ready  infoHash 40627b4d7ab85eab8f0a9c4872759a21debc724a  sha1 4511f9c0…

$ TD_PORT=7799 TD_DATA_DIR=test/app-data TD_DOWNLOAD_DIR=test/app-downloads node server.js
[trisect] http://127.0.0.1:7799

$ node test/verify-bt.js http://127.0.0.1:7799 test/out
种子文件 : test\out\test.torrent (7964 bytes)
种子 infoHash: 40627b4d7ab85eab8f0a9c4872759a21debc724a
预期 SHA1: 4511f9c05535dab262349097bb5e32fa22ca3987 (6291456 bytes)
任务已创建: 6ad9e446a8 test
  [2s] completed 100.0% 6.00MB

=== 结果 ===
状态      : completed
落盘文件  : test\app-downloads\sample-payload-6MB.bin
文件大小  : 6291456 bytes (预期 6291456 )
实际 SHA1 : 4511f9c05535dab262349097bb5e32fa22ca3987
源 SHA1   : 4511f9c05535dab262349097bb5e32fa22ca3987
校验      : PASS ✅ 内容与源文件完全一致
耗时      : 2.1 s
```

## 三、验证 2：磁力链接（无 .torrent，靠 ut_metadata 交换元数据，64MB）

```
$ node test/swarm.js --mb 64 --port 8100 --out test/out2
$ node test/verify-magnet.js http://127.0.0.1:7799 test/out2
磁力链接 : magnet:?xt=urn:btih:75e09e82a7334da5d28053bed17c1a39b1792d2b&dn=sample-payload-64MB.bin&tr=http%3A%2F%2F127.0.0.1%3A8100%2Fannounce
  [0.6s] 元数据已就绪 name=sample-payload-64MB.bin size=67108864 hash=75e09e82a7334da5d28053bed17c1a39b1792d2b

=== 结果 ===
磁力→元数据交换 : PASS ✅
落盘文件        : test\app-downloads\sample-payload-64MB.bin 67108864 bytes
SHA1 校验       : PASS ✅
耗时            : 2.5 s
```

## 四、验证 3：打包后的 exe（512MB，观察完整进度曲线）

```
$ node test/verify-packaged.js test/out3
exe        : dist\TrisectDownloader-win32-x64\TrisectDownloader.exe
种子       : 97703e283705766ccb95c8482788171d773b3cfc 512MB
预期 SHA1  : 2f7f090f81e5ddf4f97ad6caf3bd035fc3d48f6a
  [exe] [trisect] http://127.0.0.1:7800
  [exe] [electron] engine at http://127.0.0.1:7800
内嵌引擎已就绪: http://127.0.0.1:7800
CDP 就绪: true
截图(启动): test\shots\packaged-01-idle.png
BT 任务已创建: e7941654d3 payload
  [exe] [bt] WebTorrent engine ready
  [1.0s] downloading 0.0% 0.0MB peers=0 0.00MB/s
  [2.2s] downloading 3.1% 15.9MB peers=1 13.30MB/s
  [3.5s] downloading 7.7% 39.2MB peers=1 17.85MB/s
  [4.7s] downloading 14.0% 71.9MB peers=1 19.44MB/s
  [5.9s] downloading 18.5% 94.8MB peers=1 20.18MB/s
  [7.2s] downloading 25.3% 129.7MB peers=1 21.85MB/s
截图(下载中): test\shots\packaged-02-downloading.png
  [13.0s] downloading 50.1% 256.4MB peers=1 22.39MB/s
  [19.1s] downloading 80.3% 411.0MB peers=1 22.87MB/s
  [22.8s] downloading 96.6% 494.4MB peers=1 23.00MB/s
截图(完成): test\shots\packaged-03-completed.png

=== 打包版验证结果 ===
状态          : completed
落盘文件      : test\pkg-downloads\sample-payload-512MB.bin
文件大小      : 536870912 / 预期 536870912
SHA1          : 2f7f090f81e5ddf4f97ad6caf3bd035fc3d48f6a
预期 SHA1     : 2f7f090f81e5ddf4f97ad6caf3bd035fc3d48f6a
内容校验      : PASS ✅
节点峰值      : 1
速度峰值      : 23.02 MB/s
总耗时        : 25.2 s
进度采样      : 0% → 3% → 8% → 14% → 19% → 25% → 30% → 34% → 39% → 45% → 50% → 57% → 62% → 69% → 73% → 80% → 85% → 92% → 97%
```

截图证据（`test/shots/`）：

| 文件 | 内容 |
| --- | --- |
| `packaged-01-idle.png` | exe 启动后的主界面（引擎状态显示 WebTorrent） |
| `packaged-02-downloading.png` | BT 任务传输中：25.3%、129.7/512 MB、21.9 MB/s、节点 1 |
| `packaged-03-completed.png` | 任务完成：100%、512.0/512.0 MB，已完成计数 +1 |

---

## 五、过程中修复的问题（真实踩坑记录）

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| 下载进度始终 0%、peer 一直 reject | 做种时用 `name` 覆盖了种子名，Seeder 实际在做种一个**同名空文件**，bitfield 为空 | 去掉 `name` 覆盖，种子名与真实文件名一致 |
| `Cannot add duplicate torrent` | 同一 infoHash 被重复添加（磁力 + 种子同批提交） | 捕获该错误并复用客户端中已有的 torrent 实例 |
| exe 启动几秒后自行退出 | 该会话下 GPU 进程崩溃（`exit_code=-1073741819`）→ `GPU process isn't usable. Goodbye.` | `app.disableHardwareAcceleration()` + `--disable-gpu` + `--no-sandbox`（可用 `TD_GPU=1` 恢复硬件加速） |
| exe 报 `bad option: --remote-debugging-port` | 父进程环境带 `ELECTRON_RUN_AS_NODE=1`，exe 以 Node 模式启动 | 启动子进程时删除该环境变量 |

---

## 六、复现步骤

```bash
# 1. 起本地真实 swarm（另一个终端保持运行）
node test/swarm.js --mb 64 --port 8000 --out test/out

# 2a. 验证 Web 引擎（种子文件）
TD_PORT=7799 TD_DATA_DIR=test/app-data TD_DOWNLOAD_DIR=test/app-downloads node server.js
node test/verify-bt.js http://127.0.0.1:7799 test/out

# 2b. 验证磁力链接（元数据交换）
node test/verify-magnet.js http://127.0.0.1:7799 test/out

# 3. 验证打包后的 exe
node test/verify-packaged.js test/out
```
