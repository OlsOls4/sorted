// Signed, short-lived approval tokens for write actions (server-only).
//
// The agent can propose writes but never perform them. A write route (send
// invoice, send reminder, mark paid, cancel) only runs when the request carries a
// token that the server itself signed for that exact action + invoice + mode,
// within the last 10 minutes, and that hasn't been used before. Tokens are minted
// only where a human confirmation is shown: the "Needs your OK" card from Ask
// Sorted, or the confirm step of a modal in the UI.

import "server-only";
import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import type { Mode } from "./types";

export type ApprovalAction = "create_invoice" | "send_reminder" | "mark_paid" | "cancel_invoice";
export const APPROVAL_ACTIONS: ApprovalAction[] = ["create_invoice", "send_reminder", "mark_paid", "cancel_invoice"];
export const APPROVAL_TTL_MS = 10 * 60_000;

interface Claims {
  a: ApprovalAction;
  i: string; // invoice id, or "new" for a new invoice
  m: Mode;
  e: number; // expiry, ms since epoch
  n: string; // nonce
}

function secret(): string {
  const explicit = process.env.SORTED_APPROVAL_SECRET?.trim();
  if (explicit) return explicit;
  // Fallback: derive from server-only secrets so tokens survive across serverless instances.
  const material = [process.env.PAYPAL_CLIENT_SECRET, process.env.GROQ_API_KEY, process.env.GEMINI_API_KEY].filter(Boolean).join("|");
  return createHash("sha256").update(`sorted-approval|${material || "dev-only"}`).digest("hex");
}

const b64url = (b: Buffer | string) => Buffer.from(b).toString("base64url");
const sign = (payload: string) => createHmac("sha256", secret()).update(payload).digest("base64url");

export function issueApproval(action: ApprovalAction, invoiceId: string, mode: Mode, now = Date.now()): { token: string; expiresAt: string } {
  const claims: Claims = { a: action, i: invoiceId || "new", m: mode, e: now + APPROVAL_TTL_MS, n: randomUUID() };
  const payload = b64url(JSON.stringify(claims));
  return { token: `${payload}.${sign(payload)}`, expiresAt: new Date(claims.e).toISOString() };
}

// Single use, per server instance (best effort without a database; the 10-minute expiry is the hard limit).
const used = new Map<string, number>();

export function verifyApproval(token: unknown, action: ApprovalAction, invoiceId: string, mode: Mode, now = Date.now()): { ok: true } | { ok: false; reason: string } {
  if (typeof token !== "string" || !token.includes(".") || token.length > 1000) return { ok: false, reason: "missing approval" };
  const [payload, sig] = token.split(".");
  const want = Buffer.from(sign(payload));
  const got = Buffer.from(sig ?? "");
  if (want.length !== got.length || !timingSafeEqual(want, got)) return { ok: false, reason: "bad signature" };
  let c: Claims;
  try {
    c = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return { ok: false, reason: "unreadable token" };
  }
  if (c.e < now) return { ok: false, reason: "approval expired" };
  if (c.a !== action) return { ok: false, reason: `approval is for ${c.a}, not ${action}` };
  if (c.i !== (invoiceId || "new")) return { ok: false, reason: "approval is for a different invoice" };
  if (c.m !== mode) return { ok: false, reason: "approval is for a different mode" };
  for (const [n, exp] of used) if (exp < now) used.delete(n);
  if (used.has(c.n)) return { ok: false, reason: "approval already used" };
  used.set(c.n, c.e);
  return { ok: true };
}

/** For write routes: null when approved, otherwise a 403 to return. */
export function requireApproval(token: unknown, action: ApprovalAction, invoiceId: string, mode: Mode): Response | null {
  const v = verifyApproval(token, action, invoiceId, mode);
  if (v.ok) return null;
  return Response.json(
    { error: `This needs your OK first (${v.reason}). Review it and press confirm again.`, code: "APPROVAL_REQUIRED" },
    { status: 403 },
  );
}
