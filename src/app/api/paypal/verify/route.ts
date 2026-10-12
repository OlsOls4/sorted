import { errorResponse, resolveContext } from "@/lib/backend";
import { PayPalClient, isSandbox } from "@/lib/paypal/client";

export const dynamic = "force-dynamic";

/**
 * Test PayPal credentials: OAuth client_credentials + a one-page invoice list.
 * Uses the browser-supplied sandbox creds if present, else server env vars.
 * Credentials are never logged or returned.
 */
export async function POST(req: Request) {
  const rc = resolveContext(req);
  if (!rc.cfg) return Response.json({ ok: false, error: "No PayPal credentials supplied." }, { status: 400 });
  try {
    const client = new PayPalClient(rc.cfg);
    await client.getAccessToken(true);
    const { data } = await client.request<{ total_items?: number; items?: unknown[] }>("GET", "/v2/invoicing/invoices?page=1&page_size=1&total_required=true");
    return Response.json({
      ok: true,
      env: isSandbox(rc.cfg) ? "sandbox" : "live",
      credSource: rc.credSource,
      invoiceCount: data?.total_items ?? data?.items?.length ?? 0,
    });
  } catch (e) {
    return errorResponse(e);
  }
}
