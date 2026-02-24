import "dotenv/config";
import express from "express";
import cors from "cors";

// security / perf
import helmet from "helmet";
import compression from "compression";
import rateLimit from "express-rate-limit";
import slowDown from "express-slow-down";

import alertsRoutes, { webRouter } from "./routes/alerts.routes.js";
import { requireClientKey } from "./middlewares/clientKey.middleware.js";
import { apiRateLimiter } from "./middlewares/rateLimit.middleware.js";
import { errorMiddleware } from "./middlewares/error.middleware.js";
import { startPushPoller } from "./poller/pushPoller.js";
import { startOblastWarmup } from "./services/oblastWarmup.service.js";
// ✅ твої web guards + web cors
import { webCors, webGuards } from "./middlewares/webSecurity.middleware.js";

import admin from "firebase-admin";
import fs from "node:fs";

import type { Request, Response } from "express";

const app = express();

// Якщо ти за Cloudflare/Render/NGINX — важливо для коректного IP:
app.set("trust proxy", 1);

// ✅ базовий hardening (не ламає мобільний клієнт)
app.use(
  helmet({
    crossOriginResourcePolicy: { policy: "cross-origin" },
  })
);
app.use(compression());

// ✅ JSON
app.use(express.json({ limit: "32kb" }));

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});
app.set("trust proxy", 1);
/**
 * ✅ INTERNAL endpoint (без X-Client-Key і без rate-limit)
 * Poller має ходити СЮДИ
 */
app.use("/internal", cors(), alertsRoutes);

/**
 * ✅ Публічне API для мобільного клієнта (rate limit + X-Client-Key)
 */
app.use("/api", cors(), apiRateLimiter, requireClientKey, alertsRoutes);

/**
 * ✅ WEB API (окремий вхід для Flutter Web)
 * - strict CORS allowlist
 * - webGuards (Origin allowlist, X-Web-App marker, UA sanity, query length, etc)
 * - rateLimit + slowDown
 */

// ✅ FIX: не використовуємо `message`, бо в типах твоєї версії воно може не бути
const webRateLimiter = rateLimit({
  windowMs: 60_000, // 1 хв
  limit: 120, // 120 req/min з одного IP
  standardHeaders: true,
  legacyHeaders: false,
  handler: (_req: Request, res: Response) => {
    res.status(429).json({ ok: false, error: "Too many requests" });
  },
});

const webSlowDown = slowDown({
  windowMs: 60_000,
  delayAfter: 60, // після 60 запитів/хв починаємо гальмувати
  delayMs: (hits) => Math.min((hits - 60) * 100, 2000), // до 2с
});

app.use("/web", webCors, webGuards, webRateLimiter, webSlowDown, webRouter);

app.use(errorMiddleware);

const PORT = Number(process.env.PORT || 3000);
app.listen(PORT, () => {
  console.log(`Proxy running on http://localhost:${PORT}`);

  if ((process.env.ENABLE_POLLER || "true").toLowerCase() === "true") {
    startPushPoller();
  } else {
    console.log("ℹ️ Poller disabled (ENABLE_POLLER != true)");
  }
  const OBLAST_UIDS = [
    "31", // м. Київ
    "4", "8", "9", "28", "10", "11", "12", "13", "14", "15", "16", "27",
    "17", "18", "19", "5", "20", "21", "22", "23", "3", "24", "26", "25", "29"
  ];

  startOblastWarmup({
    oblastUids: OBLAST_UIDS,
    period: "month_ago",
    uiDays: 3,
    delayMs: 35_000, // ✅ 1 запит кожні 35 секунд
  });
});

// ===============================
// ✅ INTERNAL TEST ENDPOINTS
// ===============================

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

app.get("/internal/test-topic/:level/:uid", async (req, res) => {
  const level = String(req.params.level);
  const uid = String(req.params.uid);

  if (level !== "raion" && level !== "oblast") {
    return res
      .status(400)
      .json({ ok: false, error: "level must be raion|oblast" });
  }

  try {
    const msgId = await admin.messaging().send({
      topic: `${level}_${uid}`,
      data: { type: "TEST", level, uid },
      android: { priority: "high" },
    });

    res.json({ ok: true, msgId, topic: `${level}_${uid}` });
  } catch (e: unknown) {
    res.status(500).json({ ok: false, error: errMsg(e) });
  }
});

app.get("/internal/test-start/:topic", async (req, res) => {
  try {
    const topic = String(req.params.topic);

    const msgId = await admin.messaging().send({
      topic,
      data: {
        type: "ALARM_START",
        level: topic.startsWith("oblast_") ? "oblast" : "raion",
        uid: topic.split("_")[1] ?? "",
        name: topic,
      },
      android: { priority: "high" },
    });

    res.json({ ok: true, msgId });
  } catch (e: unknown) {
    res.status(500).json({ ok: false, error: errMsg(e) });
  }
});

app.get("/internal/test-end/:topic", async (req, res) => {
  try {
    const topic = String(req.params.topic);

    const msgId = await admin.messaging().send({
      topic,
      data: {
        type: "ALARM_END",
        level: topic.startsWith("oblast_") ? "oblast" : "raion",
        uid: topic.split("_")[1] ?? "",
        name: topic,
      },
      android: { priority: "high" },
    });

    res.json({ ok: true, msgId });
  } catch (e: unknown) {
    res.status(500).json({ ok: false, error: errMsg(e) });
  }
});

app.post("/internal/test_topic", async (req, res) => {
  const topic = String(req.body?.topic ?? "").trim();
  const type = String(req.body?.type ?? "ALARM_START").trim();

  if (!topic) {
    return res.status(400).json({ ok: false, error: "topic required" });
  }
  if (type !== "ALARM_START" && type !== "ALARM_END") {
    return res
      .status(400)
      .json({ ok: false, error: "type must be ALARM_START|ALARM_END" });
  }

  try {
    const msgId = await admin.messaging().send({
      topic,
      data: {
        type,
        level: topic.startsWith("oblast_")
          ? "oblast"
          : topic.startsWith("raion_")
            ? "raion"
            : "hromada",
        uid: topic,
        name: "TEST",
      },
      android: { priority: "high" },
    });

    res.json({ ok: true, msgId, topic, type });
  } catch (e: unknown) {
    res.status(500).json({ ok: false, error: errMsg(e) });
  }
});

app.get("/internal/debug/state", (_req, res) => {
  const STATE_FILE = process.env.STATE_FILE || "./alarm_state.json";

  try {
    const raw = fs.readFileSync(STATE_FILE, "utf8");
    res.type("application/json").send(raw);
  } catch {
    res.status(404).json({ error: "state file not found", path: STATE_FILE });
  }
});

app.get("/internal/test-hromada/:uid", async (req, res) => {
  try {
    const uid = String(req.params.uid).trim();
    const topic = `hromada_${uid}`;

    const msgId = await admin.messaging().send({
      topic,
      data: {
        type: "TEST",
        level: "hromada",
        uid: topic,
        name: "TEST HROMADA",
      },
      android: { priority: "high" },
    });

    res.json({ ok: true, msgId, topic });
  } catch (e: unknown) {
    res.status(500).json({ ok: false, error: errMsg(e) });
  }
});
