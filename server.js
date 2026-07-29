const express = require("express");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
require("dotenv").config();

const app = express();
const PORT = process.env.PORT || 3000;
const SUNO_BASE_URL = "https://api.sunoapi.org/api/v1";
const callbackCache = new Map();
const uploadsDir = path.join(__dirname, "uploads");
const dataDir = path.join(__dirname, "data");
const sharesFile = path.join(dataDir, "shares.json");

fs.mkdirSync(uploadsDir, { recursive: true });
fs.mkdirSync(dataDir, { recursive: true });

app.use(express.json({ limit: "25mb" }));
app.use("/uploads", express.static(uploadsDir, {
  dotfiles: "deny",
  index: false
}));

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

app.get("/health", (req, res) => {
  res.json({ status: "ok" });
});

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

function configuredBaseUrl() {
  return (process.env.PUBLIC_BASE_URL || process.env.RENDER_EXTERNAL_URL || "").replace(/\/$/, "");
}

function publicBaseUrl(req) {
  return configuredBaseUrl() || `${req.protocol}://${req.get("host")}`;
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

    const baseUrl = configuredBaseUrl();
    const effectiveCallback = callbackUrl || (baseUrl ? `${baseUrl}/api/suno/callback` : process.env.SUNO_CALLBACK_URL);
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

    const baseUrl = configuredBaseUrl();
    const effectiveCallback = callbackUrl || (baseUrl ? `${baseUrl}/api/suno/callback` : process.env.SUNO_CALLBACK_URL);
    if (!baseUrl) {
      return res.status(400).json({ message: "请配置 PUBLIC_BASE_URL；在 Render 上会自动使用 RENDER_EXTERNAL_URL" });
    }
    if (!effectiveCallback) {
      return res.status(400).json({ message: "请填写公网 callbackUrl，或在 .env 配置 PUBLIC_BASE_URL / SUNO_CALLBACK_URL" });
    }

    const cleanBase64 = audioBase64.includes(",") ? audioBase64.split(",").pop() : audioBase64;
    const audioBuffer = Buffer.from(cleanBase64, "base64");
    if (!audioBuffer.length) return res.status(400).json({ message: "录音内容为空" });
    if (audioBuffer.length > 20 * 1024 * 1024) return res.status(413).json({ message: "录音文件过大，请控制在 20MB 以内" });

    const extension = mimeType.includes("wav") ? "wav" : mimeType.includes("mpeg") || mimeType.includes("mp3") ? "mp3" : "webm";
    const filename = `hum-${Date.now()}-${Math.random().toString(16).slice(2)}.${extension}`;
    const filePath = path.join(uploadsDir, filename);
    fs.writeFileSync(filePath, audioBuffer);

    const payload = {
      uploadUrl: `${baseUrl}/uploads/${filename}`,
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

app.post("/api/suno/callback", (req, res) => {
  const payload = req.body || {};
  const taskId = payload.data?.task_id;
  if (taskId) callbackCache.set(taskId, payload);
  res.status(200).json({ status: "received" });
});

app.post("/api/shares", (req, res, next) => {
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
      heroImageUrl = ""
    } = req.body || {};

    if (!title || !audioUrl) return res.status(400).json({ message: "title 和 audioUrl 不能为空" });

    const shares = readShares();
    const variants = [
      { name: "简洁试听", inspiration },
      { name: "灵感卡片", inspiration: inspiration || "来自一段文字、图片和哼唱灵感" },
      { name: "歌词优先", inspiration: lyrics ? lyrics.split(/\n+/).find(Boolean) : inspiration }
    ];

    const candidates = variants.map((variant) => {
      let token = randomToken();
      while (shares[token]) token = randomToken();
      const share = {
        token,
        template: variant.name,
        access_type: "public_link",
        access_code: null,
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
      return {
        token,
        template: variant.name,
        url: `${publicBaseUrl(req)}/s/${token}`,
        preview: {
          title: share.title,
          inspiration: share.inspiration,
          styleTags: share.styleTags,
          versionLabel: share.versionLabel
        }
      };
    });

    writeShares(shares);
    res.json({ candidates });
  } catch (error) { next(error); }
});

app.get("/api/shares/:token", (req, res) => {
  const share = readShares()[req.params.token];
  if (!share) return res.status(404).json({ message: "分享链接不存在" });
  if (!share.is_active) return res.status(410).json({ message: "分享已关闭" });
  if (!share.audioUrl) return res.status(404).json({ message: "音频不存在" });
  res.json({ share });
});

app.get("/s/:token", (req, res) => {
  const share = readShares()[req.params.token];
  if (!share || !share.is_active || !share.audioUrl) {
    return res.status(!share ? 404 : share.is_active ? 404 : 410).send(`<!doctype html>
<html lang="zh-CN"><head><meta charset="UTF-8" /><meta name="viewport" content="width=device-width, initial-scale=1.0" /><title>分享不可用</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px;color:#555c70;background:#f7f7fb;font-family:ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif}.box{max-width:360px;text-align:center;background:#fff;border:1px solid #e7e8f0;border-radius:16px;padding:28px;box-shadow:0 18px 42px rgba(35,32,69,.1)}h1{margin:0 0 10px;color:#101223;font-size:24px}</style></head>
<body><div class="box"><h1>分享不可用</h1><p>${!share ? "Token 无效，找不到这个分享。" : share.is_active ? "音频不存在或已失效。" : "这个分享已被关闭。"}</p></div></body></html>`);
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

app.listen(PORT, () => console.log(`MelodyFlow 已启动：http://localhost:${PORT}`));
