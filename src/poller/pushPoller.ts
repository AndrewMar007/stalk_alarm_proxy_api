import admin from "firebase-admin";
import { fetch } from "undici";
import fs from "node:fs";
import path from "node:path";

type TopicNameMap = Map<string, string>; // topic -> human name
type State = { topics: Record<string, string> };

type OblastTopicRow = { name: string; topic: string };

type AlarmType = "ALARM_START" | "ALARM_END";
type Level = "raion" | "oblast";

export function startPushPoller() {
  const SERVICE_ACCOUNT_PATH =
    process.env.FCM_SERVICE_ACCOUNT || "./serviceAccountKey.json";

  const PORT = Number(process.env.PORT || 3000);
  const PROXY_URL =
    process.env.ALERTS_PROXY_URL ||
    `http://127.0.0.1:${PORT}/internal/alerts/active`;

  const POLL_MS = Number(process.env.POLL_MS || 15000);

  // ✅ один state файл, зберігаємо ТОПІКИ які зараз "активні"
  const STATE_FILE = process.env.STATE_FILE || "./alarm_state.json";

  // ✅ антифліккер END області: 2 тики = ~30с
  const OBLAST_END_CONFIRM_TICKS = Number(
    process.env.OBLAST_END_CONFIRM_TICKS || 2
  );

  // ✅ файл з твоїм мапінгом "назва області" -> "oblast_XX"
  const OBLAST_TOPICS_FILE =
    process.env.OBLAST_TOPICS_FILE || "./oblast_uid_map.json";

  /* ================== INIT FCM ================== */
  if (admin.apps.length === 0) {
    const sa = JSON.parse(
      fs.readFileSync(path.resolve(SERVICE_ACCOUNT_PATH), "utf8")
    );
    admin.initializeApp({ credential: admin.credential.cert(sa) });
  }

  /* ================== LOAD OBLAST TOPICS ================== */
  function loadOblastNameToTopic(): Map<string, string> {
    try {
      const raw = JSON.parse(fs.readFileSync(OBLAST_TOPICS_FILE, "utf8")) as OblastTopicRow[];
      const m = new Map<string, string>();
      for (const r of raw) {
        const name = String(r?.name ?? "").trim();
        const topic = String(r?.topic ?? "").trim();
        if (!name || !topic) continue;
        m.set(name, topic);
      }
      console.log(`✅ Loaded oblast topics: ${m.size} from ${OBLAST_TOPICS_FILE}`);
      return m;
    } catch (e) {
      console.warn(`⚠️ Could not load ${OBLAST_TOPICS_FILE}`, e);
      return new Map();
    }
  }

  const oblastNameToTopic = loadOblastNameToTopic();

  /* ================== STATE ================== */
  function loadState(): TopicNameMap {
    try {
      const raw = JSON.parse(fs.readFileSync(STATE_FILE, "utf8")) as State;
      return new Map(Object.entries(raw?.topics ?? {}));
    } catch {
      return new Map();
    }
  }

  function saveState(activeTopics: TopicNameMap) {
    const obj: State = { topics: Object.fromEntries(activeTopics) };
    fs.writeFileSync(STATE_FILE, JSON.stringify(obj, null, 2), "utf8");
  }

  /* ================== EXTRACT ==================
     - oblast активна якщо Є ХОЧА Б ОДИН активний алерт з location_oblast = ця область
     - raion активний тільки якщо type === "raion"
     - Повертаємо топіки, які треба вважати активними зараз
  */
  function extractActiveTopics(payload: any): {
    raionTopics: TopicNameMap;  // topic -> name
    oblastTopics: TopicNameMap; // topic -> oblast name
  } {
    const alerts = payload?.alerts ?? payload;

    const raionTopics = new Map<string, string>();
    const oblastTopics = new Map<string, string>();

    if (!Array.isArray(alerts)) return { raionTopics, oblastTopics };

    for (const a of alerts) {
      // ✅ тільки активні
      if (a?.finished_at != null) continue;

      // ====== ОБЛАСТЬ: OR по всіх алертах ======
      // беремо назву області з location_oblast (у твоєму JSON вона є всюди)
      const oblastName = (a?.location_oblast ?? "").toString().trim();
      if (oblastName) {
        const oblastTopic = oblastNameToTopic.get(oblastName);
        if (oblastTopic) {
          // в області є хоча б 1 активний алерт -> область активна
          oblastTopics.set(oblastTopic, oblastName);
        }
      }

      // ====== РАЙОН: тільки type=raion ======
      if (a?.location_type === "raion") {
        const raionUid = (a?.location_uid ?? "").toString().trim();
        const raionName = (a?.location_title ?? "").toString().trim();
        if (raionUid && raionName) {
          // твої підписки виглядають як raion_74
          const raionTopic = `raion_${raionUid}`;
          raionTopics.set(raionTopic, raionName);
        }
      }
    }

    return { raionTopics, oblastTopics };
  }

  /* ================== PUSH (DATA ONLY) ================== */
  async function sendToTopic(
    level: Level,
    topic: string,
    name: string,
    type: AlarmType
  ) {
    const isStart = type === "ALARM_START";

    const title = "Stalk Alarm";
    const body = isStart
      ? `Увага! Повітряна тривога в «${name}»! Залишайтесь в укритті!`
      : `Відбій у «${name}». Будьте обережні!`;

    await admin.messaging().send({
      topic,
      data: {
        type,
        level,
        uid: topic,     // для сумісності з твоїм Flutter (ти uid читаєш як string)
        name,
        title,
        body,
      },
      android: { priority: "high" },
    });

    console.log(`[FCM SEND] type=${type} level=${level} topic=${topic} name="${name}"`);
  }

  /* ================== POLL ================== */
  const oblastMissStreak = new Map<string, number>(); // topic -> misses count

  async function pollOnce(prevActiveTopics: TopicNameMap) {
    const res = await fetch(PROXY_URL, { headers: { Accept: "application/json" } });
    if (!res.ok) throw new Error(`Upstream error: ${res.status} ${res.statusText}`);

    const payload = await res.json();
    const { raionTopics, oblastTopics } = extractActiveTopics(payload);

    // current set = raions + oblasts
    const currentActive = new Map<string, string>([
      ...raionTopics.entries(),
      ...oblastTopics.entries(),
    ]);

    /* ===== START ===== */
    for (const [topic, name] of currentActive) {
      if (!prevActiveTopics.has(topic)) {
        const level: Level = topic.startsWith("oblast_") ? "oblast" : "raion";
        await sendToTopic(level, topic, name, "ALARM_START");
      }
    }

    /* ===== END =====
       - raion: одразу END
       - oblast: END тільки якщо область ВЖЕ 0 активних алертів (тобто topic зник),
                і зник N тиками підряд (антифліккер)
    */
    for (const [topic, name] of Array.from(prevActiveTopics.entries())) {
      if (currentActive.has(topic)) {
        // якщо знов активний — скидаємо streak
        if (topic.startsWith("oblast_")) oblastMissStreak.delete(topic);
        continue;
      }

      const isOblast = topic.startsWith("oblast_");

      if (!isOblast) {
        // raion end одразу
        await sendToTopic("raion", topic, name, "ALARM_END");
        prevActiveTopics.delete(topic);
        continue;
      }

      // oblast end з підтвердженням
      const streak = (oblastMissStreak.get(topic) ?? 0) + 1;
      oblastMissStreak.set(topic, streak);

      if (streak >= OBLAST_END_CONFIRM_TICKS) {
        await sendToTopic("oblast", topic, name, "ALARM_END");
        prevActiveTopics.delete(topic);
        oblastMissStreak.delete(topic);
      }
    }

    return currentActive;
  }

  /* ================== RUN ================== */
  console.log("🚀 Push poller started");
  console.log(`POLL_MS=${POLL_MS}`);
  console.log(`PROXY_URL=${PROXY_URL}`);
  console.log(`STATE_FILE=${STATE_FILE}`);
  console.log(`OBLAST_TOPICS_FILE=${OBLAST_TOPICS_FILE}`);
  console.log(`OBLAST_END_CONFIRM_TICKS=${OBLAST_END_CONFIRM_TICKS}`);

  let prevActiveTopics = loadState();

  const tick = async () => {
    try {
      prevActiveTopics = await pollOnce(prevActiveTopics);
      saveState(prevActiveTopics);
    } catch (e) {
      console.error("Poll failed:", e);
    }
  };

  void tick();
  setInterval(() => void tick(), POLL_MS);
}
