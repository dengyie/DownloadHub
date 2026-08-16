# 卡密网关 cardgw (Go) — 基于 OpenList 底座的分发授权层

自研 Go 卡密网关，为 OpenList 资源提供"卡密授权下载"访问控制。支持两种卡模型：
**资源绑定卡**（推荐，一卡对应具体资源路径）与**前缀权限卡**（兼容旧模型）。

## 架构
```
用户(兑换页或直链)
   ├─ 兑换页 /redeem  输卡号+密钥 → POST /api/redeem → 列出绑定资源
   └─ 下载 GET /dl/<path>?card=<id>&key=<secret>
            │ ① 验卡:存在/未过期/次数>0/资源绑定或前缀匹配
            │ ② 调 OpenList /api/fs/get 拿 raw_url 签名直链(自动重登 token)
            │ ③ 扣次数 → SQLite
            │ ④ 302 到签名直链(仅带 sign)
            ▼
        [OpenList :5244] → 文件
```
- 网关监听 `127.0.0.1:8080`（本机回环，nginx 反代对外）
- SQLite: `cards.db`（运行期路径由配置 `db_path` 指定）
- 配置文件: `config.yaml`（OpenList base URL、服务账号、端口、db_path），示例见 `config.yaml.example`

## 卡模型
- **资源绑定卡（推荐）**: `--resource "pub/a.zip,pub/说明.txt"`，下载时精确匹配 `HasResource`，一卡只下绑定资源
- **前缀卡（兼容旧数据）**: `--prefix /pub/,/share/`，按 `Allowed` 前缀匹配
- 字段: `card_id+secret`(验卡)、`quota`(剩余次数)、`perm_group`、`prefixes`(旧)、`resources`(新)、`expires_at`、`revoked`

## CLI
```bash
cardgw serve -config config.yaml                    # 启动网关
cardgw gencard --quota 3 --resource pub/a.zip,pub/b.txt --days 30   # 资源绑定卡
cardgw gencard --quota 10 --group vip --prefix /pub/,/share/ --days 30  # 前缀卡(兼容)
cardgw listcards
cardgw revokecard --card <卡号>
```
> 注: admin 子命令直接以 `cardgw <cmd> ...` 调用（本地 ./cards.db），不要把 flag 放 serve 前。

## 开发 / 验证
```bash
gofmt -w *.go && go vet ./... && go test -count=1 ./...
CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -o cardgw-linux-amd64 .   # 交叉编译部署
```
## 兼容性说明
- 旧数据库表无 `resources` 列时，`openDB` 自动 `ALTER TABLE ADD COLUMN resources`（幂等）。
- 部署替换二进制前 `systemctl restart cardgw`；升级前备份旧二进制与 cards.db。