// ============================================================================
// Image lifecycle: open, close, list, rename, clone/restore, crop, dimensions,
// stats, export. Ported from v0-pipeline:agents/llm/tools.mjs and v0-pipeline:agents/llm/tools-essential.mjs.
// ============================================================================
import fs from 'node:fs';
import path from 'node:path';
import { toPixPath } from '../platform.mjs';
import { isInside, realPathOf } from '../workspace.mjs';
import { clampFractions } from './compare.mjs';
import { vid } from './pjsr-args.mjs';
import { COPY_WINDOW_PJSR, SAFE_CLOSE_PJSR } from './views.mjs';

const q = (s) => JSON.stringify(String(s));

// A number interpolated bare into PJSR cannot be quoted like a string, so its actual runtime
// type is validated instead of trusted from the JSON Schema alone.
function num(value, fallback) {
  const v = value === undefined ? fallback : value;
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    throw new Error(`expected a finite number, got ${JSON.stringify(v)}`);
  }
  return v;
}

// Native PixInsight processes throw odd values under V8; rethrow a real Error with a message.
function guard(body) {
  return `(function(){ try {
  function __run(P, v) { if (!P.executeOn(v)) throw new Error('the process did not run (see console message)'); }
  ${body}
} catch (e) { throw new Error(e && e.message ? e.message : String(e)); } })()`;
}

function need(id) {
  return `var __w = ImageWindow.windowById(${q(id)}); if (__w.isNull) throw new Error('View not found: ' + ${q(id)});`;
}

async function run(api, body) {
  const r = await api.pjsr(guard(body));
  if (r.status === 'error') throw new Error(r.error?.message || JSON.stringify(r.error));
  return r.result;
}

const IMAGE_FILE_RE = /\.(xisf|fits?|fts|tiff?|png|jpe?g)$/i;

// Checked here rather than in PixInsight, so a wrong path is answered with what the folder does hold
// and never reaches the Process Console as a script error.
function missingImageFile(file) {
  if (typeof file !== 'string' || !path.isAbsolute(file)) return `file_path must be an absolute path: ${JSON.stringify(file)}`;
  if (fs.existsSync(file)) return null;
  const dir = path.dirname(file);
  let names = [];
  try {
    names = fs.readdirSync(dir).filter((n) => IMAGE_FILE_RE.test(n)).sort();
  } catch {
    return `File not found: ${file} (the folder ${dir} does not exist or cannot be read)`;
  }
  if (!names.length) return `File not found: ${file} (no image files in ${dir})`;
  const shown = names.slice(0, 40).join(', ') + (names.length > 40 ? `, and ${names.length - 40} more` : '');
  return `File not found: ${file}. Image files in ${dir}: ${shown}`;
}

const openImage = {
  name: 'open_image',
  description: 'Open an XISF/FITS image file in PixInsight. Returns the view ID: output_id when given (refused if a view of that id is open), otherwise the one PixInsight assigned. Automatically closes any crop_mask windows that come with XISF files.',
  inputSchema: {
    type: 'object',
    properties: {
      file_path: { type: 'string', description: 'Absolute path to the image file' },
      output_id: { type: 'string', description: 'Optional: id to give the opened view; must not be open' },
    },
    required: ['file_path'],
  },
  async handler(api, input) {
    const missing = missingImageFile(input.file_path);
    if (missing) return { isError: true, text: missing };
    const wantedId = input.output_id === undefined || input.output_id === null || input.output_id === '' ? null : vid(input.output_id, 'output_id');
    const beforeIds = (await api.listImages()).map((i) => i.id);
    const r = await api.pjsr(`
      var __p = ${q(toPixPath(input.file_path))};
      if (!File.exists(__p)) throw new Error('File not found: ' + __p);
      ${wantedId ? `if (!ImageWindow.windowById(${q(wantedId)}).isNull) throw new Error('output_id ' + ${q(wantedId)} + ' is already open; name a view that is not.');` : ''}
      var __wins = ImageWindow.open(__p);
      if (__wins.length === 0) throw new Error('Failed to open image: ' + __p);
      ${wantedId ? `__wins[0].mainView.id = ${q(wantedId)};` : ''}
      __wins[0].show();
      __wins[0].mainView.id;
    `);
    if (r.status === 'error') return { isError: true, text: `Failed to open: ${r.error?.message ?? JSON.stringify(r.error)}` };
    // The id ImageWindow.open gave the image, as the snippet returned it -- not a guess from
    // whatever else appeared meanwhile.
    const openedId = String(r.result ?? '').trim();
    // Close the crop masks this file brought along, and only those: a crop_mask view the user
    // already had open is not ours to close.
    const imgs = await api.listImages();
    for (const cm of imgs.filter((i) => !beforeIds.includes(i.id) && i.id.includes('crop_mask'))) {
      await run(api, `var w=ImageWindow.windowById(${q(cm.id)});if(!w.isNull)w.forceClose();`);
    }
    const after = await api.listImages();
    const summary = after.map((i) => `${i.id}: ${i.width}x${i.height} color=${i.isColor}`).join('\n');
    if (!openedId) return { isError: true, text: `Opened ${input.file_path}, but PixInsight reported no view id.\nCurrent images:\n${summary}` };
    return { text: `Opened as view id "${openedId}".\nCurrent images:\n${summary}` };
  },
};

const closeImage = {
  name: 'close_image',
  description: 'Close an image window to free memory, discarding unsaved changes. A window that other windows use as a mask is removed as their mask before it closes.',
  inputSchema: {
    type: 'object',
    properties: { view_id: { type: 'string', description: 'View ID to close' } },
    required: ['view_id'],
  },
  async handler(api, input) {
    await run(api, `${SAFE_CLOSE_PJSR} var w = ImageWindow.windowById(${q(input.view_id)}); if (!w.isNull) mcpSafeClose(w);`);
    return { text: `Closed ${input.view_id}` };
  },
};

const listOpenImages = {
  name: 'list_open_images',
  description: 'List all currently open images in PixInsight with their dimensions and color status.',
  inputSchema: { type: 'object', properties: {} },
  async handler(api, _input) {
    const imgs = await api.listImages();
    return { text: JSON.stringify(imgs) };
  },
};

const renameView = {
  name: 'rename_view',
  description: 'Rename an image view to a different view ID. Long XISF names can cause some PixInsight processes to fail.',
  inputSchema: {
    type: 'object',
    properties: {
      old_id: { type: 'string', description: 'Current view ID' },
      new_id: { type: 'string', description: 'New view ID (no spaces)' },
    },
    required: ['old_id', 'new_id'],
  },
  async handler(api, input) {
    const newId = vid(input.new_id, 'new_id');
    // PixInsight gives a view a suffixed id when the one asked for is taken, so a taken id is refused
    // (renaming never closes another view) and the result reports the id the view has afterwards.
    const r = await api.pjsr(`
      var w = ImageWindow.windowById(${q(input.old_id)});
      if (w.isNull) throw new Error('View not found: ' + ${q(input.old_id)});
      if (${q(newId)} !== ${q(input.old_id)} && !ImageWindow.windowById(${q(newId)}).isNull) throw new Error('new_id ' + ${q(newId)} + ' is already open; close it or name another view. ' + ${q(input.old_id)} + ' was not renamed.');
      w.mainView.id = ${q(newId)};
      w.mainView.id;`);
    if (r.status === 'error') throw new Error(r.error?.message || JSON.stringify(r.error));
    const got = String(r.result ?? newId).trim() || newId;
    return { text: `Renamed ${input.old_id} → ${got}` };
  },
};

const cloneImage = {
  name: 'clone_image',
  description: 'Clone an image to a backup view, which can be restored from later with restore_from_clone. The clone keeps the image\'s FITS keywords, astrometric solution and view properties. A view already named clone_id is closed and replaced (the result says so); clone_id may not be the source itself.',
  inputSchema: {
    type: 'object',
    properties: {
      source_id: { type: 'string', description: 'Source view ID' },
      clone_id: { type: 'string', description: 'Name for the clone' },
    },
    required: ['source_id', 'clone_id'],
  },
  async handler(api, input) {
    const cloneId = vid(input.clone_id, 'clone_id');
    if (cloneId === input.source_id) throw new Error(`clone_image: clone_id is the source view ${input.source_id}; name another view. Nothing was changed.`);
    const dimR = await api.pjsr(`
      var srcW = ImageWindow.windowById(${q(input.source_id)});
      if (srcW.isNull) throw new Error('Clone source not found: ' + ${q(input.source_id)});
      var img = srcW.mainView.image;
      JSON.stringify({ w: img.width, h: img.height, ch: img.numberOfChannels, color: img.isColor });
    `);
    if (dimR.status === 'error') throw new Error('clone_image: ' + dimR.error.message);
    const d = JSON.parse(dimR.outputs?.consoleOutput?.trim() || '{}');
    const r = await api.pjsr(`
      ${SAFE_CLOSE_PJSR}
      var old = ImageWindow.windowById(${q(cloneId)}), __replaced = !old.isNull;
      if (__replaced) mcpSafeClose(old);
      var srcW = ImageWindow.windowById(${q(input.source_id)});
      var clone = new ImageWindow(${d.w || 0}, ${d.h || 0}, ${d.ch || 3}, 32, true, ${d.color !== false}, ${q(input.clone_id)});
      clone.mainView.beginProcess();
      clone.mainView.image.assign(srcW.mainView.image);
      clone.mainView.endProcess();
      // A clone is a new window: carry over what describes the image, not just the pixels.
      clone.keywords = srcW.keywords;
      if (srcW.hasAstrometricSolution) clone.copyAstrometricSolution(srcW);
      var props = srcW.mainView.properties;
      for (var i = 0; i < props.length; ++i) {
        try {
          clone.mainView.setPropertyValue(props[i], srcW.mainView.propertyValue(props[i]));
          clone.mainView.setPropertyAttributes(props[i], srcW.mainView.propertyAttributes(props[i]));
        } catch (e) {}
      }
      clone.hide();
      __replaced ? 'replaced' : 'OK';
    `);
    if (r.status === 'error') throw new Error('clone_image: ' + r.error.message);
    const replaced = String(r.result ?? r.outputs?.consoleOutput ?? '').trim() === 'replaced';
    return { text: `Cloned ${input.source_id} → ${input.clone_id}${replaced ? ` (the view previously named ${input.clone_id} was closed and replaced)` : ''}` };
  },
};

const restoreFromClone = {
  name: 'restore_from_clone',
  description: 'Restore an image\'s pixels from a backup clone, replacing the pixel changes made since the clone was made. Its FITS keywords, astrometric solution and view properties stay as they are now.',
  inputSchema: {
    type: 'object',
    properties: {
      target_id: { type: 'string', description: 'Target view ID to overwrite' },
      clone_id: { type: 'string', description: 'Clone view ID to restore from' },
    },
    required: ['target_id', 'clone_id'],
  },
  async handler(api, input) {
    const r = await api.pjsr(`
      var srcW = ImageWindow.windowById(${q(input.target_id)});
      var clone = ImageWindow.windowById(${q(input.clone_id)});
      if (srcW.isNull) throw new Error('Restore target not found: ' + ${q(input.target_id)});
      if (clone.isNull) throw new Error('Clone not found: ' + ${q(input.clone_id)});
      srcW.mainView.beginProcess();
      srcW.mainView.image.assign(clone.mainView.image);
      srcW.mainView.endProcess();
      'OK';
    `);
    if (r.status === 'error') throw new Error('restore_from_clone: ' + r.error.message);
    return { text: `Restored ${input.target_id} from ${input.clone_id}` };
  },
};

const cropImage = {
  name: 'crop_image',
  description: 'Crop pixels off the edges of an image, in place, or into a new view output_id (a copy with the FITS keywords, astrometric solution and view properties, cropped; the source unchanged). Amounts are pixels to remove from each side. All four amounts 0 (or omitted) runs nothing and leaves the image, and its astrometric solution, unchanged. Crop runs with noGUIMessages, so PixInsight writes its warnings to the Process Console instead of opening a confirmation dialog. A crop deletes the image\'s astrometric solution (PixInsight behaviour); the result says when one was removed.',
  inputSchema: {
    type: 'object',
    properties: {
      view_id: { type: 'string', description: 'View ID to crop' },
      left: { type: 'number', description: 'Pixels to remove from the left edge' },
      top: { type: 'number', description: 'Pixels to remove from the top edge' },
      right: { type: 'number', description: 'Pixels to remove from the right edge' },
      bottom: { type: 'number', description: 'Pixels to remove from the bottom edge' },
      output_id: { type: 'string', description: 'Optional: id of a new view that receives the cropped copy; must not be open. Omitted = in place' },
    },
    required: ['view_id'],
  },
  async handler(api, input) {
    const m = { left: num(input.left, 0), top: num(input.top, 0), right: num(input.right, 0), bottom: num(input.bottom, 0) };
    const outputId = input.output_id === undefined || input.output_id === null || input.output_id === '' ? null : vid(input.output_id, 'output_id');
    if (m.left === 0 && m.top === 0 && m.right === 0 && m.bottom === 0) {
      const size = await run(api, `${need(input.view_id)}
        var im = __w.mainView.image;
        return im.width + 'x' + im.height;`);
      return { text: `Nothing cropped from ${input.view_id}: all margins are 0, so no process ran${outputId ? ` and no view ${outputId} was made` : ''}. Size: ${size}` };
    }
    const raw = await run(api, `${need(input.view_id)}
      ${COPY_WINDOW_PJSR}
      var hadSol = __w.hasAstrometricSolution;
      var __t = __w;
      ${outputId ? `if (!ImageWindow.windowById(${q(outputId)}).isNull) throw new Error('output_id ' + ${q(outputId)} + ' is already open; name a view that is not.');
      __t = mcpCopyWindow(__w, ${q(outputId)});` : ''}
      var P = new Crop;
      P.mode = Crop.AbsolutePixels;
      P.leftMargin = ${-m.left}; P.topMargin = ${-m.top}; P.rightMargin = ${-m.right}; P.bottomMargin = ${-m.bottom};
      if (P.noGUIMessages !== undefined) P.noGUIMessages = true;
      ${outputId ? 'try { __run(P, __t.mainView); } catch (e) { __t.forceClose(); throw e; } __t.show();' : '__run(P, __w.mainView);'}
      var im = __t.mainView.image;
      return JSON.stringify({ id: __t.mainView.id, size: im.width + 'x' + im.height, hadSol: hadSol, hasSol: __t.hasAstrometricSolution });`);
    let out;
    try { out = JSON.parse(String(raw)); } catch { out = { size: String(raw ?? '') }; }
    const sol = out.hadSol && !out.hasSol ? ` The crop removed the astrometric solution: ${outputId ? 'the new view' : 'the image'} has none now.` : '';
    return { text: `${outputId ? `Cropped a copy of ${input.view_id} into ${outputId}` : `Cropped ${input.view_id}`}. New size: ${out.size}.${sol}` };
  },
};

const getImageDimensions = {
  name: 'get_image_dimensions',
  description: 'Get dimensions, channel count, and color status for one or more views. Every channel must have identical dimensions before ChannelCombination.',
  inputSchema: {
    type: 'object',
    properties: { view_ids: { type: 'array', items: { type: 'string' }, description: 'View IDs to check' } },
    required: ['view_ids'],
  },
  async handler(api, input) {
    const ids = input.view_ids.map((id) => q(id)).join(',');
    const r = await api.pjsr(`
      var ids = [${ids}];
      var res = [];
      for (var i = 0; i < ids.length; i++) {
        var w = ImageWindow.windowById(ids[i]);
        if (!w.isNull) {
          var img = w.mainView.image;
          res.push({ id: ids[i], width: img.width, height: img.height, channels: img.numberOfChannels, isColor: img.isColor });
        } else {
          res.push({ id: ids[i], error: 'not found' });
        }
      }
      JSON.stringify(res);
    `);
    if (r.status === 'error') throw new Error(r.error?.message || JSON.stringify(r.error));
    return { text: r.outputs?.consoleOutput || '[]' };
  },
};

const getImageStats = {
  name: 'get_image_stats',
  description: 'Get image statistics: median, MAD, min, max, per-channel medians, and per channel the fraction of samples at exactly 0 and at exactly 1 (clampFractions).',
  inputSchema: {
    type: 'object',
    properties: { view_id: { type: 'string', description: 'PixInsight view ID' } },
    required: ['view_id'],
  },
  async handler(api, input) {
    const stats = await api.stats(input.view_id);
    stats.clampFractions = await clampFractions(api, input.view_id);
    return { text: JSON.stringify(stats) };
  },
};

// resolveExportPath(filePath, { outputDir, stateDir }, platform, { realpathSync }?) -> { path } | { error }
//
// export_image is the one core tool that writes where the caller says, so it is held to the two
// folders a session writes to: a relative file_path is resolved under outputDir, and the resolved
// path must lie inside outputDir or stateDir after following links (the real path of its deepest
// existing folder), so a link inside output/ cannot lead out of them. Every
// other core tool writes under scratchDir.
export function resolveExportPath(filePath, { outputDir, stateDir }, platform = process.platform, { realpathSync } = {}) {
  const p = platform === 'win32' ? path.win32 : path.posix;
  const target = p.resolve(outputDir, filePath);
  const refuse = (where) => ({ error: `file_path must be inside ${outputDir} or ${stateDir} (a relative path is resolved under ${outputDir}); "${filePath}" ${where}.` });
  // The real paths decide (they are resolved too, so `..` cannot climb out either); where nothing
  // resolves, realPathOf returns the path as resolved and this is the lexical check.
  const real = (x) => realPathOf(x, { platform, ...(realpathSync ? { realpathSync } : {}) });
  const realTarget = real(target);
  if (isInside(realTarget, real(outputDir), platform) || isInside(realTarget, real(stateDir), platform)) return { path: target };
  const lexicallyInside = isInside(target, outputDir, platform) || isInside(target, stateDir, platform);
  return refuse(lexicallyInside ? `leads to ${realTarget} through a link` : `resolves to ${target}`);
}

const exportImage = {
  name: 'export_image',
  description: 'Write an image to a file in the workspace\'s output or state folder. A relative file_path is resolved under <workspace>/output; an absolute one must lie inside <workspace>/output or the state folder (<workspace>/agentic by default), and a path anywhere else is refused. Format comes from the extension: .tif/.tiff, .png, .jpg/.jpeg, .webp, .xisf, .fits. TIFF and PNG default to 16-bit, JPEG and WebP are 8-bit; use 32 for float. quality sets JPEG and WebP compression; max_size scales the written copy down with Resample so its longest edge is at most that many pixels. The file keeps the image\'s FITS keywords, astrometric solution and view properties (formats that cannot store them drop them; on a scaled copy, the solution is whatever Resample leaves, and the result says which); an XISF file also keeps the view\'s id, so it opens under that name. The working image is not changed. Missing parent folders are created.',
  inputSchema: {
    type: 'object',
    properties: {
      view_id: { type: 'string', description: 'View ID to export' },
      file_path: { type: 'string', description: 'Output file path: relative to <workspace>/output, or absolute inside <workspace>/output or the state folder' },
      bits: { type: 'number', enum: [8, 16, 32], description: 'Sample depth for tif/png/xisf/fits (default 16 for tif/png, 32 otherwise)' },
      quality: { type: 'number', description: 'JPEG or WebP quality, a whole number from 1 to 100, passed to PixInsight as the "quality" format hint. Omitted: PixInsight\'s own default. Refused for other formats.' },
      max_size: { type: 'number', description: 'Longest edge of the written image in pixels, a whole number of at least 16. A larger image is scaled down to it with Resample (aspect ratio kept, Resample\'s default interpolation) in the copy that is written; a smaller one is written at its own size.' },
    },
    required: ['view_id', 'file_path'],
  },
  async handler(api, input) {
    const ext = path.extname(String(input.file_path)).toLowerCase();
    if (!['.tif', '.tiff', '.png', '.jpg', '.jpeg', '.webp', '.xisf', '.fits', '.fit'].includes(ext)) {
      return { isError: true, text: `Unsupported extension "${ext}".` };
    }
    const eightBitFormat = ['.jpg', '.jpeg', '.webp'].includes(ext);
    const defaultBits = eightBitFormat ? 8 : ['.tif', '.tiff', '.png'].includes(ext) ? 16 : 32;
    const bits = input.bits ?? defaultBits;
    const conv = { 8: 'SampleFormatConversion.To8Bit', 16: 'SampleFormatConversion.To16Bit', 32: null }[bits];
    if (conv === undefined) return { isError: true, text: 'bits must be 8, 16 or 32.' };
    const quality = input.quality;
    if (quality !== undefined) {
      if (!eightBitFormat) return { isError: true, text: `quality applies to .jpg, .jpeg and .webp files, not ${ext}. Nothing was written.` };
      if (!Number.isInteger(quality) || quality < 1 || quality > 100) return { isError: true, text: `quality must be a whole number from 1 to 100; got ${JSON.stringify(quality)}. Nothing was written.` };
    }
    const maxSize = input.max_size;
    if (maxSize !== undefined && (!Number.isInteger(maxSize) || maxSize < 16)) {
      return { isError: true, text: `max_size must be a whole number of pixels, at least 16; got ${JSON.stringify(maxSize)}. Nothing was written.` };
    }
    // The state folder is scratchDir's parent (src/workspace.mjs's workspacePaths).
    const outputDir = api.workspace.outputDir;
    const resolved = resolveExportPath(String(input.file_path), { outputDir, stateDir: path.dirname(api.workspace.scratchDir) });
    if (resolved.error) return { isError: true, text: resolved.error };
    const file = resolved.path;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    // Checked again now that the parent exists: a link created in the meantime cannot lead out.
    const again = resolveExportPath(file, { outputDir, stateDir: path.dirname(api.workspace.scratchDir) });
    if (again.error) return { isError: true, text: again.error };
    const out = await run(api, `${need(input.view_id)}
      var src = __w.mainView.image;
      // An XISF file stores the id of the view it was saved from, and the copy saved here is a new
      // window. The copy takes the source view's id, so that the file opens later under the name of
      // the view it came from: the source is renamed while the copy exists, and renamed back whatever
      // happens.
      var srcId = __w.mainView.id;
      var parkedId = '__mcp_export_source';
      for (var n = 1; !ImageWindow.windowById(parkedId).isNull; ++n) parkedId = '__mcp_export_source' + n;
      __w.mainView.id = parkedId;
      var c = null;
      try {
        c = new ImageWindow(src.width, src.height, src.numberOfChannels, 32, true, src.isColor, srcId);
        c.mainView.beginProcess(); c.mainView.image.assign(src); c.mainView.endProcess();
        // The copy is a new window: carry over what the file should describe, not just the pixels.
        c.keywords = __w.keywords;
        if (__w.hasAstrometricSolution) c.copyAstrometricSolution(__w);
        var props = __w.mainView.properties;
        for (var i = 0; i < props.length; ++i) {
          try {
            c.mainView.setPropertyValue(props[i], __w.mainView.propertyValue(props[i]));
            c.mainView.setPropertyAttributes(props[i], __w.mainView.propertyAttributes(props[i]));
          } catch (e) {}
        }
        var W0 = src.width, H0 = src.height, scaled = false, hadSol = c.hasAstrometricSolution;
        ${maxSize === undefined ? '' : `
        // Scaled in the copy, in 32-bit float, before any conversion to the file's sample depth.
        if (Math.max(W0, H0) > ${maxSize}) {
          var R = new Resample;
          R.mode = Resample.AbsolutePixels; R.absoluteMode = Resample.ForceWidthAndHeight;
          R.xSize = Math.max(1, Math.round(W0 * ${maxSize} / Math.max(W0, H0)));
          R.ySize = Math.max(1, Math.round(H0 * ${maxSize} / Math.max(W0, H0)));
          // Routes Resample's question about the astrometric solution to the console instead of a dialog.
          if (R.noGUIMessages !== undefined) R.noGUIMessages = true;
          if (!R.executeOn(c.mainView)) throw new Error('Resample did not run (see console message)');
          scaled = true;
        }`}
        ${conv ? `var S = new SampleFormatConversion; S.format = ${conv}; S.executeOn(c.mainView);` : ''}
        var W1 = c.mainView.image.width, H1 = c.mainView.image.height, keptSol = c.hasAstrometricSolution;
        if (File.exists(${q(toPixPath(file))})) File.remove(${q(toPixPath(file))});
        if (!c.saveAs(${q(toPixPath(file))}, false, false, false, false${quality === undefined ? '' : `, ${q(`quality ${quality}`)}`})) throw new Error('PixInsight did not write ' + ${q(toPixPath(file))} + ' (saveAs returned false)');
      } finally {
        if (c !== null) c.forceClose();
        __w.mainView.id = srcId;
      }
      if (!File.exists(${q(toPixPath(file))})) throw new Error('File was not written');
      return JSON.stringify({ bytes: new FileInfo(${q(toPixPath(file))}).size, from: [W0, H0], size: [W1, H1], scaled: scaled, hadSol: hadSol, keptSol: keptSol });`);
    return { text: exportText(file, out, { bits: eightBitFormat ? 8 : bits, quality }) };
  },
};

// The result line of export_image. `out` is the PJSR's JSON ({ bytes, from, size, scaled, hadSol,
// keptSol }); a bare byte count is read as { bytes }.
function exportText(file, out, { bits, quality }) {
  let info = null;
  try { info = JSON.parse(String(out)); } catch { info = null; }
  if (typeof info === 'number') info = { bytes: info };
  info = info ?? {};
  const parts = [`${(Number(info.bytes) / 1048576).toFixed(1)} MB`, `${bits}-bit`];
  if (quality !== undefined) parts.push(`quality ${quality}`);
  if (Array.isArray(info.size)) parts.push(`${info.size[0]}x${info.size[1]}`);
  let text = `Wrote ${file} (${parts.join(', ')}).`;
  if (info.scaled && Array.isArray(info.from)) {
    text += ` Scaled down from ${info.from[0]}x${info.from[1]} in the written copy; the working image is unchanged.`;
    if (info.hadSol) text += info.keptSol ? ' The scaled copy kept an astrometric solution.' : ' Resample removed the astrometric solution from the scaled copy.';
  }
  return text;
}

// ensure_dir: create a folder (and its parents) inside the folders a session writes to, so a save
// from PJSR never meets a missing folder. PixInsight answers a save into a missing folder with a modal
// API-error box that no saveAs argument suppresses.
const ensureDir = {
  name: 'ensure_dir',
  description: 'Create a folder, with any missing parents, inside the workspace\'s output folder or state folder. A relative path is resolved under <workspace>/output; an absolute one must lie inside <workspace>/output or the state folder (<workspace>/agentic by default), and a path anywhere else is refused. An existing folder is left as it is. Returns the absolute path.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      path: { type: 'string', description: 'Folder path: relative to <workspace>/output, or absolute inside <workspace>/output or the state folder' },
    },
    required: ['path'],
  },
  async handler(api, input) {
    const outputDir = api.workspace.outputDir;
    const stateDir = path.dirname(api.workspace.scratchDir);
    const resolved = resolveExportPath(String(input.path), { outputDir, stateDir });
    if (resolved.error) return { isError: true, text: resolved.error.replace('file_path', 'path') };
    const existed = fs.existsSync(resolved.path);
    if (existed && !fs.statSync(resolved.path).isDirectory()) return { isError: true, text: `${resolved.path} exists and is not a folder.` };
    fs.mkdirSync(resolved.path, { recursive: true });
    // Checked again now that it exists: a link created in the meantime cannot lead out.
    const again = resolveExportPath(resolved.path, { outputDir, stateDir });
    if (again.error) return { isError: true, text: again.error.replace('file_path', 'path') };
    return { text: `${existed ? 'Folder exists' : 'Created'}: ${resolved.path}` };
  },
};

export const tools = [
  ensureDir,
  openImage,
  closeImage,
  listOpenImages,
  renameView,
  cloneImage,
  restoreFromClone,
  cropImage,
  getImageDimensions,
  getImageStats,
  exportImage,
];
