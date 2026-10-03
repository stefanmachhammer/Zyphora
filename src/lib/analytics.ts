// Privacy guarantees to preserve: no cookies, no raw IP/UA ever stored. A visitor
// is sha256(salt | UTC day | ip | ua) — stable within a UTC day, unlinkable across
// days — so "unique visitors" over several days is the SUM of daily uniques.
//
// Timestamps: Drizzle's mysql `timestamp` reads/writes UTC wall-clock, but MySQL's
// `DEFAULT now()` uses the session time zone. Always set `createdAt` explicitly so
// `DATE_FORMAT(created_at, ...)` yields UTC day keys.
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { and, desc, gte, inArray, lt, sql } from 'drizzle-orm';
import { db, schema } from '../db/client.ts';
import { getSetting } from './settings.ts';
import type { SessionUser } from './auth.ts';

export type Device = 'desktop' | 'mobile' | 'tablet';

export type AnalyticsPeriod = 7 | 30 | 90;

const DAY_MS = 24 * 60 * 60 * 1000;

export function isTrackablePath(path: string): boolean {
  return path === '/' || /^\/posts\/[^/]+\/?$/.test(path);
}

// Tablet first: Android tablet UAs omit the "Mobile" token (hence the negative
// lookahead) and iPad UAs would otherwise match the mobile pattern.
export function classifyDevice(ua: string): Device {
  if (/ipad|tablet|(android(?!.*mobile))/i.test(ua)) return 'tablet';
  if (/mobi|iphone|ipod|android/i.test(ua)) return 'mobile';
  return 'desktop';
}

export function isBot(ua: string): boolean {
  if (!ua.trim()) return true;
  return /bot|crawl|spider|slurp|headless|lighthouse|preview|fetch|curl|wget|python-requests|monitor|uptime|facebookexternalhit|whatsapp|telegram|discord/i.test(
    ua,
  );
}

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
  return host.slice(0, 255);
}

// `clientAddress` is a getter that throws when the adapter can't provide it.
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

export function utcDayKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function startOfUtcDay(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

interface AnalyticsConfig {
  enabled: boolean;
  excludeLoggedIn: boolean;
  retentionDays: number;
}

export const RETENTION_MIN_DAYS = 30;
export const RETENTION_MAX_DAYS = 3650;

export const RETENTION_DEFAULT_DAYS = 365;

// Blank/non-numeric input falls back to the default, NOT the minimum: a missing
// form field must not shrink retention and have the next prune delete a year of data.
export function clampRetentionDays(value: unknown): number {
  if (value === null || value === undefined || String(value).trim() === '') return RETENTION_DEFAULT_DAYS;
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return RETENTION_DEFAULT_DAYS;
  return Math.min(RETENTION_MAX_DAYS, Math.max(RETENTION_MIN_DAYS, n));
}

// The promise (not the value) is cached so concurrent requests on an expired
// cache share one lookup.
const CONFIG_TTL_MS = 30_000;
let configCache: { promise: Promise<AnalyticsConfig>; at: number } | null = null;

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
  // A failed read must not be served for the whole TTL.
  promise.catch(() => {
    if (configCache === entry) configCache = null;
  });
  return promise;
}

export function invalidateAnalyticsConfig(): void {
  configCache = null;
}

let saltPromise: Promise<string> | null = null;

function getSalt(): Promise<string> {
  if (!saltPromise) {
    saltPromise = (async () => {
      const existing = await getSetting('analytics_salt', '');
      if (existing) return existing;
      await db
        .insert(schema.settings)
        .values({ key: 'analytics_salt', value: randomBytes(32).toString('hex') })
        // Not setSetting(): an upsert would overwrite a salt another process
        // just created and split that day's hashes. First writer wins.
        .onDuplicateKeyUpdate({ set: { value: sql`${schema.settings.value}` } });
      return getSetting('analytics_salt', '');
    })().catch((err) => {
      saltPromise = null;
      throw err;
    });
  }
  return saltPromise;
}

export async function visitorHash(ip: string, ua: string, now = new Date()): Promise<string> {
  const salt = await getSalt();
  return createHash('sha256').update(`${salt}|${utcDayKey(now)}|${ip}|${ua}`).digest('hex');
}

export interface TrackDecisionInput {
  method: string;
  path: string;
  status: number;
  contentType: string | null;
  userAgent: string;
  dnt: string | null;
  gpc: string | null;
  purpose: string | null;
  user: SessionUser | null;
}

export async function shouldTrack(input: TrackDecisionInput): Promise<boolean> {
  if (input.method !== 'GET') return false;
  if (!isTrackablePath(input.path)) return false;
  if (input.status !== 200) return false;
  if (!input.contentType || !input.contentType.toLowerCase().includes('text/html')) return false;
  if (isBot(input.userAgent)) return false;
  if (input.dnt === '1' || input.gpc === '1') return false;
  if (input.purpose && /prefetch|prerender/i.test(input.purpose)) return false;

  const config = await getAnalyticsConfig();
  if (!config.enabled) return false;
  if (config.excludeLoggedIn && input.user) return false;
  return true;
}

export interface PageviewInput {
  path: string;
  postId: string | null;
  referer: string | null;
  selfHost: string;
  userAgent: string;
  ip: string;
}

const WARN_INTERVAL_MS = 60_000;
let lastWarnAt = 0;

function warnThrottled(message: string, err: unknown): void {
  const now = Date.now();
  if (now - lastWarnAt < WARN_INTERVAL_MS) return;
  lastWarnAt = now;
  console.warn(`[analytics] ${message}:`, err instanceof Error ? err.message : err);
}

const PRUNE_INTERVAL_MS = 60 * 60 * 1000;
let lastPruneAt = 0;

// Must never throw: the middleware calls this without awaiting.
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
      // Explicit, not defaultNow() — see the timestamp note at the top.
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

function retentionCutoff(retentionDays: number, now = new Date()): Date {
  return new Date(startOfUtcDay(now).getTime() - retentionDays * DAY_MS);
}

export async function pruneOldPageviews(): Promise<void> {
  const { retentionDays } = await getAnalyticsConfig();
  await db.delete(schema.pageviews).where(lt(schema.pageviews.createdAt, retentionCutoff(retentionDays)));
}

export interface DailyPoint {
  date: string;
  views: number;
  visitors: number;
}

export interface AnalyticsSummary {
  days: AnalyticsPeriod;
  totalViews: number;
  uniqueVisitors: number;
  prevTotalViews: number;
  prevUniqueVisitors: number;
  comparable: boolean;
  viewsToday: number;
  viewsYesterdaySameTime: number;
  perDay: DailyPoint[];
  topPages: { path: string; views: number; postId: string | null; title: string | null }[];
  topReferrers: { host: string | null; views: number }[];
  devices: { device: Device; views: number }[];
}

// mysql2 may return COUNT() as a string (BIGINT); every aggregate goes through Number().
const viewsExpr = sql<number>`count(*)`;
const dayExpr = sql<string>`DATE_FORMAT(${schema.pageviews.createdAt}, '%Y-%m-%d')`;

function sumVisitors(rows: { visitors: number }[]): number {
  return rows.reduce((n, r) => n + Number(r.visitors), 0);
}

export async function getAnalyticsSummary(days: AnalyticsPeriod): Promise<AnalyticsSummary> {
  const now = new Date();
  const today = startOfUtcDay(now);
  const start = new Date(today.getTime() - (days - 1) * DAY_MS);
  const prevStart = new Date(start.getTime() - days * DAY_MS);
  // The current period ends now, mid-day. Comparing it with `days` FULL previous
  // days would read as a drop every morning, so the previous window is cut to
  // the same elapsed length; likewise "today" vs yesterday-up-to-this-hour.
  const elapsedMs = now.getTime() - start.getTime();
  const prevEnd = new Date(prevStart.getTime() + elapsedMs);
  const yesterday = new Date(today.getTime() - DAY_MS);
  const yesterdaySameTime = new Date(yesterday.getTime() + (now.getTime() - today.getTime()));
  const inRange = gte(schema.pageviews.createdAt, start);
  const pv = schema.pageviews;
  const visitorsExpr = sql<number>`count(distinct ${pv.visitorHash})`;

  const [dailyRows, prevRows, yesterdayRows, pageRows, referrerRows, deviceRows, config] = await Promise.all([
    db
      .select({ date: dayExpr, views: viewsExpr, visitors: visitorsExpr })
      .from(pv)
      .where(inRange)
      .groupBy(dayExpr),
    db
      .select({ views: viewsExpr, visitors: visitorsExpr })
      .from(pv)
      .where(and(gte(pv.createdAt, prevStart), lt(pv.createdAt, prevEnd))),
    db
      .select({ views: viewsExpr })
      .from(pv)
      .where(and(gte(pv.createdAt, yesterday), lt(pv.createdAt, yesterdaySameTime))),
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
    // Previous-period counts are partial once pruning has eaten into them; the page then hides deltas.
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

export async function countRecentViews(days: number): Promise<number> {
  const start = new Date(startOfUtcDay(new Date()).getTime() - (days - 1) * DAY_MS);
  const rows = await db
    .select({ views: viewsExpr })
    .from(schema.pageviews)
    .where(gte(schema.pageviews.createdAt, start));
  return Number(rows[0]?.views ?? 0);
}
