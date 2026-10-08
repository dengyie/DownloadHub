// One image/ID lifecycle for the SPA and PHP pages. Keep this module dependency-free:
// the build publishes these same bytes at the no-store /ui/captcha.js entry point.
export function mountCaptcha({action, image, input, status, trigger, signal, onChange = () => {}}) {
  let id = '',
    sequence = 0,
    request,
    objectURL,
    expiryTimer,
    expires = 0,
    disposed = false;
  input.maxLength = 4;
  input.inputMode = 'text';
  input.autocomplete = 'off';
  input.setAttribute('autocapitalize', 'characters');
  input.setAttribute('spellcheck', 'false');
  input.pattern = '[A-Za-z2-9]{4}';
  image.width = 150;
  image.height = 50;
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  if (status.id) input.setAttribute('aria-describedby', status.id);

  function invalidate(message) {
    id = '';
    expires = 0;
    input.value = '';
    input.disabled = true;
    image.hidden = true;
    image.removeAttribute('src');
    if (objectURL) URL.revokeObjectURL(objectURL);
    objectURL = undefined;
    clearTimeout(expiryTimer);
    status.textContent = message;
    onChange();
  }

  async function refresh() {
    if (disposed || signal?.aborted) return false;
    const version = ++sequence;
    request?.abort();
    const controller = (request = new AbortController());
    invalidate('验证码加载中…');
    trigger.setAttribute('aria-busy', 'true');
    const started = Date.now();
    const timeout = setTimeout(() => controller.abort(), 10000);
    let abortLoading;
    const interrupted = new Promise((_, reject) => {
      abortLoading = () => reject(controller.signal.reason);
      controller.signal.addEventListener('abort', abortLoading, {once: true});
      if (controller.signal.aborted) abortLoading();
    });
    let candidate;
    const current = () => !disposed && version === sequence && !signal?.aborted;
    try {
      const response = await Promise.race([
        fetch(`/user/captcha/image?action=${encodeURIComponent(action)}`, {
          credentials: 'same-origin',
          cache: 'no-store',
          signal: controller.signal,
        }),
        interrupted,
      ]);
      if (!current() || controller.signal.aborted) return false;
      const challengeID = response.headers.get('X-Captcha-Id');
      if (
        !response.ok ||
        !/^[A-Za-z0-9_-]{22}$/.test(challengeID || '') ||
        response.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase() !== 'image/png'
      ) {
        throw new Error('Invalid captcha response');
      }
      const blob = await Promise.race([response.blob(), interrupted]);
      if (!current() || controller.signal.aborted) return false;
      if (!blob.size || blob.size > 65536) throw new Error('Invalid captcha image size');
      candidate = URL.createObjectURL(blob);
      image.src = candidate;
      // Abort also bounds decoding, which does not observe the fetch signal.
      await Promise.race([image.decode(), interrupted]);
      if (!current() || controller.signal.aborted) return false;
      objectURL = candidate;
      candidate = undefined;
      id = challengeID;
      expires = started + 300000;
      image.hidden = false;
      input.disabled = false;
      status.textContent = '输入图片中的 4 位字符，不区分大小写。';
      expiryTimer = setTimeout(
        () => invalidate('验证码已过期，请点击图片更换。'),
        Math.max(0, expires - Date.now())
      );
      onChange();
      return true;
    } catch {
      if (current()) invalidate('验证码加载失败，请点击图片重试。');
      return false;
    } finally {
      clearTimeout(timeout);
      controller.signal.removeEventListener('abort', abortLoading);
      if (candidate) URL.revokeObjectURL(candidate);
      if (current()) trigger.setAttribute('aria-busy', 'false');
    }
  }

  const clicked = () => {
    void refresh();
  };
  const keyed = (event) => {
    if (trigger.tagName !== 'BUTTON' && ['Enter', ' '].includes(event.key)) {
      event.preventDefault();
      void refresh();
    }
  };
  const pause = () => {
    ++sequence;
    request?.abort();
    invalidate('请点击图片获取验证码。');
  };
  const resume = (event) => {
    if (event.persisted && !disposed) void refresh();
  };
  function dispose() {
    if (disposed) return;
    disposed = true;
    pause();
    trigger.removeEventListener('click', clicked);
    trigger.removeEventListener('keydown', keyed);
    signal?.removeEventListener('abort', dispose);
    window.removeEventListener('pagehide', pause);
    window.removeEventListener('pageshow', resume);
  }
  trigger.addEventListener('click', clicked);
  trigger.addEventListener('keydown', keyed);
  window.addEventListener('pagehide', pause);
  window.addEventListener('pageshow', resume);
  signal?.addEventListener('abort', dispose, {once: true});
  if (signal?.aborted) dispose();
  else void refresh();
  return {
    refresh,
    dispose,
    get id() {
      return !disposed && Date.now() < expires ? id : '';
    },
    get ready() {
      return Boolean(this.id);
    },
    fields() {
      if (!this.ready) throw new Error('请先加载有效的图片验证码。');
      return {captcha_id: this.id, captcha_code: input.value.trim()};
    },
  };
}
