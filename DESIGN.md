# 授权服务设计与验证

## 业务合同

一次额度代表成功签发一份短时下载授权，不代表文件传输完成。凭证唯一，资源固定，同凭证恢复不再次扣次也不延长恢复窗口。已发出的后端签名 URL 的撤销能力由 OpenList 决定。

## 职责

- `main.go` / `config.go`：装配、严格配置、版本、优雅停机。
- `http_handlers.go` / `ratelimit.go`：输入边界、IP 信任、响应、错误映射和请求计数。
- `redemption_service.go`：总时间预算、后端访问、释放占用、提交结果不确定时只读核对。
- `grant_store.go`：凭证创建、租约竞争、条件提交、审计与清理。
- `cardstore.go`：卡校验、授权规则和管理。
- `migrations.go` / `migrations/001.sql`：事务迁移、版本与 UTC 毫秒格式。
- `openlist.go`：可取消认证刷新、generation 保护、协议解析、错误脱敏。
- `gen.go` / `cli_validation.go` / `backup.go`：发卡管理、写前校验、一致性备份。
- `web/`：无依赖页面与 DOM 行为测试；`web_embed.go` 保持单二进制。

## 正确性边界

`acquire` 和 `finish` 在获得 SQLite 事务后刷新时间，避免等待连接时仍用过期的校验时刻。SQLite DSN 为每条连接应用 foreign_keys、busy_timeout，并使用 immediate 写事务。网络调用在事务之外。

`finish` 检查 state、claim_id、lease_until、credential expiry、卡状态、绑定和额度。`quota_events.grant_id` 主键确保每份授权唯一事件；卡扣次、事件和结果同一事务提交。释放也带 claim_id 条件。

提交结果不确定时只读查询 issued 状态，不启动新的操作、不猜测退款；客户端按原凭证重试恢复。结果 URL 视为敏感信息，不进入普通日志或错误消息。

公开文件保护是纵深防护：网关对 public_prefixes 拒绝签发，但 nginx/OpenList 仍必须从根本上隔离受保护数据。绝对下载 URL 另受主机白名单限制。签名有效期来自管理员核验的最短剩余期限，代码不能推断外部存储签名合同。

## 测试覆盖

| 测试文件 | 关键行为 |
|---|---|
| cardstore_test.go | 新卡、精确资源授权、前缀、吊销、真正过期、旧表迁移 |
| grant_store_test.go | 清理与处理中状态、吊销竞态、租约接管、零余额恢复、最后一次额度竞争 |
| migrations_test.go | 旧明文/旧 token 迁移、跨重启恢复、未来版本、迁移失败回滚、等待连接时过期 |
| download_test.go | HTTP 授权/重试/吊销、GET/HEAD不扣次、后端失败/取消/超时、公开资源、前缀、输入边界、编码往返 |
| http_boundary_test.go | 代理伪造与端口绕过、配置核验、输入长度、URL主机限制、清理保留期、资源变更和凭证到期 |
| openlist*_test.go | 登录、刷新、并发、迟到401、取消、响应大小、读取错误、协议错误、敏感信息和重定向 |
| cli_test.go / backup_test.go | 非法输入写前拒绝、永久卡、只读备份、不覆盖、失败清理 |
| web/frontend.test.cjs | 原始错误复现、DOM提交、复制兜底、重试credential、并发合并、主题异常、旧链接确认 |

## 剩余边界

- 未实现严格一次性文件传输或签名 URL 即时撤销。
- 页面刷新后不保留凭证，避免引入持久卡密存储；需凭已有签名链接下载或重新兑换。
- 未删除 acg-faka 或前缀卡能力；生产使用证据不足，见 production-readiness。
- 当前阶段提供请求计数、错误分类和结构化耗时日志，不包含独立 Prometheus 服务；容量需使用实际工作负载测量。
- 本分支包含 schema 升级，应作为单独协议版本发布，不能按仅替换旧二进制的方式上线。
