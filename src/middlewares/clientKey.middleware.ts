import type { Request, Response, NextFunction } from "express";

export function requireClientKey(req: Request, res: Response, next: NextFunction) {
  const requiredKey = process.env.CLIENT_KEY;

  // якщо ключ не заданий — не перевіряємо
  if (!requiredKey) return next();

  const key = req.header("X-Client-Key");
  if (key !== requiredKey) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  next();
}
