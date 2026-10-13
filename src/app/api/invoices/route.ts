import { asLedger, readJSON, sanitizeSettings } from "@/lib/api";
import { errorResponse, getBackend, resolveContext, validateDraft } from "@/lib/backend";
import { requireApproval } from "@/lib/approval";
import { liveWriteGuard } from "@/lib/guard";
import type { InvoiceDraft } from "@/lib/types";

export const dynamic = "force-dynamic";

/** List invoices. Live: synced from PayPal. Demo: seeded mock ledger. */
export async function GET(req: Request) {
  const rc = resolveContext(req);
  const mode = rc.mode;
  try {
    const { data, via } = await getBackend(rc).list();
    return Response.json({ mode, via, invoices: data });
  } catch (e) {
    return errorResponse(e);
  }
}

/** Create + send an invoice via PayPal (or mock PayPal in demo mode). */
export async function POST(req: Request) {
  const rc = resolveContext(req);
  const mode = rc.mode;
  const body = await readJSON(req);
  const draft = body.draft as InvoiceDraft | undefined;
  if (!draft || typeof draft !== "object") return Response.json({ error: "Missing invoice draft." }, { status: 400 });
  const errors = validateDraft(draft);
  if (errors.length) return Response.json({ error: errors.join(" "), errors }, { status: 422 });
  const unapproved = requireApproval(body.approval, "create_invoice", "new", mode);
  if (unapproved) return unapproved;
  const blocked = liveWriteGuard(req, rc, [draft.customerEmail]);
  if (blocked) return blocked;
  try {
    const { data, via } = await getBackend(rc).createAndSend(draft, sanitizeSettings(body.settings), asLedger(body.ledger));
    return Response.json({ mode, via, invoice: data });
  } catch (e) {
    return errorResponse(e);
  }
}
