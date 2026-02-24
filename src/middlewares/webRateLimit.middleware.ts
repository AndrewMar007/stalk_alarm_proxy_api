import rateLimit, { ipKeyGenerator } from "express-rate-limit";
import slowDown from "express-slow-down";
import type { Request, Response } from "express";
// Загальний ліміт для web (active)
export const webRateLimiter = rateLimit({
  windowMs: 60_000, // 1 хв
  limit: 120,       // 120 req/min з одного IP
  standardHeaders: true,
  legacyHeaders: false,

  handler: (_req: Request, res: Response) => {
    res.status(429).json({ ok: false, error: "Too many requests" });
  },
});


// Плавне “гальмо” (коли починають лупити)
export const webSpeedLimiter = slowDown({
  windowMs: 60 * 1000,
  delayAfter: 15, // після 15 запитів/хв починаємо затримувати
  delayMs: () => 250, // +250мс за запит
});

// Для історії — сильніше
// export const webHistoryLimiter = rateLimit({
//   windowMs: 60 * 1000,
//   max: 10, // історія дорожча
//   standardHeaders: true,
//   legacyHeaders: false,
// });

// alerts.routes.ts
// ...
/**
 * ⏱️ WEB: 1 раз / 10 секунд на IP
 */
export const webHistoryLimiter = rateLimit({
  windowMs: 10_000,
  limit: 1,
  standardHeaders: true,
  legacyHeaders: false,

  keyGenerator: (req) => {
    const ip = req.ip ?? "0.0.0.0"; // fallback якщо undefined
    return `webip:${ipKeyGenerator(ip)}`;
  },

  handler: (_req, res) => {
    res.setHeader("Retry-After", "10");
    res.status(429).json({
      error: "Зачекайте 10 секунд перед наступним запитом.",
      code: "WEB_HISTORY_RATE_LIMIT",
      retryAfterSec: 10,
    });
  },
});

