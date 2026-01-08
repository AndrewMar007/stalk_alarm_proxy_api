import type { Request, Response, NextFunction } from "express";

export function errorMiddleware(err: unknown, _req: Request, res: Response, _next: NextFunction) {
  const message = err instanceof Error ? err.message : "Server error";
  res.status(500).json({ error: message });
}
