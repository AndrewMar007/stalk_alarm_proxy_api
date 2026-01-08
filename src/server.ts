import "dotenv/config";
import express from "express";
import cors from "cors";

import alertsRoutes from "./routes/alerts.routes.js";
import { requireClientKey } from "./middlewares/clientKey.middleware.js";
import { apiRateLimiter } from "./middlewares/rateLimit.middleware.js";
import { errorMiddleware } from "./middlewares/error.middleware.js";
import { startPushPoller } from "./poller/pushPoller.js";

const app = express();

// Якщо ти за Cloudflare/Render/NGINX — важливо для коректного IP:
app.set("trust proxy", 1);

app.use(cors());
app.use(express.json());

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

/**
 * ✅ INTERNAL endpoint (без X-Client-Key і без rate-limit)
 * Poller має ходити СЮДИ, щоб не ловити 401/ліміти від твого ж middleware.
 *
 * Реалізація береться з тих самих routes, просто окремим шляхом:
 *  - або ти додаєш окремий internal route файл
 *  - або (найпростіше) робиш internal routes у alerts.routes.ts
 */
app.use("/internal", alertsRoutes); // ✅ без requireClientKey

// ✅ Публічне API для клієнта (rate limit + X-Client-Key)
app.use("/api", apiRateLimiter, requireClientKey, alertsRoutes);

app.use(errorMiddleware);

const PORT = Number(process.env.PORT || 3000);
app.listen(PORT, () => {
  console.log(`Proxy running on http://localhost:${PORT}`);

  // ✅ Щоб можна було керувати запуском poller через env
  if ((process.env.ENABLE_POLLER || "true").toLowerCase() === "true") {
    startPushPoller();
  } else {
    console.log("ℹ️ Poller disabled (ENABLE_POLLER != true)");
  }
  
});

import admin from "firebase-admin"; // ← якщо ще не імпортований

app.get("/internal/test-topic/:uid", async (req, res) => {
  const uid = req.params.uid;

  try {
    const msgId = await admin.messaging().send({
      topic: `raion_${uid}`,
      notification: {
        title: "TEST",
        body: `topic raion_${uid}`,
      },
      data: {
        type: "TEST",
        raion_uid: uid,
      },
      android: {
        priority: "high",
      },
    });

    res.json({ ok: true, msgId });
  } catch (e: any) {
    console.error("❌ test-topic error:", e);
    res.status(500).json({
      ok: false,
      error: String(e?.message ?? e),
    });
  }
});


app.get("/internal/test-oblast/:uid", async (req, res) => {
  const uid = req.params.uid; // сюди передаєш "31"
  try {
    const msgId = await admin.messaging().send({
      topic: `oblast_${uid}`,
      notification: { title: "TEST", body: `topic oblast_${uid}` },
      data: { type: "TEST", level: "oblast", uid },
      android: { priority: "high" },
    });
    res.json({ ok: true, msgId, topic: `oblast_${uid}` });
  } catch (e: any) {
    res.status(500).json({ ok: false, error: String(e?.message ?? e) });
  }
});



