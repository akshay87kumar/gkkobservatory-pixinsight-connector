// The gkkobservatory build's fixes for three findings of the live smoke sweep (2026-11-22,
// PixInsight 1.9.5, Windows 11), checked without PixInsight by running the emitted PJSR in a vm
// against a stand-in for the slice of PJSR it touches, with real pixel storage:
//
//  1. Tools that computed an image one sample at a time (extract_pseudo_oiii, the
//     dynamic_narrowband_blend mask, create_zone_masks, create_adaptive_zone_masks, continuous_clamp,
//     shell_detail_enhance's measurement) took minutes at real sizes with PixInsight frozen. They now
//     move a row per native call (src/tools/pixel-rows.mjs) and yield every 64 rows. Every output
//     pixel must equal what the per-pixel formula gave, and a stop mid-loop must leave no window.
//  2. export_image saved XISF files whose view id was its temporary window's, export_tmp.
//  3. ha_inject_red, ha_inject_luminance, star_protected_blend and restore_star_color changed a mono
//     view as if it were R and reported success.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { PIXEL_ROWS } from '../src/tools/pixel-rows.mjs';
import { createZoneMasks, createAdaptiveZoneMasks } from '../src/tools/zones.mjs';
import { tools as narrowbandTools } from '../src/tools/narrowband.mjs';
import { tools as toneTools } from '../src/tools/tone.mjs';
import { tools as starTools } from '../src/tools/stars.mjs';
import { tools as imageTools } from '../src/tools/images.mjs';

const byName = Object.fromEntries([...narrowbandTools, ...toneTools, ...starTools, ...imageTools].map((t) => [t.name, t]));
const LUM = (r, g, b) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

// Deterministic pixel values: a dark noisy sky with a bright blob, so thresholds and percentiles have
// something to find.
function fill(img, seed = 1) {
  let s = seed;
  const rnd = () => ((s = (s * 1103515245 + 12345) % 2147483648) / 2147483648);
  for (let c = 0; c < img.numberOfChannels; c++) {
    for (let y = 0; y < img.height; y++) {
      for (let x = 0; x < img.width; x++) {
        const d2 = ((x - img.width * 0.45) ** 2 + (y - img.height * 0.55) ** 2) / (2 * 22 * 22);
        img.setSample(0.04 + 0.03 * rnd() + (0.85 - 0.1 * c) * Math.exp(-d2) * (0.9 + 0.1 * rnd()), x, y, c);
      }
    }
  }
  return img;
}

// The stand-in PJSR world. Images store float32 samples, as a 32-bit PixInsight image does.
// `abortAfterYields` makes processEvents() throw MCP_ABORTED on that call, as the watcher's does once
// Pause/Abort is pressed.
function world({ abortAfterYields = Infinity } = {}) {
  const open = new Map();
  const calls = { yields: 0, getSamples: 0, executed: [], saved: [] };
  const files = new Set();
  const NULL_WINDOW = { isNull: true };
  class Rect { constructor(x0, y0, x1, y1) { Object.assign(this, { x0, y0, x1, y1 }); } }
  class Image {
    constructor(width, height, n) {
      Object.assign(this, { width, height, numberOfChannels: n, isColor: n >= 3 });
      this.data = Array.from({ length: n }, () => new Float32Array(width * height));
    }
    check(c) { if (!(c >= 0 && c < this.numberOfChannels)) throw new Error(`Invalid channel index '${c}'`); }
    sample(x, y, c = 0) { this.check(c); return this.data[c][y * this.width + x]; }
    setSample(v, x, y, c = 0) { this.check(c); this.data[c][y * this.width + x] = v; }
    getSamples(buf, r, c = 0) {
      this.check(c); calls.getSamples++;
      let k = 0;
      for (let y = r.y0; y < r.y1; y++) for (let x = r.x0; x < r.x1; x++) buf[k++] = this.data[c][y * this.width + x];
    }
    setSamples(buf, r, c = 0) {
      this.check(c);
      let k = 0;
      for (let y = r.y0; y < r.y1; y++) for (let x = r.x0; x < r.x1; x++) this.data[c][y * this.width + x] = buf[k++];
    }
    all() { return this.data.flatMap((d) => [...d]); }
    maximum() { return Math.max(...this.all()); }
    minimum() { return Math.min(...this.all()); }
    median() { const v = this.all().sort((a, b) => a - b); return v[Math.floor(v.length / 2)]; }
    MAD() { const m = this.median(); const v = this.all().map((x) => Math.abs(x - m)).sort((a, b) => a - b); return v[Math.floor(v.length / 2)]; }
    assign(other) { this.data = other.data.map((d) => new Float32Array(d)); }
    resetChannelSelection() {}
  }
  const uniqueId = (id) => { let u = id, n = 1; while (open.has(u)) u = id + n++; return u; };
  class ImageWindow {
    static windowById(id) { return open.get(id) ?? NULL_WINDOW; }
    constructor(width, height, n, bits, isFloat, color, id) {
      this.isNull = false;
      this.keywords = [];
      this.hasAstrometricSolution = false;
      const win = this;
      let viewId = uniqueId(id);
      this.mainView = {
        window: win,
        image: new Image(width, height, n),
        properties: [],
        get id() { return viewId; },
        set id(v) {
          if (open.has(v) && open.get(v) !== win) throw new Error(`View.id: identifier already in use: ${v}`);
          open.delete(viewId); viewId = v; open.set(v, win);
        },
        beginProcess() {}, endProcess() {},
      };
      open.set(viewId, this);
    }
    show() { this.shown = true; }
    forceClose() { open.delete(this.mainView.id); this.closed = true; }
    get mask() { return this.attached ?? NULL_WINDOW; }
    set mask(w) { this.attached = w; }
    removeMask() { this.attached = null; }
    copyAstrometricSolution() {}
    saveAs(file) {
      if (calls.saveThrows) throw new Error('disk full');
      calls.saved.push({ file, id: this.mainView.id });
      files.add(file);
      return true;
    }
  }
  // Processes do not change pixels here, so a mask is compared as the pixel loop left it. Each run is
  // recorded with a copy of every open temporary window's channel 0, so a temporary window closed
  // later can still be checked.
  const process = (name) => class {
    executeOn(view) {
      const snapshot = {};
      for (const [id, w] of open) if (id.startsWith('__')) snapshot[id] = new Float32Array(w.mainView.image.data[0]);
      calls.executed.push({ name, view: view.id, snapshot });
      return true;
    }
  };
  const sandbox = {
    ImageWindow, Rect,
    Convolution: Object.assign(process('Convolution'), { Parametric: 1 }),
    PixelMath: process('PixelMath'),
    SampleFormatConversion: Object.assign(process('SampleFormatConversion'), { To8Bit: 1, To16Bit: 2 }),
    File: { exists: (f) => files.has(f), remove: (f) => files.delete(f) },
    FileInfo: class { constructor() { this.size = 1048576; } },
    processEvents() {
      if (++calls.yields >= abortAfterYields) throw new Error('MCP_ABORTED: Pause/Abort was pressed');
    },
  };
  const ctx = vm.createContext(sandbox);
  const run = (code) => vm.runInContext(code, ctx);
  // The api a handler receives: pjsr runs the emitted code in this world.
  const api = (extra = {}) => ({
    pjsr: async (code) => {
      try {
        const v = run(code);
        const text = v === undefined ? 'Script executed.' : String(v);
        return { status: 'success', result: text, outputs: { consoleOutput: text, consoleErrors: [] } };
      } catch (e) {
        return { status: 'error', error: { message: `Script error: ${e.message}` } };
      }
    },
    listImages: async () => [...open.values()].map((w) => ({ id: w.mainView.id, width: w.mainView.image.width, height: w.mainView.image.height, isColor: w.mainView.image.isColor })),
    stats: async () => ({ median: 0.1, max: 0.9 }),
    ...extra,
  });
  const add = (id, width, height, n, seed) => fill(new ImageWindow(width, height, n, 32, true, n >= 3, id).mainView.image, seed);
  return { open, calls, run, api, add, ImageWindow };
}

const f32 = (v) => Math.fround(v);
function assertImageEquals(actual, expectedAt, what) {
  for (let y = 0; y < actual.height; y++) {
    for (let x = 0; x < actual.width; x++) {
      const want = f32(expectedAt(x, y));
      if (actual.sample(x, y) !== want) assert.fail(`${what}: pixel (${x}, ${y}) is ${actual.sample(x, y)}, the per-pixel formula gives ${want}`);
    }
  }
}

// --- the helpers themselves ---

test('mcpLumRow gives exactly the per-pixel Rec.709 luminance of a colour row, and the samples of a mono row', () => {
  const w = world();
  const rgb = w.add('RGB', 37, 5, 3, 3);
  const mono = w.add('L', 37, 5, 1, 4);
  w.run(PIXEL_ROWS);
  const lum = w.run('mcpLumRow(ImageWindow.windowById("RGB").mainView.image, 2, mcpLumBuffers(37))');
  const gray = w.run('Array.prototype.slice.call(mcpLumRow(ImageWindow.windowById("L").mainView.image, 4, mcpLumBuffers(37)))');
  for (let x = 0; x < 37; x++) {
    assert.equal(lum[x], LUM(rgb.sample(x, 2, 0), rgb.sample(x, 2, 1), rgb.sample(x, 2, 2)));
    assert.equal(gray[x], mono.sample(x, 4));
  }
});

test('mcpLumCache reads each row once, in any access order within its capacity, with the same values', () => {
  const w = world();
  const rgb = w.add('RGB', 20, 12, 3, 5);
  w.run(PIXEL_ROWS);
  w.run('var at = mcpLumCache(ImageWindow.windowById("RGB").mainView.image, 3);');
  w.calls.getSamples = 0;
  for (const [x, y] of [[0, 1], [19, 1], [5, 2], [5, 0], [7, 1], [3, 2], [8, 0]]) {
    assert.equal(w.run(`at(${x}, ${y})`), LUM(rgb.sample(x, y, 0), rgb.sample(x, y, 1), rgb.sample(x, y, 2)));
  }
  assert.equal(w.calls.getSamples, 3 * 3, 'three rows, three channels each, each read once');
});

test('mcpRowDone yields to PixInsight every 64 calls', () => {
  const w = world();
  w.run(PIXEL_ROWS);
  w.run('for (var i = 0; i < 200; i++) mcpRowDone();');
  assert.equal(w.calls.yields, 3);
});

// --- 1. the tools' pixel loops: same pixels, and a stop leaves no window ---

test('extract_pseudo_oiii: every pixel is max(0, B - factor * R), as before', async () => {
  const w = world();
  const rgb = w.add('RGB', 41, 150, 3, 7);
  const out = await byName.extract_pseudo_oiii.handler(w.api(), { rgb_id: 'RGB', continuum_factor: 0.37 });
  assert.match(out.text, /Pseudo-OIII extracted: OIII_pseudo/);
  assertImageEquals(w.open.get('OIII_pseudo').mainView.image, (x, y) => Math.max(0, rgb.sample(x, y, 2) - 0.37 * rgb.sample(x, y, 0)), 'OIII_pseudo');
  assert.equal(w.calls.yields, 2, '150 rows: a yield at row 64 and 128');
});

test('extract_pseudo_oiii stopped mid-loop leaves no output window', async () => {
  const w = world({ abortAfterYields: 1 });
  w.add('RGB', 41, 150, 3, 7);
  await assert.rejects(byName.extract_pseudo_oiii.handler(w.api(), { rgb_id: 'RGB', continuum_factor: 0.37 }), /MCP_ABORTED/);
  assert.deepEqual([...w.open.keys()], ['RGB']);
});

test('create_zone_masks: every pixel of the three masks follows the ramps, as before (colour and mono)', async () => {
  for (const n of [3, 1]) {
    const w = world();
    const src = w.add('SRC', 43, 140, n, 11);
    const lum = (x, y) => (n === 3 ? LUM(src.sample(x, y, 0), src.sample(x, y, 1), src.sample(x, y, 2)) : src.sample(x, y));
    await createZoneMasks(w.api(), 'SRC', { core_clip: 0.6, shell_clip: 0.3, halo_clip: 0.08 });
    const ramp = (l, lo, hi, top) => (l > lo && (top || l <= hi) ? Math.min(1, (l - lo) / (hi - lo)) : 0);
    assertImageEquals(w.open.get('mask_core').mainView.image, (x, y) => ramp(lum(x, y), 0.6, 1, true), `mask_core (${n} channels)`);
    assertImageEquals(w.open.get('mask_shell').mainView.image, (x, y) => ramp(lum(x, y), 0.3, 0.6), `mask_shell (${n} channels)`);
    assertImageEquals(w.open.get('mask_halo').mainView.image, (x, y) => ramp(lum(x, y), 0.08, 0.3), `mask_halo (${n} channels)`);
  }
});

test('create_zone_masks stopped mid-loop leaves none of its three windows', async () => {
  const w = world({ abortAfterYields: 1 });
  w.add('SRC', 43, 140, 3, 11);
  await assert.rejects(createZoneMasks(w.api(), 'SRC', { core_clip: 0.6, shell_clip: 0.3, halo_clip: 0.08 }), /MCP_ABORTED/);
  assert.deepEqual([...w.open.keys()], ['SRC']);
});

test('create_adaptive_zone_masks: every pixel and every count follows its thresholds and ROI, as before', async () => {
  const w = world();
  const src = w.add('SRC', 150, 140, 3, 13);
  const r = await createAdaptiveZoneMasks(w.api(), 'SRC', { coreBias: 0.5 });
  const { core: coreTh, shellLow, outer: subjectTh } = r.thresholds;
  const { cx, cy, radius: rad } = r.roi;
  const mid = (shellLow + coreTh) / 2, half = (coreTh - shellLow) / 2;
  const counts = { core: 0, shell: 0, outer: 0 };
  const at = (x, y) => {
    const lum = LUM(src.sample(x, y, 0), src.sample(x, y, 1), src.sample(x, y, 2));
    const dist = Math.sqrt((x - cx) ** 2 + (y - cy) ** 2);
    const roiW = dist < rad ? 1.0 : Math.max(0, 1.0 - (dist - rad) / 20.0);
    let cV = 0, sV = 0, oV = 0;
    if (lum > coreTh) cV = Math.min(1.0, (lum - coreTh) / Math.max(0.01, 1.0 - coreTh));
    if (half > 0 && lum > shellLow && lum <= coreTh) sV = Math.max(0, Math.min(1, 1.0 - Math.abs(lum - mid) / half));
    if (lum > subjectTh && lum <= shellLow) oV = Math.min(1.0, (lum - subjectTh) / Math.max(0.01, shellLow - subjectTh));
    return { c: cV * roiW, s: sV * roiW, o: oV * roiW, lum };
  };
  for (let y = 0; y < 140; y++) for (let x = 0; x < 150; x++) {
    const { lum } = at(x, y);
    if (lum > coreTh) counts.core++;
    if (half > 0 && lum > shellLow && lum <= coreTh) counts.shell++;
    if (lum > subjectTh && lum <= shellLow) counts.outer++;
  }
  assert.ok(counts.core > 0 && counts.shell > 0 && counts.outer > 0, JSON.stringify(counts));
  assert.deepEqual(r.pixelCounts, counts);
  assertImageEquals(w.open.get('azone_core').mainView.image, (x, y) => at(x, y).c, 'azone_core');
  assertImageEquals(w.open.get('azone_shell').mainView.image, (x, y) => at(x, y).s, 'azone_shell');
  assertImageEquals(w.open.get('azone_outer').mainView.image, (x, y) => at(x, y).o, 'azone_outer');
});

test('create_adaptive_zone_masks stopped mid-loop leaves none of its three windows', async () => {
  const w = world({ abortAfterYields: 1 });
  w.add('SRC', 150, 140, 3, 13);
  await assert.rejects(createAdaptiveZoneMasks(w.api(), 'SRC', { coreBias: 0.5 }), /MCP_ABORTED/);
  assert.deepEqual([...w.open.keys()], ['SRC']);
});

test('continuous_clamp: its luminance mask is the per-pixel luminance over its maximum, as before, and is closed', async () => {
  for (const n of [3, 1]) {
    const w = world();
    const src = w.add('SRC', 39, 130, n, 17);
    await byName.continuous_clamp.handler(w.api(), { view_id: 'SRC', min_clamp: 0.8, max_clamp: 0.95, mode: 'hard', blur_sigma: 30 });
    const pm = w.calls.executed.find((e) => e.name === 'PixelMath' && e.view === 'SRC');
    const mask = pm.snapshot.__cont_clamp_lum;
    const lum = (x, y) => (n === 3 ? LUM(src.sample(x, y, 0), src.sample(x, y, 1), src.sample(x, y, 2)) : src.sample(x, y));
    const raw = Float32Array.from({ length: 39 * 130 }, (_, i) => lum(i % 39, Math.floor(i / 39)));
    const max = Math.max(...raw);
    for (let i = 0; i < raw.length; i++) assert.equal(mask[i], f32(raw[i] / max), `pixel ${i} (${n} channels)`);
    assert.deepEqual([...w.open.keys()], ['SRC'], 'the temporary mask is closed');
  }
});

test('continuous_clamp stopped mid-loop leaves its temporary mask closed and the view unclamped', async () => {
  const w = world({ abortAfterYields: 1 });
  w.add('SRC', 39, 130, 3, 17);
  await assert.rejects(byName.continuous_clamp.handler(w.api(), { view_id: 'SRC', min_clamp: 0.8, max_clamp: 0.95, mode: 'hard' }), /MCP_ABORTED/);
  assert.deepEqual([...w.open.keys()], ['SRC']);
  assert.equal(w.calls.executed.filter((e) => e.name === 'PixelMath').length, 0);
});

test('dynamic_narrowband_blend: its mask is the per-pixel luminance of the target before the blur, as before', async () => {
  const w = world();
  const rgb = w.add('RGB', 33, 70, 3, 19);
  w.add('Ha', 33, 70, 1, 20);
  w.add('OIII', 33, 70, 1, 21);
  await byName.dynamic_narrowband_blend.handler(w.api(), {
    target_id: 'RGB', ha_id: 'Ha', oiii_id: 'OIII',
    ha_strength: 0.35, oiii_strength: 0.4, g_strength: 0.3, max_output: 0.9, mask_clip: 0, mask_blur: 3, g_ha_fraction: 0.3, rolloff: 0.2,
  });
  const conv = w.calls.executed.find((e) => e.name === 'Convolution' && e.view === '__nb_blend_mask');
  assert.ok(conv, 'the mask was built and blurred');
  for (let i = 0; i < 33 * 70; i++) {
    const x = i % 33, y = Math.floor(i / 33);
    assert.equal(conv.snapshot.__nb_blend_mask[i], f32(LUM(rgb.sample(x, y, 0), rgb.sample(x, y, 1), rgb.sample(x, y, 2))), `pixel ${i}`);
  }
});

// --- 2. export_image keeps the view's id in the file ---

function exportWorkspace(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gkko-export-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return { dir, outputDir: path.join(dir, 'output'), scratchDir: path.join(dir, 'agentic', 'scratch') };
}

test('export_image saves a copy named after the source view, and the source keeps its name', async (t) => {
  const w = world();
  w.add('Seagull_HOO', 9, 7, 3, 23);
  const out = await byName.export_image.handler(w.api({ workspace: exportWorkspace(t) }), { view_id: 'Seagull_HOO', file_path: 'final.xisf' });
  assert.match(out.text, /^Wrote /);
  assert.equal(w.calls.saved.length, 1);
  assert.equal(w.calls.saved[0].id, 'Seagull_HOO', 'the file stores the source view id');
  assert.deepEqual([...w.open.keys()], ['Seagull_HOO'], 'the copy is closed and the source has its name back');
});

test('export_image gives the source its name back when the save fails, and parks it under a free name', async (t) => {
  const w = world();
  w.add('M42', 9, 7, 3, 29);
  w.add('__mcp_export_source', 2, 2, 1, 30); // a leftover with the parking name
  w.calls.saveThrows = true;
  await assert.rejects(byName.export_image.handler(w.api({ workspace: exportWorkspace(t) }), { view_id: 'M42', file_path: 'final.xisf' }), /disk full/);
  assert.deepEqual([...w.open.keys()].sort(), ['M42', '__mcp_export_source']);
  assert.equal(w.open.get('M42').mainView.image.width, 9, 'M42 is the source, not the copy');
});

// --- 3. colour-only tools refuse a mono view ---

test('the four tools that read R, G and B refuse a mono view before sending anything', async () => {
  const cases = [
    ['ha_inject_red', { target_id: 'L', ha_id: 'Ha', strength: 0.5, brightness_limit: 0.1 }, /target_id must be a colour \(RGB\) view; target_id L is mono/],
    ['ha_inject_luminance', { target_id: 'L', ha_id: 'Ha', strength: 0.5 }, /target_id must be a colour \(RGB\) view; target_id L is mono/],
    ['star_protected_blend', { target_id: 'RGB', stars_id: 'L', strength: 1, core_threshold_low: 0.2, core_threshold_high: 0.8, min_strength_fraction: 0.3, max_value: 0.95 }, /target_id, stars_id must be colour \(RGB\) views; stars_id L is mono/],
    ['restore_star_color', { target_id: 'L', pre_star_id: 'RGB', restore_start: 0.2, restore_end: 0.8, max_value: 0.95 }, /target_id, pre_star_id must be colour \(RGB\) views; target_id L is mono/],
  ];
  for (const [name, input, message] of cases) {
    const sent = [];
    const api = {
      pjsr: async (code) => { sent.push(code); return { status: 'success', outputs: { consoleOutput: '{}' } }; },
      listImages: async () => [{ id: 'L', width: 8, height: 8, isColor: false }, { id: 'Ha', width: 8, height: 8, isColor: false }, { id: 'RGB', width: 8, height: 8, isColor: true }],
      stats: async () => ({ median: 0.1, max: 0.9 }),
    };
    const out = await byName[name].handler(api, input);
    assert.equal(out.isError, true, name);
    assert.match(out.text, message, name);
    assert.match(out.text, /No view was changed\.$/, name);
    assert.deepEqual(sent, [], `${name} sent nothing to PixInsight`);
  }
});

test('ha_inject_red and ha_inject_luminance fail when PixelMath reports that it did not run', async () => {
  for (const name of ['ha_inject_red', 'ha_inject_luminance']) {
    const w = world();
    w.add('RGB', 8, 8, 3, 31);
    w.add('Ha', 8, 8, 1, 32);
    w.run('PixelMath.prototype.executeOn = function () { return false; };');
    await assert.rejects(byName[name].handler(w.api(), { target_id: 'RGB', ha_id: 'Ha', strength: 0.5, brightness_limit: 0.1 }), /PixelMath did not run on RGB/, name);
  }
});
