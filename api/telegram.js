const SUPABASE_TABLES = {
  USERS: 'users',
  BOT_LOGS: 'bot_logs'
};

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(200).json({ ok: true, message: 'Fitness Telegram Bot webhook is alive.' });
  }

  try {
    const update = req.body || {};
    await handleTelegramUpdate(update);
    return res.status(200).json({ ok: true });
  } catch (error) {
    console.error('telegram webhook error', error);
    return res.status(200).json({ ok: true, error: error.message });
  }
}

async function handleTelegramUpdate(update) {
  const message = update.message || update.edited_message;
  if (!message || !message.chat) return;

  const chatId = message.chat.id;
  const from = message.from || {};
  const userId = from.id;
  const text = (message.text || message.caption || '').trim();

  try {
    await upsertTelegramUser({ chatId, from });

    if (text === '/start') {
      await sendTelegramMessage(chatId, [
        'Hey! I am your fitness buddy 💪',
        '',
        'I will help you stay on track without making fitness feel so stressful:',
        '🥩 daily protein, carbs, fiber, fats, and calories',
        '📸 meal photo estimates',
        '🏋️ workout plans based on the gym equipment you have',
        '',
        'Send /profile and we will set your targets together. Small steps count, okay? ✨'
      ].join('\n'));
      await logBotEvent({ userId, chatId, text, action: 'start', status: 'ok' });
      return;
    }

    if (text === '/profile') {
      await sendTelegramMessage(chatId, [
        'Yess, let us set your profile first 💪',
        'Once I know your body data and goal, I can help you count what is left for the day.',
        '',
        'For this first setup, reply in this format:',
        'sex, age, height cm, weight kg, goal, activity level, training days',
        '',
        'Example:',
        'female, 28, 165, 58, fat loss, moderate, 4',
        '',
        'Do not worry if it is not perfect. We can adjust later ✨'
      ].join('\n'));
      await logBotEvent({ userId, chatId, text, action: 'profile_prompt', status: 'ok' });
      return;
    }

    if (text === '/health') {
      await sendTelegramMessage(chatId, 'All good, I am connected and ready to help you stay consistent 💪✨');
      await logBotEvent({ userId, chatId, text, action: 'health', status: 'ok' });
      return;
    }

    await sendTelegramMessage(chatId, [
      'I am here with you 💪',
      'Start with /profile so I can calculate your daily targets.',
      '',
      'After that, we will track meals, see how much protein/fiber is left, and keep going step by step ✨'
    ].join('\n'));
    await logBotEvent({ userId, chatId, text, action: 'fallback', status: 'ok' });
  } catch (error) {
    await safeSendTelegramMessage(chatId, 'Oops, I hit a setup error 😭 Please ask Chloe to check the backend settings. We are close, do not give up 💪');
    await logBotEvent({ userId, chatId, text, action: 'error', status: 'error', errorMessage: error.message });
  }
}

async function upsertTelegramUser({ chatId, from }) {
  if (!from || !from.id) return;

  const displayName = [from.first_name, from.last_name].filter(Boolean).join(' ').trim();
  const payload = {
    telegram_user_id: from.id,
    telegram_chat_id: chatId,
    username: from.username || null,
    first_name: from.first_name || null,
    display_name: displayName || from.username || String(from.id),
    updated_at: new Date().toISOString()
  };

  await supabaseFetch(`${SUPABASE_TABLES.USERS}?on_conflict=telegram_user_id`, {
    method: 'POST',
    headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify(payload)
  });
}

async function logBotEvent({ userId, chatId, text, action, status, errorMessage = '' }) {
  try {
    await supabaseFetch(SUPABASE_TABLES.BOT_LOGS, {
      method: 'POST',
      body: JSON.stringify({
        telegram_user_id: userId || null,
        telegram_chat_id: chatId || null,
        message_type: 'telegram',
        user_message: text || '',
        bot_action: action,
        status,
        error_message: errorMessage
      })
    });
  } catch (error) {
    console.error('failed to write bot log', error);
  }
}

async function sendTelegramMessage(chatId, text) {
  const token = requireEnv('TELEGRAM_BOT_TOKEN');
  const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text })
  });

  if (!response.ok) {
    throw new Error(`Telegram sendMessage failed: ${response.status} ${await response.text()}`);
  }
}

async function safeSendTelegramMessage(chatId, text) {
  try {
    await sendTelegramMessage(chatId, text);
  } catch (error) {
    console.error('failed to send fallback Telegram message', error);
  }
}

async function supabaseFetch(path, options = {}) {
  const baseUrl = normalizeSupabaseUrl(requireEnv('SUPABASE_URL'));
  const key = requireEnv('SUPABASE_SERVICE_ROLE_KEY');
  const response = await fetch(`${baseUrl}/rest/v1/${path}`, {
    ...options,
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
      ...(options.headers || {})
    }
  });

  if (!response.ok) {
    throw new Error(`Supabase request failed: ${response.status} ${await response.text()}`);
  }

  const text = await response.text();
  return text ? JSON.parse(text) : null;
}

function normalizeSupabaseUrl(url) {
  return url.replace(/\/rest\/v1\/?$/, '').replace(/\/$/, '');
}

function requireEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing environment variable: ${name}`);
  return value;
}
