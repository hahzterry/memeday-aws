const { test, beforeEach } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const { registerHooks } = require("node:module");
const { pathToFileURL, fileURLToPath } = require("node:url");

// Synthetic env, not .env. node --test runs each file in its own process, so
// this does not leak into other test files. The key and channel IDs are fake:
// every Buffer call in this file goes to the fetch stub below, never the
// network.
const APP_URL = "https://memeday.example";
process.env.CRON_SECRET = "test-cron-secret";
process.env.BUFFER_API_KEY = "test-buffer-key";
process.env.BUFFER_CHANNEL_IDS = "chan-a, chan-b";
process.env.NEXT_PUBLIC_APP_URL = APP_URL;

const stubUrl = pathToFileURL(path.join(__dirname, "helpers", "buffer-motd-stubs.mjs")).href;

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "@/lib/db") {
      return { url: stubUrl, shortCircuit: true };
    }
    if (specifier === "next/server") {
      return nextResolve("next/server.js", context);
    }
    if (specifier.startsWith("@/")) {
      const candidate = path.resolve(__dirname, "..", specifier.slice(2) + ".ts");
      if (fs.existsSync(candidate)) {
        return { url: pathToFileURL(candidate).href, shortCircuit: true };
      }
    }
    if (specifier.startsWith(".") && !path.extname(specifier) && context.parentURL?.startsWith("file:")) {
      const candidate = path.resolve(path.dirname(fileURLToPath(context.parentURL)), specifier + ".ts");
      if (fs.existsSync(candidate)) {
        return { url: pathToFileURL(candidate).href, shortCircuit: true };
      }
    }
    return nextResolve(specifier, context);
  },
});

function load(rel) {
  return import(pathToFileURL(path.join(__dirname, "..", rel)).href);
}

const MEME = {
  id: "11111111-2222-3333-4444-555555555555",
  caption: "When the deploy works first try",
  imageUrl: "https://d111111abcdef8.cloudfront.net/uploads/u1/m1.jpg",
};
const PERMALINK = `${APP_URL}/meme/${MEME.id}`;
const CHANNELS = ["chan-a", "chan-b"];

const db = (globalThis.__bufferMotd ??= { meme: null, calls: 0 });

// Replaces global fetch for the whole file. Anything that is not one of the
// three known Buffer operations throws, so a test can never reach a real API.
let bufferCalls = [];
let lastPostText = {};
let createPostError = {};
let rateLimited = new Set();

global.fetch = async (url, init) => {
  assert.strictEqual(url, "https://api.buffer.com");
  assert.strictEqual(init.headers.Authorization, "Bearer test-buffer-key");
  const { query } = JSON.parse(init.body);
  const channelId = CHANNELS.find((id) => query.includes(`"${id}"`));
  const reply = (body, status = 200, headers = {}) =>
    new Response(JSON.stringify(body), { status, headers });

  if (rateLimited.has(channelId)) {
    bufferCalls.push({ op: "rate_limited", channelId, query });
    return reply(
      { errors: [{ message: "Too many requests", extensions: { code: "RATE_LIMIT_EXCEEDED" } }] },
      429,
      { "Retry-After": "120" }
    );
  }
  if (query.includes("channel(")) {
    bufferCalls.push({ op: "channel", channelId, query });
    return reply({ data: { channel: { organizationId: "org-1" } } });
  }
  if (query.includes("posts(")) {
    bufferCalls.push({ op: "posts", channelId, query });
    const text = lastPostText[channelId];
    const edges = text === undefined ? [] : [{ node: { id: "p-old", text } }];
    return reply({ data: { posts: { edges } } });
  }
  if (query.includes("createPost(")) {
    bufferCalls.push({ op: "createPost", channelId, query });
    if (createPostError[channelId]) {
      return reply({ data: { createPost: { message: createPostError[channelId] } } });
    }
    return reply({ data: { createPost: { post: { id: `p-${channelId}` } } } });
  }
  throw new Error("fetch stub: unexpected Buffer query");
};

beforeEach(() => {
  db.meme = { ...MEME };
  db.calls = 0;
  bufferCalls = [];
  lastPostText = {};
  createPostError = {};
  rateLimited = new Set();
  process.env.CRON_SECRET = "test-cron-secret";
  process.env.NEXT_PUBLIC_APP_URL = APP_URL;
});

const createCalls = () => bufferCalls.filter((c) => c.op === "createPost");

async function callCron({ url = `${APP_URL}/api/cron/buffer-motd`, authorization = "Bearer test-cron-secret" } = {}) {
  const { NextRequest } = await import("next/server.js");
  const { GET } = await load("app/api/cron/buffer-motd/route.ts");
  const headers = authorization === null ? {} : { authorization };
  return GET(new NextRequest(url, { headers }));
}

// ---------------------------------------------------------------------------
// Post text builder
// ---------------------------------------------------------------------------

const LINK = "https://memeday.example/meme/abc";
// Forces template i (0, 1 or 2) out of the three.
const pick = (i) => () => (i + 0.5) / 3;

test("buffer text: each template fills in the caption and the link", async () => {
  const { buildPostText } = await load("lib/buffer.ts");
  assert.strictEqual(
    buildPostText("Stonks", LINK, pick(0)),
    `Meme of the Day on MemeDay: "Stonks" Like it, tip the creator in SOL, or share it. ${LINK}`
  );
  assert.strictEqual(
    buildPostText("Stonks", LINK, pick(1)),
    `"Stonks" is today's Meme of the Day. On MemeDay, creators get tipped in SOL directly from the feed. ${LINK}`
  );
  assert.strictEqual(
    buildPostText("Stonks", LINK, pick(2)),
    `Today's pick on MemeDay: "Stonks" Creators post, fans tip in SOL, and memes can be minted as NFTs. ${LINK}`
  );
});

test("buffer text: a caption with $ patterns or a literal {link} is inserted as written", async () => {
  const { buildPostText } = await load("lib/buffer.ts");
  const post = buildPostText("$& costs $1 {link}", LINK, pick(0));
  assert.ok(post.includes(`"$& costs $1 {link}"`), post);
  assert.ok(post.endsWith(LINK));
});

test("buffer text: a long caption is truncated to exactly 280 counted characters, link counted as 23", async () => {
  const { buildPostText, xCountedLength } = await load("lib/buffer.ts");
  // Far longer than 23, to prove the link's real length is not what is counted.
  const longLink = `https://memeday.example/meme/${"x".repeat(80)}`;
  for (const i of [0, 1, 2]) {
    const post = buildPostText("a".repeat(400), longLink, pick(i));
    assert.ok(post.endsWith(longLink), "link survives intact");
    assert.ok(post.includes(`a…"`), "caption ends in an ellipsis inside the quotes");
    // Counted by hand rather than with the module's own counter: everything
    // but the link is ASCII (1 each) except the ellipsis, which X counts as 2,
    // hence the +1. Then the link at a flat 23.
    const withoutLink = post.replace(longLink, "");
    assert.strictEqual(withoutLink.length + 1 + 23, 280);
    assert.strictEqual(xCountedLength(post, longLink), 280);
  }
});

test("buffer text: emoji count as 2 and are never cut in half", async () => {
  const { buildPostText } = await load("lib/buffer.ts");
  const post = buildPostText("😂".repeat(300), LINK, pick(0));
  assert.ok(post.isWellFormed(), "no lone surrogate left by the cut");
  const emoji = [...post].filter((c) => c === "😂").length;
  const rest = post.replace(LINK, "").replaceAll("😂", "");
  // rest is ASCII plus one ellipsis (weight 2).
  const counted = emoji * 2 + rest.length + 1 + 23;
  assert.ok(counted <= 280 && counted >= 279, `counted ${counted}`);
});

test("buffer text: a caption that fits is not truncated", async () => {
  const { buildPostText } = await load("lib/buffer.ts");
  const post = buildPostText("  short one  ", LINK, pick(2));
  assert.ok(post.includes(`"short one"`));
  assert.ok(!post.includes("…"));
});

test("buffer text: an empty or whitespace caption leaves clean text with no quotes or double spaces", async () => {
  const { buildPostText } = await load("lib/buffer.ts");
  assert.strictEqual(
    buildPostText("", LINK, pick(0)),
    `Meme of the Day on MemeDay: Like it, tip the creator in SOL, or share it. ${LINK}`
  );
  assert.strictEqual(
    buildPostText("", LINK, pick(2)),
    `Today's pick on MemeDay: Creators post, fans tip in SOL, and memes can be minted as NFTs. ${LINK}`
  );
  for (const caption of ["", "   ", "\n\t "]) {
    for (const i of [0, 1, 2]) {
      const post = buildPostText(caption, LINK, pick(i));
      assert.ok(!post.includes('"'), post);
      assert.ok(!post.includes("  "), post);
      assert.strictEqual(post, post.trim());
      assert.ok(post.endsWith(` ${LINK}`), post);
    }
  }
});

// ---------------------------------------------------------------------------
// Route auth
// ---------------------------------------------------------------------------

test("buffer-motd: 401 with no Authorization header", async () => {
  const res = await callCron({ authorization: null });
  assert.strictEqual(res.status, 401);
  assert.strictEqual(db.calls, 0, "no DB read before auth");
  assert.strictEqual(bufferCalls.length, 0);
});

test("buffer-motd: 401 with the wrong secret", async () => {
  for (const authorization of ["Bearer wrong", "test-cron-secret", "Bearer test-cron-secretX"]) {
    const res = await callCron({ authorization });
    assert.strictEqual(res.status, 401, authorization);
  }
  assert.strictEqual(db.calls, 0);
  assert.strictEqual(bufferCalls.length, 0);
});

test("buffer-motd: 401 when CRON_SECRET is unset or empty, whatever the header says", async () => {
  for (const secret of [undefined, ""]) {
    if (secret === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = secret;
    for (const authorization of [null, "Bearer ", "Bearer undefined", "Bearer test-cron-secret"]) {
      const res = await callCron({ authorization });
      assert.strictEqual(res.status, 401, `secret=${secret} header=${authorization}`);
    }
  }
  assert.strictEqual(db.calls, 0);
  assert.strictEqual(bufferCalls.length, 0);
});

// ---------------------------------------------------------------------------
// Queueing
// ---------------------------------------------------------------------------

test("buffer-motd: queues the same post on both channels, queue-only, with the image", async () => {
  lastPostText = { "chan-a": "some older post about another meme" };
  const res = await callCron();
  assert.strictEqual(res.status, 200);
  assert.deepStrictEqual(await res.json(), {
    memeId: MEME.id,
    results: [
      { channelId: "chan-a", result: "queued" },
      { channelId: "chan-b", result: "queued" },
    ],
  });

  const created = createCalls();
  assert.deepStrictEqual(created.map((c) => c.channelId), CHANNELS);
  for (const { query } of created) {
    assert.ok(query.includes("mode: addToQueue"));
    assert.ok(query.includes("schedulingType: automatic"));
    assert.ok(query.includes(`assets: [{ image: { url: "${MEME.imageUrl}" } }]`));
    assert.ok(query.includes(PERMALINK));
    assert.ok(query.includes(MEME.caption));
    assert.ok(!query.includes("shareNow") && !query.includes("dueAt"), "never share-now or custom time");
  }
  // Same text on both: only the channel ID differs between the two mutations.
  assert.strictEqual(
    created[0].query.replace("chan-a", "X"),
    created[1].query.replace("chan-b", "X")
  );

  // The dedup read is scoped to one channel and covers sent and scheduled.
  for (const { query, channelId } of bufferCalls.filter((c) => c.op === "posts")) {
    assert.ok(query.includes(`channelIds: ["${channelId}"]`));
    assert.ok(query.includes("status: [sent, scheduled]"));
    assert.ok(query.includes(`organizationId: "org-1"`));
  }
});

test("buffer-motd: a channel whose last post has this meme's permalink is skipped, the other is still queued", async () => {
  lastPostText = { "chan-a": `Meme of the Day on MemeDay: "x" Like it. ${PERMALINK}` };
  const res = await callCron();
  assert.strictEqual(res.status, 200);
  assert.deepStrictEqual((await res.json()).results, [
    { channelId: "chan-a", result: "skipped_same_meme" },
    { channelId: "chan-b", result: "queued" },
  ]);
  assert.deepStrictEqual(createCalls().map((c) => c.channelId), ["chan-b"]);
});

test("buffer-motd: one channel's createPost failing gives 500 with both results, the other still queued", async () => {
  createPostError = { "chan-a": "Failed to create post: Failed to fetch image dimensions: Not Found" };
  const res = await callCron();
  assert.strictEqual(res.status, 500);
  const { results } = await res.json();
  assert.strictEqual(results.length, 2);
  assert.strictEqual(results[0].channelId, "chan-a");
  assert.strictEqual(results[0].result, "error");
  assert.match(results[0].error, /Failed to fetch image dimensions/);
  assert.deepStrictEqual(results[1], { channelId: "chan-b", result: "queued" });
  assert.ok(!JSON.stringify(results).includes("test-buffer-key"), "API key never in the response");
});

test("buffer-motd: a 429 is reported with its Retry-After and not retried", async () => {
  rateLimited = new Set(["chan-a"]);
  const res = await callCron();
  assert.strictEqual(res.status, 500);
  const { results } = await res.json();
  assert.strictEqual(results[0].result, "error");
  assert.match(results[0].error, /429/);
  assert.match(results[0].error, /Retry-After: 120/);
  assert.deepStrictEqual(results[1], { channelId: "chan-b", result: "queued" });
  assert.strictEqual(bufferCalls.filter((c) => c.channelId === "chan-a").length, 1, "exactly one attempt");
});

test("buffer-motd: a relative /api/image URL queues nothing", async () => {
  db.meme = { ...MEME, imageUrl: "/api/image/uploads/u1/m1.jpg" };
  const res = await callCron();
  assert.strictEqual(res.status, 500);
  assert.strictEqual(bufferCalls.length, 0, "no Buffer call at all, so no createPost");
});

test("buffer-motd: no usable base URL queues nothing", async () => {
  // Unset, and set to the unexpanded shell form lib/metadata-url.ts rejects.
  // Either way the only base left is the plain-http host of the request.
  for (const appUrl of [undefined, "https://$VERCEL_URL"]) {
    if (appUrl === undefined) delete process.env.NEXT_PUBLIC_APP_URL;
    else process.env.NEXT_PUBLIC_APP_URL = appUrl;
    const res = await callCron({ url: "http://localhost:3000/api/cron/buffer-motd" });
    assert.strictEqual(res.status, 500);
  }
  assert.strictEqual(bufferCalls.length, 0, "no Buffer call at all, so no createPost");
});

test("buffer-motd: no meme of the day returns 200 with a no_meme result and queues nothing", async () => {
  db.meme = null;
  const res = await callCron();
  assert.strictEqual(res.status, 200);
  assert.deepStrictEqual(await res.json(), { result: "no_meme" });
  assert.strictEqual(bufferCalls.length, 0);
});
