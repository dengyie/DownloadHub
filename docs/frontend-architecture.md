# 前端现代化架构说明 (Frontend Architecture)

## 1. 架构定位与服务边界

MangoQWQ 资源下载站前端采用现代化的纯 ES 模块 (Vanilla JS / Native DOM)，无重型前端框架依赖，具备轻量、高性能、零依赖打包、严格安全沙箱的特性。

系统分为三个清晰的服务边界：
1. **cardgw (Go 下载授权网关)**:
   - 托管公共目录 API (`GET /api/catalog`)。
   - 负责卡密核验与受保护资源授权 (`POST /api/redeem`, `POST /api/grants`)。
   - 提供安全静态资源托管模式 (`frontend_handler.go`)，以 `Cache-Control: no-store` 托管 SPA 壳 (`index.html`)，并对版本化资源 (`/ui/<hash>/...`) 设置 `Cache-Control: public, max-age=31536000, immutable`。
   - 严格白名单文档路由匹配，未授权文件与未知路径直接返回 404，杜绝路径遍历和隐式文件泄漏。

2. **commerce / overlay (PHP 商城后端)**:
   - 提供前台安全引导配置 (`GET /user/api/storefront/bootstrap`)。
   - 商品分类与详情展示 (`GET /user/api/index/data`, `/user/api/index/commodityDetail`)。
   - 价格算费、下单与订单查询 (`POST /user/api/index/valuation`, `/user/api/order/trade`, `/user/api/index/query`, `/user/api/index/secret`)。
   - 会员登录与注册认证流程。

3. **静态发行包与反向代理 (Nginx)**:
   - `/ui/` 静态指纹化构建包 (`frontend/dist/ui/<hash>/`)。
   - `/pub/` 公开静态资源目录 (`/data/share/pub/`)，直接高速分发，不消耗卡密点数。
   - `/p/` 经由 OpenList 的受保护签名下载通道。

## 2. 状态机与安全模型

- **富文本净化与安全导航**:
  - `dom.js` 内置基于 DOMParser 的严格白名单净化 (`richText`)，仅允许安全的排版标签与样式，所有链接必须经 `safeURL` 过滤（禁止 `javascript:`, `vbscript:`, `data:` 与协议相对链接）。
  - `target="_blank"` 强制注入 `rel="noopener noreferrer"`。

- **卡密与凭证安全**:
  - 卡密凭证严格保存在内存中，不在 URL、localStorage 或 query string 中残留。
  - 历史带有 `?token=` 或 `?card=` 的下载链接，在前端初始化时提取至内存后立即通过 `history.replaceState` 剥离。
  - 授权签发必须通过用户显式 POST 确认，GET/HEAD 请求绝不触发扣点。

- **动态算费与下单防刷**:
  - SKU 规格、加价、优惠券、购买数量发生任何变动时，先前的估价即刻失效，必须经权威后端重新核价后方可唤起支付。
  - 严格限制并发提交，订单与兑换流程防重入锁。

- **主题与视觉系统**:
  - 集成 awesome-ui 的 Vanilla UI 原型规范与 Tabler 图标库。
  - 支持浅色、深色、跟随系统三态切换，通过 `theme-init.js` 在页面挂载前完成闪烁防护 (`data-theme`)。

## 3. 构建与发布流水线

- **构建命令**:
  ```sh
  node frontend/build.mjs
  ```
- **输出机制**:
  - 根据源码内容生成 24 位十六进制 SHA-256 指纹，输出至 `frontend/dist/ui/<hash>/`。
  - 自动更新 `frontend/dist/index.html` 中的资源引用路径。
  - 拷贝 `brand/` 图标与徽标至分发目录。
- **本地开发与测试**:
  - 开发服务器：`node frontend/dev.mjs`
  - 离线合成桩模式：`node frontend/dev.mjs --fixture`
  - 前端测试套件：`npm test`（27 个纯原生 Node.js 测试用例，全面覆盖安全、表单、估价、订单与凭证恢复）。
