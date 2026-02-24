// services/alertsHistory.cache.ts
import { fetchRegionAlertsHistoryFromUpstream } from "../clients/alerts.history.client.js";

type UpstreamAlert = {
  id: number;
  started_at: string; // ISO
  finished_at: string | null;
  updated_at?: string;
  [k: string]: unknown;
};

type UpstreamResponse = {
  alerts: UpstreamAlert[];
  [k: string]: unknown;
};

const TTL = Number(process.env.HISTORY_CACHE_TTL_MS || 60000); // 60s
const DEFAULT_DAYS = Number(process.env.HISTORY_DAYS_DEFAULT || 3);

// ✅ ВАЖЛИВО: cache key БЕЗ days (days тільки для фільтрації)
const cache = new Map<
  string,
  { raw: UpstreamResponse | null; lastFetch: number; inFlight: Promise<UpstreamResponse> | null }
>();

function clampDays(days: number) {
  if (!Number.isFinite(days)) return DEFAULT_DAYS;
  // для історії показуємо 1..7, але для ризику хочеш "місяць" -> дозволимо до 31
  return Math.min(Math.max(Math.floor(days), 1), 31);
}

function safeParseTs(a: UpstreamAlert): number {
  const s = Date.parse(a.started_at);
  if (Number.isFinite(s)) return s;

  if (a.updated_at) {
    const u = Date.parse(a.updated_at);
    if (Number.isFinite(u)) return u;
  }

  return -1;
}

function filterLastDays(resp: UpstreamResponse, days: number): UpstreamResponse {
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;

  const filtered = (resp.alerts ?? []).filter((a) => {
    const t = safeParseTs(a);
    return t >= cutoff;
  });

  // новіші зверху
  filtered.sort((a, b) => safeParseTs(b) - safeParseTs(a));

  return { ...resp, alerts: filtered };
}

/**
 * ✅ Кешуємо "raw" відповідь (без фільтра days), а фільтруємо на виході.
 * Це гарантує, що history(days=3) і risk(days=30) НЕ викличуть upstream двічі.
 */
export async function getRegionAlertsHistoryCached(
  uid: string,
  period: string,
  days?: number
) {
  const d = clampDays(days ?? DEFAULT_DAYS);
  const key = `${uid}::${period}`;

  const now = Date.now();
  const entry =
    cache.get(key) ?? { raw: null, lastFetch: 0, inFlight: null };

  // raw кеш актуальний
  if (entry.raw !== null && now - entry.lastFetch < TTL) {
    return filterLastDays(entry.raw, d);
  }

  // вже йде fetch — чекаємо
  if (entry.inFlight) {
    const raw = await entry.inFlight;
    return filterLastDays(raw, d);
  }

  // робимо новий upstream fetch
  entry.inFlight = (async () => {
    try {
      const raw = (await fetchRegionAlertsHistoryFromUpstream(
        uid,
        period
      )) as UpstreamResponse;

      // нормалізуємо масив alerts
      const alerts = Array.isArray(raw?.alerts) ? raw.alerts : [];
      const normalized: UpstreamResponse = { ...raw, alerts };

      entry.raw = normalized;
      entry.lastFetch = Date.now();
      return normalized;
    } finally {
      entry.inFlight = null;
      cache.set(key, entry);
    }
  })();

  cache.set(key, entry);

  const raw = await entry.inFlight;
  return filterLastDays(raw, d);
}