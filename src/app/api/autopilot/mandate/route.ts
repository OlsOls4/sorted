import { readJSON } from "@/lib/api";
import { issueMandate } from "@/lib/approval";
import { sanitizeRules } from "@/lib/autopilot";
import { resolveContext } from "@/lib/backend";
import { clientIp, rateLimit } from "@/lib/guard";

export const dynamic = "force-dynamic";

/**
 * Signs the owner's Autopilot limits into a 30-day mandate. Called only when the
 * owner presses "Sign mandate" in the Autopilot panel; the agent loop has no route here.
 */
export async function POST(req: Request) {
  const rc = resolveContext(req);
  const body = await readJSON(req);
  const wait = rateLimit(`mandate:${clientIp(req)}`, 30, 10 * 60_000);
  if (wait) return Response.json({ error: "Too many changes at once. Give it a moment." }, { status: 429, headers: { "Retry-After": String(wait) } });
  const rules = sanitizeRules({ ...(body.rules as object), enabled: true });
  return Response.json({ mode: rc.mode, ...issueMandate(rules, rc.mode) });
}
