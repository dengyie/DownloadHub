import {postJSON, safeReturnPath} from '../api.js';
import {authSettings, recoveryPath, verificationSettings} from '../auth-model.js';
import {el, icon, link, button, banner, inputField, loadingState, errorState, setBusy} from '../dom.js';

function captcha(action, name = 'captcha', label = '图片验证码') {
  const control = inputField(label, name, {required: true, inputmode: 'numeric', autocomplete: 'off', maxlength: 8, placeholder: '输入图片中的数字'});
  const image = el('img', {alt: '图片验证码；看不清可点击更换', width: 120, height: 44});
  const refresh = () => {image.src = `/user/captcha/image?action=${action}&_=${Date.now()}`; control.input.value = '';};
  const trigger = el('button', {type: 'button', className: 'captcha-refresh', 'aria-label': `更换${label}`, onclick: refresh}, image);
  control.field.append(el('div', {className: 'captcha-row'}, [control.input, trigger]));
  refresh();
  return {...control, refresh};
}

export async function renderAuth(root, {url, signal, navigate, sitePromise, refreshSite}) {
  root.append(loadingState('正在加载账户服务'));
  const site = await sitePromise;
  if (signal.aborted) return;
  let auth;
  try {auth = authSettings(site);}
  catch (error) {
    root.replaceChildren(errorState(error, async () => {await refreshSite(); if (!signal.aborted) navigate(url.pathname + url.search);}));
    return;
  }
  const returnPath = safeReturnPath(url.searchParams.get('goto') || url.searchParams.get('return') || '/user/dashboard/index');
  if (site.user) {navigate(returnPath); return;}
  const mode = url.pathname.endsWith('/register') ? 'register' : url.pathname.endsWith('/login') ? 'login' : 'recovery';
  const registration = mode === 'register';
  const recovery = mode === 'recovery';
  const title = registration ? '创建你的账户' : recovery ? '找回账户密码' : '欢迎回来';
  document.title = `${title} · MangoQWQ 资源站`;
  if (registration && !auth.registration_enabled) {
    root.replaceChildren(el('div', {className: 'page-heading'}, el('h1', {text: title})), banner('站点当前暂停新账户注册。已有账户可以继续登录，公开资源和卡密兑换无需注册。'), link('返回登录', '/user/authentication/login', {className: 'button button-primary'}));
    return;
  }
  const verification = verificationSettings(auth, recovery);
  const phone = verification.channel === 'phone';
  const target = recovery || registration && verification.channel ? inputField(phone ? '手机号码' : '邮箱地址', verification.channel, {
    type: phone ? 'tel' : 'email', autocomplete: phone ? 'tel' : 'email', required: true,
    maxlength: phone ? 20 : 254, placeholder: phone ? '输入注册使用的手机号码' : 'you@example.com',
  }) : null;
  const username = !recovery ? inputField(registration ? '用户名' : '用户名 / 邮箱 / 手机', 'username', {
    required: true, autocomplete: 'username', maxlength: registration ? 32 : 254,
    ...(registration ? {minlength: auth.username_min_length} : {}),
    placeholder: registration ? `至少 ${auth.username_min_length} 位字符` : '输入你的账户',
  }) : null;
  const password = inputField(recovery ? '设置新密码' : '密码', 'password', {
    type: 'password', required: true, minlength: 6, autocomplete: mode === 'login' ? 'current-password' : 'new-password', placeholder: '至少 6 位，请使用不易猜测的密码',
  });
  const confirmation = mode !== 'login' ? inputField('确认密码', 'password-confirmation', {type: 'password', required: true, minlength: 6, autocomplete: 'new-password', placeholder: '再次输入密码'}) : null;
  const imageCaptcha = !recovery && (registration ? auth.registration_captcha : auth.login_captcha) ? captcha(registration ? 'register' : 'login') : null;
  const verificationCaptcha = mode !== 'login' && verification.required ? captcha(verification.action, 'verification-image', '发送前的图片验证码') : null;
  const code = verificationCaptcha ? inputField(phone ? '短信验证码' : '邮箱验证码', recovery ? 'captcha' : `${verification.channel}_captcha`, {required: true, inputmode: 'numeric', autocomplete: 'one-time-code', maxlength: 12, placeholder: '输入收到的验证码'}) : null;
  const status = el('div', {className: 'form-status'});
  const sendStatus = el('div', {className: 'form-status'});
  let cooldown;
  if (code) {
    const send = button('发送验证码', {className: 'button button-secondary'});
    code.field.append(el('div', {className: 'verification-row'}, [code.input, send]));
    send.addEventListener('click', async () => {
      if (send.disabled || !target.input.reportValidity() || !verificationCaptcha.input.reportValidity()) return;
      setBusy(send, true, '正在发送');
      sendStatus.replaceChildren();
      try {
        const response = await postJSON(`/user/api/authentication/${verification.action}`, {[verification.channel]: target.input.value.trim(), captcha: verificationCaptcha.input.value.trim()}, {signal});
        if (signal.aborted) return;
        sendStatus.replaceChildren(banner(response.msg || '验证码已发送，请查收。', 'success'));
        let remaining = 60;
        send.setAttribute('aria-busy', 'false');
        send.replaceChildren(el('span', {text: `${remaining} 秒后重发`}));
        cooldown = setInterval(() => {
          remaining -= 1;
          send.replaceChildren(el('span', {text: `${remaining} 秒后重发`}));
          if (remaining <= 0) {clearInterval(cooldown); setBusy(send, false, '重新发送');}
        }, 1000);
      } catch (error) {
        if (!signal.aborted) {sendStatus.replaceChildren(banner(error.message, 'error')); setBusy(send, false, '重新发送');}
      } finally {if (!signal.aborted) verificationCaptcha.refresh();}
    });
  }
  const remember = el('input', {type: 'checkbox', name: 'remember'});
  const submitText = registration ? '创建账户' : recovery ? '重置密码' : '登录';
  const submit = button(submitText, {type: 'submit', className: 'button button-primary button-wide'}, 'arrow-right');
  const form = el('form', {id: 'auth-form'}, [
    username?.field, target?.field, verificationCaptcha?.field, code?.field, sendStatus,
    password.field, confirmation?.field, imageCaptcha?.field,
    mode === 'login' && el('div', {className: 'auth-options'}, [el('label', {}, [remember, '保持登录']), link('忘记密码？', recoveryPath(auth))]), submit, status,
  ]);
  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (submit.disabled) return;
    if (confirmation && confirmation.input.value !== password.input.value) {status.replaceChildren(banner('两次输入的密码不一致，请检查。', 'error')); confirmation.input.focus(); return;}
    const fields = {username: recovery ? target.input.value.trim() : username.input.value.trim(), password: password.input.value};
    if (mode === 'login') fields.remember = remember.checked;
    if (registration && target) fields[verification.channel] = target.input.value.trim();
    if (imageCaptcha) fields.captcha = imageCaptcha.input.value.trim();
    if (code) fields[recovery ? 'captcha' : `${verification.channel}_captcha`] = code.input.value.trim();
    setBusy(submit, true, recovery ? '正在重置' : '正在验证');
    status.replaceChildren();
    try {
      await postJSON(`/user/api/authentication/${recovery ? 'password' : mode}`, fields, {signal});
      if (signal.aborted) return;
      password.input.value = '';
      if (confirmation) confirmation.input.value = '';
      if (recovery) {
        form.replaceChildren(banner('密码已重置，请使用新密码重新登录。', 'success'), link('返回登录', '/user/authentication/login', {className: 'button button-primary button-wide'}));
      } else {
        await refreshSite();
        if (!signal.aborted) navigate(returnPath);
      }
    } catch (error) {
      if (!signal.aborted) {status.replaceChildren(banner(error.message, 'error')); imageCaptcha?.refresh();}
    } finally {if (!signal.aborted) setBusy(submit, false, submitText);}
  });
  const returnQuery = `?goto=${encodeURIComponent(returnPath)}`;
  const footnote = mode === 'login' ? (auth.registration_enabled && el('p', {className: 'auth-footnote'}, ['还没有账户？', link('创建账户', `/user/authentication/register${returnQuery}`)])) : el('p', {className: 'auth-footnote'}, ['已有账户？', link('返回登录', `/user/authentication/login${returnQuery}`)]);
  root.replaceChildren(el('div', {className: 'page-heading'}, link('返回资源广场', '/', {className: 'text-link'}, 'arrow-left')), el('div', {className: 'auth-layout'}, [
    el('section', {className: 'auth-intro'}, [el('p', {className: 'eyebrow', text: 'YOUR SPACE FOR GOOD RESOURCES'}), el('h1', {}, ['好用的资源，', el('br'), '从这里连接。']), el('p', {text: '登录后使用账户余额购买、管理订单与个人资料。只想下载公开资源？无需注册，也能自在探索。'}), el('div', {className: 'hero-benefits'}, [el('span', {}, [icon('lock', 16), '账户信息安全传输']), el('span', {}, [icon('layers', 16), '资源与订单一处管理'])])]),
    el('section', {className: 'content-panel'}, [el('div', {className: 'section-title'}, el('h2', {text: title})), recovery && banner(`使用注册时绑定的${phone ? '手机号' : '邮箱'}验证身份，再设置新密码。`), form, footnote]),
  ]));
  const cleanup = () => {clearInterval(cooldown); password.input.value = ''; if (confirmation) confirmation.input.value = ''; if (code) code.input.value = '';};
  signal.addEventListener('abort', cleanup, {once: true});
  return cleanup;
}
