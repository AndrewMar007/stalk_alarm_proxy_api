import { Router } from "express";
import { getActiveAlertsCached } from "../services/alerts.cache.js";

const router = Router();

router.get("/alerts/active", async (_req, res, next) => {
    console.log("[API] /alerts/active");
  try {
    const data = await getActiveAlertsCached();
    res.json(data);
  } catch (e) {
    next(e);
  }
});
export default router;