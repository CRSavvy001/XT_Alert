require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
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

async function fetchLastTweet(handle) {
  const res = await axios.get('https://api.twitterapi.io/twitter/user/last_tweets', {
    params: { userName: handle },
    headers: { 'x-api-key': TWITTERAPI_KEY },
    timeout: 15000
  });
  const tweets = res.data?.data?.tweets;
  if (!tweets || tweets.length === 0) return null;
  return tweets[0]; // most recent tweet, newest-first confirmed
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
    const tweet = await fetchLastTweet(handle);
    data[chatId][key] = tweet ? tweet.id : null;
    saveData(data);
    bot.sendMessage(
      chatId,
      `Watching @${handle} now. Baseline set — you'll only get alerts on tweets posted after this.`
    );
  } catch (err) {
    console.error('watch error', err.response?.status, err.message);
    bot.sendMessage(chatId, `Couldn't reach twitterapi.io for @${handle} (${err.response?.status || err.message}). Try again shortly.`);
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

bot.onText(/\/start/, (msg) => {
  bot.sendMessage(
    msg.chat.id,
    'Commands:\n' +
      '/watch https://x.com/handle — start watching (baseline only, no old-tweet flood)\n' +
      '/unwatch https://x.com/handle — stop watching\n' +
      '/watching — list active watches in this chat'
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
    console.error(`check @${handle} failed:`, err.response?.status || err.message);
  }
}

setInterval(tick, CHECK_GAP_MS);
console.log(`Bot running. Checking one handle every ${CHECK_GAP_MS}ms.`);
