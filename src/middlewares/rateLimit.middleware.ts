import rateLimit from "express-rate-limit";

// Загальний ліміт на API: наприклад 120 запитів/хв з одного IP
// (це ліміт на ТВОЇЙ proxy, а не на alerts.in.ua — upstream все одно захищає кеш 15s)
export const apiRateLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 хв
  limit: Number(process.env.RATE_LIMIT_PER_MINUTE || 120),
  standardHeaders: true, // додає RateLimit-* headers
  legacyHeaders: false,
  message: { error: "Too many requests, please slow down." }
});
