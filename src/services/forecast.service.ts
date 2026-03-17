// services/forecast.service.ts

export type UpstreamAlert = {
  started_at: string;
  finished_at: string | null;
  updated_at?: string;
};

export type ForecastPeriod = {
  from: string; // "20:00"
  to: string;   // "22:00"
  level: "LOW" | "MEDIUM" | "HIGH";
  percent: number; // 0..100
};

export type ForecastResponse = {
  ok: true;
  oblastUid: string;
  oblastName: string;
  updatedAt: string;

  tz: string;      // e.g. "Europe/Kyiv"
  daysBack: number; // e.g. 30

  periods: ForecastPeriod[];     // ALWAYS 24 rows
  hourlyPercent: number[];       // 24 values 0..100
};

function fmtH(h: number) {
  return String(h).padStart(2, "0") + ":00";
}

// ✅ Hour in TZ (0..23) without extra libs
function getHourInTz(iso: string, tz: string): number | null {
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return null;

  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hour: "2-digit",
    hour12: false,
  });

  const parts = fmt.formatToParts(d);
  const hh = parts.find((p) => p.type === "hour")?.value;
  const hour = hh == null ? NaN : Number(hh);
  if (!Number.isFinite(hour) || hour < 0 || hour > 23) return null;
  return hour;
}

// ✅ Day key in TZ as "YYYY-MM-DD" (en-CA gives that format)
function getDayKeyInTz(iso: string, tz: string): string | null {
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return null;

  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });

  return fmt.format(d); // "YYYY-MM-DD"
}

/**
 * Forecast model (stable):
 * - For each hour, count "distinct days where an alert START happened in this hour"
 * - Convert to probability: p = (k + alpha) / (N + alpha + beta)
 * - N = daysBack (window size), default 30
 * - Return ALWAYS 24 hourly periods (no merge), to guarantee full scroll 00:00..00:00
 */
export function computeOblastForecast(args: {
  oblastUid: string;
  oblastName: string;
  updatedAt: string;
  monthAlerts: UpstreamAlert[];

  tz?: string;       // default Europe/Kyiv
  daysBack?: number; // default 30
}): ForecastResponse {
  const tz = args.tz || "Europe/Kyiv";
  const daysBack = Math.max(1, Math.floor(args.daysBack ?? 30));

  // For each hour: set of days where a START happened in that hour
  const hourDays: Array<Set<string>> = Array.from(
    { length: 24 },
    () => new Set<string>()
  );

  for (const a of args.monthAlerts ?? []) {
    const iso = String(a?.started_at ?? "").trim();
    if (!iso) continue;

    const dayKey = getDayKeyInTz(iso, tz);
    const hour = getHourInTz(iso, tz);
    if (!dayKey || hour == null) continue;

    hourDays[hour].add(dayKey);
  }

  // N = window days (use daysBack, not "unique days in data")
  const N = daysBack;

  // Bayesian smoothing (prevents spikes in sparse regions)
  // More conservative => bigger beta.
  const alpha = 1; // pseudo-successes
  const beta = 6;  // pseudo-failures

  const hourlyPercent = Array.from({ length: 24 }, (_, h) => {
    const k = hourDays[h].size; // distinct days with start in this hour
    const p = (k + alpha) / (N + alpha + beta);
    const pct = Math.round(Math.max(0, Math.min(1, p)) * 100);
    return pct;
  });

  // ✅ Absolute thresholds (as you asked):
  // >=60 red, >=40 orange, else green
  function levelOfPercent(p: number): "LOW" | "MEDIUM" | "HIGH" {
    if (p >= 60) return "HIGH";
    if (p >= 40) return "MEDIUM";
    return "LOW";
  }

  // ✅ ALWAYS 24 rows
  const periods: ForecastPeriod[] = Array.from({ length: 24 }, (_, h) => {
    const p = hourlyPercent[h];
    return {
      from: fmtH(h),
      to: fmtH((h + 1) % 24),
      level: levelOfPercent(p),
      percent: p,
    };
  });

  return {
    ok: true,
    oblastUid: args.oblastUid,
    oblastName: args.oblastName,
    updatedAt: args.updatedAt,
    tz,
    daysBack,
    periods,
    hourlyPercent,
  };
}