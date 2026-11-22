// A stand-in for the slice of PJSR the tools touch, with real pixel storage, for running emitted
// snippets in a vm without PixInsight. Images store float32 samples (a 32-bit PixInsight image);
// windows keep a processing history of image states; FastRotation, Crop, Convolution, PixelMath and
// SampleFormatConversion are stand-ins (the last three change no pixels). Statistics follow the PJSR
// signatures (Rect and channel-range overloads) and leave the selection alone.
import vm from 'node:vm';

const LUM = (r, g, b) => 0.2126 * r + 0.7152 * g + 0.0722 * b;
export { LUM };

// Deterministic pixel values: a dark noisy sky with a bright blob.
export function fill(img, seed = 1) {
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

// `abortAfterYields` makes processEvents() throw MCP_ABORTED on that call, as the watcher's does once
// Pause/Abort is pressed. `noise` sets what noiseMRS(n) reports as its count, per layer count.
export function world({ abortAfterYields = Infinity, noiseCount } = {}) {
  const open = new Map();
  const calls = { yields: 0, getSamples: 0, executed: [], saved: [] };
  const files = new Set();
  const NULL_WINDOW = { isNull: true, mainView: { id: '' } };
  class Rect {
    constructor(x0, y0, x1, y1) { Object.assign(this, { x0, y0, x1, y1 }); }
    get area() { return (this.x1 - this.x0) * (this.y1 - this.y0); }
  }
  class Point { constructor(x, y) { Object.assign(this, { x, y }); } }
  class Image {
    constructor(width, height, n) {
      Object.assign(this, { width, height, numberOfChannels: n, isColor: n >= 3, bitsPerSample: 32, isReal: true });
      this.data = Array.from({ length: n }, () => new Float32Array(width * height));
      this.selectedRect = new Rect(0, 0, width, height);
      this.selectedChannel = 0;
      this.lastSelectedChannel = n - 1;
      this.stack = [];
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
    fill(v) { for (const d of this.data) d.fill(v); return this; }
    // Samples of a region and channel range ([rect, c0, c1] as the PJSR overloads take them; the
    // selection when omitted), with their positions.
    region(rect, c0, c1) {
      const r = rect ?? this.selectedRect;
      const from = c0 ?? this.selectedChannel, to = c1 ?? (rect === undefined ? this.lastSelectedChannel : from);
      const out = [];
      for (let c = from; c <= to; c++) for (let y = r.y0; y < r.y1; y++) for (let x = r.x0; x < r.x1; x++) out.push({ v: this.data[c][y * this.width + x], x, y });
      return out;
    }
    values(...a) { return this.region(...a).map((p) => p.v); }
    mean(...a) { const v = this.values(...a); return v.reduce((s, x) => s + x, 0) / v.length; }
    median(...a) { const v = this.values(...a).sort((p, q) => p - q); const n = v.length; return n % 2 ? v[(n - 1) / 2] : (v[n / 2 - 1] + v[n / 2]) / 2; }
    stdDev(...a) { const v = this.values(...a), m = v.reduce((s, x) => s + x, 0) / v.length; return Math.sqrt(v.reduce((s, x) => s + (x - m) ** 2, 0) / (v.length - 1)); }
    minimum(...a) { return Math.min(...this.values(...a)); }
    maximum(...a) { return Math.max(...this.values(...a)); }
    minimumPosition(...a) { const p = this.region(...a).reduce((b, q) => (q.v < b.v ? q : b)); return new Point(p.x, p.y); }
    maximumPosition(...a) { const p = this.region(...a).reduce((b, q) => (q.v > b.v ? q : b)); return new Point(p.x, p.y); }
    MAD(center, ...a) {
      const v = this.values(...a), m = center ?? this.median(...a);
      const d = v.map((x) => Math.abs(x - m)).sort((p, q) => p - q), n = d.length;
      return n % 2 ? d[(n - 1) / 2] : (d[n / 2 - 1] + d[n / 2]) / 2;
    }
    orderStatistic(k, ...a) { const v = this.values(...a).sort((p, q) => p - q); return v[Math.round(k * (v.length - 1))]; }
    avgDev(center, ...a) { const v = this.values(...a); return v.reduce((s, x) => s + Math.abs(x - center), 0) / v.length; }
    Sn(...a) { return 0.5 * this.MAD(undefined, ...a) + 0.001; }
    Qn(...a) { return 0.25 * this.MAD(undefined, ...a) + 0.002; }
    BWMV(center, sigma, k, reduced, ...a) { return sigma * sigma + 0.003; }
    noiseMRS(n = 4) {
      const area = this.selectedRect.area;
      const count = noiseCount ? noiseCount(n, area) : area;
      return [0.001 * n + this.stdDev(), count];
    }
    noiseKSigma() { return [0.0123, this.selectedRect.area]; }
    pushSelections() { this.stack.push([this.selectedRect, this.selectedChannel, this.lastSelectedChannel]); return this; }
    popSelections() { [this.selectedRect, this.selectedChannel, this.lastSelectedChannel] = this.stack.pop(); return this; }
    assign(other) { this.data = other.data.map((d) => new Float32Array(d)); Object.assign(this, { width: other.width, height: other.height, numberOfChannels: other.numberOfChannels, isColor: other.isColor }); }
    resetChannelSelection() {}
    // Moves pixels as FastRotation's modes do.
    transform(mode) {
      const W = this.width, H = this.height, swap = mode === 1 || mode === 2;
      const at = [(x, y) => [W - 1 - x, H - 1 - y], (x, y) => [H - 1 - y, x], (x, y) => [y, W - 1 - x], (x, y) => [W - 1 - x, y], (x, y) => [x, H - 1 - y]][mode];
      const nw = swap ? H : W, nh = swap ? W : H;
      this.data = this.data.map((d) => { const o = new Float32Array(nw * nh); for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const [u, v] = at(x, y); o[v * nw + u] = d[y * W + x]; } return o; });
      Object.assign(this, { width: nw, height: nh, selectedRect: new Rect(0, 0, nw, nh) });
    }
    crop(l, t, r, b) {
      const W = this.width, nw = W - l - r, nh = this.height - t - b;
      this.data = this.data.map((d) => { const o = new Float32Array(nw * nh); for (let y = 0; y < nh; y++) for (let x = 0; x < nw; x++) o[y * nw + x] = d[(y + t) * W + x + l]; return o; });
      Object.assign(this, { width: nw, height: nh, selectedRect: new Rect(0, 0, nw, nh) });
    }
  }
  const uniqueId = (id) => { let u = id, n = 1; while (open.has(u)) u = id + n++; return u; };
  class ImageWindow {
    static windowById(id) { return open.get(id) ?? NULL_WINDOW; }
    static get windows() { return [...open.values()]; }
    constructor(width, height, n, bits, isFloat, color, id) {
      Object.assign(this, { isNull: false, keywords: [], hasAstrometricSolution: false, isNew: true, isModified: false, filePath: '', previews: [], maskEnabled: true, maskInverted: false, attached: null });
      const win = this;
      let viewId = uniqueId(id);
      const image = new Image(width, height, n);
      if (bits) image.bitsPerSample = bits;
      // history[i] = the image state at position i; steps[i] = the process that led from i to i+1.
      this.history = [image.data.map((d) => new Float32Array(d))];
      this.sizes = [[width, height]];
      this.steps = [];
      this.position = 0;
      this.mainView = {
        window: win, image, properties: [], stf: [[0.5, 0, 1, 0, 1], [0.5, 0, 1, 0, 1], [0.5, 0, 1, 0, 1], [0.5, 0, 1, 0, 1]],
        get id() { return viewId; },
        set id(v) {
          if (open.has(v) && open.get(v) !== win) throw new Error(`View.id: identifier already in use: ${v}`);
          open.delete(viewId); viewId = v; open.set(v, win);
        },
        get historyIndex() { return win.position; },
        get canGoBackward() { return win.position > 0; },
        get canGoForward() { return win.position < win.steps.length; },
        get processing() { const s = win.steps; return { length: s.length, at: (k) => ({ processId: () => s[k] }) }; },
        beginProcess() {}, endProcess() { win.record('Script'); },
        setPropertyValue(id, v) { this.props ??= {}; this.props[id] = v; if (!this.properties.includes(id)) this.properties.push(id); return true; },
        propertyValue(id) { return this.props?.[id]; },
        propertyAttributes() { return 0; },
        setPropertyAttributes() { return true; },
        propertyType() { return 13; },
      };
      open.set(viewId, this);
    }
    record(processId) {
      const img = this.mainView.image;
      this.history = this.history.slice(0, this.position + 1);
      this.sizes = this.sizes.slice(0, this.position + 1);
      this.steps = this.steps.slice(0, this.position);
      this.history.push(img.data.map((d) => new Float32Array(d)));
      this.sizes.push([img.width, img.height]);
      this.steps.push(processId);
      this.position++;
      this.isModified = true;
    }
    restore() {
      const img = this.mainView.image;
      img.data = this.history[this.position].map((d) => new Float32Array(d));
      [img.width, img.height] = this.sizes[this.position];
      img.selectedRect = new Rect(0, 0, img.width, img.height);
    }
    undo(n = 1) { this.position = Math.max(0, this.position - n); this.restore(); }
    redo(n = 1) { this.position = Math.min(this.steps.length, this.position + n); this.restore(); }
    go(i) { this.position = i; this.restore(); }
    purge() { this.history = [this.history[this.position]]; this.sizes = [this.sizes[this.position]]; this.steps = []; this.position = 0; }
    show() { this.shown = true; }
    hide() { this.shown = false; }
    forceClose() { open.delete(this.mainView.id); this.closed = true; }
    get mask() { return this.attached ?? NULL_WINDOW; }
    set mask(w) { this.attached = w; }
    setMask(w, inverted = false) { this.attached = typeof w === 'string' ? open.get(w) : w; this.maskInverted = inverted; }
    removeMask() { this.attached = null; }
    get hasMaskReferences() { return [...open.values()].some((w) => w.attached === this); }
    removeMaskReferences() { for (const w of open.values()) if (w.attached === this) w.attached = null; }
    copyAstrometricSolution(src) { this.hasAstrometricSolution = src.hasAstrometricSolution; }
    saveAs(file) {
      if (calls.saveThrows) throw new Error('disk full');
      calls.saved.push({ file, id: this.mainView.id });
      files.add(file);
      return true;
    }
  }
  // Every run is recorded with a copy of every open temporary window's channel 0, so a temporary
  // window closed later can still be checked.
  const process = (name, apply) => class {
    executeOn(view) {
      const snapshot = {};
      for (const [id, w] of open) if (id.startsWith('__')) snapshot[id] = new Float32Array(w.mainView.image.data[0]);
      calls.executed.push({ name, view: view.id, snapshot });
      if (apply) { apply(this, view.image, view.window); view.window.record(name); }
      return true;
    }
  };
  const FastRotation = Object.assign(process('FastRotation', (p, img, win) => { img.transform(p.mode); if (p.mode !== undefined) win.hasAstrometricSolution = false; }),
    { Rotate180: 0, Rotate90CW: 1, Rotate90CCW: 2, HorizontalMirror: 3, VerticalMirror: 4 });
  const Crop = Object.assign(process('Crop', (p, img, win) => { img.crop(-p.leftMargin, -p.topMargin, -p.rightMargin, -p.bottomMargin); win.hasAstrometricSolution = false; }), { AbsolutePixels: 2 });
  const sandbox = {
    ImageWindow, Rect, Point, FastRotation, Crop,
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
  return { open, calls, run, api, add, ImageWindow, files };
}
