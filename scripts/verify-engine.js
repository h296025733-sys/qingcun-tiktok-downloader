'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const enginePath = path.join(__dirname, '..', 'vendor', 'yt-dlp.exe');
const checksumPath = path.join(__dirname, '..', 'vendor', 'yt-dlp.sha256');

if (!fs.existsSync(enginePath)) throw new Error(`下载引擎不存在：${enginePath}`);

const expected = fs.readFileSync(checksumPath, 'utf8').trim().split(/\s+/)[0].toLowerCase();
const actual = crypto.createHash('sha256').update(fs.readFileSync(enginePath)).digest('hex');
if (actual !== expected) throw new Error(`yt-dlp.exe 校验失败。期望 ${expected}，实际 ${actual}`);

const result = spawnSync(enginePath, ['--version'], { encoding: 'utf8', windowsHide: true });
const version = String(result.stdout || '').trim().split(/\r?\n/)[0];
if (result.status !== 0 || version !== '2026.08.19') throw new Error(`yt-dlp.exe 版本异常：${version}`);

console.log(`yt-dlp.exe ${version}`);
console.log(`SHA256 ${actual}`);
