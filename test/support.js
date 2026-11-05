'use strict';
// Small helpers shared by the tests: a throwaway folder, a way to make files in it, and ways to wait for the server's background work.
const fs = require('fs');
const os = require('os');
const path = require('path');

/** A fresh temporary folder. Call `cleanup()` when the test is done with it. */
function tmp(prefix = 'flowdeck-test-') {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  return { dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

/** Write a file, making its folders first. */
function touch(file, data = 'x') {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, data);
  return file;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Wait until `check()` is truthy; fail the test (rather than hang) if it takes too long. */
async function until(check, { ms = 8000, every = 25 } = {}) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return;
    await sleep(every);
  }
  throw new Error('timed out waiting for the condition');
}

/** Wait for a library's scan to finish (a scan starts a moment after addRoot / scan are called). */
async function scanned(lib) {
  await sleep(30);
  await until(() => !lib.scanning);
}

module.exports = { tmp, touch, sleep, until, scanned };
