// ============================================================================
// PJSR for the tools that compute an image in script, pixel by pixel. Reading or writing one sample
// at a time costs one native call per sample: at real image sizes those tools took minutes (live,
// 93.6 MP RGB: create_adaptive_zone_masks 185 s, shell_detail_enhance with auto_zone 218 s) with
// PixInsight frozen, Pause/Abort unable to act, and the server warning about a possible dialog.
//
// These helpers move a whole row per native call (Image.getSamples / setSamples over a one-row Rect)
// into Float64Array buffers. A Float64Array holds exactly what Image.sample() returns (checked live
// on 32-bit float and 16-bit integer images), and setSamples rounds as setSample does, so the
// arithmetic and the results are unchanged. The loops call mcpRowDone() after each unit of work;
// every MCP_ROWS_PER_YIELD calls it yields with processEvents(): PixInsight repaints, the watcher's
// busy heartbeat is refreshed, and Pause/Abort and cancel_job can stop the script.
//
// A per-pixel loop must run inside a function, on that function's own variables and parameters. The
// watcher runs a snippet through eval, and the variables a snippet declares at its top level are
// looked up by name on every access: live, a loop over 6 MP took 1932 ms at the top of a snippet and
// 256 ms inside a function, with row reads and writes costing 9 ms and 5 ms of that.
//
// A helper module: it exports no `tools` array, so src/tools/index.mjs's scan passes over it.
// ============================================================================

export const PIXEL_ROWS = `
    var MCP_ROWS_PER_YIELD = 64;
    var mcpRowsSinceYield = 0;
    function mcpRowRect(img, y) { return new Rect(0, y, img.width, y + 1); }
    // Row y of channel c of img into buf (a Float64Array of img.width); returns buf.
    function mcpGetRow(img, y, c, buf) { img.getSamples(buf, mcpRowRect(img, y), c); return buf; }
    // buf into row y of channel c of img.
    function mcpSetRow(img, y, c, buf) { img.setSamples(buf, mcpRowRect(img, y), c); }
    // Buffers for mcpLumRow, each a Float64Array of width w.
    function mcpLumBuffers(w) { return { lum: new Float64Array(w), r: new Float64Array(w), g: new Float64Array(w), b: new Float64Array(w) }; }
    // The Rec.709 luminance 0.2126 R + 0.7152 G + 0.0722 B of row y of a colour image, or the row of a
    // mono one, into bufs.lum; returns bufs.lum.
    function mcpLumRow(img, y, bufs) {
      if (!img.isColor) return mcpGetRow(img, y, 0, bufs.lum);
      mcpGetRow(img, y, 0, bufs.r); mcpGetRow(img, y, 1, bufs.g); mcpGetRow(img, y, 2, bufs.b);
      var lum = bufs.lum, r = bufs.r, g = bufs.g, b = bufs.b;
      for (var x = 0; x < lum.length; ++x) lum[x] = 0.2126 * r[x] + 0.7152 * g[x] + 0.0722 * b[x];
      return lum;
    }
    // lumAt(x, y): the luminance mcpLumRow gives, computing each row once and keeping the most recent
    // \`capacity\` rows. For loops that read scattered pixels row by row; build a new one after the
    // image changes.
    function mcpLumCache(img, capacity) {
      var rows = {}, order = [], bufs = mcpLumBuffers(img.width);
      return function (x, y) {
        var row = rows[y];
        if (row === undefined) {
          if (order.length >= capacity) delete rows[order.shift()];
          row = new Float64Array(mcpLumRow(img, y, bufs));
          rows[y] = row;
          order.push(y);
        }
        return row[x];
      };
    }
    // Called after each row (or block of rows) of work: yields every MCP_ROWS_PER_YIELD calls.
    function mcpRowDone() {
      if (++mcpRowsSinceYield >= MCP_ROWS_PER_YIELD) { mcpRowsSinceYield = 0; processEvents(); }
    }
`;
