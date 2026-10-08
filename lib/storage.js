'use strict';
// Disk use of the data folder (config, history, icon cache ...), for the Settings "Storage" card.

const fsp = require('fs').promises;
const path = require('path');
const { DATA_DIR } = require('./env');

// File name -> label; `clear` = the Settings action that can empty it.
const KNOWN = {
  'config.json': { name: 'Dashboard config' },
  'remotes.json': { name: 'Remote dashboards and share token' },
  'tunables.json': { name: 'Timing and limit settings' },
  'serverinfo.json': { name: 'Server info settings' },
  'session.key': { name: 'Login session key' },
  'clipboard.json': { name: 'Shared clipboard history', clear: 'clip' },
  'availability.json': { name: 'Outage history', clear: 'availability' },
  icons: { name: 'Icon cache', clear: 'icons' },
};

/** Size of a file, or of a folder's files (the icon cache is flat). */
async function sizeOf(full) {
  const stat = await fsp.stat(full);
  if (!stat.isDirectory()) return { bytes: stat.size, files: 1 };
  let bytes = 0;
  let files = 0;
  for (const entry of await fsp.readdir(full, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    bytes += await fsp.stat(path.join(full, entry.name)).then((s) => s.size, () => 0);
    files++;
  }
  return { bytes, files };
}

async function getStorage() {
  let names = [];
  try {
    names = await fsp.readdir(DATA_DIR);
  } catch {
    /* no data folder yet */
  }
  const items = [];
  for (const file of names) {
    try {
      const { bytes, files } = await sizeOf(path.join(DATA_DIR, file));
      const known = KNOWN[file] || {};
      items.push({ file, name: known.name || file, bytes, files, clear: known.clear || '' });
    } catch {
      /* removed meanwhile */
    }
  }
  items.sort((a, b) => b.bytes - a.bytes);
  return { total: items.reduce((sum, i) => sum + i.bytes, 0), items };
}

module.exports = { getStorage };
