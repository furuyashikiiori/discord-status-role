// Discord ステータスロール切り替え（Cloudflare Workers）
//
// POST /<status>/on  → そのステータスのロールを付与
// POST /<status>/off → そのステータスのロールを外す
//   例: /sleep/on, /sleep/off, /away/on, /away/off
// 互換: /sleep = /sleep/on, /wake = /sleep/off
//
// ※ サーバーオーナーにも使える（ニックネーム変更と違い制限なし）
//
// 必要な環境変数
//   BOT_TOKEN     (Secret) Discord Bot のトークン
//   SHARED_SECRET (Secret) ショートカットから送る合言葉（適当な長い文字列）
//   USER_ID       自分の Discord ユーザーID
//   ROLES         ステータスごとの "サーバーID:ロールID"（カンマ区切り）を JSON で
//                 例: {"sleep":"1111:2222,3333:4444","away":"1111:5555"}
//                 ステータス名は自由に追加できる（例: "work", "school"）

const ALIASES = { sleep: ["sleep", "on"], wake: ["sleep", "off"] };

// 長さや内容で処理時間が変わらないよう、SHA-256 してから定数時間比較する
async function safeEqual(a, b) {
  const enc = new TextEncoder();
  const [ha, hb] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(a)),
    crypto.subtle.digest("SHA-256", enc.encode(b)),
  ]);
  return crypto.subtle.timingSafeEqual(ha, hb);
}

export default {
  async fetch(req, env) {
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

    const parts = new URL(req.url).pathname.split("/").filter(Boolean);
    let status, action;
    if (parts.length === 1 && Object.hasOwn(ALIASES, parts[0])) {
      [status, action] = ALIASES[parts[0]];
    } else if (parts.length === 2) {
      [status, action] = parts;
    } else {
      return new Response("Not Found", { status: 404 });
    }

    let roles;
    try {
      roles = JSON.parse(env.ROLES || "{}");
    } catch {
      return new Response("ROLES is not valid JSON", { status: 500 });
    }
    if (
      !Object.hasOwn(roles, status) ||
      typeof roles[status] !== "string" ||
      (action !== "on" && action !== "off")
    ) {
      return new Response("Not Found", { status: 404 });
    }

    const method = action === "on" ? "PUT" : "DELETE";
    const pairs = roles[status]
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
    return Response.json({ status, action, results }, { status: ok ? 200 : 502 });
  },
};
