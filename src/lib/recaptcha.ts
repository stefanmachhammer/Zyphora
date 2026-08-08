/**
 * Google reCAPTCHA v2 verification.
 *
 * Two keys (settings `recaptcha_site_key` / `recaptcha_secret_key`): the public
 * site key renders the widget, the secret key verifies tokens server-side.
 *
 * Opt-in: either key empty ⇒ disabled, verification skipped (a fresh install
 * posts comments without configuring keys). Fail-closed: any missing/rejected
 * token or upstream error returns `false` rather than opening a spam window.
 */
import { getSetting } from './settings.ts';

const VERIFY_URL = 'https://www.google.com/recaptcha/api/siteverify';

/** Subset of Google's siteverify response we inspect; `success` is authoritative. */
type SiteVerifyResponse = {
  success: boolean;
  challenge_ts?: string;
  hostname?: string;
  'error-codes'?: string[];
};

export type RecaptchaConfig = {
  /** Public site key, safe to expose in template HTML. `null` when unset. */
  siteKey: string | null;
  /** Server-only secret. `null` when unset — never expose to templates. */
  secretKey: string | null;
  /** Convenience: true iff both keys are present and non-empty. */
  enabled: boolean;
};

/** Load both keys together; partial config (one key set) counts as disabled. */
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

/**
 * Verify a reCAPTCHA v2 token against Google's siteverify endpoint. Returns true
 * only on confirmation; any other outcome (empty token, non-2xx, bad JSON,
 * network error) returns false. Error codes aren't surfaced — callers show one
 * generic message so probing bots learn nothing.
 */
export async function verifyRecaptchaToken(
  token: string | undefined | null,
  secretKey: string,
  remoteIp?: string,
): Promise<boolean> {
  if (!token || token.length === 0) return false;

  const params = new URLSearchParams({ secret: secretKey, response: token });
  // Optional per Google's docs, but improves their risk scoring when present.
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
    return false; // fail-closed on any network/parse error
  }
}
