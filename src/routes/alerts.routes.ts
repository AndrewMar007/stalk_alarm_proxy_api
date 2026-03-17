// routes/alerts.routes.ts
import { Router } from "express";
import rateLimit from "express-rate-limit";

import { getActiveAlertsCached } from "../services/alerts.cache.js";
import { computeOblastRisk } from "../services/risk.service.js";
import { getOblastCacheEntry } from "../services/oblastWarmup.service.js";

import type { Request, Response, NextFunction } from "express";
import { webHistoryLimiter } from "../middlewares/webRateLimit.middleware.js";
import { computeOblastForecast } from "../services/forecast.service.js";

import {
  forecastLimiter,
  webForecastLimiter,
} from "../middlewares/forecastRateLimit.middleware.js";

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
    retryAfterSec: 5,
  });
}

/* ===================== rate limit (mobile history) ===================== */

const HISTORY_GAP_MS = 5_000;

const historyLimiter = rateLimit({
  windowMs: HISTORY_GAP_MS,
  limit: 1,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => `dev:${req.get("X-Device-Id")}`,
  handler: (_req, res) => {
    res.setHeader("Retry-After", "10");
    res.status(429).json({
      error: "Зачекайте 5 секунд перед наступним запитом.",
      code: "HISTORY_RATE_LIMIT",
      retryAfterSec: 5,
    });
  },
});

/* ===================== /api + /internal routes ===================== */

// ACTIVE
router.get("/alerts/active", async (_req, res, next) => {
  try {
    const data = await getActiveAlertsCached();
    res.json(data);
  } catch (e) {
    next(e);
  }
});

/**
 * HISTORY + RISK
 * - alerts: за 3 дні (UI)
 * - risk: за місяць (30 днів) з entry.monthAlerts
 * - updatedAt / historyUpdatedAt: час останнього оновлення кешу області
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

      const activePayload: any = await getActiveAlertsCached();
      const activeAlerts = Array.isArray(activePayload?.alerts)
        ? activePayload.alerts
        : Array.isArray(activePayload)
        ? activePayload
        : [];

      const isActiveNow = activeAlerts.some(
        (a: any) =>
          a?.finished_at == null &&
          String(
            a?.location_oblast_uid ?? a?.location_uid ?? "",
          ).trim() === uid,
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

        // час останнього оновлення кешу області
        updatedAt: entry.updatedAt,

        // окремо для історії, якщо поле вже є в cache entry
        historyUpdatedAt:
          (entry as any).historyUpdatedAt ?? entry.updatedAt,

        // UI history
        days: 3,
        period: entry.period,
        alerts: entry.history3d,

        // risk block
        riskDays: 30,
        isActiveNow,
        risk,
      });
    } catch (e) {
      next(e);
    }
  },
);

export default router;

/* ============================================================
 * WEB ROUTER
 * ============================================================ */

export const webRouter = Router();

// ACTIVE
webRouter.get("/alerts/active", async (_req, res, next) => {
  try {
    const data = await getActiveAlertsCached();
    res.json(data);
  } catch (e) {
    next(e);
  }
});

/**
 * WEB HISTORY + RISK
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
          String(
            a?.location_oblast_uid ?? a?.location_uid ?? "",
          ).trim() === uid,
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

        // час останнього оновлення кешу області
        updatedAt: entry.updatedAt,

        // окремо для історії, якщо поле вже є в cache entry
        historyUpdatedAt:
          (entry as any).historyUpdatedAt ?? entry.updatedAt,

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
  },
);

// /api/alerts/forecast/:uid
router.get(
  "/alerts/forecast/:uid",
  requireDeviceId,
  forecastLimiter,
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

      const forecast = computeOblastForecast({
        oblastUid: uid,
        oblastName: entry.oblastName || `Oblast ${uid}`,
        updatedAt: entry.updatedAt,
        monthAlerts: Array.isArray(entry.monthAlerts) ? entry.monthAlerts : [],
        tz: "Europe/Kyiv",
        daysBack: 30,
      });

      res.json(forecast);
    } catch (e) {
      next(e);
    }
  },
);

// /web/alerts/forecast/:uid
webRouter.get(
  "/alerts/forecast/:uid",
  webForecastLimiter,
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

      const forecast = computeOblastForecast({
        oblastUid: uid,
        oblastName: entry.oblastName || `Oblast ${uid}`,
        updatedAt: entry.updatedAt,
        monthAlerts: Array.isArray(entry.monthAlerts) ? entry.monthAlerts : [],
        tz: "Europe/Kyiv",
        daysBack: 30,
      });

      res.json(forecast);
    } catch (e) {
      next(e);
    }
  },
);