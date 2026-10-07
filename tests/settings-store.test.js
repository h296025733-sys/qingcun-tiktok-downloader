'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { JsonStore } = require('../src/lib/settings-store');

test('persists the selected directory and reads it on the next launch', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'qingcun-store-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, 'settings.json');

  const first = new JsonStore(filePath, { downloadDirectory: '' });
  first.set('downloadDirectory', 'D:\\视频');

  const second = new JsonStore(filePath, { downloadDirectory: '' });
  assert.equal(second.get('downloadDirectory'), 'D:\\视频');
});

test('falls back to defaults when the JSON file is invalid', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'qingcun-store-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, 'settings.json');
  fs.writeFileSync(filePath, '{invalid', 'utf8');

  const store = new JsonStore(filePath, { downloadDirectory: '', tasks: [] });
  assert.deepEqual(store.getAll(), { downloadDirectory: '', tasks: [] });
});
