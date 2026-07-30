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
const profileFile = process.env.PROFILE_FILE || path.join(dataDir, "profile.json");
const shareImagesDir = process.env.SHARE_IMAGES_DIR
  || path.join(__dirname, "分享图打包");
const avatarImagesDir = process.env.AVATAR_IMAGES_DIR
  || path.join(__dirname, "头像打包");
const SHARE_ACCESS_TYPE_PUBLIC = "public_link";
const SHARE_ACCESS_TYPE_PASSWORD = "password";
const PROFILE_ROLE = "独立音乐人";
const DEFAULT_PROFILE_NAME = "Echo";
const SHARE_UNLOCK_TTL_MS = 24 * 60 * 60 * 1000;
const SHARE_UNLOCK_WINDOW_MS = 10 * 60 * 1000;
const SHARE_UNLOCK_MAX_FAILURES = 5;
const SHARE_PASSWORD_KEY_LENGTH = 64;
const DUMMY_PASSWORD_SALT = "00000000000000000000000000000000";
const SHARE_IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".webp"]);
const DASHSCOPE_MULTIMODAL_URL = "https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation";
const DASHSCOPE_ASR_URL = "https://dashscope.aliyuncs.com/api/v1/services/audio/asr/transcription";
const DASHSCOPE_TASK_URL = "https://dashscope.aliyuncs.com/api/v1/tasks";
const DASHSCOPE_COMPAT_CHAT_URL = "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions";
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
const NO_INSPIRATION_PROMPT = `# 无灵感做歌 Prompt 生成

你是一名音乐创作策划。请根据用户对以下三个问题的选择，生成一段可直接输入音乐生成模型的做歌提示词：

1. 窗外的环境与氛围；
2. 用户当前的行为或状态；
3. 用户希望音乐带来的“解药”。

## 生成要求

- 综合三个选项，不要机械拼接选项原文。
- 将环境转化为歌曲的画面、情绪和空间感。
- 将当前状态转化为速度、律动和情绪浓度。
- 将“解药”转化为音乐风格、主要配器和听感方向。
- 当选项之间存在冲突时，以第三个问题确定核心风格，前两个问题作为氛围和节奏补充。
- 不指定具体歌手、乐队或歌曲。
- 不输出精确 BPM、调式或和弦。
- 语言自然、简洁、有画面感。

## 输出格式

严格输出合法 JSON，不要输出额外解释。

{
  "theme": "歌曲主题，20字以内",
  "mood": ["情绪1", "情绪2", "情绪3"],
  "music_style": ["主要风格", "辅助风格"],
  "instrumentation": ["配器1", "配器2", "配器3"],
  "music_prompt": "可直接输入音乐生成模型的中文提示词"
}

## music_prompt 要求

- 控制在 80～150 个汉字；
- 包含场景、情绪、速度感、风格、主要配器和段落发展；
- 主歌与副歌要有清晰的情绪变化；
- 不解释生成过程；
- 不重复罗列用户选择。`;
const SONG_ANALYSIS_PROMPT = `# 歌曲解读与推荐语生成

你是一名专业的音乐编辑。请结合输入的歌曲音频和完整歌词，对歌曲进行简洁、准确的结构化解读。

## 输入

- 歌曲音频：MP3
- 完整歌词：文本
- 歌曲名称：可能为空
- 创作者名称：可能为空

## 任务

请完成以下分析：

1. **流派**：判断歌曲最主要的音乐流派，可补充一个次要流派。
2. **内容**：结合歌词概括歌曲表达的主题、故事和核心情绪。
3. **BPM**：根据音频估计歌曲速度，输出整数；无法稳定判断时给出合理区间。
4. **配乐**：识别最突出的主要乐器、音色或编曲元素。
5. **推荐语**：基于以上解读生成三句不同的分享卡片推荐语。

## 判断原则

- 音乐流派、BPM和配乐以音频听感为主，歌词仅作辅助。
- 歌曲内容以歌词为主，并结合演唱情绪和音乐氛围。
- 不要因为出现电子音色就直接判断为电子音乐。
- 不要因为使用吉他就直接判断为摇滚或民谣。
- 只输出歌曲中明显存在的主要配器，不要罗列不确定的乐器。
- BPM允许估计，但不要伪装成精确检测结果。
- 信息不足时应降低结论强度，不要虚构。
- 不要提及具体歌手或使用“像某某歌手”的表达。
- 解读应简洁，适合直接展示在歌曲分享卡片中。

## 推荐语要求

- 每句最多13个汉字，标点也计入长度。
- 输出三句，彼此不能只是同义替换，要分别突出不同卖点。
- 不直接复述歌名。
- 不使用“这是一首”“带你感受”“值得一听”等模板化表达。
- 优先突出歌曲最鲜明的情绪、画面或记忆点。
- 表达自然、有画面感，适合吸引用户点击试听。
- 不要夸大歌曲内容，也不要引入歌词中不存在的信息。
- 三句分别建议侧重：画面感、情绪记忆点、音乐听感。

## 输出格式

严格输出合法JSON，不要输出解释、Markdown或其他内容。

{
  "primary_genre": "主要流派",
  "secondary_genre": "次要流派，没有则为空字符串",
  "content_summary": "30字以内的歌曲内容概括",
  "mood": ["核心情绪1", "核心情绪2"],
  "bpm": 92,
  "bpm_range": "88-96",
  "bpm_confidence": "high / medium / low",
  "instrumentation": ["主要配器1", "主要配器2", "主要配器3"],
  "arrangement_summary": "30字以内的编曲与听感概括",
  "recommendations": ["13个汉字以内的推荐语1", "13个汉字以内的推荐语2", "13个汉字以内的推荐语3"],
  "recommendation": "13个汉字以内的默认推荐语，取recommendations第一句"
}`;

fs.mkdirSync(uploadsDir, { recursive: true });
fs.mkdirSync(dataDir, { recursive: true });
fs.mkdirSync(path.dirname(sharesFile), { recursive: true });
fs.mkdirSync(path.dirname(profileFile), { recursive: true });

app.set("trust proxy", 1);
app.use(express.json({ limit: "25mb" }));

app.get("/health", (_req, res) => {
  res.status(200).json({
    status: "ok",
    commit: process.env.RENDER_GIT_COMMIT || "local"
  });
});

app.use("/uploads", express.static(uploadsDir));
app.use("/share-images", express.static(shareImagesDir, {
  dotfiles: "deny",
  fallthrough: true,
  index: false
}));
app.use("/profile-images", express.static(avatarImagesDir, {
  dotfiles: "deny",
  fallthrough: true,
  index: false
}));
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

function availableAvatarIds() {
  try {
    return fs.readdirSync(avatarImagesDir, { withFileTypes: true })
      .filter((entry) => (
        entry.isFile()
        && SHARE_IMAGE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())
      ))
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
}

function avatarUrlForId(avatarId = "") {
  return avatarId ? `/profile-images/${encodeURIComponent(avatarId)}` : "";
}

function normalizeStoredProfile(value = {}) {
  const avatarIds = availableAvatarIds();
  const storedName = String(value.name || "").trim();
  const nameLength = Array.from(storedName).length;
  const name = nameLength >= 1 && nameLength <= 40
    ? storedName
    : DEFAULT_PROFILE_NAME;
  const avatarId = avatarIds.includes(value.avatarId)
    ? value.avatarId
    : (avatarIds[0] || "");
  return {
    name,
    role: PROFILE_ROLE,
    avatarId
  };
}

function readProfile() {
  try {
    return normalizeStoredProfile(JSON.parse(fs.readFileSync(profileFile, "utf8")));
  } catch {
    return normalizeStoredProfile();
  }
}

function writeProfile(profile) {
  fs.writeFileSync(profileFile, JSON.stringify(profile, null, 2));
}

function publicProfile(profile = readProfile()) {
  return {
    ...profile,
    avatarUrl: avatarUrlForId(profile.avatarId)
  };
}

function profileResponse(profile = readProfile()) {
  return {
    profile: publicProfile(profile),
    avatars: availableAvatarIds().map((avatarId) => ({
      id: avatarId,
      url: avatarUrlForId(avatarId)
    }))
  };
}

function normalizeBaseUrl(value = "") {
  return String(value || "").trim().replace(/\/+$/, "");
}

function renderExternalBaseUrl() {
  return normalizeBaseUrl(process.env.RENDER_EXTERNAL_URL);
}

function configuredPublicBaseUrl() {
  return renderExternalBaseUrl() || normalizeBaseUrl(process.env.PUBLIC_BASE_URL);
}

function publicBaseUrl(req) {
  return configuredPublicBaseUrl() || `${req.protocol}://${req.get("host")}`;
}

function effectiveSunoCallbackUrl(requestedCallbackUrl = "") {
  const renderBaseUrl = renderExternalBaseUrl();
  if (renderBaseUrl) return `${renderBaseUrl}/api/suno/callback`;

  const requestedCallback = String(requestedCallbackUrl || "").trim();
  if (requestedCallback) return requestedCallback;

  const configuredBaseUrl = configuredPublicBaseUrl();
  return configuredBaseUrl
    ? `${configuredBaseUrl}/api/suno/callback`
    : String(process.env.SUNO_CALLBACK_URL || "").trim();
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

function formatSeconds(seconds) {
  const value = Math.max(0, Math.floor(Number(seconds) || 0));
  return `${Math.floor(value / 60)}:${String(value % 60).padStart(2, "0")}`;
}

function normalizeSunoTrack(track = {}) {
  return {
    id: track.id,
    audioUrl: track.audioUrl || track.audio_url,
    streamAudioUrl: track.streamAudioUrl || track.stream_audio_url,
    imageUrl: track.imageUrl || track.image_url,
    sourceAudioUrl: track.sourceAudioUrl || track.source_audio_url,
    sourceStreamAudioUrl: track.sourceStreamAudioUrl || track.source_stream_audio_url,
    sourceImageUrl: track.sourceImageUrl || track.source_image_url,
    prompt: track.prompt,
    title: track.title,
    tags: track.tags,
    modelName: track.modelName || track.model_name,
    createTime: track.createTime || track.create_time || track.createTime,
    duration: track.duration
  };
}

function tracksFromCallback(payload) {
  const callbackData = payload?.data || {};
  if (!["first", "complete"].includes(callbackData.callbackType)) return [];
  return (callbackData.data || []).map(normalizeSunoTrack).filter((track) => track.audioUrl || track.streamAudioUrl);
}

function statusFromCallback(payload) {
  const callbackData = payload?.data || {};
  if (!payload) return "";
  if (payload.code && Number(payload.code) !== 200) return "GENERATE_AUDIO_FAILED";
  if (callbackData.callbackType === "error") return "GENERATE_AUDIO_FAILED";
  if (callbackData.callbackType === "complete") return "SUCCESS";
  if (callbackData.callbackType === "first") return "FIRST_SUCCESS";
  if (callbackData.callbackType === "text") return "TEXT_SUCCESS";
  return "";
}

function callbackTaskId(payload = {}) {
  return payload.data?.task_id || payload.data?.taskId || payload.task_id || payload.taskId || "";
}

function mergeTaskStatus(recordStatus = "", callbackStatus = "") {
  const terminal = new Set(["SUCCESS", "CREATE_TASK_FAILED", "GENERATE_AUDIO_FAILED", "CALLBACK_EXCEPTION", "SENSITIVE_WORD_ERROR"]);
  if (callbackStatus && (terminal.has(callbackStatus) || !recordStatus || recordStatus === "PENDING")) return callbackStatus;
  if (recordStatus === "TEXT_SUCCESS" && callbackStatus === "FIRST_SUCCESS") return callbackStatus;
  if (recordStatus === "FIRST_SUCCESS" && callbackStatus === "SUCCESS") return callbackStatus;
  return recordStatus || callbackStatus || "PENDING";
}

function availableShareImages() {
  let entries;
  try {
    entries = fs.readdirSync(shareImagesDir, { withFileTypes: true });
  } catch {
    const error = new Error("分享图片目录不可用，请检查服务端资源配置");
    error.status = 500;
    throw error;
  }

  return entries
    .filter((entry) => (
      entry.isFile()
      && SHARE_IMAGE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())
    ))
    .map((entry) => entry.name)
    .sort();
}

function selectShareHeroImageUrls(count) {
  const candidates = availableShareImages();
  if (candidates.length < count) {
    const error = new Error(`分享图片资源不足，至少需要 ${count} 张`);
    error.status = 500;
    throw error;
  }

  for (let index = candidates.length - 1; index > 0; index -= 1) {
    const swapIndex = crypto.randomInt(index + 1);
    [candidates[index], candidates[swapIndex]] = [candidates[swapIndex], candidates[index]];
  }

  return candidates
    .slice(0, count)
    .map((filename) => `/share-images/${encodeURIComponent(filename)}`);
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
    lyrics: _lyrics,
    ...safeShare
  } = share;
  const profile = publicProfile();
  return {
    ...safeShare,
    creatorName: safeShare.creatorName || profile.name,
    creatorRole: safeShare.creatorRole || profile.role,
    creatorAvatarUrl: safeShare.creatorAvatarUrl || profile.avatarUrl,
    comments: Array.isArray(safeShare.comments)
      ? safeShare.comments.map(({ readAt: _readAt, ...comment }) => comment)
      : [],
    requiresPassword: isPasswordProtected(share)
  };
}

function feedbackInbox(shares) {
  const groups = Object.values(shares)
    .filter((share) => share && typeof share === "object")
    .map((share) => {
      const feedbacks = (Array.isArray(share.comments) ? share.comments : [])
        .map((comment) => ({
          id: comment.id,
          timeSeconds: Math.max(0, Math.round(Number(comment.timeSeconds) || 0)),
          rating: Math.max(1, Math.min(5, Math.round(Number(comment.rating) || 5))),
          title: comment.title || "修改建议",
          category: comment.category || "建议",
          text: comment.text || "",
          reviewerName: comment.reviewerName || "匿名听众",
          createdAt: comment.createdAt || share.createdAt || "",
          readAt: comment.readAt || null
        }))
        .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
      if (!feedbacks.length) return null;
      return {
        token: share.token,
        title: share.title || "未命名 Demo",
        versionLabel: share.versionLabel || "v1",
        heroImageUrl: share.heroImageUrl || "",
        isActive: share.is_active !== false,
        shareUrl: `/s/${encodeURIComponent(share.token)}`,
        feedbackUrl: `/s/${encodeURIComponent(share.token)}/feedback`,
        createdAt: share.createdAt || "",
        latestFeedbackAt: feedbacks[0]?.createdAt || share.createdAt || "",
        feedbacks
      };
    })
    .filter(Boolean)
    .sort((a, b) => String(b.latestFeedbackAt).localeCompare(String(a.latestFeedbackAt)));
  const total = groups.reduce((count, group) => count + group.feedbacks.length, 0);
  const unread = groups.reduce(
    (count, group) => count + group.feedbacks.filter((feedback) => !feedback.readAt).length,
    0
  );
  return {
    summary: {
      total,
      unread,
      shares: groups.length
    },
    groups
  };
}

function hasShareApiAccess(req, res, share, token) {
  if (!share) {
    res.status(404).json({ message: "分享链接不存在" });
    return false;
  }
  if (!share.is_active) {
    res.status(410).json({ message: "分享已关闭" });
    return false;
  }
  if (!share.audioUrl) {
    res.status(404).json({ message: "音频不存在" });
    return false;
  }
  if (isPasswordProtected(share) && !hasValidUnlockCookie(req, token)) {
    res.status(401).json({ message: "需要访问密码", requiresPassword: true });
    return false;
  }
  return true;
}

function serializeForInlineScript(value) {
  return JSON.stringify(value)
    .replaceAll("<", "\\u003c")
    .replaceAll("\u2028", "\\u2028")
    .replaceAll("\u2029", "\\u2029");
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
  const profile = publicProfile();
  const title = escapeHtml(share.title || "未命名 Demo");
  const creatorName = escapeHtml(share.creatorName || profile.name);
  const creatorRole = escapeHtml(share.creatorRole || profile.role);
  const creatorAvatarUrl = escapeHtml(share.creatorAvatarUrl || profile.avatarUrl);
  const createdAt = escapeHtml((share.createdAt || "").slice(0, 10));
  const styleTags = (share.styleTags || []).slice(0, 4).map((tag) => `<span>${escapeHtml(tag)}</span>`).join("");
  const audioUrl = escapeHtml(share.audioUrl || "");
  const heroStyle = share.heroImageUrl ? ` style="background-image:url('${escapeHtml(share.heroImageUrl)}')"` : "";
  const heroClass = share.heroImageUrl ? "hero has-image" : "hero";
  const analysis = normalizeSongAnalysis(share.analysis, fallbackSongAnalysis({ lyrics: share.lyrics, styleTags: share.styleTags }));
  const genreText = [analysis.primary_genre, analysis.secondary_genre].filter(Boolean).join(" / ");
  const bpmText = analysis.bpm || analysis.bpm_range || "待分析";
  const instrumentText = analysis.instrumentation.join(" · ") || "人声 · 编曲";
  const moodText = analysis.mood.join(" · ") || "真诚 · 温暖";
  const recommendation = escapeHtml(analysis.recommendation || "灵感正在发光");
  const songDescription = escapeHtml(`${analysis.content_summary}。${analysis.arrangement_summary}`);
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
        color: #151329;
        background: radial-gradient(circle at 50% 0%, #ffffff 0, #f7f4ff 42%, #edeaf8 100%);
        font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
      }
      .page { max-width: 580px; margin: 0 auto; padding: 40px 14px 40px; }
      .card { overflow: hidden; background: linear-gradient(180deg, #fff, #fbfaff 74%, #36149c 74%); border: 1px solid #e7e1ff; border-radius: 28px; box-shadow: 0 26px 68px rgba(44, 23, 105, .18); }
      .hero {
        position: relative;
        display: grid;
        min-height: 300px;
        padding: 34px 30px 24px;
        align-content: end;
        background: linear-gradient(135deg, #f7f7fb, #eceef6);
      }
      .hero.has-image { background-position: center; background-size: cover; }
      .hero.has-image::before { content: ""; position: absolute; inset: 0; background: linear-gradient(180deg, rgba(19,13,45,.14), rgba(16,10,38,.58)); }
      .hero-main { position: relative; z-index: 1; color: #fff; text-shadow: 0 8px 22px rgba(0,0,0,.22); }
      .hero h1 { max-width: 82%; margin: 0 0 10px; font-size: 38px; line-height: 1.08; letter-spacing: 0; }
      .creator-line { display: flex; align-items: center; gap: 10px; color: rgba(255,255,255,.86); font-size: 18px; }
      .creator-avatar { width: 34px; height: 34px; flex: 0 0 auto; object-fit: cover; border: 2px solid rgba(255,255,255,.82); border-radius: 50%; box-shadow: 0 6px 16px rgba(0,0,0,.2); }
      .accent-line { width: 48px; height: 3px; margin: 26px 0 22px; background: #a987ff; border-radius: 99px; }
      .hero-player { display: flex; align-items: center; gap: 16px; }
      .play-pill { display: grid; width: 64px; height: 64px; place-items: center; color: #fff; background: linear-gradient(135deg, #9e5cff, #623cff); border: 0; border-radius: 50%; box-shadow: 0 14px 32px rgba(75, 46, 180, .38); cursor: pointer; }
      .play-pill svg { width: 28px; height: 28px; fill: currentColor; transform: translateX(2px); }
      .time { color: rgba(255,255,255,.92); font-weight: 760; }
      .empty-hero {
        display: grid;
        min-height: 236px;
        place-items: center;
        color: #858ba0;
        border: 1px dashed rgba(120, 120, 145, .34);
        border-radius: 20px;
        background: rgba(255,255,255,.48);
      }
      .version { position: absolute; z-index: 2; top: 28px; right: 28px; padding: 8px 13px; color: #7048ff; background: rgba(255,255,255,.88); border-radius: 12px; font-weight: 800; box-shadow: 0 8px 20px rgba(31, 21, 70, .12); }
      .content { padding: 20px 18px 0; }
      .quote { margin: 0 0 24px; padding: 18px 20px; color: #3b16ba; background: linear-gradient(135deg, #f4edff, #fff); border: 1px solid #e8ddff; border-radius: 16px; box-shadow: 0 12px 28px rgba(104, 70, 210, .13); text-align: center; font-size: 26px; font-weight: 900; letter-spacing: 0; }
      .tags { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 22px; }
      .tags span { padding: 7px 12px; color: #626879; background: #f1f0f6; border-radius: 10px; font-size: 14px; }
      audio { position: absolute; width: 1px; height: 1px; opacity: 0; pointer-events: none; }
      .section-title { display: flex; align-items: center; gap: 8px; margin: 0 0 12px; color: #3b16ba; font-size: 18px; font-weight: 900; }
      .analysis-grid { display: grid; grid-template-columns: repeat(4, 1fr); overflow: hidden; margin-bottom: 22px; background: rgba(255,255,255,.78); border: 1px solid #dacdff; border-radius: 14px; box-shadow: 0 10px 26px rgba(92, 62, 172, .08); }
      .analysis-item { min-height: 76px; padding: 14px 10px; text-align: center; border-right: 1px solid #ded7f2; }
      .analysis-item:last-child { border-right: 0; }
      .analysis-item strong { display: block; margin-bottom: 7px; color: #5e3bd1; font-size: 13px; }
      .analysis-item span { display: block; color: #17152a; line-height: 1.35; font-size: 15px; }
      .description-box { min-height: 86px; margin-bottom: 18px; padding: 18px; color: #343244; background: linear-gradient(135deg, #fff, #fbf8ff); border: 1px solid #ece6ff; border-radius: 20px; line-height: 1.8; white-space: pre-wrap; }
      .creator { display: flex; align-items: center; gap: 14px; padding: 0 0 22px; }
      .avatar { width: 54px; height: 54px; border-radius: 50%; background: linear-gradient(135deg, #9be8dc, #222947); }
      .creator strong, .creator span { display: block; }
      .creator span { margin-top: 4px; color: #6b7284; }
      .footer { display: grid; grid-template-columns: 1fr auto; align-items: center; gap: 14px; padding: 35px 28px 56px; color: rgba(255,255,255,.78); background: #35139b; }
      .brand { display: block; color: #fff; font-size: 22px; font-weight: 900; }
      .brand-sub { display: block; margin-top: 4px; font-size: 13px; }
      .qr { display: grid; width: 86px; height: 86px; place-items: center; color: rgba(255,255,255,.72); border: 1px dashed rgba(255,255,255,.42); border-radius: 12px; font-size: 12px; text-align: center; }
      .copy { width: 100%; min-height: 48px; margin: 18px 0 0; color: #fff; background: #7048ff; border: 0; border-radius: 12px; font-size: 16px; font-weight: 760; }
      .feedback-entry { margin: 28px 0 0; }
      a.feedback-entry { display: flex; align-items: center; justify-content: center; min-height: 48px; color: #7048ff; background: #fff; border: 1px solid #ded7ff; border-radius: 12px; cursor: pointer; font-weight: 820; text-decoration: none; }
      .feedback-entry summary { display: flex; align-items: center; justify-content: center; min-height: 48px; color: #7048ff; background: #fff; border: 1px solid #ded7ff; border-radius: 12px; cursor: pointer; font-weight: 820; }
      .feedback { margin-top: 22px; padding: 18px; background: #fbfaff; border: 1px solid #e2dcff; border-radius: 18px; }
      .feedback h2 { margin: 0 0 12px; font-size: 20px; }
      .feedback-meta { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 10px; color: #626879; font-size: 14px; }
      .feedback-time { color: #7048ff; font-weight: 800; }
      .feedback-range { width: 100%; accent-color: #7048ff; cursor: pointer; }
      .stars { display: flex; gap: 6px; margin: 14px 0; }
      .stars button { width: 38px; height: 38px; color: #c8ccd8; background: #fff; border: 1px solid #e6e7ef; border-radius: 10px; cursor: pointer; font-size: 22px; line-height: 1; }
      .stars button.active { color: #7048ff; border-color: #b7a3ff; background: #f6f2ff; }
      .feedback textarea { width: 100%; min-height: 92px; resize: vertical; padding: 12px; color: #333849; border: 1px solid #e1e2eb; border-radius: 12px; outline: none; font: inherit; line-height: 1.55; }
      .feedback-actions { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin-top: 12px; }
      .feedback-actions button { min-height: 44px; border-radius: 12px; border: 1px solid #e1e2eb; background: #fff; cursor: pointer; font-weight: 760; }
      .feedback-actions .submit { color: #fff; background: #7048ff; border-color: #7048ff; }
      .feedback-message { min-height: 20px; margin: 10px 0 0; color: #626879; font-size: 14px; }
      .comment-list { display: grid; gap: 10px; margin-top: 16px; }
      .comment-item { padding: 12px; background: #fff; border: 1px solid #e8e9f1; border-radius: 12px; }
      .comment-item div { display: flex; justify-content: space-between; gap: 12px; color: #7048ff; font-size: 14px; }
      .comment-item span { color: #8a91a3; }
      .comment-item p { margin: 8px 0 0; color: #333849; line-height: 1.55; }
      .error { min-height: 100vh; display: grid; place-items: center; padding: 24px; text-align: center; color: #555c70; }
      @media (max-width: 420px) {
        .page { padding: 0; }
        .card { min-height: 100vh; border-radius: 0; border: 0; }
        .hero { min-height: 292px; padding: 28px 24px 22px; }
        .hero h1 { font-size: 34px; }
        .description-box { min-height: 0; }
        .feedback-entry { margin-top: 18px; }
        .footer { padding: 24px 28px 26px; }
        .analysis-grid { grid-template-columns: repeat(2, 1fr); }
        .analysis-item:nth-child(2) { border-right: 0; }
        .analysis-item:nth-child(-n+2) { border-bottom: 1px solid #ded7f2; }
      }
    </style>
  </head>
  <body>
    <main class="page">
      <section class="card">
        <div class="${heroClass}"${heroStyle}>
          <span class="version">${escapeHtml(share.versionLabel || "v1")}</span>
          ${share.heroImageUrl ? "" : '<div class="empty-hero">顶部图片留空，可配置插入</div>'}
          <div class="hero-main">
            <h1>${title}</h1>
            <div class="creator-line">${creatorAvatarUrl ? `<img class="creator-avatar" src="${creatorAvatarUrl}" alt="" />` : ""}<span>${creatorName} · ${creatorRole}</span></div>
            <div class="accent-line"></div>
            <div class="hero-player">
              <button id="playButton" class="play-pill" type="button" aria-label="播放歌曲"><svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z" /></svg></button>
              <span id="durationLabel" class="time">--:--</span>
            </div>
          </div>
        </div>
        <div class="content">
          <div class="quote">“ ${recommendation} ”</div>
          <div class="tags">${styleTags}</div>
          ${audioUrl ? `<audio id="shareAudio" controls preload="metadata" src="${audioUrl}"></audio>` : '<div class="info">音频不存在或已失效</div>'}
          <h2 class="section-title">歌曲解读</h2>
          <div class="analysis-grid">
            <div class="analysis-item"><strong>流派</strong><span>${escapeHtml(genreText)}</span></div>
            <div class="analysis-item"><strong>BPM</strong><span>${escapeHtml(bpmText)}</span></div>
            <div class="analysis-item"><strong>配器</strong><span>${escapeHtml(instrumentText)}</span></div>
            <div class="analysis-item"><strong>情绪</strong><span>${escapeHtml(moodText)}</span></div>
          </div>
          <h2 class="section-title">歌曲描述</h2>
          <div class="description-box">${songDescription}</div>
          <a class="feedback-entry" href="${escapeHtml(shareUrl)}/feedback">反馈修改意见</a>
          <button class="copy" data-link="${escapeHtml(shareUrl)}">复制链接</button>
        </div>
        <footer class="footer">
          <span><span class="brand">MelodyFlow</span><span class="brand-sub">让音乐创作自然流动</span></span>
          <span>生成时间<br>${createdAt}</span>
          <span class="qr">二维码<br>预留</span>
        </footer>
      </section>
    </main>
    <script>
      const token = ${JSON.stringify(share.token)};
      const audio = document.getElementById("shareAudio");
      const durationLabel = document.getElementById("durationLabel");
      const playButton = document.getElementById("playButton");

      function formatTime(seconds) {
        const value = Math.max(0, Math.floor(Number(seconds) || 0));
        return Math.floor(value / 60) + ":" + String(value % 60).padStart(2, "0");
      }

      audio?.addEventListener("loadedmetadata", () => {
        durationLabel.textContent = formatTime(audio.duration);
      });
      audio?.addEventListener("play", () => {
        playButton.innerHTML = '<svg viewBox="0 0 24 24"><path d="M7 5h4v14H7zm6 0h4v14h-4z" /></svg>';
      });
      audio?.addEventListener("pause", () => {
        playButton.innerHTML = '<svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z" /></svg>';
      });
      playButton?.addEventListener("click", () => {
        if (!audio) return;
        if (audio.paused) audio.play();
        else audio.pause();
      });
      document.querySelector(".copy").addEventListener("click", async (event) => {
        const button = event.currentTarget;
        const link = button.dataset.link;
        try {
          await navigator.clipboard.writeText(link);
          button.textContent = "已复制";
        } catch {
          button.textContent = link;
        }
      });
    </script>
  </body>
</html>`;
}

function makeFeedbackPage(share, shareUrl) {
  const profile = publicProfile();
  const title = escapeHtml(share.title || "未命名 Demo");
  const creatorName = escapeHtml(share.creatorName || profile.name);
  const creatorRole = escapeHtml(share.creatorRole || profile.role);
  const createdAt = escapeHtml((share.createdAt || "").slice(0, 10));
  const audioUrl = escapeHtml(share.audioUrl || "");
  const heroImageUrl = escapeHtml(share.heroImageUrl || "");
  const versionLabel = escapeHtml(share.versionLabel || "v1");
  const comments = serializeForInlineScript((share.comments || []).map((comment) => ({
    id: comment.id,
    timeSeconds: Math.max(0, Math.round(Number(comment.timeSeconds) || 0)),
    rating: Math.max(1, Math.min(5, Math.round(Number(comment.rating) || 5))),
    title: comment.title || "修改建议",
    category: comment.category || "建议",
    text: comment.text || "",
    reviewerName: comment.reviewerName || "匿名听众",
    createdAt: comment.createdAt
  })).sort((a, b) => a.timeSeconds - b.timeSeconds));
  const bars = Array.from({ length: 96 }, (_, index) => {
    const height = 22 + Math.round(Math.abs(Math.sin(index * 0.55)) * 54 + Math.abs(Math.cos(index * 0.17)) * 20);
    return `<span style="height:${height}px"></span>`;
  }).join("");

  return `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>反馈修改意见 - ${title}</title>
    <style>
      * { box-sizing: border-box; }
      body { margin: 0; min-height: 100vh; color: #25283b; background: linear-gradient(180deg, #faf8ff, #f0ecff); font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif; }
      button, input, textarea, select { font: inherit; }
      .page { max-width: 760px; margin: 0 auto; padding: 12px 12px 24px; }
      .hero-card, .timeline-card, .mini-player { background: rgba(255,255,255,.9); border: 1px solid #e4dcff; border-radius: 18px; box-shadow: 0 18px 48px rgba(60, 39, 132, .09); }
      .hero-card { display: grid; grid-template-columns: auto 1fr auto; gap: 18px; align-items: center; padding: 24px; }
      .back { display: grid; width: 44px; height: 44px; place-items: center; color: #242638; text-decoration: none; border-radius: 12px; }
      .cover { width: 118px; aspect-ratio: 1; border-radius: 14px; object-fit: cover; background: linear-gradient(135deg, #eee9ff, #d8e8ff); }
      .song h1 { margin: 0 0 10px; font-size: 30px; line-height: 1.1; letter-spacing: 0; }
      .song-meta, .song-sub { color: #62677a; line-height: 1.7; }
      .version { display: inline-flex; margin-left: 8px; padding: 4px 8px; color: #7048ff; background: #f1ebff; border-radius: 8px; font-size: 15px; }
      .top-actions { display: grid; gap: 16px; justify-items: end; }
      .submit-top { min-height: 42px; padding: 0 18px; color: #7048ff; background: #fff; border: 1px solid #a98bff; border-radius: 10px; cursor: pointer; font-weight: 800; }
      .switch { display: grid; width: 58px; height: 58px; place-items: center; color: #242638; background: #f2f0f8; border: 0; border-radius: 50%; cursor: pointer; }
      .switch svg, .play svg, .icon { width: 24px; height: 24px; stroke: currentColor; fill: none; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
      .timeline-card { margin-top: 20px; overflow: hidden; }
      .player-row { display: grid; grid-template-columns: auto auto 1fr auto auto auto; gap: 16px; align-items: center; padding: 22px; }
      .play { display: grid; width: 58px; height: 58px; place-items: center; color: #fff; background: linear-gradient(135deg, #9a5bff, #6846f5); border: 0; border-radius: 50%; cursor: pointer; box-shadow: 0 14px 30px rgba(104, 70, 245, .28); }
      .clock { color: #7048ff; font-size: 18px; font-weight: 900; }
      .duration { color: #7b8095; }
      .skip, .volume-button { display: grid; width: 42px; height: 42px; place-items: center; color: #25283b; background: #fff; border: 0; border-radius: 10px; cursor: pointer; }
      .volume { width: 128px; accent-color: #7048ff; }
      .wave-panel { position: relative; padding: 26px 22px 34px; cursor: pointer; }
      .wave { display: flex; height: 92px; align-items: center; gap: 3px; }
      .wave span { flex: 1; min-width: 2px; border-radius: 999px; background: #d7c9ff; }
      .wave span.active { background: #7048ff; }
      .playhead { position: absolute; top: 22px; bottom: 50px; left: 22px; width: 3px; background: #7048ff; border-radius: 999px; transform: translateX(-1px); pointer-events: none; }
      .playhead::before { content: attr(data-time); position: absolute; top: -26px; left: 50%; transform: translateX(-50%); padding: 5px 9px; color: #fff; background: #7048ff; border-radius: 8px; font-weight: 800; white-space: nowrap; }
      .ticks { display: grid; grid-template-columns: repeat(6, 1fr); margin-top: 12px; color: #747a91; font-size: 14px; }
      .ticks span:last-child { text-align: right; }
      .hint-row { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 14px 22px; color: #777d92; border-top: 1px solid #ece7ff; border-bottom: 1px solid #ece7ff; }
      .hint-row button { min-height: 38px; padding: 0 14px; color: #7048ff; background: #fff; border: 1px solid #d6c8ff; border-radius: 10px; cursor: pointer; font-weight: 800; }
      .feedback-form { display: none; grid-template-columns: 120px 1fr; gap: 12px; padding: 18px 22px; background: #fbfaff; border-bottom: 1px solid #ece7ff; }
      .feedback-form.show { display: grid; }
      .feedback-form .time-box { color: #25283b; font-size: 22px; font-weight: 900; }
      .fields { display: grid; gap: 10px; }
      .fields input, .fields textarea, .fields select { width: 100%; padding: 11px 12px; color: #303447; background: #fff; border: 1px solid #ded9ee; border-radius: 10px; outline: none; }
      .fields textarea { min-height: 96px; resize: vertical; line-height: 1.55; }
      .field-grid { display: grid; grid-template-columns: 1fr 130px; gap: 10px; }
      .form-actions { display: flex; justify-content: flex-end; gap: 10px; }
      .form-actions button { min-height: 40px; padding: 0 16px; border-radius: 10px; border: 1px solid #ded9ee; background: #fff; cursor: pointer; font-weight: 800; }
      .form-actions .primary { color: #fff; background: #7048ff; border-color: #7048ff; }
      .comment-list { display: grid; gap: 18px; padding: 20px 22px 24px; }
      .comment-row { display: grid; grid-template-columns: 92px 1fr; gap: 16px; }
      .rail { display: grid; justify-items: center; color: #25283b; font-weight: 900; }
      .rail button { display: grid; width: 46px; height: 46px; margin-top: 8px; place-items: center; color: #fff; background: linear-gradient(135deg, #9a5bff, #6846f5); border: 0; border-radius: 50%; cursor: pointer; }
      .rail-line { width: 2px; min-height: 42px; margin-top: 8px; background: #aa8cff; }
      .comment-card { position: relative; padding: 20px 18px; background: #fff; border: 1px solid #ded6ff; border-radius: 16px; }
      .comment-card::before { content: ""; position: absolute; left: -9px; top: 34px; width: 16px; height: 16px; background: #fff; border-left: 1px solid #ded6ff; border-bottom: 1px solid #ded6ff; transform: rotate(45deg); }
      .comment-head { display: flex; justify-content: space-between; gap: 12px; margin-bottom: 8px; }
      .comment-head strong { font-size: 18px; }
      .reviewer { display: inline-flex; margin-left: 8px; color: #777d92; font-size: 13px; font-weight: 650; }
      .tag { display: inline-flex; margin-left: 8px; padding: 3px 8px; color: #7048ff; background: #f3eeff; border: 1px solid #dacdff; border-radius: 7px; font-size: 13px; }
      .comment-card p { margin: 0; color: #5a6075; line-height: 1.75; }
      .add-empty { display: grid; min-height: 92px; place-items: center; color: #7048ff; border: 1px dashed #a98bff; border-radius: 14px; cursor: pointer; font-weight: 900; }
      .feedback-notice { display: none; margin: 14px 22px 0; padding: 12px 14px; color: #256b45; background: #ecf8f1; border: 1px solid #bfe5ce; border-radius: 10px; font-weight: 750; }
      .feedback-notice.show { display: block; }
      .mini-player { position: sticky; bottom: 12px; display: grid; grid-template-columns: auto 1fr auto; gap: 12px; align-items: center; margin-top: 20px; padding: 14px 18px; }
      .mini-player .play { width: 44px; height: 44px; }
      .mini-title strong, .mini-title span { display: block; }
      .mini-title span { margin-top: 4px; color: #777d92; }
      .mini-time { color: #7048ff; font-weight: 900; }
      audio { position: absolute; width: 1px; height: 1px; opacity: 0; pointer-events: none; }
      @media (max-width: 640px) {
        .page { padding: 0; }
        .hero-card, .timeline-card, .mini-player { border-radius: 0; }
        .hero-card { grid-template-columns: 1fr auto; padding: 18px; }
        .back { grid-column: 1 / -1; justify-self: start; }
        .cover { width: 84px; grid-column: 2; grid-row: 2; }
        .top-actions { grid-column: 1 / -1; grid-template-columns: 1fr auto; align-items: center; justify-items: stretch; }
        .player-row { grid-template-columns: auto auto 1fr; }
        .skip, .volume-button, .volume { display: none; }
        .feedback-form, .comment-row { grid-template-columns: 1fr; }
        .rail { grid-template-columns: 76px auto; justify-content: start; gap: 10px; }
        .rail-line { display: none; }
      }
    </style>
  </head>
  <body>
    <main class="page">
      <section class="hero-card">
        <a class="back" href="${escapeHtml(shareUrl)}" aria-label="返回分享页"><svg class="icon" viewBox="0 0 24 24"><path d="M19 12H5" /><path d="m12 19-7-7 7-7" /></svg></a>
        ${heroImageUrl ? `<img class="cover" src="${heroImageUrl}" alt="歌曲封面" />` : '<span class="cover"></span>'}
        <div class="song">
          <h1>${title}<span class="version">${versionLabel}</span></h1>
          <div class="song-sub">${creatorName} · ${creatorRole}</div>
          <div class="song-meta">时长 <span id="durationMeta">--:--</span> ｜ 由 AI 生成</div>
        </div>
        <div class="top-actions">
          <button id="submitTop" class="submit-top" type="button">提交反馈</button>
          <button id="switchPlay" class="switch" type="button" aria-label="播放"><svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z" /></svg></button>
          <span>切换版本</span>
        </div>
      </section>

      <section class="timeline-card">
        ${audioUrl ? `<audio id="feedbackAudio" preload="metadata" src="${audioUrl}"></audio>` : ""}
        <div class="player-row">
          <button id="mainPlay" class="play" type="button" aria-label="播放"><svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z" /></svg></button>
          <span id="currentLabel" class="clock">0:00</span>
          <span id="totalLabel" class="duration">/ --:--</span>
          <button id="back5" class="skip" type="button">↶5</button>
          <button id="forward5" class="skip" type="button">5↷</button>
          <button class="volume-button" type="button"><svg class="icon" viewBox="0 0 24 24"><path d="M11 5 6 9H3v6h3l5 4z" /><path d="M16 9a5 5 0 0 1 0 6" /></svg></button>
          <input id="volumeRange" class="volume" type="range" min="0" max="1" step="0.01" value="0.8" aria-label="音量" />
        </div>
        <div id="wavePanel" class="wave-panel">
          <div id="playhead" class="playhead" data-time="0:00"></div>
          <div id="wave" class="wave">${bars}</div>
          <div id="ticks" class="ticks"></div>
        </div>
        <div class="hint-row">
          <span>点击时间轴上的任意位置，添加你的反馈意见</span>
          <button id="addFeedback" type="button">添加反馈</button>
        </div>
        <div id="feedbackNotice" class="feedback-notice" role="status" aria-live="polite"></div>
        <div id="feedbackForm" class="feedback-form">
          <div class="time-box" id="selectedTimeLabel">0:00</div>
          <div class="fields">
            <div class="field-grid">
              <input id="feedbackTitle" maxlength="40" placeholder="例如：主歌情绪" />
              <select id="feedbackCategory" aria-label="反馈类型">
                <option value="建议">建议</option>
                <option value="喜欢">喜欢</option>
                <option value="问题">问题</option>
              </select>
            </div>
            <input id="feedbackAuthor" maxlength="40" placeholder="你的称呼（选填，默认匿名听众）" />
            <textarea id="feedbackText" maxlength="500" placeholder="写下这一段的修改建议、喜欢/不喜欢的地方..."></textarea>
            <div class="form-actions">
              <button id="cancelFeedback" type="button">取消</button>
              <button id="saveFeedback" class="primary" type="button">保存反馈</button>
            </div>
            <div id="feedbackMessage"></div>
          </div>
        </div>
        <div id="commentList" class="comment-list"></div>
      </section>

      <section class="mini-player">
        <button id="miniPlay" class="play" type="button" aria-label="播放"><svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z" /></svg></button>
        <div class="mini-title"><strong>${title} <span class="version">${versionLabel}</span></strong><span id="miniDuration">--:--</span></div>
        <span id="miniTime" class="mini-time">0:00 / --:--</span>
      </section>
    </main>
    <script>
      const token = ${JSON.stringify(share.token)};
      let comments = ${comments};
      const audio = document.getElementById("feedbackAudio");
      const mainPlay = document.getElementById("mainPlay");
      const miniPlay = document.getElementById("miniPlay");
      const switchPlay = document.getElementById("switchPlay");
      const currentLabel = document.getElementById("currentLabel");
      const totalLabel = document.getElementById("totalLabel");
      const miniTime = document.getElementById("miniTime");
      const durationMeta = document.getElementById("durationMeta");
      const miniDuration = document.getElementById("miniDuration");
      const wavePanel = document.getElementById("wavePanel");
      const waveBars = [...document.querySelectorAll("#wave span")];
      const playhead = document.getElementById("playhead");
      const ticks = document.getElementById("ticks");
      const form = document.getElementById("feedbackForm");
      const selectedTimeLabel = document.getElementById("selectedTimeLabel");
      const feedbackTitle = document.getElementById("feedbackTitle");
      const feedbackCategory = document.getElementById("feedbackCategory");
      const feedbackAuthor = document.getElementById("feedbackAuthor");
      const feedbackText = document.getElementById("feedbackText");
      const feedbackMessage = document.getElementById("feedbackMessage");
      const feedbackNotice = document.getElementById("feedbackNotice");
      const commentList = document.getElementById("commentList");
      let selectedTime = 0;
      feedbackAuthor.value = localStorage.getItem("melodyflow.feedback.reviewerName") || "";

      function formatTime(seconds) {
        const value = Math.max(0, Math.floor(Number(seconds) || 0));
        return Math.floor(value / 60) + ":" + String(value % 60).padStart(2, "0");
      }
      function duration() {
        return audio && Number.isFinite(audio.duration) && audio.duration ? audio.duration : 181;
      }
      function playIcon(paused) {
        return paused ? '<svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z" /></svg>' : '<svg viewBox="0 0 24 24"><path d="M7 5h4v14H7zm6 0h4v14h-4z" /></svg>';
      }
      function syncButtons() {
        const html = playIcon(!audio || audio.paused);
        mainPlay.innerHTML = html;
        miniPlay.innerHTML = html;
        switchPlay.innerHTML = html;
      }
      function seekTo(seconds) {
        selectedTime = Math.max(0, Math.min(duration(), Number(seconds) || 0));
        if (audio) audio.currentTime = selectedTime;
        updatePlayback();
      }
      function updatePlayback() {
        const total = duration();
        const current = audio ? audio.currentTime : selectedTime;
        const ratio = total ? Math.max(0, Math.min(1, current / total)) : 0;
        currentLabel.textContent = formatTime(current);
        totalLabel.textContent = "/ " + formatTime(total);
        miniTime.textContent = formatTime(current) + " / " + formatTime(total);
        durationMeta.textContent = formatTime(total);
        miniDuration.textContent = formatTime(total);
        playhead.style.left = (22 + ratio * Math.max(0, wavePanel.clientWidth - 44)) + "px";
        playhead.dataset.time = formatTime(current);
        waveBars.forEach((bar, index) => bar.classList.toggle("active", index / waveBars.length <= ratio));
      }
      function openFormAt(seconds) {
        selectedTime = Math.max(0, Math.min(duration(), Number(seconds) || 0));
        selectedTimeLabel.textContent = formatTime(selectedTime);
        feedbackTitle.value = "";
        feedbackCategory.value = "建议";
        feedbackText.value = "";
        feedbackMessage.textContent = "";
        feedbackNotice.classList.remove("show");
        form.classList.add("show");
        seekTo(selectedTime);
        feedbackTitle.focus();
      }
      function renderTicks() {
        const total = duration();
        ticks.innerHTML = Array.from({ length: 7 }, (_, index) => '<span>' + formatTime((total / 6) * index) + '</span>').join("");
      }
      function renderComments() {
        comments.sort((a, b) => a.timeSeconds - b.timeSeconds);
        commentList.innerHTML = comments.map((comment, index) => '<article class="comment-row"><div class="rail"><span>' + formatTime(comment.timeSeconds) + '</span><button type="button" data-seek="' + comment.timeSeconds + '">' + playIcon(true) + '</button>' + (index < comments.length - 1 ? '<span class="rail-line"></span>' : '') + '</div><div class="comment-card"><div class="comment-head"><div><strong>' + escapeHtml(comment.title || "修改建议") + '</strong><span class="tag">' + escapeHtml(comment.category || "建议") + '</span><span class="reviewer">' + escapeHtml(comment.reviewerName || "匿名听众") + '</span></div></div><p>' + escapeHtml(comment.text) + '</p></div></article>').join("") + '<button id="addEmpty" class="add-empty" type="button">＋ 添加反馈（点击时间轴或此处）</button>';
        document.querySelectorAll("[data-seek]").forEach((button) => button.addEventListener("click", () => {
          seekTo(Number(button.dataset.seek));
          audio?.play();
        }));
        document.getElementById("addEmpty").addEventListener("click", () => openFormAt(audio?.currentTime || selectedTime || 0));
      }
      function escapeHtml(value) {
        return String(value || "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#039;");
      }
      async function saveComment() {
        const text = feedbackText.value.trim();
        if (!text) {
          feedbackMessage.textContent = "请填写文字反馈";
          return;
        }
        const reviewerName = feedbackAuthor.value.trim();
        const payload = { timeSeconds: Math.round(selectedTime), rating: feedbackCategory.value === "喜欢" ? 5 : 4, title: feedbackTitle.value.trim() || "修改建议", category: feedbackCategory.value, reviewerName, text };
        const response = await fetch("/api/shares/" + encodeURIComponent(token) + "/comments", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
        const body = await response.json().catch(() => ({}));
        if (!response.ok) {
          feedbackMessage.textContent = body.message || "保存失败";
          return;
        }
        comments.push(body.comment);
        if (reviewerName) localStorage.setItem("melodyflow.feedback.reviewerName", reviewerName);
        form.classList.remove("show");
        feedbackNotice.textContent = "反馈已提交，作者会在首页的“收到的反馈”中看到。";
        feedbackNotice.classList.add("show");
        renderComments();
      }
      function togglePlay() {
        if (!audio) return;
        if (audio.paused) audio.play();
        else audio.pause();
      }
      audio?.addEventListener("loadedmetadata", () => { renderTicks(); updatePlayback(); });
      audio?.addEventListener("timeupdate", updatePlayback);
      audio?.addEventListener("play", syncButtons);
      audio?.addEventListener("pause", syncButtons);
      mainPlay.addEventListener("click", togglePlay);
      miniPlay.addEventListener("click", togglePlay);
      switchPlay.addEventListener("click", togglePlay);
      document.getElementById("back5").addEventListener("click", () => seekTo((audio?.currentTime || 0) - 5));
      document.getElementById("forward5").addEventListener("click", () => seekTo((audio?.currentTime || 0) + 5));
      document.getElementById("volumeRange").addEventListener("input", (event) => { if (audio) audio.volume = Number(event.target.value); });
      wavePanel.addEventListener("click", (event) => {
        const rect = wavePanel.getBoundingClientRect();
        openFormAt(((event.clientX - rect.left) / rect.width) * duration());
      });
      document.getElementById("saveFeedback").addEventListener("click", saveComment);
      document.getElementById("submitTop").addEventListener("click", () => openFormAt(audio?.currentTime || selectedTime || 0));
      document.getElementById("addFeedback").addEventListener("click", () => openFormAt(audio?.currentTime || selectedTime || 0));
      document.getElementById("cancelFeedback").addEventListener("click", () => form.classList.remove("show"));
      renderTicks();
      renderComments();
      updatePlayback();
      syncButtons();
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

function truncateText(value = "", maxLength = 13) {
  const chars = Array.from(String(value || "").replace(/\s+/g, ""));
  return chars.length > maxLength ? chars.slice(0, maxLength).join("") : chars.join("");
}

function listFromValue(value, fallback = []) {
  if (Array.isArray(value)) return value.map((item) => String(item || "").trim()).filter(Boolean);
  if (!value) return fallback;
  return String(value).split(/[、,，/]/).map((item) => item.trim()).filter(Boolean);
}

function fallbackSongAnalysis({ styleTags = [] } = {}) {
  const primary = listFromValue(styleTags, ["流行"])[0] || "流行";
  return {
    primary_genre: primary.replace(/\s+\w+$/, "") || primary,
    secondary_genre: "",
    content_summary: "围绕创作主题展开情绪表达",
    mood: ["真诚", "温暖"],
    bpm: "",
    bpm_range: "待分析",
    bpm_confidence: "low",
    instrumentation: ["人声", "鼓组", "合成器"],
    arrangement_summary: "旋律围绕情绪逐步铺开",
    recommendations: [
      "旋律里藏着心事",
      "情绪随节奏铺开",
      "听见灵感生长"
    ],
    recommendation: "旋律里藏着心事"
  };
}

function normalizeSongAnalysis(value, fallback) {
  const analysis = value && typeof value === "object" ? value : {};
  const bpm = Number.parseInt(analysis.bpm, 10);
  const rawRecommendations = listFromValue(analysis.recommendations, []);
  if (analysis.recommendation) rawRecommendations.push(analysis.recommendation);
  const fallbackRecommendations = listFromValue(fallback.recommendations, [fallback.recommendation]).filter(Boolean);
  const recommendations = [...rawRecommendations, ...fallbackRecommendations]
    .map((item) => truncateText(item, 13))
    .filter(Boolean)
    .filter((item, index, list) => list.indexOf(item) === index)
    .slice(0, 3);
  while (recommendations.length < 3) {
    recommendations.push(["旋律里藏着心事", "情绪随节奏铺开", "听见灵感生长"][recommendations.length]);
  }
  return {
    primary_genre: String(analysis.primary_genre || fallback.primary_genre || "流行").trim(),
    secondary_genre: String(analysis.secondary_genre || fallback.secondary_genre || "").trim(),
    content_summary: truncateText(analysis.content_summary || fallback.content_summary, 30),
    mood: listFromValue(analysis.mood, fallback.mood).slice(0, 2),
    bpm: Number.isFinite(bpm) ? bpm : "",
    bpm_range: String(analysis.bpm_range || fallback.bpm_range || "").trim(),
    bpm_confidence: ["high", "medium", "low"].includes(analysis.bpm_confidence) ? analysis.bpm_confidence : "low",
    instrumentation: listFromValue(analysis.instrumentation, fallback.instrumentation).slice(0, 3),
    arrangement_summary: truncateText(analysis.arrangement_summary || fallback.arrangement_summary, 30),
    recommendations,
    recommendation: recommendations[0]
  };
}

function normalizeNoInspirationPrompt(value) {
  const prompt = value && typeof value === "object" ? value : {};
  return {
    theme: truncateText(prompt.theme || "无灵感 Demo", 20),
    mood: listFromValue(prompt.mood, ["松弛", "有画面", "治愈"]).slice(0, 3),
    music_style: listFromValue(prompt.music_style, ["Pop", "Chill"]).slice(0, 2),
    instrumentation: listFromValue(prompt.instrumentation, ["合成器", "贝斯", "鼓组"]).slice(0, 3),
    music_prompt: Array.from(String(prompt.music_prompt || "").trim()).slice(0, 150).join("")
  };
}

async function readSseText(response) {
  const decoder = new TextDecoder();
  let buffer = "";
  let output = "";
  for await (const chunk of response.body) {
    buffer += decoder.decode(chunk, { stream: true });
    const parts = buffer.split("\n\n");
    buffer = parts.pop() || "";
    for (const part of parts) {
      const lines = part.split("\n").filter((line) => line.startsWith("data:"));
      for (const line of lines) {
        const data = line.replace(/^data:\s*/, "").trim();
        if (!data || data === "[DONE]") continue;
        const payload = JSON.parse(data);
        const delta = payload.choices?.[0]?.delta;
        const content = delta?.content;
        if (typeof content === "string") output += content;
        if (Array.isArray(content)) {
          output += content.map((item) => item.text || "").join("");
        }
      }
    }
  }
  return output.trim();
}

async function analyzeSongForShare({ audioUrl, lyrics, title, creatorName, styleTags }) {
  const fallback = fallbackSongAnalysis({ lyrics, styleTags });
  if (!audioUrl || !process.env.DASHSCOPE_API_KEY) return fallback;
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 90000);
    const response = await fetch(DASHSCOPE_COMPAT_CHAT_URL, {
      method: "POST",
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${requireDashScopeApiKey()}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: "qwen3-omni-flash",
        messages: [
          { role: "system", content: SONG_ANALYSIS_PROMPT },
          {
            role: "user",
            content: [
              { type: "input_audio", input_audio: { data: audioUrl } },
              {
                type: "text",
                text: `歌曲名称：${title || "未命名"}\n创作者名称：${creatorName || ""}\n完整歌词：\n${lyrics || "暂无歌词"}`
              }
            ]
          }
        ],
        modalities: ["text"],
        stream: true,
        stream_options: { include_usage: true }
      })
    });
    clearTimeout(timeout);
    if (!response.ok) throw new Error(`歌曲解读失败：${response.status}`);
    const text = await readSseText(response);
    return normalizeSongAnalysis(parseJsonText(text), fallback);
  } catch (error) {
    console.warn("歌曲解读失败，已使用基础分享信息兜底：", error.message);
    return fallback;
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
    const {
      prompt,
      title,
      style,
      generationType = "lyrics",
      customMode,
      instrumental = false,
      model = "V5",
      callbackUrl = ""
    } = req.body || {};
    const cleanPrompt = String(prompt || "").trim();
    const cleanTitle = String(title || "").trim();
    const cleanStyle = String(style || "").trim();
    const isInstrumental = instrumental === true || instrumental === "true";
    const isDescriptionMode = generationType === "description";
    const useCustomMode = typeof customMode === "boolean" ? customMode : (!isDescriptionMode || isInstrumental);

    if (!cleanPrompt) return res.status(400).json({ message: isDescriptionMode ? "歌曲描述不能为空" : "歌词不能为空" });
    if (!useCustomMode && cleanPrompt.length > 500) return res.status(400).json({ message: "歌曲描述最多支持 500 个字符" });
    if (useCustomMode && (!cleanTitle || !cleanStyle)) return res.status(400).json({ message: "自定义模式下标题和风格不能为空" });
    if (useCustomMode && !isInstrumental && !cleanPrompt) return res.status(400).json({ message: "歌词不能为空" });

    const effectiveCallback = effectiveSunoCallbackUrl(callbackUrl);
    if (!effectiveCallback) {
      return res.status(400).json({ message: "请填写公网 callbackUrl，或配置 RENDER_EXTERNAL_URL / PUBLIC_BASE_URL / SUNO_CALLBACK_URL" });
    }

    const payload = {
      customMode: useCustomMode,
      instrumental: isInstrumental,
      model: model || "V5",
      callBackUrl: effectiveCallback
    };
    if (useCustomMode) {
      payload.prompt = isInstrumental ? undefined : cleanPrompt;
      payload.style = cleanStyle;
      payload.title = cleanTitle;
      if (isInstrumental && cleanPrompt) {
        payload.style = `${cleanStyle}。创作描述：${cleanPrompt}`.slice(0, 1000);
      }
    } else {
      payload.prompt = cleanPrompt;
    }

    const body = await sunoFetch(`${SUNO_BASE_URL}/generate`, {
      method: "POST",
      body: JSON.stringify(payload)
    });
    res.json({ taskId: body.data?.taskId });
  } catch (error) { next(error); }
});

async function handleUploadCoverAudio(req, res, next) {
  try {
    const {
      audioBase64,
      mimeType = "audio/webm",
      durationSeconds = 0,
      title,
      tags,
      prompt = "",
      generationType = "description",
      customMode = true,
      instrumental = true,
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

    const externalBaseUrl = configuredPublicBaseUrl();
    const effectiveCallback = effectiveSunoCallbackUrl(callbackUrl);
    if (!externalBaseUrl) {
      return res.status(400).json({ message: "请配置 RENDER_EXTERNAL_URL 或 PUBLIC_BASE_URL，用于公开访问录音文件" });
    }
    if (!effectiveCallback) {
      return res.status(400).json({ message: "请填写公网 callbackUrl，或配置 RENDER_EXTERNAL_URL / PUBLIC_BASE_URL / SUNO_CALLBACK_URL" });
    }

    const filename = saveAudioDataUrl({ audioBase64, mimeType, prefix: "hum" });

    const payload = {
      uploadUrl: `${externalBaseUrl}/uploads/${filename}`,
      customMode: customMode !== false,
      instrumental: instrumental !== false && instrumental !== "false",
      title,
      style: String(prompt || "").trim() ? `${tags}。创作描述：${String(prompt).trim()}`.slice(0, 1000) : tags,
      prompt: generationType === "lyrics" && instrumental === false ? String(prompt || "").trim() : undefined,
      negativeTags,
      callBackUrl: effectiveCallback,
      styleWeight: Number(styleWeight),
      weirdnessConstraint: Number(weirdnessConstraint),
      audioWeight: Number(audioWeight),
      model
    };
    if (vocalGender === "m" || vocalGender === "f") payload.vocalGender = vocalGender;

    const body = await sunoFetch(`${SUNO_BASE_URL}/generate/upload-cover`, {
      method: "POST",
      body: JSON.stringify(payload)
    });
    res.json({ taskId: body.data?.taskId, uploadUrl: payload.uploadUrl, api: "upload-cover" });
  } catch (error) { next(error); }
}

app.post("/api/suno/upload-cover", handleUploadCoverAudio);
app.post("/api/suno/add-instrumental", handleUploadCoverAudio);

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
    let body;
    try {
      body = await sunoFetch(`${SUNO_BASE_URL}/generate/record-info?${query}`);
    } catch (error) {
      const callback = callbackCache.get(taskId) || null;
      if (!callback) throw error;
      const callbackStatus = statusFromCallback(callback);
      return res.json({
        taskId,
        status: callbackStatus || "PENDING",
        errorCode: callbackStatus === "GENERATE_AUDIO_FAILED" ? callback.code : undefined,
        errorMessage: callbackStatus === "GENERATE_AUDIO_FAILED" ? callback.msg : undefined,
        tracks: tracksFromCallback(callback),
        callback
      });
    }
    const data = body.data || {};
    const callback = callbackCache.get(taskId) || null;
    const recordTracks = (data.response?.sunoData || []).map(normalizeSunoTrack);
    const callbackTracks = tracksFromCallback(callback);
    const callbackStatus = statusFromCallback(callback);
    const effectiveStatus = mergeTaskStatus(data.status, callbackStatus);
    const tracks = callbackTracks.length && ["SUCCESS", "FIRST_SUCCESS"].includes(callbackStatus) ? callbackTracks : (recordTracks.length ? recordTracks : callbackTracks);
    res.json({
      taskId: data.taskId || taskId,
      status: effectiveStatus,
      errorCode: data.errorCode || (callback && callback.code !== 200 ? callback.code : undefined),
      errorMessage: data.errorMessage || (callbackStatus === "GENERATE_AUDIO_FAILED" ? callback?.msg : undefined),
      tracks,
      callback
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

app.post("/api/no-inspiration-prompt", async (req, res, next) => {
  try {
    const { environment, currentState, musicRemedy } = req.body || {};
    const selections = [
      ["environment", environment, "窗外环境"],
      ["currentState", currentState, "当前状态"],
      ["musicRemedy", musicRemedy, "音乐解药"]
    ];
    for (const [, value, label] of selections) {
      if (!value?.text || !value?.mapping) return res.status(400).json({ message: `请选择${label}` });
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
            { role: "system", content: NO_INSPIRATION_PROMPT },
            {
              role: "user",
              content: [
                {
                  text: JSON.stringify({
                    environment: environment.text,
                    environment_mapping: environment.mapping,
                    current_state: currentState.text,
                    current_state_mapping: currentState.mapping,
                    music_remedy: musicRemedy.text,
                    music_remedy_mapping: musicRemedy.mapping
                  }, null, 2)
                }
              ]
            }
          ]
        }
      })
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok || body.code) {
      const error = new Error(body.message || body.msg || `DashScope 无灵感 Prompt 生成失败：${response.status}`);
      error.status = response.status >= 400 ? response.status : 502;
      error.details = body;
      throw error;
    }
    const content = body.output?.choices?.[0]?.message?.content;
    const text = Array.isArray(content) ? content.find((item) => item.text)?.text : content;
    const prompt = normalizeNoInspirationPrompt(parseJsonText(text));
    if (!prompt.music_prompt) throw new Error("无灵感 Prompt 结果缺少 music_prompt");
    res.json({ prompt, rawText: text });
  } catch (error) { next(error); }
});

app.post("/api/suno/callback", (req, res) => {
  const payload = req.body || {};
  const taskId = callbackTaskId(payload);
  if (taskId) {
    const previous = callbackCache.get(taskId);
    const previousStatus = statusFromCallback(previous);
    const nextStatus = statusFromCallback(payload);
    const previousRank = { TEXT_SUCCESS: 1, FIRST_SUCCESS: 2, SUCCESS: 3, GENERATE_AUDIO_FAILED: 4 }[previousStatus] || 0;
    const nextRank = { TEXT_SUCCESS: 1, FIRST_SUCCESS: 2, SUCCESS: 3, GENERATE_AUDIO_FAILED: 4 }[nextStatus] || 0;
    callbackCache.set(taskId, nextRank >= previousRank ? payload : previous);
  }
  res.status(200).json({ status: "received" });
});

app.get("/api/profile", (_req, res) => {
  res.json(profileResponse());
});

app.put("/api/profile", (req, res, next) => {
  try {
    const name = String(req.body?.name || "").trim();
    const nameLength = Array.from(name).length;
    if (nameLength < 1 || nameLength > 40) {
      return res.status(400).json({ message: "昵称长度必须为 1–40 个字符" });
    }

    const avatarId = String(req.body?.avatarId || "");
    const avatarIds = availableAvatarIds();
    if (!avatarIds.includes(avatarId)) {
      return res.status(400).json({ message: "请选择有效头像" });
    }

    const profile = {
      name,
      role: PROFILE_ROLE,
      avatarId
    };
    writeProfile(profile);

    const shares = readShares();
    let updatedShares = 0;
    for (const share of Object.values(shares)) {
      if (!share || typeof share !== "object") continue;
      share.creatorName = profile.name;
      share.creatorRole = profile.role;
      share.creatorAvatarUrl = avatarUrlForId(profile.avatarId);
      updatedShares += 1;
    }
    if (updatedShares) writeShares(shares);

    res.json({
      ...profileResponse(profile),
      updatedShares
    });
  } catch (error) {
    next(error);
  }
});

app.post("/api/shares", async (req, res, next) => {
  try {
    const {
      title,
      inspiration,
      lyrics,
      source,
      creatorName: requestedCreatorName,
      audioUrl,
      styleTags = [],
      versionLabel,
      accessType = SHARE_ACCESS_TYPE_PUBLIC,
      accessCode: rawAccessCode = ""
    } = req.body || {};

    if (!title || !audioUrl) return res.status(400).json({ message: "title 和 audioUrl 不能为空" });
    const profile = publicProfile();
    const creatorName = String(requestedCreatorName || "").trim() || profile.name;
    const creatorNameLength = Array.from(creatorName).length;
    if (creatorNameLength > 40) {
      return res.status(400).json({ message: "创作者昵称最多 40 个字符" });
    }
    const creatorRole = profile.role;
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
    const baseUrl = publicBaseUrl(req);
    const normalizedStyleTags = Array.isArray(styleTags) ? styleTags : String(styleTags).split(",").map((item) => item.trim()).filter(Boolean);
    const analysis = await analyzeSongForShare({
      audioUrl,
      lyrics: lyrics || inspiration || "",
      title,
      creatorName,
      styleTags: normalizedStyleTags
    });
    const displayInspiration = inspiration || analysis.content_summary || "来自一段灵感创作";
    const variants = [
      { name: "分享卡片", inspiration: displayInspiration },
      { name: "分享卡片", inspiration: displayInspiration },
      { name: "分享卡片", inspiration: displayInspiration }
    ];
    const heroImageUrls = selectShareHeroImageUrls(variants.length);

    const candidates = [];
    for (const [index, variant] of variants.entries()) {
      let token = randomToken();
      while (shares[token]) token = randomToken();
      const protectedCredentials = accessType === SHARE_ACCESS_TYPE_PASSWORD
        ? await hashAccessCode(accessCode)
        : {};
      const selectedRecommendation = analysis.recommendations?.[index] || analysis.recommendation;
      const shareAnalysis = {
        ...analysis,
        recommendation: selectedRecommendation,
        recommendations: [
          selectedRecommendation,
          ...(analysis.recommendations || [analysis.recommendation].filter(Boolean)).filter((item) => item !== selectedRecommendation)
        ].filter(Boolean)
      };
      const share = {
        token,
        template: variant.name,
        access_type: accessType,
        ...protectedCredentials,
        is_active: true,
        title,
        inspiration: displayInspiration,
        source: source || "文字＋哼唱灵感",
        creatorName,
        creatorRole,
        creatorAvatarUrl: profile.avatarUrl,
        audioUrl,
        styleTags: normalizedStyleTags,
        versionLabel,
        heroImageUrl: heroImageUrls[index],
        analysis: shareAnalysis,
        comments: [],
        createdAt: new Date().toISOString()
      };
      shares[token] = share;
      candidates.push({
        token,
        template: variant.name,
        url: `${baseUrl}/s/${token}`,
        previewUrl: `/s/${token}`,
        requiresPassword: isPasswordProtected(share),
        preview: {
          title: share.title,
          inspiration: share.analysis?.content_summary || share.inspiration,
          styleTags: share.styleTags,
          versionLabel: share.versionLabel,
          heroImageUrl: share.heroImageUrl,
          creatorName: share.creatorName,
          creatorAvatarUrl: share.creatorAvatarUrl,
          recommendation: share.analysis?.recommendation
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

app.post("/api/shares/:token/comments", (req, res) => {
  const shares = readShares();
  const share = shares[req.params.token];
  if (!hasShareApiAccess(req, res, share, req.params.token)) return;

  const rawRating = Math.round(Number(req.body?.rating) || 0);
  const rating = Math.max(1, Math.min(5, rawRating));
  const text = String(req.body?.text || "").trim();
  const title = String(req.body?.title || "修改建议").trim().slice(0, 40) || "修改建议";
  const category = String(req.body?.category || "建议").trim().slice(0, 12) || "建议";
  const reviewerName = String(req.body?.reviewerName || "").trim().slice(0, 40) || "匿名听众";
  const timeSeconds = Math.max(0, Math.round(Number(req.body?.timeSeconds) || 0));
  if (rawRating < 1 || rawRating > 5) return res.status(400).json({ message: "请先打星" });
  if (!text) return res.status(400).json({ message: "请填写文字反馈" });
  if (text.length > 500) return res.status(400).json({ message: "反馈最多 500 字" });

  const comment = {
    id: randomToken(),
    timeSeconds,
    rating,
    title,
    category,
    text,
    reviewerName,
    createdAt: new Date().toISOString(),
    readAt: null
  };
  share.comments = Array.isArray(share.comments) ? share.comments : [];
  share.comments.push(comment);
  writeShares(shares);
  res.json({ comment });
});

app.get("/api/feedback", (_req, res) => {
  res.json(feedbackInbox(readShares()));
});

app.patch("/api/feedback/read-all", (req, res) => {
  const shares = readShares();
  const readAt = new Date().toISOString();
  let updated = 0;
  for (const share of Object.values(shares)) {
    if (!Array.isArray(share?.comments)) continue;
    for (const comment of share.comments) {
      if (comment.readAt) continue;
      comment.readAt = readAt;
      updated += 1;
    }
  }
  if (updated) writeShares(shares);
  res.json({ ok: true, updated, readAt });
});

app.patch("/api/feedback/:token/:commentId", (req, res) => {
  const shares = readShares();
  const share = shares[req.params.token];
  if (!share) return res.status(404).json({ message: "分享链接不存在" });
  const comment = (Array.isArray(share.comments) ? share.comments : [])
    .find((item) => item.id === req.params.commentId);
  if (!comment) return res.status(404).json({ message: "反馈不存在" });
  comment.readAt = req.body?.read === false ? null : new Date().toISOString();
  writeShares(shares);
  res.json({ ok: true, comment: { id: comment.id, readAt: comment.readAt } });
});

app.delete("/api/feedback/:token/:commentId", (req, res) => {
  const shares = readShares();
  const share = shares[req.params.token];
  if (!share) return res.status(404).json({ message: "分享链接不存在" });
  const comments = Array.isArray(share.comments) ? share.comments : [];
  if (!comments.some((comment) => comment.id === req.params.commentId)) {
    return res.status(404).json({ message: "反馈不存在" });
  }
  share.comments = comments.filter((comment) => comment.id !== req.params.commentId);
  writeShares(shares);
  res.json({ ok: true });
});

app.get("/s/:token/feedback", (req, res) => {
  const share = readShares()[req.params.token];
  if (!share || !share.is_active || !share.audioUrl) {
    return res.status(!share ? 404 : share.is_active ? 404 : 410).send(`<!doctype html>
<html lang="zh-CN"><head><meta charset="UTF-8" /><meta name="viewport" content="width=device-width, initial-scale=1.0" /><title>反馈不可用</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px;color:#555c70;background:#f7f7fb;font-family:ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif}.box{max-width:360px;text-align:center;background:#fff;border:1px solid #e7e8f0;border-radius:16px;padding:28px;box-shadow:0 18px 42px rgba(35,32,69,.1)}h1{margin:0 0 10px;color:#101223;font-size:24px}</style></head>
<body><div class="box"><h1>反馈不可用</h1><p>${!share ? "Token 无效，找不到这个分享。" : share.is_active ? "音频不存在或已失效。" : "这个分享已被关闭。"}</p></div></body></html>`);
  }
  if (isPasswordProtected(share) && !hasValidUnlockCookie(req, req.params.token)) {
    return res.type("html").send(makePasswordPage(req.params.token));
  }
  res.type("html").send(makeFeedbackPage(share, `${publicBaseUrl(req)}/s/${share.token}`));
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
