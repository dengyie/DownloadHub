# cardgw — 卡密资源下载网关

MangoQWQ 资源站：独立静态前端 + Go/SQLite 卡密授权 API + PHP/SQLite 商城 API + OpenList 文件传输。用户输入卡密查看资源，以 POST 明确签发下载授权；同一凭证在固定有效期内可恢复，最多扣一次额度。

**UI/API 重构分支：`codex/download-ui-api`。** 前端覆盖资源目录、资源详情、兑换、购买、订单查询、登录/注册/找回密码与账户概览。充值、账单、个人资料、安全设置及后台管理继续使用原 PHP 页面。架构、路由、接口和独立部署方式见 [前后端分离说明](docs/frontend-architecture.md)，验收与实际发布状态见 [UI 重构验收](docs/release-2026-10-09-ui-api.md)，根因修复见 [生产级 Review](docs/review-2026-10-09-ui-api.md)。

历史数据库/协议升级及宿主资源问题见 [2026-10-01 发布记录](docs/release-2026-10-01.md) 和 [当时的实施状态](docs/implementation-status.md)，不要据此推断当前线上版本。禁止旧二进制接回迁移后的数据库。

## 开发与验证

要求 Go 1.26.4+、Node.js 22+、Python 3.10+；完整商城验证还需要 PHP 8.2 与 [对应扩展](commerce/README.md)。nginx 路由验收使用真实 nginx 二进制、私有回环端口和模拟 API；本机没有 nginx 时该组会明确跳过，发布前必须在 CI 或隔离环境实际运行。前端无运行时 npm 依赖，锁定的开发依赖仅用于格式检查和浏览器验收。

```sh
npm --prefix frontend ci --ignore-scripts
cd frontend
npx playwright install chromium
cd ..
make check
make build-linux
```

已有 Chrome 时可用 `PLAYWRIGHT_CHROMIUM_EXECUTABLE=/absolute/path/to/chrome make check-browser`，无需再下载浏览器。CI 安装锁定 Playwright 对应的 Chromium。

```sh
npm --prefix frontend run dev:fixture  # http://127.0.0.1:4173，显著标注的模拟预览
make check-frontend                   # Node 单元测试、格式检查、静态构建
make check-browser                    # 完整模拟交互，不使用真实卡密/支付
```

后端测试使用临时 SQLite 和本地模拟 HTTP 服务，不需要真实 OpenList 密码。PHP 测试校验固定版本公开源码的 SHA-256，使用无用户数据的 SQLite schema。浏览器截图和失败诊断分别保留于 `frontend/test-results/<run-id>/`。

## 配置与运行

复制 `config.yaml.example` 到受限配置文件，填入实际 OpenList 凭据。必须先核验签名 URL 的**最短剩余有效期**、公网可达路径及 host，再设置 `openlist_min_url_ttl_seconds` 和 `download_hosts`。示例中的 0 会阻止启动，避免用假定的期限签发可恢复授权。

```sh
go build -o cardgw .
./cardgw serve --config config.yaml
./cardgw version
```

签名地址仅允许 http/https 或根相对路径；绝对地址必须匹配 `download_hosts`。仅列入 `trusted_proxy_cidrs` 的网络对端可提供 `X-Real-IP`，其他请求按 RemoteAddr 的 IP 限流，不包含源端口。兑换和签发分别限流；每卡最多保留 500 个尚未扣次的凭证，达到上限返回 429，过期清理后恢复容量。

`public_prefixes` 必须与 nginx 公开 alias 一致。默认 `pub/` 不接受付费授权签发，避免用户为可公开获取的文件扣次；这不能替代存储侧访问隔离。

运行 `npm --prefix frontend run build`，让 nginx 独立托管 `frontend/dist`。Go 始终只提供 API/health/ready，不包含 HTML、品牌或静态文件服务；升级时从配置中移除已退役的 `frontend_dir`、`api_only`。本次 UI 重构没有修改卡密库结构、扣次协议或商城金额事务。

## 发卡与管理

资源必须实际位于受保护存储中；下面路径仅为示例，需在 OpenList 配置后使用。

```sh
./cardgw gencard --quota 3 --resource private/manual.zip --days 30 --db cards.db
./cardgw listcards --db cards.db
./cardgw revokecard --card CARD_ID --db cards.db
./cardgw backup --db cards.db --out cards-snapshot.db
```

- 明文密钥仅发卡时显示；数据库只保存 hash。禁止将真实输出粘贴到日志或提交到 Git。
- 新卡必须显式指定 `--resource` 或 `--prefix`，不按权限组自动授予目录访问权。
- `--days 0` 明确表示永久；非法整数、负数、时长溢出、未知权限组和非法路径均在打开数据库前拒绝。
- 最多 100 个资源，每条路径最多 2048 字节；支持中文、空格及字面 `%20`，拒绝含歧义分隔符、路径穿越和控制字符的路径。
- 旧前缀卡可在页面填写具体资源路径，仍校验其前缀；暂保留是因为外部分发链接使用情况未完全核实。
- `backup` 只读打开源库，使用 SQLite `VACUUM INTO` 创建一致性快照并验证 integrity_check，不迁移源库，不覆盖已有文件。其他数据库命令会按版本自动迁移，生产必须按维护窗口流程执行。

## API

| 请求 | 行为 |
|---|---|
| GET `/redeem` | nginx 提供独立前端，Go 对该路径返回 404 |
| GET/HEAD `/api/catalog` | 白名单公开资源目录，不枚举受保护存储 |
| GET/HEAD `/user/api/storefront/bootstrap` | PHP 提供公开站点/注册配置及当前用户的最小投影，no-store |
| POST `/api/redeem` | 表单 `card`、`key`；旧前缀卡另传 `resource`，返回资源凭证，不扣次 |
| POST `/api/grants` | 表单 `credential`；签发或恢复同一授权，返回 `url`、`expires_at`、`grant_id`、当前 `quota` |
| GET/HEAD `/dl/PATH?...` | 历史链接确认页；无自动签发、无扣次。浏览器清理敏感查询参数，用户点击后以 POST 确认 |
| GET `/health` | 进程版本与存活 |
| GET `/ready` | 数据库就绪及基础请求计数；不代表 OpenList 已可用 |

请求体上限 8 KiB；仅接受 POST 表单中的卡密/凭证，不接受 query 中的 API 卡密。错误使用 HTTP 状态、数字 `code`、稳定 `error` 和用户可读 `msg`。409 表示处理中或公开资源冲突；410 到期；429 限流；502 后端故障；504 总预算超时。

同一凭证重试不会重复扣次。再次点击“查看可用资源”会产生新凭证，因此是新的签发操作。凭证只保存在页面内存，刷新页面会丢失恢复入口。签发后显式点击“打开下载链接”在新页面下载，兑换页保留恢复入口，也可复制完整 URL；签名链接自身在其有效期内可能被复用，**网关不证明文件已完整下载，也不保证已发出的签名 URL 能立即撤回**。

## 状态、存储和迁移

- `ready → processing → issued`；处理中使用处理者 ID 和到期租约，旧请求不能提交或释放新租约。
- 网络请求不占数据库事务；最终事务重验卡状态/资源/额度，将扣次、唯一事件和签发结果一起提交。
- quota=0 不阻止恢复既有授权；吊销、卡到期或资源授权变化会拒绝服务端恢复。
- 依赖调用、登录和重试共用 8 秒预算；请求总预算 10 秒，写超时 15 秒。提交前取消不扣次；提交后响应丢失通过同一凭证恢复。
- 清理每分钟有界执行；过期 URL 立即进入清理范围，扣次审计默认保留 90 天。
- schema 1 将历史时间转换为 UTC epoch 毫秒，将卡资源列表转为 JSON；移除明文 secret 列和旧 download_tokens 表。
- 历史未用 token 迁移为 ready，已用/已过期 token 迁移为 expired；旧处理中 token 仅在停止全部旧写入者之后迁移为 ready。不得在线混跑新旧程序。
- 迁移在一个事务中完成，未知日期/不合法数据导致失败回滚；未来 schema 拒绝打开。不开启未经文件系统验证的 WAL。

运维备份使用 Python 3.10+ 的 `deploy/backup_snapshot.py`，生产按受限配置定期运行。

设计边界与测试矩阵见 [DESIGN.md](DESIGN.md)。

## 发布

[nginx 参考配置](deploy/download-nginx.conf.example) 演示静态前端与 API-only 网关：仅白名单页面返回 HTML，指纹静态文件使用长缓存；未知 API、缺失静态文件不会被 SPA 吞掉。`/assets/`、支付、旧账户页面及后台仍交由 PHP，`/pub/` 和 `/p/` 保持原分发职责。

这是参考配置，不是可直接覆盖现网的发布指令。发布前必须审阅实际来源版本和 nginx 差异、保存配置及源码/SQLite 一致性备份，并执行实际 nginx 检查、签名期限和受保护资源验收。`commerce/release-baseline.json` 是历史前置哈希清单；新增引导文件的 `null` 表示目标应不存在。若现网已存在这些文件或版本不同，应停止、审阅并明确更新前置哈希，不能绕过漂移保护。不得为 UI 发布重跑 MySQL→SQLite 迁移。

新状态产生业务数据后，回退数据库会丢失新增卡、吊销、授权和扣次。应优先前向修复；必须回滚时停写并对账，不能盲目恢复旧快照。

## License

[MIT](LICENSE)

前端复用组件及品牌资产另见 [第三方来源说明](frontend/THIRD_PARTY_NOTICES.md)；不替上游未声明许可证的源码作授权承诺。
