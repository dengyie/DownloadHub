export function authSettings(site) {
  const auth = site?.auth;
  const booleans = ['registration_enabled', 'registration_captcha', 'email_verification', 'phone_verification', 'login_captcha'];
  if (!auth || booleans.some(name => typeof auth[name] !== 'boolean') ||
      ![0, 1, 2].includes(auth.registration_type) || ![0, 1].includes(auth.recovery_type) ||
      !Number.isInteger(auth.username_min_length) || auth.username_min_length < 1 || auth.username_min_length > 32) {
    throw new Error('账户服务配置暂时无法加载，请稍后重新加载。资源浏览与卡密兑换不受此影响。');
  }
  return auth;
}

export const recoveryPath = auth => `/user/authentication/${auth.recovery_type === 1 ? 'phoneForget' : 'emailForget'}`;

export function verificationSettings(auth, recovery = false) {
  const channel = recovery ? (auth.recovery_type === 1 ? 'phone' : 'email') : (auth.registration_type === 1 ? 'phone' : auth.registration_type === 2 ? 'email' : null);
  return {
    channel,
    required: !!channel && (recovery || auth[`${channel}_verification`]),
    action: channel ? `${channel}${recovery ? 'Forget' : 'Register'}Captcha` : null,
  };
}
