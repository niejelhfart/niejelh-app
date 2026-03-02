# Financial Alert Contract

`invariantVersion`: `1`

All invariant events use a shared payload contract:

- `event`
- `severity` (`critical` | `warning` | `info`)
- `invariantVersion`
- `runId` / `requestId` (when available)
- `uid` (when available)
- `matchId` (when available)
- `errorCode` / `errorMessage`
- `timestamp`

## Critical Alerts

- `LEDGER_MISMATCH`
- `NEGATIVE_WALLET`
- `DUPLICATE_LEDGER_SIDE_EFFECT`
- `VERSION_REGRESSION`
- `CAP_BREACH_ANOMALY`

Critical alerts are persisted to:

- `audit/anomalies/records/{id}`

## Warning Alerts

- `HIGH_CONTENTION_RETRY`
- `HIGH_SETTLEMENT_CONFLICT_RATE`
- `TX_CONTENTION_WARNING`

Warning alerts are emitted to structured logs and do not block writes.
