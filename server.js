const express = require("express");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
require("dotenv").config();

const app = express();
const PORT = process.env.PORT || 3000;
const SUNO_BASE_URL = "https://api.sunoapi.org/api/v1";
const callbackCache = new Map();
const unlockAttempts = new Map();
const storageDir = process.env.STORAGE_DIR || "";
const uploadsDir = process.env.UPLOADS_DIR
  || (storageDir ? path.join(storageDir, "uploads") : path.join(__dirname, "uploads"));
const dataDir = storageDir ? path.join(storageDir, "data") : path.join(__dirname, "data");
const sharesFile = process.env.SHARES_FILE || path.join(dataDir, "shares.json");
const SHARE_ACCESS_TYPE_PUBLIC = "public_link";
const SHARE_ACCESS_TYPE_PASSWORD = "password";
const SHARE_UNLOCK_TTL_MS = 24 * 60 * 60 * 1000;
const SHARE_UNLOCK_WINDOW_MS = 10 * 60 * 1000;
const SHARE_UNLOCK_MAX_FAILURES = 5;
const SHARE_PASSWORD_KEY_LENGTH = 64;
const DUMMY_PASSWORD_SALT = "00000000000000000000000000000000";
const DASHSCOPE_MULTIMODAL_URL = "https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation";
const DASHSCOPE_ASR_URL = "https://dashscope.aliyuncs.com/api/v1/services/audio/asr/transcription";
const DASHSCOPE_TASK_URL = "https://dashscope.aliyuncs.com/api/v1/tasks";
const IMAGE_CAPTION_PROMPT = `你是一名音乐创作策划。请理解用户上传的图片，并将其转换为可直接输入 AI 作曲模型的音乐创作 Caption。

你的任务不是简单描述图片内容，而是提取其中适合音乐创作的信息，包括：

- 核心场景；
- 主要情绪；
- 可能的故事主题；
- 音乐风格；
- 速度与能量；
- 配器方向；
- 歌词意象。

## 规则

1. 只能基于图片可见内容分析，不要虚构人物身份、地点或真实背景。
2. 可以做合理的情绪和故事联想，但不要写成确定事实。
3. 不要输出精确 BPM、调式、和弦等复杂乐理。
4. 不要指定模仿具体歌手、乐队或歌曲。
5. 音乐风格、情绪、速度和配器需要保持一致。
6. 图片内容较少时，优先分析色彩、光影、构图和氛围，不要强行编造故事。
7. 图片含有文字时，可提取其中最核心的表达作为歌曲主题或歌词灵感。

## 输出格式

严格输出合法 JSON，不要输出额外解释或 Markdown 代码块。

{
  "visual_summary": "图片核心画面，一句话概括",
  "story_inspiration": "适合歌曲表达的故事或主题",
  "mood": ["情绪1", "情绪2", "情绪3"],
  "energy": "低 / 中低 / 中 / 中高 / 高",
  "tempo_feel": "慢速 / 中慢速 / 中速 / 中速偏快 / 快速",
  "music_style": ["风格1", "风格2"],
  "instrumentation": ["配器1", "配器2", "配器3"],
  "vocal_direction": "适合的演唱情绪；若更适合纯音乐则填写纯音乐",
  "lyric_keywords": ["关键词1", "关键词2", "关键词3", "关键词4"],
  "music_caption": "可直接输入作曲模型的中文音乐指令"
}

## music_caption 要求

- 80～150 个汉字；
- 包含主题、情绪、风格、速度感、主要配器和歌曲发展；
- 不出现字段名称；
- 不解释分析过程；
- 不指定精确 BPM；
- 不模仿具体音乐人；
- 语言简洁、自然，可直接用于生成音乐。`;

fs.mkdirSync(uploadsDir, { recursive: true });
fs.mkdirSync(dataDir, { recursive: true });
fs.mkdirSync(path.dirname(sharesFile), { recursive: true });

app.set("trust proxy", 1);
app.use(express.json({ limit: "25mb" }));

app.get("/health", (_req, res) => {
  res.status(200).json({ status: "ok" });
});

app.use("/uploads", express.static(uploadsDir));
app.use(express.static(__dirname));

function readShares() {
  try {
    return JSON.parse(fs.readFileSync(sharesFile, "utf8"));
  } catch {
    return {};
  }
}

function writeShares(shares) {
  fs.writeFileSync(sharesFile, JSON.stringify(shares, null, 2));
}

function publicBaseUrl(req) {
  return process.env.RENDER_EXTERNAL_URL?.replace(/\/$/, "")
    || process.env.PUBLIC_BASE_URL?.replace(/\/$/, "")
    || `${req.protocol}://${req.get("host")}`;
}

function escapeHtml(value = "") {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function randomToken() {
  return crypto.randomBytes(4).toString("hex").slice(0, 6);
}

function scryptAccessCode(accessCode, salt) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(accessCode, salt, SHARE_PASSWORD_KEY_LENGTH, (error, derivedKey) => {
      if (error) reject(error);
      else resolve(derivedKey);
    });
  });
}

async function hashAccessCode(accessCode) {
  const salt = crypto.randomBytes(16).toString("hex");
  const derivedKey = await scryptAccessCode(accessCode, salt);
  return {
    access_code_hash: derivedKey.toString("hex"),
    access_code_salt: salt
  };
}

async function verifyAccessCode(accessCode, share) {
  const salt = /^[a-f0-9]{32}$/i.test(share?.access_code_salt || "")
    ? share.access_code_salt
    : DUMMY_PASSWORD_SALT;
  const expectedHex = /^[a-f0-9]{128}$/i.test(share?.access_code_hash || "")
    ? share.access_code_hash
    : "0".repeat(SHARE_PASSWORD_KEY_LENGTH * 2);
  const [actual, expected] = await Promise.all([
    scryptAccessCode(String(accessCode || ""), salt),
    Promise.resolve(Buffer.from(expectedHex, "hex"))
  ]);
  return crypto.timingSafeEqual(actual, expected);
}

function requireShareSessionSecret() {
  const secret = process.env.SHARE_SESSION_SECRET || "";
  if (secret.length < 32) {
    const error = new Error("服务端未配置有效的 SHARE_SESSION_SECRET（至少 32 个字符）");
    error.status = 500;
    throw error;
  }
  return secret;
}

function unlockCookieName(token) {
  const tokenHash = crypto.createHash("sha256").update(String(token)).digest("hex").slice(0, 16);
  return `melodyflow_share_${tokenHash}`;
}

function unlockCookieSignature(token, expiresAt, secret) {
  return crypto
    .createHmac("sha256", secret)
    .update(`${token}.${expiresAt}`)
    .digest("base64url");
}

function createUnlockCookieValue(token, expiresAt, secret) {
  return `${expiresAt}.${unlockCookieSignature(token, expiresAt, secret)}`;
}

function parseCookies(cookieHeader = "") {
  return String(cookieHeader)
    .split(";")
    .reduce((cookies, item) => {
      const separatorIndex = item.indexOf("=");
      if (separatorIndex < 0) return cookies;
      const name = item.slice(0, separatorIndex).trim();
      const value = item.slice(separatorIndex + 1).trim();
      if (name) cookies[name] = value;
      return cookies;
    }, {});
}

function hasValidUnlockCookie(req, token, now = Date.now()) {
  let secret;
  try {
    secret = requireShareSessionSecret();
  } catch {
    return false;
  }
  const value = parseCookies(req.headers.cookie)[unlockCookieName(token)] || "";
  const [expiresAtText, signature = ""] = value.split(".");
  const expiresAt = Number(expiresAtText);
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= now) return false;
  const expected = unlockCookieSignature(token, expiresAt, secret);
  const actualBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);
  return actualBuffer.length === expectedBuffer.length
    && crypto.timingSafeEqual(actualBuffer, expectedBuffer);
}

function isPasswordProtected(share) {
  return share?.access_type === SHARE_ACCESS_TYPE_PASSWORD;
}

function publicShare(share) {
  const {
    access_code: _legacyAccessCode,
    access_code_hash: _accessCodeHash,
    access_code_salt: _accessCodeSalt,
    ...safeShare
  } = share;
  return {
    ...safeShare,
    requiresPassword: isPasswordProtected(share)
  };
}

function unlockAttemptKey(req, token) {
  return `${req.ip || req.socket.remoteAddress || "unknown"}|${token}`;
}

function activeUnlockAttempt(req, token, now = Date.now()) {
  const key = unlockAttemptKey(req, token);
  const attempt = unlockAttempts.get(key);
  if (!attempt || now - attempt.startedAt >= SHARE_UNLOCK_WINDOW_MS) {
    unlockAttempts.delete(key);
    return null;
  }
  return attempt;
}

function recordUnlockFailure(req, token, now = Date.now()) {
  const key = unlockAttemptKey(req, token);
  const current = activeUnlockAttempt(req, token, now);
  unlockAttempts.set(key, current
    ? { ...current, failures: current.failures + 1 }
    : { failures: 1, startedAt: now });
}

function clearUnlockFailures(req, token) {
  unlockAttempts.delete(unlockAttemptKey(req, token));
}

function makePasswordPage(token) {
  const unlockUrl = `/api/shares/${encodeURIComponent(token)}/unlock`;
  return `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>请输入访问密码 - MelodyFlow</title>
    <style>
      * { box-sizing: border-box; }
      body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 24px; color: #101223; background: radial-gradient(circle at 78% 8%, rgba(121,72,255,.12), transparent 34%), linear-gradient(135deg,#fbfbfe,#f1f2f8); font-family: ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif; }
      .card { width: min(390px, 100%); padding: 34px 30px; background: #fff; border: 1px solid #e7e8f0; border-radius: 22px; box-shadow: 0 24px 60px rgba(35,32,69,.14); }
      .lock { display: grid; width: 54px; height: 54px; margin-bottom: 22px; place-items: center; color: #7048ff; background: #efeaff; border-radius: 16px; font-size: 25px; }
      h1 { margin: 0 0 10px; font-size: 26px; }
      p { margin: 0 0 24px; color: #697082; line-height: 1.6; }
      label { display: grid; gap: 8px; color: #4f5668; font-size: 14px; }
      input { width: 100%; min-height: 48px; padding: 11px 13px; color: #202334; background: #fff; border: 1px solid #dfe1ea; border-radius: 10px; outline: none; font: inherit; }
      input:focus { border-color: #7048ff; box-shadow: 0 0 0 3px rgba(112,72,255,.12); }
      button { width: 100%; min-height: 48px; margin-top: 14px; color: #fff; background: linear-gradient(135deg,#7048ff,#935cff); border: 0; border-radius: 10px; font: inherit; font-weight: 760; cursor: pointer; }
      button:disabled { cursor: wait; opacity: .68; }
      .message { min-height: 20px; margin: 12px 0 0; color: #d64242; font-size: 14px; }
    </style>
  </head>
  <body>
    <main class="card">
      <div class="lock" aria-hidden="true">🔒</div>
      <h1>这个分享需要密码</h1>
      <p>请输入分享人提供的访问密码，验证后 24 小时内无需再次输入。</p>
      <form id="unlockForm">
        <label>访问密码
          <input id="accessCode" type="password" minlength="4" maxlength="12" autocomplete="current-password" required autofocus />
        </label>
        <button id="submitButton" type="submit">解锁并试听</button>
        <div id="message" class="message" role="alert"></div>
      </form>
    </main>
    <script>
      const form = document.getElementById("unlockForm");
      const accessCode = document.getElementById("accessCode");
      const submitButton = document.getElementById("submitButton");
      const message = document.getElementById("message");
      form.addEventListener("submit", async (event) => {
        event.preventDefault();
        message.textContent = "";
        submitButton.disabled = true;
        submitButton.textContent = "正在验证…";
        try {
          const response = await fetch(${JSON.stringify(unlockUrl)}, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ accessCode: accessCode.value })
          });
          const body = await response.json().catch(() => ({}));
          if (!response.ok) throw new Error(body.message || "验证失败，请稍后重试");
          window.location.reload();
        } catch (error) {
          message.textContent = error.message;
          accessCode.select();
        } finally {
          submitButton.disabled = false;
          submitButton.textContent = "解锁并试听";
        }
      });
    </script>
  </body>
</html>`;
}

function makeSharePage(share, shareUrl) {
  const title = escapeHtml(share.title || "未命名 Demo");
  const inspiration = escapeHtml(share.inspiration || "来自一段灵感创作");
  const lyrics = escapeHtml(share.lyrics || "暂无歌词").replace(/\n+/g, "<br>");
  const creatorName = escapeHtml(share.creatorName || "Echo");
  const creatorRole = escapeHtml(share.creatorRole || "独立音乐人");
  const createdAt = escapeHtml(share.createdAt || "");
  const source = escapeHtml(share.source || "文字＋哼唱灵感");
  const styleTags = (share.styleTags || []).slice(0, 4).map((tag) => `<span>${escapeHtml(tag)}</span>`).join("");
  const audioUrl = escapeHtml(share.audioUrl || "");
  const heroStyle = share.heroImageUrl ? ` style="background-image:url('${escapeHtml(share.heroImageUrl)}')"` : "";
  const heroClass = share.heroImageUrl ? "hero has-image" : "hero";

  return `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${title} - MelodyFlow</title>
    <style>
      * { box-sizing: border-box; }
      body {
        margin: 0;
        min-height: 100vh;
        color: #101223;
        background: linear-gradient(180deg, #fbfbff, #f1f2f8);
        font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
      }
      .page { max-width: 520px; margin: 0 auto; padding: 18px 14px 28px; }
      .card { overflow: hidden; background: #fff; border: 1px solid #e7e8f0; border-radius: 28px; box-shadow: 0 24px 60px rgba(35, 32, 69, .14); }
      .hero {
        display: grid;
        min-height: 260px;
        padding: 22px;
        align-content: start;
        background: linear-gradient(135deg, #f7f7fb, #eceef6);
        border-bottom: 1px solid #ececf4;
      }
      .hero.has-image { background-position: center; background-size: cover; }
      .empty-hero {
        display: grid;
        min-height: 218px;
        place-items: center;
        color: #858ba0;
        border: 1px dashed rgba(120, 120, 145, .34);
        border-radius: 20px;
        background: rgba(255,255,255,.48);
      }
      .version { justify-self: end; padding: 8px 14px; color: #7048ff; background: rgba(255,255,255,.88); border-radius: 14px; font-weight: 800; }
      .content { padding: 24px 22px 0; }
      h1 { margin: 0 0 12px; font-size: 34px; line-height: 1.08; letter-spacing: 0; }
      .tags { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 22px; }
      .tags span { padding: 7px 12px; color: #626879; background: #f1f0f6; border-radius: 10px; font-size: 14px; }
      audio { width: 100%; margin: 4px 0 20px; }
      .info { display: grid; gap: 16px; padding: 18px 0; border-top: 1px dashed #e1e2eb; border-bottom: 1px dashed #e1e2eb; color: #565d70; line-height: 1.65; }
      .lyrics { padding: 18px 0 22px; color: #333849; line-height: 1.8; }
      .creator { display: flex; align-items: center; gap: 14px; padding: 0 0 22px; }
      .avatar { width: 54px; height: 54px; border-radius: 50%; background: linear-gradient(135deg, #9be8dc, #222947); }
      .creator strong, .creator span { display: block; }
      .creator span { margin-top: 4px; color: #6b7284; }
      .footer { display: flex; align-items: center; justify-content: space-between; gap: 14px; padding: 18px 22px 20px; color: #6d7386; background: #f7f7fb; }
      .brand { color: #7048ff; font-weight: 800; }
      .copy { width: 100%; min-height: 48px; margin: 18px 0 0; color: #fff; background: #7048ff; border: 0; border-radius: 12px; font-size: 16px; font-weight: 760; }
      .error { min-height: 100vh; display: grid; place-items: center; padding: 24px; text-align: center; color: #555c70; }
      @media (max-width: 420px) {
        .page { padding: 0; }
        .card { min-height: 100vh; border-radius: 0; border: 0; }
        .hero { min-height: 235px; }
        h1 { font-size: 30px; }
      }
    </style>
  </head>
  <body>
    <main class="page">
      <section class="card">
        <div class="${heroClass}"${heroStyle}>
          <span class="version">${escapeHtml(share.versionLabel || "v1")}</span>
          ${share.heroImageUrl ? "" : '<div class="empty-hero">顶部图片留空，可配置插入</div>'}
        </div>
        <div class="content">
          <h1>${title}</h1>
          <div class="tags">${styleTags}</div>
          ${audioUrl ? `<audio controls preload="metadata" src="${audioUrl}"></audio>` : '<div class="info">音频不存在或已失效</div>'}
          <div class="info">
            <div>${inspiration}</div>
            <div>创作来源：${source}</div>
          </div>
          <div class="lyrics">${lyrics}</div>
          <div class="creator">
            <span class="avatar"></span>
            <span><strong>${creatorName}</strong><span>${creatorRole}</span></span>
          </div>
          <button class="copy" data-link="${escapeHtml(shareUrl)}">复制链接</button>
        </div>
        <footer class="footer">
          <span class="brand">MelodyFlow</span>
          <span>AI 灵感成歌 · ${createdAt}</span>
        </footer>
      </section>
    </main>
    <script>
      document.querySelector(".copy").addEventListener("click", async (event) => {
        const link = event.currentTarget.dataset.link;
        try {
          await navigator.clipboard.writeText(link);
          event.currentTarget.textContent = "已复制";
        } catch {
          event.currentTarget.textContent = link;
        }
      });
    </script>
  </body>
</html>`;
}

function requireApiKey() {
  if (!process.env.SUNO_API_KEY) {
    const error = new Error("服务端未配置 SUNO_API_KEY");
    error.status = 500;
    throw error;
  }
  return process.env.SUNO_API_KEY;
}

function requireDashScopeApiKey() {
  if (!process.env.DASHSCOPE_API_KEY) {
    const error = new Error("服务端未配置 DASHSCOPE_API_KEY");
    error.status = 500;
    throw error;
  }
  return process.env.DASHSCOPE_API_KEY;
}

function parseJsonText(text) {
  const clean = String(text || "").trim().replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/```$/i, "").trim();
  try {
    return JSON.parse(clean);
  } catch {
    const match = clean.match(/\{[\s\S]*\}/);
    if (!match) throw new Error("图片理解模型没有返回合法 JSON");
    return JSON.parse(match[0]);
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function audioExtension(mimeType = "") {
  if (mimeType.includes("wav")) return "wav";
  if (mimeType.includes("mpeg") || mimeType.includes("mp3")) return "mp3";
  if (mimeType.includes("ogg")) return "ogg";
  if (mimeType.includes("mp4") || mimeType.includes("m4a")) return "m4a";
  return "webm";
}

function saveAudioDataUrl({ audioBase64, mimeType, prefix }) {
  const cleanBase64 = String(audioBase64 || "").includes(",") ? String(audioBase64).split(",").pop() : audioBase64;
  const audioBuffer = Buffer.from(cleanBase64 || "", "base64");
  if (!audioBuffer.length) {
    const error = new Error("录音内容为空");
    error.status = 400;
    throw error;
  }
  if (audioBuffer.length > 20 * 1024 * 1024) {
    const error = new Error("录音文件过大，请控制在 20MB 以内");
    error.status = 413;
    throw error;
  }
  const filename = `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}.${audioExtension(mimeType)}`;
  const filePath = path.join(uploadsDir, filename);
  fs.writeFileSync(filePath, audioBuffer);
  return filename;
}

async function submitAsrTask(fileUrl) {
  const response = await fetch(DASHSCOPE_ASR_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${requireDashScopeApiKey()}`,
      "Content-Type": "application/json",
      "X-DashScope-Async": "enable"
    },
    body: JSON.stringify({
      model: "fun-asr",
      input: { file_urls: [fileUrl] },
      parameters: { channel_id: [0] }
    })
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body.code) {
    const error = new Error(body.message || body.msg || `DashScope 语音识别任务提交失败：${response.status}`);
    error.status = response.status >= 400 ? response.status : 502;
    error.details = body;
    throw error;
  }
  return body.output?.task_id;
}

async function fetchAsrTask(taskId) {
  const response = await fetch(`${DASHSCOPE_TASK_URL}/${encodeURIComponent(taskId)}`, {
    headers: { Authorization: `Bearer ${requireDashScopeApiKey()}` }
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body.code) {
    const error = new Error(body.message || body.msg || `DashScope 语音识别任务查询失败：${response.status}`);
    error.status = response.status >= 400 ? response.status : 502;
    error.details = body;
    throw error;
  }
  return body.output || {};
}

async function readTranscriptionText(transcriptionUrl) {
  const response = await fetch(transcriptionUrl);
  if (!response.ok) throw new Error(`语音识别结果下载失败：${response.status}`);
  const body = await response.json();
  return (body.transcripts || [])
    .map((transcript) => transcript.text)
    .filter(Boolean)
    .join("\n")
    .trim();
}

async function sunoFetch(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${requireApiKey()}`,
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...(options.headers || {})
    }
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body.code !== 200) {
    const error = new Error(body.msg || `Suno API 请求失败：${response.status}`);
    error.status = response.status >= 400 ? response.status : 502;
    error.details = body;
    throw error;
  }
  return body;
}

app.post("/api/suno/generate", async (req, res, next) => {
  try {
    const { prompt, title, style, generationType = "lyrics", model = "V5", callbackUrl = "" } = req.body || {};
    const cleanPrompt = String(prompt || "").trim();
    const cleanTitle = String(title || "").trim();
    const cleanStyle = String(style || "").trim();
    const isDescriptionMode = generationType === "description";

    if (!cleanPrompt) return res.status(400).json({ message: isDescriptionMode ? "歌曲描述不能为空" : "歌词不能为空" });
    if (isDescriptionMode && cleanPrompt.length > 500) return res.status(400).json({ message: "歌曲描述最多支持 500 个字符" });
    if (!isDescriptionMode && (!cleanTitle || !cleanStyle)) return res.status(400).json({ message: "歌词、标题和风格不能为空" });

    const publicBaseUrl = process.env.PUBLIC_BASE_URL?.replace(/\/$/, "");
    const effectiveCallback = callbackUrl || (publicBaseUrl ? `${publicBaseUrl}/api/suno/callback` : process.env.SUNO_CALLBACK_URL);
    if (!effectiveCallback) {
      return res.status(400).json({ message: "请填写公网 callbackUrl，或在 .env 配置 PUBLIC_BASE_URL / SUNO_CALLBACK_URL" });
    }

    const payload = {
      customMode: !isDescriptionMode,
      instrumental: false,
      model: model || "V5",
      callBackUrl: effectiveCallback,
      prompt: cleanPrompt
    };
    if (!isDescriptionMode) {
      payload.style = cleanStyle;
      payload.title = cleanTitle;
    }

    const body = await sunoFetch(`${SUNO_BASE_URL}/generate`, {
      method: "POST",
      body: JSON.stringify(payload)
    });
    res.json({ taskId: body.data?.taskId });
  } catch (error) { next(error); }
});

app.post("/api/suno/add-instrumental", async (req, res, next) => {
  try {
    const {
      audioBase64,
      mimeType = "audio/webm",
      durationSeconds = 0,
      title,
      tags,
      negativeTags = "重金属, 激进鼓点, 噪音",
      callbackUrl = "",
      vocalGender,
      styleWeight = 0.61,
      weirdnessConstraint = 0.72,
      audioWeight = 0.65,
      model = "V4_5PLUS"
    } = req.body || {};

    if (!audioBase64 || !title || !tags) {
      return res.status(400).json({ message: "audioBase64、title 和 tags 不能为空" });
    }
    if (Number(durationSeconds) > 0 && Number(durationSeconds) < 12) {
      return res.status(400).json({ message: "哼唱录音太短，请录制至少 12 秒，推荐 15-30 秒" });
    }

    const publicBaseUrl = process.env.PUBLIC_BASE_URL?.replace(/\/$/, "");
    const effectiveCallback = callbackUrl || (publicBaseUrl ? `${publicBaseUrl}/api/suno/callback` : process.env.SUNO_CALLBACK_URL);
    if (!publicBaseUrl) {
      return res.status(400).json({ message: "请在 .env 配置 PUBLIC_BASE_URL，用于公开访问本地录音文件" });
    }
    if (!effectiveCallback) {
      return res.status(400).json({ message: "请填写公网 callbackUrl，或在 .env 配置 PUBLIC_BASE_URL / SUNO_CALLBACK_URL" });
    }

    const filename = saveAudioDataUrl({ audioBase64, mimeType, prefix: "hum" });

    const payload = {
      uploadUrl: `${publicBaseUrl}/uploads/${filename}`,
      title,
      negativeTags,
      tags,
      callBackUrl: effectiveCallback,
      styleWeight: Number(styleWeight),
      weirdnessConstraint: Number(weirdnessConstraint),
      audioWeight: Number(audioWeight),
      model
    };
    if (vocalGender === "m" || vocalGender === "f") payload.vocalGender = vocalGender;

    const body = await sunoFetch(`${SUNO_BASE_URL}/generate/add-instrumental`, {
      method: "POST",
      body: JSON.stringify(payload)
    });
    res.json({ taskId: body.data?.taskId, uploadUrl: payload.uploadUrl });
  } catch (error) { next(error); }
});

app.post("/api/speech/transcribe", async (req, res, next) => {
  try {
    const { audioBase64, mimeType = "audio/webm", durationSeconds = 0 } = req.body || {};
    if (!audioBase64) return res.status(400).json({ message: "audioBase64 不能为空" });
    if (Number(durationSeconds) > 0 && Number(durationSeconds) < 1) {
      return res.status(400).json({ message: "语音太短，请至少口述 1 秒" });
    }

    const baseUrl = publicBaseUrl(req);
    const filename = saveAudioDataUrl({ audioBase64, mimeType, prefix: "speech" });
    const fileUrl = `${baseUrl}/uploads/${filename}`;
    const taskId = await submitAsrTask(fileUrl);
    if (!taskId) throw new Error("语音识别接口未返回 task_id");

    let output = null;
    for (let attempt = 0; attempt < 30; attempt += 1) {
      await sleep(attempt < 2 ? 1000 : 2000);
      output = await fetchAsrTask(taskId);
      if (["SUCCEEDED", "FAILED", "CANCELED"].includes(output.task_status)) break;
    }

    if (!output || output.task_status !== "SUCCEEDED") {
      return res.status(202).json({ taskId, status: output?.task_status || "PENDING", fileUrl, message: "语音识别仍在处理中，请稍后重试" });
    }

    const result = output.results?.find((item) => item.subtask_status === "SUCCEEDED" && item.transcription_url);
    if (!result) {
      const failed = output.results?.find((item) => item.subtask_status === "FAILED");
      return res.status(502).json({ message: failed?.message || "语音识别失败", taskId, status: output.task_status });
    }

    const text = await readTranscriptionText(result.transcription_url);
    if (!text) return res.status(502).json({ message: "语音识别结果为空", taskId, status: output.task_status });
    res.json({ text, taskId, status: output.task_status, fileUrl });
  } catch (error) { next(error); }
});

app.get("/api/suno/tasks/:taskId", async (req, res, next) => {
  try {
    const taskId = req.params.taskId;
    const query = new URLSearchParams({ taskId });
    const body = await sunoFetch(`${SUNO_BASE_URL}/generate/record-info?${query}`);
    const data = body.data || {};
    const tracks = (data.response?.sunoData || []).map(track => ({
      id: track.id,
      audioUrl: track.audioUrl,
      streamAudioUrl: track.streamAudioUrl,
      imageUrl: track.imageUrl,
      prompt: track.prompt,
      title: track.title,
      tags: track.tags,
      createTime: track.createTime,
      duration: track.duration
    }));
    res.json({
      taskId: data.taskId,
      status: data.status,
      errorCode: data.errorCode,
      errorMessage: data.errorMessage,
      tracks,
      callback: callbackCache.get(taskId) || null
    });
  } catch (error) { next(error); }
});

app.post("/api/suno/timestamped-lyrics", async (req, res, next) => {
  try {
    const { taskId, audioId } = req.body || {};
    if (!taskId || !audioId) return res.status(400).json({ message: "taskId 和 audioId 不能为空" });

    const body = await sunoFetch(`${SUNO_BASE_URL}/generate/get-timestamped-lyrics`, {
      method: "POST",
      body: JSON.stringify({ taskId, audioId })
    });

    res.json({
      alignedWords: body.data?.alignedWords || [],
      waveformData: body.data?.waveformData || [],
      hootCer: body.data?.hootCer,
      isStreamed: body.data?.isStreamed
    });
  } catch (error) { next(error); }
});

app.post("/api/image-caption", async (req, res, next) => {
  try {
    const { imageDataUrl } = req.body || {};
    if (!imageDataUrl || !/^data:image\/(jpeg|jpg|png|webp);base64,/i.test(imageDataUrl)) {
      return res.status(400).json({ message: "请上传 jpg、png 或 webp 图片" });
    }
    if (Buffer.byteLength(imageDataUrl, "utf8") > 8 * 1024 * 1024) {
      return res.status(413).json({ message: "图片过大，请上传 6MB 以内图片" });
    }

    const response = await fetch(DASHSCOPE_MULTIMODAL_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${requireDashScopeApiKey()}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: "qwen3.7-flash",
        input: {
          messages: [
            { role: "system", content: IMAGE_CAPTION_PROMPT },
            {
              role: "user",
              content: [
                { image: imageDataUrl },
                { text: "请基于这张图片输出符合要求的音乐创作 JSON。" }
              ]
            }
          ]
        }
      })
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok || body.code) {
      const error = new Error(body.message || body.msg || `DashScope 图片理解失败：${response.status}`);
      error.status = response.status >= 400 ? response.status : 502;
      error.details = body;
      throw error;
    }
    const content = body.output?.choices?.[0]?.message?.content;
    const text = Array.isArray(content) ? content.find((item) => item.text)?.text : content;
    const caption = parseJsonText(text);
    if (!caption.music_caption) throw new Error("图片理解结果缺少 music_caption");
    res.json({ caption, rawText: text });
  } catch (error) { next(error); }
});

app.post("/api/suno/callback", (req, res) => {
  const payload = req.body || {};
  const taskId = payload.data?.task_id;
  if (taskId) callbackCache.set(taskId, payload);
  res.status(200).json({ status: "received" });
});

app.post("/api/shares", async (req, res, next) => {
  try {
    const {
      title,
      inspiration,
      lyrics,
      source,
      creatorName = "Echo",
      creatorRole = "独立音乐人",
      audioUrl,
      styleTags = [],
      versionLabel,
      heroImageUrl = "",
      accessType = SHARE_ACCESS_TYPE_PUBLIC,
      accessCode: rawAccessCode = ""
    } = req.body || {};

    if (!title || !audioUrl) return res.status(400).json({ message: "title 和 audioUrl 不能为空" });
    if (![SHARE_ACCESS_TYPE_PUBLIC, SHARE_ACCESS_TYPE_PASSWORD].includes(accessType)) {
      return res.status(400).json({ message: "accessType 仅支持 public_link 或 password" });
    }
    const accessCode = String(rawAccessCode).trim();
    const accessCodeLength = Array.from(accessCode).length;
    if (accessType === SHARE_ACCESS_TYPE_PASSWORD && (accessCodeLength < 4 || accessCodeLength > 12)) {
      return res.status(400).json({ message: "访问密码长度必须为 4–12 个字符" });
    }
    if (accessType === SHARE_ACCESS_TYPE_PASSWORD) requireShareSessionSecret();

    const shares = readShares();
    const variants = [
      { name: "简洁试听", inspiration },
      { name: "灵感卡片", inspiration: inspiration || "来自一段文字、图片和哼唱灵感" },
      { name: "歌词优先", inspiration: lyrics ? lyrics.split(/\n+/).find(Boolean) : inspiration }
    ];

    const candidates = [];
    for (const variant of variants) {
      let token = randomToken();
      while (shares[token]) token = randomToken();
      const protectedCredentials = accessType === SHARE_ACCESS_TYPE_PASSWORD
        ? await hashAccessCode(accessCode)
        : {};
      const share = {
        token,
        template: variant.name,
        access_type: accessType,
        ...protectedCredentials,
        is_active: true,
        title,
        inspiration: variant.inspiration || "来自一段灵感创作",
        lyrics: lyrics || "",
        source: source || "文字＋哼唱灵感",
        creatorName,
        creatorRole,
        audioUrl,
        styleTags: Array.isArray(styleTags) ? styleTags : String(styleTags).split(",").map((item) => item.trim()).filter(Boolean),
        versionLabel,
        heroImageUrl,
        createdAt: new Date().toISOString()
      };
      shares[token] = share;
      candidates.push({
        token,
        template: variant.name,
        url: `${publicBaseUrl(req)}/s/${token}`,
        previewUrl: `/s/${token}`,
        requiresPassword: isPasswordProtected(share),
        preview: {
          title: share.title,
          inspiration: share.inspiration,
          styleTags: share.styleTags,
          versionLabel: share.versionLabel
        }
      });
    }

    writeShares(shares);
    res.json({ candidates });
  } catch (error) { next(error); }
});

app.get("/api/shares/:token", (req, res) => {
  const share = readShares()[req.params.token];
  if (!share) return res.status(404).json({ message: "分享链接不存在" });
  if (!share.is_active) return res.status(410).json({ message: "分享已关闭" });
  if (!share.audioUrl) return res.status(404).json({ message: "音频不存在" });
  if (isPasswordProtected(share) && !hasValidUnlockCookie(req, req.params.token)) {
    return res.status(401).json({ message: "需要访问密码", requiresPassword: true });
  }
  res.json({ share: publicShare(share) });
});

app.post("/api/shares/:token/unlock", async (req, res, next) => {
  try {
    const token = req.params.token;
    const attempt = activeUnlockAttempt(req, token);
    if (attempt?.failures >= SHARE_UNLOCK_MAX_FAILURES) {
      return res.status(429).json({ message: "尝试次数过多，请 10 分钟后再试" });
    }

    const share = readShares()[token];
    const accessCode = String(req.body?.accessCode || "").slice(0, 128);
    const isUnlockable = Boolean(
      share
      && share.is_active
      && share.audioUrl
      && isPasswordProtected(share)
    );
    const passwordMatches = await verifyAccessCode(accessCode, isUnlockable ? share : null);
    if (!isUnlockable || !passwordMatches) {
      recordUnlockFailure(req, token);
      return res.status(401).json({ message: "密码错误或分享不可用" });
    }

    const secret = requireShareSessionSecret();
    const expiresAt = Date.now() + SHARE_UNLOCK_TTL_MS;
    res.cookie(unlockCookieName(token), createUnlockCookieValue(token, expiresAt, secret), {
      httpOnly: true,
      sameSite: "lax",
      secure: req.secure,
      maxAge: SHARE_UNLOCK_TTL_MS,
      path: "/"
    });
    clearUnlockFailures(req, token);
    res.json({ unlocked: true });
  } catch (error) { next(error); }
});

app.get("/s/:token", (req, res) => {
  const share = readShares()[req.params.token];
  if (!share || !share.is_active || !share.audioUrl) {
    return res.status(!share ? 404 : share.is_active ? 404 : 410).send(`<!doctype html>
<html lang="zh-CN"><head><meta charset="UTF-8" /><meta name="viewport" content="width=device-width, initial-scale=1.0" /><title>分享不可用</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px;color:#555c70;background:#f7f7fb;font-family:ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif}.box{max-width:360px;text-align:center;background:#fff;border:1px solid #e7e8f0;border-radius:16px;padding:28px;box-shadow:0 18px 42px rgba(35,32,69,.1)}h1{margin:0 0 10px;color:#101223;font-size:24px}</style></head>
<body><div class="box"><h1>分享不可用</h1><p>${!share ? "Token 无效，找不到这个分享。" : share.is_active ? "音频不存在或已失效。" : "这个分享已被关闭。"}</p></div></body></html>`);
  }
  if (isPasswordProtected(share) && !hasValidUnlockCookie(req, req.params.token)) {
    return res.type("html").send(makePasswordPage(req.params.token));
  }
  res.type("html").send(makeSharePage(share, `${publicBaseUrl(req)}/s/${share.token}`));
});

app.use((error, req, res, next) => {
  console.error(error);
  res.status(error.status || 500).json({
    message: error.message || "服务器错误",
    details: process.env.NODE_ENV === "development" ? error.details : undefined
  });
});

if (require.main === module) {
  app.listen(PORT, () => console.log(`MelodyFlow 已启动：http://localhost:${PORT}`));
}

module.exports = {
  app,
  createUnlockCookieValue,
  unlockCookieName
};
