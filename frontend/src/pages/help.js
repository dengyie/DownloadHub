import {safeURL} from '../api.js';
import {el, link, icon} from '../dom.js';

export async function renderHelp(root, {sitePromise, signal}) {
  document.title = '使用帮助 · MangoQWQ 资源站';
  const sections = [
    ['public', '公开资源下载', [
      el('p', {}, ['标记为“公开下载”的资源无需账户或卡密。打开资源详情，确认平台、版本和文件大小，再点击下载。', link('浏览公开资源', '/?category=all')]),
      el('p', {text: '脚本只会下载，不会在浏览器或设备上自动执行。运行前请先阅读内容，并确认来源、所需权限和适用环境。'}),
    ]],
    ['redeem', '卡密兑换与扣次', [
      el('ol', {}, ['打开卡密兑换，填写卡号和密钥。', '点击“查看可用资源”，核对资源清单。此步骤不会扣次。', '对需要的文件点击“签发下载授权”。首次成功签发会扣减一次下载授权。', '点击“打开下载链接”获取文件，并保留兑换页面。'].map(text => el('li', {text}))),
      el('p', {text: '如果网络中断或响应丢失，使用原资源下方的“核验并恢复链接”重试。同一凭证的有效授权可以恢复，不会因重复点击再扣一次；即使显示剩余 0 次，也不要丢弃原凭证。'}),
      el('p', {text: '卡密和恢复凭证只保留在当前页面内存，不保存到浏览器存储。刷新或关闭页面会丢失恢复入口。新一轮查看资源可能生成新的凭证，请优先使用已有链接的恢复按钮。'}),
    ]],
    ['expired', '过期链接与旧版卡密', [
      el('p', {text: '下载授权有有效期，以签发后显示的时间为准。过期链接不能继续下载或复制；可重新查看资源并签发新授权，新授权会根据卡密剩余次数核验。'}),
      el('p', {text: '旧版前缀卡需要资源提供方给出的具体路径。展开兑换表单中的高级选项填写，不能使用授权范围以外的路径。打开旧的 /dl/ 链接只会进入确认页，不会自动扣次。'}),
    ]],
    ['orders', '购买、支付与订单查询', [
      el('p', {text: '商品页会按规格、数量和优惠券向服务器重新核价。支付方式、库存及最终应付金额以服务器校验为准；付款后请保留订单号。'}),
      el('p', {}, ['在', link('订单查询', '/user/index/query'), '中输入订单号或购买时填写的联系方式。设有查询密码的订单，需要该密码才能查看发货内容。查询信息不会写入地址栏或浏览器存储。']),
      el('p', {text: '“已支付”不一定表示已经发货。人工交付商品或处理中订单请稍后查询；支付跳转中断时先核对原订单，避免重复购买。'}),
    ]],
    ['privacy', '账户与信息安全', [
      el('p', {text: '公开资源和已有卡密无需登录。注册与找回密码的验证方式由站点配置决定，请按页面提示操作。不要向他人分享账户密码、查询密码或卡密。'}),
      el('p', {text: '如果浏览器不允许自动复制，页面会显示并选中可手动复制的内容。主题偏好可以保存在浏览器中，卡密、订单内容和登录密码不会写入本地存储。'}),
    ]],
  ];
  const support = el('section', {className: 'help-section', id: 'support'}, [el('h2', {text: '仍然需要帮助？'}), el('p', {text: '请联系资源提供方，并说明资源名称、订单号和遇到的问题。不要在公开反馈中附上密码、完整卡密或有效下载链接。'})]);
  root.append(el('div', {className: 'page-heading'}, [el('nav', {className: 'breadcrumbs', 'aria-label': '面包屑'}, [link('资源广场', '/'), icon('chevron-right', 12), el('span', {text: '使用帮助'})]), el('h1', {text: '让每一次下载，都顺利一点。'}), el('p', {text: '从公开资源到专属卡密，这里整理了你可能需要的使用说明。'})]),
    el('div', {className: 'help-layout'}, [el('nav', {className: 'help-nav', 'aria-label': '帮助目录'}, [...sections.map(([id, title]) => link(title, `#${id}`)), link('联系支持', '#support')]), el('div', {}, [...sections.map(([id, title, content]) => el('section', {className: 'help-section', id}, [el('h2', {text: title}), ...content])), support])]),
  );
  const site = await sitePromise;
  if (!signal.aborted && safeURL(site?.support_url)) support.append(el('p', {}, link('联系站点客服', safeURL(site.support_url), {target: '_blank', rel: 'noopener noreferrer'}, 'external-link')));
}
