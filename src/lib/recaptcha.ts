import { getSetting } from './settings.ts';

const VERIFY_URL = 'https://www.google.com/recaptcha/api/siteverify';

type SiteVerifyResponse = {
  success: boolean;
  challenge_ts?: string;
  hostname?: string;
  'error-codes'?: string[];
};

export type RecaptchaConfig = {
  siteKey: string | null;
  secretKey: string | null;
  enabled: boolean;
};

export async function getRecaptchaConfig(): Promise<RecaptchaConfig> {
  const [siteKey, secretKey] = await Promise.all([
    getSetting('recaptcha_site_key', ''),
    getSetting('recaptcha_secret_key', ''),
  ]);
  const enabled = siteKey.length > 0 && secretKey.length > 0;
  return {
    siteKey: siteKey || null,
    secretKey: secretKey || null,
    enabled,
  };
}

export async function verifyRecaptchaToken(
  token: string | undefined | null,
  secretKey: string,
  remoteIp?: string,
): Promise<boolean> {
  if (!token || token.length === 0) return false;

  const params = new URLSearchParams({ secret: secretKey, response: token });
  if (remoteIp && remoteIp.length > 0) params.set('remoteip', remoteIp);

  try {
    const res = await fetch(VERIFY_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
    });
    if (!res.ok) return false;
    const data = (await res.json()) as SiteVerifyResponse;
    return data.success === true;
  } catch {
    return false;
  }
}
