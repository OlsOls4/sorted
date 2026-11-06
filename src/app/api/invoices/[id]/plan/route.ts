import { readJSON } from "@/lib/api";
import { errorResponse, getBackend, resolveContext } from "@/lib/backend";
import { requireApproval } from "@/lib/approval";
import { todayISO } from "@/lib/format";
import { liveWriteGuard } from "@/lib/guard";
import type { Invoice, PlanCadence } from "@/lib/types";

export const dynamic = "force-dynamic";

/**
 * Offer a payment plan on an open invoice: the outstanding balance is split into
 * 2–4 weekly or monthly instalments and the invoice is updated to accept part
 * payments of that size. Live: PUT /v2/invoicing/invoices/{id} with
 * configuration.partial_payment. Needs the owner's OK (signed approval), and on the
 * shared sandbox only test (@example.com) customers.
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const rc = resolveContext(req);
  const mode = rc.mode;
  const body = await readJSON(req);
  const invoice = body.invoice as Invoice | undefined;
  const count = Number(body.count);
  const cadence = body.cadence as PlanCadence;
  const startDate = typeof body.startDate === "string" && /^\d{4}-\d{2}-\d{2}$/.test(body.startDate) ? body.startDate : todayISO();
  if (![2, 3, 4].includes(count) || (cadence !== "weekly" && cadence !== "monthly")) {
    return Response.json({ error: "Choose 2, 3 or 4 instalments, weekly or monthly." }, { status: 400 });
  }
  if (startDate < todayISO()) return Response.json({ error: "The first instalment can't be in the past." }, { status: 400 });
  if (mode === "demo" && (!invoice || invoice.id !== id)) {
    return Response.json({ error: "Demo mode needs the invoice in the request body." }, { status: 400 });
  }
  const unapproved = requireApproval(body.approval, "offer_plan", id, mode);
  if (unapproved) return unapproved;
  try {
    const backend = getBackend(rc);
    // Recipient rule checked against PayPal's own copy of the invoice, not the request body.
    const current = mode === "live" ? (await backend.get(id)).data : invoice;
    const blocked = liveWriteGuard(req, rc, current?.customerEmail ? [current.customerEmail] : []);
    if (blocked) return blocked;
    const { data, via } = await backend.offerPlan(invoice && invoice.id === id ? invoice : id, { count, cadence, startDate });
    return Response.json({ mode, via, invoice: data });
  } catch (e) {
    return errorResponse(e);
  }
}
