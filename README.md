<div align="center">

<img src="brand/logo.png" alt="DownloadHub Logo" width="120" height="120" />

# DownloadHub

**现代化全功能开源数字资源下载站与安全资产分发平台**  
**Modern high-performance digital resource download platform & asset distribution hub.**

[![Go Version](https://img.shields.io/badge/Go-1.26+-00ADD8?style=flat&logo=go)](https://golang.org)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Zero Runtime Deps](https://img.shields.io/badge/Frontend-Zero%20Runtime%20Deps-brightgreen)](frontend/)
[![Storage Gateway](https://img.shields.io/badge/Storage-OpenList%20%7C%20S3%20Compatible-blue)](https://github.com/OpenListTeam/OpenList)
[![Architecture](https://img.shields.io/badge/Architecture-Decoupled%20SPA%20%2B%20Go%20API-orange)](docs/frontend-architecture.md)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-purple.svg)](CONTRIBUTING.md)

[English](#english-overview) · [中文文档](#中文说明) · [架构设计](DESIGN.md) · [前端架构](docs/frontend-architecture.md) · [快速上手](#快速上手)

</div>

---

## 📖 平台介绍 (About DownloadHub)

**DownloadHub** 是一套开箱即用、前后端分离的高性能现代化数字资源下载站。它不仅支持**公开文件免密直链分发**，还深度集成了**卡密核销兑换**、**付费资源商城**与**对象存储临时签名安全分发**，帮助团队与独立创作者轻松构建属于自己的数字资产展台。

- **前台展示**：现代化单页应用（SPA），涵盖首页资源网格、分类导航、实时搜索、商品详情展示、卡密核销兑换、订单查询与账户中心。
- **授权核心**：基于 Go + SQLite `IMMEDIATE` 事务实现的高性能后端，提供严格的租约锁（Lease Claim），高并发抢购和多线程兑换下**绝对杜绝超额扣次与重复核销**。
- **存储加速**：对接 OpenList 或标准 S3 对象存储，生成受保护的防盗链短时下载直链，大文件传输完全走存储 CDN，**不耗费下载站服务器任何中转带宽**。

---

## 🌟 核心特性 (Key Features)

### 🎨 现代化前端展台 (Modern Storefront)
- **零 npm 运行时依赖**：基于原生 ES Modules (Vanilla JS) 打造，体积超轻，加载秒开。
- **三态无缝自适应主题**：浅色、深色、跟随系统无闪烁即时切换，内置 Tabler 精美图标体系。
- **沉浸式资源浏览**：支持按分类筛选、关键词防抖实时搜索、富文本描述安全渲染（防 XSS 元素白名单重建）。
- **全平台响应式适配**：完美适配桌面大屏、iPad 与各类移动端触控屏。

### 🔒 银行级卡密与授权交易 (Transactional Security)
- **两阶段安全兑换**：
  1. *Redeem 验卡*：验证卡号/密钥有效性及可用资源列表，发放内存短效凭证，**不扣额度**；
  2. *Grant 签发*：用户明确点击下载后才进入事务扣除额度并签发短时存储签名；网络异常可凭原凭据**幂等恢复**，绝不二次扣减。
- **多模式发卡支持**：支持按具体资源文件绑定（`--resource`）或路径前缀批量授权（`--prefix`），支持设定次数或永久有效。
- **防刷限流与人机验证**：内置 IP 滑动窗口速率限制与基于 SQLite 的独立 ID 图像验证码系统，有效防御自动化恶意扫卡。

### ⚡ 极速与安全分发 (Secure Distribution)
- **源站零暴露**：后端动态向上游存储请求生成带有效期的签名链接，外部访客完全接触不到真实文件存储桶凭证。
- **公开文件白名单穿透**：针对公开免密资源（如客户端、测评脚本）支持配置高速缓存前缀（`/pub/`）。
- **内置数据热备与管理 CLI**：支持通过命令行零停机生成卡密、查询、吊销，并利用 SQLite `VACUUM INTO` 导出秒级一致性快照。

---

## 🏛️ 系统架构 (Architecture)

```text
       ┌────────────────────────┐
       │   Browser / Visitors   │
       └───────────┬────────────┘
                   │ HTTPS Request
                   ▼
       ┌────────────────────────┐
       │      Nginx Ingress     │ ◄─── Independent Static Dist (SPA Shell & Assets)
       └───────────┬────────────┘
                   ├─────────────────────────────────────────┐
                   │ /api/* (Core JSON API)                  │ /p/* (Signed Large Files)
                   ▼                                         ▼
   ┌────────────────────────────────┐        ┌────────────────────────────────┐
   │       DownloadHub Server       │        │       OpenList / S3 Storage    │
   │       (Go Engine :8080)        │───────►│    (High-Speed Stream Storage) │
   └───────────────┬────────────────┘ Sign   └────────────────────────────────┘
                   │                                         ▲
                   │ Atomic Transactions                     │ Validate Signature
                   ▼                                         │
   ┌────────────────────────────────┐                        │
   │       cards.db (SQLite)        │────────────────────────┘
   │   (Cards, Quotas, Audit Log)   │
   └────────────────────────────────┘
```

---

## 🚀 快速上手 (Quick Start)

### 1. 编译构建

运行环境要求：**Go 1.26+** 以及 **Node.js 22+**（仅用于前端资源打包）：

```bash
# 克隆仓库
git clone https://github.com/dengyie/DownloadHub.git
cd DownloadHub

# 编译后端单一可执行程序
make build
# 产物生成在当前目录 ./downloadhub

# 构建前端静态产物 (产物输出至 frontend/dist)
npm --prefix frontend ci --ignore-scripts
npm --prefix frontend run build
```

如需部署至 Linux 服务器，可直接交叉编译：
```bash
make build-linux
# 产物生成在 ./downloadhub-linux-amd64
```

### 2. 配置文件说明

复制配置模板：
```bash
cp config.yaml.example config.yaml
```

编辑 `config.yaml` 关键字段：
```yaml
listen: "127.0.0.1:8080"
db_path: "./cards.db"
openlist_url: "http://127.0.0.1:5244"
openlist_admin_user: "admin"
openlist_admin_pass: "your_password"

# 兑换后在途凭据有效期（秒）
grant_window_seconds: 600

# 存储签名最短有效剩余时间（秒，防止发出即将失效的外链）
openlist_min_url_ttl_seconds: 3600

# 允许签发的外链域名白名单
download_hosts: ["download.example.com"]

# 信任代理 IP 网段（仅允许本机 Nginx 回环传导真实客户 IP）
trusted_proxy_cidrs: ["127.0.0.1/32"]
```

### 3. 卡密生成与管理 CLI

```bash
# 生成新卡密：包含 3 次下载额度，绑定 private/release-v1.zip，30 天有效期
./downloadhub gencard --quota 3 --resource private/release-v1.zip --days 30 --db cards.db

# 生成永久多资源卡密（--days 0 代表永久有效，支持逗号分隔多个资源路径）
./downloadhub gencard --quota 10 --resource private/doc.pdf,private/setup.exe --days 0 --db cards.db

# 查看所有已发卡状态与额度
./downloadhub listcards --db cards.db

# 吊销指定卡密
./downloadhub revokecard --card <CARD_ID> --db cards.db

# 生产环境零停机热备份（VACUUM INTO 一致性热快照）
./downloadhub backup --db cards.db --out cards-snapshot.db
```

### 4. 运行服务与部署

```bash
./downloadhub serve --config config.yaml
```

结合 Nginx 托管前端与反代 API，完整的生产级 Nginx 配置示例请参考 [deploy/download-nginx.conf.example](deploy/download-nginx.conf.example)。

---

## 📡 核心 API 端点

| 方法 | 端点 | 说明 | 是否扣费 |
|---|---|---|:---:|
| `GET` | `/`、`/redeem`、`/orders` | 独立静态前端文档路由 | ❌ 否 |
| `GET` | `/api/catalog` | 公开可下载资源列表白名单 | ❌ 否 |
| `POST` | `/api/redeem` | 校验卡密密钥，获取授权凭证与资源列表 | ❌ 否 |
| `POST` | `/api/grants` | 携带凭证发起最终签发，获取带签名下载 URL | ✅ 扣 1 次 |
| `GET` | `/health` | 服务存活健康检测接口 | ❌ 否 |
| `GET` | `/ready` | 数据库及核心组件就绪探针 | ❌ 否 |

---

## 🧪 自动化测试套件

全站配有覆盖严格边界与高并发竞态的测试套件：

```bash
# 运行完整质量门禁
make check

# 单独运行 Go 后端单元测试（带 -race 竞态检测）
go test -race -count=1 ./...

# 运行前端测试与代码规范检查
make check-frontend
```

---

<span id="english-overview"></span>
## 🌐 English Overview

**DownloadHub** is an all-in-one, modern digital asset distribution platform and download station. It combines a zero-dependency Vanilla JS storefront, a high-concurrency transactional Go API engine, and native signed streaming integrations with OpenList & S3-compatible object storages.

### Why DownloadHub?
1. **Zero Double-Spending**: Backed by SQLite `IMMEDIATE` write transactions, claim leases, and unique tokens to guarantee rock-solid idempotency under high concurrency.
2. **Bandwidth Savings**: The gateway only handles lightweight metadata and temporary signatures; the heavy lifting of multi-gigabyte file transfers is offloaded directly to your storage provider or CDN.
3. **Zero Frontend Bloat**: Clean, reactive Vanilla ES Modules frontend with native dark/light theme switching, responsive layouts, and zero client-side npm dependencies.
4. **Production Ready**: Comes with rate limiting, anti-tampering path normalizations, live backup CLI (`VACUUM INTO`), and comprehensive test suites.

### Get Started in 3 Steps
```bash
# 1. Build
go build -o downloadhub .

# 2. Issue a card key
./downloadhub gencard --quota 5 --resource private/sdk.zip --days 7 --db cards.db

# 3. Start server
./downloadhub serve --config config.yaml
```

---

## 📄 License & Community

- Licensed under the [MIT License](LICENSE).
- Contribution Guidelines: [CONTRIBUTING.md](CONTRIBUTING.md)
- Security Policy: [SECURITY.md](SECURITY.md)
