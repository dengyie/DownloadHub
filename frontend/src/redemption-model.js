export function redemptionResult(data) {
  if (
    !Array.isArray(data?.resources) ||
    data.resources.some(
      (item) => typeof item?.name !== 'string' || !/^[a-f0-9]{64}$/i.test(item?.credential || '')
    )
  ) {
    throw new Error('资源列表格式异常，请稍后重试；已有下载凭证仍保留在下方。');
  }
  return data;
}

// Historical links are read into memory, then removed from the address bar by
// the page. Parsing them must never request a grant or consume a card.
export function legacyRedemption(url) {
  if (!url.pathname.startsWith('/dl/')) return null;
  const resource = decodeURIComponent(url.pathname.slice(4));
  if (!resource || /[\u0000-\u001f\\]/.test(resource))
    throw new Error('旧下载链接格式无效，请使用卡号和密钥重新兑换。');
  const credential = url.searchParams.get('token');
  if (credential !== null) {
    if (!/^[a-f0-9]{64}$/i.test(credential))
      throw new Error('旧下载凭证格式无效，请使用卡号和密钥重新兑换。');
    return {resources: [{name: resource.split('/').pop() || resource, credential}]};
  }
  return {card: url.searchParams.get('card') || '', key: url.searchParams.get('key') || '', resource};
}

export const grantExpired = (grant, now = Date.now()) =>
  !grant || !Number.isFinite(Date.parse(grant.expires_at)) || Date.parse(grant.expires_at) <= now;
