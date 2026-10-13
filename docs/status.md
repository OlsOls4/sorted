# Sorted: verified status

_Last updated 13 Oct 2026 (BST). Commands and outputs below are copied from real runs, not written by hand._

## Live PayPal sandbox end-to-end (`node scripts/live-e2e.mjs`)

Run against `next start` on the production build, with server sandbox credentials
(PayPal app APP-1992168495389594T, auth injected by the dev egress proxy:
`NODE_USE_ENV_PROXY=1 PAYPAL_AUTH_VIA_PROXY=1`, AI disabled so it uses no Groq quota).
Every call below hit `api-m.sandbox.paypal.com`; "via paypal-agent-toolkit" means
`@paypal/agent-toolkit` executed the call.

```
PASS  status: live available via server creds  — {"env":"sandbox","src":"server"}
PASS  verify: OAuth + invoice list  — existing=5 
PASS  create+send consumer invoice  — 200 INV2-M4AA-W5LH-PYPA-4XYT
PASS  status SENT  — SENT
PASS  amounts 175 + 35 VAT = 210  — 175/35/210
PASS  dates round-trip  — 2026-10-13 → 2026-10-27
PASS  customer mapped  — Sarah Jones/consumer
PASS  items mapped  — [["Labour",2.5,45,"HOURS"],["Parts: mixer tap",1,62.5,"QUANTITY"]]
PASS  payer link  — https://www.sandbox.paypal.com/invoice/p/#M4AAW5LHPYPA4XYT
PASS  job summary from memo  — [E2E] Replace kitchen mixer tap
PASS  create+send business invoice (past due)  — 200 INV2-EEMK-2EK6-WSEU-U4U3
PASS  no-VAT total 152.50  — 152.5/0/152.5
PASS  business recipient  — Acme Lettings Ltd/business
PASS  list includes new invoice  — 7 invoices, via paypal-rest
PASS  list row hydrated (VAT/items)  — 175/35 items=2
PASS  remind  — 200 via paypal-agent-toolkit 
PASS  mark paid  — 200 MARKED_AS_PAID paid=210 date=2026-10-13 
PASS  Ask Sorted 'who owes me what' sees live Acme invoice  — list_invoices[paypal-agent-toolkit], get_ledger_summary[ledger]
      reply: You're owed **£1,311.90** across 5 customers — **£1,131.90 is overdue**: | • **Redland Property Management Ltd** — £491.40 (31 days overdue) | • **Harbourside Lettings Ltd** — £306.00 (28 days overdue) | • **Dave Bennett** — £182.00 (9 days overdue) | • **Tom Patel** — £180.00 (not due yet) | • **Acme Lettings Ltd** — £152.50 (10 days overdue)
PASS  Ask Sorted: generate_invoice_qr_code via Agent Toolkit  — list_invoices[paypal-agent-toolkit], generate_invoice_qr_code[paypal-agent-toolkit]
PASS  Ask Sorted: send_invoice_reminder returns a 'Needs your OK' card with a signed approval (nothing sent)
PASS  write without a valid approval → 403  — 403
PASS  shared sandbox refuses real email addresses  — 422
PASS  cancel sent invoice  — 200 via paypal-agent-toolkit CANCELLED
PASS  invalid draft rejected before PayPal  — 422

Created: INV2-M4AA-W5LH-PYPA-4XYT, INV2-EEMK-2EK6-WSEU-U4U3

ALL PASSED
```

The test invoices were then removed with `npm run seed:sandbox -- --reset`.

## Pay links, Pay in 3 and the B2B waiver (live sandbox, rules-engine drafts)

```
qr via paypal-agent-toolkit data:image/png;base64,iVBORw0KGgoAAAANSU
payer link https://www.sandbox.paypal.com/invoice/p/#NGABXS2YCFSWN7HL
Hi Dave,

I'm following up on invoice INV-1004 for £182.00, issued on 20 Sept 2026 and now 9 days overdue. I haven't yet received payment or heard back about it.

Please could you settle the balance within the next 7 days. You can pay securely by card or PayPal here: https://www.sandbox.paypal.com/invoice/p/#NGABXS2YCFSWN7HL

If it helps to spread the cost, eligible customers can choose PayPal Pay in 3 at checkout (interest-free instalments, subject to status).

If there's a problem with the work or the invoice, just reply and let me know so we can sort it out.

Kind regards,
Dave Harris
Dave Harris Plumbing & Heating
---
Hi Accounts team,

Despite previous reminders, invoice INV-1005 for £491.40 remains unpaid and is now 31 days overdue.

This is a final notice. Please pay the full balance by 20 Oct 2026. You can pay securely by card or PayPal here: https://www.sandbox.paypal.com/invoice/p/#DAWFMBJC5TK48D9R

As this is a business-to-business debt, if payment is not received by 20 Oct 2026 I will claim statutory interest under the Late Payment of Commercial Debts (Interest) Act 1998 at 11.75% a year (currently £4.90 and rising daily), plus fixed compensation of £40.00.

If you pay the invoice in full today using the link above, I'll waive the statutory interest and the £40.00 compensation.

I'd much rather resolve this amicably — if you're having difficulty paying, please get in touch today and we can agree a payment plan.

Kind regards,
Dave Harris
Dave Harris Plumbing & Heating
```

## Webhook

- Registered for the sandbox app with `npm run webhook:register`: id `76R5584597538213C` →
  `https://sorted-paypal.vercel.app/api/paypal/webhook`, events `INVOICING.INVOICE.PAID`,
  `INVOICING.INVOICE.CANCELLED`. `PAYPAL_WEBHOOK_ID` is set on Vercel.
- Signature check verified against PayPal locally: a forged event got
  `{"error":"Signature verification failed (verification_status=FAILURE)"}` from
  `POST /v1/notifications/verify-webhook-signature`; missing headers are rejected before calling PayPal.
- On production the route answers 503 "Webhook not configured" until the server has
  `PAYPAL_CLIENT_ID`/`PAYPAL_CLIENT_SECRET` (it needs them to call PayPal's verify API).
- Not yet seen: a real PayPal delivery verified end to end (needs those keys on Vercel).
  The dashboard also diffs the ledger on every live sync (once a minute), so a payment shows up
  even if a webhook is missed.

## Unit tests (`npm test`)

175 checks pass: job-notes parser, AI provider chain (mocked fetch), chat markdown, PayPal
mapping (VAT per line, private vs business, summaries, part payments), REST client (422 →
PayPalError with debug id, 401 → one token refresh, idempotency key, sandbox pinning),
Agent Toolkit `{ok:false}` handling (stubbed toolkit), approval tokens (scope, expiry,
replay, forgery), live-write guards, payment events and webhook mapping, reminder pay links.

## Smoke (`npm run smoke -- https://sorted-paypal.vercel.app`)

Demo mode against production: parse, ledger, create+send, approvals (403 without a token,
card token accepted), reminders (Act only for business, pay link, Pay in 3, waiver), QR,
mock payer page, cancel, mark paid, Ask Sorted (Groq) incl. QR via `generate_invoice_qr_code`.

## Live vs mocked on production right now

- Production has **no PayPal server keys** yet, so https://sorted-paypal.vercel.app opens in
  demo mode (mock PayPal). Pasting sandbox keys in "Connect PayPal sandbox" gives the full
  live flow above. Adding `PAYPAL_CLIENT_ID` / `PAYPAL_CLIENT_SECRET` on Vercel makes it live
  by default for everyone and switches the webhook on.
- Pay in 3: only mentioned (hedged) for private customers owing £20–£3,000, per PayPal UK's
  invoicing page; PayPal decides eligibility on its own payer page. Not verifiable in sandbox.
- Orders v2 checkout links: not used; reminders use the invoice's payer-view link.
