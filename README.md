# gkkobservatory PixInsight Connector

The PixInsight MCP connector used at [gkkobservatory](https://www.gkkobservatory.in), the Dr. Gopal Krishna Kunwar
Observatory: urban astrophotography by Akshay Kumar from Bhagalpur, Bihar (Bortle 8). It lets an AI agent
(Claude Code, Codex, Cursor and others) operate [PixInsight](https://pixinsight.com) through about 80 tools.
It is [mxcoppell/pixinsight-connector](https://github.com/mxcoppell/pixinsight-connector) plus fixes found while
processing real data; [CHANGELOG.md](CHANGELOG.md) lists them and which are offered upstream.

Example: the [Seagull Nebula (IC 2177)](https://www.gkkobservatory.in/signals/seagull-nebula-ic-2177-runaway-star-bow-shock),
processed end to end through the connector.

## Tools

| Area | Examples |
|---|---|
| Images | `open_image`, `list_open_images`, `crop_image`, `clone_image`, `export_image` |
| Processes | `run_process` (any PixInsight process), `run_pixelmath`, `run_curves`, `describe_process` |
| Linear prep | `run_abe`, `run_mgc`, `run_gradient_correction`, `run_background_neutralization` |
| Colour and astrometry | `run_plate_solve`, `run_spcc`, `run_spfc`, `verify_astrometry`, `catalog_stars` |
| Detail and noise | `run_bxt`, `run_nxt`, `run_hdrmt`, `run_lhe`, `multi_scale_enhance` |
| Stretch and tone | `auto_stretch`, `robust_median_stretch`, `set_stf`, `continuous_clamp` |
| Channels and narrowband | `combine_channels`, `lrgb_combine`, `dynamic_narrowband_blend`, `extract_pseudo_oiii` |
| Stars and masks | `run_sxt`, `stretch_stars`, `star_protected_blend`, `create_luminance_mask`, `apply_mask` |
| Measurement | `get_image_stats`, `measure_stars`, `measure_sharpness`, `measure_uniformity`, `compare_images` |
| Preview and scripting | `save_and_show_preview`, `run_pjsr`, `job_status`, `cancel_job` |

All 80-odd, with parameters: [docs/tools.md](docs/tools.md).

## What it does

- **Operates PixInsight for an agent:** open and inspect images, run any process, build masks, stretch, combine
  channels, separate stars, plate solve, calibrate colour, measure, preview and export.
- **Starts itself:** PixInsight and a small watcher script launch on the first tool call; nothing to run by hand.
- **Leaves technique to you:** tools take every value as input and measurements return numbers. Which steps, in
  what order and how far, lives in your own skills and prompts.
- **Stays in your folder:** it writes only `agentic/` (working files, logs) and `output/` (results) inside the target folder.
- **Tested on real data:** used for gkkobservatory's own images on Windows 11 with PixInsight 1.9.5. Fixes found
  along the way are in this build; see [CHANGELOG.md](CHANGELOG.md).

## Install

Needs Node 22+ and PixInsight 1.9.5+.

```sh
npm install -g github:akshay87kumar/gkkobservatory-pixinsight-connector
claude mcp add -s user pixinsight -- pixinsight-connector
pixinsight-connector doctor
```

Update by running the install command again; `npm install -g pixinsight-connector` goes back to the upstream release
on npm. Other harnesses: [docs/setup.md](docs/setup.md).

## Docs

[Tools](docs/tools.md) · [Setup](docs/setup.md) · [Troubleshooting](docs/troubleshooting.md) · [Contributing](CONTRIBUTING.md)

<!-- crossplatform:start -->
## Cross-platform

macOS, Windows and Linux are all first-class, for running this connector and for developing it.
A change that works on one OS and breaks another is a bug, not a limitation.

- **No shell pipelines.** No `ps`, `grep`, `awk`, `wc`, `df` or `&&` in `src/` or in npm scripts.
  OS-specific behaviour goes behind `src/platform.mjs` (paths) or `src/process-probe.mjs` (process
  inspection), one implementation per OS.
- **No POSIX path literals.** Use `path.join`. Use forward slashes only when handing a path to
  PixInsight, which accepts them everywhere.
- **CI runs the full suite on Linux, macOS and Windows.** Green on one is not green.
- **Degrade, never fail.** If an OS cannot supply something optional — a memory reading, a process
  start time — carry on without it. Never report it as a crash.
- **Overrides always win:** `PIXINSIGHT_BIN` for the executable, `PIXINSIGHT_DIR` for the install root.

Tests need no PixInsight and no astronomy software, so you can develop on any of the three.
<!-- crossplatform:end -->

## Credit and license

Built on [mxcoppell/pixinsight-connector](https://github.com/mxcoppell/pixinsight-connector) by Min Xie, which began as
[aescaffre/pixinsight-mcp](https://github.com/aescaffre/pixinsight-mcp) by Alain Escaffre. MIT licensed: see [LICENSE](LICENSE).
Not affiliated with or endorsed by Pleiades Astrophoto; PixInsight® is a registered trademark of Pleiades Astrophoto S.L.
