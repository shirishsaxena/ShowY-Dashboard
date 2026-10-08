'use strict';
// Shared clipboard: recent pieces of text (or links) to pass between devices, newest first, kept in the data dir.
// File: { max, entries: [{ id, text, createdAt }] }. The old single-entry format { text, updatedAt } is migrated on read.
// `text` / `updatedAt` in the API result are the newest entry, so the original one-item workflow keeps working.

const fsp = require('fs').promises;
const crypto = require('crypto');
const { CLIP_FILE } = require('./env');
const { writeAtomic } = require('./config');
const { badRequest } = require('./http');

const MAX_CHARS = 10_000;
const MAX_OPTIONS = [5, 10, 25, 50];
const DEFAULT_MAX = 10;

let cache = null; // parsed file; this process is the only writer, so polls never touch the disk
let queue = Promise.resolve(); // read-modify-write steps run one at a time

function normalize(raw) {
  const max = MAX_OPTIONS.includes(raw?.max) ? raw.max : DEFAULT_MAX;
  let entries = [];
  if (Array.isArray(raw?.entries)) {
    entries = raw.entries
      .filter((e) => e && typeof e.text === 'string' && e.text.trim())
      .map((e) => ({ id: String(e.id || crypto.randomBytes(6).toString('hex')), text: e.text.slice(0, MAX_CHARS), createdAt: Number(e.createdAt) || 0 }));
  } else if (typeof raw?.text === 'string' && raw.text.trim()) {
    entries = [{ id: crypto.randomBytes(6).toString('hex'), text: raw.text.slice(0, MAX_CHARS), createdAt: Number(raw.updatedAt) || Date.now() }];
  }
  entries.sort((a, b) => b.createdAt - a.createdAt);
  return { max, entries: entries.slice(0, max) };
}

async function load() {
  if (!cache) {
    try {
      cache = normalize(JSON.parse(await fsp.readFile(CLIP_FILE, 'utf8')));
    } catch {
      cache = normalize(null);
    }
  }
  return cache;
}

const view = (data) => ({
  text: data.entries[0]?.text || '',
  updatedAt: data.entries[0]?.createdAt || 0,
  entries: data.entries,
  max: data.max,
  maxOptions: MAX_OPTIONS,
  maxChars: MAX_CHARS,
});

/** Runs one change (fn gets the data and returns true when it changed something) and saves only if it did. */
function update(fn) {
  const run = queue.then(async () => {
    const data = await load();
    if (fn(data)) await writeAtomic(CLIP_FILE, JSON.stringify(data));
    return view(data);
  });
  queue = run.catch(() => {});
  return run;
}

async function readClip() {
  return view(await load());
}

/** Adds a new entry. Empty text is ignored, and so is a repeat of the newest entry. */
function writeClip(input) {
  const text = typeof input?.text === 'string' ? input.text : '';
  if (text.length > MAX_CHARS) throw badRequest(`Too long - at most ${MAX_CHARS.toLocaleString('en-US')} characters`);
  return update((data) => {
    if (!text.trim() || data.entries[0]?.text === text) return false;
    const createdAt = Math.max(Date.now(), (data.entries[0]?.createdAt || 0) + 1); // strictly newer, so the "new" dot always fires
    data.entries.unshift({ id: crypto.randomBytes(6).toString('hex'), text, createdAt });
    data.entries.length = Math.min(data.entries.length, data.max); // drops the oldest
    return true;
  });
}

function deleteEntry(input) {
  const id = typeof input?.id === 'string' ? input.id : '';
  return update((data) => {
    const before = data.entries.length;
    data.entries = data.entries.filter((e) => e.id !== id);
    return data.entries.length !== before;
  });
}

function clearClip() {
  return update((data) => {
    if (!data.entries.length) return false;
    data.entries = [];
    return true;
  });
}

function saveClipSettings(input) {
  const max = Number(input?.max);
  if (!MAX_OPTIONS.includes(max)) throw badRequest(`Maximum entries must be one of ${MAX_OPTIONS.join(', ')}`);
  return update((data) => {
    if (data.max === max) return false;
    data.max = max;
    data.entries.length = Math.min(data.entries.length, max); // a lower limit drops the oldest right away
    return true;
  });
}

module.exports = { readClip, writeClip, deleteEntry, clearClip, saveClipSettings };
