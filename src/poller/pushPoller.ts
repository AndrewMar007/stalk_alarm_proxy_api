import admin from "firebase-admin";
import { fetch } from "undici";
import fs from "node:fs";
import path from "node:path";

type TopicNameMap = Map<string, string>; // topic -> name
type State = { raions: Record<string, string>; oblasts: Record<string, string> };

type OblastTopicRow = { name: string; topic: string };
type AlarmType = "ALARM_START" | "ALARM_END";

export function startPushPoller() {
  const SERVICE_ACCOUNT_PATH =
    process.env.FCM_SERVICE_ACCOUNT || "./serviceAccountKey.json";

  const PORT = Number(process.env.PORT || 3000);
  const PROXY_URL =
    process.env.ALERTS_PROXY_URL ||
    `http://127.0.0.1:${PORT}/internal/alerts/active`;

  const POLL_MS = Number(process.env.POLL_MS || 15000);
  const STATE_FILE = process.env.STATE_FILE || "./alarm_state.json";

  // ✅ антифліккер END області: 2 тики = ~30с
  const OBLAST_END_CONFIRM_TICKS = Number(
    process.env.OBLAST_END_CONFIRM_TICKS || 2
  );

  // ✅ файл-мапа "назва області" -> "oblast_XX"
  const OBLAST_TOPICS_FILE =
    process.env.OBLAST_TOPICS_FILE || "./oblast_uid_map.json";

  /* ================= OBLAST TOPICS MAP ================= */

  function loadOblastNameToTopic(): Map<string, string> {
    try {
      const raw = JSON.parse(
        fs.readFileSync(OBLAST_TOPICS_FILE, "utf8")
      ) as OblastTopicRow[];

      const m = new Map<string, string>();
      for (const r of raw) {
        const name = (r?.name ?? "").toString().trim();
        const topic = (r?.topic ?? "").toString().trim();
        if (!name || !topic) continue;
        m.set(name, topic);
      }
      //console.log(`✅ Loaded oblast topics: ${m.size} from ${OBLAST_TOPICS_FILE}`);
      return m;
    } catch (e) {
      //console.warn(`⚠️ Could not load ${OBLAST_TOPICS_FILE}`, e);
      return new Map();
    }
  }

  const oblastNameToTopic = loadOblastNameToTopic();

  /* ================= STATE ================= */

  function loadState(): { raions: TopicNameMap; oblasts: TopicNameMap } {
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

  function saveState(raions: TopicNameMap, oblasts: TopicNameMap) {
    const obj: State = {
      raions: Object.fromEntries(raions),
      oblasts: Object.fromEntries(oblasts),
    };
    fs.writeFileSync(STATE_FILE, JSON.stringify(obj, null, 2), "utf8");
  }

  /* ================= EXTRACT ================= */

  function extractActiveTopics(payload: any): {
    raions: TopicNameMap;   // topic -> name
    oblasts: TopicNameMap;  // topic -> name
  } {
    const alerts = payload?.alerts ?? payload;

    const raions = new Map<string, string>();
    const oblasts = new Map<string, string>();

    if (!Array.isArray(alerts)) return { raions, oblasts };

    for (const a of alerts) {
      // ✅ тільки активні
      if (a?.finished_at != null) continue;

      // ===== OBLAST =====
      // область активна, якщо є хоч 1 алерт у цій області (будь-який location_type)
      const oblastName = (a?.location_oblast ?? "").toString().trim();
      if (oblastName) {
        const oblastTopic = oblastNameToTopic.get(oblastName);
        if (oblastTopic) {
          oblasts.set(oblastTopic, oblastName);
        } else {
          // якщо десь не збіглась назва — побачиш це в логах
          //console.log(`[OBLAST MAP MISS] "${oblastName}" has no topic in ${OBLAST_TOPICS_FILE}`);
        }
      }

      // ===== RAION =====
      // район активний тільки якщо type === raion
      if (a?.location_type === "raion") {
        const raionUid = (a?.location_uid ?? "").toString().trim();
        const raionName = (a?.location_title ?? "").toString().trim();
        if (raionUid && raionName) {
          const raionTopic = `raion_${raionUid}`;
          raions.set(raionTopic, raionName);
        }
      }
    }

    return { raions, oblasts };
  }

  /* ================= PUSH ================= */

  async function sendToTopic(
    level: "raion" | "oblast",
    topic: string, // ✅ СЮДИ ПРИХОДИТЬ ВЖЕ ГОТОВИЙ topic: "oblast_14" або "raion_74"
    name: string,
    type: AlarmType
  ) {
    const isStart = type === "ALARM_START";

    const title = "Stalk Alarm";
    const body = isStart
      ? `Увага! Насувається викид в «${name}»! Пройдіть в найближче укриття!`
      : `Викид завершився у «${name}». Слідкуйте за подальшими оновленнями!`;

    await admin.messaging().send({
      topic,
      data: {
        type,
        level,
        uid: topic, // щоб у Flutter було видно як ти підписувався
        name,
        title,
        body,
      },
      android: { priority: "high" },
    });

   // console.log(`[FCM SEND] type=${type} level=${level} topic=${topic} name="${name}"`);
  }

  /* ================= POLL ================= */

  // ✅ streak відсутності області (антифліккер END)
  const oblastMissStreak = new Map<string, number>();

  async function pollOnce(prevRaions: TopicNameMap, prevOblastsStable: TopicNameMap) {
    const res = await fetch(PROXY_URL, { headers: { Accept: "application/json" } });
    if (!res.ok) throw new Error(`Upstream error: ${res.status} ${res.statusText}`);

    const payload = await res.json();
    const { raions: currentRaions, oblasts: oblastsInstant } = extractActiveTopics(payload);

    /* ===== RAIONS (без debounce) ===== */

    for (const [topic, name] of currentRaions) {
      if (!prevRaions.has(topic)) {
        const t: AlarmType = "ALARM_START";
        await sendToTopic("raion", topic, name, t);
      }
    }
    for (const [topic, name] of prevRaions) {
      if (!currentRaions.has(topic)) {
        const t: AlarmType = "ALARM_END";
        await sendToTopic("raion", topic, name, t);
      }
    }

    /* ===== OBLASTS (stable + debounce END) ===== */

    // START
    for (const [topic, name] of oblastsInstant) {
      oblastMissStreak.delete(topic);

      if (!prevOblastsStable.has(topic)) {
        prevOblastsStable.set(topic, name);
        const t: AlarmType = "ALARM_START";
        await sendToTopic("oblast", topic, name, t);
      } else {
        prevOblastsStable.set(topic, name);
      }
    }

    // END лише після N тика(ів) відсутності
    for (const [topic, name] of Array.from(prevOblastsStable.entries())) {
      if (oblastsInstant.has(topic)) continue;

      const streak = (oblastMissStreak.get(topic) ?? 0) + 1;
      oblastMissStreak.set(topic, streak);

      if (streak >= OBLAST_END_CONFIRM_TICKS) {
        const t: AlarmType = "ALARM_END";
        await sendToTopic("oblast", topic, name, t);
        prevOblastsStable.delete(topic);
        oblastMissStreak.delete(topic);
      }
    }

    return { currentRaions };
  }

  /* ================= INIT ================= */

  if (admin.apps.length === 0) {
    const sa = JSON.parse(fs.readFileSync(path.resolve(SERVICE_ACCOUNT_PATH), "utf8"));
    admin.initializeApp({ credential: admin.credential.cert(sa) });
  }

  console.log("🚀 Push poller started");
  console.log(`POLL_MS=${POLL_MS}`);
  console.log(`PROXY_URL=${PROXY_URL}`);
  console.log(`STATE_FILE=${STATE_FILE}`);
  console.log(`OBLAST_END_CONFIRM_TICKS=${OBLAST_END_CONFIRM_TICKS}`);
  console.log(`OBLAST_TOPICS_FILE=${OBLAST_TOPICS_FILE}`);

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
