import { readJSON } from "@/lib/api";
import { APPROVAL_ACTIONS, issueApproval, type ApprovalAction } from "@/lib/approval";
import { resolveContext } from "@/lib/backend";
import { clientIp, rateLimit } from "@/lib/guard";

export const dynamic = "force-dynamic";

/**
 * Mints a signed approval for one write, called by the UI at the moment the user
 * presses a confirm button in a modal. (Ask Sorted's "Needs your OK" cards carry
 * their own token.) The agent loop has no route to this: it can only propose.
 */
export async function POST(req: Request) {
  const rc = resolveContext(req);
  const body = await readJSON(req);
  const action = body.action as ApprovalAction;
  const invoiceId = typeof body.invoiceId === "string" ? body.invoiceId.slice(0, 128) : "new";
  if (!APPROVAL_ACTIONS.includes(action)) return Response.json({ error: "Unknown action." }, { status: 400 });
  const wait = rateLimit(`approve:${clientIp(req)}`, 60, 10 * 60_000);
  if (wait) return Response.json({ error: "Too many approvals, slow down." }, { status: 429, headers: { "Retry-After": String(wait) } });
  return Response.json(issueApproval(action, invoiceId, rc.mode));
}
