// routes/alerts.routes.ts
import { Router } from "express";
import rateLimit from "express-rate-limit";

import { getActiveAlertsCached } from "../services/alerts.cache.js";
import { computeOblastRisk } from "../services/risk.service.js";
import { getOblastCacheEntry } from "../services/oblastWarmup.service.js";

import type { Request, Response, NextFunction } from "express";
import { webHistoryLimiter } from "../middlewares/webRateLimit.middleware.js";

const router = Router();

/* ===================== helpers ===================== */

function requireDeviceId(req: Request, res: Response, next: NextFunction) {
  const deviceId = req.get("X-Device-Id");
  if (!deviceId || !deviceId.trim()) {
    return res.status(400).json({
      error: "X-Device-Id header is required",
      code: "DEVICE_ID_REQUIRED",
    });
  }
  next();
}

function asUid(param: any) {
  return String(param ?? "").trim();
}

function warmupMiss(res: Response, uid: string) {
  return res.status(503).json({
    ok: false,
    error: "Cache is warming up for this oblast. Try again soon.",
    code: "CACHE_WARMING_UP",
    oblastUid: uid,
    retryAfterSec: 10,
  });
}

/* ===================== rate limit (mobile history) ===================== */

const HISTORY_GAP_MS = 10_000;

const historyLimiter = rateLimit({
  windowMs: HISTORY_GAP_MS,
  limit: 1,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => `dev:${req.get("X-Device-Id")}`,
  handler: (_req, res) => {
    res.setHeader("Retry-After", "10");
    res.status(429).json({
      error: "Зачекайте 10 секунд перед наступним запитом.",
      code: "HISTORY_RATE_LIMIT",
      retryAfterSec: 10,
    });
  },
});

/* ===================== /api + /internal routes ===================== */

// ✅ ACTIVE (як було)
router.get("/alerts/active", async (_req, res, next) => {
  try {
    const data = await getActiveAlertsCached();
    res.json(data);
  } catch (e) {
    next(e);
  }
});

/**
 * ✅ HISTORY + RISK (1 запит)
 * - alerts: за 3 дні (UI)
 * - risk: за місяць (30 днів) з entry.monthAlerts
 */
router.get(
  "/alerts/history/:uid",
  requireDeviceId,
  historyLimiter,
  async (req, res, next) => {
    const uid = asUid(req.params.uid);
    if (!uid) {
      return res
        .status(400)
        .json({ error: "uid is required", code: "UID_REQUIRED" });
    }

    try {
      const entry = getOblastCacheEntry(uid);
      if (!entry) return warmupMiss(res, uid);

      // active state (з твого cached active, не upstream history)
      const activePayload: any = await getActiveAlertsCached();
      const activeAlerts = Array.isArray(activePayload?.alerts)
        ? activePayload.alerts
        : Array.isArray(activePayload)
        ? activePayload
        : [];

      const isActiveNow = activeAlerts.some(
        (a: any) =>
          a?.finished_at == null &&
          String(a?.location_oblast_uid ?? a?.location_uid ?? "").trim() === uid
      );

      const monthAlerts = Array.isArray(entry.monthAlerts)
        ? entry.monthAlerts
        : [];

      const risk = computeOblastRisk({
        oblastUid: uid,
        oblastName: entry.oblastName || `Oblast ${uid}`,
        historyAlerts: monthAlerts, // ✅ місяць
        isActiveNow,
      });

      // ✅ 1 відповідь: історія + ризик
      res.json({
        ok: true,
        cached: true,
        oblastUid: uid,
        oblastName: entry.oblastName || risk.oblastName,
        updatedAt: entry.updatedAt,

        // UI history
        days: 3,
        period: entry.period,
        alerts: entry.history3d,

        // risk block
        riskDays: 30,
        isActiveNow,
        risk, // <- тут OblastRiskResponse-подібний обʼєкт
      });
    } catch (e) {
      next(e);
    }
  }
);

export default router;

/* ============================================================
 * ✅ WEB ROUTER (для /web) — теж HISTORY + RISK в одному запиті
 * ============================================================ */

export const webRouter = Router();

// ✅ ACTIVE (як було)
webRouter.get("/alerts/active", async (_req, res, next) => {
  try {
    const data = await getActiveAlertsCached();
    res.json(data);
  } catch (e) {
    next(e);
  }
});

/**
 * ✅ WEB HISTORY + RISK (1 запит)
 * Ліміт на web лишається через webHistoryLimiter (у тебе там 10 секунд / IP або як налаштовано).
 */
webRouter.get(
  "/alerts/history/:uid",
  webHistoryLimiter,
  async (req, res, next) => {
    const uid = asUid(req.params.uid);
    if (!uid) {
      return res
        .status(400)
        .json({ error: "uid is required", code: "UID_REQUIRED" });
    }

    try {
      const entry = getOblastCacheEntry(uid);
      if (!entry) return warmupMiss(res, uid);

      const activePayload: any = await getActiveAlertsCached();
      const activeAlerts = Array.isArray(activePayload?.alerts)
        ? activePayload.alerts
        : Array.isArray(activePayload)
        ? activePayload
        : [];

      const isActiveNow = activeAlerts.some(
        (a: any) =>
          a?.finished_at == null &&
          String(a?.location_oblast_uid ?? a?.location_uid ?? "").trim() === uid
      );

      const monthAlerts = Array.isArray(entry.monthAlerts)
        ? entry.monthAlerts
        : [];

      const risk = computeOblastRisk({
        oblastUid: uid,
        oblastName: entry.oblastName || `Oblast ${uid}`,
        historyAlerts: monthAlerts,
        isActiveNow,
      });

      res.json({
        ok: true,
        cached: true,
        oblastUid: uid,
        oblastName: entry.oblastName || risk.oblastName,
        updatedAt: entry.updatedAt,

        days: 3,
        period: entry.period,
        alerts: entry.history3d,

        riskDays: 30,
        isActiveNow,
        risk,
      });
    } catch (e) {
      next(e);
    }
  }
);