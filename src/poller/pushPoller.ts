import admin from "firebase-admin";
import { fetch } from "undici";
import fs from "node:fs";
import path from "node:path";

type UidNameMap = Map<string, string>; // uid -> name
type State = { raions: Record<string, string>; oblasts: Record<string, string> };

export function startPushPoller() {
  const SERVICE_ACCOUNT_PATH =
    process.env.FCM_SERVICE_ACCOUNT || "./serviceAccountKey.json";

  // має повертати JSON з { alerts: [...] } або просто [...] — обидва варіанти ок
  const PROXY_URL =
    process.env.ALERTS_PROXY_URL || "http://localhost:3000/internal/alerts/active";

  const POLL_MS = Number(process.env.POLL_MS || 15000);
  const STATE_FILE = process.env.STATE_FILE || "./alarm_state.json";

  /* ================= STATE ================= */

  function loadState(): { raions: UidNameMap; oblasts: UidNameMap } {
    try {
      const raw = JSON.parse(fs.readFileSync(STATE_FILE, "utf8")) as State;

      return {
        raions: new Map(Object.entries(raw?.raions ?? {})),
        oblasts: new Map(Object.entries(raw?.oblasts ?? {})),
      };
    } catch {
      return { raions: new Map(), oblasts: new Map() };
    }
  }

  function saveState(raions: UidNameMap, oblasts: UidNameMap) {
    const obj: State = {
      raions: Object.fromEntries(raions),
      oblasts: Object.fromEntries(oblasts),
    };
    fs.writeFileSync(STATE_FILE, JSON.stringify(obj, null, 2), "utf8");
  }

  /* ================= EXTRACT ================= */

  function extractActiveMaps(payload: any): { raions: UidNameMap; oblasts: UidNameMap } {
    const alerts = payload?.alerts ?? payload;

    const raions = new Map<string, string>();
    const oblasts = new Map<string, string>();

    if (!Array.isArray(alerts)) return { raions, oblasts };

    for (const a of alerts) {
      const type = a?.location_type;
      const title = a?.location_title;
      if (!title) continue;

      // ✅ РАЙОН: topic raion_{uid}
      if (type === "raion") {
        const uid = a?.location_uid; // 150,152,...
        if (uid != null) raions.set(String(uid), String(title));
        continue;
      }

      // ✅ ОБЛАСТЬ: topic oblast_{uid}
      if (type === "oblast") {
        const uid = a?.location_oblast_uid ?? a?.location_uid; // 24,16,...
        if (uid != null) oblasts.set(String(uid), String(title));
        continue;
      }
    }

    return { raions, oblasts };
  }

  /* ================= PUSH ================= */

  async function sendToTopic(
    level: "raion" | "oblast",
    uid: string,
    name: string,
    type: "ALARM_START" | "ALARM_END"
  ) {
    const isStart = type === "ALARM_START";
    const title = "Stalk Alarm";

    const body = isStart
      ? `Увага! Починається викид в «${name}»! Пройдіть в найближче укриття!`
      : `Викид завершився в «${name}». Слідкуйте за оновленнями!`;

    await admin.messaging().send({
      topic: `${level}_${uid}`,

      // ✅ видно в шторці навіть коли app killed
      notification: { title, body },

      // ✅ для внутрішньої логіки в апці
      data: {
        type,
        level,
        uid,
        name,
      },

      android: {
        priority: "high",
        notification: {
          channelId: "alarm_channel",
          sound: "alarm",
        },
      },
    });
  }

  /* ================= POLL ================= */

  async function pollOnce(prevRaions: UidNameMap, prevOblasts: UidNameMap) {
    const res = await fetch(PROXY_URL, { headers: { Accept: "application/json" } });
    if (!res.ok) throw new Error(`Upstream error: ${res.status} ${res.statusText}`);

    const payload = await res.json();
    const { raions: currentRaions, oblasts: currentOblasts } = extractActiveMaps(payload);

    // ---- DIFF RAIONS
    const startedRaions: [string, string][] = [];
    const endedRaions: [string, string][] = [];

    for (const [uid, name] of currentRaions) if (!prevRaions.has(uid)) startedRaions.push([uid, name]);
    for (const [uid, name] of prevRaions) if (!currentRaions.has(uid)) endedRaions.push([uid, name]);

    // ---- DIFF OBLASTS
    const startedOblasts: [string, string][] = [];
    const endedOblasts: [string, string][] = [];

    for (const [uid, name] of currentOblasts) if (!prevOblasts.has(uid)) startedOblasts.push([uid, name]);
    for (const [uid, name] of prevOblasts) if (!currentOblasts.has(uid)) endedOblasts.push([uid, name]);

    // SEND (спочатку START, потім END)
    for (const [uid, name] of startedRaions) {
      await sendToTopic("raion", uid, name, "ALARM_START");
      console.log(`🚨 START raion ${name} (${uid})`);
    }
    for (const [uid, name] of startedOblasts) {
      await sendToTopic("oblast", uid, name, "ALARM_START");
      console.log(`🚨 START oblast ${name} (${uid})`);
    }

    for (const [uid, name] of endedRaions) {
      await sendToTopic("raion", uid, name, "ALARM_END");
      console.log(`✅ END raion ${name} (${uid})`);
    }
    for (const [uid, name] of endedOblasts) {
      await sendToTopic("oblast", uid, name, "ALARM_END");
      console.log(`✅ END oblast ${name} (${uid})`);
    }

    return { currentRaions, currentOblasts };
  }

  /* ================= INIT ================= */

  if (admin.apps.length === 0) {
    const sa = JSON.parse(
      fs.readFileSync(path.resolve(SERVICE_ACCOUNT_PATH), "utf8")
    );
    admin.initializeApp({
      credential: admin.credential.cert(sa),
    });
  }

  console.log("🚀 Push poller started");
  console.log(`POLL_MS=${POLL_MS}`);
  console.log(`PROXY_URL=${PROXY_URL}`);
  console.log(`STATE_FILE=${STATE_FILE}`);

  let { raions: prevRaions, oblasts: prevOblasts } = loadState();

  const tick = async () => {
    try {
      const { currentRaions, currentOblasts } = await pollOnce(prevRaions, prevOblasts);
      prevRaions = currentRaions;
      prevOblasts = currentOblasts;
      saveState(prevRaions, prevOblasts);
    } catch (e) {
      console.error("Poll failed:", e);
    }
  };

  // перший запуск одразу
  void tick();
  setInterval(() => void tick(), POLL_MS);
}
