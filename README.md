# Sorted

**Invoice sent, chased, sorted.**

Sorted is an AI agent for UK sole traders and tradespeople. You paste or say your messy job notes, for example *"fitted 2 radiators for Mrs Patel, 4 hrs, parts £86, she's at patel.r@example.com"*, and Sorted:

1. **Writes the invoice.** It turns the notes into a structured draft: customer, email, labour hours × your rate, parts, VAT (off by default for non-VAT-registered traders), GBP, and a due date 14 days out. You can edit everything before sending.
2. **Sends it through PayPal.** It uses the PayPal Invoicing API v2 to create and send the invoice. Your customer gets a secure link and can pay by card or PayPal.
3. **Keeps the ledger.** All your invoices sit in an AG Grid table with status badges, a days-overdue column, filters, quick search, a filtered totals row, CSV export and row actions.
4. **Chases late payers.** It spots overdue invoices and drafts reminders that get firmer each time: a friendly nudge, then a firm reminder, then a final notice. For business customers, the final notice cites the **Late Payment of Commercial Debts (Interest) Act 1998** and works out statutory interest and fixed compensation. Nothing is sent until you approve it.
5. **Answers "Ask Sorted" questions.** You can ask things in plain English, like *"Who owes me what?"*, *"How much did I earn in October?"* or *"Who's my latest payer?"*. A tool-calling agent answers from your ledger. It can also propose actions (create an invoice, send a reminder, mark something paid), and it always waits for your **explicit confirmation** first.

> UK businesses are owed an estimated **£26bn** in late payments at any given time, and **38 businesses close every day** because of late payment.
> Source: [Department for Business and Trade (2025), *Estimating the total economic cost of late payments*](https://assets.publishing.service.gov.uk/media/68652e8f6569be0acf74db3e/late-payments-infographic.pdf).

Built for the **PayPal AI Hackathon** (Devpost), entering Best Use of PayPal + AI, Best Use of Agentic Commerce, and the AG Grid prize.

---

## How PayPal is used

| Feature | PayPal API | Where |
|---|---|---|
| OAuth | `POST /v1/oauth2/token` (client_credentials, cached until near expiry, one automatic refresh on 401) | `src/lib/paypal/client.ts` |
| Invoice numbers | `POST /v2/invoicing/generate-next-invoice-number` | `client.ts` |
| Create invoice | `POST /v2/invoicing/invoices` (with `Prefer: return=representation` and a `PayPal-Request-Id` idempotency key) | `client.ts`, `mapping.ts` |
| Send invoice | `POST /v2/invoicing/invoices/{id}/send` | `client.ts` |
| Sync ledger | `GET /v2/invoicing/invoices` (paginated), `GET /v2/invoicing/invoices/{id}` | `client.ts` |
| Reminders | `send_invoice_reminder` tool from **PayPal Agent Toolkit** (falls back to `POST /v2/invoicing/invoices/{id}/remind`) | `src/lib/paypal/toolkit.ts`, `backend.ts` |
| Ask Sorted's ledger (live mode) | `list_invoices` tool from **PayPal Agent Toolkit** (falls back to REST) | `src/app/api/chat/route.ts` |
| Mark paid (cash / bank transfer) | `POST /v2/invoicing/invoices/{id}/payments` | `client.ts` |

The client retries 429 and 5xx responses with backoff (honouring `Retry-After`) and retries network errors. It also turns PayPal error payloads into readable messages that include the `paypal-debug-id`.

### PayPal Agent Toolkit

[`@paypal/agent-toolkit`](https://www.npmjs.com/package/@paypal/agent-toolkit) (v1.11, AI SDK flavour) supplies the agent's PayPal tool layer in live mode. Ask Sorted reads invoices with the toolkit's `list_invoices` tool, and confirmed reminders go out through its `send_invoice_reminder` tool. **Invoice creation** uses our own REST client, because it needs things the toolkit tool doesn't expose: `Prefer: return=representation`, idempotency keys, retries, and UK/GBP payload shaping (a business vs private recipient, VAT as a per-line tax, a specific due date). The toolkit is loaded with a dynamic import and kept out of the bundle (`serverExternalPackages`). If it fails to load, Sorted falls back to direct REST and the tool trace shows which path ran.

## How AI is used

- **Note parsing** (`src/lib/ai/parse.ts`): an LLM returns structured JSON. Guard rails stop it inventing an email that isn't in the notes and fall back to the heuristic parser if the JSON doesn't make sense.
- **Reminder writing** (`src/lib/ai/remind.ts`): the tone depends on the stage. The model only gets verified facts (amounts, dates, pay link, statutory interest). A guard rail rejects any draft that cites the Late Payment Act for a private customer.
- **Ask Sorted agent** (`src/lib/ai/agent.ts`): a provider-agnostic tool-calling loop with these tools: `get_ledger_summary`, `list_invoices`, `get_earnings`, `rank_payers`, `draft_payment_reminder`, `create_invoice_draft`, `propose_mark_paid`. Any tool that would contact a customer or change an invoice returns a **pending action**. The UI shows it as a "Needs your OK" card, and the user has to confirm before anything is sent.
- **Providers** (`src/lib/ai/provider.ts`): Google Gemini, OpenAI (or any OpenAI-compatible endpoint via `OPENAI_BASE_URL`), and Anthropic, all called with plain `fetch` and native tool calling. Sorted picks the first configured key, or the one named in `SORTED_AI_PROVIDER`.
- **Deterministic fallback, always available**: a regex/heuristic job-notes parser, template reminders, and a rules-based agent that calls the same tools for the common questions. With no API key, every feature still works. Each answer shows which engine produced it ("✦ Google gemini-2.5-flash" or "⚙ Sorted rules engine").

## Modes

| Mode | When | What happens |
|---|---|---|
| **Demo** (badge in header) | No PayPal credentials, or the user picks "Use demo" | Mock PayPal backend with 21 seeded invoices for a Bristol plumbing & heating sole trader (paid / sent / overdue, private and business customers, reminder history). The ledger is kept in the browser's `localStorage`. Nothing is emailed. "Reset demo" restores the seed. |
| **Live (PayPal sandbox)** | The user pastes their own sandbox Client ID + Secret in **Connect PayPal sandbox**, *or* the server has `PAYPAL_CLIENT_ID`/`PAYPAL_CLIENT_SECRET` | PayPal is the source of truth. The ledger syncs from PayPal and invoices really go out (to sandbox emails). Reminder history is also kept locally, because PayPal's list API doesn't return it. |

**Browser-supplied credentials** are stored only in that browser's localStorage and sent over HTTPS on each request (`x-paypal-client-id` / `x-paypal-client-secret`). They are **pinned to `api-m.sandbox.paypal.com`**, so pasted keys can never move real money. The server doesn't store or log them, and token and toolkit caches are keyed by a fingerprint, never by the raw secret. Precedence is browser creds, then server env vars, then demo.

## Setup

```bash
npm install
cp .env.example .env.local   # everything is optional
npm run dev                  # http://localhost:3000
```

```bash
npm run lint && npm run typecheck && npm run build
npm start &                  # then, in another shell:
npm run smoke -- http://localhost:3000   # end-to-end API smoke test (demo mode)
```

### Environment variables

See [`.env.example`](.env.example). They are all optional:

- `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`, `PAYPAL_ENV` (`sandbox` | `live`), `PAYPAL_API_BASE`, `SORTED_FORCE_DEMO`
- `GEMINI_API_KEY` / `GEMINI_MODEL`, `OPENAI_API_KEY` / `OPENAI_MODEL` / `OPENAI_BASE_URL`, `ANTHROPIC_API_KEY` / `ANTHROPIC_MODEL`, `SORTED_AI_PROVIDER`, `SORTED_AI_TIMEOUT_MS`, `SORTED_AI_DISABLED`

### Deploy

Sorted is a standard Next.js 16 App Router app and deploys to Vercel with no configuration. It needs no database. Demo state lives in the browser, and live state lives in PayPal.

## Stack

Next.js 16 (App Router, TypeScript), Tailwind CSS v4, AG Grid Community 36 (`ag-grid-community` + `ag-grid-react`), PayPal Invoicing v2 REST, `@paypal/agent-toolkit`, the Web Speech API (`en-GB`) for dictation.

### AG Grid features used

Custom cell renderers (customer avatar with job summary, status badges, a days-overdue severity bar, reminder stage badges, row actions: Chase / Remind / Paid / PayPal ↗), a status-aware sort comparator, text/number/date column filters, an external filter driven by segmented status chips with live counts, a quick-filter search box, a **pinned bottom totals row that recalculates over the filtered rows**, overdue row classes, pinned columns, CSV export, and responsive column hiding on phones. It uses the `themeQuartz.withParams` theming API.

## AI tools used to build it

The code was written by the **Hark AI agent** (an autonomous coding agent), working from Olly McBride's product brief.

## Not legal advice

Sorted's reminder wording and statutory interest figures are there to help. Check the rules for your situation (gov.uk: *Late commercial payments: charging interest and debt recovery*).

## License

MIT © 2026 Olly McBride
