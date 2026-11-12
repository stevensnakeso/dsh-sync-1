import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { SyncEngine } from '../lib/engine.js';

const CHUNK = 2 * 1024 * 1024;

function makeEngine() {
  const root = path.join(os.tmpdir(), `dsh-sync-download-${process.pid}-${Math.random().toString(16).slice(2)}`);
  const engine = new SyncEngine({ dshHome: root, profileDir: path.join(root, 'profile'), profileName: 'desktop' });
  return { root, engine };
}

/** @param {Buffer} bytes @param {{ ignoreRange?: boolean, failAt?: number | null }} [options] */
function backendFor(bytes, options = {}) {
  const ranges = [];
  let failed = false;
  return {
    ranges,
    async head() {
      return { size: bytes.length };
    },
    async get(_key, request = {}) {
      const start = request.range?.start ?? 0;
      const end = Math.min(request.range?.end ?? bytes.length - 1, bytes.length - 1);
      ranges.push([start, end]);
      if (!failed && options.failAt !== undefined && options.failAt !== null && start === options.failAt) {
        failed = true;
        throw new Error('connection reset');
      }
      if (options.ignoreRange) return bytes;
      return bytes.subarray(start, end + 1);
    },
  };
}

test('resumes a partial download from the bytes already on disk', async (t) => {
  const { root, engine } = makeEngine();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const bytes = Buffer.alloc(CHUNK * 2 + 1234);
  for (let index = 0; index < bytes.length; index += 1) bytes[index] = index % 251;

  const key = 'snapshots/example.dshsync';
  const cacheId = createHash('sha256').update(key).digest('hex').slice(0, 24);
  const tmp = path.join(root, 'dsh-sync', 'tmp');
  await fs.mkdir(tmp, { recursive: true });
  await fs.writeFile(path.join(tmp, `${cacheId}.part`), bytes.subarray(0, CHUNK));
  await fs.writeFile(path.join(tmp, `${cacheId}.meta.json`), JSON.stringify({ key, total: bytes.length }));

  const backend = backendFor(bytes);
  const downloaded = await engine.downloadSnapshot(backend, key);
  assert.equal(downloaded.length, bytes.length);
  assert.ok(downloaded.equals(bytes));
  assert.equal(backend.ranges[0][0], CHUNK, 'first request starts at the resume offset');
  assert.ok(backend.ranges.length >= 2);
  assert.equal(engine.progress?.stage, 'verify');
  assert.equal(await fs.stat(path.join(tmp, `${cacheId}.part`)).catch(() => null), null, 'partial file is cleaned up');
});

test('retries a dropped chunk from its own offset instead of restarting', async (t) => {
  const { root, engine } = makeEngine();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const bytes = Buffer.alloc(CHUNK + 512, 7);
  const key = 'snapshots/drop.dshsync';
  const backend = backendFor(bytes, { failAt: CHUNK });
  const downloaded = await engine.downloadSnapshot(backend, key);
  assert.ok(downloaded.equals(bytes));
  assert.deepEqual(
    backend.ranges.map(([start]) => start),
    [0, CHUNK, CHUNK],
    'failed chunk is requested again at the same offset',
  );
});

test('falls back to a single request when the server ignores Range', async (t) => {
  const { root, engine } = makeEngine();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const bytes = Buffer.alloc(CHUNK * 2 + 100, 9);
  const key = 'snapshots/norange.dshsync';
  const backend = backendFor(bytes, { ignoreRange: true });
  const downloaded = await engine.downloadSnapshot(backend, key);
  assert.ok(downloaded.equals(bytes));
  assert.equal(backend.ranges.length, 1);
});
