// Works out, on the server, which "Money owed" dashboard to render: the AG Studio one while its
// key is in date, Sorted's own board otherwise. Pure (no Next imports) so the unit tests can run it.
// Never log or return the key itself.

const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];

/** Strip what AG Studio strips (zero-width chars, line breaks), plus literal "\r\n" text from a pasted email. */
function clean(key: string): string {
  return key.replace(/[\u200B-\u200D\uFEFF]/g, "").replace(/\\r\\n|\\n/g, " ").replace(/\r?\n|\r/g, " ").trim();
}

/** The "{14 November 2026}" date written in the key text, as YYYY-MM-DD. */
export function bracedExpiry(key: string): string | null {
  const m = /\{\s*(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})\s*\}/.exec(clean(key));
  if (!m) return null;
  const month = MONTHS.findIndex((x) => x.startsWith(m[2].toLowerCase()) && m[2].length >= 3);
  const day = Number(m[1]);
  if (month < 0 || day < 1 || day > 31) return null;
  const iso = `${m[3]}-${String(month + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  const d = new Date(`${iso}T12:00:00Z`);
  return Number.isNaN(d.getTime()) || d.getUTCDate() !== day ? null : iso;
}

/** The expiry instant AG Studio itself checks: base64 epoch millis after the last "_" (before the 32-char hash). */
export function encodedExpiry(key: string): Date | null {
  const k = clean(key).replace(/\s+/g, "");
  if (k.length <= 32) return null;
  const body = k.slice(0, -32);
  const tail = body.slice(body.lastIndexOf("_") + 1).replace(/[^A-Za-z0-9+/=]/g, "");
  if (!tail) return null;
  let text: string;
  try {
    text = Buffer.from(tail, "base64").toString("latin1");
  } catch {
    return null;
  }
  if (!/^\d{10,14}$/.test(text)) return null;
  const d = new Date(Number(text));
  return Number.isNaN(d.getTime()) ? null : d;
}

/** A calendar date in Europe/London, YYYY-MM-DD. */
export function londonDate(d: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

/**
 * The key's last good day is the day before this (Europe/London). Takes the earlier of the
 * written date and the encoded instant, so the switch never lands after AG Studio's own check.
 */
export function studioKeyExpiry(key: string | undefined | null): string | null {
  if (!key || !key.trim()) return null;
  const dates = [bracedExpiry(key), (() => {
    const e = encodedExpiry(key);
    return e ? londonDate(e) : null;
  })()].filter((x): x is string => !!x);
  return dates.length ? dates.sort()[0] : null;
}

export type StudioChoice = "studio" | "board";

/**
 * "board" when the key is missing, or today (Europe/London) is on or after its expiry date, or the
 * SORTED_FORCE_STUDIO_OFF override is set. A key whose date can't be read keeps Studio (today's behaviour).
 */
export function chooseDashboard(opts: { key?: string | null; now?: Date; forceOff?: string | null }): StudioChoice {
  const force = (opts.forceOff ?? "").trim().toLowerCase();
  if (force === "1" || force === "true" || force === "yes") return "board";
  if (!opts.key || !opts.key.trim()) return "board";
  const expiry = studioKeyExpiry(opts.key);
  if (!expiry) return "studio";
  return londonDate(opts.now ?? new Date()) < expiry ? "studio" : "board";
}
