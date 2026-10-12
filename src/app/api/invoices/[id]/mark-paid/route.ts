import { readJSON } from "@/lib/api";
import { errorResponse, getBackend, resolveContext } from "@/lib/backend";
import type { Invoice } from "@/lib/types";

export const dynamic = "force-dynamic";

/** Record an off-PayPal payment (cash / bank transfer). Live: POST /v2/invoicing/invoices/{id}/payments. */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const rc = resolveContext(req);
  const mode = rc.mode;
  const body = await readJSON(req);
  const invoice = body.invoice as Invoice | undefined;
  if (mode === "demo" && (!invoice || invoice.id !== id)) {
    return Response.json({ error: "Demo mode needs the invoice in the request body." }, { status: 400 });
  }
  try {
    const { data, via } = await getBackend(rc).markPaid(invoice && invoice.id === id ? invoice : id);
    return Response.json({ mode, via, invoice: data });
  } catch (e) {
    return errorResponse(e);
  }
}
