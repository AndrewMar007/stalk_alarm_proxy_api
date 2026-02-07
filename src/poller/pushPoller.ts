import admin from "firebase-admin";
import { fetch } from "undici";
import fs from "node:fs";
import path from "node:path";

type TopicNameMap = Map<string, string>; // topic -> name
type AlarmType = "ALARM_START" | "ALARM_END";

type State = {
  raions: Record<string, string>;
  oblasts: Record<string, string>;
  hromadas: Record<string, string>;
};

type OblastTopicRow = { name: string; topic: string };

// ✅ ПІДТРИМУЄМО ОБИДВА ФОРМАТИ ФАЙЛУ ГРОМАД:
//
// A) { "uid":"UA...", "title":"...", "raionUid":"raion_135" }
// B) { "uid":"UA...", "name":"...", "raion_uid":"raion_107", "topic":"hromada_UA..." }
type HromadaRowAny = {
  uid?: string;
  title?: string;
  name?: string;
  raionUid?: string;
  raion_uid?: string;
  topic?: string;
};

type HromadaIndexed = {
  uid: string;       // UA...
  name: string;      // title/name
  raionUid: string;  // raion_###
  topic: string;     // hromada_UA...
};

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

  // ✅ антифліккер END громад: 2 тики = ~30с
  const HROMADA_END_CONFIRM_TICKS = Number(
    process.env.HROMADA_END_CONFIRM_TICKS || 2
  );

  // ✅ файл-мапа "назва області" -> "oblast_XX"
  const OBLAST_TOPICS_FILE =
    process.env.OBLAST_TOPICS_FILE || "./oblast_uid_map.json";

  // ✅ файл зі списком громад
  const HROMADAS_MAP_FILE =
    process.env.HROMADAS_MAP_FILE || "./hromada_uid_map.json";

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
      return m;
    } catch {
      return new Map();
    }
  }

  const oblastNameToTopic = loadOblastNameToTopic();

  /* ================= HROMADAS MAP (raion -> hromadas[]) ================= */

  function normalizeHromadaRow(r: HromadaRowAny): HromadaIndexed | null {
    const uid = (r?.uid ?? "").toString().trim();
    if (!uid) return null;

    const name =
      (r?.title ?? r?.name ?? "").toString().trim(); // <-- головне: title OR name
    const raionUid =
      (r?.raionUid ?? r?.raion_uid ?? "").toString().trim(); // <-- raionUid OR raion_uid

    if (!name || !raionUid) return null;

    const topicRaw = (r?.topic ?? "").toString().trim();
    const topic = topicRaw
      ? topicRaw
      : uid.startsWith("hromada_")
        ? uid
        : `hromada_${uid}`;

    return { uid, name, raionUid, topic };
  }

  function loadRaionToHromadas(): Map<string, HromadaIndexed[]> {
    try {
      const raw = JSON.parse(
        fs.readFileSync(HROMADAS_MAP_FILE, "utf8")
      ) as HromadaRowAny[];

      const m = new Map<string, HromadaIndexed[]>();
      let ok = 0;

      for (const row of raw) {
        const h = normalizeHromadaRow(row);
        if (!h) continue;

        ok++;
        if (!m.has(h.raionUid)) m.set(h.raionUid, []);
        m.get(h.raionUid)!.push(h);
      }

      console.log(`✅ Loaded hromadas: ${ok} from ${HROMADAS_MAP_FILE}`);
      return m;
    } catch {
      console.log(
        `⚠️ Could not load ${HROMADAS_MAP_FILE}. Hromada fanout disabled.`
      );
      return new Map();
    }
  }

  const raionToHromadas = loadRaionToHromadas();

  /* ================= STATE ================= */

  function loadState(): {
    raions: TopicNameMap;
    oblasts: TopicNameMap;
    hromadas: TopicNameMap;
  } {
    try {
      const raw = JSON.parse(fs.readFileSync(STATE_FILE, "utf8")) as State;
      return {
        raions: new Map(Object.entries(raw?.raions ?? {})),
        oblasts: new Map(Object.entries(raw?.oblasts ?? {})),
        hromadas: new Map(Object.entries(raw?.hromadas ?? {})),
      };
    } catch {
      return { raions: new Map(), oblasts: new Map(), hromadas: new Map() };
    }
  }

  function saveState(
    raions: TopicNameMap,
    oblasts: TopicNameMap,
    hromadas: TopicNameMap
  ) {
    const obj: State = {
      raions: Object.fromEntries(raions),
      oblasts: Object.fromEntries(oblasts),
      hromadas: Object.fromEntries(hromadas),
    };
    fs.writeFileSync(STATE_FILE, JSON.stringify(obj, null, 2), "utf8");
  }

  /* ================= EXTRACT (from API) ================= */

  function extractActiveTopics(payload: any): {
    raions: TopicNameMap; // topic -> name
    oblasts: TopicNameMap; // topic -> name
  } {
    const alerts = payload?.alerts ?? payload;

    const raions = new Map<string, string>();
    const oblasts = new Map<string, string>();

    if (!Array.isArray(alerts)) return { raions, oblasts };

    for (const a of alerts) {
      // ✅ тільки активні
      if (a?.finished_at != null) continue;

      // ===== OBLAST =====
      const oblastName = (a?.location_oblast ?? "").toString().trim();
      if (oblastName) {
        const oblastTopic = oblastNameToTopic.get(oblastName);
        if (oblastTopic) {
          oblasts.set(oblastTopic, oblastName);
        }
      }

      // ===== RAION =====
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

  /* ================= HROMADAS DERIVED FROM RAIONS ================= */

  function deriveActiveHromadasFromActiveRaions(
    activeRaions: TopicNameMap
  ): TopicNameMap {
    const h = new Map<string, string>();

    if (raionToHromadas.size === 0) return h;

    for (const [raionTopic] of activeRaions) {
      const list = raionToHromadas.get(raionTopic) ?? [];
      for (const row of list) {
        // ✅ беремо topic + name з файлу (а не конструюємо)
        h.set(row.topic, row.name);
      }
    }
    return h;
  }

  /* ================= PUSH ================= */

  async function sendToTopic(
    level: "raion" | "oblast" | "hromada",
    topic: string,
    name: string,
    type: AlarmType
  ) {
    const isStart = type === "ALARM_START";

    const TTL_SECONDS = 5 * 60; // ✅ 5 хвилин

    await admin.messaging().send({
      topic,
      data: {
        type,
        level,
        uid: topic,     // як і було
        name,           // можеш прибрати, якщо не треба (див. нижче)
        sentAtMs: Date.now().toString(), // ✅ опційно для дебагу/фільтрації
      },

      android: {
        priority: "high",
        ttl: TTL_SECONDS * 1000,          // ✅ Android TTL
        collapseKey: `alarm_${topic}`,    // ✅ не накопичувати офлайн
      },

      apns: {
        headers: {
          "apns-expiration": `${Math.floor(Date.now() / 1000) + TTL_SECONDS}`,
          "apns-collapse-id": `alarm_${topic}`, // ✅ iOS collapse
        },
      },
    });



    console.log(
      `[FCM SEND] type=${type} level=${level} topic=${topic} name="${name}"`
    );
  }

  /* ================= POLL ================= */

  const oblastMissStreak = new Map<string, number>();
  const hromadaMissStreak = new Map<string, number>();

  async function pollOnce(
    prevRaions: TopicNameMap,
    prevOblastsStable: TopicNameMap,
    prevHromadasStable: TopicNameMap
  ) {
    const res = await fetch(PROXY_URL, {
      headers: { Accept: "application/json" },
    });
    if (!res.ok) throw new Error(`Upstream error: ${res.status} ${res.statusText}`);

    const payload = await res.json();

    const { raions: currentRaions, oblasts: oblastsInstant } =
      extractActiveTopics(payload);

    const hromadasInstant = deriveActiveHromadasFromActiveRaions(currentRaions);

    /* ===== RAIONS ===== */

    for (const [topic, name] of currentRaions) {
      if (!prevRaions.has(topic)) {
        await sendToTopic("raion", topic, name, "ALARM_START");
      }
    }
    for (const [topic, name] of prevRaions) {
      if (!currentRaions.has(topic)) {
        await sendToTopic("raion", topic, name, "ALARM_END");
      }
    }

    /* ===== OBLASTS (stable + debounce END) ===== */

    for (const [topic, name] of oblastsInstant) {
      oblastMissStreak.delete(topic);

      if (!prevOblastsStable.has(topic)) {
        prevOblastsStable.set(topic, name);
        await sendToTopic("oblast", topic, name, "ALARM_START");
      } else {
        prevOblastsStable.set(topic, name);
      }
    }

    for (const [topic, name] of Array.from(prevOblastsStable.entries())) {
      if (oblastsInstant.has(topic)) continue;

      const streak = (oblastMissStreak.get(topic) ?? 0) + 1;
      oblastMissStreak.set(topic, streak);

      if (streak >= OBLAST_END_CONFIRM_TICKS) {
        await sendToTopic("oblast", topic, name, "ALARM_END");
        prevOblastsStable.delete(topic);
        oblastMissStreak.delete(topic);
      }
    }

    /* ===== HROMADAS (stable + debounce END) ===== */

    for (const [topic, name] of hromadasInstant) {
      hromadaMissStreak.delete(topic);

      if (!prevHromadasStable.has(topic)) {
        prevHromadasStable.set(topic, name);
        await sendToTopic("hromada", topic, name, "ALARM_START");
      } else {
        prevHromadasStable.set(topic, name);
      }
    }

    for (const [topic, name] of Array.from(prevHromadasStable.entries())) {
      if (hromadasInstant.has(topic)) continue;

      const streak = (hromadaMissStreak.get(topic) ?? 0) + 1;
      hromadaMissStreak.set(topic, streak);

      if (streak >= HROMADA_END_CONFIRM_TICKS) {
        await sendToTopic("hromada", topic, name, "ALARM_END");
        prevHromadasStable.delete(topic);
        hromadaMissStreak.delete(topic);
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
  console.log(`HROMADA_END_CONFIRM_TICKS=${HROMADA_END_CONFIRM_TICKS}`);
  console.log(`OBLAST_TOPICS_FILE=${OBLAST_TOPICS_FILE}`);
  console.log(`HROMADAS_MAP_FILE=${HROMADAS_MAP_FILE}`);

  let {
    raions: prevRaions,
    oblasts: prevOblastsStable,
    hromadas: prevHromadasStable,
  } = loadState();

  const tick = async () => {
    try {
      const { currentRaions } = await pollOnce(
        prevRaions,
        prevOblastsStable,
        prevHromadasStable
      );
      prevRaions = currentRaions;
      saveState(prevRaions, prevOblastsStable, prevHromadasStable);
    } catch (e) {
      console.error("Poll failed:", e);
    }
  };

  void tick();
  setInterval(() => void tick(), POLL_MS);
}
