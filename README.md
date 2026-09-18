# X Watch Telegram Bot

Monitors X/Twitter handles via twitterapi.io and alerts a Telegram chat on new tweets.

## Commands
- `/watch https://x.com/handle` — start watching (baseline only, no alert flood)
- `/unwatch https://x.com/handle` — stop watching
- `/watching` — list active watches in this chat

## Setup
1. Create a bot with @BotFather on Telegram, copy the token.
2. Get an API key from twitterapi.io.
3. Set env vars `TELEGRAM_BOT_TOKEN` and `TWITTERAPI_IO_KEY`.
4. `npm install && npm start`

## Deploy on Railway
1. Push this repo to GitHub.
2. On railway.com: New Project → Deploy from GitHub repo.
3. Add the two env vars under Variables.
4. Railway auto-detects `npm start` from package.json and deploys.

Note: `data.json` (watch state) lives on the container's local disk. It survives
restarts but is wiped on a fresh redeploy unless you attach a Railway volume.
