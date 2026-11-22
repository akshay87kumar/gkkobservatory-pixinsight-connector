// Inputs that name a view a tool is about to create must get past the server's up-front check that
// named views are open (src/server.mjs missingViews), which only knows fixed argument names such as
// view_id. In 2.5.3-gkkobservatory.3, open_image's new name was an input called view_id, so the
// server refused every new name as "View not found" before the handler ran; a unit test that
// called the handler directly could not see it. These calls go through a real MCP client and server.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../src/server.mjs';
import { buildCoreCatalog } from '../src/tools/index.mjs';
import { createFakeBridge, apiFrom } from './fake-bridge.mjs';

async function connect(t, open) {
  const dir = mkdtempSync(path.join(tmpdir(), 'pixinsight-new-ids-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'M42.xisf');
  writeFileSync(file, '');
  const { ctx, emitted } = createFakeBridge({ replies: Array(8).fill(JSON.stringify({ id: 'x', size: '10x10', result: 'x', before: [10, 10], after: [10, 10], hadSolution: false, hasSolution: false, view: 'x' })) });
  ctx.listImages = async () => open.map((id) => ({ id, width: 10, height: 10, isColor: false }));
  const api = apiFrom(ctx, { workspace: { dir, scratchDir: path.join(dir, 'agentic', 'scratch'), outputDir: path.join(dir, 'output') } });
  const server = createServer({ catalog: await buildCoreCatalog(), api });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'new-ids', version: '0.0.0' }, { capabilities: {} });
  await Promise.all([server.connect(b), client.connect(a)]);
  t.after(async () => { await client.close(); await server.close(); });
  return { client, emitted, file };
}

const text = (r) => r.content.map((c) => c.text).join(' | ');

test('a new view name reaches the tool through the server: open_image, crop_image, rotate_image, view_history, clone_image', async (t) => {
  const { client, emitted, file } = await connect(t, ['L']);
  const calls = [
    ['open_image', { file_path: file, output_id: 'Ha_master' }],
    ['crop_image', { view_id: 'L', left: 2, output_id: 'L_crop' }],
    ['rotate_image', { view_id: 'L', operation: 'rotate_180', output_id: 'L_rot' }],
    ['view_history', { view_id: 'L', action: 'snapshot', index: 0, output_id: 'L_snap' }],
    ['clone_image', { source_id: 'L', clone_id: 'L_backup' }],
  ];
  for (const [name, args] of calls) {
    const before = emitted.length;
    const r = await client.callTool({ name, arguments: args });
    assert.doesNotMatch(text(r), /View not found/, `${name}: ${text(r)}`);
    assert.ok(emitted.length > before, `${name} sent its script to PixInsight`);
  }
});

test('a view that must already be open is still checked up front', async (t) => {
  const { client, emitted } = await connect(t, ['L']);
  const r = await client.callTool({ name: 'crop_image', arguments: { view_id: 'Nope', left: 2 } });
  assert.equal(r.isError, true);
  assert.match(text(r), /View not found: view_id="Nope"/);
  assert.equal(emitted.length, 0);
});
