import { resolveContext } from "@/lib/backend";
import { eventsSince } from "@/lib/paypal/webhook";

export const dynamic = "force-dynamic";

/** Verified webhook events since `?since=<seq>`. Only for the server's own PayPal account. */
export async function GET(req: Request) {
  const rc = resolveContext(req);
  const since = Number(new URL(req.url).searchParams.get("since") ?? 0) || 0;
  if (rc.mode !== "live" || rc.credSource !== "server") return Response.json({ events: [], seq: since, webhook: false });
  return Response.json({ ...eventsSince(since), webhook: !!process.env.PAYPAL_WEBHOOK_ID });
}
