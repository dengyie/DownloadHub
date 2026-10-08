# 下载站前后端分离

## 边界

浏览器只消费同源 HTTP 接口，不访问数据库或 OpenList 管理接口。nginx 独立分发前端构建；Go 不再嵌入或读取页面。商城仍用已校验的 PHP/SQLite 服务，不重写支付、库存或会话规则。

| 请求 | 所有者 | 合同 |
|---|---|---|
| `/`、`/cat/:id`、`/resources/:id`、`/item/:id` | 独立前端 | 公开目录、商城目录及详情 |
| `/redeem`、`/orders`、`/help` | 独立前端 | 兑换、私密查单和帮助 |
| `/user/index/{index,item,query}` | 独立前端 | 仍有外部链接调用的文档地址 |
| `/user/authentication/{login,register,emailForget,phoneForget}` | 独立前端 | 登录、注册、找回密码 |
| `/user/dashboard/index` | 独立前端 | 账户概览 |
| `/dl/<resource>?...` | 独立前端 | 读取旧链接到内存、清除敏感查询参数；GET 不签发 |
| `/ui/<24位内容哈希>/...js`、`...css`、三项 `/brand/` 资源 | nginx | 真实文件；缺失返回 404 |
| `/api/{catalog,redeem,grants}` | Go | 公开目录与卡密授权 API |
| `/user/api/*`、`/user/pay/*`、`/pay/*`、`/user/captcha/*` | PHP | 原商城、支付、认证接口 |
| 充值、账单、资料、安全设置、`/admin/*`、原商城资产 | PHP | 实际有调用的原页面，不套用 SPA 的禁内联 CSP |
| `/pub/*`、`/p/*` | nginx / OpenList | 公开文件与受保护签名传输 |
| `/health`、`/ready` | Go 回环监听 | nginx 公网拒绝；不据 ready 推断 OpenList 可用 |

`frontend/src/router.js` 是客户端/开发服务器的文档路由合同。nginx 保留同一显式白名单，并用真实二进制测试验证；禁止全站 `try_files ... /index.html`，以免吞掉 API、支付或管理路径。已移除原 `web/`、Go embeds 和可选静态托管配置，不保留第三套兜底页面。

## 模块

- `app.js`：共享导航、页面挂载/取消、站点引导和 URL 状态。
- `api.js`：表单编码、同源 JSON、超时/取消、错误、安全 URL、同凭证合并。
- `dom.js`：可访问 DOM 控件、复制失败的手动选择、白名单富文本。
- `catalog.js`：公开目录/商城项目的展示映射。
- `commerce-model.js`：纯协议转换与购买可用性；价格、库存、金额和鉴权的最终权威仍在后端。
- `auth-model.js` / `redemption-model.js`：认证设置与下载返回数据的边界校验。
- `pages/`：每个用户流程的页面生命周期；返回清理函数，不持久化卡密、订单密码、发货内容。
- `vendor/`：按用户指定 awesome-ui 复用 Vanilla UiIcon/ThemeToggle；来源和许可证边界见 `THIRD_PARTY_NOTICES.md`。

商品页的报价、支付方式和自选库存使用独立取消/序列校验，旧规格响应不能覆盖新选择。下单未确认时禁止重复提交，失联后引导查单，不自动重发 POST。不为单一商城引入抽象数据总线或通用插件框架。

## API 与状态合同

- `GET/HEAD /api/catalog` 返回经过长度、字段、唯一性和路径白名单校验的公开资源。默认编译进 `catalog/public.json`；`public_catalog_path` 可指定独立 JSON，启动时读取，修改后需重启 Go，不需重新构建前端。
- `GET/HEAD /user/api/storefront/bootstrap` 通过原 Waf/UserVisitor，保留分站覆盖及合法推广来源；只投影公开配置、当前用户最小字段，响应 `no-store`，HEAD 无正文。
- 商城价格/库存继续使用 `valuation` / `stock`；字段保持 PHP 的 `item_id`、`num`、`race`、`sku[字段]`、`card_id`、`coupon`。自定义输入直接使用后端约定的顶层字段，不能包在新的 `widget[...]` 中。
- 抢购 SQL 时间来自固定 PHP kernel 的 `Asia/Shanghai`，前端按 UTC+8 解析，不使用顾客机器的时区决定能否下单。
- 查单、密码取货和下单均为 POST。未付款和密码未验证的内容不展示；“已付款待补货”与“商家处理中”不当作支付失败。
- 兑换只生成资源凭证；明确点击后才 `POST /api/grants`。页面校验和签发互斥，防止替换仍在等待结果的恢复凭证；不同资源仍可并发签发，由后端原子限制总额度。
- 页面刷新会失去内存凭证，已获得的签名链接仍可在其有效期内使用。不要为恢复功能引入浏览器持久卡密存储。

## 安全与资源生命周期

富文本不信任管理端输入：只复制明确允许的元素和 URL，不复制脚本、内联事件、样式、表单、SVG/MathML 或框架对象。动态错误与加载文案用 textContent。URL 拒绝可执行协议、账户信息、控制字符和歧义网络路径；登录返回地址还校验解码后的路径。

页面切换清理报价计时器、搜索 debounce、监听器和请求；迟到的页面清理函数也会执行。API 超时不冒充主动切页取消，不自动重试财务操作。卡密、密码和签名查询值不进入 access log；生产 nginx 日志使用 `$uri` 而非原始请求行。

只读开发代理使用审阅过的接口白名单，不把 GET 等同于无副作用；logout、支付回调及未知 API 均拒绝。绝对请求目标和路径穿越在 URL 规范化前拒绝。

## 构建与发布

```sh
npm --prefix frontend ci --ignore-scripts
npm --prefix frontend run build
```

生成 `frontend/dist/index.html`、`ui/<hash>/`、三项品牌资源和 `build.json`。哈希涵盖模板、文件名与全部 JS/CSS 内容；不打包测试、模拟数据、后端配置或依赖目录。构建拒绝覆盖源码、输出符号链接和异常文件，保留旧指纹目录以服务已打开的页面。

生产根推荐 `/var/www/download-ui/current`，目录必须可被 nginx worker 读取，不能为了托管前端开放 `/root` 权限。候选版本完整校验后原子切换 current；候选包应保留之前仍在使用的指纹目录。HTML `no-store`；仅成功的指纹静态响应使用一年 immutable，404 不长缓存。品牌资源与公开文件有独立缓存期限。

Go 配置移除 `frontend_dir`、`api_only`。新旧 Go 的卡密 schema 和事务相同，本次不迁移数据库。PHP 引导文件若与已发布版本哈希相同就不覆盖、不重启 PHP；禁止为 UI 发布调用历史 MySQL 切换脚本或绕过 source drift 检查。

先用真实 nginx、私有端口和模拟 API 验证路由，再暂存二进制/配置、保存源码与一致性 SQLite 备份，切换前端和 nginx 后重启 cardgw。回滚只恢复本次二进制/配置/前端指向，不能恢复旧数据库丢弃新增业务。具体发布事实见 [验收记录](release-2026-10-09-ui-api.md)。

## 验证

`make check` 汇总 Go vet/race、Python 发布/备份/nginx、Node、浏览器和六套真实 PHP 回归。CI 提供 nginx、PHP 8.2 与固定 Playwright Chromium。本地缺失的运行时不得以 skip 冒充通过。

浏览器场景使用显式模拟标识，覆盖桌面/移动端、明暗主题、兑换/查单/支付/认证完整交互、请求竞态、异常数据与复制失败。线上只做非业务写入探针，不使用真实卡密和支付验证。
