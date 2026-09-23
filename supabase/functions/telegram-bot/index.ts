import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const BOT_TOKEN = Deno.env.get('TELEGRAM_BOT_TOKEN')!;
const TGAPI = `https://api.telegram.org/bot${BOT_TOKEN}`;

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

const ALLOWED_NAMES = ['alex', 'עילאי', 'ליטל', 'אינה'];
const REMINDER_DELAY = 15;

// Thrown when the database or dose-status function is unreachable/erroring,
// so we can tell the user "server busy" instead of crashing on a bad body.
class UpstreamError extends Error {}

async function supaFetch(path: string, options: RequestInit = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...options,
    headers: {
      'apikey': SERVICE_KEY,
      'Authorization': `Bearer ${SERVICE_KEY}`,
      'Content-Type': 'application/json',
      'Prefer': 'return=minimal',
      ...((options.headers as Record<string,string>) || {}),
    },
  });
  return res;
}

async function supaGet(path: string) {
  const res = await supaFetch(path);
  if (!res.ok) throw new UpstreamError(`GET ${path.split('?')[0]} failed: ${res.status}`);
  return res.json();
}

async function tgSend(chatId: number, text: string, replyMarkup?: any) {
  const body: any = { chat_id: chatId, text, parse_mode: 'HTML' };
  if (replyMarkup) body.reply_markup = replyMarkup;
  await fetch(`${TGAPI}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function tgAnswer(callbackId: string, text: string) {
  await fetch(`${TGAPI}/answerCallbackQuery`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ callback_query_id: callbackId, text }),
  });
}

async function tgEditMessage(chatId: number, messageId: number, text: string) {
  // Always clear the inline keyboard so a finished confirm/cancel/reminder
  // message can't be tapped again later and silently create a stray log.
  await fetch(`${TGAPI}/editMessageText`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, message_id: messageId, text, parse_mode: 'HTML', reply_markup: { inline_keyboard: [] } }),
  });
}

function getNowIsrael(): Date {
  return new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Jerusalem' }).replace(',', ''));
}

function getTodayStr(): string {
  const d = getNowIsrael();
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

// Dose schedule, scheduling windows, and log-matching all live in the shared
// dose-status function so the bot and the web app can never drift apart again.
type Dose = { index: number; hour: number; minute: number; label: string; status: string; given: boolean; givenBy: string | null; givenAt: string | null; logId: number | null };
type DoseStatus = { today: string; nowMin: number; currentDoseIndex: number; doses: Dose[] };

async function getDoseStatus(): Promise<DoseStatus> {
  const res = await fetch(`${SUPABASE_URL}/functions/v1/dose-status`, {
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` },
  });
  if (!res.ok) throw new UpstreamError(`dose-status failed: ${res.status}`);
  const data = await res.json();
  if (!Array.isArray(data?.doses)) throw new UpstreamError('dose-status returned no doses');
  return data;
}

function fmtTime(hour: number, minute: number) {
  return `${String(hour).padStart(2,'0')}:${String(minute).padStart(2,'0')}`;
}

async function givePill(name: string): Promise<boolean> {
  const res = await supaFetch('med_logs', {
    method: 'POST',
    body: JSON.stringify({ given_by: name }),
  });
  return res.ok;
}

async function getUser(chatId: number) {
  const users = await supaGet(`telegram_users?chat_id=eq.${chatId}`);
  return users.length > 0 ? users[0] : null;
}

async function registerUser(chatId: number, name: string) {
  await supaFetch('telegram_users', {
    method: 'POST',
    body: JSON.stringify({ chat_id: chatId, name }),
    headers: { 'Prefer': 'return=minimal' } as any,
  });
}

async function getAllUsers() {
  return await supaGet('telegram_users?select=chat_id,name');
}

async function handleUpdate(update: any) {
  if (update.message?.text) {
    const chatId = update.message.chat.id;
    const text = update.message.text.trim();

    if (text === '/start') {
      const user = await getUser(chatId);
      if (user) {
        await tgSend(chatId, `שלום ${user.name}! 👋\nאת/ה כבר רשום/ה.\n\n📌 <b>פקודות:</b>\n/give - נתתי כדור\n/status - סטטוס היום`);
      } else {
        await tgSend(chatId, '🐕💊 שלום! אני הבוט של זקי.\n\nמה השם שלך? (כתוב את השם שלך)');
      }
      return;
    }

    if (text === '/status') {
      const { doses } = await getDoseStatus();
      let msg = '📊 <b>סטטוס היום:</b>\n\n';
      for (const d of doses) {
        const time = fmtTime(d.hour, d.minute);
        msg += d.given ? `✅ ${d.label} (${time})\n` : `⬜ ${d.label} (${time})\n`;
      }
      await tgSend(chatId, msg);
      return;
    }

    if (text === '/give') {
      const user = await getUser(chatId);
      if (!user) {
        await tgSend(chatId, '❌ את/ה לא רשום/ה. שלח /start קודם.');
        return;
      }

      const { currentDoseIndex, nowMin, doses } = await getDoseStatus();
      if (currentDoseIndex < 0) {
        await tgSend(chatId, '⏳ עוד לא הגיע הזמן למנה הראשונה.\n\nהמנה הבאה: 07:30');
        return;
      }

      const doseIdx = currentDoseIndex;
      const dose = doses[doseIdx];

      if (dose.given) {
        // find next undone dose
        const next = doses.find(d => !d.given && (d.hour * 60 + d.minute) > nowMin);

        const allDone = doses.every(d => d.given);

        if (allDone) {
          await tgSend(chatId, '✅ כבר ניתן כדור למנת ' + dose.label + '!\n\n🎉 כל המנות ניתנו היום!');
        } else if (next) {
          const nextTime = fmtTime(next.hour, next.minute);
          await tgSend(chatId, '✅ כבר ניתן כדור למנת ' + dose.label + '!\n\nהמנה הבאה: ' + next.label + ' (' + nextTime + ')');
        } else {
          await tgSend(chatId, '✅ כבר ניתן כדור למנת ' + dose.label + '!');
        }
        return;
      }

      // send confirmation with button
      const time = fmtTime(dose.hour, dose.minute);
      await tgSend(
        chatId,
        `💊 <b>לתת כדור לזקי?</b>\n\nמנת ${dose.label} (${time})`,
        {
          inline_keyboard: [[
            { text: '✅ כן, נתתי!', callback_data: `give_${doseIdx}` },
            { text: '❌ לא', callback_data: 'cancel_give' }
          ]]
        }
      );
      return;
    }

    const user = await getUser(chatId);
    if (!user) {
      const name = text;
      if (!ALLOWED_NAMES.includes(name)) {
        await tgSend(chatId, `❌ השם "${name}" לא נמצא ברשימה.\nנסה שוב עם השם הנכון.`);
        return;
      }
      await registerUser(chatId, name);
      await tgSend(chatId, `✅ שלום ${name}! נרשמת בהצלחה.\n\n📌 <b>פקודות:</b>\n/give - נתתי כדור\n/status - סטטוס היום`);
      return;
    }
  }

  if (update.callback_query) {
    const cb = update.callback_query;
    const chatId = cb.message.chat.id;
    const messageId = cb.message.message_id;
    const data = cb.data;

    if (data === 'cancel_give') {
      await tgAnswer(cb.id, 'בוטל');
      await tgEditMessage(chatId, messageId, '❌ בוטל.');
      return;
    }

    if (data.startsWith('give_')) {
      const doseIdx = parseInt(data.split('_')[1]);
      const user = await getUser(chatId);

      if (!user) {
        await tgAnswer(cb.id, 'את/ה לא רשום/ה. שלח /start');
        return;
      }

      const { doses } = await getDoseStatus();
      const dose = doses[doseIdx];

      if (dose.given) {
        await tgAnswer(cb.id, 'כבר ניתן! ✅');
        await tgEditMessage(chatId, messageId, `✅ <b>כבר ניתן כדור למנת ${dose.label}!</b>`);
        return;
      }

      const ok = await givePill(user.name);
      if (ok) {
        await tgAnswer(cb.id, '✅ נשלח!');
        await tgEditMessage(chatId, messageId, `✅ <b>${user.name} נתן/ה כדור למנת ${dose.label}!</b> 🐕💊`);

        const allUsers = await getAllUsers();
        for (const u of allUsers) {
          if (u.chat_id !== chatId) {
            await tgSend(u.chat_id, `✅ ${user.name} נתן/ה כדור למנת ${dose.label}! 🐕💊`);
          }
        }
      } else {
        await tgAnswer(cb.id, '❌ שגיאה!');
      }
    }
  }
}

// Let the user know the server is having trouble, so a /give or button tap
// doesn't just silently do nothing. The pill was NOT recorded in this case.
async function notifyBusy(update: any) {
  const busy = '⚠️ השרת לא זמין כרגע, הכדור לא נרשם. נסו שוב בעוד דקה.';
  try {
    if (update.callback_query) {
      await tgAnswer(update.callback_query.id, busy);
    } else if (update.message?.chat?.id) {
      await tgSend(update.message.chat.id, busy);
    }
  } catch (e) {
    console.error('notifyBusy failed', e);
  }
}

async function sendReminders() {
  const { currentDoseIndex, nowMin, doses } = await getDoseStatus();
  if (currentDoseIndex < 0) return new Response('No dose now');

  const dose = doses[currentDoseIndex];
  const doseMin = dose.hour * 60 + dose.minute;
  const minSinceDose = nowMin - doseMin;

  if (minSinceDose < REMINDER_DELAY || minSinceDose > 60) {
    return new Response('Outside reminder window');
  }

  if (dose.given) {
    return new Response('Already given');
  }

  const today = getTodayStr();
  const existing = await supaGet(`telegram_reminders?dose_index=eq.${currentDoseIndex}&dose_date=eq.${today}&reminder_number=eq.1`);

  if (existing.length > 0) {
    return new Response('Reminder already sent');
  }

  await supaFetch('telegram_reminders', {
    method: 'POST',
    body: JSON.stringify({ dose_index: currentDoseIndex, dose_date: today, reminder_number: 1 }),
  });

  const users = await getAllUsers();
  const time = fmtTime(dose.hour, dose.minute);

  for (const user of users) {
    await tgSend(
      user.chat_id,
      `⚠️💊 <b>לא ניתן כדור לזקי!</b>\n\nמנת ${dose.label} (${time})\nכבר עברו ${REMINDER_DELAY} דקות!`,
      {
        inline_keyboard: [[
          { text: '✅ נתתי כדור!', callback_data: `give_${currentDoseIndex}` }
        ]]
      }
    );
  }

  return new Response(`Sent reminder to ${users.length} users`);
}

Deno.serve(async (req: Request) => {
  try {
    const url = new URL(req.url);

    if (url.searchParams.get('cron') === 'true') {
      return await sendReminders();
    }

    if (req.method === 'POST') {
      const update = await req.json();
      try {
        await handleUpdate(update);
      } catch (e) {
        console.error(e);
        await notifyBusy(update);
      }
      // Always 200 to Telegram: a non-2xx makes it redeliver the same update
      // over and over, which piles more load onto an already struggling DB.
      return new Response('ok');
    }

    return new Response('DogMeds Telegram Bot 🐕💊');
  } catch (e) {
    console.error(e);
    return new Response('Error: ' + (e as Error).message, { status: e instanceof UpstreamError ? 503 : 500 });
  }
});
