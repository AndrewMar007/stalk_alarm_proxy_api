import type { Request, Response, NextFunction } from "express";

export function errorMiddleware(err: unknown, _req: Request, res: Response, _next: NextFunction) {
  const message =
    err instanceof Error ? err.message :
    typeof err === "string" ? err :
    "Server error";

  // ✅ ЛОГИ (дуже важливо)
  console.error("❌ ERROR:", message);
  if (err instanceof Error && err.stack) console.error(err.stack);

  res.status(500).json({ error: message });
}
