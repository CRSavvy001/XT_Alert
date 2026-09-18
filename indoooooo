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

// shape: { [chatId]: { [handleLower]: lastTweetIdOrNull } }
let data = loadData();

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

// Tries userName first; if that comes back with zero tweets, looks up the
// numeric userId and retries once with that instead. Some low-activity
// accounts seem to resolve more reliably by userId on twitterapi.io.
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
      // fallback failed silently; we still return the original (empty) result
    }
  }

  return { tweet: tweets[0] || null, via, raw: body };
}

async function fetchLastTweet(handle) {
  const { tweet } = await fetchLastTweetSmart(handle);
  return tweet;
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

  bot.sendMessage(chatId, `Setting baseline for @${handle}...`);
  try {
    const { tweet, via } = await fetchLastTweetSmart(handle);
    data[chatId][key] = tweet ? tweet.id : null;
    saveData(data);
    bot.sendMessage(
      chatId,
      `Watching @${handle} now. Baseline set — you'll only get alerts on tweets posted after this.` +
        (tweet
          ? ''
          : `\n\n(Note: no tweets were found for this account right now via ${via} — baseline set to "none", so the next tweet detected will trigger an alert.)`)
    );
  } catch (err) {
    console.error(`watch @${handle} failed:`, describeError(err));
    bot.sendMessage(chatId, `Couldn't reach twitterapi.io for @${handle} (${describeError(err)}). Try again shortly.`);
  }
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
  bot.sendMessage(chatId, `Calling twitterapi.io for @${handle}...`);
  const started = Date.now();
  try {
    const { tweet, via, raw } = await fetchLastTweetSmart(handle);
    const ms = Date.now() - started;
    const tweets = extractTweets(raw);
    let out = `Response in ${ms}ms (via ${via}).\nstatus=${raw?.status} code=${raw?.code} msg=${raw?.msg || raw?.message}\ntweets returned: ${tweets.length}`;
    if (tweet) {
      out += `\n\nLatest: id=${tweet.id}\ncreatedAt=${tweet.createdAt}\ntext=${(tweet.text || '').slice(0, 200)}`;
    } else {
      out += `\n\nStill no tweets even after userId fallback. This account may not be indexed yet on twitterapi.io's side.`;
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
      '/watch https://x.com/handle — start watching (baseline only, no old-tweet flood)\n' +
      '/unwatch https://x.com/handle — stop watching\n' +
      '/watching — list active watches in this chat\n' +
      '/debugapi handle — test the API directly and see the raw response'
  );
});

// ---------- global round-robin polling ----------
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

  try {
    const tweet = await fetchLastTweet(handle);
    if (!tweet) return;
    const known = data[chatId]?.[handle];
    if (known === undefined) return; // unwatched mid-cycle

    if (known === null) {
      data[chatId][handle] = tweet.id; // late baseline
      saveData(data);
      return;
    }

    if (String(tweet.id) !== String(known)) {
      data[chatId][handle] = tweet.id;
      saveData(data);
      const url = tweet.url || `https://x.com/${handle}/status/${tweet.id}`;
      bot.sendMessage(chatId, `New tweet from @${handle}:\n\n${tweet.text || '(no text)'}\n\n${url}`);
    }
  } catch (err) {
    console.error(`check @${handle} failed:`, describeError(err));
  }
}

setInterval(tick, CHECK_GAP_MS);
console.log(`Bot running. Checking one handle every ${CHECK_GAP_MS}ms.`);
