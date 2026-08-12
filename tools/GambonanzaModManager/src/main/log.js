'use strict';

const fs = require('node:fs');
const path = require('node:path');

// A log the user can actually be pointed at. Everything the manager does to
// someone's game files - patch, restore, install, delete - lands here with a
// timestamp, because "it broke my game" support threads are unwinnable without
// one. Also mirrored into a ring buffer the UI shows under Settings → Activity.

const RING_SIZE = 400;
const MAX_BYTES = 2 * 1024 * 1024;

const ring = [];
const listeners = new Set();
let stream = null;
let logFile = null;

function init(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    logFile = path.join(dir, 'manager.log');
    // Roll once at 2 MB rather than growing forever. One generation of history
    // is plenty: anything older is not going to explain today's problem.
    try {
      if (fs.statSync(logFile).size > MAX_BYTES) {
        fs.renameSync(logFile, `${logFile}.1`);
      }
    } catch { /* no existing log */ }
    stream = fs.createWriteStream(logFile, { flags: 'a' });
    write('info', 'log', `--- session started (${new Date().toISOString()}) ---`);
  } catch (err) {
    console.error('could not open log file:', err.message);
  }
}

function write(level, scope, message, detail) {
  const entry = {
    at: new Date().toISOString(),
    level,
    scope,
    message: String(message ?? ''),
    detail: detail === undefined ? undefined : safeDetail(detail),
  };

  ring.push(entry);
  if (ring.length > RING_SIZE) ring.shift();

  const line = `${entry.at} ${level.toUpperCase().padEnd(5)} [${scope}] ${entry.message}${entry.detail ? ` :: ${entry.detail}` : ''}`;
  if (stream) stream.write(`${line}\n`);
  if (level === 'error') console.error(line);
  else if (process.env.GAMBONANZA_DEBUG) console.log(line);

  for (const fn of listeners) {
    try { fn(entry); } catch { /* a broken listener must not break logging */ }
  }
  return entry;
}

function safeDetail(detail) {
  if (typeof detail === 'string') return detail;
  if (detail instanceof Error) return detail.stack || detail.message;
  try { return JSON.stringify(detail); } catch { return String(detail); }
}

module.exports = {
  init,
  info: (scope, msg, detail) => write('info', scope, msg, detail),
  warn: (scope, msg, detail) => write('warn', scope, msg, detail),
  error: (scope, msg, detail) => write('error', scope, msg, detail),
  history: () => ring.slice(),
  onEntry: (fn) => { listeners.add(fn); return () => listeners.delete(fn); },
  file: () => logFile,
};
