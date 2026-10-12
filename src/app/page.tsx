import Link from "next/link";
import { Logo } from "@/components/Logo";

const DBT_URL = "https://assets.publishing.service.gov.uk/media/68652e8f6569be0acf74db3e/late-payments-infographic.pdf";

const STATS = [
  { n: "£26bn", t: "owed to UK businesses in late payments at any given time — about £17,000 per affected business." },
  { n: "38", t: "UK businesses close every day as a result of late payment — 14,000 a year." },
  { n: "86 hrs", t: "a year spent chasing late payments by each affected business that does it." },
];

const STEPS = [
  {
    k: "1",
    h: "Say what you did",
    p: "“Fitted 2 radiators for Mrs Patel, 4 hrs, parts £86, she’s at patel.r@example.com.” Type it in the van or just say it.",
  },
  {
    k: "2",
    h: "Sorted writes the invoice",
    p: "AI pulls out the customer, hours at your rate, parts and terms. You check it, tweak it, and send it through PayPal in one tap.",
  },
  {
    k: "3",
    h: "Sorted does the chasing",
    p: "Spots late payers, drafts a friendly nudge, then a firmer note, then a proper final notice — citing the Late Payment Act for business customers. You approve every send.",
  },
];

export default function Home() {
  return (
    <div className="bg-white">
      <header className="mx-auto flex max-w-6xl items-center justify-between px-5 py-5">
        <Logo className="text-2xl" />
        <nav className="flex items-center gap-2">
          <a href="#how" className="hidden px-3 text-sm font-medium text-muted hover:text-ink sm:inline">
            How it works
          </a>
          <Link href="/app" className="btn-primary">
            Try the demo
          </Link>
        </nav>
      </header>

      <section className="mx-auto grid max-w-6xl items-center gap-10 px-5 pt-6 pb-16 lg:grid-cols-2 lg:pt-14">
        <div>
          <span className="inline-flex items-center gap-2 rounded-full bg-brand-soft px-3 py-1 text-xs font-bold text-brand">
            For UK sole traders &amp; tradespeople
          </span>
          <h1 className="mt-4 text-4xl leading-[1.05] font-extrabold tracking-tight sm:text-6xl">
            Invoice sent, chased,
            <br />
            <span className="text-brand">sorted.</span>
          </h1>
          <p className="mt-5 max-w-xl text-lg text-ink-2">
            Turn scribbled job notes into a PayPal invoice in seconds. Sorted keeps the ledger, spots who&apos;s late, and writes the awkward reminder emails for you, from a friendly nudge up to a
            final notice.
          </p>
          <div className="mt-7 flex flex-wrap gap-3">
            <Link href="/app" className="btn-primary px-6 py-3 text-base">
              Open the dashboard →
            </Link>
            <a href="#how" className="btn-ghost px-6 py-3 text-base">
              See how it works
            </a>
          </div>
          <p className="mt-3 text-xs text-muted">No sign-up. The demo runs on sample data with a mock PayPal backend.</p>
        </div>

        <div className="relative">
          <div className="absolute -inset-4 -z-10 rounded-[2rem] bg-gradient-to-br from-brand-soft via-white to-sky-50" />
          <div className="card p-5">
            <div className="text-xs font-semibold text-muted uppercase">Job notes</div>
            <p className="mt-1 rounded-xl bg-paper p-3 font-mono text-sm">fitted 2 radiators for Mrs Patel, 4 hrs, parts £86, she&apos;s at patel.r@example.com</p>
            <div className="my-3 text-center text-brand">✦ Sorted ↓</div>
            <div className="rounded-xl border border-line p-3 text-sm">
              <div className="flex justify-between font-semibold">
                <span>Mrs Patel</span>
                <span className="text-muted">due in 14 days</span>
              </div>
              <div className="mt-2 flex justify-between text-ink-2">
                <span>Labour — 4 hrs × £45</span>
                <span>£180.00</span>
              </div>
              <div className="flex justify-between text-ink-2">
                <span>Parts &amp; materials</span>
                <span>£86.00</span>
              </div>
              <div className="mt-2 flex justify-between border-t border-line pt-2 text-base font-extrabold">
                <span>Total</span>
                <span>£266.00</span>
              </div>
              <div className="mt-3 rounded-lg bg-pp py-2 text-center text-sm font-semibold text-white">Send via PayPal</div>
            </div>
          </div>
        </div>
      </section>

      <section className="bg-ink py-14 text-white">
        <div className="mx-auto max-w-6xl px-5">
          <h2 className="max-w-2xl text-2xl font-bold sm:text-3xl">Late payment isn&apos;t a paperwork problem. It closes businesses.</h2>
          <div className="mt-8 grid gap-6 sm:grid-cols-3">
            {STATS.map((s) => (
              <div key={s.n} className="rounded-2xl bg-white/5 p-5 ring-1 ring-white/10">
                <div className="text-4xl font-extrabold text-[#6ee7b7]">{s.n}</div>
                <p className="mt-2 text-sm text-white/80">{s.t}</p>
              </div>
            ))}
          </div>
          <p className="mt-6 text-xs text-white/60">
            Source:{" "}
            <a className="underline" href={DBT_URL} target="_blank" rel="noreferrer">
              Department for Business and Trade (2025), Estimating the total economic cost of late payments and their impact on the UK economy
            </a>
            .
          </p>
        </div>
      </section>

      <section id="how" className="mx-auto max-w-6xl px-5 py-16">
        <h2 className="text-3xl font-bold">How it works</h2>
        <div className="mt-8 grid gap-5 md:grid-cols-3">
          {STEPS.map((s) => (
            <div key={s.k} className="card p-6">
              <div className="flex h-9 w-9 items-center justify-center rounded-full bg-brand text-sm font-bold text-white">{s.k}</div>
              <h3 className="mt-4 text-lg font-bold">{s.h}</h3>
              <p className="mt-2 text-sm text-ink-2">{s.p}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="mx-auto max-w-6xl px-5 pb-16">
        <div className="grid gap-5 md:grid-cols-2">
          <div className="card p-6">
            <div className="text-xs font-bold tracking-wide text-pp-2 uppercase">PayPal</div>
            <h3 className="mt-2 text-xl font-bold">Real invoices, real payments</h3>
            <ul className="mt-3 space-y-2 text-sm text-ink-2">
              <li>• Invoices are created and emailed with the PayPal Invoicing API v2 — customers pay by card or PayPal.</li>
              <li>• Status syncs straight from PayPal, so the ledger is always the truth.</li>
              <li>• Reminders go out through PayPal&apos;s invoice reminder, driven by the PayPal Agent Toolkit.</li>
              <li>• Cash or bank transfer? Record it against the PayPal invoice in one tap.</li>
            </ul>
          </div>
          <div className="card p-6">
            <div className="text-xs font-bold tracking-wide text-violet-700 uppercase">AI agent</div>
            <h3 className="mt-2 text-xl font-bold">An assistant that asks before it acts</h3>
            <ul className="mt-3 space-y-2 text-sm text-ink-2">
              <li>• Reads messy notes and voice dictation into structured invoices.</li>
              <li>• Writes reminders with the right tone, and only cites the Late Payment Act where it applies.</li>
              <li>• “Ask Sorted” answers questions like “who owes me what?” using tools over your ledger.</li>
              <li>• Anything that contacts a customer needs your OK first. Works without an AI key too, using a built-in rules engine.</li>
            </ul>
          </div>
        </div>
        <div className="mt-10 text-center">
          <Link href="/app" className="btn-primary px-8 py-3 text-base">
            Try Sorted now: no sign-up
          </Link>
        </div>
      </section>

      <footer className="border-t border-line py-6 text-center text-xs text-muted">
        Sorted · built for the PayPal AI Hackathon · MIT licensed · Not legal advice: check the Late Payment rules for your situation.
      </footer>
    </div>
  );
}
