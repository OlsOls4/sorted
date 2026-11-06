// The one place the Late Payment Act reference rate lives.
//
// Late Payment of Commercial Debts (Interest) Act 1998: statutory interest is 8% a
// year over the Bank of England "reference rate", which is Bank Rate as it stood on
// 30 June (for debts falling overdue 1 Jul–31 Dec) or 31 December (for 1 Jan–30 Jun).
//
// Source, checked 6 Nov 2026: Bank Rate was 3.75% on 30 June 2026 (MPC held at 3.75% on
// 18 June 2026, https://www.bankofengland.co.uk/monetary-policy-summary-and-minutes/2026/june-2026).
// Bank Rate rose to 4% on 5 Nov 2026; that only becomes the reference rate for debts
// falling overdue from 1 Jan 2027 if it still stands on 31 Dec 2026.
export const LATE_PAYMENT_REFERENCE_RATE = 3.75;
export const LATE_PAYMENT_REFERENCE_RATE_AS_OF = "2026-06-30";
export const LATE_PAYMENT_STATUTORY_MARGIN = 8;
