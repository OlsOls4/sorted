"use client";

import { useState } from "react";
import type { PayPalCreds } from "@/lib/client";
import { Modal, PayPalMark, Spinner } from "./ui";

export function PayPalConnect({
  connected,
  credSource,
  onConnect,
  onDisconnect,
  onClose,
}: {
  connected: boolean;
  credSource: "browser" | "server" | null;
  onConnect: (c: PayPalCreds) => Promise<void>;
  onDisconnect: () => Promise<void>;
  onClose: () => void;
}) {
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function connect() {
    setBusy(true);
    setError(null);
    try {
      await onConnect({ clientId: clientId.trim(), clientSecret: clientSecret.trim() });
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open onClose={onClose} title="Connect PayPal sandbox">
      {connected && (
        <div className="mb-4 flex items-center justify-between gap-3 rounded-xl bg-brand-soft px-3 py-2 text-sm text-brand">
          <span>
            ✓ Connected {credSource === "browser" ? "with keys saved in this browser" : "via the server's PayPal app"}.
          </span>
          {credSource === "browser" && (
            <button
              className="text-xs font-semibold underline"
              onClick={async () => {
                await onDisconnect();
                onClose();
              }}
            >
              Disconnect
            </button>
          )}
        </div>
      )}
      <p className="text-sm text-ink-2">
        Use live PayPal invoicing with your own <strong>sandbox</strong> app. Create one free at{" "}
        <a className="font-semibold text-pp-2 underline" href="https://developer.paypal.com/dashboard/applications/sandbox" target="_blank" rel="noreferrer">
          developer.paypal.com → Apps &amp; Credentials (Sandbox)
        </a>
        , then paste its Client ID and Secret.
      </p>
      <div className="mt-4 space-y-3">
        <div>
          <label className="label" htmlFor="pp-id">Client ID</label>
          <input id="pp-id" className="input font-mono text-xs" autoComplete="off" spellCheck={false} value={clientId} onChange={(e) => setClientId(e.target.value)} />
        </div>
        <div>
          <label className="label" htmlFor="pp-secret">Secret</label>
          <input
            id="pp-secret"
            type="password"
            className="input font-mono text-xs"
            autoComplete="off"
            spellCheck={false}
            value={clientSecret}
            onChange={(e) => setClientSecret(e.target.value)}
          />
        </div>
      </div>
      <ul className="mt-3 space-y-1 text-xs text-muted">
        <li>• Sandbox only: Sorted pins these keys to api-m.sandbox.paypal.com, so no real money can move.</li>
        <li>• Stored only in this browser&apos;s local storage and sent over HTTPS with each request. Sorted&apos;s server never saves or logs them.</li>
        <li>• Invoices go to sandbox emails. Use a sandbox personal account to pay them.</li>
      </ul>
      {error && <div className="mt-3 rounded-xl bg-bad-soft px-3 py-2 text-sm text-bad">Couldn&apos;t connect: {error}</div>}
      <div className="mt-5 flex justify-end gap-2">
        <button className="btn-ghost" onClick={onClose}>Cancel</button>
        <button className="btn-paypal" disabled={busy || !clientId.trim() || !clientSecret.trim()} onClick={connect}>
          {busy ? <Spinner /> : <PayPalMark />} {busy ? "Checking…" : "Test & connect"}
        </button>
      </div>
    </Modal>
  );
}
