const SUPABASE_TABLES = {
  USERS: 'users',
  TARGETS: 'nutrition_targets',
  MEALS: 'meal_logs',
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
    const user = await upsertTelegramUser({ chatId, from });

    if (message.photo && message.photo.length) {
      try {
        await handleMealPhoto({ chatId, userId, user, message, caption: text });
        await logBotEvent({ userId, chatId, text, action: 'meal_photo', status: 'ok' });
      } catch (error) {
        console.error('meal photo error', error);
        await sendTelegramMessage(chatId, buildPhotoErrorReply(error));
        await logBotEvent({ userId, chatId, text, action: 'meal_photo', status: 'error', errorMessage: error.message });
      }
      return;
    }

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
        'Just tell me naturally. No need to follow a strict form.',
        '',
        'Example:',
        'I am female, 27, 160cm, 67kg, want to reach 60kg, train 3 days a week',
        '',
        '中文也可以:',
        '女生 27岁 160cm 67kg 想瘦到60kg 一周练3天',
        '',
        'Send it your way. I will try my best to understand you ✨'
      ].join('\n'));
      await logBotEvent({ userId, chatId, text, action: 'profile_prompt', status: 'ok' });
      return;
    }

    const profileDraft = parseProfileDraft(text);
    if (profileDraft && profileDraft.profile) {
      const updatedUser = await updateUserProfile(user.id, profileDraft.profile);
      const targets = calculateTargets(profileDraft.profile);
      await saveNutritionTargets(updatedUser.id, targets);
      await sendTelegramMessage(chatId, buildTargetsReply(profileDraft.profile, targets));
      await logBotEvent({ userId, chatId, text, action: 'profile_saved', status: 'ok' });
      return;
    }

    if (profileDraft && profileDraft.isProfileLike) {
      await sendTelegramMessage(chatId, buildMissingProfileReply(profileDraft));
      await logBotEvent({ userId, chatId, text, action: 'profile_needs_more_info', status: 'ok' });
      return;
    }

    const profile = parseProfileText(text);
    if (profile) {
      const updatedUser = await updateUserProfile(user.id, profile);
      const targets = calculateTargets(profile);
      await saveNutritionTargets(updatedUser.id, targets);
      await sendTelegramMessage(chatId, buildTargetsReply(profile, targets));
      await logBotEvent({ userId, chatId, text, action: 'profile_saved', status: 'ok' });
      return;
    }

    if (text === '/targets') {
      const targets = await getActiveTargets(user.id);
      if (!targets) {
        await sendTelegramMessage(chatId, 'I do not have your targets yet. Send /profile first and we will set them up together 💪');
      } else {
        await sendTelegramMessage(chatId, buildExistingTargetsReply(targets));
      }
      await logBotEvent({ userId, chatId, text, action: 'targets', status: 'ok' });
      return;
    }

    if (text === '/health') {
      await sendTelegramMessage(chatId, 'All good, I am connected and ready to help you stay consistent 💪✨');
      await logBotEvent({ userId, chatId, text, action: 'health', status: 'ok' });
      return;
    }

    const targets = await getActiveTargets(user.id);
    await sendTelegramMessage(chatId, buildFallbackReply(Boolean(targets)));
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
    headers: { Prefer: 'resolution=merge-duplicates,return=representation' },
    body: JSON.stringify(payload)
  });

  const rows = await supabaseFetch(`${SUPABASE_TABLES.USERS}?telegram_user_id=eq.${from.id}&select=*`, {
    method: 'GET'
  });
  return rows && rows[0];
}

async function updateUserProfile(userId, profile) {
  const rows = await supabaseFetch(`${SUPABASE_TABLES.USERS}?id=eq.${userId}`, {
    method: 'PATCH',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify({
      sex: profile.sex,
      age: profile.age,
      height_cm: profile.heightCm,
      weight_kg: profile.weightKg,
      goal_type: profile.goalType,
      target_weight_kg: profile.targetWeightKg,
      activity_level: profile.activityLevel,
      training_days_per_week: profile.trainingDays,
      profile_status: 'complete',
      updated_at: new Date().toISOString()
    })
  });
  return rows && rows[0];
}

async function saveNutritionTargets(userId, targets) {
  await supabaseFetch(`${SUPABASE_TABLES.TARGETS}?user_id=eq.${userId}&active=eq.true`, {
    method: 'PATCH',
    body: JSON.stringify({ active: false, updated_at: new Date().toISOString() })
  });

  return supabaseFetch(SUPABASE_TABLES.TARGETS, {
    method: 'POST',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify({
      user_id: userId,
      bmr: targets.bmr,
      tdee: targets.tdee,
      target_calories: targets.targetCalories,
      protein_g: targets.proteinG,
      carbs_g: targets.carbsG,
      fat_g: targets.fatG,
      fiber_g: targets.fiberG,
      calculation_note: targets.note,
      active: true
    })
  });
}

async function getActiveTargets(userId) {
  const rows = await supabaseFetch(
    `${SUPABASE_TABLES.TARGETS}?user_id=eq.${userId}&active=eq.true&select=*&order=created_at.desc&limit=1`,
    { method: 'GET' }
  );
  return rows && rows[0];
}

async function handleMealPhoto({ chatId, userId, user, message, caption }) {
  const targets = await getActiveTargets(user.id);
  if (!targets) {
    await sendTelegramMessage(chatId, [
      'I can read meal photos, but I need your targets first 💪',
      'Send /profile and tell me your body data naturally.',
      '',
      'Example: 女生 27岁 160cm 67kg 想瘦到60kg 一周练3天 ✨'
    ].join('\n'));
    return;
  }

  await sendTelegramMessage(chatId, 'Got your meal photo 📸 Give me a moment, I am estimating it now...');

  const photo = message.photo[message.photo.length - 1];
  const image = await downloadTelegramPhoto(photo.file_id);
  const consumedBefore = await getTodayConsumed(user.id);
  const estimate = await analyzeMealImage({
    imageBase64: image.base64,
    mimeType: image.mimeType,
    caption,
    targets,
    consumedBefore
  });

  if (estimate.needs_clarification) {
    await sendTelegramMessage(chatId, estimate.clarifying_question || 'I need a little more info about this meal. What food is this and roughly how much?');
    return;
  }

  await saveMealLog({
    userId: user.id,
    photo,
    caption,
    estimate
  });

  const consumedAfter = addMealToConsumed(consumedBefore, estimate);
  await sendTelegramMessage(chatId, buildMealEstimateReply({ estimate, targets, consumedAfter }));
}

async function downloadTelegramPhoto(fileId) {
  const token = requireEnv('TELEGRAM_BOT_TOKEN');
  const fileResponse = await fetch(`https://api.telegram.org/bot${token}/getFile?file_id=${encodeURIComponent(fileId)}`);
  if (!fileResponse.ok) {
    throw new Error(`Telegram getFile failed: ${fileResponse.status} ${await fileResponse.text()}`);
  }

  const fileJson = await fileResponse.json();
  const filePath = fileJson.result && fileJson.result.file_path;
  if (!filePath) throw new Error('Telegram did not return a file path for this photo.');

  const imageResponse = await fetch(`https://api.telegram.org/file/bot${token}/${filePath}`);
  if (!imageResponse.ok) {
    throw new Error(`Telegram photo download failed: ${imageResponse.status} ${await imageResponse.text()}`);
  }

  const arrayBuffer = await imageResponse.arrayBuffer();
  const headerMimeType = imageResponse.headers.get('content-type');
  const mimeType = isSupportedImageMime(headerMimeType) ? headerMimeType : guessMimeType(filePath);
  return {
    base64: Buffer.from(arrayBuffer).toString('base64'),
    mimeType
  };
}

async function analyzeMealImage({ imageBase64, mimeType, caption, targets, consumedBefore }) {
  const prompt = [
    'You are a warm fitness nutrition assistant.',
    'Estimate nutrition from the meal image and caption.',
    'Be honest: photo nutrition is an estimate, not exact.',
    'Use common Malaysian and Asian food assumptions when relevant.',
    'If the photo is too unclear, return needs_clarification true.',
    '',
    `Caption: ${caption || '(none)'}`,
    '',
    'Daily targets:',
    `Calories ${targets.target_calories}, protein ${targets.protein_g}g, carbs ${targets.carbs_g}g, fat ${targets.fat_g}g, fiber ${targets.fiber_g}g.`,
    '',
    'Consumed today before this meal:',
    `Calories ${consumedBefore.calories}, protein ${consumedBefore.proteinG}g, carbs ${consumedBefore.carbsG}g, fat ${consumedBefore.fatG}g, fiber ${consumedBefore.fiberG}g.`,
    '',
    'Return JSON only with this shape:',
    '{"needs_clarification":false,"clarifying_question":"","foods":[""],"portion_assumption":"","calories":0,"protein_g":0,"carbs_g":0,"fat_g":0,"fiber_g":0,"confidence":"low|medium|high","tip":""}'
  ].join('\n');

  if (process.env.GEMINI_API_KEY) {
    return analyzeMealImageWithGemini({ imageBase64, mimeType, prompt });
  }

  if (!process.env.OPENAI_API_KEY) {
    throw new Error('Missing image AI key: add GEMINI_API_KEY or OPENAI_API_KEY');
  }

  return analyzeMealImageWithOpenAI({ imageBase64, mimeType, prompt });
}

async function analyzeMealImageWithGemini({ imageBase64, mimeType, prompt }) {
  const model = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
  const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
    method: 'POST',
    headers: {
      'x-goog-api-key': requireEnv('GEMINI_API_KEY'),
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      contents: [
        {
          parts: [
            {
              inline_data: {
                mime_type: mimeType,
                data: imageBase64
              }
            },
            { text: prompt }
          ]
        }
      ],
      generationConfig: {
        temperature: 0.2,
        response_mime_type: 'application/json'
      }
    })
  });

  if (!response.ok) {
    throw new Error(`Gemini image analysis failed: ${response.status} ${await response.text()}`);
  }

  const json = await response.json();
  const outputText = extractGeminiText(json);
  const parsed = parseJsonFromText(outputText);
  return normalizeMealEstimate(parsed, {
    provider: 'gemini',
    model,
    output_text: outputText
  });
}

async function analyzeMealImageWithOpenAI({ imageBase64, mimeType, prompt }) {
  const response = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${requireEnv('OPENAI_API_KEY')}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: 'gpt-4.1-mini',
      input: [
        {
          role: 'user',
          content: [
            { type: 'input_text', text: prompt },
            {
              type: 'input_image',
              image_url: `data:${mimeType};base64,${imageBase64}`,
              detail: 'low'
            }
          ]
        }
      ]
    })
  });

  if (!response.ok) {
    throw new Error(`OpenAI image analysis failed: ${response.status} ${await response.text()}`);
  }

  const json = await response.json();
  const outputText = extractOpenAIText(json);
  const parsed = parseJsonFromText(outputText);
  return normalizeMealEstimate(parsed, json);
}

async function saveMealLog({ userId, photo, caption, estimate }) {
  return supabaseFetch(SUPABASE_TABLES.MEALS, {
    method: 'POST',
    headers: { Prefer: 'return=minimal' },
    body: JSON.stringify({
      user_id: userId,
      telegram_file_id: photo.file_id || null,
      telegram_file_unique_id: photo.file_unique_id || null,
      caption: caption || '',
      detected_foods: estimate.foods || [],
      portion_assumption: estimate.portion_assumption || '',
      calories: estimate.calories || 0,
      protein_g: estimate.protein_g || 0,
      carbs_g: estimate.carbs_g || 0,
      fat_g: estimate.fat_g || 0,
      fiber_g: estimate.fiber_g || 0,
      confidence: estimate.confidence || 'low',
      ai_notes: estimate.tip || '',
      raw_ai_response: estimate.raw || null
    })
  });
}

async function getTodayConsumed(userId) {
  const today = new Date().toISOString().slice(0, 10);
  const rows = await supabaseFetch(
    `${SUPABASE_TABLES.MEALS}?user_id=eq.${userId}&log_date=eq.${today}&select=calories,protein_g,carbs_g,fat_g,fiber_g`,
    { method: 'GET' }
  );

  return (rows || []).reduce((total, row) => ({
    calories: total.calories + Number(row.calories || 0),
    proteinG: total.proteinG + Number(row.protein_g || 0),
    carbsG: total.carbsG + Number(row.carbs_g || 0),
    fatG: total.fatG + Number(row.fat_g || 0),
    fiberG: total.fiberG + Number(row.fiber_g || 0)
  }), { calories: 0, proteinG: 0, carbsG: 0, fatG: 0, fiberG: 0 });
}

function addMealToConsumed(consumed, estimate) {
  return {
    calories: consumed.calories + Number(estimate.calories || 0),
    proteinG: consumed.proteinG + Number(estimate.protein_g || 0),
    carbsG: consumed.carbsG + Number(estimate.carbs_g || 0),
    fatG: consumed.fatG + Number(estimate.fat_g || 0),
    fiberG: consumed.fiberG + Number(estimate.fiber_g || 0)
  };
}

function buildMealEstimateReply({ estimate, targets, consumedAfter }) {
  const remainingProtein = Math.max(0, Math.round(Number(targets.protein_g || 0) - consumedAfter.proteinG));
  const remainingCarbs = Math.max(0, Math.round(Number(targets.carbs_g || 0) - consumedAfter.carbsG));
  const remainingFiber = Math.max(0, Math.round(Number(targets.fiber_g || 0) - consumedAfter.fiberG));
  const remainingCalories = Math.max(0, Math.round(Number(targets.target_calories || 0) - consumedAfter.calories));
  const foods = Array.isArray(estimate.foods) && estimate.foods.length ? estimate.foods.join(', ') : 'Meal from photo';

  return [
    'Meal estimate 📸',
    `Food: ${foods}`,
    estimate.portion_assumption ? `Portion: ${estimate.portion_assumption}` : '',
    '',
    `🔥 Calories: ${Math.round(estimate.calories)} kcal`,
    `🥩 Protein: ${Math.round(estimate.protein_g)}g`,
    `🍚 Carbs: ${Math.round(estimate.carbs_g)}g`,
    `🥑 Fat: ${Math.round(estimate.fat_g)}g`,
    `🥦 Fiber: ${Math.round(estimate.fiber_g)}g`,
    '',
    'Today so far:',
    `🔥 Calories: ${Math.round(consumedAfter.calories)} / ${targets.target_calories}`,
    `🥩 Protein: ${Math.round(consumedAfter.proteinG)} / ${targets.protein_g}g`,
    `🍚 Carbs: ${Math.round(consumedAfter.carbsG)} / ${targets.carbs_g}g`,
    `🥦 Fiber: ${Math.round(consumedAfter.fiberG)} / ${targets.fiber_g}g`,
    '',
    'Still left:',
    `🥩 Protein: ${remainingProtein}g`,
    `🍚 Carbs: ${remainingCarbs}g`,
    `🥦 Fiber: ${remainingFiber}g`,
    `🔥 Calories: ${remainingCalories} kcal`,
    '',
    estimate.tip || `加油, protein 还剩 ${remainingProtein}g. We can close it with the next meal 💪`,
    `Confidence: ${estimate.confidence || 'low'}`
  ].filter(Boolean).join('\n');
}

function parseProfileText(text) {
  if (!text || text.startsWith('/')) return null;
  const parts = text.split(',').map((part) => part.trim()).filter(Boolean);
  if (parts.length < 7) return null;

  const sex = normalizeSex(parts[0]);
  const age = toNumber(parts[1]);
  const heightCm = toNumber(parts[2]);
  const weightKg = toNumber(parts[3]);
  const fifth = parts[4].toLowerCase();
  const activityLevel = normalizeActivity(parts[5]);
  const trainingDays = Math.round(toNumber(parts[6]));

  if (!sex || !age || !heightCm || !weightKg || !activityLevel || Number.isNaN(trainingDays)) {
    return null;
  }

  let goalType = normalizeGoal(fifth);
  let targetWeightKg = null;

  if (!goalType) {
    targetWeightKg = toNumber(fifth);
    if (!targetWeightKg) return null;
    goalType = inferGoalFromTarget(weightKg, targetWeightKg);
  }

  return {
    sex,
    age,
    heightCm,
    weightKg,
    goalType,
    targetWeightKg,
    activityLevel,
    trainingDays: Math.max(0, Math.min(trainingDays, 7))
  };
}

function parseProfileDraft(text) {
  if (!text || text.startsWith('/')) return null;
  const commaProfile = parseProfileText(text);
  if (commaProfile) return { isProfileLike: true, profile: commaProfile, missing: [] };

  const normalized = normalizeMessage(text);
  const sex = extractSex(normalized);
  const age = extractAge(normalized);
  const heightCm = extractHeight(normalized);
  const weights = extractWeights(normalized);
  const weightKg = weights.current;
  const targetWeightKg = weights.target;
  const explicitGoal = normalizeGoal(normalized);
  const trainingDays = extractTrainingDays(normalized);
  const activityLevel = extractActivity(normalized, trainingDays);
  const goalType = explicitGoal || (weightKg && targetWeightKg ? inferGoalFromTarget(weightKg, targetWeightKg) : null);

  const fields = { sex, age, heightCm, weightKg, goalType, activityLevel, trainingDays };
  const presentCount = Object.values(fields).filter((value) => value !== null && value !== undefined && !Number.isNaN(value)).length;
  const isProfileLike = presentCount >= 3 || /profile|target|goal|weight|height|protein|calorie|女生|男生|身高|体重|目标|瘦|增肌|减脂|一周|训练|健身/i.test(normalized);
  if (!isProfileLike) return null;

  const missing = [];
  if (!sex) missing.push('sex');
  if (!age) missing.push('age');
  if (!heightCm) missing.push('height');
  if (!weightKg) missing.push('current weight');
  if (!goalType && !targetWeightKg) missing.push('goal or target weight');
  if (!activityLevel) missing.push('activity level');
  if (trainingDays === null || Number.isNaN(trainingDays)) missing.push('training days per week');

  if (missing.length) {
    return {
      isProfileLike: true,
      missing,
      understood: {
        sex,
        age,
        heightCm,
        weightKg,
        targetWeightKg,
        goalType,
        activityLevel,
        trainingDays
      }
    };
  }

  return {
    isProfileLike: true,
    missing: [],
    profile: {
      sex,
      age,
      heightCm,
      weightKg,
      goalType,
      targetWeightKg: targetWeightKg || null,
      activityLevel,
      trainingDays: Math.max(0, Math.min(Math.round(trainingDays), 7))
    }
  };
}

function calculateTargets(profile) {
  const isMale = profile.sex === 'male';
  const bmr = isMale
    ? 10 * profile.weightKg + 6.25 * profile.heightCm - 5 * profile.age + 5
    : 10 * profile.weightKg + 6.25 * profile.heightCm - 5 * profile.age - 161;

  const multipliers = {
    sedentary: 1.2,
    light: 1.375,
    moderate: 1.55,
    active: 1.725,
    'very active': 1.9
  };
  const tdee = bmr * multipliers[profile.activityLevel];
  const adjustments = {
    'fat loss': 0.85,
    'muscle gain': 1.1,
    maintenance: 1,
    recomposition: 0.95
  };
  const targetCalories = tdee * adjustments[profile.goalType];
  const proteinRate = profile.goalType === 'fat loss' ? 2 : profile.goalType === 'maintenance' ? 1.6 : 1.8;
  const proteinG = profile.weightKg * proteinRate;
  const fatG = profile.weightKg * 0.8;
  const carbsG = Math.max(0, (targetCalories - proteinG * 4 - fatG * 9) / 4);
  const fiberG = Math.min(35, Math.max(25, targetCalories / 1000 * 14));

  return {
    bmr: Math.round(bmr),
    tdee: Math.round(tdee),
    targetCalories: Math.round(targetCalories),
    proteinG: Math.round(proteinG),
    carbsG: Math.round(carbsG),
    fatG: Math.round(fatG),
    fiberG: Math.round(fiberG),
    note: 'Mifflin-St Jeor estimate with MVP macro rules.'
  };
}

function buildTargetsReply(profile, targets) {
  const targetLine = profile.targetWeightKg ? `Target weight: ${profile.targetWeightKg}kg\n` : '';
  return [
    'Profile saved! Nice start 💪✨',
    '',
    `Goal: ${formatGoal(profile.goalType)}`,
    targetLine.trim(),
    'Your daily targets:',
    `🔥 Calories: ${targets.targetCalories} kcal`,
    `🥩 Protein: ${targets.proteinG}g`,
    `🍚 Carbs: ${targets.carbsG}g`,
    `🥑 Fat: ${targets.fatG}g`,
    `🥦 Fiber: ${targets.fiberG}g`,
    '',
    `Protein goal is ${targets.proteinG}g. 加油, we will close it meal by meal 💪`,
    'Next: send /targets anytime to see this again.'
  ].filter(Boolean).join('\n');
}

function buildMissingProfileReply(draft) {
  const understoodLines = [];
  const data = draft.understood || {};
  if (data.sex) understoodLines.push(`Sex: ${data.sex}`);
  if (data.age) understoodLines.push(`Age: ${data.age}`);
  if (data.heightCm) understoodLines.push(`Height: ${data.heightCm}cm`);
  if (data.weightKg) understoodLines.push(`Current weight: ${data.weightKg}kg`);
  if (data.targetWeightKg) understoodLines.push(`Target weight: ${data.targetWeightKg}kg`);
  if (data.goalType) understoodLines.push(`Goal: ${formatGoal(data.goalType)}`);
  if (data.activityLevel) understoodLines.push(`Activity: ${data.activityLevel}`);
  if (data.trainingDays !== null && data.trainingDays !== undefined && !Number.isNaN(data.trainingDays)) {
    understoodLines.push(`Training: ${data.trainingDays} days/week`);
  }

  return [
    'I think I got part of it 💪',
    understoodLines.length ? understoodLines.join('\n') : '',
    '',
    `Can you send me the missing part: ${draft.missing.join(', ')}?`,
    '',
    'You can reply naturally, for example:',
    '女生 27岁 160cm 67kg 想瘦到60kg 一周练3天 ✨'
  ].filter(Boolean).join('\n');
}

function buildExistingTargetsReply(targets) {
  return [
    'Here are your daily targets 💪',
    '',
    `🔥 Calories: ${targets.target_calories} kcal`,
    `🥩 Protein: ${targets.protein_g}g`,
    `🍚 Carbs: ${targets.carbs_g}g`,
    `🥑 Fat: ${targets.fat_g}g`,
    `🥦 Fiber: ${targets.fiber_g}g`,
    '',
    'Keep going. One good meal at a time ✨'
  ].join('\n');
}

function normalizeSex(value) {
  const text = String(value || '').toLowerCase();
  if (['female', 'f', 'woman', 'girl'].includes(text) || /\b(female|woman|girl)\b|女生|女性|女孩子|女\b/.test(text)) return 'female';
  if (['male', 'm', 'man', 'boy'].includes(text) || /\b(male|man|boy)\b|男生|男性|男孩子|男\b/.test(text)) return 'male';
  return null;
}

function normalizeGoal(value) {
  const text = String(value || '').toLowerCase().replace(/[_-]/g, ' ').trim();
  if (['fat loss', 'lose fat', 'cut', 'weight loss', 'slim'].includes(text) || /\b(fat loss|lose fat|weight loss|slim|cut)\b|减脂|减肥|瘦|想瘦|变瘦/.test(text)) return 'fat loss';
  if (['muscle gain', 'gain muscle', 'bulk', 'build muscle'].includes(text) || /\b(muscle gain|gain muscle|build muscle|bulk)\b|增肌|长肌肉|练大/.test(text)) return 'muscle gain';
  if (['maintenance', 'maintain'].includes(text) || /\b(maintenance|maintain)\b/.test(text)) return 'maintenance';
  if (['recomposition', 'recomp', 'body recomposition'].includes(text) || /\b(recomposition|recomp|body recomposition)\b|塑形|体态|线条/.test(text)) return 'recomposition';
  return null;
}

function inferGoalFromTarget(weightKg, targetWeightKg) {
  if (targetWeightKg < weightKg - 1) return 'fat loss';
  if (targetWeightKg > weightKg + 1) return 'muscle gain';
  return 'maintenance';
}

function normalizeActivity(value) {
  const text = String(value || '').toLowerCase().replace(/[_-]/g, ' ').trim();
  if (['sedentary', 'low'].includes(text) || /久坐|很少动|不太动/.test(text)) return 'sedentary';
  if (['light', 'lightly active'].includes(text) || /轻度|偶尔|少量/.test(text)) return 'light';
  if (['moderate', 'moderately active', 'medium'].includes(text) || /中等|普通|一般/.test(text)) return 'moderate';
  if (['active', 'high'].includes(text) || /活跃|经常|高活动/.test(text)) return 'active';
  if (['very active', 'very'].includes(text) || /非常活跃|每天练|运动量很大/.test(text)) return 'very active';
  return null;
}

function normalizeMessage(text) {
  return String(text || '')
    .replace(/[，。；;|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function extractSex(text) {
  return normalizeSex(text);
}

function extractAge(text) {
  const explicit = text.match(/(\d{1,2})\s*(岁|years?\s*old|yo|y\/o)/i);
  if (explicit) return Number(explicit[1]);
  const intro = text.match(/\b(?:age|aged)\s*(?:is|:)?\s*(\d{1,2})\b/i);
  if (intro) return Number(intro[1]);
  const numbers = getNumbers(text);
  return numbers.find((number) => number >= 13 && number <= 85) || null;
}

function extractHeight(text) {
  const explicit = text.match(/(\d{2,3}(?:\.\d+)?)\s*(cm|厘米|公分)/i);
  if (explicit) return Number(explicit[1]);
  const labeled = text.match(/(?:height|身高)\s*(?:is|:)?\s*(\d{2,3}(?:\.\d+)?)/i);
  if (labeled) return Number(labeled[1]);
  return null;
}

function extractWeights(text) {
  const weightMatches = [...text.matchAll(/(\d{2,3}(?:\.\d+)?)\s*(kg|公斤|kilo|kilogram)/gi)].map((match) => Number(match[1]));
  let current = weightMatches[0] || null;
  let target = weightMatches[1] || null;

  const currentMatch = text.match(/(?:current weight|weight|体重|现在|目前)\s*(?:is|:)?\s*(\d{2,3}(?:\.\d+)?)/i);
  if (currentMatch) current = Number(currentMatch[1]);

  const targetMatch = text.match(/(?:target|goal weight|目标|瘦到|减到|到|reach)\s*(?:is|:)?\s*(\d{2,3}(?:\.\d+)?)/i);
  if (targetMatch) target = Number(targetMatch[1]);

  return { current, target };
}

function extractTrainingDays(text) {
  const explicit = text.match(/(\d(?:\.\d+)?)\s*(days?|天|次)\s*(?:a|per)?\s*(?:week|weekly|每周|一周)?/i);
  if (explicit) return Number(explicit[1]);
  const cn = text.match(/(?:一周|每周|weekly|week)\s*(?:练|训练|workout|train)?\s*(\d(?:\.\d+)?)\s*(?:天|次|days?)?/i);
  if (cn) return Number(cn[1]);
  return null;
}

function extractActivity(text, trainingDays) {
  const activity = normalizeActivity(text);
  if (activity) return activity;
  if (trainingDays === null || trainingDays === undefined || Number.isNaN(trainingDays)) return null;
  if (trainingDays <= 1) return 'light';
  if (trainingDays <= 4) return 'moderate';
  if (trainingDays <= 6) return 'active';
  return 'very active';
}

function getNumbers(text) {
  return [...String(text || '').matchAll(/\d+(?:\.\d+)?/g)].map((match) => Number(match[0]));
}

function formatGoal(goal) {
  return goal.replace(/\b\w/g, (char) => char.toUpperCase());
}

function toNumber(value) {
  const match = String(value || '').match(/-?\d+(\.\d+)?/);
  return match ? Number(match[0]) : NaN;
}

function extractOpenAIText(response) {
  if (response.output_text) return response.output_text;
  const output = response.output || [];
  const texts = [];
  for (const item of output) {
    for (const content of item.content || []) {
      if (content.type === 'output_text' && content.text) texts.push(content.text);
      if (content.type === 'text' && content.text) texts.push(content.text);
    }
  }
  return texts.join('\n').trim();
}

function extractGeminiText(response) {
  const candidates = response.candidates || [];
  const texts = [];
  for (const candidate of candidates) {
    for (const part of (candidate.content && candidate.content.parts) || []) {
      if (part.text) texts.push(part.text);
    }
  }
  return texts.join('\n').trim();
}

function parseJsonFromText(text) {
  const cleaned = String(text || '').trim().replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```$/i, '').trim();
  try {
    return JSON.parse(cleaned);
  } catch (error) {
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (match) return JSON.parse(match[0]);
    throw error;
  }
}

function normalizeMealEstimate(estimate, raw) {
  const outputText = raw && raw.provider === 'gemini' ? raw.output_text : extractOpenAIText(raw || {});
  return {
    needs_clarification: Boolean(estimate.needs_clarification),
    clarifying_question: estimate.clarifying_question || '',
    foods: Array.isArray(estimate.foods) ? estimate.foods.map(String).slice(0, 8) : [],
    portion_assumption: estimate.portion_assumption || '',
    calories: safeMacroNumber(estimate.calories),
    protein_g: safeMacroNumber(estimate.protein_g),
    carbs_g: safeMacroNumber(estimate.carbs_g),
    fat_g: safeMacroNumber(estimate.fat_g),
    fiber_g: safeMacroNumber(estimate.fiber_g),
    confidence: ['low', 'medium', 'high'].includes(estimate.confidence) ? estimate.confidence : 'low',
    tip: estimate.tip || '',
    raw: {
      provider: raw && raw.provider ? raw.provider : 'openai',
      id: raw && raw.id,
      model: raw && raw.model,
      output_text: outputText.slice(0, 2000)
    }
  };
}

function safeMacroNumber(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) return 0;
  return Math.round(number);
}

function guessMimeType(filePath) {
  const lower = String(filePath || '').toLowerCase();
  if (lower.endsWith('.png')) return 'image/png';
  if (lower.endsWith('.webp')) return 'image/webp';
  if (lower.endsWith('.gif')) return 'image/gif';
  return 'image/jpeg';
}

function isSupportedImageMime(mimeType) {
  return ['image/jpeg', 'image/png', 'image/webp', 'image/gif'].includes(String(mimeType || '').toLowerCase());
}

function buildFallbackReply(hasTargets) {
  if (hasTargets) {
    return [
      'I have your profile saved already 💪',
      '',
      'You can send me:',
      '📸 a meal photo, like "mala panmee"',
      '🎯 /targets to see your daily goals',
      '🏋️ what you want to train and what machines you have',
      '',
      'No need to set profile again. We keep going from here ✨'
    ].join('\n');
  }

  return [
    'I am here with you 💪',
    'Send /profile first so I can calculate your daily targets.',
    '',
    'After that, you can send meal photos and I will track what is left for the day ✨'
  ].join('\n');
}

function buildPhotoErrorReply(error) {
  const message = String(error && error.message ? error.message : error);

  if (/Missing environment variable: OPENAI_API_KEY/.test(message)) {
    return [
      'I can see your meal photo, but my AI vision key is not connected yet 😭',
      'Chloe needs to add `GEMINI_API_KEY` or `OPENAI_API_KEY` in Vercel Environment Variables, then redeploy.',
      '',
      'After that, send the meal photo again and I will estimate calories + protein + carbs + fiber 💪'
    ].join('\n');
  }

  if (/Missing image AI key|Missing environment variable: GEMINI_API_KEY/.test(message)) {
    return [
      'I can see your meal photo, but Gemini is not connected yet 😭',
      'Chloe needs to add `GEMINI_API_KEY` in Vercel Environment Variables, then redeploy.',
      '',
      'After that, send the meal photo again and I will estimate calories + protein + carbs + fiber 💪'
    ].join('\n');
  }

  if (/Gemini image analysis failed: 400/.test(message)) {
    return [
      'I tried to read the meal photo with Gemini, but the image request was rejected 😭',
      'Please try sending the photo again as a normal Telegram photo with a short caption.',
      '',
      'If it repeats, Chloe should check Vercel logs for the Gemini error.'
    ].join('\n');
  }

  if (/Gemini image analysis failed: 401|Gemini image analysis failed: 403/.test(message)) {
    return [
      'I tried to read the meal photo, but the Gemini API key is not allowed or not valid 😭',
      'Chloe needs to check `GEMINI_API_KEY` in Vercel, then redeploy.',
      '',
      'Once the key is fixed, I can estimate the meal properly 💪'
    ].join('\n');
  }

  if (/Gemini image analysis failed: 429/.test(message)) {
    return [
      'I tried to read the meal photo, but Gemini is rate-limiting or quota-limiting requests right now 😭',
      'Try again later, or Chloe can check Gemini API quota/limits for the key.',
      '',
      'We are close 💪'
    ].join('\n');
  }

  if (/Gemini image analysis failed/.test(message)) {
    return [
      'I tried to read the meal photo with Gemini, but the AI step failed 😭',
      'Please try one clearer photo with a short caption like "mala panmee".',
      '',
      'If it repeats, Chloe should check Vercel Function Logs for the Gemini error.'
    ].join('\n');
  }

  if (/OpenAI image analysis failed: 401/.test(message)) {
    return [
      'I tried to read the meal photo, but the OpenAI key looks invalid or expired 😭',
      'Chloe needs to check `OPENAI_API_KEY` in Vercel and redeploy.',
      '',
      'We are close. Once the key is fixed, I can estimate the meal properly 💪'
    ].join('\n');
  }

  if (/OpenAI image analysis failed: 429/.test(message)) {
    if (/insufficient_quota|quota|billing|credits/i.test(message)) {
      return [
        'I tried to read the meal photo, but the OpenAI account has no available quota/credits right now 😭',
        'Chloe needs to check OpenAI billing/credits first, then redeploy or try again.',
        '',
        'Once credits are active, send the meal photo again and I will estimate calories + protein + carbs + fiber 💪'
      ].join('\n');
    }

    return [
      'I tried to read the meal photo, but OpenAI is rate-limiting requests right now 😭',
      'Wait a short while and try again.',
      '',
      'If this keeps happening, Chloe should check OpenAI usage limits for this API key 💪'
    ].join('\n');
  }

  if (/OpenAI image analysis failed/.test(message)) {
    return [
      'I tried to read the meal photo, but the AI vision step failed 😭',
      'Please try one more time with a clearer photo and a short caption like "mala panmee".',
      '',
      'If it still fails, Chloe should check Vercel Function Logs for the OpenAI error.'
    ].join('\n');
  }

  if (/Telegram .*photo|Telegram getFile|Telegram photo download/.test(message)) {
    return 'I received the photo, but Telegram would not let me download it properly 😭 Please send it again as a normal photo, not a file.';
  }

  if (/Supabase request failed/.test(message)) {
    return [
      'I estimated the meal, but saving it to the database failed 😭',
      'Chloe should check Supabase tables and Vercel env keys.',
      '',
      'Do not worry, this is a setup issue, not your photo 💪'
    ].join('\n');
  }

  return [
    'I got your meal photo, but something broke while estimating it 😭',
    'Try sending it again with a short caption, for example: "mala panmee".',
    '',
    'If it repeats, Chloe can check Vercel Function Logs and we will fix it 💪'
  ].join('\n');
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
