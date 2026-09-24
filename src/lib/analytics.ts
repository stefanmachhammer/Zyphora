/**
 * Site analytics — cookieless, server-side page-view counting for the public
 * site, plus the aggregate queries behind `/admin/analytics`.
 *
 * Privacy model (keep these guarantees if you touch this file):
 *   - No cookies, no client-side tracker. Views are recorded by the middleware
 *     after the page has rendered (see `src/middleware.ts`).
 *   - No raw IP address or user-agent is ever persisted. A visitor is reduced
 *     to `sha256(salt | UTC day | ip | ua)`: stable within one UTC day (so we
 *     can count unique visitors per day) but unlinkable across days, and not
 *     reversible without the server-side salt.
 *   - Referrers are reduced to a hostname — paths and query strings can carry
 *     search terms or tokens.
 *   - `DNT: 1` and `Sec-GPC: 1` opt a request out entirely; logged-in users are
 *     skipped by default; the whole feature can be switched off in Settings.
 *   - Rows older than `analytics_retention_days` are pruned lazily.
 *
 * Because the visitor hash rotates daily, "unique visitors" over a multi-day
 * period is the sum of daily uniques: a person visiting on three days counts
 * three times. That's the price of not being able to follow anyone across days.
 *
 * Timestamps: Drizzle's mysql `timestamp` column writes and reads UTC
 * wall-clock strings, while MySQL's `DEFAULT now()` uses the *session* time
 * zone (often local). We therefore always set `createdAt` explicitly and only
 * compare against Dates through Drizzle column operators, so the stored
 * wall-clock is UTC and `DATE_FORMAT(created_at, ...)` yields UTC day keys.
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { and, desc, gte, inArray, lt, sql } from 'drizzle-orm';
import { db, schema } from '../db/client.ts';
import { getSetting } from './settings.ts';
import type { SessionUser } from './auth.ts';

/** Device buckets stored in `pageviews.device`. */
export type Device = 'desktop' | 'mobile' | 'tablet';

/** Report periods offered by the admin page. */
export type AnalyticsPeriod = 7 | 30 | 90;

const DAY_MS = 24 * 60 * 60 * 1000;

// ── Classification helpers (pure) ────────────────────────────────────

/**
 * True only for the public routes worth counting: the homepage and a single
 * post (`/posts/<slug>`, exactly one segment, optional trailing slash — Astro
 * renders both spellings). Admin, install, assets, search, login etc. are
 * ignored so the report reflects content traffic only.
 */
export function isTrackablePath(path: string): boolean {
  return path === '/' || /^\/posts\/[^/]+\/?$/.test(path);
}

/**
 * Coarse device class from the user-agent. Tablet is tested first because
 * iPad / Android tablet UAs would otherwise match the mobile pattern
 * (Android tablets omit the "Mobile" token, hence the negative lookahead).
 */
export function classifyDevice(ua: string): Device {
  if (/ipad|tablet|(android(?!.*mobile))/i.test(ua)) return 'tablet';
  if (/mobi|iphone|ipod|android/i.test(ua)) return 'mobile';
  return 'desktop';
}

/**
 * Heuristic bot filter. An empty UA is treated as a bot (real browsers always
 * send one). Link-preview fetchers (Slack/WhatsApp/Discord unfurls) are
 * included — they're not human views of the page.
 */
export function isBot(ua: string): boolean {
  if (!ua.trim()) return true;
  return /bot|crawl|spider|slurp|headless|lighthouse|preview|fetch|curl|wget|python-requests|monitor|uptime|facebookexternalhit|whatsapp|telegram|discord/i.test(
    ua,
  );
}

/**
 * Reduce a `Referer` header to a bare hostname: lowercased, leading `www.`
 * stripped. Returns null for a missing/unparseable/non-http(s) referrer and
 * for same-site navigation (`selfHost`), which the report buckets as "direct".
 */
export function referrerHost(referer: string | null | undefined, selfHost: string): string | null {
  if (!referer) return null;
  let host: string;
  try {
    const url = new URL(referer);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    host = url.hostname.toLowerCase();
  } catch {
    return null;
  }
  const strip = (h: string) => h.toLowerCase().replace(/^www\./, '');
  host = strip(host);
  if (!host || host === strip(selfHost)) return null;
  // Column is varchar(255); DNS names cap at 253, but be defensive.
  return host.slice(0, 255);
}

/**
 * Best-effort client IP, used *only* as hash input — never stored. Prefers the
 * first `X-Forwarded-For` hop (reverse-proxy deploys), else the socket address.
 * XFF is client-spoofable, but the worst a spoofer can do is inflate their own
 * unique-visitor count, so we don't gate it on a trusted-proxy list.
 * `clientAddress` is a getter that throws when the adapter can't provide it
 * (e.g. prerendering), hence the try/catch.
 */
export function clientIp(ctx: { request: Request; clientAddress?: string }): string {
  const xff = ctx.request.headers.get('x-forwarded-for');
  if (xff) {
    const first = xff.split(',')[0]?.trim();
    if (first) return first;
  }
  try {
    return ctx.clientAddress ?? '';
  } catch {
    return '';
  }
}

/** `YYYY-MM-DD` for the UTC day containing `d`. */
export function utcDayKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Midnight UTC at the start of the day containing `d`. */
function startOfUtcDay(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

// ── Settings (cached) ────────────────────────────────────────────────

interface AnalyticsConfig {
  enabled: boolean;
  excludeLoggedIn: boolean;
  retentionDays: number;
}

/** Bounds for `analytics_retention_days`; the settings form clamps to these too. */
export const RETENTION_MIN_DAYS = 30;
export const RETENTION_MAX_DAYS = 3650;

export const RETENTION_DEFAULT_DAYS = 365;

/**
 * Clamp an arbitrary input to a valid retention window. Missing, blank or
 * non-numeric input falls back to the default rather than the minimum: a
 * scripted POST without the field, or a blank stored value, must not silently
 * shrink retention to 30 days and have the next prune delete a year of data.
 */
export function clampRetentionDays(value: unknown): number {
  if (value === null || value === undefined || String(value).trim() === '') return RETENTION_DEFAULT_DAYS;
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return RETENTION_DEFAULT_DAYS;
  return Math.min(RETENTION_MAX_DAYS, Math.max(RETENTION_MIN_DAYS, n));
}

// `shouldTrack` runs on every public page view; caching the three settings for
// 30 s saves three point-reads per request. The *promise* is cached (not just
// the value) so concurrent requests arriving on an expired cache share one
// lookup instead of each firing their own. The settings page calls
// `invalidateAnalyticsConfig()` after saving so its own process sees changes
// immediately; other processes converge within the TTL.
const CONFIG_TTL_MS = 30_000;
let configCache: { promise: Promise<AnalyticsConfig>; at: number } | null = null;

/** Read (and cache) the analytics settings, applying the documented defaults. */
export function getAnalyticsConfig(): Promise<AnalyticsConfig> {
  if (configCache && Date.now() - configCache.at < CONFIG_TTL_MS) return configCache.promise;
  const promise = Promise.all([
    getSetting('analytics_enabled', '1'),
    getSetting('analytics_exclude_logged_in', '1'),
    getSetting('analytics_retention_days', String(RETENTION_DEFAULT_DAYS)),
  ]).then(([enabled, exclude, retention]) => ({
    enabled: enabled === '1',
    excludeLoggedIn: exclude === '1',
    retentionDays: clampRetentionDays(retention),
  }));
  const entry = { promise, at: Date.now() };
  configCache = entry;
  // A failed read must not be served for 30 s — drop it so the next call retries.
  promise.catch(() => {
    if (configCache === entry) configCache = null;
  });
  return promise;
}

/** Drop the cached settings so the next read hits the DB (call after saving). */
export function invalidateAnalyticsConfig(): void {
  configCache = null;
}

// ── Visitor hashing ──────────────────────────────────────────────────

// The salt is generated once per site and kept in `settings.analytics_salt`.
// Cached as a promise so concurrent first requests share one lookup.
let saltPromise: Promise<string> | null = null;

/**
 * Load the site's hashing salt, creating it on first use. Creation is
 * race-safe: the insert's ON DUPLICATE KEY branch is a no-op, so if two
 * processes race, the first writer wins and both re-read the same value.
 */
function getSalt(): Promise<string> {
  if (!saltPromise) {
    saltPromise = (async () => {
      const existing = await getSetting('analytics_salt', '');
      if (existing) return existing;
      await db
        .insert(schema.settings)
        .values({ key: 'analytics_salt', value: randomBytes(32).toString('hex') })
        // Deliberately not setSetting(): an upsert would overwrite a salt
        // another process just created and split that day's hashes.
        .onDuplicateKeyUpdate({ set: { value: sql`${schema.settings.value}` } });
      return getSetting('analytics_salt', '');
    })().catch((err) => {
      // Don't cache a failure — retry on the next request.
      saltPromise = null;
      throw err;
    });
  }
  return saltPromise;
}

/**
 * Daily-rotating pseudonymous visitor id: hex sha256 of salt, UTC day, IP and
 * UA. Including the day means yesterday's and today's hashes for the same
 * person are unrelated.
 */
export async function visitorHash(ip: string, ua: string, now = new Date()): Promise<string> {
  const salt = await getSalt();
  return createHash('sha256').update(`${salt}|${utcDayKey(now)}|${ip}|${ua}`).digest('hex');
}

// ── Recording ────────────────────────────────────────────────────────

/** Inputs `shouldTrack` needs; all come straight off the request/response. */
export interface TrackDecisionInput {
  method: string;
  path: string;
  status: number;
  contentType: string | null;
  userAgent: string;
  dnt: string | null;
  gpc: string | null;
  /** `Sec-Purpose` / `Purpose` header — browsers mark speculative prefetches. */
  purpose: string | null;
  user: SessionUser | null;
}

/**
 * Decide whether a finished request counts as a page view. Cheap header/path
 * checks run first so asset and admin requests never touch the DB; settings
 * are consulted last (and are cached).
 */
export async function shouldTrack(input: TrackDecisionInput): Promise<boolean> {
  if (input.method !== 'GET') return false;
  if (!isTrackablePath(input.path)) return false;
  // Only real 200 renders — 404s, redirects (e.g. comment PRG) and errors don't count.
  if (input.status !== 200) return false;
  if (!input.contentType || !input.contentType.toLowerCase().includes('text/html')) return false;
  if (isBot(input.userAgent)) return false;
  // Honor explicit browser opt-out signals.
  if (input.dnt === '1' || input.gpc === '1') return false;
  // Speculative prefetch/prerender is not a person looking at the page.
  if (input.purpose && /prefetch|prerender/i.test(input.purpose)) return false;

  const config = await getAnalyticsConfig();
  if (!config.enabled) return false;
  if (config.excludeLoggedIn && input.user) return false;
  return true;
}

/** What the middleware hands over for one view. Raw IP/UA are hash input only. */
export interface PageviewInput {
  path: string;
  postId: string | null;
  referer: string | null;
  selfHost: string;
  userAgent: string;
  ip: string;
}

// Log throttling: a DB outage would otherwise print one warning per page view.
const WARN_INTERVAL_MS = 60_000;
let lastWarnAt = 0;

/** `console.warn` at most once per minute per process. */
function warnThrottled(message: string, err: unknown): void {
  const now = Date.now();
  if (now - lastWarnAt < WARN_INTERVAL_MS) return;
  lastWarnAt = now;
  console.warn(`[analytics] ${message}:`, err instanceof Error ? err.message : err);
}

// Retention pruning piggybacks on recording, at most once per hour per process.
const PRUNE_INTERVAL_MS = 60 * 60 * 1000;
let lastPruneAt = 0;

/**
 * Persist one page view. Never throws — analytics must not be able to break
 * page rendering (the middleware also calls it without awaiting). Also kicks
 * off the hourly retention prune.
 */
export async function recordPageview(input: PageviewInput): Promise<void> {
  try {
    const now = new Date();
    await db.insert(schema.pageviews).values({
      id: randomUUID(),
      path: input.path.slice(0, 500),
      postId: input.postId,
      referrerHost: referrerHost(input.referer, input.selfHost),
      visitorHash: await visitorHash(input.ip, input.userAgent, now),
      device: classifyDevice(input.userAgent),
      // Explicit, not defaultNow() — see the timestamp note in the header.
      createdAt: now,
    });
  } catch (err) {
    warnThrottled('failed to record page view', err);
  }

  if (Date.now() - lastPruneAt >= PRUNE_INTERVAL_MS) {
    // Stamp before running so concurrent requests don't all start a prune.
    lastPruneAt = Date.now();
    try {
      await pruneOldPageviews();
    } catch (err) {
      warnThrottled('failed to prune old page views', err);
    }
  }
}

/** Midnight UTC `retentionDays` days ago — everything before it is prunable. */
function retentionCutoff(retentionDays: number, now = new Date()): Date {
  return new Date(startOfUtcDay(now).getTime() - retentionDays * DAY_MS);
}

/**
 * Delete page views older than the configured retention window. The cutoff is
 * aligned to a UTC day boundary so the oldest day still in the window is kept
 * whole rather than being trimmed hour by hour.
 */
export async function pruneOldPageviews(): Promise<void> {
  const { retentionDays } = await getAnalyticsConfig();
  await db.delete(schema.pageviews).where(lt(schema.pageviews.createdAt, retentionCutoff(retentionDays)));
}

// ── Reporting ────────────────────────────────────────────────────────

/** One point of the views-per-day series. */
export interface DailyPoint {
  date: string;
  views: number;
  visitors: number;
}

/** Shape consumed by `/admin/analytics`. All counts are plain numbers. */
export interface AnalyticsSummary {
  days: AnalyticsPeriod;
  totalViews: number;
  uniqueVisitors: number;
  /**
   * Previous-period counts over the *same elapsed span* as the current period
   * (which ends now, mid-day), so the comparison isn't biased by today being
   * partial. E.g. at 09:00 UTC on day 7 of a 7-day view, this covers 6 days
   * plus 9 hours of the period before.
   */
  prevTotalViews: number;
  prevUniqueVisitors: number;
  /**
   * False when the retention window has already pruned (part of) the previous
   * period — the previous counts are then undercounts and deltas are hidden.
   */
  comparable: boolean;
  viewsToday: number;
  /** Yesterday's views up to the same time of day as now — the fair peer of `viewsToday`. */
  viewsYesterdaySameTime: number;
  perDay: DailyPoint[];
  topPages: { path: string; views: number; postId: string | null; title: string | null }[];
  topReferrers: { host: string | null; views: number }[];
  devices: { device: Device; views: number }[];
}

// mysql2 may return COUNT() as a string (BIGINT), so every aggregate is
// wrapped in Number() at the boundary.
const viewsExpr = sql<number>`count(*)`;
// Daily-rotating hashes make DISTINCT per day == unique people per day; see
// the header note for what that means over longer periods.
const dayExpr = sql<string>`DATE_FORMAT(${schema.pageviews.createdAt}, '%Y-%m-%d')`;

/**
 * Unique visitors over a range = sum of per-day distinct hashes (a hash only
 * identifies someone within its own day, so distinct-over-range would be the
 * same number anyway; summing makes that explicit).
 */
function sumVisitors(rows: { visitors: number }[]): number {
  return rows.reduce((n, r) => n + Number(r.visitors), 0);
}

/**
 * Aggregate the last `days` UTC days (today inclusive) plus the same-length
 * period immediately before it, for the admin report.
 */
export async function getAnalyticsSummary(days: AnalyticsPeriod): Promise<AnalyticsSummary> {
  const now = new Date();
  const today = startOfUtcDay(now);
  const start = new Date(today.getTime() - (days - 1) * DAY_MS);
  const prevStart = new Date(start.getTime() - days * DAY_MS);
  // The current period is [start, now) — (days − 1) full days plus today so
  // far. Comparing it with `days` *full* previous days would read as a drop
  // every morning, so the previous window is cut to the same elapsed length.
  const elapsedMs = now.getTime() - start.getTime();
  const prevEnd = new Date(prevStart.getTime() + elapsedMs);
  // Same idea for "today": its fair peer is yesterday up to this time of day.
  const yesterday = new Date(today.getTime() - DAY_MS);
  const yesterdaySameTime = new Date(yesterday.getTime() + (now.getTime() - today.getTime()));
  const inRange = gte(schema.pageviews.createdAt, start);
  const pv = schema.pageviews;
  const visitorsExpr = sql<number>`count(distinct ${pv.visitorHash})`;

  // Independent aggregates run concurrently; only the post titles depend on
  // another result (top pages) and are fetched afterwards.
  const [dailyRows, prevRows, yesterdayRows, pageRows, referrerRows, deviceRows, config] = await Promise.all([
    // Per-day rows for the current period, zero-filled below.
    db
      .select({ date: dayExpr, views: viewsExpr, visitors: visitorsExpr })
      .from(pv)
      .where(inRange)
      .groupBy(dayExpr),
    // Previous period, trimmed to the elapsed span (see above). Hashes are
    // day-scoped, so DISTINCT over several days equals the sum of daily uniques.
    db
      .select({ views: viewsExpr, visitors: visitorsExpr })
      .from(pv)
      .where(and(gte(pv.createdAt, prevStart), lt(pv.createdAt, prevEnd))),
    db
      .select({ views: viewsExpr })
      .from(pv)
      .where(and(gte(pv.createdAt, yesterday), lt(pv.createdAt, yesterdaySameTime))),
    // Top pages. Grouped by path only; MAX(post_id) picks up the post link for
    // post URLs (null for `/` or a since-deleted post).
    db
      .select({ path: pv.path, postId: sql<string | null>`max(${pv.postId})`, views: viewsExpr })
      .from(pv)
      .where(inRange)
      .groupBy(pv.path)
      .orderBy(desc(viewsExpr))
      .limit(10),
    db
      .select({ host: pv.referrerHost, views: viewsExpr })
      .from(pv)
      .where(inRange)
      .groupBy(pv.referrerHost)
      .orderBy(desc(viewsExpr))
      .limit(10),
    db
      .select({ device: pv.device, views: viewsExpr })
      .from(pv)
      .where(inRange)
      .groupBy(pv.device)
      .orderBy(desc(viewsExpr)),
    getAnalyticsConfig(),
  ]);

  // Zero-filled series, oldest first, one entry per day in range.
  const byDate = new Map(dailyRows.map((r) => [r.date, r]));
  const perDay: DailyPoint[] = [];
  for (let i = 0; i < days; i++) {
    const key = utcDayKey(new Date(start.getTime() + i * DAY_MS));
    const row = byDate.get(key);
    perDay.push({ date: key, views: Number(row?.views ?? 0), visitors: Number(row?.visitors ?? 0) });
  }

  const postIds = pageRows.map((r) => r.postId).filter((id): id is string => !!id);
  const titleRows = postIds.length
    ? await db
        .select({ id: schema.posts.id, title: schema.posts.title })
        .from(schema.posts)
        .where(inArray(schema.posts.id, postIds))
    : [];
  const titles = new Map(titleRows.map((r) => [r.id, r.title]));

  return {
    days,
    totalViews: perDay.reduce((n, d) => n + d.views, 0),
    uniqueVisitors: sumVisitors(dailyRows),
    prevTotalViews: Number(prevRows[0]?.views ?? 0),
    prevUniqueVisitors: Number(prevRows[0]?.visitors ?? 0),
    // If pruning has eaten into the previous period, its counts are partial
    // and any delta would be inflated — the page hides them instead.
    comparable: prevStart >= retentionCutoff(config.retentionDays, now),
    viewsToday: perDay[perDay.length - 1]?.views ?? 0,
    viewsYesterdaySameTime: Number(yesterdayRows[0]?.views ?? 0),
    perDay,
    topPages: pageRows.map((r) => ({
      path: r.path,
      views: Number(r.views),
      postId: r.postId ?? null,
      title: r.postId ? titles.get(r.postId) ?? null : null,
    })),
    topReferrers: referrerRows.map((r) => ({ host: r.host, views: Number(r.views) })),
    devices: deviceRows.map((r) => ({ device: r.device, views: Number(r.views) })),
  };
}

/**
 * Cheap single-count variant for the dashboard tile: views over the last
 * `days` UTC days, today inclusive (same window as `getAnalyticsSummary`).
 */
export async function countRecentViews(days: number): Promise<number> {
  const start = new Date(startOfUtcDay(new Date()).getTime() - (days - 1) * DAY_MS);
  const rows = await db
    .select({ views: viewsExpr })
    .from(schema.pageviews)
    .where(gte(schema.pageviews.createdAt, start));
  return Number(rows[0]?.views ?? 0);
}
