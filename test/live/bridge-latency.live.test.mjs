// ============================================================================
// Live measurement: the fixed cost of one bridge round trip (connector -> watcher -> connector) for
// a trivial snippet, with no image open and with a large synthetic colour image on screen. Opt-in
// only (PIXINSIGHT_CONNECTOR_LIVE=1); skipped in CI. It prints the numbers and asserts no limit on
// them, since timings depend on the machine. It does assert that every call answered and that no
// watcher was launched during the back-to-back calls: a launch there means a liveness check took a
// running watcher for a dead one (on Windows a heartbeat read can fail while the watcher replaces it).
//
// Uses the workspace the test runs in (the checkout), so it starts that workspace's own watcher.
// It opens one window of its own (LATENCY_PROBE_ID) and closes it; nothing else is touched. It also
// waits out the watcher's idle linger twice, to time the relaunch a call then pays (about 25 s).
// PIXINSIGHT_CONNECTOR_LATENCY_CALLS sets the number of timed calls per phase (default 20).
// ============================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import { buildRuntimeApi } from '../../src/server.mjs';
import { resolvePlatform } from '../../src/platform.mjs';
import { createProcessProbe } from '../../src/process-probe.mjs';
import { createWorkspace } from '../../src/workspace.mjs';
import { NO_CALL_LOG } from '../../src/call-log.mjs';

const live = { skip: process.env.PIXINSIGHT_CONNECTOR_LIVE ? false : 'set PIXINSIGHT_CONNECTOR_LIVE=1 with PixInsight running' };
const CALLS = Number(process.env.PIXINSIGHT_CONNECTOR_LATENCY_CALLS) || 20;
const LATENCY_PROBE_ID = 'latency_probe_9000x6000';
const LINGER_MS = Number(process.env.PIXINSIGHT_CONNECTOR_LINGER_MS) || 8000;

// The bridge's own events (launch, relaunch, watcher start, ...), tagged with the phase they fell in.
const events = [];
let phase = 'first call';
const callLog = Object.freeze({ ...NO_CALL_LOG, bridge: (rec) => { if (rec.kind === 'event') events.push({ phase, event: rec.event }); } });
const LAUNCH_EVENTS = new Set(['launch', 'relaunch']);
const launchesIn = (label) => events.filter((e) => e.phase === label && LAUNCH_EVENTS.has(e.event)).length;

function liveApi() {
  const { version } = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
  return buildRuntimeApi({
    platform: resolvePlatform({ env: process.env, platform: process.platform, existsSync, homeDir: os.homedir() }),
    probe: createProcessProbe(),
    workspace: createWorkspace({ cwd: process.cwd(), env: process.env, homeDir: os.homedir(), platform: process.platform }),
    log: () => {},
    connectorVersion: version,
    callLog,
  }).api;
}

async function ok(api, code) {
  const r = await api.pjsr(code);
  assert.notEqual(r.status, 'error', JSON.stringify(r.error ?? r));
  return r;
}

function summary(values) {
  const s = [...values].sort((a, b) => a - b);
  const at = (q) => s[Math.min(s.length - 1, Math.floor(q * s.length))];
  const mean = s.reduce((a, b) => a + b, 0) / s.length;
  return { n: s.length, min: s[0], median: at(0.5), mean: Math.round(mean), p90: at(0.9), max: s[s.length - 1] };
}

// What the watcher's waits cost inside PixInsight right now: one CoreApplication.processEvents(), and
// a 25 x (msleep 20 + processEvents) cycle (nominally 500 ms).
async function pumpCost(api) {
  const r = await ok(api, `
    var t0 = Date.now();
    for (var i = 0; i < 25; ++i) CoreApplication.processEvents();
    var single = (Date.now() - t0) / 25;
    var t1 = Date.now();
    for (var j = 0; j < 25; ++j) { System.msleep(20); CoreApplication.processEvents(); }
    JSON.stringify({ processEventsMs: single, cycle25x20Ms: Date.now() - t1 });
  `);
  return JSON.parse(r.result);
}

async function timeCalls(api, label) {
  phase = label;
  const roundTrip = [];
  const inWatcher = [];
  for (let i = 0; i < CALLS; i++) {
    const t0 = performance.now();
    const r = await ok(api, '1+1');
    roundTrip.push(Math.round(performance.now() - t0));
    inWatcher.push(r.duration_ms ?? 0);
    assert.equal(r.result, '2');
  }
  return {
    roundTripMs: summary(roundTrip), inWatcherMs: summary(inWatcher), overheadMs: summary(roundTrip.map((v, i) => v - inWatcher[i])),
    watcherLaunches: launchesIn(label),
  };
}

// One call after the watcher has exited on idle: the launch a call pays when calls are further apart
// than the linger.
async function afterIdleExit(api, label) {
  phase = label;
  await new Promise((r) => setTimeout(r, LINGER_MS + 3000));
  const t0 = performance.now();
  await ok(api, '1+1');
  return Math.round(performance.now() - t0);
}

test('bridge round trip for a trivial snippet, without and with a 9000x6000 colour image on screen', live, async (t) => {
  const api = liveApi();
  const report = { calls: CALLS, platform: process.platform, node: process.version };

  let t0 = performance.now();
  await ok(api, '1+1'); // starts PixInsight and/or this workspace's watcher if needed
  report.firstCallMs = Math.round(performance.now() - t0);
  report.openImagesBefore = (await api.listImages()).length;

  phase = 'no image';
  report.noImage = { pump: await pumpCost(api), ...(await timeCalls(api, 'no image: calls')), afterIdleExitMs: await afterIdleExit(api, 'no image: after idle exit') };

  t.after(async () => {
    try { await api.pjsr(`var w = ImageWindow.windowById(${JSON.stringify(LATENCY_PROBE_ID)}); if (!w.isNull) w.forceClose(); 0`); } catch {}
  });
  phase = 'large image';
  t0 = performance.now();
  await ok(api, `
    var w = new ImageWindow(9000, 6000, 3, 32, true, true, ${JSON.stringify(LATENCY_PROBE_ID)});
    var v = w.mainView;
    var pm = new PixelMath;
    pm.expression = "0.2 + 0.15*sin(x()/37)*cos(y()/23) + 0.1*x()/w()";
    pm.useSingleExpression = true;
    pm.createNewImage = false;
    pm.executeOn(v);
    w.show();
    w.zoomToFit();
    v.id;
  `);
  report.createImageMs = Math.round(performance.now() - t0);

  report.largeImage = { pump: await pumpCost(api), ...(await timeCalls(api, 'large image: calls')), afterIdleExitMs: await afterIdleExit(api, 'large image: after idle exit') };
  report.bridgeEvents = events;

  console.log(JSON.stringify(report, null, 2));
  assert.equal(report.noImage.watcherLaunches + report.largeImage.watcherLaunches, 0, 'no watcher may be launched while one is serving back-to-back calls');
});
