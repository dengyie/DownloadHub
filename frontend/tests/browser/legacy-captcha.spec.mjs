import {test, expect} from '@playwright/test';
import {readFile} from 'node:fs/promises';

const overlay = new URL('../../../commerce/overlay/', import.meta.url);

// Only the surrounding legacy UI/services are doubled. The checked-in template,
// controller and shared captcha module run unchanged in a real browser.
async function legacyPage(page, script, markup) {
  const code = await readFile(new URL(script, overlay), 'utf8');
  await page.addInitScript(() => {
    window.calls = [];
    window.i18n = (text) => text;
    window.$ = (selector) => ({
      click: (handler) =>
        document.querySelectorAll(selector).forEach((node) => node.addEventListener('click', handler)),
      val: () => document.querySelector(selector).value,
    });
    window.util = {
      getParam: () => 'null',
      getFormData: (selector) => Object.fromEntries(new FormData(document.querySelector(selector))),
      countDown: (button) => {
        button.disabled = true;
      },
      post: (url, fields, done) => {
        if (typeof url === 'object') {
          window.calls.push(url.data);
          url.error({code: 42001, msg: '需要动态码'});
        } else {
          window.calls.push({url, ...fields});
          done?.({code: 200});
        }
      },
    };
    window.message = {
      error: () => {},
      success: () => {},
      warning: () => {},
      prompt: (options) =>
        new Promise((resolve) => {
          const popup = document.createElement('div');
          popup.setAttribute('role', 'dialog');
          const input = document.createElement('input');
          input.setAttribute('aria-label', '安全图片验证码');
          const confirm = document.createElement('button');
          confirm.textContent = options.confirmButtonText;
          const cancel = document.createElement('button');
          cancel.textContent = '取消';
          popup.append(options.html, input, confirm, cancel);
          document.body.append(popup);
          window.Swal = {getInput: () => input, showValidationMessage: () => {}};
          options.didOpen();
          confirm.addEventListener('click', () => {
            if (options.inputValidator(input.value)) return;
            const value = options.preConfirm();
            if (value === false) return;
            options.willClose();
            popup.remove();
            resolve({isConfirmed: true, value});
          });
          cancel.addEventListener('click', () => {
            options.willClose();
            popup.remove();
            resolve({isConfirmed: false});
          });
        }),
    };
  });
  await page.route('**/__legacy__/controller.js', (route) =>
    route.fulfill({contentType: 'text/javascript; charset=utf-8', body: code})
  );
  await page.route('**/__legacy__/page', (route) =>
    route.fulfill({
      contentType: 'text/html; charset=utf-8',
      body: `<!doctype html><html><head><meta charset="utf-8"></head><body>${markup}<script src="/__legacy__/controller.js"></script></body></html>`,
    })
  );
  await page.goto('/__legacy__/page');
}

test.beforeEach(async ({request}) => {
  await request.post('/__fixture/reset');
});

test('PHP admin template uses the shared challenge and preserves the TOTP follow-up', async ({page}) => {
  const template = await readFile(new URL('app/View/Admin/Authentication/Login.html', overlay), 'utf8');
  const markup = template
    .slice(template.indexOf('<main'), template.indexOf('</main>') + 7)
    .replace(/#\{t\((["'])(.*?)\1\)\}/g, '$2')
    .replace(/#\{[^}]*\}/g, '');
  await legacyPage(page, 'assets/admin/controller/auth/login.js', markup);
  await page.locator('input[name=username]').fill('fixture');
  await page.locator('#ay-pass').fill('fixture-password');
  await page.locator('#ay-captcha').fill('4286');
  await page.locator('#ay-submit').click();
  await expect.poll(() => page.evaluate(() => window.calls.length)).toBe(1);
  const first = await page.evaluate(() => window.calls[0]);
  expect(first.captcha_id).toMatch(/^[A-Za-z0-9_-]{22}$/);
  expect(first.captcha_code).toBe('4286');
  expect(first.captcha).toBeUndefined();
  await expect(page.locator('.ay-2fa')).not.toHaveClass(/is-hidden/);
  await page.locator('#ay-code').fill('123456');
  await page.locator('#ay-captcha').fill('4286');
  await page.locator('#ay-submit').click();
  const second = await page.evaluate(() => window.calls[1]);
  expect(second.code).toBe('123456');
  expect(second.captcha_id).not.toBe(first.captcha_id);
});

for (const channel of ['email', 'phone']) {
  test(`PHP ${channel} security prompt captures its ID before disposal and cancels without sending`, async ({
    page,
  }) => {
    const target = channel === 'email' ? 'fixture@example.test' : '13800138000';
    await legacyPage(
      page,
      `assets/user/controller/security/${channel}.js`,
      `<input name="${channel}" value="${target}"><button class="send-captcha">发送验证码</button><button class="save-data">保存</button>`
    );
    await page.getByRole('button', {name: '发送验证码', exact: true}).click();
    await page.getByRole('button', {name: '取消', exact: true}).click();
    expect(await page.evaluate(() => window.calls)).toEqual([]);
    await expect(page.getByRole('button', {name: '发送验证码', exact: true})).toBeEnabled();
    await page.getByRole('button', {name: '发送验证码', exact: true}).click();
    await page.getByLabel('安全图片验证码', {exact: true}).fill('4286');
    await page.getByRole('button', {name: '继续操作', exact: true}).click();
    await expect.poll(() => page.evaluate(() => window.calls.length)).toBe(1);
    const sent = await page.evaluate(() => window.calls[0]);
    expect(sent).toMatchObject({
      url: `/user/api/security/${channel}BindNew`,
      [channel]: target,
      captcha_code: '4286',
    });
    expect(sent.captcha_id).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(sent.captcha).toBeUndefined();
    await expect(page.getByRole('dialog')).toHaveCount(0);
  });
}
