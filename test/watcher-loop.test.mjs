// The watcher's main loop (pjsr/watcher.template.js runWatcher()), run for real in a vm under a fake
// clock, with an in-memory PJSR File and the command handler stubbed. No PixInsight, no real waiting.
//
// Pinned (2026-11, Windows 11, PixInsight 1.9.5): the loop waited a fixed number of
// msleep(20) + processEvents() slices, 25 while idle and 20 after a command. Windows rounds a 20 ms
// sleep up to its 15.6 ms timer tick (about 31 ms), so the nominal 500 ms idle cycle took about 770 ms,
// and a pump that repaints large images has been reported to take far longer. Every wait is now
// bounded by wall time, whatever a sleep or a pump costs on the machine.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const TEMPLATE = fs.readFileSync(new URL('../pjsr/watcher.template.js', import.meta.url), 'utf8');
const T0 = 1_800_000_000_000;

// What one System.msleep(ms) and one CoreApplication.processEvents() cost on the simulated machine.
const MACHINES = {
  'precise timers': { sleep: (ms) => ms, pump: 0.2 },
  'Windows 15.6 ms timer tick': { sleep: (ms) => Math.ceil(ms / 15.625) * 15.625, pump: 0.2 },
  'slow repaint (80 ms per pump)': { sleep: (ms) => ms, pump: 80 },
};

// An in-memory PJSR File; every path is under the baked-in bridge dir /b.
function memFile(files) {
  const missing = (p) => { throw new Error(`no such file: ${p}`); };
  return {
    exists: (p) => files.has(p),
    directoryExists: () => true,
    createDirectory: () => {},
    readLines: (p) => (files.has(p) ? files.get(p).split('\n') : missing(p)),
    writeTextFile: (p, text) => { files.set(p, String(text)); },
    remove: (p) => { if (!files.delete(p)) missing(p); },
    move: (from, to) => { if (!files.has(from)) missing(from); files.set(to, files.get(from)); files.delete(from); },
    searchDirectory: (pattern) => {
      const dir = pattern.slice(0, pattern.lastIndexOf('/') + 1);
      const ext = pattern.slice(pattern.lastIndexOf('.'));
      return [...files.keys()].filter((p) => p.startsWith(dir) && !p.slice(dir.length).includes('/') && p.endsWith(ext));
    },
  };
}

// Runs runWatcher() to its end. `events` maps a fake time offset (ms after start) to a function run
// at the end of the first sleep that reaches it (`fired` says when). Returns what happened, in fake
// time relative to the start.
function runLoop(machine, { lingerMs = 2000, events = {} } = {}) {
  const clock = { t: T0 };
  class FakeDate extends Date {
    constructor(...a) { if (a.length) super(...a); else super(clock.t); }
    static now() { return clock.t; }
  }
  const files = new Map();
  const file = memFile(files);
  const scans = [];
  const beats = [];
  const pumps = [];
  const armed = [];
  const dispatched = [];
  const fired = [];
  const searchDirectory = file.searchDirectory;
  file.searchDirectory = (pattern) => {
    if (pattern === '/b/commands/*.json') scans.push(clock.t - T0);
    return searchDirectory(pattern);
  };
  const move = file.move;
  file.move = (from, to) => {
    move(from, to);
    if (to === '/b/heartbeat') beats.push({ at: clock.t - T0, text: files.get(to) });
  };
  const quiet = () => {};
  const console = { writeln: quiet, noteln: quiet, warningln: quiet, criticalln: quiet, show: quiet, abortRequested: false, abortEnabled: false };
  const pending = Object.entries(events).map(([at, fn]) => ({ at: Number(at), fn })).sort((a, b) => a.at - b.at);
  const ctx = vm.createContext({
    File: file, Date: FakeDate, console,
    CoreApplication: {
      versionLE: false, versionMajor: 1, versionMinor: 9, versionRelease: 5, versionRevision: 0, versionBeta: 0,
      // PixInsight greys Pause/Abort after every process; record whether it was armed, then grey it.
      processEvents: () => { clock.t += machine.pump; pumps.push(clock.t - T0); armed.push(console.abortEnabled); console.abortEnabled = false; },
    },
    System: {
      msleep: (ms) => {
        clock.t += machine.sleep(ms);
        while (pending.length && clock.t - T0 >= pending[0].at) {
          fired.push(clock.t - T0);
          pending.shift().fn({ files, console, now: () => clock.t });
        }
        if (clock.t - T0 > 120_000) console.abortRequested = true; // a loop that never ends fails, not hangs
      },
    },
  });
  const src = TEMPLATE.split('@@BRIDGEDIR@@').join('"/b"')
    .split('\n').filter((l) => !l.startsWith('#')).join('\n').replace(/\nrunWatcher\(\);\s*$/, '\n');
  vm.runInContext(src, ctx);
  ctx.dispatchCommand = (command) => {
    dispatched.push({ code: command.parameters.code, at: clock.t - T0 });
    return { status: 'success', outputs: { consoleOutput: 'ok', consoleErrors: [] }, message: '' };
  };
  // A launch ticket gives the linger; without one the watcher stays resident (a hand launch).
  if (lingerMs > 0) files.set(`/b/launches/${T0}-ticket.json`, JSON.stringify({ lingerMs, at: T0, pid: 1 }));
  vm.runInContext('runWatcher()', ctx);
  const [reason, stoppedAt] = files.get('/b/last-stop').split(' | ');
  const constants = Object.fromEntries(['MCP_IDLE_WAIT_MS', 'MCP_AFTER_COMMAND_MS', 'MCP_PUMP_SLICE_MS'].map((k) => [k, ctx[k]]));
  return { scans, beats, pumps, armed, dispatched, fired, files, reason, stoppedAt: Number(stoppedAt) - T0, ...constants };
}

function writeCommand({ files, now }, code) {
  files.set(`/b/commands/${code}.json`, JSON.stringify({
    id: code, timestamp: new Date(now()).toISOString(), senderPid: 1, tool: 'run_script', process: '__script__', parameters: { code },
  }));
}

const gaps = (times) => times.slice(1).map((t, i) => t - times[i]);
// The longest a wait may last: its bound, plus the slice and pump that cross it, plus the main
// loop's own pump before it looks again (and 1 ms for float rounding).
const slack = (m, r) => m.sleep(r.MCP_PUMP_SLICE_MS) + 2 * m.pump + 1;

for (const [name, m] of Object.entries(MACHINES)) {
  test(`idle, the watcher looks for commands every MCP_IDLE_WAIT_MS of wall time (${name}), keeps beating, and exits after the linger`, () => {
    const r = runLoop(m, { lingerMs: 2000 });
    assert.equal(r.MCP_IDLE_WAIT_MS, 100);
    assert.ok(r.scans.length >= 2000 / (r.MCP_IDLE_WAIT_MS + slack(m, r)), `only ${r.scans.length} looks in 2 s`);
    const longest = Math.max(...gaps(r.scans));
    assert.ok(longest <= r.MCP_IDLE_WAIT_MS + slack(m, r), `${longest} ms between two looks at commands/`);
    const idleBeats = r.beats.filter((b) => b.text.startsWith('idle ')).map((b) => b.at);
    assert.ok(Math.max(...gaps(idleBeats)) <= 500 + slack(m, r), 'the idle heartbeat is still refreshed about every 500 ms');
    assert.equal(r.reason, 'idle for 2s');
    assert.ok(r.stoppedAt >= 2000 && r.stoppedAt <= 2000 + r.MCP_IDLE_WAIT_MS + slack(m, r), `stopped at ${r.stoppedAt}`);
    assert.equal(r.files.has('/b/heartbeat'), false, 'the heartbeat is removed on exit');
  });

  test(`a command is picked up within one idle wait, and the next only after MCP_AFTER_COMMAND_MS of UI pumping (${name})`, () => {
    const r = runLoop(m, { lingerMs: 1000, events: { 300: (w) => { writeCommand(w, 'a-1'); writeCommand(w, 'a-2'); } } });
    assert.deepEqual(r.dispatched.map((d) => d.code), ['a-1', 'a-2']);
    const [first, second] = r.dispatched.map((d) => d.at);
    const writtenAt = r.fired[0];
    assert.ok(first - writtenAt <= r.MCP_IDLE_WAIT_MS + slack(m, r), `picked up ${first - writtenAt} ms after it was written`);
    assert.ok(second - first >= r.MCP_AFTER_COMMAND_MS, `the next command ran ${second - first} ms after the first`);
    assert.ok(second - first <= r.MCP_AFTER_COMMAND_MS + slack(m, r), `the next command waited ${second - first} ms`);
    assert.ok(r.pumps.filter((t) => t > first && t < second).length >= 2, 'the UI is pumped between two commands');
    for (const id of ['a-1', 'a-2']) {
      assert.equal(JSON.parse(r.files.get(`/b/results/${id}.json`)).status, 'success');
      assert.equal(r.files.has(`/b/commands/${id}.running`), false);
    }
    assert.equal(r.reason, 'idle for 1s');
    assert.ok(r.stoppedAt >= second + 1000, 'the linger counts from the last command');
  });

  test(`Pause/Abort and the shutdown file stop the watcher within one slice (${name})`, () => {
    const aborted = runLoop(m, { lingerMs: 0, events: { 500: (w) => { w.console.abortRequested = true; } } });
    assert.equal(aborted.reason, 'abort requested');
    const pressed = aborted.fired[0];
    assert.ok(aborted.stoppedAt - pressed <= slack(m, aborted), `stopped ${aborted.stoppedAt - pressed} ms after Pause/Abort`);
    const shut = runLoop(m, { lingerMs: 0, events: { 500: (w) => w.files.set('/b/shutdown', '') } });
    assert.equal(shut.reason, 'shutdown file');
    assert.equal(shut.files.has('/b/shutdown'), false);
    const written = shut.fired[0];
    assert.ok(shut.stoppedAt - written <= slack(m, shut), `stopped ${shut.stoppedAt - written} ms after the shutdown file`);
  });
}

test('while it waits, the watcher pumps the UI every slice and re-arms Pause/Abort before each pump', () => {
  const r = runLoop(MACHINES['precise timers'], { lingerMs: 300 });
  assert.ok(Math.max(...gaps(r.pumps)) <= r.MCP_PUMP_SLICE_MS + 0.2 + 1, 'pumped at least every slice');
  assert.ok(r.armed.length > 10 && r.armed.every(Boolean), 'Pause/Abort was armed at every pump');
});
