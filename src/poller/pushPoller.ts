import admin from "firebase-admin";
import { fetch } from "undici";
import fs from "node:fs";
import path from "node:path";

type UidNameMap = Map<string, string>;
type State = { raions: Record<string, string>; oblasts: Record<string, string> };

export function startPushPoller() {
  const SERVICE_ACCOUNT_PATH =
    process.env.FCM_SERVICE_ACCOUNT || "./serviceAccountKey.json";

  const PORT = Number(process.env.PORT || 3000);
  const PROXY_URL =
    process.env.ALERTS_PROXY_URL ||
    `http://127.0.0.1:${PORT}/internal/alerts/active`;

  const POLL_MS = Number(process.env.POLL_MS || 15000);
  const STATE_FILE = process.env.STATE_FILE || "./alarm_state.json";

  // ✅ антифліккер END області: 2 тики = ~30s (при POLL_MS=15s)
  const OBLAST_END_CONFIRM_TICKS = Number(
    process.env.OBLAST_END_CONFIRM_TICKS || 2
  );

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

  function extractActiveMaps(payload: any): {
    raions: UidNameMap;
    oblasts: UidNameMap; // ✅ "instant" області за поточний тик
  } {
    const alerts = payload?.alerts ?? payload;

    const raions = new Map<string, string>();
    const oblasts = new Map<string, string>();

    if (!Array.isArray(alerts)) return { raions, oblasts };

    for (const a of alerts) {
      // ✅ тільки активні
      if (a?.finished_at != null) continue;

      // ✅ ОБЛАСТЬ активна, якщо є ХОЧА Б 1 активний алерт у ній
      // (raion/hromada/city/oblast — не важливо)
      const oblastUid = a?.location_oblast_uid;
      const oblastName = a?.location_oblast;

      if (oblastUid != null && oblastName) {
        oblasts.set(String(oblastUid), String(oblastName));
      }

      // ✅ РАЙОН активний ТІЛЬКИ якщо type === "raion"
      if (a?.location_type === "raion") {
        const raionUid = a?.location_uid;
        const raionName = a?.location_title;

        if (raionUid != null && raionName) {
          raions.set(String(raionUid), String(raionName));
        }
      }
    }

    return { raions, oblasts };
  }

  /* ================= PUSH ================= */

  async function sendToTopic(
    level: "raion" | "oblast",
    uid: string, // ✅ тут уже "raion_74" або "oblast_14" або "74/14" — див. нижче
    name: string,
    type: "ALARM_START" | "ALARM_END"
  ) {
    const isStart = type === "ALARM_START";

    const title = "Stalk Alarm";
    const body = isStart
      ? `Увага! Повітряна тривога в «${name}»! Залишайтесь в укритті!`
      : `Відбій у «${name}». Будьте обережні!`;

    // ✅ ВАЖЛИВО:
    // У Flutter ти підписуєшся на topic типу "oblast_14" / "raion_74"
    // Тому тут topic має бути саме ТАКИЙ.
    const topic = uid.includes("_") ? uid : `${level}_${uid}`;

    await admin.messaging().send({
      topic,
      data: {
        type,
        level,
        uid: topic, // кладемо те саме, щоб у Flutter було зрозуміло
        name,
        title,
        body,
      },
      android: { priority: "high" },
    });

    console.log(`[FCM SEND] type=${type} level=${level} topic=${topic} name="${name}"`);
  }

  /* ================= POLL ================= */

  // ✅ streak відсутності області (антифліккер END)
  const oblastMissStreak = new Map<string, number>();

  async function pollOnce(prevRaions: UidNameMap, prevOblastsStable: UidNameMap) {
    const res = await fetch(PROXY_URL, { headers: { Accept: "application/json" } });
    if (!res.ok) throw new Error(`Upstream error: ${res.status} ${res.statusText}`);

    const payload = await res.json();

    // ✅ правильна деструктуризація:
    // extractActiveMaps повертає "oblasts", а ми перейменовуємо в oblastsInstant
    const { raions: currentRaions, oblasts: oblastsInstant } = extractActiveMaps(payload);

    /* ===== RAIONS (без debounce) ===== */

    for (const [uid, name] of currentRaions) {
      if (!prevRaions.has(uid)) {
        await sendToTopic("raion", uid, name, "ALARM_START");
        console.log(`🚨 START raion ${name} (${uid})`);
      }
    }

    for (const [uid, name] of prevRaions) {
      if (!currentRaions.has(uid)) {
        await sendToTopic("raion", uid, name, "ALARM_END");
        console.log(`✅ END raion ${name} (${uid})`);
      }
    }

    /* ===== OBLASTS (🔥 stable + debounce END) ===== */

    // START (або лишаємо активною)
    for (const [uid, name] of oblastsInstant) {
      // якщо область є в інстант — streak скидаємо
      oblastMissStreak.delete(uid);

      if (!prevOblastsStable.has(uid)) {
        prevOblastsStable.set(uid, name);
        await sendToTopic("oblast", uid, name, "ALARM_START");
        console.log(`🚨 START oblast ${name} (${uid})`);
      } else {
        // на всяк — оновлюємо назву
        prevOblastsStable.set(uid, name);
      }
    }

    // END лише після N тика(ів) відсутності
    for (const [uid, name] of Array.from(prevOblastsStable.entries())) {
      if (oblastsInstant.has(uid)) continue;

      const streak = (oblastMissStreak.get(uid) ?? 0) + 1;
      oblastMissStreak.set(uid, streak);

      if (streak >= OBLAST_END_CONFIRM_TICKS) {
        await sendToTopic("oblast", uid, name, "ALARM_END");
        console.log(`✅ END oblast ${name} (${uid}) after ${streak} misses`);

        prevOblastsStable.delete(uid);
        oblastMissStreak.delete(uid);
      } else {
        console.log(
          `… debounce END oblast ${name} (${uid}) misses=${streak}/${OBLAST_END_CONFIRM_TICKS}`
        );
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

  let { raions: prevRaions, oblasts: prevOblastsStable } = loadState();

  const tick = async () => {
    try {
      const { currentRaions } = await pollOnce(prevRaions, prevOblastsStable);

      // ✅ raions оновлюємо
      prevRaions = currentRaions;

      // ✅ oblasts НЕ перезаписуємо інстантом, бо prevOblastsStable — стабільний стан
      saveState(prevRaions, prevOblastsStable);
    } catch (e) {
      console.error("Poll failed:", e);
    }
  };

  void tick();
  setInterval(() => void tick(), POLL_MS);
}
