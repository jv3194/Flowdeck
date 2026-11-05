// Converted playback, the page's side: what this browser can decode, the question "download ffmpeg?",
// the download's progress, and the setup sheet. The rules for what needs converting live on the server.
import { api } from './api.js';
import { ListSheet, toast } from './ui.js';
import { sleep } from './util.js';

let capsPromise;

/**
 * What this browser can decode beyond the basics, as the words the server understands (ac3, eac3, dts, hevc8, hevc10).
 * Asked once. HEVC depends on the graphics card, so it is checked the way the player itself would decode it.
 */
export function playerCaps() {
  capsPromise ??= (async () => {
    const v = document.createElement('video');
    const found = [];
    if (v.canPlayType('audio/mp4; codecs="ac-3"')) found.push('ac3');
    if (v.canPlayType('audio/mp4; codecs="ec-3"')) found.push('eac3');
    if (v.canPlayType('audio/mp4; codecs="dtsc"')) found.push('dts');
    const decodes = async (contentType) => {
      try {
        return !!(await navigator.mediaCapabilities.decodingInfo({ type: 'file', video: { contentType, width: 1920, height: 1080, bitrate: 8e6, framerate: 24 } })).supported;
      } catch {
        return false;
      }
    };
    if (await decodes('video/mp4; codecs="hvc1.1.6.L93.B0"')) found.push('hevc8');
    if (await decodes('video/mp4; codecs="hvc1.2.4.L120.B0"')) found.push('hevc10');
    return found.join(',');
  })();
  return capsPromise;
}

const mb = (n) => Math.round(n / 1e6); // decimal, to agree with the "about 115 MB" shown beforehand

/** Keep the app's copy of ffmpeg's status (shown in Options) up to date. */
export async function refreshFfmpeg(app) {
  try {
    app.ffmpeg = await api.ffmpegStatus();
  } catch {
    /* the Options row just keeps showing the last thing it knew */
  }
  return app.ffmpeg;
}

/**
 * "This video needs converting, and ffmpeg isn't here." Resolves 'download', 'skip' (play it as it is) or 'never'.
 * The sheet says exactly what a download is, because clicking it is the user's consent to fetch it.
 */
export function askFfmpeg(app, plan) {
  return new Promise((resolve) => {
    const what = plan.reasons.map((r) => (r.forced ? r.text : `${r.text} ${r.kind === 'video' ? 'picture' : 'sound'}`)).join(' and ') || 'this video';
    const { canInstall, approxMB } = plan.ffmpeg;
    // Picking another sound track needs no conversion of anything, but still has to rebuild the stream with ffmpeg.
    const lead = plan.switched && !plan.reasons.length
      ? 'Playing the sound track you picked needs ffmpeg, a free tool, to rebuild the video while you watch.'
      : `Flowdeck can't play this video's ${what} on its own. ffmpeg, a free tool, can convert it while you watch.`;
    const note = `${lead} ${canInstall
      ? `It's about ${approxMB} MB from gyan.dev (the official Windows build), checked against the checksum gyan.dev publishes, and kept in Flowdeck's own data folder. Nothing else is sent anywhere.`
      : 'Install ffmpeg (for example with your package manager) and restart Flowdeck.'}`;
    const items = [];
    if (canInstall) items.push({ label: `Download ffmpeg (about ${approxMB} MB)`, icon: 'download', primary: true, action: () => resolve('download') });
    items.push({ label: 'Play it without converting', icon: 'play', action: () => resolve('skip') });
    items.push({ label: "Don't ask again", icon: 'close', action: () => resolve('never') });
    app.openLayer(new ListSheet(app, { title: 'This video needs converting', note, items, onClose: () => resolve('skip') }));
  });
}

const phaseText = (s) => {
  if (s.phase === 'verifying') return 'Checking the download…';
  if (s.phase === 'extracting') return 'Unpacking…';
  return `${mb(s.done)} of ${s.total ? mb(s.total) : `about ${s.approxMB}`} MB`;
};

/**
 * Download ffmpeg and wait for it, showing progress. True once it is ready. Closing the sheet stops waiting
 * (the download carries on and finishes by itself).
 */
export async function installFfmpeg(app) {
  let closed = false;
  const sheet = new ListSheet(app, {
    title: 'Downloading ffmpeg',
    note: 'From gyan.dev, checked against its published SHA-256 before anything is installed.',
    items: [{ label: 'Starting…', disabled: true }],
    onClose: () => { closed = true; },
  });
  app.openLayer(sheet);
  try {
    let s = await api.ffmpegInstall();
    while (!closed) {
      if (s.state === 'busy') sheet.setItems([{ label: phaseText(s), disabled: true }]);
      else break;
      await sleep(400);
      s = await api.ffmpegStatus();
    }
    if (closed) {
      toast('ffmpeg keeps downloading in the background. Open the video again when it is done.', 'info', 5000);
      return false;
    }
    app.ffmpeg = s;
    sheet.close();
    if (s.state === 'ready') {
      toast('ffmpeg is ready', 'check', 2500);
      return true;
    }
    toast(s.error || "Couldn't get ffmpeg", 'info', 7000);
    return false;
  } catch (e) {
    sheet.close();
    toast(e.message, 'info', 6000);
    return false;
  }
}

/** Options → Video conversion: what state ffmpeg is in, and the things you can do about it. */
export async function openFfmpegSheet(app) {
  let s = await refreshFfmpeg(app);
  if (!s) return toast("Couldn't reach Flowdeck's server", 'info');
  const sheet = new ListSheet(app, { title: 'Video conversion', closeBelow: true, items: [] });
  const paint = async (keepSel = true) => {
    s = (await refreshFfmpeg(app)) || s;
    const on = app.prefs.convert !== false;
    const items = [{
      label: 'Convert videos when needed', icon: 'sync', value: on ? 'On' : 'Off', keep: true,
      action: () => { app.patchPrefs({ convert: !on }); paint(); },
    }];
    let note = 'Some videos use video or sound the player cannot decode (HEVC 10-bit, Dolby Digital, DTS). With ffmpeg, Flowdeck converts them while you watch. Nothing is saved to disk and your files are never changed.';
    if (s.state === 'ready') {
      items.push({ label: `ffmpeg ${s.version}`, icon: 'check', sm: { path: 'found on your PC', flowdeck: "Flowdeck's own copy", folder: 'from FLOWDECK_FFMPEG' }[s.source] || '', disabled: true });
      if (s.canRemove) items.push({ label: 'Remove ffmpeg', icon: 'trash', keep: true, action: async () => { await api.ffmpegRemove(); toast('ffmpeg removed', 'trash'); paint(); } });
    } else if (s.state === 'busy') {
      note += ' It is downloading right now.';
    } else if (s.canInstall) {
      if (s.error) note += ` The last attempt failed: ${s.error}.`;
      items.push({ label: `Download ffmpeg (about ${s.approxMB} MB)`, icon: 'download', primary: true, keep: true, action: async () => { await installFfmpeg(app); paint(); } });
      note += " The download is from gyan.dev (the official Windows build), checked against its published SHA-256, and kept in Flowdeck's own data folder.";
    } else {
      items.push({ label: 'ffmpeg is not installed', icon: 'info', sm: 'install it, then restart', disabled: true });
    }
    sheet.setItems(items, { note, keepSel });
  };
  await paint(false);
  app.openLayer(sheet);
}
