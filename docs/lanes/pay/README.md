# Pay lane sources (GPT lane, Claude reviews)

Copies of the project's finance working files, put here so the pay lane can read them on GitHub. The desk PR is never merged; these files are reference, not a spec change on main.

Authoritative order when two sources disagree:
1. `decisions-2026-10-27.md` (Khalid's settled decisions; SHU-208 pay math, SHU-209 switch gates).
2. On main: `docs/parity/finance-contracts-and-payroll.md` (legacy facts, FI-xx rows), `docs/parity/bank-file-contract/` (formats incl. `legacy-abk-workbook` and `legacy-hdt-advice`, fixtures, `verify.py`), `packages/pay-contracts` (F1), `tools/reconciliation` and `tools/legacy-import` (from #120, synthetic legacy-billing fixtures).
3. Drafts here, read from legacy code on 2026-11-05: `F-1.md` (pay lines), `F-2.md` (generation, weekly job, FI-F16), `F-3.md` (transfer states), `F-4.md` (bank file and payment-advice workbook exports), `F-5.md` (bank result import), `F-6.md` (paid notifications), `F4-invoices.md`, and `W-2-payable-inputs-month-confirm.md` (the payable-input seam the replay reads instead of waiting on Work and hours).
4. `finance-outcomes.md`: the outcome contract per F card (stale D-FI lines corrected 2026-11-17).

Legacy source for line-level reads: `BAWES-Universe/studenthub` (master), paths cited in each draft.
