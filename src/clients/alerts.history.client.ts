// clients/alerts.history.client.ts
import "dotenv/config";

const BASE_URL = (process.env.ALERTS_BASE_URL || "https://api.alerts.in.ua").replace(/\/+$/, "");
const TOKEN = process.env.ALERTS_TOKEN;

if (!TOKEN) console.warn("⚠️ ALERTS_TOKEN is not set");
console.log("ℹ️ HISTORY BASE_URL =", BASE_URL);

export async function fetchRegionAlertsHistoryFromUpstream(uid: string, period: string) {
  if (!uid) throw new Error("uid is required");
  if (!TOKEN) throw new Error("ALERTS_TOKEN is not set");

  const url = `${BASE_URL}/v1/regions/${encodeURIComponent(uid)}/alerts/${encodeURIComponent(period)}.json`;
  console.log("[UPSTREAM] history url:", url);

  const resp = await fetch(url, {
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      Accept: "application/json",
    },
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`Upstream error ${resp.status}: ${text || resp.statusText}`);
  }

  return resp.json();
}
