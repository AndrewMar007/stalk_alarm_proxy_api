import cors from "cors";
import type { Request, Response, NextFunction } from "express";
import "dotenv/config";

const WEB_ORIGINS = [
  "http://localhost:5173",
  "http://localhost:8080",
  "http://localhost:3000",
  // якщо Flutter Web запускаєш не з localhost, а з IP — додай і його:
  "http://192.168.50.67:5173",
  "http://192.168.50.67:3000",
  process.env.PROD_URL || "",
].filter(Boolean);

export const webCors = cors({
  origin: (origin, cb) => {
    // Без Origin (curl/сервер-сервер) — у проді забороняємо
    if (!origin) return cb(null, process.env.NODE_ENV !== "production");
    if (WEB_ORIGINS.includes(origin)) return cb(null, true);
    return cb(new Error("Not allowed by CORS"));
  },
  methods: ["GET", "OPTIONS"],
  allowedHeaders: ["Content-Type", "X-Web-App", "Accept"],
  credentials: false,
  maxAge: 86400,
});

function isAllowedOrigin(req: Request) {
  const origin = req.headers.origin;
  if (!origin) return process.env.NODE_ENV !== "production";
  return WEB_ORIGINS.includes(origin);
}

function looksLikeBrowser(req: Request) {
  const ua = String(req.headers["user-agent"] || "");
  return ua.length >= 8;
}

function hasWebMarker(req: Request) {
  // Для звичайного GET
  const marker = String(req.headers["x-web-app"] || "");
  if (marker === "stalk-web-v1") return true;

  // Для preflight OPTIONS браузер зазвичай шле це:
  const acrh = String(req.headers["access-control-request-headers"] || "").toLowerCase();
  // якщо він збирається відправити x-web-app — пропускаємо
  if (acrh.includes("x-web-app")) return true;

  return false;
}

export function webGuards(req: Request, res: Response, next: NextFunction) {
  // 1) тільки GET/OPTIONS
  if (req.method !== "GET" && req.method !== "OPTIONS") {
    return res.status(405).json({ ok: false, error: "Method not allowed" });
  }

  // 2) origin allowlist
  if (!isAllowedOrigin(req)) {
    return res.status(403).json({ ok: false, error: "Forbidden origin" });
  }

  // ✅ 2.5) OPTIONS треба пропускати (cors відповість 204)
  if (req.method === "OPTIONS") {
    return next();
  }

  // 3) marker
  if (!hasWebMarker(req)) {
    return res.status(403).json({ ok: false, error: "Missing web marker" });
  }

  // 4) UA sanity
  if (!looksLikeBrowser(req)) {
    return res.status(403).json({ ok: false, error: "Bad user-agent" });
  }

  // 5) query limit
  const qs = req.originalUrl.split("?")[1] || "";
  if (qs.length > 512) {
    return res.status(414).json({ ok: false, error: "Query too long" });
  }

  res.setHeader("Cache-Control", "no-store");
  next();
}
