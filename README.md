# cardgw — 卡密资源下载网关

自研 Go 实现的卡密授权下载网关，底层对接 **OpenList**（文件存储 + 签名直链）。用于"外部分发卡密 → 用户到站点兑换/下载资源"的分发授权闭环。

> 内部分发用途。卡密可绑定**具体资源**（推荐）或按**路径前缀**（兼容旧模型）。

## 架构

```
                兑换页 /redeem (输卡号+密钥)
                       │ POST /api/redeem
                       ▼
用户 ── GET /dl/<path>?card=<id>&key=<secret> ──▶ [cardgw :8080]
       │                                          │ ① 验卡:存在/未过期/次数>0/资源匹配
       │                                          │ ② 调 OpenList /api/fs/get 拿签名直链(自动重登)
       │                                          │ ③ 扣次数 → SQLite
       │                                          │ ④ 302 到签名直链(仅带 sign)
       ▼                                          ▼
  [OpenList :5244] ◀─────────────────────── /p/<path>?sign=... (防盗链,无sign 401)
```

- 网关监听 `127.0.0.1:8080`（本机回环，由 nginx 反代对外）
- 存储：SQLite（`card_id`+`secret` 验卡、`quota` 次数、`resources`/`prefixes` 授权、`expires_at` 到期、`revoked` 吊销）
- 前置：需外部提供一个 OpenList（或任意提供"按路径取签名直链"API 的后端）

## 环境要求

- Go 1.26+（开发/构建）
- OpenList 实例（生产必需，提供 `/api/fs/get` 签名直链接口）；配置见 `config.yaml.example`
- 部署运行：Linux x86_64（`CGO_ENABLED=0` 交叉编译产物）

## 构建

```bash
# 开发验证
gofmt -w *.go && go vet ./... && go test -count=1 ./...

# 本机跑
go build -o cardgw .

# 交叉编译部署(DGN-VPS linux amd64)
CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -o cardgw-linux-amd64 .
```

## 卡模型（两种，resourghace 优先）

| 模型 | CLI | 授权判断 | 适用 |
|---|---|---|---|
| **资源绑定卡**(推荐) | `--resource "pub/a.zip,pub/b.txt"` | 精确匹配 `HasResource` | 卖具体一份资源 |
| **前缀权限卡**(兼容旧) | `--prefix /pub/,/share/` | 前缀 `Allowed` | 会员整目录下载 |

## CLI 用法

```bash
# 启动网关(需 config.yaml)
cardgw serve -config config.yaml

# 生成资源绑定卡: 1份资源, 可下3次, 30天有效
cardgw gencard --quota 3 --resource "pub/manual.txt,pub/sample.zip" --days 30

# 生成前缀卡(旧模型)
cardgw gencard --quota 10 --group vip --prefix /pub/,/share/ --days 30

# 查卡/吊销
cardgw listcards
cardgw revokecard --card <卡号>
```

生成资源卡后输出示例：

```
卡已生成: 卡号=27b63edc 密钥=94549883c84bf467
  次数=3 权限组=member 资源=[pub/manual.txt pub/sample.zip] 到期=2026-09-15
兑换页: https://download.mangoqwq.com/redeem
```

把 `卡号+密钥` 分发给购买者；他们到兑换页输入即可列出并下载绑定资源。

## 兑换页

GET `/redeem` 返回内嵌 HTML（`redeem_html.go` 常量，单二进制无静态依赖）：

1. 用户输入卡号 + 密钥
2. 前端 `POST /api/redeem` → 后端校验 → 返回绑定资源列表（name/path）
3. 用户点击资源 → 跳 `/dl/<path>?card=&key=` → 网关鉴权 → 302 签名直链下载

兑换 API 响应：

```json
{"code":200,"msg":"ok","quota":3,"resources":[{"name":"manual.txt","path":"pub/manual.txt"}]}
```

错误：`400`(缺参) / `403`(卡号不存在/密钥错误/过期/吊销/次数用完/未绑定该资源)。

## nginx 反代参考

```nginx
location /dl/    { proxy_pass http://127.0.0.1:8080; ... }
location /redeem { proxy_pass http://127.0.0.1:8080; ... }
location /api/   { proxy_pass http://127.0.0.1:8080; ... }   # 兑换 API
location /p/     { proxy_pass http://127.0.0.1:5244; ... }   # OpenList 签名直链前缀
```

> ⚠️ `/p/` 必须反代到 OpenList，否则 302 后的签名直链 `/p/*` 会落到应用层 → 404。

## 部署到服务器（systemd 参考）

```bash
scp cardgw-linux-amd64 root@host:/root/cardgw/cardgw
systemctl restart cardgw          # 升级; 先备份旧二进制与 cards.db
curl -s 127.0.0.1:8080/health     # {"status":"ok"}
```

## 测试

`cardstore_test.go` / `openlist_test.go` 覆盖：卡创建/验卡/过期/吊销/次数扣减、资源绑定与精确授权、前缀兼容、OpenList token 失效自动重试。运行 `go test -count=1 ./...`。

## 兼容性 / 迁移

- 旧库无 `resources` 列：`openDB` 自动 `ALTER TABLE ADD COLUMN`（幂等）。
- 旧前缀卡继续按 `prefixes` 授权，与新资源绑定卡并存。

## LICENSE

[MIT](./LICENSE) © dengyie