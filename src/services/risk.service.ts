// services/risk.service.ts

type UpstreamAlert = {
  started_at: string;
  finished_at: string | null;
  alert_type?: string;
  location_oblast?: string;
  location_title?: string;
  location_type?: string;
};

function clamp01(x: number) {
  return Math.max(0, Math.min(1, x));
}

function safeParseMs(s: string | null | undefined): number | null {
  if (!s) return null;
  const ms = Date.parse(s);
  return Number.isFinite(ms) ? ms : null;
}

function expSafe(x: number) {
  // prevent overflow in extreme cases
  if (x > 50) return Math.exp(50);
  if (x < -50) return Math.exp(-50);
  return Math.exp(x);
}

/**
 * Intelligent risk model (V2):
 * - time decay with half-life
 * - smooth frequency saturation
 * - smooth duration severity
 * - cool-down based on time since last alert
 *
 * Returns score 0..100 + level + label + components (kept compatible with Flutter model).
 */
export function computeOblastRisk(args: {
  oblastUid: string;
  oblastName: string;

  // IMPORTANT: Prefer history for ~30 days (month_ago filtered by days)
  historyAlerts: UpstreamAlert[];

  // active now from /alerts/active
  isActiveNow: boolean;

  // Tunables (all optional):
  halfLifeDays?: number;        // default 5  (older alerts fade)
  freqK?: number;               // default 6  (frequency saturation scale)
  durationTauMin?: number;      // default 45 (duration severity scale)
  recencyTauHours?: number;     // default 36 (cool-down)
}) {
  const now = Date.now();

  const halfLifeDays = Number.isFinite(args.halfLifeDays ?? NaN)
    ? Math.max(1, args.halfLifeDays!)
    : 5;

  const freqK = Number.isFinite(args.freqK ?? NaN) ? Math.max(0.5, args.freqK!) : 6;

  const durationTauMin = Number.isFinite(args.durationTauMin ?? NaN)
    ? Math.max(5, args.durationTauMin!)
    : 45;

  const recencyTauHours = Number.isFinite(args.recencyTauHours ?? NaN)
    ? Math.max(6, args.recencyTauHours!)
    : 36;

  const ln2 = Math.log(2);

  // Prepare events
  let sumW = 0;
  let sumWS = 0; // weighted duration severity
  let sumDurW = 0; // weighted duration minutes (for reporting)
  let lastEventMs: number | null = null;

  // We'll count only parseable started_at as "events"
  let eventsCount = 0;

  for (const a of args.historyAlerts ?? []) {
    const sMs = safeParseMs(a.started_at);
    if (sMs == null) continue;

    eventsCount++;

    // days ago based on START time
    const daysAgo = Math.max(0, (now - sMs) / 86_400_000);

    // time-decay weight: w = 2^(-daysAgo/halfLifeDays) = exp(-ln2 * daysAgo/halfLifeDays)
    const w = expSafe(-ln2 * (daysAgo / halfLifeDays));

    // duration: use finished_at if present else "now"
    const fMs = safeParseMs(a.finished_at) ?? now;
    const durMs = fMs - sMs;
    const durMin = Number.isFinite(durMs) && durMs > 0 ? durMs / 60_000 : 0;

    // smooth duration severity: s = 1 - exp(-durMin / durationTauMin)
    const sev = 1 - expSafe(-(durMin / durationTauMin));

    sumW += w;
    sumWS += w * sev;
    sumDurW += w * durMin;

    // last event timestamp: take max of started_at (you can change to max(fMs) if you prefer)
    if (lastEventMs == null || sMs > lastEventMs) lastEventMs = sMs;
  }

  // Frequency component (smooth saturation):
  // F = 1 - exp(-(sumW / K))
  const F = clamp01(1 - expSafe(-(sumW / freqK)));

  // Duration component (weighted mean of severity):
  const D = sumW > 0 ? clamp01(sumWS / sumW) : 0;

  // Recency / cool-down:
  // R = exp(-(hoursSinceLast / tau))
  const hoursSinceLast =
    lastEventMs == null ? 1e9 : Math.max(0, (now - lastEventMs) / 3_600_000);
  const R = clamp01(expSafe(-(hoursSinceLast / recencyTauHours)));

  // Active now bonus
  const A = args.isActiveNow ? 1 : 0;

  // Final score
  // Tuned weights (sum to 1.0)
  const score01 = clamp01(0.45 * F + 0.25 * D + 0.20 * R + 0.10 * A);
  const score = Math.round(score01 * 100);

  const level = score <= 39 ? "LOW" : score <= 69 ? "MEDIUM" : "HIGH";
  const label =
    level === "LOW"
      ? "🟢 Низький ризик"
      : level === "MEDIUM"
        ? "🟡 Середній ризик"
        : "🔴 Високий ризик";

  // Helpful reporting numbers
  const weightedAvgDurationMin = sumW > 0 ? sumDurW / sumW : 0;

  return {
    oblastUid: args.oblastUid,
    oblastName: args.oblastName,
    score,
    level,
    label,

    // Keep compatibility with Flutter RiskComponents model:
    // - count7d: we keep as "eventsCount" (count in provided history window)
    // - avgDurationMin: weighted average duration minutes
    // - normCount: we expose Frequency component F
    // - normDuration: we expose Duration component D
    // - activeBonus: 1/0
    components: {
      count7d: eventsCount,
      avgDurationMin: Math.round(weightedAvgDurationMin),
      isActiveNow: args.isActiveNow,

      normCount: F,
      normDuration: D,
      activeBonus: A,

      // Extra fields (Flutter will ignore if not mapped, but useful for UI explanation later)
      recency: R,
      hoursSinceLast: Math.round(hoursSinceLast),
      halfLifeDays,
      freqK,
      durationTauMin,
      recencyTauHours,
      weightedCount: sumW,
    },
  };
}