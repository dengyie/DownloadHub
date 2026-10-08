# 2026-10-09 UI/API 根因修复与发布验收

## 状态

发布准备已通过下述验证；本记录的生产部分在实际切换后登记。开发分支 `codex/download-ui-api`，目标为最新 `origin/main`；此前线上版本为 `53b32a2`，不能把本地测试当作已上线。

前端独立构建，Go 纯 API。首页、详情、兑换、购买、查单、登录/注册/找回密码、账户概览已重构；账户深层操作和后台仍是原 PHP 页面。

## 已执行验证

| 检查 | 结果 |
|---|---|
| `go vet ./...` | 通过 |
| `go test -race -count=1 ./...` | 通过 |
| Node 单元/协议/构建/开发代理 | 44 项通过 |
| 真实 Chrome 浏览器 | 39 项通过，含桌面/移动、明暗主题和异常回归 |
| Prettier 检查与独立 build | 通过，20 项版本化资产 |
| Python 备份/发布 | 9 项通过；修正测试用 SQLite 连接未关闭的警告 |
| 真实 nginx 1.18 隔离边界 | 10 项通过；本机无 nginx 的 skip 不计为通过 |
| PHP 8.2 全文件语法检查 | 通过 |
| PHP 六套真实服务回归 | sqlite、bill、migration、orders、card-deletion、storefront 全部通过；最后一套 261 断言 |
| Linux amd64 静态构建 | 通过 |

浏览器证据：本地 `frontend/test-results/1791494031542-12735/`，包含首页亮/暗、移动首页、移动商品、桌面商品与订单截图。实际查看过桌面首页与移动商品截图，无横向溢出或控件错位。模拟商品、账户、卡密仅存在测试环境，不打包到生产。

nginx 证据：pxed `/tmp/cardgw-nginx-boundary-gwh2dmjq/`。测试以私有端口、假 Go/PHP/文件接口及临时静态文件运行，不接触现网卡密与订单。

PHP 证据：pxed `/srv/acg-rootfs/tmp/cardgw-ui-final-php.pGh65P2L/`。复制固定公开源码到新的 `commerce-suite-fresh`，确认 marker、Composer 文件哈希、空 29 表 schema 与完整性后执行测试；未读取生产客户数据。首次配置了不匹配的 TMPDIR，被 fixture 防护拒绝；调整为正确私有根并新建 fixture 后全过，未削弱该防护。

## 已确认并修复

完整依据、触发条件、最小方案及测试在 [Review](review-2026-10-09-ui-api.md)。重点包括：校验/签发凭证竞态、抢购时区、支付表单生命周期、编码返回地址、开发代理只读边界、nginx 规范化与缓存/请求大小、退役 Go UI 清理及验收链路接入。

## 生产发布前置与步骤

1. 检查主 worktree 干净、拉取远端；本 UI 分支先 rebase 到最新 main 并再次验证。
2. 只读确认 pxed 服务状态、当前二进制/配置/UI/PHP 哈希；任何漂移都停止发布核对。
3. 保存二进制、受限配置、nginx 站点配置、前端目录与两个 SQLite 一致性快照，不覆盖已有备份，不触发保留期清理。
4. 独立静态根使用 `/var/www/download-ui/current`，候选版保留前次指纹资源，验证大小、哈希和 worker 读取权限。先用回环监听验证完整候选前端及实际只读 API。
5. 配置只移除退休的 UI 键；PHP 引导源若相同不覆盖、不重启 PHP，不重放任何 schema 迁移。
6. 先就绪独立静态根并切换 nginx，验证现有 API 仍可用，再原子安装新 Go 并仅重启 cardgw。nginx 保持原监听地址，使用 graceful reload；检查实际响应和 worker，而不只看 `nginx -t`。
7. 公网验证 HTML、版本化 JS/CSS、公开目录/引导 API、旧链接确认、私有接口遮蔽、异常路径与无副作用错误响应。不真实下单、不签发真实授权、不下载 >10 MB 公开包。
8. 更新 GitHub 分支与 main、核对远端 ref/CI；就地更新 Obsidian canonical、router/MOC 并执行健康检查。

## 回滚边界

本次不修改数据库 schema。可恢复本次发布前的 Go 二进制及配套配置、nginx 站点文件和旧前端指向；原 `/root/cardgw/frontend/dist` 保留用于回滚。不能把更早的迁移前程序连到当前库，也不能通过恢复 DB 快照丢弃发布后的新订单、卡、吊销或扣次。

宿主长期可用性、真实支付渠道和历史 OpenList 永久签名/克隆密钥的撤销不由本次模拟测试证明。没有执行真实付款、轮换密钥或处置旧主机；这些不应被表述成“全部线上业务已压测”。
