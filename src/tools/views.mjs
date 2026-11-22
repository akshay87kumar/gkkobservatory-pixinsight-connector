// ============================================================================
// Views: view_history, get_view_info, close_images, rotate_image.
//
// Built on PixInsight's own window and view API (checked live, PixInsight 1.9.5): View.historyIndex
// and View.processing (every step of the history, by process id, including steps that can be
// redone), ImageWindow.undo(n) / redo(n) / go(i) / purge(), View.stf, ImageWindow.mask and
// hasMaskReferences / removeMaskReferences(), and FastRotation, whose five modes move pixels exactly
// (no resampling).
// ============================================================================
import { q, vid, oneOf, int, bool, pjsrJson } from './pjsr-args.mjs';

// PJSR: mcpCopyWindow(src, id) -> a new hidden window named `id` holding a copy of src's image in the
// same sample format, with its FITS keywords, astrometric solution and view properties, as
// clone_image copies them. Throws if PixInsight did not give the window that id (it was taken).
export const COPY_WINDOW_PJSR = `
    function mcpCopyWindow(src, id) {
      var s = src.mainView.image;
      var c = new ImageWindow(s.width, s.height, s.numberOfChannels, s.bitsPerSample, s.isReal, s.isColor, id);
      if (c.mainView.id !== id) { var got = c.mainView.id; c.forceClose(); throw new Error('Could not create view ' + id + ' (PixInsight named it ' + got + ').'); }
      c.mainView.beginProcess(); c.mainView.image.assign(s); c.mainView.endProcess();
      c.keywords = src.keywords;
      if (src.hasAstrometricSolution) c.copyAstrometricSolution(src);
      var props = src.mainView.properties;
      for (var i = 0; i < props.length; ++i) {
        try {
          c.mainView.setPropertyValue(props[i], src.mainView.propertyValue(props[i]));
          c.mainView.setPropertyAttributes(props[i], src.mainView.propertyAttributes(props[i]));
        } catch (e) {}
      }
      c.hide();
      return c;
    }
`;

// PJSR: the open window with this id, or an error that lists the open views.
const WINDOW_PJSR = `
    function mcpWindow(id) {
      var w = ImageWindow.windowById(id);
      if (w.isNull) {
        var open = ImageWindow.windows.map(function (x) { return x.mainView.id; });
        throw new Error('View not found: ' + id + '. Open views: ' + (open.join(', ') || '(none)') + '.');
      }
      return w;
    }
    function mcpRefuseOpen(id, label) {
      if (!ImageWindow.windowById(id).isNull) throw new Error(label + ' ' + id + ' is already open; name a view that is not.');
    }
`;

// --- view_history ------------------------------------------------------------------------------

const HISTORY_ACTIONS = ['status', 'undo', 'redo', 'go', 'snapshot', 'purge'];

const viewHistory = {
  name: 'view_history',
  description: 'Read or move through the processing history (the undo/redo states) PixInsight keeps for a view. Position 0 is the initial state; position k is the state after the k-th step. ' +
    'status: the current position, whether undo and redo are possible, and every step by process name (steps after the current position can be redone). ' +
    'undo / redo: move `steps` back or forward (1 when omitted; clamped to the history). go: move to position `index`. ' +
    'snapshot: copy the view as it is at position `index` (pixels, FITS keywords, astrometric solution and view properties) into a new view output_id, then return to the current position. ' +
    'purge: discard the history to free memory and disk; it cannot be undone. Every action reports the position before and after.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      view_id: { type: 'string', description: 'View whose history is read or moved' },
      action: { type: 'string', enum: HISTORY_ACTIONS, description: 'What to do' },
      steps: { type: 'integer', description: 'undo / redo: number of steps; 1 when omitted' },
      index: { type: 'integer', description: 'go / snapshot: history position (0 = initial state)' },
      output_id: { type: 'string', description: 'snapshot: id of the new view; must not be open' },
    },
    required: ['view_id', 'action'],
  },
  async handler(api, input) {
    const id = vid(input.view_id);
    const action = oneOf(input.action, HISTORY_ACTIONS, undefined, 'action');
    const steps = ['undo', 'redo'].includes(action) ? int(input.steps, 1, 'steps') : null;
    if (steps !== null && steps < 1) throw new Error(`steps must be at least 1, got ${steps}`);
    const index = ['go', 'snapshot'].includes(action) ? int(input.index, undefined, 'index') : null;
    const outputId = action === 'snapshot' ? vid(input.output_id, 'output_id') : null;
    const r = await pjsrJson(api, `
      ${WINDOW_PJSR}
      ${COPY_WINDOW_PJSR}
      var w = mcpWindow(${q(id)}), v = w.mainView;
      function state() {
        var pc = v.processing, list = [];
        for (var k = 0; k < pc.length; ++k) list.push(pc.at(k).processId());
        return { index: v.historyIndex, canUndo: v.canGoBackward, canRedo: v.canGoForward, length: list.length, steps: list, modified: w.isModified };
      }
      var before = state(), out = { view: ${q(id)}, action: ${q(action)}, before: before };
      var action = ${q(action)}, index = ${index === null ? 'null' : index};
      if ((action === 'go' || action === 'snapshot') && (index < 0 || index > before.length)) {
        throw new Error('index ' + index + ' is outside the history of ' + ${q(id)} + ' (0 to ' + before.length + ').');
      }
      if (action === 'undo') w.undo(${steps ?? 0});
      else if (action === 'redo') w.redo(${steps ?? 0});
      else if (action === 'go') w.go(index);
      else if (action === 'purge') w.purge();
      else if (action === 'snapshot') {
        mcpRefuseOpen(${q(outputId ?? '')}, 'output_id');
        var back = v.historyIndex, copy = null;
        try {
          w.go(index);
          copy = mcpCopyWindow(w, ${q(outputId ?? '')});
          copy.show();
        } finally {
          w.go(back);
        }
        out.snapshot = { id: copy.mainView.id, fromIndex: index, width: copy.mainView.image.width, height: copy.mainView.image.height };
      }
      var after = state();
      out.after = { index: after.index, canUndo: after.canUndo, canRedo: after.canRedo, length: after.length, modified: after.modified };
      if (action !== 'status') delete out.before.steps;
      JSON.stringify(out);
    `, 'view_history');
    return { text: JSON.stringify(r) };
  },
};

// --- get_view_info -------------------------------------------------------------------------------

const getViewInfo = {
  name: 'get_view_info',
  description: 'What PixInsight holds about open views: size, channels, colour, sample format (bits, float), the memory the pixels take, file path, whether the image is new or modified, history position and whether undo and redo are possible, whether it has an astrometric solution, the mask it carries (enabled, inverted), the views that use it as a mask, its screen transfer function (per channel [midtones, shadows, highlights, low range, high range]) and its previews. ' +
    'Optional: its FITS keywords (name, value, comment) and its view properties (id, type, value; long values shortened). All open views when view_ids is omitted. Reads only: no view is changed.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      view_ids: { type: 'array', items: { type: 'string' }, description: 'Views to describe; omitted = every open view' },
      keywords: { type: 'boolean', description: 'Also list FITS keywords; default false' },
      properties: { type: 'boolean', description: 'Also list view properties; default false' },
    },
  },
  async handler(api, input) {
    const ids = input.view_ids === undefined || input.view_ids === null ? null : input.view_ids.map((x, i) => vid(x, `view_ids[${i}]`));
    const withKeywords = bool(input.keywords, false, 'keywords');
    const withProperties = bool(input.properties, false, 'properties');
    const r = await pjsrJson(api, `
      ${WINDOW_PJSR}
      var ids = ${JSON.stringify(ids)};
      var all = ImageWindow.windows;
      var wins = ids === null ? all : ids.map(mcpWindow);
      function info(w) {
        var v = w.mainView, img = v.image, mask = w.mask;
        var o = {
          id: v.id, width: img.width, height: img.height, channels: img.numberOfChannels, isColor: img.isColor,
          bitsPerSample: img.bitsPerSample, isFloat: img.isReal, megabytes: Math.round(img.width * img.height * img.numberOfChannels * img.bitsPerSample / 8 / 1048576 * 10) / 10,
          filePath: w.filePath || null, isNew: w.isNew, isModified: w.isModified,
          history: { index: v.historyIndex, canUndo: v.canGoBackward, canRedo: v.canGoForward },
          astrometricSolution: w.hasAstrometricSolution,
          mask: mask.isNull ? null : { id: mask.mainView.id, enabled: w.maskEnabled, inverted: w.maskInverted },
          maskFor: all.filter(function (x) { return !x.mask.isNull && x.mask.mainView.id === v.id; }).map(function (x) { return x.mainView.id; }),
          stf: v.stf,
          previews: w.previews.map(function (p) { return p.id; })
        };
        ${withKeywords ? `o.keywords = w.keywords.map(function (k) { return { name: k.name, value: k.strippedValue, comment: k.comment }; });` : ''}
        ${withProperties ? `o.properties = v.properties.map(function (p) {
          var val; try { val = v.propertyValue(p); } catch (e) { val = '(unreadable)'; }
          var s; try { s = typeof val === 'string' ? val : JSON.stringify(val); } catch (e) { s = String(val); }
          if (s === undefined) s = String(val);
          return { id: p, type: v.propertyType(p), value: s.length > 200 ? s.substring(0, 200) + '...' : s };
        });` : ''}
        return o;
      }
      JSON.stringify(wins.map(info));
    `, 'get_view_info');
    return { text: JSON.stringify(r) };
  },
};

// --- close_images --------------------------------------------------------------------------------

// PJSR: closes window w after taking it off every window that uses it as a mask: force-closing a mask
// in use has been reported to crash PixInsight 1.9.5 (not reproduced on Windows).
export const SAFE_CLOSE_PJSR = `
    function mcpSafeClose(w) {
      if (w.hasMaskReferences) w.removeMaskReferences();
      w.forceClose();
    }
`;

const closeImages = {
  name: 'close_images',
  description: 'Close several image windows in one call, discarding unsaved changes. A window that other windows use as a mask is removed as their mask before it closes. Ids that are not open are reported, not treated as errors. Returns what was closed, what was not open, and what is still open.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      view_ids: { type: 'array', items: { type: 'string' }, minItems: 1, description: 'Views to close' },
    },
    required: ['view_ids'],
  },
  async handler(api, input) {
    if (!Array.isArray(input.view_ids) || input.view_ids.length === 0) throw new Error('view_ids must be a non-empty array of view ids');
    const ids = input.view_ids.map((x, i) => vid(x, `view_ids[${i}]`));
    const r = await pjsrJson(api, `
      ${SAFE_CLOSE_PJSR}
      var ids = ${JSON.stringify(ids)}, closed = [], notOpen = [], detached = [];
      for (var i = 0; i < ids.length; ++i) {
        var w = ImageWindow.windowById(ids[i]);
        if (w.isNull) { notOpen.push(ids[i]); continue; }
        if (w.hasMaskReferences) detached.push(ids[i]);
        mcpSafeClose(w);
        closed.push(ids[i]);
      }
      JSON.stringify({ closed: closed, notOpen: notOpen, detachedAsMask: detached, stillOpen: ImageWindow.windows.map(function (x) { return x.mainView.id; }) });
    `, 'close_images');
    return { text: JSON.stringify(r) };
  },
};

// --- rotate_image --------------------------------------------------------------------------------

// FastRotation's modes (FastRotation.Rotate180 = 0 ... VerticalMirror = 4, checked live) and where a
// pixel (x, y) of a W x H image lands (checked live for 90 CW: (4, 0) of 5x3 -> (2, 4) of 3x5).
const ROTATIONS = {
  rotate_90_cw: { mode: 'Rotate90CW', map: (W, H) => `(${H - 1} - y, x)` },
  rotate_90_ccw: { mode: 'Rotate90CCW', map: (W) => `(y, ${W - 1} - x)` },
  rotate_180: { mode: 'Rotate180', map: (W, H) => `(${W - 1} - x, ${H - 1} - y)` },
  mirror_horizontal: { mode: 'HorizontalMirror', map: (W) => `(${W - 1} - x, y)` },
  mirror_vertical: { mode: 'VerticalMirror', map: (W, H) => `(x, ${H - 1} - y)` },
};

const rotateImage = {
  name: 'rotate_image',
  description: 'Rotate an image by 90 or 180 degrees, or mirror it, with PixInsight\'s FastRotation, which moves pixels exactly (no resampling). In place, or into a new view output_id (a copy with the FITS keywords, astrometric solution and view properties, the source unchanged). ' +
    'Operations: rotate_90_cw, rotate_90_ccw, rotate_180, mirror_horizontal (left and right swap), mirror_vertical (top and bottom swap). Runs with noGUIMessages, so warnings go to the Process Console instead of a dialog. ' +
    'Returns the new size, where a pixel (x, y) of the W x H original lands, and whether the result still has an astrometric solution.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      view_id: { type: 'string', description: 'View to rotate or mirror' },
      operation: { type: 'string', enum: Object.keys(ROTATIONS), description: 'Rotation or mirror' },
      output_id: { type: 'string', description: 'Optional: id of a new view that receives the result; must not be open. Omitted = in place' },
    },
    required: ['view_id', 'operation'],
  },
  async handler(api, input) {
    const id = vid(input.view_id);
    const op = ROTATIONS[oneOf(input.operation, Object.keys(ROTATIONS), undefined, 'operation')];
    const outputId = input.output_id === undefined || input.output_id === null || input.output_id === '' ? null : vid(input.output_id, 'output_id');
    const r = await pjsrJson(api, `
      ${WINDOW_PJSR}
      ${COPY_WINDOW_PJSR}
      var src = mcpWindow(${q(id)}), img0 = src.mainView.image;
      var out = { view: ${q(id)}, operation: ${q(input.operation)}, before: [img0.width, img0.height], hadSolution: src.hasAstrometricSolution };
      var target = src;
      ${outputId ? `mcpRefuseOpen(${q(outputId)}, 'output_id');
      target = mcpCopyWindow(src, ${q(outputId)});` : ''}
      try {
        var P = new FastRotation;
        P.mode = FastRotation.${op.mode};
        if (P.noGUIMessages !== undefined) P.noGUIMessages = true;
        if (!P.executeOn(target.mainView)) throw new Error('FastRotation did not run on ' + target.mainView.id);
      } catch (e) {
        ${outputId ? 'target.forceClose();' : ''}
        throw e;
      }
      ${outputId ? 'target.show();' : ''}
      var img = target.mainView.image;
      out.result = target.mainView.id; out.after = [img.width, img.height]; out.hasSolution = target.hasAstrometricSolution;
      JSON.stringify(out);
    `, 'rotate_image');
    const [W, H] = r.before;
    const solution = r.hadSolution ? (r.hasSolution ? ' It still has an astrometric solution.' : ' It has no astrometric solution now (the original had one).') : '';
    return {
      text: `${r.result === id ? `Rotated ${id} in place` : `Wrote ${r.result} from ${id}`} (${input.operation}): ${W}x${H} -> ${r.after[0]}x${r.after[1]}. ` +
        `A pixel (x, y) of the ${W}x${H} original is now at ${op.map(W, H)}.${solution}`,
    };
  },
};

export const tools = [viewHistory, getViewInfo, closeImages, rotateImage];
