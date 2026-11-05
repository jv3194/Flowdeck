'use strict';
// The installer script, run for real against a small fake release. Every location it writes to (the install folder, the
// Start menu, the desktop, the registry entry) is redirected into temporary places, so the machine itself is untouched.
const test = require('node:test');
const assert = require('node:assert/strict');
const cp = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { tmp, touch, until, sleep } = require('../support.js');

const script = path.join(__dirname, '..', '..', 'packaging', 'Install-Flowdeck.ps1');
const windows = process.platform === 'win32';
const skip = windows ? false : 'the installer is for Windows';

const ps = (args) => cp.spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', ...args], { encoding: 'utf8', timeout: 120000 });
const psCommand = (command) => ps(['-Command', command]).stdout.trim();

/** An unzipped "release": the installer beside a Flowdeck folder holding a stand-in exe, the version file and the icon. */
function release(t, version = '9.9.9') {
  const dir = path.join(t.dir, 'release');
  fs.mkdirSync(dir, { recursive: true });
  fs.copyFileSync(script, path.join(dir, 'Install-Flowdeck.ps1'));
  touch(path.join(dir, 'Flowdeck', 'Flowdeck.exe'), 'not really an exe');
  touch(path.join(dir, 'Flowdeck', 'resources', 'app', 'package.json'), JSON.stringify({ version }));
  fs.mkdirSync(path.join(dir, 'Flowdeck', 'resources', 'app', 'assets'), { recursive: true });
  fs.copyFileSync(path.join(__dirname, '..', '..', 'assets', 'icon.ico'), path.join(dir, 'Flowdeck', 'resources', 'app', 'assets', 'icon.ico'));
  return dir;
}

function places(t) {
  return { prefix: path.join(t.dir, 'installed'), start: path.join(t.dir, 'startmenu'), desktop: path.join(t.dir, 'desktop'), userData: path.join(t.dir, 'appdata') };
}

const common = (p, extra = []) => ['-Prefix', p.prefix, '-StartMenuDir', p.start, '-DesktopDir', p.desktop, '-UserDataDir', p.userData, '-NoLaunch', ...extra];
const target = (lnk) => psCommand(`(New-Object -ComObject WScript.Shell).CreateShortcut('${lnk}').TargetPath`);

test('installing copies the app, adds Start-menu and desktop shortcuts that point at it, and keeps a copy of the uninstaller', { skip }, () => {
  const t = tmp();
  try {
    const rel = release(t);
    const p = places(t);
    const r = ps(['-File', path.join(rel, 'Install-Flowdeck.ps1'), ...common(p, ['-DesktopShortcut', '-NoRegistry'])]);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.ok(fs.existsSync(path.join(p.prefix, 'Flowdeck.exe')));
    assert.ok(fs.existsSync(path.join(p.prefix, 'resources', 'app', 'package.json')));
    assert.ok(fs.existsSync(path.join(p.prefix, 'Uninstall-Flowdeck.ps1')));
    assert.equal(target(path.join(p.start, 'Flowdeck.lnk')).toLowerCase(), path.join(p.prefix, 'Flowdeck.exe').toLowerCase());
    assert.ok(fs.existsSync(path.join(p.desktop, 'Flowdeck.lnk')));
    assert.match(r.stdout, /Installing Flowdeck 9\.9\.9/);
  } finally {
    t.cleanup();
  }
});

test('no desktop shortcut unless asked for', { skip }, () => {
  const t = tmp();
  try {
    const rel = release(t);
    const p = places(t);
    assert.equal(ps(['-File', path.join(rel, 'Install-Flowdeck.ps1'), ...common(p, ['-NoRegistry'])]).status, 0);
    assert.ok(fs.existsSync(path.join(p.start, 'Flowdeck.lnk')));
    assert.ok(!fs.existsSync(path.join(p.desktop, 'Flowdeck.lnk')));
  } finally {
    t.cleanup();
  }
});

test('installing over an older version upgrades it: files the new version no longer has are removed, and user data is left alone', { skip }, () => {
  const t = tmp();
  try {
    const rel = release(t, '2.0.0');
    const p = places(t);
    touch(path.join(p.prefix, 'old-file-from-1.0.txt'), 'stale');
    touch(path.join(p.prefix, 'resources', 'app', 'removed-module.js'), 'stale');
    touch(path.join(p.userData, 'data', 'library.json'), '{"keep":"me"}');
    const r = ps(['-File', path.join(rel, 'Install-Flowdeck.ps1'), ...common(p, ['-NoRegistry'])]);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.ok(!fs.existsSync(path.join(p.prefix, 'old-file-from-1.0.txt')));
    assert.ok(!fs.existsSync(path.join(p.prefix, 'resources', 'app', 'removed-module.js')));
    assert.equal(JSON.parse(fs.readFileSync(path.join(p.prefix, 'resources', 'app', 'package.json'), 'utf8')).version, '2.0.0');
    assert.equal(fs.readFileSync(path.join(p.userData, 'data', 'library.json'), 'utf8'), '{"keep":"me"}');
  } finally {
    t.cleanup();
  }
});

test('the Settings > Apps entry is written with the version, the location and a working uninstall command', { skip }, () => {
  const t = tmp();
  const key = `HKCU:\\Software\\FlowdeckInstallerTest-${process.pid}`;
  try {
    const rel = release(t, '3.1.4');
    const p = places(t);
    const r = ps(['-File', path.join(rel, 'Install-Flowdeck.ps1'), ...common(p), '-RegistryKey', key]);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const read = (name) => psCommand(`(Get-ItemProperty -Path '${key}').${name}`);
    assert.equal(read('DisplayName'), 'Flowdeck');
    assert.equal(read('DisplayVersion'), '3.1.4');
    assert.equal(read('InstallLocation').toLowerCase(), p.prefix.toLowerCase());
    const uninstall = read('UninstallString');
    assert.ok(uninstall.includes('Uninstall-Flowdeck.ps1') && uninstall.includes('-Uninstall'), uninstall);
    assert.ok(Number(read('EstimatedSize')) >= 0);
  } finally {
    ps(['-Command', `Remove-Item -Path '${key}' -Recurse -Force -ErrorAction SilentlyContinue`]);
    t.cleanup();
  }
});

test('uninstalling removes the app, the shortcuts and the registry entry, and keeps your library; -RemoveUserData removes that too', { skip }, async () => {
  const t = tmp();
  const key = `HKCU:\\Software\\FlowdeckInstallerTest-un-${process.pid}`;
  try {
    const rel = release(t);
    const p = places(t);
    touch(path.join(p.userData, 'data', 'library.json'), '{}');
    assert.equal(ps(['-File', path.join(rel, 'Install-Flowdeck.ps1'), ...common(p, ['-DesktopShortcut']), '-RegistryKey', key]).status, 0);
    assert.equal(psCommand(`Test-Path '${key}'`), 'True');

    // the installed copy of the script is what Settings > Apps runs
    const r = ps(['-File', path.join(p.prefix, 'Uninstall-Flowdeck.ps1'), ...common(p, ['-Uninstall']), '-RegistryKey', key]);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.ok(!fs.existsSync(path.join(p.start, 'Flowdeck.lnk')));
    assert.ok(!fs.existsSync(path.join(p.desktop, 'Flowdeck.lnk')));
    assert.equal(psCommand(`Test-Path '${key}'`), 'False');
    await until(() => !fs.existsSync(p.prefix), { ms: 15000 }); // the folder goes a moment later, once the script has exited
    assert.ok(fs.existsSync(path.join(p.userData, 'data', 'library.json')), 'the library survives an uninstall');

    // with -RemoveUserData
    assert.equal(ps(['-File', path.join(rel, 'Install-Flowdeck.ps1'), ...common(p), '-NoRegistry']).status, 0);
    assert.equal(ps(['-File', path.join(p.prefix, 'Uninstall-Flowdeck.ps1'), ...common(p, ['-Uninstall', '-RemoveUserData', '-NoRegistry'])]).status, 0);
    assert.ok(!fs.existsSync(p.userData));
  } finally {
    ps(['-Command', `Remove-Item -Path '${key}' -Recurse -Force -ErrorAction SilentlyContinue`]);
    await sleep(300);
    t.cleanup();
  }
});

test('uninstalling leaves alone a shortcut that points somewhere else', { skip }, async () => {
  const t = tmp();
  try {
    const rel = release(t);
    const p = places(t);
    assert.equal(ps(['-File', path.join(rel, 'Install-Flowdeck.ps1'), ...common(p, ['-NoRegistry'])]).status, 0);
    // another install of Flowdeck elsewhere has taken over the Start-menu shortcut
    const other = path.join(t.dir, 'elsewhere', 'Flowdeck.exe');
    touch(other, 'x');
    ps(['-Command', `$l=(New-Object -ComObject WScript.Shell).CreateShortcut('${path.join(p.start, 'Flowdeck.lnk')}'); $l.TargetPath='${other}'; $l.Save()`]);
    assert.equal(ps(['-File', path.join(p.prefix, 'Uninstall-Flowdeck.ps1'), ...common(p, ['-Uninstall', '-NoRegistry'])]).status, 0);
    assert.ok(fs.existsSync(path.join(p.start, 'Flowdeck.lnk')), "someone else's shortcut is not ours to remove");
    await until(() => !fs.existsSync(p.prefix), { ms: 15000 });
  } finally {
    await sleep(300);
    t.cleanup();
  }
});

test('a clear error, and nothing installed, if the Flowdeck folder is not beside the script', { skip }, () => {
  const t = tmp();
  try {
    const lone = path.join(t.dir, 'lone');
    fs.mkdirSync(lone);
    fs.copyFileSync(script, path.join(lone, 'Install-Flowdeck.ps1'));
    const p = places(t);
    const r = ps(['-File', path.join(lone, 'Install-Flowdeck.ps1'), ...common(p, ['-NoRegistry'])]);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr + r.stdout, /Can't find the Flowdeck folder next to this script/);
    assert.ok(!fs.existsSync(p.prefix));
  } finally {
    t.cleanup();
  }
});
