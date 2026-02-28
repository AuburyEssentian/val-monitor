# val-monitor

Quick Ethereum validator health check. Uses the standard CL REST API — no API keys required.

## Install

```sh
cd val-monitor
bun install
bun link  # makes `val-monitor` available globally
```

Or run directly:

```sh
bun run index.ts status --index 12345
```

## Usage

```sh
# Add validators to track
val-monitor add 12345
val-monitor add 67890

# Check status
val-monitor status

# Ad-hoc check (not saved to config)
val-monitor status --index 1 2 3

# List tracked validators
val-monitor list

# Remove a validator
val-monitor remove 12345
```

## Config

Config lives at `~/.val-monitor.json`. To use your own beacon node instead of the public Lodestar endpoint:

```json
{
  "validators": [12345, 67890],
  "beaconNode": "http://localhost:5052"
}
```

Any beacon node that exposes the standard Ethereum CL REST API works (Lighthouse, Prysm, Teku, Lodestar, Grandine).

## Output

```
  Validator Status
  Beacon: http://localhost:5052 | Finalized epoch: 430967 | Head epoch ~430969

  Index       Status                  Balance ETH     Eff Bal ETH     Next Att Slot
  ────────────────────────────────────────────────────────────────────────────────
  12345       active_ongoing          32.0481         32.0000         13791024

  ✓  All 1 validators active and healthy
  Active: 1/1  |  Total balance: 32.0481 ETH
  Chain uptime: 1915 days
```

Fields:
- **Status**: CL validator lifecycle state
- **Balance**: current balance in ETH
- **Eff Bal**: effective balance (what's used for attestation weight)
- **Next Att Slot**: next slot this validator is scheduled to attest
