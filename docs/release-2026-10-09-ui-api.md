# 2026-10-09 UI/API 根因修复与发布验收

## 状态

开发分支 `codex/download-ui-api` 已 rebase 到 `origin/main=53b32a2`。验证码替换、Review 修复与退役清理已完成本地/隔离验收，正在准备发布提交；**此处记录时尚未切换生产、合并 main 或推送 GitHub**。用户已分别批准删除 `frontend_handler.go`、`frontend_handler_test.go`，两文件已分两次移除，删除后 Go race/vet 再次通过。

前端独立构建，Go 纯 API。首页、详情、兑换、购买、查单、登录/注册/找回密码、账户概览已重构；账户深层操作和后台仍是原 PHP 页面。

## 已执行验证

| 检查 | 结果 |
|---|---|
| `go vet ./...` | 通过 |
| `go test -race -count=1 ./...` | 通过 |
| Node 单元/协议/构建/开发代理 | 44 项通过 |
| 真实 Chrome 浏览器 | 52 项通过，含多标签验证码、乱序/网络/解码超时、PHP 后台/安全页、桌面/移动和异常回归 |
| Prettier 检查与独立 build | 通过，21 项版本化资产，另提供字节相同的 no-store `/ui/captcha.js` |
| Python 备份/发布 | 9 项通过；修正测试用 SQLite 连接未关闭的警告 |
| 真实 nginx 1.18 隔离边界 | 12 项通过，含验证码模块/CSP、真实客户端头覆盖；本机 skip 不计为通过 |
| PHP 8.2 全文件语法检查 | 通过 |
| PHP 八套隔离回归 | sqlite、bill、migration、orders、card-deletion、storefront、captcha、captcha-callers 全部通过；storefront 261、captcha 106、callers/rendering 72 断言 |
| Linux amd64 静态构建 | 前轮通过；本次最终提交后重新构建并核对版本后方可发布 |

浏览器证据：本地 `frontend/test-results/1791501989920-57744/`（52 项完整运行），包含首页亮/暗、移动首页、移动商品、桌面商品与订单截图。已实际查看新增验证码的移动商品截图，150×50 图片、输入与按钮无横向溢出。模拟商品、账户、卡密仅存在测试环境，不打包到生产。

nginx 证据：pxed `/tmp/cardgw-nginx-boundary-ywxwb20g/`。测试以私有端口、假 Go/PHP/文件接口及临时静态文件运行，不接触现网卡密与订单。

PHP 证据：pxed `/srv/acg-rootfs/tmp/cardgw-ui-final-php.pGh65P2L/`。复制固定公开源码到新的 `commerce-suite-fresh`，确认 marker、Composer 文件哈希、空 29 表 schema 与完整性后执行测试；未读取生产客户数据。首次配置了不匹配的 TMPDIR，被 fixture 防护拒绝；调整为正确私有根并新建 fixture 后全过，未削弱该防护。

## 已确认并修复

完整依据、触发条件、最小方案及测试在 [Review](review-2026-10-09-ui-api.md)。重点包括：校验/签发凭证竞态、抢购时区、支付表单生命周期、编码返回地址、开发代理只读边界、nginx 规范化与缓存/请求大小、退役 Go UI 清理及验收链路接入。

验证码按用户要求采用固定 xianyu 登录协议。旧 PHP 的“第二张图片覆盖第一张答案”和“0000 恒拒绝”已在固定公开源码中复现；新系统按独立 ID/scene/IP/TTL 单次校验，不依赖 session。不移植 Codex User-Agent 豁免，不改邮件/SMS 最终验证码、SSO、TOTP 或财务事务。

发布前新增两项证据：解码挂起测试原失败，扩展整个图片加载的中断范围后通过；生产缺少 `runtime/mode/trusted_proxies`，默认 Client 把两个不同转发地址都解析为 `127.0.0.1`。配套发布必须启用已有 mode=1、仅信任 IPv4/IPv6 回环 nginx。隔离真实 Client 与 nginx 头覆盖测试已通过，不能遗漏该部署配置。

## 生产发布前置与步骤

1. 两份退役文件已获确认并分别删除；完成最终检查/提交。检查主 worktree 干净、拉取远端；本 UI 分支已 rebase 并复验，发布前若 main 再变化则重新集成验证。
2. 只读确认 pxed 服务状态、当前二进制/配置/UI/PHP 哈希；任何漂移都停止发布核对。
3. 保存二进制、受限配置、nginx 站点配置、前端目录与两个 SQLite 一致性快照，不覆盖已有备份，不触发保留期清理。
4. 独立静态根使用 `/var/www/download-ui/current`，候选版保留前次指纹资源，验证大小、哈希和 worker 读取权限。先用回环监听验证完整候选前端及实际只读 API。
5. Go 配置只移除退休的 UI 键；33 份 PHP overlay 的旧哈希已与现网及固定参考逐项交叉核对，仅替换实际不同的源码/模板/JS，新 CaptchaStore 原不存在。保存原源码和两份 IP 配置前置状态；不重放任何 schema 迁移。
6. 在候选验证及备份完成后，受控停止 PHP，成套安装新验证码及 IP 配置、切换独立前端与 nginx，再恢复 PHP/更新 Go。nginx 保持原监听地址并 graceful reload；确认实际 worker 与响应。常规备份加入 `/var/www/download-ui` 和本次证据；停止并确认备份进程退出后，将准确识别的最旧完整快照移到同文件系统、不受 retention 扫描的保留目录，再更新配置、启动并验证新快照。retain=28 和 interval=21600 保持不变，不删除快照、不重启无关服务。
7. 公网验证 HTML、版本化 JS/CSS、公开目录/引导 API、旧链接确认、私有接口遮蔽、异常路径与无副作用错误响应。不真实下单、不签发真实授权、不下载 >10 MB 公开包。
8. 更新 GitHub 分支与 main、核对远端 ref/CI；就地更新 Obsidian canonical、router/MOC 并执行健康检查。

## 先前暂存证据（未激活，不能作为验证码版候选）

- 发布目录：`/root/cardgw/releases/ui-api-20261009.c1Pc7tJU`，`staging.json` 的 phase 为 `staged-not-activated`。
- 发布前备份：该目录的 `backup/` 保存二进制、配置、nginx 站点、旧前端与分别一致性的 Go/PHP SQLite 快照；未替换生产数据库。
- 旧候选静态目录：`/var/www/download-ui/releases/914ca50aa8ef9531a220328f`，保留三份前次指纹目录。验证码变更后此候选已过时；本次最终构建版本为 `b643fe394262c88cf4113f2d`，必须另行暂存和验收。旧候选不删除。
- 续作只读复核：线上六项服务 RUNNING，二进制/配置/原 HTML/nginx/PHP 两文件哈希均与 staging 基线相符；GitHub main 仍为 `53b32a2`，尚无远端 `codex/download-ui-api`。
- 常规备份清单尚未包含新静态目录，当前 retain=28、完整快照=28；此项只是核对与方案记录，尚未修改备份配置、移动快照或重启服务。
- 删除确认与清理已完成。最终发布仍需最终提交后的 Linux 构建、最新候选回环验收、PHP/UI/代理配置切换、公网验收及 GitHub/文档闭环；不能将本节当成上线完成证明。

## 回滚边界

本次不修改业务数据库 schema。验证码临时库独立于商城库。回滚必须成套恢复本次发布前的 PHP 源码/模板/JS/IP 配置、Go 二进制及配套配置、nginx 和前端指向；原 `/root/cardgw/frontend/dist` 保留。新文件若需退出使用，应移到私有证据目录而非无授权删除。不能把更早的迁移前程序连到当前库，也不能通过恢复 DB 快照丢弃发布后的新订单、卡、吊销或扣次。

宿主长期可用性、真实支付渠道和历史 OpenList 永久签名/克隆密钥的撤销不由本次模拟测试证明。没有执行真实付款、轮换密钥或处置旧主机；这些不应被表述成“全部线上业务已压测”。
