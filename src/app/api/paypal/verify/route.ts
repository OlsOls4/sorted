import { errorResponse, resolveContext } from "@/lib/backend";
import { PayPalClient, PayPalError, isSandbox } from "@/lib/paypal/client";

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
    const hint = connectHint(e);
    if (hint && e instanceof PayPalError) {
      return Response.json({ ok: false, error: e.message, hint, paypalDebugId: e.debugId, status: e.status }, { status: e.status });
    }
    return errorResponse(e);
  }
}

/** Plain-English next step for the two failures people actually hit when connecting. */
function connectHint(e: unknown): string | null {
  if (!(e instanceof PayPalError)) return null;
  if (e.status === 403) {
    return "Your keys work, but this app doesn't have Invoicing enabled: developer.paypal.com → your sandbox app → Features → tick Invoicing → Save. Then try again.";
  }
  if (e.status === 401) {
    return "PayPal didn't accept these keys. Check you copied the Client ID and Secret from the same app, and that they're Sandbox keys, not Live (developer.paypal.com → Apps & Credentials → Sandbox).";
  }
  return null;
}
