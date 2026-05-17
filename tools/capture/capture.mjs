#!/usr/bin/env node
// FlashFare Capture — collects FFC_DUMP tree dumps from `adb logcat` and
// deduplicates them by node-tree signature. Node native only, no deps.

import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  openSync,
  closeSync,
  readFileSync,
  readdirSync,
  writeFileSync
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

import { parse as parseRide, signature as rideSignature } from '../parse/ride.mjs';
import { appendRide, buildEntry, loadKnownSignatures } from '../parse/history.mjs';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, '..', '..');
const CAPTURES_DIR = join(REPO_ROOT, 'captures');

const CHUNK_RE = /^\[FFC session=(\S+) seq=(\d+) chunk=(\d+)\/(\d+)\](.*)$/;
const END_RE = /^\[FFC session=(\S+) seq=(\d+) END\]$/;
const PNG_RE = /^\[FFC session=(\S+) seq=(\d+) PNG (.+)\]$/;

function printHelp() {
  process.stdout.write(
    [
      'Usage: node tools/capture/capture.mjs [options]',
      '',
      'Streams `adb logcat -s FFC_DUMP:I -v raw`, reassembles chunked tree',
      'dumps, saves every dump under captures/<session>/<seq>.json and a',
      'deduplicated copy under captures/<session>/unique/<NN>.json (+ PNG).',
      '',
      'Options:',
      '  --no-screencap   Skip `adb exec-out screencap -p` for each unique screen',
      '  -h, --help       Show this help and exit',
      '',
      `Output: ${CAPTURES_DIR}`,
      ''
    ].join('\n')
  );
}

function parseArgs(argv) {
  const opts = { screencap: true, help: false };
  for (const arg of argv) {
    if (arg === '--no-screencap') opts.screencap = false;
    else if (arg === '--help' || arg === '-h') opts.help = true;
    else {
      process.stderr.write(`Unknown argument: ${arg}\n`);
      process.exit(2);
    }
  }
  return opts;
}

function checkAdbDevice() {
  const r = spawnSync('adb', ['devices'], { encoding: 'utf8' });
  if (r.error) {
    process.stderr.write(`[capture] adb not found in PATH: ${r.error.message}\n`);
    process.exit(1);
  }
  if (r.status !== 0) {
    process.stderr.write(`[capture] adb devices failed (status=${r.status}):\n${r.stderr}`);
    process.exit(1);
  }
  const lines = r.stdout.split(/\r?\n/).slice(1);
  const devices = lines
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('*'))
    .filter((l) => /\tdevice$/.test(l));
  if (devices.length === 0) {
    process.stderr.write(
      '[capture] no adb device detected. Plug the phone, enable USB debugging, then retry.\n'
    );
    process.exit(1);
  }
  if (devices.length > 1) {
    process.stderr.write(
      `[capture] ${devices.length} devices connected. Set ANDROID_SERIAL or unplug spares.\n`
    );
    process.exit(1);
  }
}

function clearLogcat() {
  const r = spawnSync('adb', ['logcat', '-c'], { encoding: 'utf8' });
  if (r.status !== 0) {
    process.stderr.write(`[capture] failed to clear logcat: ${r.stderr}\n`);
    process.exit(1);
  }
}

function pad(n, width) {
  return String(n).padStart(width, '0');
}

function sessionState() {
  return {
    buffers: new Map(),
    signatures: new Map(),
    rawCount: 0,
    uniqueCount: 0,
    rideCount: 0,
    devicePngs: new Map()
  };
}

function getSession(sessions, sessionId) {
  let s = sessions.get(sessionId);
  if (!s) {
    s = sessionState();
    loadExistingUniques(sessionId, s);
    sessions.set(sessionId, s);
  }
  return s;
}

function loadExistingUniques(sessionId, session) {
  const uniqueDir = join(CAPTURES_DIR, sessionId, 'unique');
  if (!existsSync(uniqueDir)) return;
  let entries;
  try {
    entries = readdirSync(uniqueDir);
  } catch {
    return;
  }
  let maxNo = 0;
  let loaded = 0;
  for (const name of entries) {
    const m = /^(\d+)\.json$/.exec(name);
    if (!m) continue;
    const uniqueNo = Number(m[1]);
    const file = join(uniqueDir, name);
    let parsed;
    try {
      parsed = JSON.parse(readFileSync(file, 'utf8'));
    } catch (e) {
      process.stderr.write(`[!] ${sessionId} cannot reload ${name}: ${e.message}\n`);
      continue;
    }
    const sig = nodeSignature(parsed);
    if (!session.signatures.has(sig)) {
      session.signatures.set(sig, { firstSeq: -1, count: 0, uniqueNo, savedAs: file });
      loaded++;
    }
    if (uniqueNo > maxNo) maxNo = uniqueNo;
  }
  if (maxNo > 0) session.uniqueCount = maxNo;
  if (loaded > 0) {
    process.stdout.write(
      `[capture] resumed session=${sessionId}: ${loaded} prior unique screens, next=${pad(maxNo + 1, 2)}\n`
    );
  }
}

function nodeSignature(parsed) {
  const nodes = Array.isArray(parsed.nodes) ? parsed.nodes : [];
  return createHash('sha1').update(JSON.stringify(nodes)).digest('hex');
}

function saveRaw(sessionId, seq, parsed) {
  const dir = join(CAPTURES_DIR, sessionId);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${pad(seq, 4)}.json`);
  const pretty = JSON.stringify(parsed, null, 2);
  writeFileSync(file, pretty, 'utf8');
  return { file, pretty };
}

function saveUnique(sessionId, seq, uniqueNo, pretty, takeScreencap, session) {
  const dir = join(CAPTURES_DIR, sessionId, 'unique');
  mkdirSync(dir, { recursive: true });
  const jsonFile = join(dir, `${pad(uniqueNo, 2)}.json`);
  writeFileSync(jsonFile, pretty, 'utf8');
  let pngFile = null;
  if (takeScreencap) {
    pngFile = join(dir, `${pad(uniqueNo, 2)}.png`);
    const devicePath = session.devicePngs.get(seq);
    let pulled = false;
    if (devicePath) {
      const r = spawnSync('adb', ['pull', devicePath, pngFile], { encoding: 'utf8' });
      if (r.status === 0) {
        pulled = true;
        spawnSync('adb', ['shell', 'rm', '-f', devicePath], { stdio: 'ignore' });
        session.devicePngs.delete(seq);
      } else {
        process.stderr.write(
          `[!] adb pull ${devicePath} failed (status=${r.status}): ${r.stderr || ''}\n`
        );
      }
    }
    if (!pulled) {
      const fd = openSync(pngFile, 'w');
      try {
        const r = spawnSync('adb', ['exec-out', 'screencap', '-p'], {
          stdio: ['ignore', fd, 'inherit']
        });
        if (r.status !== 0) {
          process.stderr.write(`[!] screencap failed for ${jsonFile} (status=${r.status})\n`);
          pngFile = null;
        }
      } finally {
        closeSync(fd);
      }
    }
  }
  return { jsonFile, pngFile };
}

function handleCompleteDump(sessionId, seq, rawJson, sessions, opts) {
  let parsed;
  try {
    parsed = JSON.parse(rawJson);
  } catch (e) {
    process.stderr.write(`[!] ${sessionId} seq=${pad(seq, 4)} parse failed: ${e.message}\n`);
    return;
  }
  const session = getSession(sessions, sessionId);
  const { pretty } = saveRaw(sessionId, seq, parsed);
  const bytes = Buffer.byteLength(pretty, 'utf8');
  const nodeCount = Array.isArray(parsed.nodes) ? parsed.nodes.length : 0;
  session.rawCount++;
  process.stdout.write(
    `[+] ${sessionId} seq=${pad(seq, 4)} (${(bytes / 1024).toFixed(1)} KB, ${nodeCount} nodes)\n`
  );

  const sig = nodeSignature(parsed);
  const known = session.signatures.get(sig);
  if (known) {
    known.count++;
    process.stdout.write(
      `[=] ${sessionId} seq=${pad(seq, 4)} dup of unique=${pad(known.uniqueNo, 2)} (×${known.count})\n`
    );
    discardDevicePng(session, seq);
    return;
  }
  session.uniqueCount++;
  const uniqueNo = session.uniqueCount;
  const { jsonFile, pngFile } = saveUnique(sessionId, seq, uniqueNo, pretty, opts.screencap, session);
  session.signatures.set(sig, { firstSeq: seq, count: 1, uniqueNo, savedAs: jsonFile });
  const suffix = pngFile ? ' + .png' : '';
  process.stdout.write(
    `[★] ${sessionId} unique=${pad(uniqueNo, 2)} from seq=${pad(seq, 4)} → unique/${pad(uniqueNo, 2)}.json${suffix}\n`
  );
  detectAndLogRide(parsed, jsonFile, session, sessionId, seq);
}

function detectAndLogRide(parsed, jsonFile, session, sessionId, seq) {
  const ride = parseRide(parsed);
  if (!ride) return;
  const sig = rideSignature(ride);
  if (knownRideSignatures.has(sig)) return;
  knownRideSignatures.add(sig);
  session.rideCount++;
  const entry = buildEntry(parsed, ride, jsonFile);
  appendRide(entry);
  const drop = ride.dropoffAddress?.split(',')[1]?.trim() || ride.dropoffAddress || '?';
  const tags = ride.tags.length > 0 ? ` [${ride.tags.length} tag${ride.tags.length > 1 ? 's' : ''}]` : '';
  process.stdout.write(
    `[ride] ${sessionId} seq=${pad(seq, 4)} ${ride.vehicleType || '?'} ${ride.price?.toFixed(2) || '?'}€ → ${drop} (${ride.tripDistanceKm}km)${tags}\n`
  );
}

function discardDevicePng(session, seq) {
  const devicePath = session.devicePngs.get(seq);
  if (!devicePath) return;
  spawnSync('adb', ['shell', 'rm', '-f', devicePath], { stdio: 'ignore' });
  session.devicePngs.delete(seq);
}

function handleLine(line, sessions, opts) {
  if (!line) return;
  const pngMatch = PNG_RE.exec(line);
  if (pngMatch) {
    const sessionId = pngMatch[1];
    const seq = Number(pngMatch[2]);
    const devicePath = pngMatch[3];
    const session = getSession(sessions, sessionId);
    session.devicePngs.set(seq, devicePath);
    return;
  }
  const endMatch = END_RE.exec(line);
  if (endMatch) {
    const sessionId = endMatch[1];
    const seq = Number(endMatch[2]);
    const session = getSession(sessions, sessionId);
    const key = `${sessionId}:${seq}`;
    const buf = session.buffers.get(key);
    if (!buf) return;
    session.buffers.delete(key);
    if (buf.received !== buf.total) {
      process.stderr.write(
        `[!] ${sessionId} seq=${pad(seq, 4)} incomplete: ${buf.received}/${buf.total} chunks\n`
      );
      return;
    }
    const ordered = [];
    for (let i = 1; i <= buf.total; i++) {
      const part = buf.chunks.get(i);
      if (part === undefined) {
        process.stderr.write(`[!] ${sessionId} seq=${pad(seq, 4)} missing chunk ${i}\n`);
        return;
      }
      ordered.push(part);
    }
    handleCompleteDump(sessionId, seq, ordered.join(''), sessions, opts);
    return;
  }
  const chunkMatch = CHUNK_RE.exec(line);
  if (!chunkMatch) return;
  const sessionId = chunkMatch[1];
  const seq = Number(chunkMatch[2]);
  const idx = Number(chunkMatch[3]);
  const total = Number(chunkMatch[4]);
  const payload = chunkMatch[5];
  const session = getSession(sessions, sessionId);
  const key = `${sessionId}:${seq}`;
  let buf = session.buffers.get(key);
  if (!buf) {
    buf = { chunks: new Map(), total, received: 0 };
    session.buffers.set(key, buf);
  }
  buf.total = total;
  if (!buf.chunks.has(idx)) {
    buf.chunks.set(idx, payload);
    buf.received++;
  }
}

function printSummary(sessions) {
  let totalRaw = 0;
  let totalUnique = 0;
  let totalRides = 0;
  const outputs = [];
  for (const [id, s] of sessions) {
    totalRaw += s.rawCount;
    totalUnique += s.uniqueCount;
    totalRides += s.rideCount;
    outputs.push(join(CAPTURES_DIR, id));
  }
  const ratio = totalUnique > 0 ? (totalRaw / totalUnique).toFixed(1) : '0.0';
  process.stdout.write(
    [
      '[capture] stopped',
      `sessions: ${sessions.size}`,
      `raw dumps: ${totalRaw}`,
      `unique screens: ${totalUnique}`,
      `total dedup ratio: ${ratio}x`,
      `new ride requests: ${totalRides}`,
      `output: ${outputs.join(', ') || CAPTURES_DIR}`,
      ''
    ].join('\n')
  );
}

const knownRideSignatures = new Set();

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    printHelp();
    process.exit(0);
  }
  checkAdbDevice();
  if (!existsSync(CAPTURES_DIR)) mkdirSync(CAPTURES_DIR, { recursive: true });
  for (const sig of loadKnownSignatures()) knownRideSignatures.add(sig);
  clearLogcat();
  process.stdout.write(
    `[capture] listening on FFC_DUMP, screencap=${opts.screencap ? 'on' : 'off'}, history=${knownRideSignatures.size} known rides, output=${CAPTURES_DIR}\n`
  );

  const sessions = new Map();
  const proc = spawn('adb', ['logcat', '-s', 'FFC_DUMP:I', '-v', 'raw'], {
    stdio: ['ignore', 'pipe', 'inherit']
  });
  const rl = createInterface({ input: proc.stdout });
  rl.on('line', (line) => handleLine(line, sessions, opts));

  let stopped = false;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    try { proc.kill('SIGTERM'); } catch { /* noop */ }
    printSummary(sessions);
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  proc.on('exit', stop);
}

main();
