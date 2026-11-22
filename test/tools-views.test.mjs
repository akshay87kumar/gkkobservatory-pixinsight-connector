// view_history, get_view_info, close_images and rotate_image (src/tools/views.mjs), crop_image's
// output_id and the mask-safe close_image / close_mask (src/tools/images.mjs, masks.mjs), run in a vm
// against the stand-in PJSR world (test/pjsr-world.mjs), whose windows keep a real history of image
// states and whose FastRotation and Crop move real pixels.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { world } from './pjsr-world.mjs';
import { tools as viewTools } from '../src/tools/views.mjs';
import { tools as imageTools } from '../src/tools/images.mjs';
import { tools as maskTools } from '../src/tools/masks.mjs';

const byName = Object.fromEntries([...viewTools, ...imageTools, ...maskTools].map((t) => [t.name, t]));
const json = async (w, name, input) => JSON.parse((await byName[name].handler(w.api(), input)).text);

// A view with three recorded steps; state k has every sample equal to k / 10.
function withHistory() {
  const w = world();
  const img = w.add('V', 6, 4, 1, 1);
  const win = w.open.get('V');
  for (const k of [1, 2, 3]) { img.fill(k / 10); win.record(['PixelMath', 'Convolution', 'HistogramTransformation'][k - 1]); }
  return { w, img, win };
}
const level = (img) => Math.round(img.sample(0, 0) * 10);

test('view_history status lists every step and the position', async () => {
  const { w } = withHistory();
  const r = await json(w, 'view_history', { view_id: 'V', action: 'status' });
  assert.deepEqual(r.before.steps, ['PixelMath', 'Convolution', 'HistogramTransformation']);
  assert.deepEqual([r.before.index, r.before.canUndo, r.before.canRedo, r.after.index], [3, true, false, 3]);
});

test('view_history undo, redo and go move through the states', async () => {
  const { w, img } = withHistory();
  let r = await json(w, 'view_history', { view_id: 'V', action: 'undo', steps: 2 });
  assert.deepEqual([r.before.index, r.after.index, r.after.canRedo, level(img)], [3, 1, true, 1]);
  r = await json(w, 'view_history', { view_id: 'V', action: 'redo' });
  assert.deepEqual([r.after.index, level(img)], [2, 2]);
  r = await json(w, 'view_history', { view_id: 'V', action: 'go', index: 0 });
  assert.deepEqual([r.after.index, r.after.canUndo, level(img)], [0, false, 0]);
  await assert.rejects(byName.view_history.handler(w.api(), { view_id: 'V', action: 'go', index: 4 }), /outside the history of V \(0 to 3\)/);
  await assert.rejects(byName.view_history.handler(w.api(), { view_id: 'V', action: 'undo', steps: 0 }), /at least 1/);
});

test('view_history snapshot copies a past state into a new view and returns to the current one', async () => {
  const { w, img, win } = withHistory();
  win.keywords = [{ name: 'FILTER', value: "'Ha'", strippedValue: 'Ha', comment: '' }];
  const r = await json(w, 'view_history', { view_id: 'V', action: 'snapshot', index: 1, output_id: 'V_step1' });
  assert.deepEqual([r.snapshot.id, r.snapshot.fromIndex, r.after.index, level(img)], ['V_step1', 1, 3, 3]);
  const snap = w.open.get('V_step1');
  assert.equal(Math.round(snap.mainView.image.sample(0, 0) * 10), 1);
  assert.equal(snap.keywords[0].name, 'FILTER');
  await assert.rejects(byName.view_history.handler(w.api(), { view_id: 'V', action: 'snapshot', index: 2, output_id: 'V_step1' }), /output_id V_step1 is already open/);
  assert.equal(level(img), 3, 'a refused snapshot leaves the view where it was');
});

test('view_history purge discards the history', async () => {
  const { w, img } = withHistory();
  const r = await json(w, 'view_history', { view_id: 'V', action: 'purge' });
  assert.deepEqual([r.before.index, r.after.index, r.after.length, r.after.canUndo, level(img)], [3, 0, 0, false, 3]);
});

test('get_view_info reports mask, mask users, history, format and memory; keywords and properties only when asked', async () => {
  const w = world();
  w.add('RGB', 100, 50, 3, 2);
  w.add('M', 100, 50, 1, 3);
  const rgb = w.open.get('RGB');
  rgb.setMask('M', true);
  rgb.keywords = [{ name: 'EXPTIME', value: '300', strippedValue: '300', comment: 's' }];
  rgb.mainView.setPropertyValue('Instrument:Filter:Name', 'Ha');
  let [info] = await json(w, 'get_view_info', { view_ids: ['RGB'] });
  assert.deepEqual(info.mask, { id: 'M', enabled: true, inverted: true });
  assert.deepEqual([info.width, info.height, info.channels, info.isColor, info.bitsPerSample, info.isFloat], [100, 50, 3, true, 32, true]);
  assert.equal(info.megabytes, Math.round(100 * 50 * 3 * 4 / 1048576 * 10) / 10);
  assert.equal(info.keywords, undefined);
  assert.equal(info.properties, undefined);
  const all = await json(w, 'get_view_info', { keywords: true, properties: true });
  assert.deepEqual(all.map((v) => v.id), ['RGB', 'M']);
  assert.deepEqual(all[1].maskFor, ['RGB']);
  assert.deepEqual(all[0].keywords, [{ name: 'EXPTIME', value: '300', comment: 's' }]);
  assert.deepEqual(all[0].properties.map((p) => [p.id, p.value]), [['Instrument:Filter:Name', 'Ha']]);
  await assert.rejects(byName.get_view_info.handler(w.api(), { view_ids: ['Nope'] }), /View not found: Nope/);
});

test('close_images detaches a mask in use, reports ids that are not open, and lists what stays open', async () => {
  const w = world();
  w.add('A', 4, 4, 3, 1);
  w.add('M', 4, 4, 1, 2);
  w.add('Keep', 4, 4, 1, 3);
  w.open.get('A').setMask('M');
  w.open.get('Keep').setMask('M');
  const r = await json(w, 'close_images', { view_ids: ['M', 'A', 'Gone'] });
  assert.deepEqual(r, { closed: ['M', 'A'], notOpen: ['Gone'], detachedAsMask: ['M'], stillOpen: ['Keep'] });
  assert.equal(w.open.get('Keep').attached, null, 'the mask is taken off the view that stays open');
});

test('close_image and close_mask take a mask off the views that use it before closing it', async () => {
  for (const [tool, arg] of [['close_image', 'view_id'], ['close_mask', 'mask_id']]) {
    const w = world();
    w.add('T', 4, 4, 3, 1);
    w.add('M', 4, 4, 1, 2);
    w.open.get('T').setMask('M');
    await byName[tool].handler(w.api(), { [arg]: 'M' });
    assert.deepEqual([[...w.open.keys()], w.open.get('T').attached], [['T'], null], tool);
  }
});

test('rotate_image: the marked pixel lands where the reported mapping says, for every operation', async () => {
  const expected = {
    rotate_90_cw: { size: [3, 5], at: [3 - 1 - 1, 4], map: '(2 - y, x)' },
    rotate_90_ccw: { size: [3, 5], at: [1, 5 - 1 - 4], map: '(y, 4 - x)' },
    rotate_180: { size: [5, 3], at: [5 - 1 - 4, 3 - 1 - 1], map: '(4 - x, 2 - y)' },
    mirror_horizontal: { size: [5, 3], at: [0, 1], map: '(4 - x, y)' },
    mirror_vertical: { size: [5, 3], at: [4, 1], map: '(x, 2 - y)' },
  };
  for (const [operation, e] of Object.entries(expected)) {
    const w = world();
    const img = w.add('V', 5, 3, 1, 1);
    img.fill(0); img.setSample(1, 4, 1); // the mark at (4, 1)
    const out = await byName.rotate_image.handler(w.api(), { view_id: 'V', operation });
    const now = w.open.get('V').mainView.image;
    const p = now.maximumPosition();
    assert.deepEqual([[now.width, now.height], [p.x, p.y]], [e.size, e.at], operation);
    assert.ok(out.text.includes(`is now at ${e.map}`), `${operation}: ${out.text}`);
    assert.match(out.text, /^Rotated V in place/);
  }
});

test('rotate_image into output_id leaves the source unchanged and carries keywords; an open output_id is refused', async () => {
  const w = world();
  w.add('V', 5, 3, 3, 2);
  const src = w.open.get('V');
  src.keywords = [{ name: 'OBJECT', value: "'IC 2177'", strippedValue: 'IC 2177', comment: '' }];
  src.hasAstrometricSolution = true;
  const before = Array.from(src.mainView.image.data[0]);
  const out = await byName.rotate_image.handler(w.api(), { view_id: 'V', operation: 'rotate_180', output_id: 'V_rot' });
  assert.match(out.text, /^Wrote V_rot from V \(rotate_180\): 5x3 -> 5x3/);
  assert.match(out.text, /It has no astrometric solution now \(the original had one\)/);
  assert.deepEqual(Array.from(src.mainView.image.data[0]), before);
  assert.equal(w.open.get('V_rot').keywords[0].name, 'OBJECT');
  await assert.rejects(byName.rotate_image.handler(w.api(), { view_id: 'V', operation: 'rotate_180', output_id: 'V_rot' }), /output_id V_rot is already open/);
});

test('crop_image into output_id crops a copy and leaves the source unchanged; an open output_id is refused', async () => {
  const w = world();
  w.add('V', 20, 10, 1, 3);
  w.add('Taken', 2, 2, 1, 4);
  const src = w.open.get('V');
  src.keywords = [{ name: 'FILTER', value: "'L'", strippedValue: 'L', comment: '' }];
  const out = await byName.crop_image.handler(w.api(), { view_id: 'V', left: 2, top: 1, right: 3, bottom: 4, output_id: 'V_crop' });
  assert.match(out.text, /^Cropped a copy of V into V_crop\. New size: 15x5\./);
  const crop = w.open.get('V_crop');
  assert.deepEqual([src.mainView.image.width, src.mainView.image.height], [20, 10]);
  assert.equal(crop.mainView.image.sample(0, 0), src.mainView.image.sample(2, 1));
  assert.equal(crop.keywords[0].name, 'FILTER');
  await assert.rejects(byName.crop_image.handler(w.api(), { view_id: 'V', left: 2, output_id: 'Taken' }), /output_id Taken is already open/);
});
