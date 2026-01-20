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

const TTL = Number(process.env.HISTORY_CACHE_TTL_MS || 60000); // 60s => <= 1/min
const DEFAULT_DAYS = Number(process.env.HISTORY_DAYS_DEFAULT || 3);

const cache = new Map<
  string,
  { data: unknown; lastFetch: number; inFlight: Promise<unknown> | null }
>();

function clampDays(days: number) {
  if (!Number.isFinite(days)) return DEFAULT_DAYS;
  return Math.min(Math.max(Math.floor(days), 1), 7); // 1..7
}

function safeParseTs(a: UpstreamAlert): number {
  // 1) started_at (основне)
  const s = Date.parse(a.started_at);
  if (Number.isFinite(s)) return s;

  // 2) updated_at (fallback)
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

  // стабільне сортування: новіші зверху, некоректні (t=-1) підуть вниз
  filtered.sort((a, b) => safeParseTs(b) - safeParseTs(a));

  return { ...resp, alerts: filtered };
}

export async function getRegionAlertsHistoryCached(uid: string, period: string, days?: number) {
  const d = clampDays(days ?? DEFAULT_DAYS);
  const key = `${uid}::${period}::${d}`;

  const now = Date.now();
  const entry = cache.get(key) ?? { data: null, lastFetch: 0, inFlight: null };

  if (entry.data !== null && now - entry.lastFetch < TTL) {
    return entry.data;
  }

  if (entry.inFlight) return entry.inFlight;

  entry.inFlight = (async () => {
    try {
      const raw = (await fetchRegionAlertsHistoryFromUpstream(uid, period)) as UpstreamResponse;
      const pruned = filterLastDays(raw, d);

      entry.data = pruned;
      entry.lastFetch = Date.now();
      return pruned;
    } finally {
      entry.inFlight = null;
      cache.set(key, entry);
    }
  })();

  cache.set(key, entry);
  return entry.inFlight;
}
