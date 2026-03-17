import rateLimit, { ipKeyGenerator } from "express-rate-limit";
import type { Request, Response } from "express";

/**
 * ⏱️ MOBILE: 1 запит / 5 секунд на один X-Device-Id
 */
export const forecastLimiter = rateLimit({
  windowMs: 5_000,
  limit: 1,
  standardHeaders: true,
  legacyHeaders: false,

  keyGenerator: (req) => {
      const ip = req.ip ?? "0.0.0.0"; // fallback якщо undefined
      return `webip:${ipKeyGenerator(ip)}`;
    },

  handler: (_req: Request, res: Response) => {
    res.setHeader("Retry-After", "5");
    res.status(429).json({
      error: "Зачекайте 5 секунд перед наступним запитом.",
      code: "FORECAST_RATE_LIMIT",
      retryAfterSec: 5,
    });
  },
});

/**
 * ⏱️ WEB: 1 запит / 5 секунд на IP
 */
export const webForecastLimiter = rateLimit({
  windowMs: 5_000,
  limit: 1,
  standardHeaders: true,
  legacyHeaders: false,

  keyGenerator: (req) => {
      const ip = req.ip ?? "0.0.0.0"; // fallback якщо undefined
      return `webip:${ipKeyGenerator(ip)}`;
    },

  handler: (_req: Request, res: Response) => {
    res.setHeader("Retry-After", "5");
    res.status(429).json({
      error: "Зачекайте 5 секунд перед наступним запитом.",
      code: "WEB_FORECAST_RATE_LIMIT",
      retryAfterSec: 5,
    });
  },
});