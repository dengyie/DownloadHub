<div align="center">

<img src="brand/logo.png" alt="OpenCardGate Logo" width="120" height="120" />

# OpenCardGate

**High-performance, transactional card-key redemption and secure asset distribution gateway.**  
**高性能、带租约事务锁的资源卡密核销与安全文件分发网关。**

[![Go Version](https://img.shields.io/badge/Go-1.26+-00ADD8?style=flat&logo=go)](https://golang.org)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Zero Runtime Deps](https://img.shields.io/badge/Frontend-Zero%20Runtime%20Deps-brightgreen)](frontend/)
[![Storage Gateway](https://img.shields.io/badge/Backend-OpenList%20%7C%20S3-blue)](https://github.com/OpenListTeam/OpenList)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-orange.svg)](CONTRIBUTING.md)

[English](#english-overview) · [中文文档](#中文说明) · [架构设计](DESIGN.md) · [API 参考](#api-端点) · [快速上手](#快速上手)

</div>

---

## 🌟 核心特性 (Key Features)

- 🔒 **严格原子事务与租约防超扣**：基于 SQLite `IMMEDIATE` 事务和动态租约分配（Lease Claim），高并发请求下严格保证每卡额度不超扣、不重复扣次。
- ⏳ **两阶段兑换与幂等恢复**：
  - **阶段 1 (Redeem)**：验证卡密有效性与权限，颁发临时短效凭证（Credential），不扣减额度。
  - **阶段 2 (Grant)**：用户显式确认后签发带防盗链签名的短时下载 URL；网络超时或重试时憑原凭证幂等恢复，不重复扣费。
- 🛡️ **存储源站零暴露**：对接 OpenList / S3 对象存储生成私有签名下载链接，直连传输不占网关带宽；公共资源支持白名单前缀穿透。
- 🎨 **现代化轻量前端**：基于纯原生 ES Modules (Vanilla JS) 构建，集成自适应三态主题（浅色/深色/跟随系统）与 Tabler 图标系统，**前端生产环境 0 npm 运行时依赖**。
- 🔐 **防刷限流与真实 IP 穿透**：严格的 CIDR 反向代理白名单校验、IP 滑动窗口限流与独立图像验证码机制。
- 🧰 **内置运维 CLI**：内置卡密生成（`gencard`）、查询（`listcards`）、吊销（`revokecard`）以及基于 SQLite `VACUUM INTO` 的零停机一致性热备份（`backup`）。

---

## 🏛️ 系统架构 (Architecture)

```text
       ┌────────────────┐
       │   Browser/User │
       └───────┬────────┘
               │ HTTPS (Client)
               ▼
       ┌────────────────┐
       │     Nginx      │ ◄─── Independent Static Dist (UI Shell & Assets)
       └───────┬────────┘
               ├────────────────────────────────────────┐
               │ /api/* (JSON API)                      │ /p/* (Signed Download)
               ▼                                        ▼
   ┌───────────────────────┐                ┌───────────────────────┐
   │     OpenCardGate      │                │   OpenList / Storage  │
   │      (Go Server)      │                │    (Signed Streams)   │
   └───────────┬───────────┘                └───────────────────────┘
               │                                        ▲
               │ Atomic Transactions                    │ Issue Signatures
               ▼                                        │
   ┌───────────────────────┐                            │
   │  cards.db (SQLite)    │────────────────────────────┘
   │ (Quotas, Leases, Log) │
   └───────────────────────┘
```

---

## 🚀 快速上手 (Quick Start)

### 1. 编译安装

要求 **Go 1.26+** 以及 **Node.js 22+**（仅用于前端构建）：

```bash
# 克隆仓库
git clone https://github.com/dengyie/opencardgate.git
cd opencardgate

# 编译后端单一可执行文件
make build

# 构建前端静态资源 (产物位于 frontend/dist)
npm --prefix frontend ci --ignore-scripts
npm --prefix frontend run build
```

也可以直接交叉编译 Linux amd64 部署包：
```bash
make build-linux
# 产物生成在 ./opencardgate-linux-amd64
```

### 2. 准备配置

复制配置文件模版并修改：

```bash
cp config.yaml.example config.yaml
```

关键配置说明：
```yaml
listen: "127.0.0.1:8080"
db_path: "./cards.db"
openlist_url: "http://127.0.0.1:5244"
openlist_admin_user: "admin"
openlist_admin_pass: "your_password"

# 客户端签发下载凭证的有效期（秒）
grant_window_seconds: 600

# 必须显式设置：核验上游存储签名最短剩余生命周期
openlist_min_url_ttl_seconds: 3600

# 允许签发的外链域名白名单
download_hosts: ["download.example.com"]

# 信任代理 IP 网段（仅允许本地 Nginx 回环传导 X-Real-IP）
trusted_proxy_cidrs: ["127.0.0.1/32"]
```

### 3. 卡密生成与管理 (CLI)

```bash
# 生成新卡：3 次下载额度，绑定 private/manual.zip，有效期 30 天
./opencardgate gencard --quota 3 --resource private/manual.zip --days 30 --db cards.db

# 生成永久多资源卡：支持逗号分隔多个资源
./opencardgate gencard --quota 10 --resource private/v1.zip,private/v2.zip --days 0 --db cards.db

# 列出所有卡密（明文密钥仅在生成时显示一次，数据库仅存哈希）
./opencardgate listcards --db cards.db

# 吊销指定卡密
./opencardgate revokecard --card CARD_ID --db cards.db

# 零停机热备份数据库 (VACUUM INTO 一致性快照)
./opencardgate backup --db cards.db --out cards-snapshot.db
```

### 4. 启动服务

```bash
./opencardgate serve --config config.yaml
```

搭配 Nginx 进行前后端协同部署，可参考 [deploy/download-nginx.conf.example](deploy/download-nginx.conf.example)。

---

## 📡 API 端点

| 方法 | 路径 | 说明 | 额度扣减 |
|---|---|---|:---:|
| `GET` | `/redeem` | Nginx 托管的卡密兑换单页前端 | ❌ 否 |
| `POST` | `/api/redeem` | 验证卡号与密钥，返回可用资源清单与在途凭据 `credential` | ❌ 否 |
| `POST` | `/api/grants` | 携带 `credential` 签发或恢复短时签名下载 URL | ✅ 最多 1 次 |
| `GET` | `/api/catalog` | 获取经白名单审核的公开可用资源清单 | ❌ 否 |
| `GET` | `/health` | 服务存活探针（建议内网访问） | ❌ 否 |
| `GET` | `/ready` | 数据库就绪与原子状态探针 | ❌ 否 |

---

## 🧪 自动化测试与质量保障

全项目拥有极高覆盖率的自动化测试套件（Go vet/race 单元测试、Nginx 隔离沙箱回归、Playwright 真实浏览器交互）：

```bash
# 运行完整质量门禁
make check

# 单独运行后端单元测试 (含 Race Detector)
go test -race -count=1 ./...

# 运行前端测试与代码规范检查
make check-frontend
```

---

<span id="english-overview"></span>
## 🌐 English Overview

**OpenCardGate** is a production-grade, transactional redemption and distribution gateway designed for digital asset distribution, paywalled software downloads, and license key verification.

### Key Highlights
1. **High Concurrency Safety**: Built with SQLite `IMMEDIATE` write transactions, unique grant tokens, and claim leases to guarantee zero double-spending under concurrent traffic.
2. **Two-Phase Redemption**: Validation does not consume quota; actual deduction occurs only upon explicit user confirmation.
3. **Decoupled Architecture**: Go powers the zero-overhead API layer; a modern Vanilla ES Module SPA handles the customer UI with zero external runtime npm dependencies.
4. **Storage Agnostic**: Integrates natively with OpenList or any S3-compatible backend to sign temporary download links without proxying large files through the gateway.

### Quick Start
```bash
go build -o opencardgate .
./opencardgate gencard --quota 5 --resource private/archive.tar.gz --days 7 --db cards.db
./opencardgate serve --config config.yaml
```

---

## 📄 License & Community

- Distributed under the [MIT License](LICENSE).
- Contribution Guidelines: [CONTRIBUTING.md](CONTRIBUTING.md)
- Security Policy & Vulnerability Disclosure: [SECURITY.md](SECURITY.md)
