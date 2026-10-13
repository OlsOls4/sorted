import { resolveContext, serverLiveConfigured } from "@/lib/backend";
import { aiStatus, fallbackEngine, getLLM } from "@/lib/ai/provider";
import { isSandbox } from "@/lib/paypal/client";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const rc = resolveContext(req);
  const llm = getLLM();
  return Response.json({
    liveAvailable: rc.cfg !== null,
    serverCredentials: serverLiveConfigured(),
    credSource: rc.credSource,
    paypalEnv: rc.cfg ? (isSandbox(rc.cfg) ? "sandbox" : "live") : null,
    engine: llm?.info ?? fallbackEngine(),
    aiProviders: aiStatus(),
    // Live by default: when the server has its own sandbox keys, the app opens on real PayPal.
    liveByDefault: serverLiveConfigured(),
    sharedSandbox: rc.credSource === "server",
    agentToolkit: rc.cfg ? "enabled in live mode" : "inactive in demo mode",
  });
}
