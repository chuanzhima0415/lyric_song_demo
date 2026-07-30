const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { after, before, test } = require("node:test");

const testDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "melodyflow-share-test-"));
const testSharesFile = path.join(testDataDir, "shares.json");
const testShareImagesDir = path.join(testDataDir, "share-images");
const testSecret = "test-share-session-secret-with-more-than-32-characters";
const testPng = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64"
);
const testShareImageNames = [
  "候选图片 1.png",
  "候选图片 2.png",
  "候选图片 3.png",
  "候选图片 4.png"
];

fs.mkdirSync(testShareImagesDir, { recursive: true });
for (const filename of testShareImageNames) {
  fs.writeFileSync(path.join(testShareImagesDir, filename), testPng);
}

process.env.SHARES_FILE = testSharesFile;
process.env.UPLOADS_DIR = path.join(testDataDir, "uploads");
process.env.SHARE_IMAGES_DIR = testShareImagesDir;
process.env.SHARE_SESSION_SECRET = testSecret;
process.env.PUBLIC_BASE_URL = "http://test.invalid";

const {
  app,
  createUnlockCookieValue,
  unlockCookieName
} = require("./server");

let server;
let baseUrl;

before(async () => {
  server = await new Promise((resolve) => {
    const listener = app.listen(0, "127.0.0.1", () => resolve(listener));
  });
  const address = server.address();
  baseUrl = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  await new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
  fs.rmSync(testDataDir, { recursive: true, force: true });
});

async function postJson(url, body, cookie = "") {
  return fetch(`${baseUrl}${url}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(cookie ? { Cookie: cookie } : {})
    },
    body: JSON.stringify(body)
  });
}

function sharePayload(overrides = {}) {
  return {
    title: "受保护的测试歌曲",
    inspiration: "不能在锁定页泄露的灵感",
    lyrics: "不能在锁定页泄露的歌词",
    audioUrl: "https://audio.example/private-song.mp3",
    ...overrides
  };
}

function cookiePair(setCookieHeader) {
  return String(setCookieHeader || "").split(";")[0];
}

test("公开分享保持无需密码即可访问", async () => {
  const createResponse = await postJson("/api/shares", sharePayload({
    heroImageUrl: "https://images.example/should-not-be-used.png"
  }));
  assert.equal(createResponse.status, 200);
  const { candidates } = await createResponse.json();
  assert.equal(candidates.length, 3);
  assert.equal(candidates[0].requiresPassword, false);
  assert.equal(candidates[0].previewUrl, `/s/${candidates[0].token}`);

  const heroImageUrls = candidates.map((candidate) => candidate.preview.heroImageUrl);
  assert.equal(new Set(heroImageUrls).size, 3);
  assert.ok(heroImageUrls.every((url) => url.startsWith("/share-images/")));
  assert.ok(heroImageUrls.every((url) => !url.includes("should-not-be-used")));

  for (const heroImageUrl of heroImageUrls) {
    const imageResponse = await fetch(`${baseUrl}${heroImageUrl}`);
    assert.equal(imageResponse.status, 200);
    assert.equal(imageResponse.headers.get("content-type"), "image/png");
    assert.deepEqual(Buffer.from(await imageResponse.arrayBuffer()), testPng);
  }

  const storedShares = JSON.parse(fs.readFileSync(testSharesFile, "utf8"));
  for (const candidate of candidates) {
    assert.equal(
      storedShares[candidate.token].heroImageUrl,
      candidate.preview.heroImageUrl
    );
  }

  const pageResponse = await fetch(`${baseUrl}/s/${candidates[0].token}`);
  const pageHtml = await pageResponse.text();
  assert.equal(pageResponse.status, 200);
  assert.match(pageHtml, /private-song\.mp3/);
  assert.ok(pageHtml.includes(candidates[0].preview.heroImageUrl));
  assert.doesNotMatch(pageHtml, /顶部图片留空/);
});

test("健康检查返回当前 Render commit", async () => {
  const previousCommit = process.env.RENDER_GIT_COMMIT;
  process.env.RENDER_GIT_COMMIT = "test-render-commit";

  try {
    const response = await fetch(`${baseUrl}/health`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      status: "ok",
      commit: "test-render-commit"
    });
  } finally {
    if (previousCommit === undefined) delete process.env.RENDER_GIT_COMMIT;
    else process.env.RENDER_GIT_COMMIT = previousCommit;
  }
});

test("持久化上传目录可以通过 uploads 路由访问", async () => {
  const uploadFile = path.join(process.env.UPLOADS_DIR, "persistent-audio.txt");
  fs.writeFileSync(uploadFile, "persistent upload");

  const response = await fetch(`${baseUrl}/uploads/persistent-audio.txt`);
  assert.equal(response.status, 200);
  assert.equal(await response.text(), "persistent upload");
});

test("创建接口拒绝非法密码配置", async () => {
  const cases = [
    { accessType: "private", accessCode: "1234" },
    { accessType: "password", accessCode: "" },
    { accessType: "password", accessCode: "123" },
    { accessType: "password", accessCode: "1234567890123" }
  ];

  for (const invalidCase of cases) {
    const response = await postJson("/api/shares", sharePayload(invalidCase));
    assert.equal(response.status, 400);
  }
});

test("Render 环境始终使用正式服务域名生成分享链接", async () => {
  const previousRenderExternalUrl = process.env.RENDER_EXTERNAL_URL;
  const previousPublicBaseUrl = process.env.PUBLIC_BASE_URL;
  process.env.RENDER_EXTERNAL_URL = "https://melodyflow-demo.onrender.com/";
  process.env.PUBLIC_BASE_URL = "https://offline-tunnel.ngrok-free.dev";

  try {
    const response = await postJson("/api/shares", {
      title: "正式域名分享",
      audioUrl: "https://example.com/audio.mp3",
      accessType: "public_link"
    });

    assert.equal(response.status, 200);
    const { candidates } = await response.json();
    assert.equal(
      candidates[0].url,
      `https://melodyflow-demo.onrender.com/s/${candidates[0].token}`
    );
  } finally {
    if (previousRenderExternalUrl === undefined) delete process.env.RENDER_EXTERNAL_URL;
    else process.env.RENDER_EXTERNAL_URL = previousRenderExternalUrl;
    if (previousPublicBaseUrl === undefined) delete process.env.PUBLIC_BASE_URL;
    else process.env.PUBLIC_BASE_URL = previousPublicBaseUrl;
  }
});

test("密码分享只在有效 Cookie 下返回内容", async () => {
  const accessCode = "安全42ab";
  const createResponse = await postJson("/api/shares", sharePayload({
    accessType: "password",
    accessCode
  }));
  assert.equal(createResponse.status, 200);
  const createText = await createResponse.text();
  assert.doesNotMatch(createText, new RegExp(accessCode));
  const { candidates } = JSON.parse(createText);
  assert.equal(candidates.length, 3);
  assert.ok(candidates.every((candidate) => candidate.requiresPassword));

  const storedShares = JSON.parse(fs.readFileSync(testSharesFile, "utf8"));
  const storedShare = storedShares[candidates[0].token];
  assert.equal(storedShare.access_type, "password");
  assert.equal(typeof storedShare.access_code_hash, "string");
  assert.equal(typeof storedShare.access_code_salt, "string");
  assert.equal("access_code" in storedShare, false);
  assert.doesNotMatch(JSON.stringify(storedShare), new RegExp(accessCode));

  const lockedPageResponse = await fetch(`${baseUrl}/s/${candidates[0].token}`);
  const lockedPageHtml = await lockedPageResponse.text();
  assert.equal(lockedPageResponse.status, 200);
  assert.match(lockedPageHtml, /这个分享需要密码/);
  assert.doesNotMatch(lockedPageHtml, /private-song\.mp3/);
  assert.doesNotMatch(lockedPageHtml, /不能在锁定页泄露/);

  const lockedApiResponse = await fetch(`${baseUrl}/api/shares/${candidates[0].token}`);
  const lockedApiText = await lockedApiResponse.text();
  assert.equal(lockedApiResponse.status, 401);
  assert.doesNotMatch(lockedApiText, /private-song\.mp3/);

  const wrongResponse = await postJson(
    `/api/shares/${candidates[0].token}/unlock`,
    { accessCode: "错误密码" }
  );
  assert.equal(wrongResponse.status, 401);
  assert.equal(wrongResponse.headers.get("set-cookie"), null);

  const unlockResponse = await postJson(
    `/api/shares/${candidates[0].token}/unlock`,
    { accessCode }
  );
  assert.equal(unlockResponse.status, 200);
  assert.deepEqual(await unlockResponse.json(), { unlocked: true });
  const unlockedCookie = cookiePair(unlockResponse.headers.get("set-cookie"));
  assert.match(unlockResponse.headers.get("set-cookie"), /HttpOnly/i);
  assert.match(unlockResponse.headers.get("set-cookie"), /SameSite=Lax/i);
  assert.match(unlockResponse.headers.get("set-cookie"), /Max-Age=86400/i);

  const unlockedPageResponse = await fetch(`${baseUrl}/s/${candidates[0].token}`, {
    headers: { Cookie: unlockedCookie }
  });
  assert.match(await unlockedPageResponse.text(), /private-song\.mp3/);

  const unlockedApiResponse = await fetch(`${baseUrl}/api/shares/${candidates[0].token}`, {
    headers: { Cookie: unlockedCookie }
  });
  assert.equal(unlockedApiResponse.status, 200);
  const unlockedApiText = await unlockedApiResponse.text();
  assert.match(unlockedApiText, /private-song\.mp3/);
  assert.doesNotMatch(unlockedApiText, /access_code_hash|access_code_salt/);

  const alteredCookie = `${unlockedCookie.slice(0, -1)}x`;
  const alteredResponse = await fetch(`${baseUrl}/api/shares/${candidates[0].token}`, {
    headers: { Cookie: alteredCookie }
  });
  assert.equal(alteredResponse.status, 401);

  const crossTokenResponse = await fetch(`${baseUrl}/api/shares/${candidates[1].token}`, {
    headers: { Cookie: unlockedCookie }
  });
  assert.equal(crossTokenResponse.status, 401);

  const expiredValue = createUnlockCookieValue(
    candidates[0].token,
    Date.now() - 1000,
    testSecret
  );
  const expiredCookie = `${unlockCookieName(candidates[0].token)}=${expiredValue}`;
  const expiredResponse = await fetch(`${baseUrl}/api/shares/${candidates[0].token}`, {
    headers: { Cookie: expiredCookie }
  });
  assert.equal(expiredResponse.status, 401);

  for (let attempt = 0; attempt < 5; attempt += 1) {
    const response = await postJson(
      `/api/shares/${candidates[2].token}/unlock`,
      { accessCode: "连续错误" }
    );
    assert.equal(response.status, 401);
  }
  const limitedResponse = await postJson(
    `/api/shares/${candidates[2].token}/unlock`,
    { accessCode: "连续错误" }
  );
  assert.equal(limitedResponse.status, 429);

  const missingResponse = await postJson(
    "/api/shares/not-found/unlock",
    { accessCode }
  );
  assert.equal(missingResponse.status, 401);
  assert.equal((await missingResponse.json()).message, "密码错误或分享不可用");
});

test("分享图片不足三张时拒绝创建且不写入记录", async () => {
  const disabledPaths = testShareImageNames.slice(2).map((filename) => ({
    original: path.join(testShareImagesDir, filename),
    disabled: path.join(testShareImagesDir, `${filename}.disabled`)
  }));
  const beforeShares = JSON.parse(fs.readFileSync(testSharesFile, "utf8"));

  for (const imagePath of disabledPaths) {
    fs.renameSync(imagePath.original, imagePath.disabled);
  }

  try {
    const response = await postJson("/api/shares", sharePayload());
    assert.equal(response.status, 500);
    assert.equal((await response.json()).message, "分享图片资源不足，至少需要 3 张");

    const afterShares = JSON.parse(fs.readFileSync(testSharesFile, "utf8"));
    assert.deepEqual(afterShares, beforeShares);
  } finally {
    for (const imagePath of disabledPaths) {
      fs.renameSync(imagePath.disabled, imagePath.original);
    }
  }
});
