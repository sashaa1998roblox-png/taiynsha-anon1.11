import { getStore } from "@netlify/blobs";
import { accountStore, verifySession } from "./lib/accounts.mjs";

const ADMIN_USERNAME = "s3anchezz";
const STATE_KEY = "stats-v1";
const REVISIT_GAP = 30 * 60_000;      // повторный заход того же браузера считается новым визитом через 30 минут
const TZ_OFFSET = 5 * 3600_000;       // Казахстан (UTC+5) — чтобы «сегодня» считалось по местному времени
const KEEP_DAYS = 60;

const BOT_RE = /bot|crawl|spider|slurp|preview|facebookexternalhit|headless|curl|wget|python-requests/i;

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" },
  });
}

const statsStore = () => getStore("taiynsha-stats");
const dayKey = (t) => new Date(t + TZ_OFFSET).toISOString().slice(0, 10);
const cleanToken = (v) => String(v || "").replace(/[^\w-]/g, "").slice(0, 60);

async function readState(store) {
  const res = await store.getWithMetadata(STATE_KEY, { type: "json", consistency: "strong" });
  const d = res?.data || {};
  return {
    etag: res?.etag || null,
    state: {
      visits: Number(d.visits) || 0,
      uniqueVisitors: Number(d.uniqueVisitors) || 0,
      since: Number(d.since) || 0,
      days: d.days && typeof d.days === "object" ? d.days : {},
    },
  };
}

// Чтение → изменение → запись с повтором при конфликте.
async function bump(store, { unique }) {
  for (let attempt = 0; attempt < 8; attempt++) {
    const { etag, state } = await readState(store);
    const now = Date.now();
    if (!state.since) state.since = now;
    state.visits += 1;
    if (unique) state.uniqueVisitors += 1;
    const k = dayKey(now);
    state.days[k] = (Number(state.days[k]) || 0) + 1;
    const keys = Object.keys(state.days).sort();
    while (keys.length > KEEP_DAYS) delete state.days[keys.shift()];
    const w = await store.setJSON(STATE_KEY, state, etag ? { onlyIfMatch: etag } : { onlyIfNew: true });
    if (!w || w.modified !== false) return true;
  }
  return false;
}

async function countAccounts() {
  const { blobs } = await accountStore().list({ prefix: "acc-" });
  return blobs.length;
}

export default async (request) => {
  if (request.method !== "POST") return json({ error: "method" }, 405);

  let body;
  try {
    const raw = await request.text();
    if (raw.length > 5_000) return json({ error: "too_large" }, 413);
    body = JSON.parse(raw);
  } catch { return json({ error: "bad_json" }, 400); }

  const store = statsStore();

  /* ---------- Учёт визита (публично) ---------- */
  if (body?.op === "visit") {
    if (BOT_RE.test(request.headers.get("user-agent") || "")) return json({ ok: true, counted: false });
    const token = cleanToken(body.viewer);
    if (!token) return json({ error: "viewer_required" }, 400);

    const vKey = `vis-${token}`;
    const now = Date.now();
    const created = await store.setJSON(vKey, { first: now, last: now }, { onlyIfNew: true });
    const isNew = !(created && created.modified === false);
    if (isNew) {
      await bump(store, { unique: true });
      return json({ ok: true, counted: true });
    }
    const rec = (await store.get(vKey, { type: "json" })) || {};
    if (now - (Number(rec.last) || 0) < REVISIT_GAP) return json({ ok: true, counted: false });
    await store.setJSON(vKey, { first: Number(rec.first) || now, last: now });
    await bump(store, { unique: false });
    return json({ ok: true, counted: true });
  }

  /* ---------- Статистика для админа (проверка на сервере) ---------- */
  if (body?.op === "admin") {
    const acc = await verifySession(accountStore(), body.session);
    if (!acc || acc.username !== ADMIN_USERNAME) return json({ error: "forbidden" }, 403);

    const [{ state }, accounts] = await Promise.all([readState(store), countAccounts()]);
    const now = Date.now();
    const today = Number(state.days[dayKey(now)]) || 0;
    let week = 0;
    for (let i = 0; i < 7; i++) week += Number(state.days[dayKey(now - i * 86_400_000)]) || 0;

    return json({
      ok: true,
      accounts,
      visits: state.visits,
      uniqueVisitors: state.uniqueVisitors,
      visitsToday: today,
      visitsWeek: week,
      since: state.since,
    });
  }

  return json({ error: "unknown_op" }, 400);
};
