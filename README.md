# Fitness Telegram Bot Backend

This is the Node.js webhook backend for the Fitness Telegram Bot.

## Environment Variables

Add these in Vercel / Render / Railway:

```text
TELEGRAM_BOT_TOKEN=
OPENAI_API_KEY=
SUPABASE_URL=https://onqoqjjoutcbylgclcpk.supabase.co
SUPABASE_SERVICE_ROLE_KEY=
PUBLIC_WEBHOOK_URL=
```

Use the base Supabase URL, not the REST URL:

```text
https://onqoqjjoutcbylgclcpk.supabase.co
```

Do not use:

```text
https://onqoqjjoutcbylgclcpk.supabase.co/rest/v1/
```

The code adds `/rest/v1` automatically.

## Required Supabase Setup

Before testing the webhook, run:

```text
fitness-telegram-bot/supabase-schema.sql
```

inside Supabase SQL Editor.

## First Test

After deployment:

1. open `/api/health`;
2. set Telegram webhook to `/api/telegram`;
3. send `/start` to the bot;
4. check Supabase `users` and `bot_logs`.

