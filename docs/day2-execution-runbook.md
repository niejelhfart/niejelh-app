# N3 Day-2 Execution Runbook (A -> B -> C Discipline)

## Scope
Backend-only hardening for Phase A (institutional-grade 9.5 target).

## Hard Gates Between Epics
- Gate G1: Do not start Epic 2 until A1-A4 are merged and verified.
- Gate G2: Do not start Epic 4 until A8-A10 are green (tests + run artifacts).

## Single Definition of Done (Per Commit)
Every task commit must satisfy all checks below:
1. Build/test pass
- `npm --prefix functions test`
2. N2 smoke pass
- Run one N2 smoke (`scripts/sim-n2.mjs`) with run artifact captured.
3. Reconcile pass
- `npm run reconcile:ledger -- --opening-wallet 50000`
- Must report `mismatches=0`.
4. No out-of-scope behavior change
- Diff review limited to acceptance criteria for that task.

## Required Task Dependency Order
Execute strictly in this order:
1. A1
2. A2
3. A3
4. A4
5. A6
6. A7
7. A5
8. A8
9. A9
10. A10
11. A11
12. A13
13. A12
14. A14
15. A15
16. A16
17. A17
18. A18

## Epic Gate Checklists

### Gate G1 (Before Epic 2)
- A1 merged and verified
- A2 merged and verified
- A3 merged and verified
- A4 merged and verified
- Latest `npm --prefix functions test` green
- Latest N2 smoke + reconcile artifacts attached

### Gate G2 (Before Epic 4)
- A8 merged and verified
- A9 merged and verified
- A10 merged and verified
- Adversarial run artifacts attached
- Reconcile still clean (`mismatches=0`)

## Current Status Snapshot (as of 2026-03-02)
- A1 helper present: `emitInvariantEvent(...)` in `functions/src/index.ts`
- A2 wiring present: `place_bet_failed`
- A3 wiring present: `match_settlement_failed`
- A4 wiring present: reconcile `LEDGER_MISMATCH`
- `docs/financial-alerts.md` present

## Next Executable Action
- Merge and verify A1-A4 as a clean commit set on `n3-day2-monitoring`.
- Then start A6 (version monotonicity assertion) per order.
