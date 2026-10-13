# Sorted parser accuracy: 50 real-world job notes

**With AI on (the deployed app): totals exactly right on 41/50 notes, customer right on 50/50.**
**Rules engine alone (no AI, no network): totals exactly right on 22/50, customer right on 45/50, VAT right on 50/50.**

Run on 13 Oct 2026 against commit `a7d4a46` (main).

## The test set

`eval/job-notes.json` has 50 job notes written the way UK tradespeople actually type them: plumbers, electricians, joiners, cleaners, gardeners, decorators, roofers, locksmiths, a gas engineer, a tiler, a window cleaner and a handyman. The notes include slang ("18 quid", "call out 45", "1.2k", "a score", "2 n half hrs"), typos, VAT-registered and non-registered traders, "+ VAT", "no vat" and "inc vat", business and private customers, hours × rate, day rates, quantities ("6 x £8", "3 flats at 120 each"), multiple workers and missing names or emails.

Each note is hand-labelled with the invoice it should produce: customer name(s), customer type, every line (kind, quantity, unit price), whether VAT applies, subtotal, VAT and total. Each note also carries the trader settings (hourly rate, VAT registration) the app would send with it. The labelling rules are in the file.

## How it was run

`node scripts/eval-parser.mjs` runs the app's own parse path (`parseNotes` in `src/lib/ai/parse.ts`, the same code `/api/parse` uses) and scores each output.

- **Rules engine:** local, with `SORTED_AI_DISABLED=1`. Deterministic, 0 AI calls.
- **AI:** the Groq key lives only on Vercel, so each note was POSTed to `https://sorted-paypal.vercel.app/api/parse` with a 3 second pause between calls. The deployed chain is Groq `openai/gpt-oss-20b` first. 55 calls in total (50 notes + 5 retries). From note 41 on, Groq rate-limited the shared quota, so 4 notes were answered by the app's Groq fallback model (`qwen/qwen3.8-27b`) and 4 by the rules engine. Neither run used `gpt-oss-120b`. The "gpt-oss-20b only" column scores only the 42 notes that model answered.

A field counts as right only when it is exactly right: the name matches a label (ignoring case and punctuation), the number of lines matches, every expected line amount appears, the VAT on/off decision matches, and the total matches to the penny.

## Results

| Field | Rules engine (50) | AI as deployed (50) | gpt-oss-20b only (42) |
|---|---|---|---|
| Customer name | 45/50 (90%) | **50/50 (100%)** | 42/42 (100%) |
| Customer type (business/private) | 48/50 (96%) | 50/50 (100%) | 42/42 (100%) |
| Line count | 34/50 (68%) | 41/50 (82%) | 36/42 (86%) |
| All line amounts right | 22/50 (44%) | 40/50 (80%) | 36/42 (86%) |
| Individual lines found | 73/109 (67%) | 97/109 (89%) | 83/91 (91%) |
| VAT handling | **50/50 (100%)** | 49/50 (98%) | 41/42 (98%) |
| Subtotal exact | 22/50 (44%) | 42/50 (84%) | 38/42 (90%) |
| **Total exact (to the penny)** | **22/50 (44%)** | **41/50 (82%)** | **37/42 (88%)** |
| Whole invoice right (name, lines, VAT, total) | 18/50 (36%) | 39/50 (78%) | 35/42 (83%) |

Two of the AI's line-count misses (n27, n43) still got the total right. The model merged "3 rooms @ 40 + stairs 25" into one line, and split "4 certs at 65 each" into four lines.

## Where it goes wrong

### AI (gpt-oss-20b)
1. **Small extras dropped (3 notes).** It left out a short priced item at the end of a note: "screws 12" (n22), "sizing + paste 11" (n34), and "call it a score extra" (n24, slang for £20).
2. **"No vat" ignored for a VAT-registered trader (n17).** The model read "cash job no vat" correctly, but `parse.ts` sets `vatEnabled = settings.vatRegistered || ai.vatMentioned`, so a registered trader always gets VAT. This is a code bug, not a model error. The rules engine gets this note right.
3. **Several workers not multiplied (n31).** "2 of us 4 hours" was billed as 4 hours, not 8. The model also dropped the £220 skip on this note.

### Rules engine
1. **Bare numbers without £ or "quid" are dropped (12 notes).** For example "chemicals 35", "EICR cert 60", "sundries 10", "petrol 8", "tiles 8 x 4.50", "sealant n rawlplugs 9.60". A number only counts as money next to a keyword such as parts, call out or rate.
2. **Quantity × unit price is split into two amounts (9 notes).** "6 boards @ 14.50", "3 rooms @ 40 a room", "3 flats at 120 each", "posts 4 x 15", "£65 per house" and "2.5 sq m @ 45" each became a £6 or £3 "part" plus a single unit price.
3. **Other parsing slips (8 notes).** The note is split into clauses on commas, so "£1,350" becomes £1 and 350 (n44). "1 day at 200" was read as 8 hours at the hourly rate (n36). "2 cleaners 5 hrs each" and "2 of us" were not multiplied (n23, n31). "1450 inc vat" had VAT added on top, giving £1,740 (n40). Customer names were taken from an email address ("Manager", n10), cut at an apostrophe ("Liam", n19), cut short ("Bath Road Housing", n39), or missed ("Riverside Hotel", "Kevin @ No.7").

## Suggested fixes
- **`parse.ts`:** trust an explicit "no vat" by using the rules engine's VAT decision whenever the notes mention VAT. After the AI answers, compare the amounts in the notes with the model's lines, and add a warning (or the rules engine's line) for any amount the model left out.
- **AI prompt:** say that every priced item gets a line, that "N of us" or "N cleaners" multiplies the hours, and that "a score" means £20.
- **`parser.ts`:**
  - Join thousands separators before splitting the note into clauses.
  - Read "N x £X", "N <thing> @/at X (each/per/a <thing>)" and "X each" as one line, quantity N at £X.
  - Accept a bare trailing number as money when the clause names an item.
  - Treat "N day(s) at X" as a day rate.
  - Back the VAT out of "inc vat" prices.

## Reproduce
```
node scripts/eval-parser.mjs --engine rules
node scripts/eval-parser.mjs --engine remote --only n01,...,n10     # then --append for more chunks; budget is --max-calls 55
node scripts/eval-parser.mjs --rescore eval/raw-remote.json          # re-score saved outputs, no calls
```
Raw outputs: `eval/raw-rules.json`, `eval/raw-remote.json`. Per-note scores: `eval/scores-*.json`.
