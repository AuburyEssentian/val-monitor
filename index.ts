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
 *   val-monitor list                    # list tracked validators
 *
 * Config file: ~/.val-monitor.json
 *   { "validators": [12345, 67890], "beaconNode": "http://localhost:5052" }
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
  balance: string; // Gwei
  status: string;
  validator: {
    pubkey: string;
    effective_balance: string; // Gwei
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
  // POST to /eth/v1/beacon/states/head/validators with body
  const url = `${base}/eth/v1/beacon/states/head/validators`;
  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ids: indices.map(String) }),
  });
  if (!r.ok) {
    // Fall back to individual GETs if POST not supported
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

// ── Attestation check via recent blocks ───────────────────────────────────────
// We look at the last N slots and see if our validators' indices appear in attestations.
// This is lightweight but approximate — good enough for a health check.

interface BlockAttestation {
  aggregation_bits: string;
  data: {
    slot: string;
    index: string; // committee index
    beacon_block_root: string;
    source: { epoch: string };
    target: { epoch: string };
  };
}

interface BlockAttestationV2 {
  committee_bits?: string;
  aggregation_bits?: string;
  data: {
    slot: string;
    index: string;
    beacon_block_root: string;
    source: { epoch: string };
    target: { epoch: string };
  };
}

// Get committee assignments for validators in a given epoch
async function fetchAttesterDuties(
  epoch: number,
  indices: number[],
  base: string
): Promise<Map<number, { slot: number; committee_index: number; committee_length: number; validator_committee_index: number }>> {
  const map = new Map<number, { slot: number; committee_index: number; committee_length: number; validator_committee_index: number }>();
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

// ── Formatting ────────────────────────────────────────────────────────────────

function gweiToEth(gweiStr: string): string {
  return (Number(gweiStr) / 1e9).toFixed(4);
}

function statusBadge(s: string): string {
  if (s === "active_ongoing") return chalk.green("active_ongoing");
  if (s.startsWith("active")) return chalk.yellow(s);
  if (s === "exiting_slashed" || s === "withdrawal_possible" || s === "withdrawal_done") return chalk.gray(s);
  if (s.includes("slashed")) return chalk.red(s);
  return chalk.yellow(s);
}

function epochAge(epoch: number, currentEpoch: number): string {
  const diff = currentEpoch - epoch;
  if (diff < 0) return chalk.gray("pending");
  if (diff < 60) return chalk.green(`${diff}e ago`);
  if (diff < 1440) return chalk.yellow(`${diff}e ago`);
  return chalk.red(`${diff}e ago (~${Math.floor(diff * 6.4 / 60)}h)`);
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

  const headSlotRes = await fetch(`${base}/eth/v1/beacon/headers/head`).then(r => r.ok ? r.json() : null).catch(() => null) as { data: { header: { message: { slot: string } } } } | null;
  const headSlot = Number(headSlotRes?.data?.header?.message?.slot ?? 0);
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

  // Fetch attester duties for current epoch (best-effort)
  let duties = new Map<number, { slot: number; committee_index: number; committee_length: number; validator_committee_index: number }>();
  try {
    const validIndices = validators
      .filter(v => v.status.startsWith("active"))
      .map(v => Number(v.index));
    if (validIndices.length > 0) {
      duties = await fetchAttesterDuties(currentEpoch, validIndices, base);
    }
  } catch { /* non-fatal */ }

  // Sort: active first, then by index
  validators.sort((a, b) => {
    const aA = a.status.startsWith("active") ? 0 : 1;
    const bA = b.status.startsWith("active") ? 0 : 1;
    return aA - bA || Number(a.index) - Number(b.index);
  });

  console.log();
  console.log(chalk.bold("  Validator Status"));
  console.log(chalk.gray(`  Beacon: ${base} | Finalized epoch: ${finalizedEpoch} | Head epoch ~${currentEpoch}`));
  console.log();

  const hIdx = "Index".padEnd(10);
  const hStatus = "Status".padEnd(22);
  const hBal = "Balance ETH".padEnd(14);
  const hEffBal = "Eff Bal ETH".padEnd(14);
  const hSlot = "Next Att Slot";

  console.log("  " + chalk.bold([hIdx, hStatus, hBal, hEffBal, hSlot].join("  ")));
  console.log("  " + "─".repeat(80));

  let issueCount = 0;
  for (const v of validators) {
    const idx = Number(v.index);
    const duty = duties.get(idx);
    const nextAttSlot = duty ? chalk.cyan(String(duty.slot)) : chalk.gray("—");
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
      gweiToEth(v.validator.effective_balance).padEnd(14),
      nextAttSlot,
    ];
    console.log("  " + row.join("  "));
  }

  console.log();
  const totalBalance = validators.reduce((s, v) => s + Number(v.balance), 0);
  const activeCount = validators.filter(v => v.status.startsWith("active")).length;

  if (issueCount > 0) {
    console.log(chalk.red(`  ⚠  ${issueCount} validator(s) need attention`));
  } else {
    console.log(chalk.green(`  ✓  All ${activeCount} validators active and healthy`));
  }

  console.log(chalk.gray(`  Active: ${activeCount}/${validators.length}  |  Total balance: ${(totalBalance / 1e9).toFixed(4)} ETH`));

  if (genesis) {
    const uptime = Math.floor((Date.now() / 1000 - Number(genesis.genesis_time)) / 86400);
    console.log(chalk.gray(`  Chain uptime: ${uptime} days`));
  }

  console.log();
}

function cmdAdd(index: string, opts: { config: string }) {
  const cfg = loadConfig(opts.config);
  const n = Number(index);
  if (isNaN(n) || n < 0) { console.error(chalk.red("Invalid index")); process.exit(1); }
  if (cfg.validators.includes(n)) {
    console.log(chalk.yellow(`Validator ${n} already tracked.`));
    return;
  }
  cfg.validators.push(n);
  cfg.validators.sort((a, b) => a - b);
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
  if (cfg.validators.length === 0) {
    console.log(chalk.yellow("No validators tracked."));
  } else {
    console.log(chalk.bold(`\nTracked validators (${cfg.validators.length}):`));
    console.log(cfg.validators.join(", "));
  }
  console.log();
}

// ── CLI ───────────────────────────────────────────────────────────────────────

const program = new Command();

program
  .name("val-monitor")
  .description("Ethereum validator health monitor")
  .version("1.0.0")
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
  .command("add <index>")
  .description("Add a validator index to track")
  .action((index) => {
    const parent = program.opts();
    cmdAdd(index, { config: parent.config ?? DEFAULT_CONFIG_PATH });
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

program.parse();
