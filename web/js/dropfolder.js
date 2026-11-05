// Dragging folders onto the window to add them to the library.
// The two small functions here are plain logic (so they can be tested); the app wires them to the window's drag events.

/** True while the thing being dragged carries files or folders (rather than selected text, a link, and so on). */
export function carriesFiles(dataTransfer) {
  return !!dataTransfer && [...(dataTransfer.types || [])].includes('Files');
}

/**
 * Where the dropped items are on disk. A web page cannot read a dropped file's location, so `pathFor` is the desktop
 * app's way of asking (see preload.js); it returns '' for anything it can't place. Each place is listed once.
 */
export function droppedPaths(dataTransfer, pathFor) {
  const paths = [];
  for (const file of dataTransfer?.files || []) {
    const p = pathFor?.(file) || '';
    if (p && !paths.includes(p)) paths.push(p);
  }
  return paths;
}

/**
 * Which kind of folder to offer first for a folder holding these counts of songs, videos and pictures: a folder that
 * holds only pictures is most likely a photo folder. (A folder of folders holds nothing directly: media first.)
 */
export function likelyKind(counts) {
  const c = counts || {};
  return c.image > 0 && !c.audio && !c.video ? 'photos' : 'media';
}
