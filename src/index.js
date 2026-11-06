// Discord ステータスロール切り替え（Cloudflare Workers）
//
// POST /<status>/on  → そのステータスのロールを付与
// POST /<status>/off → そのステータスのロールを外す
//   例: /sleep/on, /sleep/off, /away/on, /away/off
// 互換: /sleep = /sleep/on, /wake = /sleep/off
//
// 自動オフ（要 KV バインディング STATE）
//   POST /<status>/on?hours=3       → 3時間後に自動で外す（0.5 など小数も可、最大72）
//   POST /<status>/on?until=07:30   → 次の 07:30 に自動で外す
//   AUTO_OFF に書いたステータスは、指定がなければその時刻に自動で外す
//   Cron が数分おきに期限切れを確認して外す
//
// ※ サーバーオーナーにも使える（ニックネーム変更と違い制限なし）
//
// 必要な環境変数
//   BOT_TOKEN     (Secret) Discord Bot のトークン
//   SHARED_SECRET (Secret) ショートカットから送る合言葉（適当な長い文字列）
//   USER_ID       自分の Discord ユーザーID
//   ROLES         ステータスごとの "サーバーID:ロールID"（カンマ区切り）を JSON で
//                 例: {"sleep":"1111:2222,3333:4444","away":"1111:5555"}
//                 ステータス名は自由に追加できる（例: "work", "busy"）
//   AUTO_OFF      (任意) ステータスごとの既定の自動オフ時刻 例: {"busy":"05:00"}
//   UTC_OFFSET    (任意) 時刻指定のタイムゾーン（時間）。既定 9 = 日本時間

const ALIASES = { sleep: ["sleep", "on"], wake: ["sleep", "off"] };
const EXPIRIES_KEY = "expiries"; // KV に { status: 期限(ms) } を1つのキーで保存
const MAX_HOURS = 72;

// 長さや内容で処理時間が変わらないよう、SHA-256 してから定数時間比較する
async function safeEqual(a, b) {
  const enc = new TextEncoder();
  const [ha, hb] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(a)),
    crypto.subtle.digest("SHA-256", enc.encode(b)),
  ]);
  return crypto.subtle.timingSafeEqual(ha, hb);
}

function parseJsonVar(value, name) {
  try {
    return JSON.parse(value || "{}");
  } catch {
    throw new Response(`${name} is not valid JSON`, { status: 500 });
  }
}

// "HH:MM"（UTC_OFFSET のタイムゾーン）の次の到来時刻を ms で返す。不正なら null
function nextTimeOfDay(hhmm, env, now) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm || "");
  if (!m || +m[1] > 23 || +m[2] > 59) return null;
  const offset = Number(env.UTC_OFFSET ?? 9) * 3600e3;
  const local = new Date(now + offset);
  let t =
    Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate(), +m[1], +m[2]) -
    offset;
  if (t <= now) t += 86400e3;
  return t;
}

// on のときの自動オフ期限を決める。undefined = 自動オフなし
function resolveExpiry(url, status, env, now) {
  const hours = url.searchParams.get("hours");
  const until = url.searchParams.get("until");
  if (hours !== null) {
    const h = Number(hours);
    if (!(h > 0 && h <= MAX_HOURS)) {
      throw new Response(`hours must be > 0 and <= ${MAX_HOURS}`, { status: 400 });
    }
    return now + h * 3600e3;
  }
  if (until !== null) {
    const t = nextTimeOfDay(until, env, now);
    if (t === null) throw new Response("until must be HH:MM", { status: 400 });
    return t;
  }
  const autoOff = parseJsonVar(env.AUTO_OFF, "AUTO_OFF");
  if (Object.hasOwn(autoOff, status)) {
    const t = nextTimeOfDay(autoOff[status], env, now);
    if (t === null) throw new Response(`AUTO_OFF.${status} must be HH:MM`, { status: 500 });
    return t;
  }
  return undefined;
}

async function applyRole(env, spec, status, action) {
  const method = action === "on" ? "PUT" : "DELETE";
  const pairs = spec
    .split(",")
    .map((s) => s.trim().split(":"))
    .filter(([g, r]) => g && r);

  const results = await Promise.all(
    pairs.map(async ([guildId, roleId]) => {
      const res = await fetch(
        `https://discord.com/api/v10/guilds/${guildId}/members/${env.USER_ID}/roles/${roleId}`,
        {
          method,
          headers: {
            Authorization: `Bot ${env.BOT_TOKEN}`,
            "User-Agent": "DiscordBot (status-role, 1.0)",
            "X-Audit-Log-Reason": encodeURIComponent(`auto: ${status} ${action}`),
          },
        }
      );
      return {
        guildId,
        roleId,
        status: res.status,
        error: res.ok ? undefined : await res.text(),
      };
    })
  );
  const ok = results.every((r) => r.status >= 200 && r.status < 300);
  return { ok, results };
}

async function updateExpiries(env, fn) {
  const exp = (await env.STATE.get(EXPIRIES_KEY, "json")) || {};
  fn(exp);
  await env.STATE.put(EXPIRIES_KEY, JSON.stringify(exp));
}

async function handleFetch(req, env) {
  if (req.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405 });
  }
  if (!env.SHARED_SECRET || !env.BOT_TOKEN || !env.USER_ID) {
    return new Response("Server is not configured", { status: 500 });
  }
  const auth = req.headers.get("Authorization") || "";
  if (!(await safeEqual(auth, `Bearer ${env.SHARED_SECRET}`))) {
    return new Response("Unauthorized", { status: 401 });
  }

  const url = new URL(req.url);
  const parts = url.pathname.split("/").filter(Boolean);
  let status, action;
  if (parts.length === 1 && Object.hasOwn(ALIASES, parts[0])) {
    [status, action] = ALIASES[parts[0]];
  } else if (parts.length === 2) {
    [status, action] = parts;
  } else {
    return new Response("Not Found", { status: 404 });
  }

  const roles = parseJsonVar(env.ROLES, "ROLES");
  if (
    !Object.hasOwn(roles, status) ||
    typeof roles[status] !== "string" ||
    (action !== "on" && action !== "off")
  ) {
    return new Response("Not Found", { status: 404 });
  }

  const now = Date.now();
  const expiresAt = action === "on" ? resolveExpiry(url, status, env, now) : undefined;
  if (expiresAt !== undefined && !env.STATE) {
    return new Response("Auto-off needs the STATE KV binding", { status: 500 });
  }

  const { ok, results } = await applyRole(env, roles[status], status, action);

  // ロール操作が成功したときだけ期限を記録／解除する
  if (ok && env.STATE) {
    if (expiresAt !== undefined) {
      await updateExpiries(env, (exp) => (exp[status] = expiresAt));
    } else {
      // 手動 off、または期限なしで on し直したら、以前の自動オフ予約は消す
      const exp = (await env.STATE.get(EXPIRIES_KEY, "json")) || {};
      if (Object.hasOwn(exp, status)) {
        await updateExpiries(env, (e) => delete e[status]);
      }
    }
  }

  return Response.json(
    {
      status,
      action,
      expiresAt: expiresAt !== undefined ? new Date(expiresAt).toISOString() : undefined,
      results,
    },
    { status: ok ? 200 : 502 }
  );
}

// Cron: 期限切れのロールを外す
async function handleScheduled(env) {
  if (!env.STATE || !env.BOT_TOKEN || !env.USER_ID) return;
  const exp = (await env.STATE.get(EXPIRIES_KEY, "json")) || {};
  const now = Date.now();
  const due = Object.keys(exp).filter((s) => exp[s] <= now);
  if (due.length === 0) return;

  const roles = JSON.parse(env.ROLES || "{}");
  const done = [];
  for (const status of due) {
    if (typeof roles[status] !== "string") {
      done.push(status); // ROLES から消えたステータスは予約だけ捨てる
      continue;
    }
    const { ok, results } = await applyRole(env, roles[status], status, "off");
    console.log(JSON.stringify({ autoOff: status, ok, results }));
    if (ok) done.push(status); // 失敗したら次の Cron で再試行
  }
  if (done.length) {
    await updateExpiries(env, (e) => {
      for (const s of done) if (e[s] === exp[s]) delete e[s];
    });
  }
}

export default {
  async fetch(req, env) {
    try {
      return await handleFetch(req, env);
    } catch (e) {
      if (e instanceof Response) return e;
      throw e;
    }
  },
  async scheduled(event, env, ctx) {
    ctx.waitUntil(handleScheduled(env));
  },
};
