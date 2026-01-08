import { fetchAlertsFromUpstream } from "../clients/alerts.client.js";

let cached: unknown = null;
let lastFetch = 0;

// single-flight: щоб при одночасних запитах не було N upstream-викликів
let inFlight: Promise<unknown> | null = null;

const TTL = Number(process.env.CACHE_TTL_MS || 15000); // 15s => ~4/min (safe)

export async function getActiveAlertsCached() {
  const now = Date.now();

  // якщо кеш актуальний — віддаємо кеш
  if (cached !== null && now - lastFetch < TTL) {
    return cached;
  }

  // якщо вже йде оновлення — чекаємо його
  if (inFlight) {
    return inFlight;
  }

  // запускаємо новий upstream fetch
  inFlight = (async () => {
    try {
      const data = await fetchAlertsFromUpstream();
      cached = data;
      lastFetch = Date.now();
      return data;
    } finally {
      inFlight = null;
    }
  })();

  return inFlight;
}
