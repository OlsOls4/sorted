import { readJSON } from "@/lib/api";
import { requireApproval } from "@/lib/approval";
import { errorResponse, getBackend, resolveContext } from "@/lib/backend";
import { liveWriteGuard } from "@/lib/guard";
import type { Invoice } from "@/lib/types";

export const dynamic = "force-dynamic";

/** Cancel a sent, unpaid invoice. Live: PayPal Agent Toolkit cancel_sent_invoice (POST /v2/invoicing/invoices/{id}/cancel). */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const rc = resolveContext(req);
  const mode = rc.mode;
  const body = await readJSON(req);
  const invoice = body.invoice as Invoice | undefined;
  if (mode === "demo" && (!invoice || invoice.id !== id)) {
    return Response.json({ error: "Demo mode needs the invoice in the request body." }, { status: 400 });
  }
  const unapproved = requireApproval(body.approval, "cancel_invoice", id, mode);
  if (unapproved) return unapproved;
  const blocked = liveWriteGuard(req, rc);
  if (blocked) return blocked;
  try {
    const { data, via } = await getBackend(rc).cancel(invoice && invoice.id === id ? invoice : id);
    return Response.json({ mode, via, invoice: data });
  } catch (e) {
    return errorResponse(e);
  }
}
