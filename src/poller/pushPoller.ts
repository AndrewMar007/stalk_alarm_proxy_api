// // import admin from "firebase-admin";
// // import { fetch } from "undici";
// // import fs from "node:fs";
// // import path from "node:path";

// // type UidNameMap = Map<string, string>; // uid -> name
// // type State = { raions: Record<string, string>; oblasts: Record<string, string> };

// // export function startPushPoller() {
// //   const SERVICE_ACCOUNT_PATH =
// //     process.env.FCM_SERVICE_ACCOUNT || "./serviceAccountKey.json";
// //   const PORT = Number(process.env.PORT || 3000);

// //   // має повертати JSON з { alerts: [...] } або просто [...] — обидва варіанти ок
// //   const PROXY_URL =
// //     process.env.ALERTS_PROXY_URL ||
// //     `http://127.0.0.1:${PORT}/internal/alerts/active`;

// //   const POLL_MS = Number(process.env.POLL_MS || 15000);
// //   const STATE_FILE = process.env.STATE_FILE || "./alarm_state.json";

// //   /* ================= STATE ================= */

// //   function loadState(): { raions: UidNameMap; oblasts: UidNameMap } {
// //     try {
// //       const raw = JSON.parse(fs.readFileSync(STATE_FILE, "utf8")) as State;

// //       return {
// //         raions: new Map(Object.entries(raw?.raions ?? {})),
// //         oblasts: new Map(Object.entries(raw?.oblasts ?? {})),
// //       };
// //     } catch {
// //       return { raions: new Map(), oblasts: new Map() };
// //     }
// //   }

// //   function saveState(raions: UidNameMap, oblasts: UidNameMap) {
// //     const obj: State = {
// //       raions: Object.fromEntries(raions),
// //       oblasts: Object.fromEntries(oblasts),
// //     };
// //     fs.writeFileSync(STATE_FILE, JSON.stringify(obj, null, 2), "utf8");
// //   }

// //   /* ================= EXTRACT ================= */

// //   // function extractActiveMaps(payload: any): {
// //   //   raions: UidNameMap;
// //   //   oblasts: UidNameMap;
// //   // } {
// //   //   const alerts = payload?.alerts ?? payload;

// //   //   const raions = new Map<string, string>();
// //   //   const oblasts = new Map<string, string>();

// //   //   if (!Array.isArray(alerts)) return { raions, oblasts };

// //   //   for (const a of alerts) {
// //   //     // 1) ОБЛАСТЬ вважаємо активною, якщо в ній є будь-який алерт (raion/hromada/city/oblast)
// //   //     //    У всіх твоїх прикладах це є:
// //   //     //      location_oblast_uid: <number>
// //   //     //      location_oblast: "<назва області>"
// //   //     const oblastUid = a?.location_oblast_uid;
// //   //     const oblastName = a?.location_oblast;
// //   //     if (oblastUid != null && oblastName) {
// //   //       oblasts.set(String(oblastUid), String(oblastName));
// //   //     }

// //   //     // 2) РАЙОН активний тільки якщо алерт саме типу "raion"
// //   //     //    (бо для city/hromada у відповіді немає raion_uid)
// //   //     const type = a?.location_type;
// //   //     if (type === "raion") {
// //   //       const uid = a?.location_uid; // "150","152",...
// //   //       const title = a?.location_title; // "Звенигородський район"
// //   //       if (uid != null && title) {
// //   //         raions.set(String(uid), String(title));
// //   //       }
// //   //     }
// //   //   }

// //   //   return { raions, oblasts };
// //   // }

// //   function extractActiveMaps(payload: any): {
// //   raions: UidNameMap;
// //   oblasts: UidNameMap;
// // } {
// //   const alerts = payload?.alerts ?? payload;

// //   const raions = new Map<string, string>();
// //   const oblasts = new Map<string, string>();

// //   if (!Array.isArray(alerts)) return { raions, oblasts };

// //   for (const a of alerts) {
// //     // ✅ беремо тільки активні
// //     if (a?.finished_at != null) continue;

// //     const type = a?.location_type;

// //     // ✅ ОБЛАСТЬ: тільки якщо тип = "oblast"
// //     if (type === "oblast") {
// //       // у oblast-записів uid може бути в location_uid або location_oblast_uid (залежить від API)
// //       const uid = a?.location_uid ?? a?.location_oblast_uid;
// //       const title = a?.location_title ?? a?.location_oblast;

// //       if (uid != null && title) {
// //         oblasts.set(String(uid), String(title));
// //       }
// //       continue;
// //     }

// //     // ✅ РАЙОН: тільки якщо тип = "raion"
// //     if (type === "raion") {
// //       const uid = a?.location_uid;        // 150, 152, ...
// //       const title = a?.location_title;    // "Звенигородський район"

// //       if (uid != null && title) {
// //         raions.set(String(uid), String(title));
// //       }
// //       continue;
// //     }

// //     // city/hromada/інші типи — ігноруємо (бо ти пушиш тільки по oblast/raion)
// //   }

// //   return { raions, oblasts };
// // }


// //   /* ================= PUSH (DATA-ONLY) ================= */

// //   async function sendToTopic(
// //     level: "raion" | "oblast",
// //     uid: string,
// //     name: string,
// //     type: "ALARM_START" | "ALARM_END"
// //   ) {
// //     const isStart = type === "ALARM_START";

// //     // ✅ Текст формуємо на сервері (можеш змінити під свій стиль)
// //     const title = "Stalk Alarm";
// //     const body = isStart
// //       ? `Увага! Повітряна тривога в «${name}»! Залишайтесь в укритті!`
// //       : `Відбій у «${name}». Будьте обережні!`;

// //     // ✅ ВАЖЛИВО: ТІЛЬКИ data (без notification), щоб не було дублю і щоб звук робив FLN
// //     await admin.messaging().send({
// //       topic: `${level}_${uid}`,
// //       data: {
// //         // для твого Flutter
// //         type,           // ALARM_START | ALARM_END
// //         level,          // raion | oblast
// //         uid,            // "150" або "24"
// //         name,           // "Звенигородський район" або "Черкаська область"
// //         // щоб показувати без мапінгу в апці:
// //         title,
// //         body,
// //       },
// //       android: {
// //         priority: "high",
// //       },
// //     });
// //   }

// //   /* ================= POLL ================= */

// //   async function pollOnce(prevRaions: UidNameMap, prevOblasts: UidNameMap) {
// //     const res = await fetch(PROXY_URL, { headers: { Accept: "application/json" } });
// //     if (!res.ok) throw new Error(`Upstream error: ${res.status} ${res.statusText}`);

// //     const payload = await res.json();
// //     const { raions: currentRaions, oblasts: currentOblasts } = extractActiveMaps(payload);

// //     // ---- DIFF RAIONS
// //     const startedRaions: [string, string][] = [];
// //     const endedRaions: [string, string][] = [];

// //     for (const [uid, name] of currentRaions) if (!prevRaions.has(uid)) startedRaions.push([uid, name]);
// //     for (const [uid, name] of prevRaions) if (!currentRaions.has(uid)) endedRaions.push([uid, name]);

// //     // ---- DIFF OBLASTS
// //     const startedOblasts: [string, string][] = [];
// //     const endedOblasts: [string, string][] = [];

// //     for (const [uid, name] of currentOblasts) if (!prevOblasts.has(uid)) startedOblasts.push([uid, name]);
// //     for (const [uid, name] of prevOblasts) if (!currentOblasts.has(uid)) endedOblasts.push([uid, name]);

// //     // SEND (спочатку START, потім END)
// //     for (const [uid, name] of startedRaions) {
// //       await sendToTopic("raion", uid, name, "ALARM_START");
// //       console.log(`🚨 START raion ${name} (${uid})`);
// //     }
// //     for (const [uid, name] of startedOblasts) {
// //       await sendToTopic("oblast", uid, name, "ALARM_START");
// //       console.log(`🚨 START oblast ${name} (${uid})`);
// //     }

// //     for (const [uid, name] of endedRaions) {
// //       await sendToTopic("raion", uid, name, "ALARM_END");
// //       console.log(`✅ END raion ${name} (${uid})`);
// //     }
// //     for (const [uid, name] of endedOblasts) {
// //       await sendToTopic("oblast", uid, name, "ALARM_END");
// //       console.log(`✅ END oblast ${name} (${uid})`);
// //     }

// //     return { currentRaions, currentOblasts };
// //   }

// //   /* ================= INIT ================= */

// //   if (admin.apps.length === 0) {
// //     const sa = JSON.parse(fs.readFileSync(path.resolve(SERVICE_ACCOUNT_PATH), "utf8"));
// //     admin.initializeApp({ credential: admin.credential.cert(sa) });
// //   }

// //   console.log("🚀 Push poller started");
// //   console.log(`POLL_MS=${POLL_MS}`);
// //   console.log(`PROXY_URL=${PROXY_URL}`);
// //   console.log(`STATE_FILE=${STATE_FILE}`);

// //   let { raions: prevRaions, oblasts: prevOblasts } = loadState();

// //   const tick = async () => {
// //     try {
// //       const { currentRaions, currentOblasts } = await pollOnce(prevRaions, prevOblasts);
// //       prevRaions = currentRaions;
// //       prevOblasts = currentOblasts;
// //       saveState(prevRaions, prevOblasts);
// //     } catch (e) {
// //       console.error("Poll failed:", e);
// //     }
// //   };

// //   void tick();
// //   setInterval(() => void tick(), POLL_MS);
// // }

// import admin from "firebase-admin";
// import { fetch } from "undici";
// import fs from "node:fs";
// import path from "node:path";

// type UidNameMap = Map<string, string>;
// type State = { raions: Record<string, string>; oblasts: Record<string, string> };

// export function startPushPoller() {
//   const SERVICE_ACCOUNT_PATH =
//     process.env.FCM_SERVICE_ACCOUNT || "./serviceAccountKey.json";

//   const PORT = Number(process.env.PORT || 3000);

//   const PROXY_URL =
//     process.env.ALERTS_PROXY_URL ||
//     `http://127.0.0.1:${PORT}/internal/alerts/active`;

//   const POLL_MS = Number(process.env.POLL_MS || 15000);
//   const STATE_FILE = process.env.STATE_FILE || "./alarm_state.json";

//   // 🔥 СКІЛЬКИ ТИКІВ ПОТРІБНО ДЛЯ END ОБЛАСТІ (2 = ~30 секунд)
//   const OBLAST_END_CONFIRM_TICKS = Number(
//     process.env.OBLAST_END_CONFIRM_TICKS || 2
//   );

//   /* ================= STATE ================= */

//   function loadState(): { raions: UidNameMap; oblasts: UidNameMap } {
//     try {
//       const raw = JSON.parse(fs.readFileSync(STATE_FILE, "utf8")) as State;
//       return {
//         raions: new Map(Object.entries(raw?.raions ?? {})),
//         oblasts: new Map(Object.entries(raw?.oblasts ?? {})),
//       };
//     } catch {
//       return { raions: new Map(), oblasts: new Map() };
//     }
//   }

//   function saveState(raions: UidNameMap, oblasts: UidNameMap) {
//     const obj: State = {
//       raions: Object.fromEntries(raions),
//       oblasts: Object.fromEntries(oblasts),
//     };
//     fs.writeFileSync(STATE_FILE, JSON.stringify(obj, null, 2), "utf8");
//   }

//   /* ================= EXTRACT ================= */

//   function extractActiveMaps(payload: any): {
//     raions: UidNameMap;
//     oblasts: UidNameMap;
//   } {
//     const alerts = payload?.alerts ?? payload;

//     const raions = new Map<string, string>();
//     const oblasts = new Map<string, string>();

//     if (!Array.isArray(alerts)) return { raions, oblasts };

//     for (const a of alerts) {
//       if (a?.finished_at != null) continue;

//       // ✅ ОБЛАСТЬ активна, якщо є ХОЧА Б 1 активний алерт у ній
//       const oblastUid = a?.location_oblast_uid;
//       const oblastName = a?.location_oblast;
//       if (oblastUid != null && oblastName) {
//         oblasts.set(String(oblastUid), String(oblastName));
//       }

//       // ✅ РАЙОН — тільки якщо type === raion
//       if (a?.location_type === "raion") {
//         const uid = a?.location_uid;
//         const title = a?.location_title;
//         if (uid != null && title) {
//           raions.set(String(uid), String(title));
//         }
//       }
//     }

//     return { raions, oblasts };
//   }

//   /* ================= PUSH ================= */

//   async function sendToTopic(
//     level: "raion" | "oblast",
//     uid: string,
//     name: string,
//     type: "ALARM_START" | "ALARM_END"
//   ) {
//     const isStart = type === "ALARM_START";

//     const title = "Stalk Alarm";
//     const body = isStart
//       ? `Увага! Повітряна тривога в «${name}»!`
//       : `Відбій у «${name}». Будьте обережні!`;

//     await admin.messaging().send({
//       topic: `${level}_${uid}`,
//       data: {
//         type,
//         level,
//         uid,
//         name,
//         title,
//         body,
//       },
//       android: { priority: "high" },
//     });
//   }

//   /* ================= POLL ================= */

//   const oblastMissStreak = new Map<string, number>();

//   async function pollOnce(
//     prevRaions: UidNameMap,
//     prevOblasts: UidNameMap
//   ) {
//     const res = await fetch(PROXY_URL, { headers: { Accept: "application/json" } });
//     if (!res.ok) throw new Error(`Upstream error: ${res.status}`);

//     const payload = await res.json();
//     const { raions: currentRaions, oblasts: currentOblasts } =
//       extractActiveMaps(payload);

//     /* ===== RAIONS (без debounce) ===== */

//     for (const [uid, name] of currentRaions)
//       if (!prevRaions.has(uid)) {
//         await sendToTopic("raion", uid, name, "ALARM_START");
//         console.log(`🚨 START raion ${name} (${uid})`);
//       }

//     for (const [uid, name] of prevRaions)
//       if (!currentRaions.has(uid)) {
//         await sendToTopic("raion", uid, name, "ALARM_END");
//         console.log(`✅ END raion ${name} (${uid})`);
//       }

//     /* ===== OBLASTS (🔥 з антифліккером) ===== */

//     // START
//     for (const [uid, name] of currentOblasts) {
//       oblastMissStreak.delete(uid);

//       if (!prevOblasts.has(uid)) {
//         prevOblasts.set(uid, name);
//         await sendToTopic("oblast", uid, name, "ALARM_START");
//         console.log(`🚨 START oblast ${name} (${uid})`);
//       }
//     }

//     // END (тільки після N тика(ів))
//     for (const [uid, name] of prevOblasts) {
//       if (currentOblasts.has(uid)) continue;

//       const streak = (oblastMissStreak.get(uid) ?? 0) + 1;
//       oblastMissStreak.set(uid, streak);

//       if (streak >= OBLAST_END_CONFIRM_TICKS) {
//         await sendToTopic("oblast", uid, name, "ALARM_END");
//         console.log(`✅ END oblast ${name} (${uid})`);
//         prevOblasts.delete(uid);
//         oblastMissStreak.delete(uid);
//       }
//     }

//     return { currentRaions };
//   }

//   /* ================= INIT ================= */

//   if (admin.apps.length === 0) {
//     const sa = JSON.parse(fs.readFileSync(path.resolve(SERVICE_ACCOUNT_PATH), "utf8"));
//     admin.initializeApp({ credential: admin.credential.cert(sa) });
//   }

//   console.log("🚀 Push poller started");

//   let { raions: prevRaions, oblasts: prevOblasts } = loadState();

//   const tick = async () => {
//     try {
//       const { currentRaions } = await pollOnce(prevRaions, prevOblasts);
//       prevRaions = currentRaions;
//       saveState(prevRaions, prevOblasts);
//     } catch (e) {
//       console.error("Poll failed:", e);
//     }
//   };

//   void tick();
//   setInterval(() => void tick(), POLL_MS);
// }

import admin from "firebase-admin";
import { fetch } from "undici";
import fs from "node:fs";
import path from "node:path";

type UidNameMap = Map<string, string>;
type State = { raions: Record<string, string>; oblasts: Record<string, string> };

type OblastRow = { uid: string; name: string };

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

  // ✅ довідник областей (name -> uid)
  const OBLAST_MAP_FILE = process.env.OBLAST_MAP_FILE || "./oblast_uid_map.json";

  function loadOblastNameToUid(): Map<string, string> {
    try {
      const raw = JSON.parse(fs.readFileSync(OBLAST_MAP_FILE, "utf8")) as OblastRow[];
      const m = new Map<string, string>();
      for (const r of raw) {
        if (!r?.uid || !r?.name) continue;
        m.set(String(r.name).trim(), String(r.uid).trim());
      }
      console.log(`✅ Loaded oblast map: ${m.size} items from ${OBLAST_MAP_FILE}`);
      return m;
    } catch (e) {
      console.warn(
        `⚠️ Could not load ${OBLAST_MAP_FILE}. Oblast OR-from-raions may not work.`,
        e
      );
      return new Map();
    }
  }

  const oblastNameToUid = loadOblastNameToUid();

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
    oblastsInstant: UidNameMap; // "миттєва" карта областей за цей тик
  } {
    const alerts = payload?.alerts ?? payload;

    const raions = new Map<string, string>();
    const oblastsInstant = new Map<string, string>();

    if (!Array.isArray(alerts)) return { raions, oblastsInstant };

    for (const a of alerts) {
      if (a?.finished_at != null) continue;

      const type = a?.location_type;

      // ✅ 1) Прямий "oblast" алерт — найнадійніший
      if (type === "oblast") {
        const uid = a?.location_uid ?? a?.location_oblast_uid;
        const name = a?.location_title ?? a?.location_oblast;
        if (uid != null && name) {
          oblastsInstant.set(String(uid), String(name));
        }
        continue;
      }

      // ✅ 2) OR-логіка: будь-який активний алерт у межах області -> область активна
      // але UID області беремо ТІЛЬКИ з довідника за назвою області
      const oblastName = (a?.location_oblast ?? "").toString().trim();
      if (oblastName) {
        const oblastUid = oblastNameToUid.get(oblastName);
        if (oblastUid) {
          oblastsInstant.set(String(oblastUid), oblastName);
        } else {
          // корисно для дебага: побачиш назви, яких нема у довіднику
          // console.log(`⚠️ Unknown oblastName in map: "${oblastName}"`);
        }
      }

      // ✅ Районні пуші — тільки якщо type === raion
      if (type === "raion") {
        const uid = a?.location_uid;
        const title = a?.location_title;
        if (uid != null && title) {
          raions.set(String(uid), String(title));
        }
      }
    }

    return { raions, oblastsInstant };
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
    ? `Увага! Повітряна тривога в «${name}»! Залишайтесь в укритті!`
    : `Відбій у «${name}». Будьте обережні!`;

  // ✅ UID У ТЕБЕ ВЖЕ З ПРЕФІКСОМ:
  // oblast_14, raion_74
  const topic = uid;

  await admin.messaging().send({
    topic,
    data: {
      type,
      level,
      uid,
      name,
      title,
      body,
    },
    android: { priority: "high" },
  });

  console.log(`[FCM] ${type} -> ${topic} (${name})`);
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

    /* ===== OBLASTS (🔥 stable + debounce END) ===== */

    // START (або лишаємо активною)
    for (const [uid, name] of oblastsInstant) {
      oblastMissStreak.delete(uid);

      if (!prevOblastsStable.has(uid)) {
        prevOblastsStable.set(uid, name);
        await sendToTopic("oblast", uid, name, "ALARM_START");
      } else {
        // оновимо назву на всяк випадок
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
        prevOblastsStable.delete(uid);
        oblastMissStreak.delete(uid);
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
  console.log(`OBLAST_MAP_FILE=${OBLAST_MAP_FILE}`);

  let { raions: prevRaions, oblasts: prevOblastsStable } = loadState();

  const tick = async () => {
    try {
      const { currentRaions } = await pollOnce(prevRaions, prevOblastsStable);

      // ✅ raions — як було
      prevRaions = currentRaions;

      // ✅ oblasts — НЕ перезаписуємо миттєвими, бо prevOblastsStable = стабільний стан
      saveState(prevRaions, prevOblastsStable);
    } catch (e) {
      console.error("Poll failed:", e);
    }
  };

  void tick();
  setInterval(() => void tick(), POLL_MS);
}
