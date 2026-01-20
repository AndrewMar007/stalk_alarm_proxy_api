import { Router } from "express";
import { getActiveAlertsCached } from "../services/alerts.cache.js";
import { getRegionAlertsHistoryCached } from "../services/alertsHistory.cache.js";

const router = Router();

router.get("/alerts/active", async (_req, res, next) => {
    // console.log("[API] /alerts/active");
  try {
    const data = await getActiveAlertsCached();
    res.json(data);
  } catch (e) {
    next(e);
  }
});

router.get("/alerts/history/:uid", async (req, res, next) => {
  const uid = String(req.params.uid || "").trim();
  const period = String(req.query.period || "week_ago").trim();
  const days = req.query.days ? Number(req.query.days) : undefined;

  console.log(`[API] /alerts/history/${uid}?period=${period}&days=${days ?? "default"}`);

  try {
    const data = await getRegionAlertsHistoryCached(uid, period, days);
    res.json(data);
  } catch (e) {
    next(e);
  }
});
export default router;