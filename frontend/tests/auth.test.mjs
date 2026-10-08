import test from 'node:test';
import assert from 'node:assert/strict';
import {authSettings, recoveryPath, verificationSettings} from '../src/auth-model.js';

const auth = {
  registration_enabled: true,
  registration_captcha: true,
  email_verification: true,
  phone_verification: false,
  login_captcha: true,
  registration_type: 2,
  recovery_type: 0,
  username_min_length: 3,
};
test('authentication does not guess missing or malformed public settings', () => {
  assert.throws(() => authSettings(null));
  assert.throws(() => authSettings({auth: {}}));
  assert.throws(() => authSettings({auth: {...auth, login_captcha: '0'}}));
  assert.equal(authSettings({auth}), auth);
});
test('registration and recovery use their distinct upstream enum mappings', () => {
  assert.deepEqual(verificationSettings(auth), {
    channel: 'email',
    required: true,
    action: 'emailRegisterCaptcha',
  });
  assert.deepEqual(verificationSettings({...auth, registration_type: 1}), {
    channel: 'phone',
    required: false,
    action: 'phoneRegisterCaptcha',
  });
  assert.deepEqual(verificationSettings({...auth, registration_type: 0}), {
    channel: null,
    required: false,
    action: null,
  });
  assert.deepEqual(verificationSettings(auth, true), {
    channel: 'email',
    required: true,
    action: 'emailForgetCaptcha',
  });
  assert.deepEqual(verificationSettings({...auth, recovery_type: 1}, true), {
    channel: 'phone',
    required: true,
    action: 'phoneForgetCaptcha',
  });
  assert.equal(recoveryPath(auth), '/user/authentication/emailForget');
});
