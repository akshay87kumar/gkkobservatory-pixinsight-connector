// ============================================================================
// Region and grid statistics: get_region_stats, get_grid_stats.
//
// Every statistic is PixInsight's own (Image.median, MAD, orderStatistic, minimumPosition, Sn, Qn,
// BWMV, noiseMRS, ...), computed on a rectangle and one channel through the Rect and channel-range
// overloads, which leave the image's own selections untouched (checked live, PixInsight 1.9.5). The
// noise estimate repeats PixInsight's NoiseEvaluation script: MRS from 4 layers down to 2, accepted
// once at least 1% of the region's pixels form the noise set, k-sigma otherwise, and sigma / Sn as
// its scaled value. Fractions above and below a level are counted a row at a time
// (src/tools/pixel-rows.mjs), with the comparison strict on both sides.
//
// Both tools only read. Regions are [x0, y0, x1, y1] in pixels with x1 and y1 exclusive, as
// PixInsight's Rect and save_preview's crop.
// ============================================================================
import { q, vid, oneOf, int, num, bool, pjsrJson } from './pjsr-args.mjs';
import { PIXEL_ROWS } from './pixel-rows.mjs';

const ESTIMATORS = ['avgDev', 'Sn', 'Qn', 'BWMV'];
const GRID_STATISTICS = ['mean', 'median', 'stdDev', 'mad', 'sigma', 'minimum', 'maximum'];
const MAX_TILES = 4096;

// rect(value, label) -> [x0, y0, x1, y1], whole pixels with x1 > x0 >= 0 and y1 > y0 >= 0.
function rect(value, label) {
  if (!Array.isArray(value) || value.length !== 4 || !value.every((v) => Number.isInteger(v) && v >= 0) || !(value[2] > value[0] && value[3] > value[1])) {
    throw new Error(`${label} must be [x0, y0, x1, y1], whole non-negative pixels with x1 > x0 and y1 > y0 (x1, y1 exclusive), got ${JSON.stringify(value)}`);
  }
  return value;
}

function numbers(value, label, { min = -Infinity, max = Infinity } = {}) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new Error(`${label} must be an array of numbers, got ${JSON.stringify(value)}`);
  return value.map((v, i) => {
    const n = num(v, undefined, `${label}[${i}]`);
    if (n < min || n > max) throw new Error(`${label}[${i}] must be in [${min}, ${max}], got ${n}`);
    return n;
  });
}

// Doubles in the result, to 8 significant digits; integers (counts, positions) as they are.
function tidy(value) {
  if (typeof value === 'number') return Number.isInteger(value) ? value : Number(value.toPrecision(8));
  if (Array.isArray(value)) return value.map(tidy);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, tidy(v)]));
  return value;
}

// PJSR shared by both tools: the image of an open view (or a refusal naming the open views), a Rect
// checked against the image, and the per-channel statistics of a region.
const STATS_PJSR = `
    ${PIXEL_ROWS}
    function mcpWindow(id) {
      var w = ImageWindow.windowById(id);
      if (w.isNull) {
        var open = ImageWindow.windows.map(function (x) { return x.mainView.id; });
        throw new Error('View not found: ' + id + '. Open views: ' + (open.join(', ') || '(none)') + '.');
      }
      return w;
    }
    function mcpRect(img, r, label) {
      if (r === null) return new Rect(0, 0, img.width, img.height);
      if (r[2] > img.width || r[3] > img.height) {
        throw new Error(label + ' [' + r.join(', ') + '] lies outside the image, which is ' + img.width + 'x' + img.height + ' (x1, y1 exclusive).');
      }
      return new Rect(r[0], r[1], r[2], r[3]);
    }
    function mcpChannelName(img, c) { return img.isColor ? ['R', 'G', 'B'][c] : 'K'; }
    // Fractions of the region's samples of channel c strictly above and strictly below each level.
    function mcpLevelFractions(img, rect, c, levels) {
      var w = rect.x1 - rect.x0, row = new Float64Array(w), nl = levels.length;
      var above = new Float64Array(nl), below = new Float64Array(nl), total = 0;
      for (var y = rect.y0; y < rect.y1; ++y) {
        img.getSamples(row, new Rect(rect.x0, y, rect.x1, y + 1), c);
        for (var x = 0; x < w; ++x) {
          var v = row[x];
          for (var k = 0; k < nl; ++k) { if (v > levels[k]) above[k]++; else if (v < levels[k]) below[k]++; }
        }
        total += w;
        mcpRowDone();
      }
      var out = {};
      for (var j = 0; j < nl; ++j) out[String(levels[j])] = { above: above[j] / total, below: below[j] / total };
      return out;
    }
    // PixInsight's NoiseEvaluation script, on the region and one channel.
    function mcpNoise(img, rect, c) {
      img.pushSelections();
      try {
        img.selectedRect = rect;
        img.selectedChannel = c;
        img.lastSelectedChannel = c;
        var area = (rect.x1 - rect.x0) * (rect.y1 - rect.y0), scale = img.Sn(), a, n = 4, method = 'MRS';
        for (;;) {
          a = img.noiseMRS(n);
          if (a[1] >= 0.01 * area) break;
          if (--n == 1) { a = img.noiseKSigma(); method = 'k-sigma'; break; }
        }
        return { sigma: a[0], scaledSigma: scale > 0 ? a[0] / scale : null, noisePixels: a[1], noiseFraction: a[1] / area, method: method, layers: method === 'MRS' ? n : null };
      } finally {
        img.popSelections();
      }
    }
    function mcpRegionStats(img, rect, o) {
      var out = [];
      for (var c = 0; c < (img.isColor ? 3 : 1); ++c) {
        var med = img.median(rect, c, c), mad = img.MAD(med, rect, c, c);
        var lo = img.minimumPosition(rect, c, c), hi = img.maximumPosition(rect, c, c);
        var s = {
          channel: mcpChannelName(img, c), mean: img.mean(rect, c, c), median: med, stdDev: img.stdDev(rect, c, c),
          mad: mad, sigma: 1.4826 * mad, min: img.minimum(rect, c, c), minAt: [lo.x, lo.y], max: img.maximum(rect, c, c), maxAt: [hi.x, hi.y]
        };
        if (o.percentiles.length) {
          s.percentiles = {};
          for (var p = 0; p < o.percentiles.length; ++p) s.percentiles[String(o.percentiles[p])] = img.orderStatistic(o.percentiles[p] / 100, rect, c, c);
        }
        if (o.levels.length) s.levels = mcpLevelFractions(img, rect, c, o.levels);
        for (var e = 0; e < o.estimators.length; ++e) {
          var name = o.estimators[e];
          if (name === 'avgDev') s.avgDev = img.avgDev(med, rect, c, c);
          else if (name === 'Sn') s.Sn = img.Sn(rect, c, c);
          else if (name === 'Qn') s.Qn = img.Qn(rect, c, c);
          else if (name === 'BWMV') s.BWMV = img.BWMV(med, mad, 9, false, rect, c, c);
        }
        if (o.noise) s.noise = mcpNoise(img, rect, c);
        out.push(s);
        mcpRowDone();
      }
      return out;
    }
`;

const getRegionStats = {
  name: 'get_region_stats',
  description: 'Statistics of rectangular regions of one or more views, per channel (R, G, B, or K for a mono view), computed by PixInsight\'s own statistics: pixel count, mean, median, standard deviation, MAD, sigma (1.4826 x MAD), and the minimum and maximum with their pixel positions. ' +
    'Optional: the order statistic at each given percentile; for each given level, the fractions of samples strictly above and strictly below it; the scale estimators avgDev, Sn, Qn and BWMV as PixInsight returns them (avgDev, Sn and Qn unnormalized: for Gaussian data, 1.2533 x avgDev, 1.1926 x Sn and 2.2219 x Qn equal the standard deviation; BWMV is the biweight midvariance about the median with the MAD as sigma and k = 9, a variance); and the Gaussian noise estimate of PixInsight\'s NoiseEvaluation script (MRS from 4 layers down to 2, accepted when at least 1% of the region\'s pixels form the noise set, k-sigma otherwise; also given divided by Sn, as that script reports it). ' +
    'Regions are [x0, y0, x1, y1] in pixels with x1 and y1 exclusive; the whole image when regions is omitted. Reads only: no view is changed.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      view_ids: { type: 'array', items: { type: 'string' }, minItems: 1, description: 'Views to measure; every region is measured on each' },
      regions: {
        type: 'array',
        description: 'Regions to measure; omitted = the whole image',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            name: { type: 'string', description: 'Label for the region in the result; omitted = its position in the list' },
            rect: { type: 'array', items: { type: 'integer' }, minItems: 4, maxItems: 4, description: '[x0, y0, x1, y1] in pixels, x1 and y1 exclusive' },
          },
          required: ['rect'],
        },
      },
      percentiles: { type: 'array', items: { type: 'number' }, description: 'Percentiles (0-100) whose order statistics are reported' },
      levels: { type: 'array', items: { type: 'number' }, description: 'Sample levels; for each, the fractions of samples strictly above and strictly below it are reported' },
      scale_estimators: { type: 'array', items: { type: 'string', enum: ESTIMATORS }, description: 'Extra scale estimators to report' },
      noise: { type: 'boolean', description: 'Also report the Gaussian noise estimate (NoiseEvaluation script); default false' },
    },
    required: ['view_ids'],
  },
  async handler(api, input) {
    if (!Array.isArray(input.view_ids) || input.view_ids.length === 0) throw new Error('view_ids must be a non-empty array of view ids');
    const ids = input.view_ids.map((id, i) => vid(id, `view_ids[${i}]`));
    const regions = input.regions === undefined || input.regions === null
      ? [{ name: 'image', rect: null }]
      : (Array.isArray(input.regions) && input.regions.length ? input.regions : (() => { throw new Error('regions must be a non-empty array of { name, rect }'); })())
        .map((r, i) => ({ name: r?.name === undefined ? String(i) : String(r.name), rect: rect(r?.rect, `regions[${i}].rect`) }));
    const o = {
      percentiles: numbers(input.percentiles, 'percentiles', { min: 0, max: 100 }),
      levels: numbers(input.levels, 'levels'),
      estimators: (input.scale_estimators ?? []).map((e, i) => oneOf(e, ESTIMATORS, undefined, `scale_estimators[${i}]`)),
      noise: bool(input.noise, false, 'noise'),
    };
    const result = await pjsrJson(api, `
      ${STATS_PJSR}
      var ids = ${JSON.stringify(ids)}, regions = ${JSON.stringify(regions)}, o = ${JSON.stringify(o)}, out = [];
      for (var i = 0; i < ids.length; ++i) {
        var img = mcpWindow(ids[i]).mainView.image;
        var view = { id: ids[i], width: img.width, height: img.height, channels: img.isColor ? 3 : 1, regions: [] };
        for (var j = 0; j < regions.length; ++j) {
          var r = mcpRect(img, regions[j].rect, 'region ' + regions[j].name);
          view.regions.push({ name: regions[j].name, rect: [r.x0, r.y0, r.x1, r.y1], pixels: (r.x1 - r.x0) * (r.y1 - r.y0), channels: mcpRegionStats(img, r, o) });
        }
        out.push(view);
      }
      JSON.stringify(out);
    `, 'get_region_stats');
    return { text: JSON.stringify(tidy(result)) };
  },
};

// Tile edges along one axis of [a, b): `count` tiles of (nearly) equal size, or tiles of `size`
// pixels with the last one taking the remainder.
export function tileEdges(a, b, { count, size }) {
  const span = b - a;
  if (count !== undefined) return Array.from({ length: count + 1 }, (_, i) => a + Math.round((i * span) / count));
  const edges = [];
  for (let e = a; e < b; e += size) edges.push(e);
  edges.push(b);
  return edges;
}

const getGridStats = {
  name: 'get_grid_stats',
  description: 'One statistic per tile of a grid laid over a view (or over a region of it), per channel (R, G, B, or K for a mono view), computed by PixInsight\'s own statistics. ' +
    'The grid comes from tiles [nx, ny] (tiles of nearly equal size) or from tile_size in pixels (the last column and row take the remainder); give one of them. ' +
    `statistic is one of ${GRID_STATISTICS.join(', ')} (sigma = 1.4826 x MAD). Returns the tile edges in x and y and, per channel, a table of ny rows of nx values. At most ${MAX_TILES} tiles. Reads only: no view is changed.`,
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      view_id: { type: 'string', description: 'View to measure' },
      statistic: { type: 'string', enum: GRID_STATISTICS, description: 'Statistic computed in each tile' },
      tiles: { type: 'array', items: { type: 'integer' }, minItems: 2, maxItems: 2, description: '[nx, ny]: number of tiles across and down' },
      tile_size: { type: 'integer', description: 'Tile width and height in pixels' },
      region: { type: 'array', items: { type: 'integer' }, minItems: 4, maxItems: 4, description: '[x0, y0, x1, y1] covered by the grid, x1 and y1 exclusive; omitted = the whole image' },
    },
    required: ['view_id', 'statistic'],
  },
  async handler(api, input) {
    const id = vid(input.view_id);
    const statistic = oneOf(input.statistic, GRID_STATISTICS, undefined, 'statistic');
    const hasTiles = input.tiles !== undefined && input.tiles !== null;
    const hasSize = input.tile_size !== undefined && input.tile_size !== null;
    if (hasTiles === hasSize) throw new Error('get_grid_stats: give exactly one of tiles [nx, ny] and tile_size');
    let tiles = null, size = null;
    if (hasTiles) {
      if (!Array.isArray(input.tiles) || input.tiles.length !== 2) throw new Error(`tiles must be [nx, ny], got ${JSON.stringify(input.tiles)}`);
      tiles = input.tiles.map((v, i) => int(v, undefined, `tiles[${i}]`));
      if (!(tiles[0] >= 1 && tiles[1] >= 1)) throw new Error(`tiles must be at least [1, 1], got ${JSON.stringify(tiles)}`);
    } else {
      size = int(input.tile_size, undefined, 'tile_size');
      if (size < 1) throw new Error(`tile_size must be at least 1, got ${size}`);
    }
    const region = input.region === undefined || input.region === null ? null : rect(input.region, 'region');
    // The image size decides the edges, so it is read first.
    const dims = await pjsrJson(api, `
      ${STATS_PJSR}
      var img = mcpWindow(${q(id)}).mainView.image;
      var r = mcpRect(img, ${JSON.stringify(region)}, 'region');
      JSON.stringify({ rect: [r.x0, r.y0, r.x1, r.y1] });
    `, 'get_grid_stats');
    const [x0, y0, x1, y1] = dims.rect;
    const xs = tileEdges(x0, x1, tiles ? { count: tiles[0] } : { size });
    const ys = tileEdges(y0, y1, tiles ? { count: tiles[1] } : { size });
    const n = (xs.length - 1) * (ys.length - 1);
    if (n > MAX_TILES) throw new Error(`get_grid_stats: ${xs.length - 1} x ${ys.length - 1} = ${n} tiles; at most ${MAX_TILES}`);
    if (xs.some((e, i) => i > 0 && e <= xs[i - 1]) || ys.some((e, i) => i > 0 && e <= ys[i - 1])) {
      throw new Error(`get_grid_stats: more tiles than pixels along an axis (region ${x1 - x0}x${y1 - y0})`);
    }
    const result = await pjsrJson(api, `
      ${STATS_PJSR}
      function mcpTileValue(img, r, c, s) {
        if (s === 'mean') return img.mean(r, c, c);
        if (s === 'median') return img.median(r, c, c);
        if (s === 'stdDev') return img.stdDev(r, c, c);
        if (s === 'minimum') return img.minimum(r, c, c);
        if (s === 'maximum') return img.maximum(r, c, c);
        var mad = img.MAD(img.median(r, c, c), r, c, c);
        return s === 'sigma' ? 1.4826 * mad : mad;
      }
      var img = mcpWindow(${q(id)}).mainView.image, xs = ${JSON.stringify(xs)}, ys = ${JSON.stringify(ys)}, out = {};
      for (var c = 0; c < (img.isColor ? 3 : 1); ++c) {
        var table = [];
        for (var j = 0; j + 1 < ys.length; ++j) {
          var row = [];
          for (var i = 0; i + 1 < xs.length; ++i) row.push(mcpTileValue(img, new Rect(xs[i], ys[j], xs[i + 1], ys[j + 1]), c, ${q(statistic)}));
          table.push(row);
          mcpRowDone();
        }
        out[mcpChannelName(img, c)] = table;
      }
      JSON.stringify(out);
    `, 'get_grid_stats');
    return { text: JSON.stringify(tidy({ view: id, statistic, xEdges: xs, yEdges: ys, values: result })) };
  },
};

export const tools = [getRegionStats, getGridStats];
