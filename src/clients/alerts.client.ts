const API_URL = "https://api.alerts.in.ua/v1/alerts/active.json";

export async function fetchAlertsFromUpstream() {
      console.log("[UPSTREAM] fetching alerts.in.ua"); // 👈 додай
  const token = process.env.ALERTS_TOKEN;
  if (!token) throw new Error("Missing ALERTS_TOKEN in .env");

  const res = await fetch(API_URL, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
    },
    signal: AbortSignal.timeout(5000),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Upstream error ${res.status}: ${text}`);
  }

  return res.json();
}
