import admin from "firebase-admin";
import { fetch } from "undici";
import fs from "node:fs";
import path from "node:path";

type UidNameMap = Map<string, string>;
type State = { raions: Record<string, string>; oblasts: Record<string, string> };

// ✅ твій формат мапи: { name, topic }
type OblastMapRow = { name: string; topic: string };

export function startPushPoller() {
  const SERVICE_ACCOUNT_PATH =
    process.env.FCM_SERVICE_ACCOUNT || "./serviceAccountKey.json";

  const PORT = Number(process.env.PORT || 3000);
  const PROXY_URL =
    process.env.ALERTS_PROXY_URL ||
    `http://127.0.0.1:${PORT}/internal/alerts/active`;

  const POLL_MS = Number(process.env.POLL_MS || 15000);
  const STATE_FILE = process.env.STATE_FILE || "./alarm_state.json";

  // ✅ антифліккер END області: 2 тики = ~30с (якщо poll 15с)
  const OBLAST_END_CONFIRM_TICKS = Number(
    process.env.OBLAST_END_CONFIRM_TICKS || 2
  );

  // ✅ файл мапи "назва області" -> "topic"
  const OBLAST_MAP_FILE = process.env.OBLAST_MAP_FILE || "./oblast_uid_map.json";

  /* ================= LOAD OBLAST MAP ================= */

  function loadOblastNameToTopic(): Map<string, string> {
    try {
      const raw = JSON.parse(
        fs.readFileSync(OBLAST_MAP_FILE, "utf8")
      ) as OblastMapRow[];

      const m = new Map<string, string>();
      for (const r of raw) {
        if (!r?.name || !r?.topic) continue;
        m.set(String(r.name).trim(), String(r.topic).trim());
      }

      console.log(`✅ Loaded oblast map: ${m.size} items from ${OBLAST_MAP_FILE}`);
      return m;
    } catch (e) {
      console.warn(`⚠️ Could not load ${OBLAST_MAP_FILE}`, e);
      return new Map();
    }
  }

  const oblastNameToTopic = loadOblastNameToTopic();

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

  /* ================= EXTRACT =================
     ПРАВИЛО:
     - область активна, якщо є хоча б 1 активний алерт у ній (будь-якого типу)
     - район активний тільки якщо location_type === "raion"
  */

  function extractActiveMaps(payload: any): {
    raions: UidNameMap;          // key: "74"  value: "Вишгородський район"
    oblastsInstant: UidNameMap;  // key: "74"  value: "Київська область"
  } {
    const alerts = payload?.alerts ?? payload;

    const raions = new Map<string, string>();
    const oblastsInstant = new Map<string, string>();

    if (!Array.isArray(alerts)) return { raions, oblastsInstant };

    for (const a of alerts) {
      if (a?.finished_at != null) continue; // тільки активні

      // ✅ область “піднімаємо” по НАЗВІ + uid (uid потрібен лише для state, не для topic)
      const oblastUid = a?.location_oblast_uid;
      const oblastName = a?.location_oblast;

      if (oblastUid != null && oblastName) {
        oblastsInstant.set(String(oblastUid), String(oblastName));
      }

      // ✅ район — тільки якщо raion
      if (a?.location_type === "raion") {
        const raionUid = a?.location_uid;
        const raionName = a?.location_title;
        if (raionUid != null && raionName) {
          raions.set(String(raionUid), String(raionName));
        }
      }
    }

    return { raions, oblastsInstant };
  }

  /* ================= PUSH ================= */

  async function sendToTopic(
    level: "raion" | "oblast",
    uidFromApi: string,  // "74", "140" ...
    name: string,        // "Київська область" / "Чернігівський район"
    type: "ALARM_START" | "ALARM_END"
  ) {
    const isStart = type === "ALARM_START";

    const title = "Stalk Alarm";
    const body = isStart
      ? `Увага! Повітряна тривога в «${name}»! Залишайтесь в укритті!`
      : `Відбій у «${name}». Будьте обережні!`;

    // ✅ topic:
    // - raion => raion_<uid>
    // - oblast => беремо з мапи по назві (твій файл), напр "oblast_14"
    let topic: string;

    if (level === "raion") {
      topic = `raion_${uidFromApi}`;
    } else {
      const mapped = oblastNameToTopic.get(String(name).trim());
      topic = mapped ?? `oblast_${uidFromApi}`; // fallback (в логах буде видно якщо мапа не спрацювала)
    }

    await admin.messaging().send({
      topic,
      data: {
        type,
        level,
        uid: topic,   // ✅ у data кладемо topic, щоб Flutter одразу бачив "oblast_14" / "raion_74"
        name,
        title,
        body,
      },
      android: { priority: "high" },
    });

    console.log(`[FCM SEND] type=${type} level=${level} topic=${topic} name="${name}" (apiUid=${uidFromApi})`);
  }

  /* ================= POLL ================= */

  // ✅ streak відсутності області (антифліккер END)
  const oblastMissStreak = new Map<string, number>();

  async function pollOnce(prevRaions: UidNameMap, prevOblastsStable: UidNameMap) {
    const res = await fetch(PROXY_URL, { headers: { Accept: "application/json" } });
    if (!res.ok) throw new Error(`Upstream error: ${res.status} ${res.statusText}`);

    const payload = await res.json();
    const { raions: currentRaions, oblastsInstant } = extractActiveMaps(payload);

    /* ===== RAIONS (без debounce) ===== */

    for (const [uid, name] of currentRaions) {
      if (!prevRaions.has(uid)) {
        await sendToTopic("raion", uid, name, "ALARM_START");
      }
    }
    for (const [uid, name] of prevRaions) {
      if (!currentRaions.has(uid)) {
        await sendToTopic("raion", uid, name, "ALARM_END");
      }
    }

    /* ===== OBLASTS (stable + debounce END) ===== */

    // START (або тримаємо активною)
    for (const [uid, name] of oblastsInstant) {
      oblastMissStreak.delete(uid);

      if (!prevOblastsStable.has(uid)) {
        prevOblastsStable.set(uid, name);
        await sendToTopic("oblast", uid, name, "ALARM_START");
      } else {
        // на всяк випадок оновимо назву
        prevOblastsStable.set(uid, name);
      }
    }

    // END тільки після N тика(ів) відсутності
    for (const [uid, name] of Array.from(prevOblastsStable.entries())) {
      if (oblastsInstant.has(uid)) continue;

      const streak = (oblastMissStreak.get(uid) ?? 0) + 1;
      oblastMissStreak.set(uid, streak);

      if (streak >= OBLAST_END_CONFIRM_TICKS) {
        await sendToTopic("oblast", uid, name, "ALARM_END");
        prevOblastsStable.delete(uid);
        oblastMissStreak.delete(uid);
      }
    }

    return { currentRaions };
  }

  /* ================= INIT ================= */

  if (admin.apps.length === 0) {
    const sa = JSON.parse(
      fs.readFileSync(path.resolve(SERVICE_ACCOUNT_PATH), "utf8")
    );
    admin.initializeApp({ credential: admin.credential.cert(sa) });
  }

  console.log("🚀 Push poller started");
  console.log(`POLL_MS=${POLL_MS}`);
  console.log(`PROXY_URL=${PROXY_URL}`);
  console.log(`STATE_FILE=${STATE_FILE}`);
  console.log(`OBLAST_END_CONFIRM_TICKS=${OBLAST_END_CONFIRM_TICKS}`);
  console.log(`OBLAST_MAP_FILE=${OBLAST_MAP_FILE}`);
  console.log(`OBLAST_MAP_LOADED=${oblastNameToTopic.size}`);

  let { raions: prevRaions, oblasts: prevOblastsStable } = loadState();

  const tick = async () => {
    try {
      const { currentRaions } = await pollOnce(prevRaions, prevOblastsStable);
      prevRaions = currentRaions;
      saveState(prevRaions, prevOblastsStable);
    } catch (e) {
      console.error("Poll failed:", e);
    }
  };

  void tick();
  setInterval(() => void tick(), POLL_MS);
}
