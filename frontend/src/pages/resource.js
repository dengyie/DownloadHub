import {getJSON, safeURL} from '../api.js';
import {
  el,
  icon,
  link,
  button,
  banner,
  emptyState,
  loadingState,
  formatBytes,
  formatDate,
  copyText,
} from '../dom.js';
import {categoryName, categoryIcon} from '../catalog.js';
import {pageTitle} from '../site.js';

export async function renderResource(root, {url, signal}) {
  root.append(
    el(
      'div',
      {className: 'page-heading'},
      el('nav', {className: 'breadcrumbs', 'aria-label': '面包屑'}, [
        link('资源广场', '/'),
        icon('chevron-right', 12),
        el('span', {text: '资源详情'}),
      ])
    ),
    loadingState('正在加载资源信息')
  );
  const data = await getJSON('/api/catalog', {signal});
  if (signal.aborted) return;
  const item = data.resources?.find((item) => item.id === url.pathname.split('/').pop());
  root.lastChild.remove();
  if (!item) {
    root.append(
      emptyState(
        '资源不存在',
        '这个资源可能已更新，请返回资源广场查找。',
        link('返回资源广场', '/', {className: 'button button-primary'})
      )
    );
    return;
  }
  const href = safeURL(item.path, {sameOrigin: true});
  if (!href || !new URL(href).pathname.startsWith('/pub/')) throw new Error('资源下载地址无效');
  document.title = pageTitle(item.name);
  const status = el('div', {className: 'form-status'});
  const copy = button(
    '复制下载链接',
    {
      className: 'button button-secondary button-wide',
      onclick: async () => {
        const ok = await copyText(href, status);
        if (ok) status.replaceChildren(banner('下载链接已复制', 'success'));
      },
    },
    'copy'
  );
  const details = el(
    'dl',
    {className: 'metadata-list'},
    [
      ['资源类型', categoryName(item.category)],
      ['适用平台', item.platform],
      ['当前版本', item.version],
      ['文件大小', formatBytes(item.bytes)],
      ['更新日期', formatDate(item.updated_at)],
    ].map(([label, value]) => el('div', {}, [el('dt', {text: label}), el('dd', {text: value})]))
  );
  const main = el('section', {className: 'content-panel'}, [
    el('div', {className: 'resource-detail-head'}, [
      el('div', {className: `resource-icon ${item.category}`}, icon(categoryIcon(item.category), 30)),
      el('div', {}, [
        el('h1', {text: item.name}),
        el('span', {className: 'badge', text: '公开资源 · 无需卡密'}),
      ]),
    ]),
    el('p', {className: 'detail-description', text: item.description}),
    el('h2', {className: 'section-title', text: '资源说明'}),
    el('p', {
      className: 'detail-description',
      text:
        item.kind === 'script'
          ? '这是一个脚本文件。请先下载并查看内容，确认符合你的使用场景后，再在相应环境中手动执行。页面不会自动运行脚本。'
          : item.kind === 'app'
            ? '下载完成后，请在兼容的 Android TV 设备上手动安装。系统可能需要你允许安装来自此来源的应用，请根据设备提示操作。'
            : '请选择与设备架构匹配的文件。此版本适用于 ARM64 环境；下载完成后，按工具文档配置服务连接。',
    }),
    el('h3', {text: '文件名称'}),
    el('p', {className: 'filename', text: item.filename}),
    el('div', {className: 'help-strip'}, [
      el('p', {className: 'small', text: '下载遇到问题？查看下载说明和常见问题。'}),
      link('获取帮助', '/help#public-download', {className: 'text-link'}, 'arrow-right'),
    ]),
  ]);
  const side = el('aside', {className: 'content-panel download-panel'}, [
    el('h2', {text: '准备好就下载吧'}),
    details,
    link(
      '下载文件',
      href,
      {className: 'button button-primary button-wide', download: item.filename},
      'arrow-down'
    ),
    copy,
    status,
    el('p', {
      className: 'download-caption',
      text: '此资源公开提供，无需登录或卡密。\n下载不会消耗卡密次数。',
    }),
  ]);
  root.append(el('div', {className: 'page-layout'}, [main, side]));
}
