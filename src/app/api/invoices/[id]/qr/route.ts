import { errorResponse, resolveContext } from "@/lib/backend";
import { demoPayLink } from "@/lib/format";
import { clientIp, rateLimit } from "@/lib/guard";
import { runToolkitTool } from "@/lib/paypal/toolkit";
import { qrDataUrl, qrFromToolkitOutput } from "@/lib/qr";

export const dynamic = "force-dynamic";

/** QR code that opens the customer's pay page. Live: PayPal Agent Toolkit generate_invoice_qr_code. */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const rc = resolveContext(req);
  const wait = rateLimit(`qr:${clientIp(req)}`, 30, 10 * 60_000);
  if (wait) return Response.json({ error: "Too many QR codes, try again shortly." }, { status: 429 });
  try {
    if (rc.mode === "live" && rc.cfg) {
      const out = await runToolkitTool(rc.cfg, "generate_invoice_qr_code", { invoice_id: id, width: 240, height: 240 });
      return Response.json({ dataUrl: qrFromToolkitOutput(out), via: "paypal-agent-toolkit" });
    }
    // Demo: always our own mock payer page, never a URL from the request body.
    const link = demoPayLink(id);
    return Response.json({ dataUrl: await qrDataUrl(link), via: "mock-paypal", link });
  } catch (e) {
    return errorResponse(e);
  }
}
