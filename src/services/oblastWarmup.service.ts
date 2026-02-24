// services/oblastWarmup.service.ts
import fs from "node:fs";
import { fetchRegionAlertsHistoryFromUpstream } from "../clients/alerts.history.client.js";

export type UpstreamAlert = {
  id?: number;
  started_at: string;
  finished_at: string | null;
  updated_at?: string;

  alert_type?: string;

  location_title?: string;
  location_type?: string;

  location_uid?: string | number;
  location_oblast?: string;
  location_oblast_uid?: string | number;

  [k: string]: unknown;
};

type UpstreamResponse = { alerts: UpstreamAlert[]; [k: string]: unknown };

export type OblastCacheEntry = {
  oblastUid: string;      // "24"
  oblastName: string;     // "Черкаська область"
  updatedAt: string;      // ISO
  period: string;         // "month_ago"

  // raw month alerts (for risk calculations)
  monthAlerts: UpstreamAlert[];

  // derived: last 3 days for UI
  history3d: UpstreamAlert[];
};

const CACHE_FILE = process.env.OBLAST_CACHE_FILE || "./oblast_cache.json";

// in-memory cache
const cache = new Map<string, OblastCacheEntry>();

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function parseMs(s?: string | null) {
  if (!s) return NaN;
  const ms = Date.parse(s);
  return Number.isFinite(ms) ? ms : NaN;
}

function pickOblastName(uid: string, monthAlerts: UpstreamAlert[]) {
  // best effort: from payload fields
  const a0 = monthAlerts.find(Boolean);
  const name = String(a0?.location_oblast ?? a0?.location_title ?? "").trim();
  return name || `Область ${uid}`;
}

function filterLastDays(alerts: UpstreamAlert[], days: number) {
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;

  const filtered = (alerts ?? []).filter((a) => {
    const t =
      parseMs(a.started_at) ||
      parseMs(a.updated_at) ||
      -1;
    return t >= cutoff;
  });

  filtered.sort((a, b) => (parseMs(b.started_at) || 0) - (parseMs(a.started_at) || 0));
  return filtered;
}

function safeReadFile() {
  try {
    const raw = fs.readFileSync(CACHE_FILE, "utf8");
    const obj = JSON.parse(raw) as Record<string, OblastCacheEntry>;
    for (const [k, v] of Object.entries(obj)) cache.set(k, v);
    console.log(`✅ Loaded oblast cache from ${CACHE_FILE} (${cache.size})`);
  } catch {
    // ignore
  }
}

function safeWriteFile() {
  try {
    const obj = Object.fromEntries(cache.entries());
    fs.writeFileSync(CACHE_FILE, JSON.stringify(obj, null, 2), "utf8");
  } catch {
    // ignore
  }
}

export function getOblastCacheEntry(uid: string) {
  return cache.get(uid) ?? null;
}

export function startOblastWarmup(args: {
  oblastUids: string[];      // ["24","27",...]
  period?: string;          // default "month_ago"
  uiDays?: number;          // default 3
  delayMs?: number;         // default 35_000
}) {
  const period = args.period || "month_ago";
  const uiDays = args.uiDays ?? 3;
  const delayMs = args.delayMs ?? 35_000;

  if (!args.oblastUids?.length) {
    console.log("⚠️ Warmup: no oblastUids provided, skipped.");
    return;
  }

  // load snapshot on boot
  safeReadFile();

  let idx = 0;

  const loop = async () => {
    while (true) {
      const uid = args.oblastUids[idx % args.oblastUids.length]!;
      idx++;

      try {
        const raw = (await fetchRegionAlertsHistoryFromUpstream(uid, period)) as UpstreamResponse;
        const monthAlerts = Array.isArray(raw?.alerts) ? raw.alerts : [];

        const oblastName = pickOblastName(uid, monthAlerts);
        const history3d = filterLastDays(monthAlerts, uiDays);

        const entry: OblastCacheEntry = {
          oblastUid: uid,
          oblastName,
          updatedAt: new Date().toISOString(),
          period,
          monthAlerts,
          history3d,
        };

        cache.set(uid, entry);
        safeWriteFile();

        console.log(
          `✅ Warmed oblast=${uid} name="${oblastName}" monthAlerts=${monthAlerts.length} ui3d=${history3d.length}`
        );
      } catch (e) {
        console.log(`⚠️ Warmup failed oblast=${uid}:`, e);
      }

      await sleep(delayMs);
    }
  };

  console.log(
    `🚀 Oblast warmup started: oblasts=${args.oblastUids.length} period=${period} every=${delayMs}ms`
  );

  void loop();
}