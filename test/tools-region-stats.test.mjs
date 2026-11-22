// get_region_stats and get_grid_stats (src/tools/region-stats.mjs), run in a vm against the stand-in
// PJSR world (test/pjsr-world.mjs). Statistics are PixInsight's own, so these tests check the wiring:
// which region, channel and option each number comes from, the noise algorithm's layer fallback, the
// strict level counts (counted here independently), the tile edges, and the refusals.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { world } from './pjsr-world.mjs';
import { tools, tileEdges } from '../src/tools/region-stats.mjs';

const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
const run = async (w, name, input) => JSON.parse((await byName[name].handler(w.api(), input)).text);
const close = (a, b) => Math.abs(a - b) <= 1e-7 * Math.max(1, Math.abs(b));

test('get_region_stats: every number comes from its view, region and channel', async () => {
  const w = world();
  const rgb = w.add('RGB', 40, 30, 3, 3);
  const mono = w.add('L', 40, 30, 1, 4);
  const regions = [{ name: 'core', rect: [10, 10, 30, 25] }, { rect: [0, 0, 8, 6] }];
  const out = await run(w, 'get_region_stats', { view_ids: ['RGB', 'L'], regions, percentiles: [5, 50, 95], levels: [0.06, 0.5], scale_estimators: ['avgDev', 'Sn', 'Qn', 'BWMV'] });
  assert.deepEqual(out.map((v) => [v.id, v.channels, v.regions.map((r) => r.name)]), [['RGB', 3, ['core', '1']], ['L', 1, ['core', '1']]]);
  for (const [v, img] of [[out[0], rgb], [out[1], mono]]) {
    for (const reg of v.regions) {
      const [x0, y0, x1, y1] = reg.rect;
      const R = { x0, y0, x1, y1 };
      assert.equal(reg.pixels, (x1 - x0) * (y1 - y0));
      reg.channels.forEach((s, c) => {
        assert.equal(s.channel, img.isColor ? 'RGB'[c] : 'K');
        assert.ok(close(s.median, img.median(R, c, c)), `median ${v.id} ${reg.name} ${c}`);
        assert.ok(close(s.mean, img.mean(R, c, c)));
        assert.ok(close(s.sigma, 1.4826 * img.MAD(img.median(R, c, c), R, c, c)));
        assert.deepEqual(s.maxAt, [img.maximumPosition(R, c, c).x, img.maximumPosition(R, c, c).y]);
        assert.ok(close(s.percentiles['95'], img.orderStatistic(0.95, R, c, c)));
        // The level fractions, counted here from the samples themselves.
        const vals = img.values(R, c, c);
        for (const level of [0.06, 0.5]) {
          assert.ok(close(s.levels[String(level)].above, vals.filter((x) => x > level).length / vals.length));
          assert.ok(close(s.levels[String(level)].below, vals.filter((x) => x < level).length / vals.length));
        }
        assert.ok('avgDev' in s && 'Sn' in s && 'Qn' in s && 'BWMV' in s);
        assert.equal(s.noise, undefined, 'no noise unless asked');
      });
    }
  }
});

test('get_region_stats: the whole image when no region is given', async () => {
  const w = world();
  w.add('L', 20, 10, 1, 5);
  const [v] = await run(w, 'get_region_stats', { view_ids: ['L'] });
  assert.deepEqual(v.regions.map((r) => [r.name, r.rect, r.pixels]), [['image', [0, 0, 20, 10], 200]]);
  assert.deepEqual(Object.keys(v.regions[0].channels[0]).sort(), ['channel', 'mad', 'max', 'maxAt', 'mean', 'median', 'min', 'minAt', 'sigma', 'stdDev'].sort());
});

test('get_region_stats noise follows the NoiseEvaluation script: fewer layers until 1% of the region qualifies, then k-sigma', async () => {
  // MRS finds enough noise pixels only with 2 layers here.
  let w = world({ noiseCount: (n, area) => (n === 2 ? 0.02 * area : 0.005 * area) });
  w.add('L', 40, 30, 1, 6);
  let [v] = await run(w, 'get_region_stats', { view_ids: ['L'], regions: [{ name: 'r', rect: [0, 0, 20, 20] }], noise: true });
  let n = v.regions[0].channels[0].noise;
  assert.deepEqual([n.method, n.layers, n.noisePixels], ['MRS', 2, 8]);
  assert.ok(close(n.noiseFraction, 0.02));
  // Never enough: k-sigma, no layer count.
  w = world({ noiseCount: (k, area) => 0.001 * area });
  w.add('L', 40, 30, 1, 6);
  [v] = await run(w, 'get_region_stats', { view_ids: ['L'], noise: true });
  n = v.regions[0].channels[0].noise;
  assert.deepEqual([n.method, n.layers, n.sigma], ['k-sigma', null, 0.0123]);
  assert.ok(n.scaledSigma > 0);
});

test('get_region_stats leaves the image selection as it was', async () => {
  const w = world();
  const img = w.add('RGB', 30, 20, 3, 7);
  await run(w, 'get_region_stats', { view_ids: ['RGB'], regions: [{ rect: [2, 2, 12, 12] }], noise: true });
  assert.deepEqual([img.selectedRect.x0, img.selectedRect.x1, img.selectedChannel, img.lastSelectedChannel, img.stack.length], [0, 30, 0, 2, 0]);
});

test('get_region_stats refuses a region outside the image, a view that is not open, and malformed input', async () => {
  const w = world();
  w.add('L', 20, 10, 1, 8);
  await assert.rejects(byName.get_region_stats.handler(w.api(), { view_ids: ['L'], regions: [{ rect: [0, 0, 21, 5] }] }), /lies outside the image, which is 20x10/);
  await assert.rejects(byName.get_region_stats.handler(w.api(), { view_ids: ['Nope'] }), /View not found: Nope\. Open views: L/);
  await assert.rejects(byName.get_region_stats.handler(w.api(), { view_ids: ['L'], regions: [{ rect: [5, 0, 5, 4] }] }), /x1 > x0/);
  await assert.rejects(byName.get_region_stats.handler(w.api(), { view_ids: ['L'], percentiles: [101] }), /percentiles\[0\] must be in \[0, 100\]/);
  await assert.rejects(byName.get_region_stats.handler(w.api(), { view_ids: [] }), /non-empty/);
});

test('tileEdges: equal tiles round, sized tiles leave the remainder to the last one', () => {
  assert.deepEqual(tileEdges(0, 10, { count: 3 }), [0, 3, 7, 10]);
  assert.deepEqual(tileEdges(5, 15, { size: 4 }), [5, 9, 13, 15]);
  assert.deepEqual(tileEdges(0, 8, { size: 4 }), [0, 4, 8]);
});

test('get_grid_stats: each value is the statistic of its tile and channel', async () => {
  const w = world();
  const img = w.add('RGB', 10, 7, 3, 9);
  const out = await run(w, 'get_grid_stats', { view_id: 'RGB', statistic: 'median', tiles: [3, 2] });
  assert.deepEqual([out.xEdges, out.yEdges], [[0, 3, 7, 10], [0, 4, 7]]);
  for (const [c, name] of ['R', 'G', 'B'].entries()) {
    assert.equal(out.values[name].length, 2);
    out.values[name].forEach((row, j) => row.forEach((v, i) => {
      assert.ok(close(v, img.median({ x0: out.xEdges[i], y0: out.yEdges[j], x1: out.xEdges[i + 1], y1: out.yEdges[j + 1] }, c, c)), `${name}[${j}][${i}]`);
    }));
  }
  const sized = await run(w, 'get_grid_stats', { view_id: 'RGB', statistic: 'maximum', tile_size: 4, region: [1, 1, 9, 6] });
  assert.deepEqual([sized.xEdges, sized.yEdges], [[1, 5, 9], [1, 5, 6]]);
});

test('get_grid_stats refuses neither or both grid inputs, too many tiles, and more tiles than pixels', async () => {
  const w = world();
  w.add('L', 10, 7, 1, 10);
  const h = byName.get_grid_stats.handler;
  await assert.rejects(h(w.api(), { view_id: 'L', statistic: 'mean' }), /exactly one of tiles/);
  await assert.rejects(h(w.api(), { view_id: 'L', statistic: 'mean', tiles: [2, 2], tile_size: 3 }), /exactly one of tiles/);
  await assert.rejects(h(w.api(), { view_id: 'L', statistic: 'mean', tiles: [11, 1] }), /more tiles than pixels/);
  const big = world();
  big.add('B', 200, 200, 1, 11);
  await assert.rejects(h(big.api(), { view_id: 'B', statistic: 'mean', tile_size: 1 }), /at most 4096/);
});
