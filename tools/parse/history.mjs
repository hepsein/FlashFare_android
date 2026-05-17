#!/usr/bin/env node
// FlashFare ride request history builder.
// Scans captures/<session>/*.json (excluding unique/ and history/), detects ride
// requests via ride.mjs, dedups by signature, appends new entries to
// captures/history/rides.jsonl. Idempotent — re-running skips signatures already
// present in the history file.

import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, appendFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { detect, parse, signature } from './ride.mjs';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, '..', '..');
const CAPTURES_DIR = join(REPO_ROOT, 'captures');
const HISTORY_DIR = join(CAPTURES_DIR, 'history');
const HISTORY_FILE = join(HISTORY_DIR, 'rides.jsonl');

const SKIP_DIRS = new Set(['history', 'unique']);

function printHelp() {
  process.stdout.write(
    [
      'Usage: node tools/parse/history.mjs [<path> ...]',
      '',
      'Detects ride request screens in TreeSerializer dumps, dedups them by',
      `(vehicle, price, distance, pickup, dropoff), and appends new rides to:`,
      `  ${HISTORY_FILE}`,
      '',
      'With no arg, scans every captures/<session>/*.json (excluding unique/ and',
      'history/). Pass one or more files or session directories to restrict.',
      ''
    ].join('\n')
  );
}

function parseArgs(argv) {
  const opts = { help: false, paths: [] };
  for (const arg of argv) {
    if (arg === '-h' || arg === '--help') opts.help = true;
    else opts.paths.push(arg);
  }
  return opts;
}

function loadKnownSignatures() {
  if (!existsSync(HISTORY_FILE)) return new Set();
  const known = new Set();
  const text = readFileSync(HISTORY_FILE, 'utf8');
  for (const line of text.split(/\r?\n/)) {
    if (!line) continue;
    try {
      const entry = JSON.parse(line);
      if (entry.signature) known.add(entry.signature);
    } catch {
      /* tolerate corrupt lines */
    }
  }
  return known;
}

function* walkDumps(target) {
  const stat = statSync(target);
  if (stat.isFile()) {
    if (target.endsWith('.json')) yield target;
    return;
  }
  for (const name of readdirSync(target)) {
    if (SKIP_DIRS.has(name)) continue;
    const child = join(target, name);
    const childStat = statSync(child);
    if (childStat.isDirectory()) {
      yield* walkDumps(child);
    } else if (name.endsWith('.json')) {
      yield child;
    }
  }
}

function buildEntry(parsed, ride, sourceFile) {
  return {
    signature: signature(ride),
    ts: parsed.meta?.ts ?? null,
    session: parsed.meta?.session ?? null,
    seq: parsed.meta?.seq ?? null,
    sourceFile: sourceFile ? sourceFile.replace(REPO_ROOT + '\\', '').replace(/\\/g, '/') : null,
    action: ride.action,
    vehicleType: ride.vehicleType,
    price: ride.price,
    tags: ride.tags,
    driverRating: ride.driverRating,
    pickupEta: ride.pickupEta,
    pickupAddress: ride.pickupAddress,
    tripDistanceKm: ride.tripDistanceKm,
    dropoffAddress: ride.dropoffAddress
  };
}

export function appendRide(entry) {
  mkdirSync(HISTORY_DIR, { recursive: true });
  appendFileSync(HISTORY_FILE, JSON.stringify(entry) + '\n', 'utf8');
}

export { buildEntry, loadKnownSignatures };

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    printHelp();
    process.exit(0);
  }
  const targets = opts.paths.length > 0 ? opts.paths.map((p) => resolve(p)) : [CAPTURES_DIR];

  const known = loadKnownSignatures();
  let scanned = 0;
  let detected = 0;
  let appended = 0;
  const newSignatures = new Set();

  for (const target of targets) {
    if (!existsSync(target)) {
      process.stderr.write(`[!] not found: ${target}\n`);
      continue;
    }
    for (const file of walkDumps(target)) {
      scanned++;
      let parsed;
      try {
        parsed = JSON.parse(readFileSync(file, 'utf8'));
      } catch (e) {
        process.stderr.write(`[!] parse fail ${file}: ${e.message}\n`);
        continue;
      }
      if (!detect(parsed)) continue;
      const ride = parse(parsed);
      if (!ride) continue;
      detected++;
      const entry = buildEntry(parsed, ride, file);
      if (known.has(entry.signature) || newSignatures.has(entry.signature)) continue;
      newSignatures.add(entry.signature);
      appendRide(entry);
      appended++;
      const drop = ride.dropoffAddress?.split(',')[1]?.trim() || ride.dropoffAddress || '?';
      process.stdout.write(
        `[+] ${ride.vehicleType || '?'} ${ride.price?.toFixed(2) || '?'}€ → ${drop} (${ride.tripDistanceKm}km)\n`
      );
    }
  }

  process.stdout.write(
    `[history] scanned ${scanned} dumps, detected ${detected} rides, appended ${appended} new entries → ${HISTORY_FILE}\n`
  );
}

const invokedDirectly =
  process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) main();
