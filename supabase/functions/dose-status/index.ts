import "jsr:@supabase/functions-js/edge-runtime.d.ts";

// Single source of truth for dose scheduling + log matching.
// Both the web app (index.html) and the Telegram bot call this instead of
// each keeping their own copy - that duplication is what caused a stray log
// to silently steal the wrong dose's slot in the first place.

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

const DOSES = [
  { hour: 7, minute: 30, label: 'בוקר' },
  { hour: 15, minute: 30, label: 'צהריים' },
  { hour: 19, minute: 30, label: 'ערב' },
  { hour: 23, minute: 30, label: 'לילה' },
];
const EARLY_MIN = 20; // minutes before scheduled time a dose can be given early and still count for that slot

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// Thrown when the database/REST API is unreachable or erroring, so callers
// get a clear 503 instead of a confusing "logs is not iterable" crash.
class UpstreamError extends Error {}

function getNowIsrael(): Date {
  return new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Jerusalem' }).replace(',', ''));
}

function pad(n: number) { return String(n).padStart(2, '0'); }

function getTodayStr(now: Date): string {
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

function getCurrentDoseIndex(nowMin: number): number {
  for (let i = DOSES.length - 1; i >= 0; i--) {
    if (nowMin >= DOSES[i].hour * 60 + DOSES[i].minute) return i;
  }
  return -1;
}

// Window (minutes-since-midnight) a log must fall in to count toward dose i.
// Starts EARLY_MIN minutes before the dose's scheduled time and runs until
// EARLY_MIN minutes before the next dose (so a late give credits the overdue
// dose instead of bleeding into the next one). Dose 0's window reaches back
// to midnight; the last dose's window reaches forward to the next midnight.
function doseWindow(i: number): [number, number] {
  const start = i === 0 ? 0 : (DOSES[i].hour * 60 + DOSES[i].minute) - EARLY_MIN;
  const end = i === DOSES.length - 1
    ? 24 * 60
    : (DOSES[i + 1].hour * 60 + DOSES[i + 1].minute) - EARLY_MIN;
  return [start, end];
}

async function getTodayLogs(today: string): Promise<any[]> {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/med_logs?given_at=gte.${today}T00:00:00&order=given_at.asc`, {
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` },
  });
  if (!res.ok) throw new UpstreamError(`med_logs fetch failed: ${res.status}`);
  const logs = await res.json();
  if (!Array.isArray(logs)) throw new UpstreamError('med_logs fetch returned a non-array');
  return logs;
}

function matchLogsToDoses(logs: any[]): (any | null)[] {
  const matched: (any | null)[] = new Array(DOSES.length).fill(null);

  for (const log of logs) {
    const d = new Date(log.given_at);
    const israel = new Date(d.toLocaleString('en-US', { timeZone: 'Asia/Jerusalem' }).replace(',', ''));
    const logMin = israel.getHours() * 60 + israel.getMinutes();

    let m = -1;
    for (let i = 0; i < DOSES.length; i++) {
      if (matched[i]) continue;
      const [start, end] = doseWindow(i);
      if (logMin >= start && logMin < end) { m = i; break; }
    }

    if (m < 0) {
      for (let i = DOSES.length - 1; i >= 0; i--) {
        if (!matched[i] && logMin >= doseWindow(i)[0]) { m = i; break; }
      }
    }

    if (m >= 0) matched[m] = log;
  }

  return matched;
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  try {
    const now = getNowIsrael();
    const nowMin = now.getHours() * 60 + now.getMinutes();
    const today = getTodayStr(now);

    const logs = await getTodayLogs(today);
    const sorted = [...logs].sort((a: any, b: any) => new Date(a.given_at).getTime() - new Date(b.given_at).getTime());
    const matched = matchLogsToDoses(sorted);

    const doses = DOSES.map((dd, i) => {
      const doseMin = dd.hour * 60 + dd.minute;
      const earlyStart = doseMin - EARLY_MIN;
      const [, windowEnd] = doseWindow(i);
      const match = matched[i];

      let status: string;
      if (match) status = 'given';
      else if (nowMin >= earlyStart && nowMin < doseMin) status = 'early';
      else if (nowMin >= doseMin && nowMin < windowEnd) status = 'active';
      else if (nowMin >= windowEnd) status = 'missed';
      else status = 'upcoming';

      return {
        index: i,
        hour: dd.hour,
        minute: dd.minute,
        label: dd.label,
        status,
        given: !!match,
        givenBy: match?.given_by ?? null,
        givenAt: match?.given_at ?? null,
        logId: match?.id ?? null,
      };
    });

    return new Response(JSON.stringify({
      today,
      nowMin,
      currentDoseIndex: getCurrentDoseIndex(nowMin),
      doses,
    }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  } catch (e) {
    console.error(e);
    return new Response(JSON.stringify({ error: (e as Error).message }), {
      status: e instanceof UpstreamError ? 503 : 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
