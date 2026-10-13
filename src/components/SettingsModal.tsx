"use client";

import { useState } from "react";
import type { EngineInfo, Settings } from "@/lib/types";
import { EngineBadge, Modal } from "./ui";

export function SettingsModal({ settings, engine, onSave, onClose }: { settings: Settings; engine?: EngineInfo | null; onSave: (s: Settings) => void; onClose: () => void }) {
  const [s, setS] = useState(settings);
  const set = <K extends keyof Settings>(k: K, v: Settings[K]) => setS((p) => ({ ...p, [k]: v }));
  return (
    <Modal open onClose={onClose} title="Your business">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2 rounded-xl bg-paper px-3 py-2 text-xs text-muted">
        <span>AI engine</span>
        <EngineBadge engine={engine} />
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="sm:col-span-2">
          <label className="label" htmlFor="bn">Business name</label>
          <input id="bn" className="input" value={s.businessName} onChange={(e) => set("businessName", e.target.value)} />
        </div>
        <div>
          <label className="label" htmlFor="tn">Your name</label>
          <input id="tn" className="input" value={s.traderName} onChange={(e) => set("traderName", e.target.value)} />
        </div>
        <div>
          <label className="label" htmlFor="te">Your email</label>
          <input id="te" type="email" className="input" value={s.traderEmail} onChange={(e) => set("traderEmail", e.target.value)} />
        </div>
        <div>
          <label className="label" htmlFor="hr">Hourly rate (£)</label>
          <input id="hr" type="number" min={0} step={1} className="input" value={s.hourlyRate} onChange={(e) => set("hourlyRate", Math.max(0, Number(e.target.value) || 0))} />
        </div>
        <div>
          <label className="label" htmlFor="pt">Payment terms (days)</label>
          <input id="pt" type="number" min={0} max={120} className="input" value={s.paymentTermsDays} onChange={(e) => set("paymentTermsDays", Math.max(0, Number(e.target.value) || 0))} />
        </div>
        <div>
          <label className="label" htmlFor="cf">Default call-out fee (£)</label>
          <input id="cf" type="number" min={0} className="input" value={s.calloutFee} onChange={(e) => set("calloutFee", Math.max(0, Number(e.target.value) || 0))} />
        </div>
        <div>
          <label className="label" htmlFor="br">BoE base rate (%)</label>
          <input id="br" type="number" min={0} step={0.05} className="input" value={s.bankRate} onChange={(e) => set("bankRate", Math.max(0, Number(e.target.value) || 0))} />
        </div>
        <label className="flex items-center gap-2 text-sm sm:col-span-2">
          <input type="checkbox" className="h-4 w-4 accent-[#0a7f5a]" checked={s.vatRegistered} onChange={(e) => set("vatRegistered", e.target.checked)} />
          I&apos;m VAT registered (add VAT at {s.vatRate}% by default)
        </label>
        <p className="text-xs text-muted sm:col-span-2">
          The base rate is used for statutory interest under the Late Payment of Commercial Debts (Interest) Act 1998 (8% + base rate, business customers only). Settings are saved in this browser and used for new invoices and reminders.
        </p>
      </div>
      <div className="mt-5 flex justify-end gap-2">
        <button type="button" className="btn-ghost" onClick={onClose}>Cancel</button>
        <button
          type="button"
          className="btn-primary"
          disabled={!s.businessName.trim() || !s.traderName.trim()}
          onClick={() => {
            onSave(s);
            onClose();
          }}
        >
          Save
        </button>
      </div>
    </Modal>
  );
}
