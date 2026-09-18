require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const https = require('https');
const fs = require('fs');
const path = require('path');

const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TWITTERAPI_KEY = process.env.TWITTERAPI_IO_KEY;
const CHECK_GAP_MS = 5500; // twitterapi.io free tier spacing
const DATA_FILE = path.join(__dirname, 'data.json');

if (!TELEGRAM_TOKEN || !TWITTERAPI_KEY) {
  console.error('Missing TELEGRAM_BOT_TOKEN or TWITTERAPI_IO_KEY env vars.');
  process.exit(1);
}

const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });

// Force IPv4 for outbound requests. Some hosts (Railway included) can hang
// for a long time on IPv6 resolution/routing to certain APIs, which shows up
// as a plain "timeout exceeded" with no other detail. Forcing IPv4 fixes it.
const ipv4Agent = new https.Agent({ family: 4 });

const api = axios.create({
  httpsAgent: ipv4Agent,
  timeout: 20000
});

// ---------- persistence ----------
// shape: { [chatId]: { [handleLower]: { lastTweetId: string|null, sinceUnix: number } } }
function loadData() {
  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch {
    return {};
  }
}
function saveData(obj) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(obj, null, 2));
}

// Older versions of this bot stored a plain tweet id (or null) per handle.
// Upgrade any such entries to the new { lastTweetId, sinceUnix } shape so
// existing watches keep working without needing /watch again.
function migrate(d) {
  const nowMinus1Min = Math.floor(Date.now() / 1000) - 60;
  for (const chatId of Object.keys(d)) {
    for (const handle of Object.keys(d[chatId])) {
      const v = d[chatId][handle];
      if (v === null || typeof v !== 'object') {
        d[chatId][handle] = { lastTweetId: v ?? null, sinceUnix: nowMinus1Min };
      }
    }
  }
  return d;
}

let data = migrate(loadData());
saveData(data);

// ---------- helpers ----------
function extractHandle(input) {
  input = input.trim();
  const m = input.match(/(?:x\.com|twitter\.com)\/([A-Za-z0-9_]{1,15})/i);
  if (m) return m[1];
  const raw = input.replace(/^@/, '');
  if (/^[A-Za-z0-9_]{1,15}$/.test(raw)) return raw;
  return null;
}

function describeError(err) {
  if (err.code === 'ECONNABORTED') return 'timeout';
  if (err.response) return `HTTP ${err.response.status}: ${JSON.stringify(err.response.data).slice(0, 200)}`;
  if (err.code) return err.code;
  return err.message;
}

function extractTweets(body) {
  return body?.data?.tweets || body?.tweets || [];
}

function tweetUnixSeconds(t) {
  const ms = Date.parse(t.createdAt);
  return Number.isNaN(ms) ? Math.floor(Date.now() / 1000) : Math.floor(ms / 1000);
}

// ---------- PRODUCTION path: /twitter/tweet/advanced_search ----------
// Only bills for tweets actually returned. Querying "since_time:<unix>"
// means the vast majority of polls (nothing new posted) come back empty
// and cost a small flat rate, instead of last_tweets' fixed ~135+ credits
// on every single call regardless of whether anything changed.
// include:nativeretweets keeps retweets visible (advanced_search excludes
// them by default, unlike last_tweets which included them automatically).
async function fetchAdvancedSearchRaw(handle, sinceUnixSeconds) {
  const query = `from:${handle} include:nativeretweets since_time:${sinceUnixSeconds}`;
  const res = await api.get('https://api.twitterapi.io/twitter/tweet/advanced_search', {
    params: { query, queryType: 'Latest' },
    headers: { 'x-api-key': TWITTERAPI_KEY }
  });
  return res.data;
}

// ---------- DEBUG-ONLY path: /twitter/user/last_tweets ----------
// Kept only for the /debugapi command (useful for comparison/troubleshooting).
// The live poller no longer uses this.
async function fetchLastTweetsRaw({ userName, userId }) {
  const params = { includeReplies: true };
  if (userId) params.userId = userId;
  else params.userName = userName;
  const res = await api.get('https://api.twitterapi.io/twitter/user/last_tweets', {
    params,
    headers: { 'x-api-key': TWITTERAPI_KEY }
  });
  return res.data;
}

async function fetchUserId(handle) {
  const res = await api.get('https://api.twitterapi.io/twitter/user/info', {
    params: { userName: handle },
    headers: { 'x-api-key': TWITTERAPI_KEY }
  });
  return res.data?.data?.id || res.data?.id || null;
}

async function fetchLastTweetSmart(handle) {
  let body = await fetchLastTweetsRaw({ userName: handle });
  let tweets = extractTweets(body);
  let via = 'userName';

  if (tweets.length === 0) {
    try {
      const userId = await fetchUserId(handle);
      if (userId) {
        body = await fetchLastTweetsRaw({ userId });
        tweets = extractTweets(body);
        via = 'userId-fallback';
      }
    } catch (e) {
      // fallback failed silently
    }
  }

  return { tweet: tweets[0] || null, via, raw: body };
}

// ---------- commands ----------
bot.onText(/\/watch(?:@\w+)?\s+(.+)/, async (msg, match) => {
  const chatId = String(msg.chat.id);
  const handle = extractHandle(match[1]);
  if (!handle) {
    return bot.sendMessage(chatId, 'Send it like:\n/watch https://x.com/handle');
  }
  const key = handle.toLowerCase();
  if (!data[chatId]) data[chatId] = {};
  if (data[chatId][key] !== undefined) {
    return bot.sendMessage(chatId, `Already watching @${handle}.`);
  }

  // No API call needed: baseline is just "watch from this moment on".
  // Costs 0 credits, unlike the old last_tweets-based baseline.
  data[chatId][key] = { lastTweetId: null, sinceUnix: Math.floor(Date.now() / 1000) };
  saveData(data);
  bot.sendMessage(
    chatId,
    `Watching @${handle} now. Baseline set — you'll only get alerts on tweets posted after this.`
  );
});

bot.onText(/\/unwatch(?:@\w+)?\s+(.+)/, (msg, match) => {
  const chatId = String(msg.chat.id);
  const handle = extractHandle(match[1]);
  if (!handle) {
    return bot.sendMessage(chatId, 'Send it like:\n/unwatch https://x.com/handle');
  }
  const key = handle.toLowerCase();
  if (data[chatId] && data[chatId][key] !== undefined) {
    delete data[chatId][key];
    saveData(data);
    bot.sendMessage(chatId, `Stopped watching @${handle}.`);
  } else {
    bot.sendMessage(chatId, `Not currently watching @${handle}.`);
  }
});

bot.onText(/\/watching(?:@\w+)?/, (msg) => {
  const chatId = String(msg.chat.id);
  const handles = data[chatId] ? Object.keys(data[chatId]) : [];
  if (handles.length === 0) {
    return bot.sendMessage(chatId, 'Nothing being watched in this chat yet. Use /watch https://x.com/handle');
  }
  bot.sendMessage(chatId, `Watching:\n${handles.map((h) => `• @${h}`).join('\n')}`);
});

bot.onText(/\/debugapi(?:@\w+)?\s+(.+)/, async (msg, match) => {
  const chatId = String(msg.chat.id);
  const handle = extractHandle(match[1]) || match[1].trim();
  bot.sendMessage(chatId, `Calling twitterapi.io (last_tweets) for @${handle}...`);
  const started = Date.now();
  try {
    const { tweet, via, raw } = await fetchLastTweetSmart(handle);
    const ms = Date.now() - started;
    const tweets = extractTweets(raw);
    let out = `Response in ${ms}ms (via ${via}).\nstatus=${raw?.status} code=${raw?.code} msg=${raw?.msg || raw?.message}\ntweets returned: ${tweets.length}`;
    if (tweet) {
      out += `\n\nLatest: id=${tweet.id}\ncreatedAt=${tweet.createdAt}\ntext=${(tweet.text || '').slice(0, 200)}`;
    } else {
      out += `\n\nStill no tweets even after userId fallback.`;
    }
    bot.sendMessage(chatId, out);
  } catch (err) {
    const ms = Date.now() - started;
    bot.sendMessage(chatId, `Failed after ${ms}ms: ${describeError(err)}`);
  }
});

bot.onText(/\/debugsearch(?:@\w+)?\s+(\S+)(?:\s+(\d+))?/, async (msg, match) => {
  const chatId = String(msg.chat.id);
  const handle = extractHandle(match[1]) || match[1].trim();
  const lookbackSeconds = match[2] ? parseInt(match[2], 10) : 3600;
  const sinceUnix = Math.floor(Date.now() / 1000) - lookbackSeconds;

  bot.sendMessage(chatId, `Calling twitterapi.io (advanced_search, since ${lookbackSeconds}s ago) for @${handle}...`);
  const started = Date.now();
  try {
    const raw = await fetchAdvancedSearchRaw(handle, sinceUnix);
    const ms = Date.now() - started;
    const tweets = extractTweets(raw);
    let out = `Response in ${ms}ms.\nstatus=${raw?.status} code=${raw?.code} msg=${raw?.msg || raw?.message}\ntweets returned: ${tweets.length}`;
    if (tweets.length > 0) {
      const t = tweets[0];
      out += `\n\nNewest in window: id=${t.id}\ncreatedAt=${t.createdAt}\ntext=${(t.text || '').slice(0, 200)}`;
    }
    bot.sendMessage(chatId, out);
  } catch (err) {
    const ms = Date.now() - started;
    bot.sendMessage(chatId, `Failed after ${ms}ms: ${describeError(err)}`);
  }
});

bot.onText(/\/start/, (msg) => {
  bot.sendMessage(
    msg.chat.id,
    'Commands:\n' +
      '/watch https://x.com/handle — start watching (free baseline, no old-tweet flood)\n' +
      '/unwatch https://x.com/handle — stop watching\n' +
      '/watching — list active watches in this chat\n' +
      '/debugapi handle — test last_tweets endpoint (diagnostic only)\n' +
      '/debugsearch handle [lookbackSeconds] — test advanced_search endpoint (diagnostic only)'
  );
});

// ---------- global round-robin polling (advanced_search, cost-optimized) ----------
let queue = [];
let pos = 0;

function rebuildQueue() {
  const items = [];
  for (const chatId of Object.keys(data)) {
    for (const handle of Object.keys(data[chatId] || {})) {
      items.push({ chatId, handle });
    }
  }
  queue = items;
  if (pos >= queue.length) pos = 0;
}

async function tick() {
  rebuildQueue();
  if (queue.length === 0) return;

  const { chatId, handle } = queue[pos];
  pos = (pos + 1) % queue.length;

  const known = data[chatId]?.[handle];
  if (known === undefined) return; // unwatched mid-cycle

  try {
    const raw = await fetchAdvancedSearchRaw(handle, known.sinceUnix);
    let tweets = extractTweets(raw);
    if (known.lastTweetId) {
      tweets = tweets.filter((t) => String(t.id) !== String(known.lastTweetId));
    }
    if (tweets.length === 0) return;

    // Oldest first, so alerts arrive in chronological order if multiple
    // tweets landed since the last check.
    tweets.sort((a, b) => tweetUnixSeconds(a) - tweetUnixSeconds(b));

    for (const t of tweets) {
      const url = t.url || `https://x.com/${handle}/status/${t.id}`;
      bot.sendMessage(chatId, `New tweet from @${handle}:\n\n${t.text || '(no text)'}\n\n${url}`);
    }

    const newest = tweets[tweets.length - 1];
    known.lastTweetId = newest.id;
    known.sinceUnix = tweetUnixSeconds(newest) + 1;
    saveData(data);
  } catch (err) {
    console.error(`check @${handle} failed:`, describeError(err));
  }
}

// Self-scheduling loop instead of setInterval: guarantees the next check
// only starts CHECK_GAP_MS after the previous one FINISHES, so a slow
// request can never overlap with the next call.
async function loop() {
  await tick();
  setTimeout(loop, CHECK_GAP_MS);
}
setTimeout(loop, CHECK_GAP_MS);
console.log(`Bot running. Checking one handle every ${CHECK_GAP_MS}ms (no overlap, advanced_search).`);
