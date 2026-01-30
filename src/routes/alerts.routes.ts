import { Router } from "express";
import rateLimit from "express-rate-limit";
import { getActiveAlertsCached } from "../services/alerts.cache.js";
import { getRegionAlertsHistoryCached } from "../services/alertsHistory.cache.js";
import type { Request, Response, NextFunction } from "express";

const router = Router();

/**
 * 🔒 Middleware: жорстко вимагаємо X-Device-Id
 */
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

/**
 * ⏱️ ЛІМІТ: 2 рази / хв НА ДЕВАЙС
 */
const HISTORY_GAP_MS = 45_000;

const historyLimiter = rateLimit({
  windowMs: HISTORY_GAP_MS,
  limit: 1,
  standardHeaders: true,
  legacyHeaders: false,

  keyGenerator: (req) => `dev:${req.get("X-Device-Id")}`,

  handler: (_req, res) => {
    res.setHeader("Retry-After", "45");
    res.status(429).json({
      error:
        "Перевищено ліміт запитів до історії. Спробуйте знову через 45 секунд.",
      code: "HISTORY_RATE_LIMIT",
      retryAfterSec: 45,
    });
  },
});


router.get("/alerts/active", async (_req, res, next) => {
  try {
    const data = await getActiveAlertsCached();
    res.json(data);
  } catch (e) {
    next(e);
  }
});

/**
 * 📜 History — з жорстким device id + rate limit
 */
router.get(
  "/alerts/history/:uid",
  requireDeviceId,   // 👈 СПОЧАТКУ перевірка
  historyLimiter,    // 👈 ПОТІМ ліміт
  async (req, res, next) => {
    const uid = String(req.params.uid || "").trim();
    const period = String(req.query.period || "week_ago").trim();
    const days = req.query.days ? Number(req.query.days) : undefined;

    try {
      const data = await getRegionAlertsHistoryCached(uid, period, days);
      res.json(data);
    } catch (e) {
      next(e);
    }
  }
);

export default router;
