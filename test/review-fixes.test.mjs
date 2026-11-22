// Fixes from the review of the existing tools (2.5.3-gkkobservatory.4): views named by the caller are
// never silently closed, renamed or confused with another, the multi_scale_enhance mask is always taken
// off, statistics name their region and channels, and run_plate_solve does not solve against
// ImageSolver's built-in 1000 mm / 7.4 um when the image carries no scale.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { world } from './pjsr-world.mjs';
import { createFakeBridge, apiFrom } from './fake-bridge.mjs';
import { tools as imageTools } from '../src/tools/images.mjs';
import { tools as executeTools } from '../src/tools/execute.mjs';
import { tools as detailTools } from '../src/tools/detail.mjs';
import { tools as astrometryTools } from '../src/tools/astrometry.mjs';
import { buildApi } from '../src/api.mjs';

const byName = Object.fromEntries([...imageTools, ...executeTools, ...detailTools, ...astrometryTools].map((t) => [t.name, t]));

test('rename_view refuses a name that is open and reports the id the view has afterwards', async () => {
  const w = world();
  w.add('Ha', 4, 4, 1, 1);
  w.add('OIII', 4, 4, 1, 2);
  await assert.rejects(byName.rename_view.handler(w.api(), { old_id: 'Ha', new_id: 'OIII' }), /new_id OIII is already open; close it or name another view\. Ha was not renamed\./);
  assert.deepEqual([...w.open.keys()], ['Ha', 'OIII']);
  const out = await byName.rename_view.handler(w.api(), { old_id: 'Ha', new_id: 'Ha_master' });
  assert.equal(out.text, 'Renamed Ha → Ha_master');
  assert.ok(w.open.has('Ha_master'));
});

test('clone_image refuses to clone over its own source, and replaces another view of that name visibly, taking its mask role off first', async () => {
  const w = world();
  w.add('L', 6, 4, 1, 3);
  w.add('L_backup', 6, 4, 1, 4);
  w.add('T', 6, 4, 3, 5);
  w.open.get('T').setMask('L_backup');
  const sent = [];
  const api = w.api();
  const spy = { ...api, pjsr: (code) => { sent.push(code); return api.pjsr(code); } };
  await assert.rejects(byName.clone_image.handler(spy, { source_id: 'L', clone_id: 'L' }), /clone_id is the source view L/);
  assert.equal(sent.length, 0, 'nothing reached PixInsight');
  const out = await byName.clone_image.handler(spy, { source_id: 'L', clone_id: 'L_backup' });
  assert.match(out.text, /the view previously named L_backup was closed and replaced/);
  assert.equal(w.open.get('T').attached, null, 'the old L_backup was taken off T before it closed');
  assert.equal(w.open.get('L_backup').mainView.image.sample(0, 0), w.open.get('L').mainView.image.sample(0, 0));
  const fresh = await byName.clone_image.handler(spy, { source_id: 'L', clone_id: 'L_b2' });
  assert.equal(fresh.text, 'Cloned L → L_b2');
});

test('pixelmath_new_image replaces a view of its output name visibly, and refuses size_from or a view the expressions read', async () => {
  const { ctx, emitted } = createFakeBridge({ replies: [JSON.stringify({ clip: null, solution: false, replaced: true })] });
  const out = await byName.pixelmath_new_image.handler(apiFrom(ctx), { output_id: 'P_HOO', size_from: 'Ha', color: 'rgb', red: 'Ha', green: 'OIII', blue: 'OIII' });
  assert.match(out.text, /^Created P_HOO \(rgb\)\. The view previously named P_HOO was closed and replaced\./);
  const close = emitted[0].indexOf('if (__replaced) mcpSafeClose(__old);');
  assert.ok(close > 0 && close < emitted[0].indexOf('new PixelMath'), 'the old view is closed (mask role taken off) before PixelMath runs');
  assert.match(emitted[0], /if \(!P\.executeGlobal\(\)\) throw/);
  const sent = emitted.length;
  for (const input of [
    { output_id: 'Ha', size_from: 'Ha', color: 'gray', expression: 'OIII' },
    { output_id: 'Mix', size_from: 'Ha', color: 'gray', expression: '0.5*Mix + 0.5*Ha' },
  ]) {
    const r = await byName.pixelmath_new_image.handler(apiFrom(ctx), input);
    assert.equal(r.isError, true);
    assert.match(r.text, /name a new view\. Nothing was changed\./);
  }
  assert.equal(emitted.length, sent, 'nothing reached PixInsight');
  // A name that merely contains the output id is not a read of it.
  await byName.pixelmath_new_image.handler(apiFrom(createFakeBridge({ replies: ['{}'] }).ctx), { output_id: 'Mix', size_from: 'Ha', color: 'gray', expression: 'Mix_old*0.5' });
});

test('multi_scale_enhance takes its mask off and closes it in a finally block', async () => {
  const { ctx, emitted } = createFakeBridge({ replies: [JSON.stringify({ before: { detailScore: 1 }, after: { detailScore: 1 }, improvement: 0, params: {} })] });
  await byName.multi_scale_enhance.handler(apiFrom(ctx, { stats: async () => ({ median: 0.1, max: 0.5 }) }), {
    view_id: 'L', mask_clip_low: 0.06, mask_blur: 5, mask_gamma: 2.0, lhe_fine_radius: 24, lhe_fine_amount: 0.20, lhe_mid_radius: 48, lhe_mid_amount: 0.30,
    lhe_large_radius: 100, lhe_large_amount: 0.30, lhe_slope_limit: 1.5, lhe_fine_slope_limit: 1.3,
  });
  const js = emitted[0];
  const attach = js.indexOf('w.mask = maskWin;');
  const fin = js.indexOf('} finally {');
  assert.ok(js.indexOf('try {') < attach && attach < fin, 'the mask is attached inside the try');
  assert.match(js.slice(fin), /^} finally \{\s*if \(!w\.mask\.isNull && w\.mask\.mainView\.id === maskId\) w\.removeMask\(\);\s*var __mseMask = ImageWindow\.windowById\(maskId\);\s*if \(!__mseMask\.isNull\) __mseMask\.forceClose\(\);/);
});

test('api.stats names the whole image and the colour channels explicitly, never the selection or an alpha channel', async () => {
  const w = world();
  const img = w.add('RGB', 30, 20, 3, 6);
  img.selectedRect = { x0: 0, y0: 0, x1: 2, y1: 2, get area() { return 4; } }; // a selection an aborted script left
  img.selectedChannel = 1; img.lastSelectedChannel = 1;
  const api = buildApi({ ctx: { pjsr: w.api().pjsr, listImages: w.api().listImages }, platform: {}, workspace: { dir: '/', scratchDir: '/s', outputDir: '/o' }, log: () => {}, version: 't' });
  const s = await api.stats('RGB');
  const all = { x0: 0, y0: 0, x1: 30, y1: 20 };
  assert.equal(s.perChannel.R.median, img.median(all, 0, 0));
  assert.equal(s.perChannel.B.mad, img.MAD(img.median(all, 2, 2), all, 2, 2));
  assert.equal(s.max, img.maximum(all, 0, 2));
});

// run_plate_solve's snippet against a stand-in ImageSolver whose metadata starts, as PixInsight's does,
// at 1000 mm and 7.4 um.
async function solveSnippet(input, window) {
  const { ctx, emitted } = createFakeBridge({ replies: ['@@SOLVE@@' + JSON.stringify({ solved: true, summary: [] })] });
  await byName.run_plate_solve.handler(apiFrom(ctx), { view_id: 'L', ra_deg: 10, dec_deg: 20, ...input });
  let solved = false;
  function ImageSolver() { this.solverCfg = {}; this.metadata = { focal: 1000, xpixsz: 7.4, useFocal: true, resolution: 1.526 / 3600, ResolutionFromFocal: (f) => (7.4 / f) * 0.206265 }; }
  ImageSolver.starsCSVFilePath = () => '';
  ImageSolver.prototype.initialize = function () {};
  ImageSolver.prototype.solveImage = function () { solved = true; throw new Error('stop after the guard'); };
  const w = { isNull: false, keywords: [], hasAstrometricSolution: false, mainView: { hasProperty: () => false }, ...window };
  const out = vm.runInNewContext(emitted[0], { ImageSolver, ImageWindow: { windowById: () => w }, CatalogMode: { LocalXPSDServer: 3 }, File: { directoryExists: () => true, createDirectory() {} } });
  return { out: String(out), solved };
}

test('run_plate_solve refuses when neither the inputs nor the image give a scale, instead of using 1000 mm and 7.4 um', async () => {
  let r = await solveSnippet({}, {});
  assert.equal(r.solved, false);
  assert.match(r.out, /No scale seed: the image carries no focal length and pixel size/);
  r = await solveSnippet({ focal_length_mm: 400 }, {}); // focal length alone: the pixel size would be the 7.4 um default
  assert.equal(r.solved, false);
  for (const [input, window] of [
    [{ pixel_scale: 1.2 }, {}],
    [{}, { keywords: [{ name: 'FOCALLEN', value: '334' }, { name: 'XPIXSZ', value: '3.76' }] }],
    [{ focal_length_mm: 334 }, { mainView: { hasProperty: (id) => id === 'Instrument:Sensor:XPixelSize' } }],
    [{}, { hasAstrometricSolution: true }],
  ]) {
    r = await solveSnippet(input, window);
    assert.equal(r.solved, true, JSON.stringify([input, window]));
  }
});
