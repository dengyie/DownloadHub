# 2026-10-09 UI/API 根因修复与发布验收

## 状态

**生产已上线并通过公网验收，业务与缓存修复已合入 GitHub main。** 2026-10-09 07:53:54（北京时间）完成 UI/API 与验证码成套切换；08:12 完成 nginx 错误缓存热更新，08:15 增加下载站专属 Cloudflare 缓存规则，08:16 公网 18 项检查全部通过。开发分支 `codex/download-ui-api` 在最新 main 上 rebase 后正常快进合入；业务提交为 `1c5150e`，缓存修正为 `8835d86`，两轮 CI 全绿。后续文档提交不改变生产 Go/UI 版本。

用户已分别批准删除 `frontend_handler.go`、`frontend_handler_test.go`；两文件已分两次移除，删除后 Go race/vet 再次通过。可从 Git 历史恢复，没有删除生产数据、备份或旧发布目录。

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
| Linux amd64 静态构建 | 通过，生产版本为 1c5150e；后续缓存/文档提交不重建业务二进制 |

浏览器证据：本地 `frontend/test-results/1791501989920-57744/`（52 项完整运行），包含首页亮/暗、移动首页、移动商品、桌面商品与订单截图。已实际查看新增验证码的移动商品截图，150×50 图片、输入与按钮无横向溢出。模拟商品、账户、卡密仅存在测试环境，不打包到生产。

nginx 最终证据：pxed `/tmp/cardgw-nginx-boundary-o456_zo8/`，12 项通过；严格 no-store 断言的旧配置失败证据保留在 `/tmp/cardgw-nginx-boundary-tfdrrr1w/`。测试以私有端口、假 Go/PHP/文件接口及临时静态文件运行，不接触现网卡密与订单。

PHP 证据：pxed `/srv/acg-rootfs/tmp/cardgw-ui-final-php.pGh65P2L/`。复制固定公开源码到新的 `commerce-suite-fresh`，确认 marker、Composer 文件哈希、空 29 表 schema 与完整性后执行测试；未读取生产客户数据。首次配置了不匹配的 TMPDIR，被 fixture 防护拒绝；调整为正确私有根并新建 fixture 后全过，未削弱该防护。

## 已确认并修复

完整依据、触发条件、最小方案及测试在 [Review](review-2026-10-09-ui-api.md)。重点包括：校验/签发凭证竞态、抢购时区、支付表单生命周期、编码返回地址、开发代理只读边界、nginx 规范化与缓存/请求大小、退役 Go UI 清理及验收链路接入。

验证码按用户要求采用固定 xianyu 登录协议。旧 PHP 的“第二张图片覆盖第一张答案”和“0000 恒拒绝”已在固定公开源码中复现；新系统按独立 ID/scene/IP/TTL 单次校验，不依赖 session。不移植 Codex User-Agent 豁免，不改邮件/SMS 最终验证码、SSO、TOTP 或财务事务。

发布前新增两项证据：解码挂起测试原失败，扩展整个图片加载的中断范围后通过；生产原缺少 `runtime/mode/trusted_proxies`，默认 Client 把两个不同转发地址都解析为 `127.0.0.1`。本次已启用已有 mode=1、仅信任 IPv4/IPv6 回环 nginx；隔离真实 Client 与 nginx 头覆盖测试通过，实机用两个 TEST-NET 地址检查各自新 challenge，确认 IP 绑定正确。

## 已执行生产变更

| 组件 | 实际部署 |
|---|---|
| Go | `/root/cardgw/cardgw`，版本 `1c5150e`；SHA-256 `a8f569795744aa9e1b9ae795995543f2aad195f6ccc788f5048dd0c08b053926` |
| 前端 | `/var/www/download-ui/current` → `releases/b643fe394262c88cf4113f2d`，nginx 独立托管，保留旧指纹目录 |
| PHP | overlay 与 SPA 同步切换；`config/app.php` 仅资源版本改为 `3.5.7-mq.20261009.1`，未升级上游内核 |
| 代理身份 | `runtime/mode=1`；trusted_proxies 仅 `127.0.0.1`、`::1`，nginx 覆盖转发头 |
| nginx | `/personal/pxed/nginx/conf.d/download.conf`，最终 SHA-256 `849ab78cbf11c50f0d8e173f91899d9b608fc8de98553651babe4b047ec11fec` |
| Cloudflare | Cache Rules ruleset `f555b0049d234f489ef8a6fc44e9f8d0` v4；新增下载站专属规则 `49a8b0b1ec8848d3b1ae5211e0c56870` |

发布目录 `/root/cardgw/releases/captcha-ui-20261009.koBJT0B1` 保存 prepared/activated、原源码/配置/前端、候选包、两份 SQLite 一致性快照与实机哈希。33 份 PHP overlay 的前置哈希与现网/固定源码逐项匹配；只覆盖有实际变化的文件。Go 仅移除退役 UI 配置键。**两个业务库 schema 前后哈希相同，没有迁移或数据恢复。**

本次仅受控重启 Go、PHP 和备份进程；nginx 使用原监听并 graceful reload，OpenList 和维护 worker 未重启。后续缓存热修只 reload nginx、更新限定站点的 CF 规则，不再重启业务服务。六项 Supervisor 服务均 RUNNING。

## 公网验证与缓存红绿证据

- 真实 Chrome 打开移动登录页，先取得两张不同 ID 的 PNG，再逐张输入人工读出的正确答案；请求故意省略账号/密码。两张均通过验证码层，返回后续的“用户名输入错误”；重放第一张返回“验证码错误”。同时验证大小写/前后空白、后台新资源版本和 blob 图片加载，无 JS 页面错误或移动横向溢出。没有真实登录、下单或付款。
- 原始 `public-verification.json` 保留了首次发现的 `/ui/.../missing.js` 404/max-age=14400，未覆盖失败证据。更严格的 nginx 测试在旧配置下五处失败，修复后 12 项通过。
- 源站 no-store 生效后，旧共享 `/pub/` CF 规则仍使缺失文件第二次请求 HIT。新增条件为 `(http.host eq "download.mangoqwq.com" and starts_with(http.request.uri.path, "/pub/"))` 的末尾规则，`cache=true`，edge/browser TTL 都 respect_origin；原三条规则逐字段核对未改变。没有全区 purge、WAF 放宽或其他站点配置修改。
- CF 刚下发时一个边缘节点仍返回旧策略，保留该次失败记录；传播后新唯一路径完整复验 **18/18 通过**：缺失 UI/品牌/pub 连续请求均 404/no-store/BYPASS、无 Age；文档/公开 API/共享验证码模块 no-store；内部探针/存储前台 404；成功指纹文件 immutable；成功公开脚本一天缓存，连续 MISS→HIT。
- Python urllib 的请求被边缘客户端检测拦截，不能当成源站行为或验证码失败；正式缓存验收使用普通 curl，无凭据/cookie/安全规则绕过。公开脚本只读取约 18 KB，没有下载大型软件包。

公网图片与首轮 JSON 在发布目录根；最终缓存证据为 `nginx-cache-hotfix/public-cache-verification-b3a087fc0c5244a3841c17abdeef476e.json`。同目录保存 CF 修改前后快照、请求配置以及 nginx 修改前后文件和激活记录。旧已缓存的不存在测试 URL 未做无意义 purge，正式验收使用新唯一路径。

## 备份闭环

- 常规备份已加入 `/var/www/download-ui` 与本次发布目录，retain=28、interval=21600 秒不变。
- 重启前把准确识别的最旧完整快照 `snapshot-20261002T205303605434-05l9m0` 从 `snapshots/` 同文件系统移动到 `/personal/pxed/backups/download/release-preserved/captcha-ui-20261009-1c5150e/`，没有删除。
- 首份新常规快照 `/personal/pxed/backups/download/snapshots/snapshot-20261008T235419937152-x60bkh` 已核对 manifest，并确认含 UI、验证码源码、代理配置和激活证据；常规完整快照仍为 28 份。
- 缓存热修后另用一次性配置在独立保留目录生成完整快照：`/personal/pxed/backups/download/release-preserved/captcha-ui-20261009-1c5150e/post-cache-hotfix/snapshot-20261009T001932378483-u3g3i6`。manifest SHA-256 为 `ea153c7a3967abde9870b11a8d59b61fcb1df97f2b7e83462f829b9bac018bff`；三个 SQLite integrity_check、全部归档 manifest、最终 nginx/UI/PHP/CF/公网证据哈希均通过。常规 28 份及配置完全未变，没有再重启服务或触发额外 retention 清理。
- 一次性备份目录不在任何备份源目录内，避免递归归档；验证记录为发布目录的 `nginx-cache-hotfix/backup-final-verified.json` 及保留目录 `verification.json`。

## GitHub 与文档交付

核心提交 `1c5150e` 的 [CI 37860750986](https://github.com/dengyie/cardgw/actions/runs/37860750986)、缓存提交 `8835d86` 的 [CI 37864095957](https://github.com/dengyie/cardgw/actions/runs/37864095957) 均全绿。fetch 最新 main 后在 feature 分支 rebase，通过普通快进 push 合入 main；业务/配置交付时远端 main 与 codex/download-ui-api 已核对一致。受保护主 worktree 保持原状，未 force push；之后只追加实际验收文档。

Obsidian 已就地更新既有《下载站项目总览》、AI-DOC-ROUTER 和项目索引，保留双链并增加验证码路由词，没有创建孤立发布笔记。健康检查 stale_hits=0；1 项缺 status、2 项缺速读均为改动前已存在的无关文档告警，本次未修改它们。

## 先前暂存证据（未激活，不能作为验证码版候选）

- 发布目录：`/root/cardgw/releases/ui-api-20261009.c1Pc7tJU`，`staging.json` 的 phase 为 `staged-not-activated`。
- 发布前备份：该目录的 `backup/` 保存二进制、配置、nginx 站点、旧前端与分别一致性的 Go/PHP SQLite 快照；未替换生产数据库。
- 旧候选静态目录：`/var/www/download-ui/releases/914ca50aa8ef9531a220328f`，保留三份前次指纹目录。验证码变更后此候选已过时；最终版本 `b643fe394262c88cf4113f2d` 已另行暂存、验收和激活。旧候选不删除。
- 这些是验证码变更前的准备记录；其候选与备份均保留，但没有激活。当前运行版本、源码回滚证据和完整备份以上方最终发布记录为准，不能重新执行早期暂存/激活脚本。

## 回滚边界

本次不修改业务数据库 schema。验证码临时库独立于商城库。回滚必须成套恢复本次发布前的 PHP 源码/模板/JS/IP 配置、Go 二进制及配套配置、nginx 和前端指向；原 `/root/cardgw/frontend/dist` 保留。新文件若需退出使用，应移到私有证据目录而非无授权删除。不能把更早的迁移前程序连到当前库，也不能通过恢复 DB 快照丢弃发布后的新订单、卡、吊销或扣次。

宿主长期可用性、真实支付渠道和历史 OpenList 永久签名/克隆密钥的撤销不由本次模拟测试证明。没有执行真实付款、轮换密钥或处置旧主机；这些不应被表述成“全部线上业务已压测”。
