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

export default {
  async fetch(req, env) {
    if (req.method !== "POST") {
      return new Response("Method Not Allowed", { status: 405 });
    }
    if (req.headers.get("Authorization") !== `Bearer ${env.SHARED_SECRET}`) {
      return new Response("Unauthorized", { status: 401 });
    }

    const parts = new URL(req.url).pathname.split("/").filter(Boolean);
    const [status, action] =
      parts.length === 1 && ALIASES[parts[0]] ? ALIASES[parts[0]] : parts;

    let roles;
    try {
      roles = JSON.parse(env.ROLES || "{}");
    } catch {
      return new Response("ROLES is not valid JSON", { status: 500 });
    }
    if (!roles[status] || (action !== "on" && action !== "off")) {
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
