const http = require("http");
const https = require("https");
const { URL } = require("url");

const MODEL_PRO    = process.env.MODEL_PRO    || "deepseek-v4-pro";
const MODEL_VISION = process.env.MODEL_VISION || "deepseek-v4-vision";
const UPSTREAM     = process.env.CPA_URL;
const PORT         = process.env.PORT || 3000;

if (!UPSTREAM) {
  console.error("❌ 缺少环境变量 CPA_URL");
  process.exit(1);
}

// ── 图片检测 ──────────────────────────────────────────────────────────────────
function hasImage(messages = []) {
  for (const msg of messages) {
    const c = msg.content;
    if (Array.isArray(c)) {
      if (c.some(b => b?.type === "image_url" || b?.type === "image")) return true;
    } else if (typeof c === "string" && c.includes("[Image #")) {
      return true;
    }
  }
  return false;
}

// ── 转发 ──────────────────────────────────────────────────────────────────────
function forward(originalHeaders, reqUrl, bodyStr, res) {
  const upstream = new URL(UPSTREAM);
  const isHttps  = upstream.protocol === "https:";
  const lib      = isHttps ? https : http;
  const bodyBuf  = Buffer.from(bodyStr, "utf-8");

  const headers = {
    "content-type":   "application/json",
    "content-length": bodyBuf.length,
    "host":           upstream.host,
  };
  if (originalHeaders["authorization"])
    headers["authorization"] = originalHeaders["authorization"];
  if (originalHeaders["x-api-key"])
    headers["x-api-key"] = originalHeaders["x-api-key"];
  if (originalHeaders["anthropic-version"])
    headers["anthropic-version"] = originalHeaders["anthropic-version"];

  const options = {
    hostname: upstream.hostname,
    port:     upstream.port || (isHttps ? 443 : 80),
    path:     reqUrl,
    method:   "POST",
    headers,
    timeout:  120000,
  };

  const proxy = lib.request(options, (upRes) => {
    res.writeHead(upRes.statusCode, upRes.headers);
    upRes.pipe(res, { end: true });
  });

  proxy.on("timeout", () => {
    proxy.destroy();
    if (!res.headersSent) {
      res.writeHead(504, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "upstream timeout" }));
    }
  });

  proxy.on("error", (e) => {
    console.error("[Router] upstream error:", e.message);
    if (!res.headersSent) {
      res.writeHead(502, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: e.message }));
    }
  });

  proxy.write(bodyBuf);
  proxy.end();
}

// ── HTTP 服务器 ───────────────────────────────────────────────────────────────
http.createServer((req, res) => {

  if (req.method === "GET") {
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify({
      status:   "ok",
      service:  "ds-router",
      upstream: UPSTREAM,
      models:   { text: MODEL_PRO, vision: MODEL_VISION },
    }));
  }

  if (req.method !== "POST") {
    return res.writeHead(405).end();
  }

  const chunks = [];
  req.on("data", chunk => chunks.push(chunk));
  req.on("end", () => {
    let body;
    try {
      body = JSON.parse(Buffer.concat(chunks).toString("utf-8"));
    } catch {
      res.writeHead(400, { "content-type": "application/json" });
      return res.end(JSON.stringify({ error: "invalid json" }));
    }

    const requestedModel = body.model || "";

    // ── 核心判断：只有 deepseek 模型才做路由 ──────────────────────────────────
    if (!requestedModel.toLowerCase().startsWith("deepseek")) {
      // 非 deepseek 模型（claude 等）→ 原样透传，不修改任何字段
      console.log(`[Router] ⏩ PASS     model=${requestedModel}`);
      forward(req.headers, req.url, JSON.stringify(body), res);
      return;
    }

    // deepseek 模型 → 检测图片，决定用 pro 还是 vision
    const vision = hasImage(body.messages || []);
    const before = body.model;
    body.model   = vision ? MODEL_VISION : MODEL_PRO;

    const tag = vision ? "🖼  VISION" : "📝 PRO   ";
    if (before !== body.model)
      console.log(`[Router] ${tag}  ← auto-switched from [${before}]`);
    else
      console.log(`[Router] ${tag}   model=${body.model}`);

    forward(req.headers, req.url, JSON.stringify(body), res);
  });

  req.on("error", (e) => {
    console.error("[Router] request error:", e.message);
    res.writeHead(400).end();
  });

}).listen(PORT, () => {
  console.log("================================");
  console.log("  DS Router 已启动");
  console.log(`  端口    : ${PORT}`);
  console.log(`  上游CPA : ${UPSTREAM}`);
  console.log(`  文本模型 : ${MODEL_PRO}`);
  console.log(`  视觉模型 : ${MODEL_VISION}`);
  console.log("  规则    : deepseek-* → 自动路由");
  console.log("           其他模型  → 直接透传");
  console.log("================================");
});
