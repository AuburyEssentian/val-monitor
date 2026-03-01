#!/usr/bin/env bun
/**
 * val-monitor — Ethereum validator health monitor
 *
 * Uses the standard CL REST API (no auth required on public nodes).
 * Defaults to lodestar-mainnet.chainsafe.io — or point at your own beacon node.
 *
 * Usage:
 *   val-monitor status                  # show all tracked validators
 *   val-monitor status --index 1 2 3    # ad-hoc check
 *   val-monitor add <index>             # add to config
 *   val-monitor remove <index>          # remove from config
 *   val-monitor list                    # list tracked validators and config
 *   val-monitor set beacon <url>        # set beacon node URL
 *   val-monitor set webhook <url>       # set Discord webhook URL
 *   val-monitor duties [--epoch N]      # show attester + proposer duties
 *   val-monitor watch                   # continuous monitoring with alerts
 *   val-monitor watch --webhook <url>   # post alerts to Discord webhook
 *   val-monitor missed [--epoch N]      # check for missed attestations last epoch
 *   val-monitor performance [--epochs N] # attestation rate over last N epochs (default 10)
 */

import chalk from "chalk";
import { Command } from "commander";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { homedir } from "os";
import { join } from "path";

// ── Config ────────────────────────────────────────────────────────────────────

const DEFAULT_CONFIG_PATH = join(homedir(), ".val-monitor.json");
const DEFAULT_BEACON = "https://lodestar-mainnet.chainsafe.io";

interface Config {
  validators: number[];
  beaconNode?: string;
  webhook?: string;
}

function loadConfig(path: string): Config {
  if (!existsSync(path)) return { validators: [] };
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    console.error(chalk.red(`Failed to parse config at ${path}`));
    process.exit(1);
  }
}

function saveConfig(path: string, cfg: Config) {
  writeFileSync(path, JSON.stringify(cfg, null, 2) + "\n");
}

// ── CL REST API ───────────────────────────────────────────────────────────────

interface CLValidator {
  index: string;
  balance: string;
  status: string;
  validator: {
    pubkey: string;
    effective_balance: string;
    slashed: boolean;
    activation_epoch: string;
    exit_epoch: string;
  };
}

interface FinalityCheckpoints {
  finalized: { epoch: string };
  current_justified: { epoch: string };
  previous_justified: { epoch: string };
}

async function fetchValidators(indices: number[], base: string): Promise<CLValidator[]> {
  if (indices.length === 0) return [];
  const url = `${base}/eth/v1/beacon/states/head/validators`;
  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ids: indices.map(String) }),
  });
  if (!r.ok) {
    const results: CLValidator[] = [];
    for (const idx of indices.slice(0, 20)) {
      const gr = await fetch(`${base}/eth/v1/beacon/states/head/validators/${idx}`);
      if (gr.ok) {
        const gj = await gr.json() as { data: CLValidator };
        results.push(gj.data);
      }
    }
    return results;
  }
  const json = await r.json() as { data: CLValidator[] };
  return json.data ?? [];
}

async function fetchFinalityCheckpoints(base: string): Promise<FinalityCheckpoints | null> {
  const r = await fetch(`${base}/eth/v1/beacon/states/head/finality_checkpoints`);
  if (!r.ok) return null;
  const json = await r.json() as { data: FinalityCheckpoints };
  return json.data ?? null;
}

async function fetchGenesis(base: string): Promise<{ genesis_time: string } | null> {
  const r = await fetch(`${base}/eth/v1/beacon/genesis`);
  if (!r.ok) return null;
  const json = await r.json() as { data: { genesis_time: string } };
  return json.data ?? null;
}

async function fetchHeadSlot(base: string): Promise<number> {
  const r = await fetch(`${base}/eth/v1/beacon/headers/head`).catch(() => null);
  if (!r || !r.ok) return 0;
  const j = await r.json() as { data: { header: { message: { slot: string } } } };
  return Number(j?.data?.header?.message?.slot ?? 0);
}

// Check if a block exists at the given slot (returns proposer_index or null if missed)
async function fetchBlockProposerIndex(slot: number, base: string): Promise<number | null> {
  const r = await fetch(`${base}/eth/v1/beacon/headers/${slot}`).catch(() => null);
  if (!r || !r.ok) return null;
  const j = await r.json() as { data: { header: { message: { proposer_index: string } } } };
  const proposerIndex = j?.data?.header?.message?.proposer_index;
  return proposerIndex !== undefined ? Number(proposerIndex) : null;
}

// ── Attester duties ───────────────────────────────────────────────────────────

interface AttesterDuty {
  slot: number;
  committee_index: number;
  committee_length: number;
  validator_committee_index: number;
}

async function fetchAttesterDuties(
  epoch: number,
  indices: number[],
  base: string
): Promise<Map<number, AttesterDuty>> {
  const map = new Map<number, AttesterDuty>();
  const r = await fetch(`${base}/eth/v1/validator/duties/attester/${epoch}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(indices.map(String)),
  });
  if (!r.ok) return map;
  const json = await r.json() as {
    data: Array<{
      validator_index: string;
      slot: string;
      committee_index: string;
      committee_length: string;
      validator_committee_index: string;
    }>;
  };
  for (const d of json.data ?? []) {
    map.set(Number(d.validator_index), {
      slot: Number(d.slot),
      committee_index: Number(d.committee_index),
      committee_length: Number(d.committee_length),
      validator_committee_index: Number(d.validator_committee_index),
    });
  }
  return map;
}

// ── Proposer duties ───────────────────────────────────────────────────────────

interface ProposerDuty {
  validator_index: number;
  slot: number;
}

/**
 * Fetch all proposer duties for the given epoch and return only those
 * belonging to the provided validator indices.
 */
async function fetchProposerDuties(
  epoch: number,
  indices: number[],
  base: string
): Promise<ProposerDuty[]> {
  const r = await fetch(`${base}/eth/v1/validator/duties/proposer/${epoch}`).catch(() => null);
  if (!r || !r.ok) return [];
  const json = await r.json() as {
    data: Array<{ validator_index: string; slot: string }>;
  };
  const indexSet = new Set(indices);
  return (json.data ?? [])
    .map(d => ({ validator_index: Number(d.validator_index), slot: Number(d.slot) }))
    .filter(d => indexSet.has(d.validator_index))
    .sort((a, b) => a.slot - b.slot);
}

// ── Missed attestation detection ──────────────────────────────────────────────

interface AttestationData {
  slot: string;
  index: string;
}

interface PhaseAttestation {
  aggregation_bits: string;
  committee_bits?: string;
  data: AttestationData;
}

function decodeBits(hexOrBin: string, length: number): boolean[] {
  const hex = hexOrBin.startsWith("0x") ? hexOrBin.slice(2) : hexOrBin;
  const bits: boolean[] = [];
  for (let i = 0; i < hex.length; i++) {
    const byte = parseInt(hex[i]!, 16);
    for (let b = 0; b < 4; b++) {
      if (bits.length < length) {
        bits.push(Boolean((byte >> b) & 1));
      }
    }
  }
  return bits;
}

async function checkMissedAttestations(
  epoch: number,
  validatorIndices: number[],
  base: string
): Promise<Map<number, boolean>> {
  const result = new Map<number, boolean>(validatorIndices.map(i => [i, false]));

  const duties = await fetchAttesterDuties(epoch, validatorIndices, base);
  if (duties.size === 0) return result;

  const slotToValidators = new Map<number, number[]>();
  for (const [valIdx, duty] of duties) {
    const validators = slotToValidators.get(duty.slot) ?? [];
    validators.push(valIdx);
    slotToValidators.set(duty.slot, validators);
  }

  for (const [slot, valIndices] of slotToValidators) {
    let found = false;
    for (const checkSlot of [slot + 1, slot + 2, slot + 4]) {
      const r = await fetch(`${base}/eth/v2/beacon/blocks/${checkSlot}`).catch(() => null);
      if (!r || !r.ok) continue;

      const j = await r.json() as {
        data: { message: { body: { attestations: PhaseAttestation[] } } };
      };

      const attestations = j?.data?.message?.body?.attestations ?? [];
      for (const att of attestations) {
        if (Number(att.data.slot) !== slot) continue;

        for (const valIdx of valIndices) {
          if (result.get(valIdx)) continue;
          const duty = duties.get(valIdx);
          if (!duty) continue;
          if (Number(att.data.index) !== duty.committee_index) continue;

          const bits = decodeBits(att.aggregation_bits, duty.committee_length);
          if (bits[duty.validator_committee_index]) {
            result.set(valIdx, true);
            found = true;
          }
        }
      }
      if (found) break;
    }
  }

  return result;
}

// ── Discord webhook ───────────────────────────────────────────────────────────

interface DiscordEmbed {
  title?: string;
  description?: string;
  color?: number;
  fields?: Array<{ name: string; value: string; inline?: boolean }>;
  timestamp?: string;
}

async function sendWebhook(url: string, content: string, embeds?: DiscordEmbed[]) {
  try {
    await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content, embeds }),
    });
  } catch (e) {
    console.error(chalk.red(`Webhook failed: ${e}`));
  }
}

// ── Formatting ────────────────────────────────────────────────────────────────

function gweiToEth(gweiStr: string): string {
  return (Number(gweiStr) / 1e9).toFixed(4);
}

function statusBadge(s: string): string {
  if (s === "active_ongoing") return chalk.green("active_ongoing");
  if (s.startsWith("active")) return chalk.yellow(s);
  if (["exiting_slashed", "withdrawal_possible", "withdrawal_done"].includes(s)) return chalk.gray(s);
  if (s.includes("slashed")) return chalk.red(s);
  return chalk.yellow(s);
}

function epochSlotToTime(slot: number, genesisTime: number): string {
  const slotTime = genesisTime + slot * 12;
  const now = Math.floor(Date.now() / 1000);
  const diff = slotTime - now;
  if (Math.abs(diff) < 60) return `${diff > 0 ? "in" : ""} ${Math.abs(diff)}s${diff < 0 ? " ago" : ""}`;
  const mins = Math.round(diff / 60);
  if (Math.abs(mins) < 60) return `${mins > 0 ? "in" : ""} ${Math.abs(mins)}m${mins < 0 ? " ago" : ""}`;
  const hrs = Math.round(diff / 3600);
  return `${hrs > 0 ? "in" : ""} ${Math.abs(hrs)}h${hrs < 0 ? " ago" : ""}`;
}

// ── Commands ──────────────────────────────────────────────────────────────────

async function cmdStatus(opts: { index?: string[]; config: string }) {
  const cfg = loadConfig(opts.config);
  const base = (cfg.beaconNode ?? DEFAULT_BEACON).replace(/\/$/, "");

  const indices = opts.index
    ? opts.index.map(Number).filter(n => !isNaN(n))
    : cfg.validators;

  if (indices.length === 0) {
    console.log(chalk.yellow("\n  No validators configured. Use `val-monitor add <index>` or --index.\n"));
    return;
  }

  process.stdout.write(chalk.gray(`  Connecting to ${base}...`));

  const headSlot = await fetchHeadSlot(base);
  const headEpoch = Math.floor(headSlot / 32);

  const [validators, checkpoints, genesis] = await Promise.all([
    fetchValidators(indices, base),
    fetchFinalityCheckpoints(base),
    fetchGenesis(base),
  ]);

  process.stdout.write(chalk.gray(" done\n"));

  if (validators.length === 0) {
    console.log(chalk.red("  No validator data returned. Check your beacon node or indices.\n"));
    return;
  }

  const finalizedEpoch = Number(checkpoints?.finalized.epoch ?? 0);
  const currentEpoch = headEpoch > 0 ? headEpoch : (finalizedEpoch > 0 ? finalizedEpoch + 2 : 0);

  let duties = new Map<number, AttesterDuty>();
  let proposerDuties: ProposerDuty[] = [];
  try {
    const validIndices = validators
      .filter(v => v.status.startsWith("active"))
      .map(v => Number(v.index));
    if (validIndices.length > 0) {
      [duties, proposerDuties] = await Promise.all([
        fetchAttesterDuties(currentEpoch, validIndices, base),
        fetchProposerDuties(currentEpoch, validIndices, base),
      ]);
      // Also check next epoch for proposals
      const nextEpochProposals = await fetchProposerDuties(currentEpoch + 1, validIndices, base);
      proposerDuties = [...proposerDuties, ...nextEpochProposals];
    }
  } catch { /* non-fatal */ }

  // Build proposer duty map: valIdx -> list of slots
  const proposerSlots = new Map<number, number[]>();
  for (const pd of proposerDuties) {
    const slots = proposerSlots.get(pd.validator_index) ?? [];
    slots.push(pd.slot);
    proposerSlots.set(pd.validator_index, slots);
  }

  validators.sort((a, b) => {
    const aA = a.status.startsWith("active") ? 0 : 1;
    const bA = b.status.startsWith("active") ? 0 : 1;
    return aA - bA || Number(a.index) - Number(b.index);
  });

  console.log();
  console.log(chalk.bold("  Validator Status"));
  console.log(chalk.gray(`  Beacon: ${base} | Finalized: epoch ${finalizedEpoch} | Head: epoch ~${currentEpoch} (slot ${headSlot})`));
  console.log();

  const hIdx = "Index".padEnd(10);
  const hStatus = "Status".padEnd(22);
  const hBal = "Balance ETH".padEnd(14);
  const hAtt = "Next Att".padEnd(12);
  const hProp = "Proposals";

  console.log("  " + chalk.bold([hIdx, hStatus, hBal, hAtt, hProp].join("  ")));
  console.log("  " + "─".repeat(80));

  let issueCount = 0;
  for (const v of validators) {
    const idx = Number(v.index);
    const duty = duties.get(idx);
    const nextAtt = duty ? chalk.cyan(String(duty.slot)) : chalk.gray("—");

    const pSlots = proposerSlots.get(idx) ?? [];
    const propDisplay = pSlots.length > 0
      ? chalk.magenta(`slots ${pSlots.join(", ")}`)
      : chalk.gray("—");

    const slashed = v.validator.slashed ? chalk.red(" SLASHED") : "";
    const isIssue = !v.status.startsWith("active") || v.validator.slashed;
    if (isIssue) issueCount++;

    const statusRaw = v.status + (v.validator.slashed ? " SLASHED" : "");
    const statusFormatted = statusBadge(v.status) + slashed;
    const statusPad = " ".repeat(Math.max(0, 22 - statusRaw.length));

    const row = [
      String(idx).padEnd(10),
      statusFormatted + statusPad,
      gweiToEth(v.balance).padEnd(14),
      nextAtt.padEnd(12),
      propDisplay,
    ];
    console.log("  " + row.join("  "));
  }

  console.log();
  const totalBalance = validators.reduce((s, v) => s + Number(v.balance), 0);
  const activeCount = validators.filter(v => v.status.startsWith("active")).length;
  const totalProposals = proposerDuties.length;

  if (issueCount > 0) {
    console.log(chalk.red(`  ⚠  ${issueCount} validator(s) need attention`));
  } else {
    console.log(chalk.green(`  ✓  All ${activeCount} validators active and healthy`));
  }

  console.log(chalk.gray(`  Active: ${activeCount}/${validators.length}  |  Total balance: ${(totalBalance / 1e9).toFixed(4)} ETH`));

  if (totalProposals > 0) {
    const slots = proposerDuties.map(d => `#${d.slot} (val ${d.validator_index})`);
    console.log(chalk.magenta(`  Upcoming proposals: ${slots.join(", ")}`));
  }

  if (genesis) {
    const uptime = Math.floor((Date.now() / 1000 - Number(genesis.genesis_time)) / 86400);
    console.log(chalk.gray(`  Chain uptime: ${uptime} days`));
  }

  console.log();
}

async function cmdDuties(opts: { epoch?: string; config: string }) {
  const cfg = loadConfig(opts.config);
  const base = (cfg.beaconNode ?? DEFAULT_BEACON).replace(/\/$/, "");
  const indices = cfg.validators;

  if (indices.length === 0) {
    console.log(chalk.yellow("No validators configured. Use `val-monitor add <index>` first."));
    return;
  }

  const headSlot = await fetchHeadSlot(base);
  const headEpoch = Math.floor(headSlot / 32);
  const targetEpoch = opts.epoch ? Number(opts.epoch) : headEpoch;
  const genesis = await fetchGenesis(base);
  const genesisTime = Number(genesis?.genesis_time ?? 0);

  process.stdout.write(chalk.gray(`  Fetching duties for epoch ${targetEpoch}...`));

  const activeIndices = (await fetchValidators(indices, base))
    .filter(v => v.status.startsWith("active"))
    .map(v => Number(v.index));

  const [attDuties, propDuties] = await Promise.all([
    fetchAttesterDuties(targetEpoch, activeIndices, base),
    fetchProposerDuties(targetEpoch, activeIndices, base),
  ]);

  process.stdout.write(chalk.gray(" done\n"));

  console.log();
  console.log(chalk.bold(`  Duties — Epoch ${targetEpoch}`));
  console.log(chalk.gray(`  Beacon: ${base} | Epoch slots ${targetEpoch * 32}–${targetEpoch * 32 + 31}`));
  console.log();

  // Proposer duties
  if (propDuties.length === 0) {
    console.log(chalk.gray("  Block proposals: none scheduled this epoch"));
  } else {
    console.log(chalk.bold("  Block Proposals:"));
    for (const pd of propDuties) {
      const slotTime = genesisTime ? epochSlotToTime(pd.slot, genesisTime) : "";
      const timeLabel = slotTime ? chalk.gray(` (${slotTime})`) : "";
      const alreadyPast = pd.slot < headSlot;
      const proposerIdx = alreadyPast ? await fetchBlockProposerIndex(pd.slot, base) : null;
      let statusLabel = "";
      if (alreadyPast) {
        if (proposerIdx === pd.validator_index) {
          statusLabel = chalk.green(" ✓ proposed");
        } else if (proposerIdx !== null) {
          statusLabel = chalk.red(` ✗ missed (block proposed by ${proposerIdx})`);
        } else {
          statusLabel = chalk.red(" ✗ missed (no block)");
        }
      }
      console.log(`    ${chalk.magenta(`slot ${pd.slot}`)} → validator ${chalk.bold(String(pd.validator_index))}${timeLabel}${statusLabel}`);
    }
    console.log();
  }

  // Attester duties
  console.log(chalk.bold("  Attestation Duties:"));
  if (attDuties.size === 0) {
    console.log(chalk.gray("  No attester duties found (are validators active?)"));
  } else {
    // Group by slot
    const bySlot = new Map<number, Array<{ valIdx: number; duty: AttesterDuty }>>();
    for (const [valIdx, duty] of attDuties) {
      const arr = bySlot.get(duty.slot) ?? [];
      arr.push({ valIdx, duty });
      bySlot.set(duty.slot, arr);
    }
    const sortedSlots = [...bySlot.keys()].sort((a, b) => a - b);
    for (const slot of sortedSlots) {
      const entries = bySlot.get(slot)!;
      const slotTime = genesisTime ? epochSlotToTime(slot, genesisTime) : "";
      const timeLabel = slotTime ? chalk.gray(` (${slotTime})`) : "";
      const valLabels = entries.map(e => `val ${e.valIdx} [committee ${e.duty.committee_index}, pos ${e.duty.validator_committee_index}/${e.duty.committee_length}]`);
      console.log(`    ${chalk.cyan(`slot ${slot}`)}${timeLabel}`);
      for (const label of valLabels) {
        console.log(`      ${chalk.gray(label)}`);
      }
    }
  }
  console.log();
}

async function cmdMissed(opts: { epoch?: string; config: string }) {
  const cfg = loadConfig(opts.config);
  const base = (cfg.beaconNode ?? DEFAULT_BEACON).replace(/\/$/, "");
  const indices = cfg.validators;

  if (indices.length === 0) {
    console.log(chalk.yellow("No validators configured."));
    return;
  }

  const headSlot = await fetchHeadSlot(base);
  const headEpoch = Math.floor(headSlot / 32);
  const targetEpoch = opts.epoch ? Number(opts.epoch) : headEpoch - 1;

  if (targetEpoch < 0) {
    console.log(chalk.yellow("Not enough epochs elapsed yet."));
    return;
  }

  console.log();
  console.log(chalk.bold(`  Missed Attestation Check — Epoch ${targetEpoch}`));
  console.log(chalk.gray(`  Beacon: ${base} | Checking ${indices.length} validators...`));
  console.log();

  const results = await checkMissedAttestations(targetEpoch, indices, base);

  let missed = 0;
  for (const [valIdx, attested] of results) {
    const badge = attested
      ? chalk.green("  ✓ attested")
      : chalk.red("  ✗ MISSED");
    console.log(`  ${String(valIdx).padEnd(10)} ${badge}`);
    if (!attested) missed++;
  }

  console.log();
  if (missed > 0) {
    console.log(chalk.red(`  ⚠  ${missed}/${results.size} validators missed attestations in epoch ${targetEpoch}`));
  } else {
    console.log(chalk.green(`  ✓  All validators attested in epoch ${targetEpoch}`));
  }
  console.log();
}

// ── Watch command ─────────────────────────────────────────────────────────────

interface WatchState {
  lastEpochChecked: number;
  balances: Map<number, number>;
  statuses: Map<number, string>;
  // Track proposal duties for current epoch so we can detect misses
  knownProposals: Map<number, { validatorIndex: number; alerted: boolean }>; // slot -> duty
}

async function cmdWatch(opts: { interval?: string; webhook?: string; config: string }) {
  const cfg = loadConfig(opts.config);
  const base = (cfg.beaconNode ?? DEFAULT_BEACON).replace(/\/$/, "");
  const webhook = opts.webhook ?? cfg.webhook;
  const intervalSec = Number(opts.interval ?? 60);

  if (cfg.validators.length === 0) {
    console.log(chalk.yellow("No validators configured. Use `val-monitor add <index>` first."));
    return;
  }

  console.log(chalk.bold(`\n  val-monitor watch`));
  console.log(chalk.gray(`  Beacon: ${base}`));
  console.log(chalk.gray(`  Monitoring ${cfg.validators.length} validators | Polling every ${intervalSec}s`));
  if (webhook) console.log(chalk.gray(`  Alerts → Discord webhook`));
  console.log(chalk.gray(`  Press Ctrl+C to stop\n`));

  const state: WatchState = {
    lastEpochChecked: -1,
    balances: new Map(),
    statuses: new Map(),
    knownProposals: new Map(),
  };

  const notify = async (msg: string, embed?: DiscordEmbed) => {
    console.log(chalk.yellow(`  [alert] ${msg}`));
    if (webhook) await sendWebhook(webhook, msg, embed ? [embed] : undefined);
  };

  const check = async () => {
    try {
      const headSlot = await fetchHeadSlot(base);
      const headEpoch = Math.floor(headSlot / 32);

      const validators = await fetchValidators(cfg.validators, base);
      if (validators.length === 0) return;

      const timestamp = new Date().toISOString().slice(11, 19);
      const issues: string[] = [];

      for (const v of validators) {
        const idx = Number(v.index);
        const balGwei = Number(v.balance);

        const prevStatus = state.statuses.get(idx);
        if (prevStatus !== undefined && prevStatus !== v.status) {
          issues.push(`Validator ${idx} status changed: ${prevStatus} → ${v.status}`);
        }
        state.statuses.set(idx, v.status);

        if (v.validator.slashed) {
          issues.push(`🚨 Validator ${idx} is SLASHED`);
        }

        const prevBal = state.balances.get(idx);
        if (prevBal !== undefined) {
          const drop = prevBal - balGwei;
          if (drop > 100_000) {
            const dropEth = (drop / 1e9).toFixed(6);
            issues.push(`Validator ${idx} balance dropped ${dropEth} ETH (${gweiToEth(prevBal.toString())} → ${gweiToEth(String(balGwei))})`);
          }
        }
        state.balances.set(idx, balGwei);

        if (!v.status.startsWith("active") && !v.status.startsWith("pending")) {
          issues.push(`Validator ${idx} is not active: ${v.status}`);
        }
      }

      // Load proposal duties for current and next epoch (refresh each epoch)
      if (headEpoch > state.lastEpochChecked) {
        const activeIndices = validators
          .filter(v => v.status.startsWith("active"))
          .map(v => Number(v.index));

        if (activeIndices.length > 0) {
          // Refresh proposer duties
          const [curProposals, nextProposals] = await Promise.all([
            fetchProposerDuties(headEpoch, activeIndices, base),
            fetchProposerDuties(headEpoch + 1, activeIndices, base),
          ]);

          // Add new duties (don't overwrite slots we've already processed)
          for (const pd of [...curProposals, ...nextProposals]) {
            if (!state.knownProposals.has(pd.slot)) {
              state.knownProposals.set(pd.slot, { validatorIndex: pd.validator_index, alerted: false });
              console.log(chalk.magenta(`  [duties] Validator ${pd.validator_index} scheduled to propose at slot ${pd.slot}`));
            }
          }
        }
      }

      // Check past proposal slots for misses
      for (const [slot, duty] of state.knownProposals) {
        if (slot >= headSlot || duty.alerted) continue;
        // Slot has passed — check if the block was produced
        const proposerIndex = await fetchBlockProposerIndex(slot, base);
        duty.alerted = true; // mark so we don't re-check
        if (proposerIndex === null) {
          issues.push(`🚨 Validator ${duty.validatorIndex} MISSED BLOCK PROPOSAL at slot ${slot} (no block)`);
        } else if (proposerIndex !== duty.validatorIndex) {
          // Shouldn't happen (different proposer won the same slot — shouldn't occur)
          issues.push(`⚠️ Slot ${slot}: expected proposer ${duty.validatorIndex}, found ${proposerIndex}`);
        } else {
          console.log(chalk.green(`  [proposal] Validator ${duty.validatorIndex} successfully proposed block at slot ${slot} ✓`));
        }
      }

      // Missed attestation check — once per epoch
      if (headEpoch > state.lastEpochChecked && headEpoch > 0) {
        const epochToCheck = headEpoch - 1;
        if (epochToCheck > state.lastEpochChecked && epochToCheck >= 0) {
          state.lastEpochChecked = epochToCheck;
          const activeIndices = validators
            .filter(v => v.status.startsWith("active"))
            .map(v => Number(v.index));

          if (activeIndices.length > 0) {
            const attResults = await checkMissedAttestations(epochToCheck, activeIndices, base);
            const missed = [...attResults.entries()].filter(([, att]) => !att).map(([idx]) => idx);
            if (missed.length > 0) {
              issues.push(`⚠️ Missed attestations in epoch ${epochToCheck}: validators ${missed.join(", ")}`);
            } else {
              console.log(chalk.gray(`  [${timestamp}] epoch ${epochToCheck} — all ${activeIndices.length} validators attested ✓`));
            }
          }
        }
      }

      if (issues.length === 0) {
        const active = validators.filter(v => v.status.startsWith("active")).length;
        const totalBal = validators.reduce((s, v) => s + Number(v.balance), 0);
        console.log(chalk.gray(`  [${timestamp}] epoch ${headEpoch} slot ${headSlot} | ${active}/${validators.length} active | ${(totalBal / 1e9).toFixed(4)} ETH total`));
        return;
      }

      const alertLines = issues.join("\n");
      const embed: DiscordEmbed = {
        title: "🚨 val-monitor alert",
        description: alertLines,
        color: 0xff4444,
        timestamp: new Date().toISOString(),
        fields: [
          { name: "Beacon", value: base, inline: true },
          { name: "Epoch", value: String(headEpoch), inline: true },
        ],
      };
      await notify(`val-monitor alert:\n${alertLines}`, embed);

    } catch (e) {
      console.error(chalk.red(`  [error] ${e}`));
    }
  };

  await check();
  setInterval(check, intervalSec * 1000);
}

function cmdAdd(index: string, opts: { config: string; webhook?: string }) {
  const cfg = loadConfig(opts.config);
  const n = Number(index);
  if (isNaN(n) || n < 0) { console.error(chalk.red("Invalid index")); process.exit(1); }
  if (cfg.validators.includes(n)) {
    console.log(chalk.yellow(`Validator ${n} already tracked.`));
    return;
  }
  cfg.validators.push(n);
  cfg.validators.sort((a, b) => a - b);
  if (opts.webhook) cfg.webhook = opts.webhook;
  saveConfig(opts.config, cfg);
  console.log(chalk.green(`Added validator ${n}.`));
}

function cmdRemove(index: string, opts: { config: string }) {
  const cfg = loadConfig(opts.config);
  const n = Number(index);
  if (!cfg.validators.includes(n)) {
    console.log(chalk.yellow(`Validator ${n} not tracked.`));
    return;
  }
  cfg.validators = cfg.validators.filter(v => v !== n);
  saveConfig(opts.config, cfg);
  console.log(chalk.green(`Removed validator ${n}.`));
}

function cmdList(opts: { config: string }) {
  const cfg = loadConfig(opts.config);
  const base = cfg.beaconNode ?? DEFAULT_BEACON;
  console.log(chalk.bold(`\nConfig: ${opts.config}`));
  console.log(chalk.gray(`Beacon node: ${base}`));
  if (cfg.webhook) console.log(chalk.gray(`Discord webhook: ${cfg.webhook.slice(0, 40)}...`));
  if (cfg.validators.length === 0) {
    console.log(chalk.yellow("No validators tracked."));
  } else {
    console.log(chalk.bold(`\nTracked validators (${cfg.validators.length}):`));
    console.log(cfg.validators.join(", "));
  }
  console.log();
}

// ── Performance command ───────────────────────────────────────────────────────

async function cmdPerformance(opts: { epochs?: string; config: string }) {
  const cfg = loadConfig(opts.config);
  const base = (cfg.beaconNode ?? DEFAULT_BEACON).replace(/\/$/, "");
  const indices = cfg.validators;

  if (indices.length === 0) {
    console.log(chalk.yellow("No validators configured. Use `val-monitor add <index>` first."));
    return;
  }

  const epochCount = Math.min(Math.max(Number(opts.epochs ?? 10), 1), 50);
  const headSlot = await fetchHeadSlot(base);
  const headEpoch = Math.floor(headSlot / 32);

  // We check epochs [headEpoch - epochCount, headEpoch - 1] — all finalised
  const startEpoch = headEpoch - epochCount;
  if (startEpoch < 0) {
    console.log(chalk.yellow("Not enough epochs in chain history yet."));
    return;
  }

  // Filter to active validators only
  process.stdout.write(chalk.gray(`  Fetching validator state...`));
  const allVals = await fetchValidators(indices, base);
  const activeVals = allVals.filter(v => v.status.startsWith("active"));
  const activeIndices = activeVals.map(v => Number(v.index));
  process.stdout.write(chalk.gray(` ${activeIndices.length} active\n`));

  if (activeIndices.length === 0) {
    console.log(chalk.yellow("No active validators to check."));
    return;
  }

  // attestedCount[valIdx] = number of epochs where we confirmed attestation
  const attestedCount = new Map<number, number>(activeIndices.map(i => [i, 0]));
  // dutiesCount[valIdx] = epochs where validator had a duty (may skip if not scheduled)
  const dutiesCount = new Map<number, number>(activeIndices.map(i => [i, 0]));

  console.log(chalk.gray(`  Checking ${epochCount} epochs (${startEpoch}–${headEpoch - 1})...`));
  console.log();

  // Process epochs in batches of 5 to avoid hammering the node
  const BATCH = 5;
  for (let epochBase = startEpoch; epochBase < headEpoch; epochBase += BATCH) {
    const batch = [];
    for (let e = epochBase; e < Math.min(epochBase + BATCH, headEpoch); e++) {
      batch.push(e);
    }

    const results = await Promise.all(
      batch.map(async (epoch) => {
        const [duties, attestedMap] = await Promise.all([
          fetchAttesterDuties(epoch, activeIndices, base),
          checkMissedAttestations(epoch, activeIndices, base),
        ]);
        return { epoch, duties, attestedMap };
      })
    );

    for (const { attestedMap, duties } of results) {
      for (const valIdx of activeIndices) {
        if (duties.has(valIdx)) {
          dutiesCount.set(valIdx, (dutiesCount.get(valIdx) ?? 0) + 1);
          // checkMissedAttestations returns true = attested, false = missed
          if (attestedMap.get(valIdx)) {
            attestedCount.set(valIdx, (attestedCount.get(valIdx) ?? 0) + 1);
          }
        }
      }
    }

    const done = Math.min(epochBase + BATCH, headEpoch) - startEpoch;
    process.stdout.write(`\r  Progress: ${done}/${epochCount} epochs`);
  }

  console.log("\n");
  console.log(chalk.bold(`  Attestation Performance — Last ${epochCount} Epochs`));
  console.log(chalk.gray(`  Beacon: ${base} | Epochs ${startEpoch}–${headEpoch - 1}`));
  console.log();

  const hIdx = "Index".padEnd(10);
  const hDuties = "Duties".padEnd(10);
  const hAtt = "Attested".padEnd(10);
  const hRate = "Rate";
  console.log("  " + chalk.bold([hIdx, hDuties, hAtt, hRate].join("  ")));
  console.log("  " + "─".repeat(50));

  let totalDuties = 0;
  let totalAttested = 0;
  let problemCount = 0;

  // Sort by rate ascending (worst first)
  const sorted = activeIndices.slice().sort((a, b) => {
    const rateA = (dutiesCount.get(a) ?? 0) > 0 ? (attestedCount.get(a) ?? 0) / dutiesCount.get(a)! : 1;
    const rateB = (dutiesCount.get(b) ?? 0) > 0 ? (attestedCount.get(b) ?? 0) / dutiesCount.get(b)! : 1;
    return rateA - rateB;
  });

  for (const valIdx of sorted) {
    const duties = dutiesCount.get(valIdx) ?? 0;
    const attested = attestedCount.get(valIdx) ?? 0;
    const rate = duties > 0 ? attested / duties : 1;
    const pct = (rate * 100).toFixed(1) + "%";

    let rateColour: (s: string) => string;
    if (rate >= 0.99) rateColour = chalk.green;
    else if (rate >= 0.95) rateColour = chalk.yellow;
    else { rateColour = chalk.red; problemCount++; }

    // Bar (20 chars wide)
    const filled = Math.round(rate * 20);
    const bar = "█".repeat(filled) + "░".repeat(20 - filled);

    console.log(
      "  " +
      String(valIdx).padEnd(10) + "  " +
      String(duties).padEnd(10) + "  " +
      String(attested).padEnd(10) + "  " +
      rateColour(`${pct.padEnd(7)} ${bar}`)
    );

    totalDuties += duties;
    totalAttested += attested;
  }

  console.log("  " + "─".repeat(50));
  const overallRate = totalDuties > 0 ? (totalAttested / totalDuties) * 100 : 100;
  const overallColour = overallRate >= 99 ? chalk.green : overallRate >= 95 ? chalk.yellow : chalk.red;
  console.log("  " + chalk.bold("Overall".padEnd(10) + "  " + String(totalDuties).padEnd(10) + "  " + String(totalAttested).padEnd(10) + "  ") + overallColour(`${overallRate.toFixed(2)}%`));
  console.log();

  if (problemCount > 0) {
    console.log(chalk.red(`  ⚠  ${problemCount} validator(s) below 95% attestation rate`));
  } else if (overallRate >= 99) {
    console.log(chalk.green(`  ✓  All validators performing well (≥99% attestation rate)`));
  } else {
    console.log(chalk.yellow(`  ~  Performance acceptable but watch for drift`));
  }
  console.log();
}

function cmdSet(key: string, value: string, opts: { config: string }) {
  const cfg = loadConfig(opts.config);
  switch (key) {
    case "beacon":
      cfg.beaconNode = value;
      saveConfig(opts.config, cfg);
      console.log(chalk.green(`Beacon node set to: ${value}`));
      break;
    case "webhook":
      cfg.webhook = value;
      saveConfig(opts.config, cfg);
      console.log(chalk.green(`Discord webhook saved.`));
      break;
    default:
      console.error(chalk.red(`Unknown setting: ${key}. Valid options: beacon, webhook`));
      process.exit(1);
  }
}

// ── CLI ───────────────────────────────────────────────────────────────────────

const program = new Command();

program
  .name("val-monitor")
  .description("Ethereum validator health monitor")
  .version("1.3.0")
  .option("-c, --config <path>", "config file path", DEFAULT_CONFIG_PATH);

program
  .command("status")
  .description("Show status for tracked (or specified) validators")
  .option("-i, --index <indices...>", "validator indices (ad-hoc, not saved)")
  .action(async (opts) => {
    const parent = program.opts();
    await cmdStatus({ ...opts, config: parent.config ?? DEFAULT_CONFIG_PATH });
  });

program
  .command("duties")
  .description("Show attester and proposer duties for current (or given) epoch")
  .option("--epoch <n>", "epoch to check (default: current head epoch)")
  .action(async (opts) => {
    const parent = program.opts();
    await cmdDuties({ ...opts, config: parent.config ?? DEFAULT_CONFIG_PATH });
  });

program
  .command("missed")
  .description("Check for missed attestations in the last (or given) epoch")
  .option("--epoch <n>", "epoch to check (default: last finalized)")
  .action(async (opts) => {
    const parent = program.opts();
    await cmdMissed({ ...opts, config: parent.config ?? DEFAULT_CONFIG_PATH });
  });

program
  .command("watch")
  .description("Continuous monitoring with optional Discord webhook alerts")
  .option("--interval <seconds>", "polling interval in seconds", "60")
  .option("--webhook <url>", "Discord webhook URL for alerts")
  .action(async (opts) => {
    const parent = program.opts();
    await cmdWatch({ ...opts, config: parent.config ?? DEFAULT_CONFIG_PATH });
  });

program
  .command("add <index>")
  .description("Add a validator index to track")
  .option("--webhook <url>", "also save Discord webhook URL to config")
  .action((index, opts) => {
    const parent = program.opts();
    cmdAdd(index, { ...opts, config: parent.config ?? DEFAULT_CONFIG_PATH });
  });

program
  .command("remove <index>")
  .description("Remove a validator index")
  .action((index) => {
    const parent = program.opts();
    cmdRemove(index, { config: parent.config ?? DEFAULT_CONFIG_PATH });
  });

program
  .command("list")
  .description("List tracked validators and config")
  .action(() => {
    const parent = program.opts();
    cmdList({ config: parent.config ?? DEFAULT_CONFIG_PATH });
  });

program
  .command("set <key> <value>")
  .description("Set config values: beacon <url> | webhook <url>")
  .action((key, value) => {
    const parent = program.opts();
    cmdSet(key, value, { config: parent.config ?? DEFAULT_CONFIG_PATH });
  });

program
  .command("performance")
  .description("Show attestation performance over last N epochs (default 10, max 50)")
  .option("--epochs <n>", "number of epochs to check (default: 10, max: 50)")
  .action(async (opts) => {
    const parent = program.opts();
    await cmdPerformance({ ...opts, config: parent.config ?? DEFAULT_CONFIG_PATH });
  });

program.parse();
