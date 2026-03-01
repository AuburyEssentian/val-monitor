# val-monitor

Ethereum validator health monitor. Uses the standard CL REST API — no API key required.

## Install

```bash
cd val-monitor
bun install
# optional: link globally
bun link
```

## Usage

```bash
# Track validators
val-monitor add 12345
val-monitor add 67890 --webhook https://discord.com/api/webhooks/...

# Configure beacon node and webhook without editing JSON
val-monitor set beacon http://samcm-nuc14-1:5052
val-monitor set webhook https://discord.com/api/webhooks/...

# Check status (includes upcoming block proposals)
val-monitor status
val-monitor status --index 12345 67890  # ad-hoc, not saved

# Show attester + proposer duties for current epoch
val-monitor duties
val-monitor duties --epoch 337000

# Check for missed attestations (last epoch)
val-monitor missed
val-monitor missed --epoch 337000

# Watch continuously (polls every 60s, alerts to Discord on issues)
val-monitor watch
val-monitor watch --interval 30 --webhook https://discord.com/api/webhooks/...

# Attestation performance over last N epochs (default 10, max 50)
val-monitor performance
val-monitor performance --epochs 20

# List config
val-monitor list
```

## Config

Stored at `~/.val-monitor.json`:

```json
{
  "validators": [12345, 67890],
  "beaconNode": "http://localhost:5052",
  "webhook": "https://discord.com/api/webhooks/..."
}
```

Set `beaconNode` to point at your own node. Defaults to `lodestar-mainnet.chainsafe.io`.

## What it monitors

- **status** — validator state, balance, effective balance, next attestation slot, upcoming block proposals
- **duties** — full epoch view: all attester duties (grouped by slot) + proposer duties with hit/miss for past slots
- **missed** — checks if validators actually attested in a given epoch (reads aggregation_bits from blocks)
- **performance** — attestation rate over the last N epochs (1–50), per-validator with ASCII bar chart, sorted by worst performers first
- **watch** — continuous loop:
  - Balance drops > 0.01 ETH
  - Status changes (e.g. active → exiting)
  - Slashing events
  - Missed attestations (checked once per epoch transition)
  - Missed block proposals (checked when a scheduled proposal slot passes)
  - Sends Discord webhook alert on any of the above

## Pointing at Sam's nodes

```bash
val-monitor set beacon http://samcm-nuc14-1:5052
val-monitor add 12345
```
