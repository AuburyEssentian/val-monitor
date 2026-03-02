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

# Sync committee membership (current + next period)
val-monitor sync

# Prometheus metrics endpoint (for Grafana/VictoriaMetrics)
val-monitor metrics
val-monitor metrics --port 9100
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

## Prometheus metrics (v1.5+)

```bash
# Start a Prometheus /metrics endpoint (default: port 9090)
val-monitor metrics
val-monitor metrics --port 9100

# Example scrape config for VictoriaMetrics / Prometheus
```

Add to your `prometheus.yml` or `victoria-metrics.yml`:

```yaml
scrape_configs:
  - job_name: val-monitor
    static_configs:
      - targets: ['localhost:9090']
    scrape_interval: 60s
```

**Exposed metrics:**

| Metric | Type | Description |
|--------|------|-------------|
| `val_monitor_balance_gwei` | gauge | Validator balance in Gwei |
| `val_monitor_balance_eth` | gauge | Validator balance in ETH |
| `val_monitor_active` | gauge | 1 if status is active, 0 otherwise |
| `val_monitor_slashed` | gauge | 1 if slashed |
| `val_monitor_attestation_rate` | gauge | Attestation effectiveness (0–1) over last 10 epochs |
| `val_monitor_sync_duty` | gauge | 1 if in current sync committee |
| `val_monitor_last_scrape_timestamp` | gauge | Unix timestamp of last successful scrape |

All metrics have `index` and `pubkey` labels. Scraping is on-demand — no background polling.

## Pointing at Sam's nodes

```bash
val-monitor set beacon http://samcm-nuc14-1:5052
val-monitor add 12345
```
