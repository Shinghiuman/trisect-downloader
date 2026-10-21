# 三栖下载器 · Trisect Downloader

同时支持 **BitTorrent/磁力、eD2K、HTTP(S)** 三种协议的下载管理器，Web 版与 Windows 桌面版（Electron）双形态。

## 三种协议的真实性说明

| 协议 | 引擎 | 是否真实传输 |
| --- | --- | --- |
| HTTP / HTTPS | 自研原生引擎 | ✅ 真实下载落盘，支持 `Range` 断点续传、重定向跟随、暂停/继续/重试 |
| BitTorrent / magnet | **WebTorrent 3.0.21**（纯 JS 完整 BT 协议栈） | ✅ 真实：解析 `.torrent`、Tracker/DHT 找 peer、TCP 握手、分片请求、**SHA1 分片校验**、多文件写盘；磁力通过 `ut_metadata` 交换元数据 |
| eD2K | 协议模型（链接解析 + 源/排队/分块模型） | ⚠️ 非真实 eD2K 网络，真实 eD2K 需 aMule/amuled 的 EC 适配 |

> BT 的真实性已用本机真实 swarm 端到端验证（种子文件 / 磁力 / 打包后 exe 三种场景，SHA1 逐字节一致），
> 详见 [`test/VERIFICATION.md`](test/VERIFICATION.md)。

## 运行

```bash
# 1) 安装依赖
npm install

# 2) Web 版（浏览器访问 http://127.0.0.1:7788）
node server.js

# 3) 桌面版（开发模式）
npx electron .
```

环境变量：`TD_PORT`（端口，默认 7788；Electron 下默认 0 = 随机空闲端口）、
`TD_DATA_DIR`（任务数据）、`TD_DOWNLOAD_DIR`（下载目录）、`TD_GPU=1`（恢复硬件加速）。

默认目录：Web 版用项目内 `data/`、`downloads/`；桌面版用
`%APPDATA%\三栖下载器\data` 与 `下载\TrisectDownloads`。

## 打包 Windows exe

```bash
# 便携文件夹版（dist/TrisectDownloader-win32-x64/TrisectDownloader.exe）
npm run pack

# 单文件便携版（dist-portable/TrisectDownloader-1.0.0-portable.exe）
npx electron-builder --win portable --config electron-builder.yml
```

> 打包采用「干净暂存目录」`build/app`（只含 `server.js`、`public/`、`electron/`、生产依赖），
> 避免把测试种子数据打进包里。先生成暂存目录：
> ```bash
> mkdir -p build/app && cp package.json package-lock.json server.js build/app/ && cp -r public electron build/app/
> cd build/app && npm ci --omit=dev
> ```
> 内网环境需设置镜像：`ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/`。

## 功能

- 一次粘贴多条链接批量建任务，逐行识别协议并统计；支持拖拽/选择 `.torrent` 文件（可多选）
- 实时进度条、已下载/总大小、瞬时速度、剩余时间、BT 节点数、eD2K 源数与排队位次
- 分类：全部 / 正在下载 / 未完成 / 已暂停 / 已完成 / 失败；协议筛选：全部 / HTTP / BT / eD2K
- 并发数可调（1–8），超出并发自动排队；任务持久化，重启后续传（BT 会保存 `.torrent` 到数据目录）
- 任务详情抽屉：400 格分片矩阵、已连接节点、哈希、保存路径、原始链接、文件数
- 顶部总速度趋势图，SSE 500ms 推送，增量渲染
- 桌面版原生菜单（打开下载/数据目录、刷新、缩放、关于）

## 目录结构

```
downloader/
├── server.js              服务端：HTTP 引擎 / BT 引擎 / eD2K 模型 / SSE / REST / 静态资源
├── electron/main.js       Electron 主进程（内嵌引擎 + 窗口 + 菜单）
├── public/                index.html · style.css · app.js
├── test/
│   ├── swarm.js           本地真实 swarm：Tracker + Seeder（生成 .torrent/magnet）
│   ├── verify-bt.js       .torrent 下载端到端验证
│   ├── verify-magnet.js   磁力链接（元数据交换）验证
│   ├── verify-packaged.js 打包 exe 端到端验证（含中途截图）
│   └── VERIFICATION.md    验证报告与踩坑记录
├── build/app/             打包暂存目录（干净生产依赖）
└── dist/ dist-portable/   打包产物
```

## API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/state` | 全量快照 |
| GET | `/api/events` | SSE 实时推送 |
| POST | `/api/tasks` | `{links, torrents:[{name, base64}], autoStart}` |
| POST | `/api/task` | `{id, action}`：`pause/resume/retry/remove` |
| POST | `/api/bulk` | `{action}`：`pauseAll/resumeAll/clearCompleted/clearAll` |
| POST | `/api/settings` | `{maxConcurrent}` |
| GET | `/api/file/:id` | 取回已完成文件（BT 返回首个文件） |

## 验证

```bash
node test/swarm.js --mb 64 --port 8000 --out test/out     # 终端 A 保持运行
node test/verify-bt.js http://127.0.0.1:7799 test/out     # 需要先起一个 TD_PORT=7799 的实例
node test/verify-magnet.js http://127.0.0.1:7799 test/out
node test/verify-packaged.js test/out                     # 打包版
```
