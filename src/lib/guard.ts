// Abuse guards for live PayPal writes (server-only).
//
// When Sorted runs live on the server's own sandbox keys (so judges see real
// PayPal without pasting anything), anyone on the internet can press "send".
// Two cheap guards keep that safe:
//   1. Rate limits on live writes, per client IP and per server instance.
//   2. On the shared server keys, invoices may only be addressed to test
//      mailboxes (example.com / .example / .test, or domains listed in
//      SORTED_ALLOWED_RECIPIENT_DOMAINS). PayPal sandbox never delivers real
//      email anyway; this stops the shared account being used to spam.
// Limits are in memory, so they are per serverless instance: best effort, not a
// billing-grade quota. Browser-pasted keys are the user's own sandbox, so they
// get the rate limit only.

import "server-only";
import type { RequestContext } from "./backend";

type Bucket = number[];
const buckets = new Map<string, Bucket>();

export function clientIp(req: Request): string {
  const fwd = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return fwd || req.headers.get("x-real-ip") || "local";
}

/** Sliding-window limiter. Returns seconds to wait, or 0 when allowed (and records the hit). */
export function rateLimit(key: string, limit: number, windowMs: number, now = Date.now()): number {
  const hits = (buckets.get(key) ?? []).filter((t) => now - t < windowMs);
  if (hits.length >= limit) {
    buckets.set(key, hits);
    return Math.max(1, Math.ceil((windowMs - (now - hits[0])) / 1000));
  }
  hits.push(now);
  if (buckets.size > 5000) buckets.clear();
  buckets.set(key, hits);
  return 0;
}

const DEFAULT_SAFE = ["example.com", "example.org", "example.net"];
const SAFE_TLDS = [".example", ".test", ".invalid", ".localhost"];

/** True for test/demo mailboxes that are safe to send to from the shared sandbox account. */
export function isSafeRecipient(email: string, extra = process.env.SORTED_ALLOWED_RECIPIENT_DOMAINS ?? ""): boolean {
  const m = email.trim().toLowerCase().match(/^[^\s@]+@([^\s@]+)$/);
  if (!m) return false;
  const domain = m[1];
  const allowed = [...DEFAULT_SAFE, ...extra.split(",").map((d) => d.trim().toLowerCase()).filter(Boolean)];
  if (allowed.some((d) => domain === d || domain.endsWith(`.${d}`))) return true;
  return SAFE_TLDS.some((t) => domain.endsWith(t));
}

export const LIMITS = {
  serverPerIp: { limit: Number(process.env.SORTED_LIVE_WRITES_PER_IP ?? 12), windowMs: 10 * 60_000 },
  serverGlobal: { limit: Number(process.env.SORTED_LIVE_WRITES_PER_HOUR ?? 150), windowMs: 60 * 60_000 },
  browserPerIp: { limit: 40, windowMs: 10 * 60_000 },
};

/**
 * Call before any live PayPal write. Returns a Response to send back (blocked) or null (go ahead).
 * Demo mode is never limited here (mock PayPal, nothing leaves the server).
 */
export function liveWriteGuard(req: Request, rc: RequestContext, recipients: string[] = []): Response | null {
  if (rc.mode !== "live") return null;
  const ip = clientIp(req);
  if (rc.credSource === "server") {
    const bad = recipients.filter((r) => !isSafeRecipient(r));
    if (bad.length) {
      return Response.json(
        {
          error: `This public demo runs on a shared PayPal sandbox, so it only sends to test addresses (anything @example.com). Use one like ${suggestTest(bad[0])}, or connect your own PayPal sandbox to send anywhere.`,
          code: "RECIPIENT_NOT_ALLOWED",
        },
        { status: 422 },
      );
    }
    const wait = rateLimit(`ip:${ip}`, LIMITS.serverPerIp.limit, LIMITS.serverPerIp.windowMs) || rateLimit("global", LIMITS.serverGlobal.limit, LIMITS.serverGlobal.windowMs);
    if (wait) return tooMany(wait);
    return null;
  }
  const wait = rateLimit(`byo:${ip}`, LIMITS.browserPerIp.limit, LIMITS.browserPerIp.windowMs);
  return wait ? tooMany(wait) : null;
}

function tooMany(wait: number) {
  return Response.json(
    { error: `Easy there: the live PayPal demo allows a limited number of sends. Try again in ${wait < 90 ? `${wait}s` : `${Math.ceil(wait / 60)} min`}.`, code: "RATE_LIMITED" },
    { status: 429, headers: { "Retry-After": String(wait) } },
  );
}

function suggestTest(email: string) {
  const local = email.split("@")[0]?.replace(/[^a-z0-9._-]/gi, "") || "customer";
  return `${local}@example.com`;
}

/** Test hook. */
export function _resetGuards() {
  buckets.clear();
}
