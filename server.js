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
const shareImageDir = path.join(__dirname, "分享图打包");
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

app.use(express.json({ limit: "25mb" }));
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
  return process.env.PUBLIC_BASE_URL?.replace(/\/$/, "") || `${req.protocol}://${req.get("host")}`;
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

function shuffledShareImages(count, baseUrl) {
  let files = [];
  try {
    files = fs.readdirSync(shareImageDir)
      .filter((file) => /\.(png|jpe?g|webp)$/i.test(file));
  } catch {
    files = [];
  }
  for (let index = files.length - 1; index > 0; index -= 1) {
    const target = Math.floor(Math.random() * (index + 1));
    [files[index], files[target]] = [files[target], files[index]];
  }
  return files.slice(0, count).map((file) => `${baseUrl}/${encodeURIComponent("分享图打包")}/${encodeURIComponent(file)}`);
}

function makeSharePage(share, shareUrl) {
  const title = escapeHtml(share.title || "未命名 Demo");
  const creatorName = escapeHtml(share.creatorName || "Echo");
  const creatorRole = escapeHtml(share.creatorRole || "独立音乐人");
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
  const comments = (share.comments || []).map((comment) => `
    <article class="comment-item">
      <div><strong>${"★".repeat(Number(comment.rating) || 0)}${"☆".repeat(5 - (Number(comment.rating) || 0))}</strong><span>${escapeHtml(formatSeconds(comment.timeSeconds))}</span></div>
      <p>${escapeHtml(comment.text)}</p>
    </article>
  `).join("");

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
      .page { max-width: 560px; margin: 0 auto; padding: 24px 14px 32px; }
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
      .creator-line { color: rgba(255,255,255,.86); font-size: 18px; }
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
      .description-box { margin-bottom: 18px; padding: 18px; color: #343244; background: linear-gradient(135deg, #fff, #fbf8ff); border: 1px solid #ece6ff; border-radius: 20px; line-height: 1.8; white-space: pre-wrap; }
      .creator { display: flex; align-items: center; gap: 14px; padding: 0 0 22px; }
      .avatar { width: 54px; height: 54px; border-radius: 50%; background: linear-gradient(135deg, #9be8dc, #222947); }
      .creator strong, .creator span { display: block; }
      .creator span { margin-top: 4px; color: #6b7284; }
      .footer { display: grid; grid-template-columns: 1fr auto; align-items: center; gap: 14px; padding: 24px 28px 26px; color: rgba(255,255,255,.78); background: #35139b; }
      .brand { display: block; color: #fff; font-size: 22px; font-weight: 900; }
      .brand-sub { display: block; margin-top: 4px; font-size: 13px; }
      .qr { display: grid; width: 86px; height: 86px; place-items: center; color: rgba(255,255,255,.72); border: 1px dashed rgba(255,255,255,.42); border-radius: 12px; font-size: 12px; text-align: center; }
      .copy { width: 100%; min-height: 48px; margin: 18px 0 0; color: #fff; background: #7048ff; border: 0; border-radius: 12px; font-size: 16px; font-weight: 760; }
      .feedback-entry { margin: 18px 0 0; }
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
            <div class="creator-line">${creatorName} · ${creatorRole}</div>
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
          <details class="feedback-entry">
            <summary>反馈修改意见</summary>
            <section class="feedback" aria-label="歌曲反馈">
              <h2>标记反馈</h2>
              <div class="feedback-meta">
                <span>评论时间点</span>
                <strong id="feedbackTime" class="feedback-time">0:00</strong>
              </div>
              <input id="feedbackRange" class="feedback-range" type="range" min="0" max="1000" value="0" aria-label="选择评论时间点" />
              <div id="stars" class="stars" aria-label="打星">
                <button type="button" data-rating="1">★</button>
                <button type="button" data-rating="2">★</button>
                <button type="button" data-rating="3">★</button>
                <button type="button" data-rating="4">★</button>
                <button type="button" data-rating="5">★</button>
              </div>
              <textarea id="feedbackText" maxlength="500" placeholder="写下这一段的修改建议、喜欢/不喜欢的地方..."></textarea>
              <div class="feedback-actions">
                <button id="markCurrentTime" type="button">标记当前进度</button>
                <button id="submitFeedback" class="submit" type="button">提交反馈</button>
              </div>
              <p id="feedbackMessage" class="feedback-message"></p>
              <div id="commentList" class="comment-list">${comments || ""}</div>
            </section>
          </details>
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
      const range = document.getElementById("feedbackRange");
      const timeLabel = document.getElementById("feedbackTime");
      const durationLabel = document.getElementById("durationLabel");
      const playButton = document.getElementById("playButton");
      const message = document.getElementById("feedbackMessage");
      const commentList = document.getElementById("commentList");
      let rating = 0;

      function formatTime(seconds) {
        const value = Math.max(0, Math.floor(Number(seconds) || 0));
        return Math.floor(value / 60) + ":" + String(value % 60).padStart(2, "0");
      }

      function selectedTime() {
        const duration = audio && Number.isFinite(audio.duration) ? audio.duration : 0;
        return duration ? duration * (Number(range.value) / 1000) : 0;
      }

      function updateTimeFromAudio() {
        if (!audio || !range || !Number.isFinite(audio.duration) || !audio.duration) return;
        range.value = String(Math.round((audio.currentTime / audio.duration) * 1000));
        timeLabel.textContent = formatTime(audio.currentTime);
      }

      function updateTimeFromRange() {
        const time = selectedTime();
        timeLabel.textContent = formatTime(time);
      }

      function renderComment(comment) {
        const item = document.createElement("article");
        item.className = "comment-item";
        item.innerHTML = '<div><strong>' + "★".repeat(comment.rating) + "☆".repeat(5 - comment.rating) + '</strong><span>' + formatTime(comment.timeSeconds) + '</span></div><p></p>';
        item.querySelector("p").textContent = comment.text;
        commentList.prepend(item);
      }

      audio?.addEventListener("timeupdate", updateTimeFromAudio);
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
      range?.addEventListener("input", updateTimeFromRange);
      range?.addEventListener("change", () => {
        if (!audio || !Number.isFinite(audio.duration) || !audio.duration) return;
        audio.currentTime = selectedTime();
      });

      document.getElementById("markCurrentTime").addEventListener("click", () => {
        updateTimeFromAudio();
        message.textContent = "已标记 " + timeLabel.textContent;
      });

      document.getElementById("stars").addEventListener("click", (event) => {
        const button = event.target.closest("button[data-rating]");
        if (!button) return;
        rating = Number(button.dataset.rating);
        document.querySelectorAll("#stars button").forEach((item) => item.classList.toggle("active", Number(item.dataset.rating) <= rating));
      });

      document.getElementById("submitFeedback").addEventListener("click", async () => {
        const text = document.getElementById("feedbackText").value.trim();
        if (!rating) {
          message.textContent = "请先打星";
          return;
        }
        if (!text) {
          message.textContent = "请填写文字反馈";
          return;
        }
        const payload = { rating, text, timeSeconds: Math.round(selectedTime()) };
        message.textContent = "正在提交反馈...";
        try {
          const response = await fetch("/api/shares/" + encodeURIComponent(token) + "/comments", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload)
          });
          const body = await response.json().catch(() => ({}));
          if (!response.ok) throw new Error(body.message || "反馈提交失败");
          renderComment(body.comment);
          document.getElementById("feedbackText").value = "";
          message.textContent = "反馈已保存";
        } catch (error) {
          message.textContent = error.message;
        }
      });

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

function truncateText(value = "", maxLength = 13) {
  const chars = Array.from(String(value || "").replace(/\s+/g, ""));
  return chars.length > maxLength ? chars.slice(0, maxLength).join("") : chars.join("");
}

function listFromValue(value, fallback = []) {
  if (Array.isArray(value)) return value.map((item) => String(item || "").trim()).filter(Boolean);
  if (!value) return fallback;
  return String(value).split(/[、,，/]/).map((item) => item.trim()).filter(Boolean);
}

function fallbackSongAnalysis({ lyrics = "", styleTags = [] } = {}) {
  const firstLyric = String(lyrics || "").split(/\n+/).map((line) => line.trim()).find(Boolean) || "灵感在旋律里慢慢展开";
  const primary = listFromValue(styleTags, ["流行"])[0] || "流行";
  const baseRecommendation = truncateText(firstLyric, 13) || "灵感正在发光";
  return {
    primary_genre: primary.replace(/\s+\w+$/, "") || primary,
    secondary_genre: "",
    content_summary: truncateText(firstLyric, 30),
    mood: ["真诚", "温暖"],
    bpm: "",
    bpm_range: "待分析",
    bpm_confidence: "low",
    instrumentation: ["人声", "鼓组", "合成器"],
    arrangement_summary: "旋律围绕情绪逐步铺开",
    recommendations: [
      baseRecommendation,
      "旋律里藏着心事",
      "情绪随节奏铺开"
    ],
    recommendation: baseRecommendation
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
  if (!audioUrl) return fallback;
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
      heroImageUrl = ""
    } = req.body || {};

    if (!title || !audioUrl) return res.status(400).json({ message: "title 和 audioUrl 不能为空" });

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
    const fallbackImages = heroImageUrl ? [] : shuffledShareImages(variants.length, baseUrl);

    const candidates = variants.map((variant, index) => {
      let token = randomToken();
      while (shares[token]) token = randomToken();
      const selectedHeroImageUrl = heroImageUrl || fallbackImages[index] || "";
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
        access_type: "public_link",
        access_code: null,
        is_active: true,
        title,
        inspiration: displayInspiration,
        lyrics: lyrics || "",
        source: source || "文字＋哼唱灵感",
        creatorName,
        creatorRole,
        audioUrl,
        styleTags: normalizedStyleTags,
        versionLabel,
        heroImageUrl: selectedHeroImageUrl,
        analysis: shareAnalysis,
        comments: [],
        createdAt: new Date().toISOString()
      };
      shares[token] = share;
      return {
        token,
        template: variant.name,
        url: `${baseUrl}/s/${token}`,
        preview: {
          title: share.title,
          inspiration: share.analysis?.content_summary || share.inspiration,
          styleTags: share.styleTags,
          versionLabel: share.versionLabel,
          heroImageUrl: share.heroImageUrl,
          recommendation: share.analysis?.recommendation
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

app.post("/api/shares/:token/comments", (req, res) => {
  const shares = readShares();
  const share = shares[req.params.token];
  if (!share) return res.status(404).json({ message: "分享链接不存在" });
  if (!share.is_active) return res.status(410).json({ message: "分享已关闭" });
  if (!share.audioUrl) return res.status(404).json({ message: "音频不存在" });

  const rawRating = Math.round(Number(req.body?.rating) || 0);
  const rating = Math.max(1, Math.min(5, rawRating));
  const text = String(req.body?.text || "").trim();
  const timeSeconds = Math.max(0, Math.round(Number(req.body?.timeSeconds) || 0));
  if (rawRating < 1 || rawRating > 5) return res.status(400).json({ message: "请先打星" });
  if (!text) return res.status(400).json({ message: "请填写文字反馈" });
  if (text.length > 500) return res.status(400).json({ message: "反馈最多 500 字" });

  const comment = {
    id: randomToken(),
    timeSeconds,
    rating,
    text,
    createdAt: new Date().toISOString()
  };
  share.comments = Array.isArray(share.comments) ? share.comments : [];
  share.comments.push(comment);
  writeShares(shares);
  res.json({ comment });
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
