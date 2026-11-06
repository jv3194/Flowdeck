# Changelog

## 1.4.0

### New
- **Tidy folder names** (Options → Tidy folder names, on the video shelves): renames the folder a movie or show is in to
  a clean "Title (Year)", as you would in Windows, or puts loose files into a folder of their own ("Show (Year)/Season 01"
  for episodes). Choose the selected movie or show, or everything on the shelf. **Nothing happens until you have seen it:**
  the list shows what each folder is called now, what it would become, and why anything can't be done. Something looked up
  online starts ticked; the rest are named from their file names (taking the year and the capital letters from the
  folder's own name when it says more) and start unticked when you tidy a whole shelf. You can type your own name for any folder.
  - **Nothing is overwritten or merged.** A folder is only renamed to a name that is free, and loose files are only moved into
    a folder where no file has the same name. Only folders inside your library folders that hold nothing but that movie or
    show are renamed, never a library folder itself. A folder that is in use (Windows refuses) is left as it was, and if
    anything fails halfway, what had been done is put back.
  - Subtitles, `.nfo` files and artwork named after a video travel with it. A separate `Subs` folder stays behind, and
    the preview says so.
  - **Flowdeck keeps what it knows.** A file's id comes from its path, so a rename changes it; its artwork and details,
    thumbnails, where you got to, watched marks, subtitle delay and cached subtitles are all carried across, and the
    library holds its own rescans back while it works. (Renaming a folder outside Flowdeck still makes it forget these.)
  - **Undo.** The last ten changes can be undone exactly, from the same window or Options → Tidy folder names, even after
    a restart. A change that can no longer be reversed (you renamed the folder again since) is left alone and reported.
  - Folders under Sonarr or Radarr, or in a downloads folder, come with a warning: they keep their own record of the
    folders and will lose track of the files.

### Under the hood
- `server/tidy.js` plans and carries out the changes; the library gains `paused()` (no scan runs, and new ones wait) and
  `movePaths()` (an item's record follows its files to a new path).
- 44 more automated tests (232 in all), every one on throwaway folders in the temp directory.

## 1.3.0

### Sharper on every screen
- **Graphics quality** (Options): Auto, Standard, High or Ultra. The animated backdrop used to be drawn at half the
  window's size whatever the screen; it now gets as many real pixels as the quality and the screen's density call for
  (Ultra is pixel-for-pixel on a high-density display). **Auto** starts at High and, if the animation can't keep up,
  steps down by itself once (with a note), and remembers it. A quality you choose by hand is never overridden.
- **Sharper thumbnails:** photo and video thumbnails are made as large as the screen and quality can use (up to 1920 px,
  they were 640), and existing ones are upgraded as you browse. Thumbnails are encoded with a better filter.
- **Larger posters** are downloaded for movies and shows (TMDB 780 px, iTunes 1000 px; they were 500 and 600).
- **Interface size** (Options, or Ctrl and + / - / 0): Small, Normal, Large, Extra large, or Auto, which makes the whole
  interface bigger on 4K screens that are not scaled by Windows. Desktop app only.

- **Resize the picture while watching a video:** zoom in up to 400% with `+` / `-` or the mouse wheel and drag to move
  around, and change the shape with `Z` (or the picture button): Original, Fill window (crop), Stretch, 16:9, 4:3,
  21:9 or 1:1. `0` resets. Both are also in the playback options. The shape is remembered; zoom starts fresh for each video.

- **Identify songs and fix their tags** (Options → Artwork & metadata → Identify the songs in …): for the selected
  album, artist or folder, every song is searched for online by its title and artist (or, where the tags are missing, by
  its file name such as `Artist - Title` and its folders), using iTunes and then MusicBrainz. A review screen shows each
  song as it is now beside what was found, with how sure the match is; confident matches start ticked, `←` `→` shows
  the other matches, and nothing is written until you save. Saving replaces the title, artist, album, track number,
  year and genre in the MP3 or FLAC file (and adds a cover when the file has none), through the same checked rewrite as
  before: the audio is copied byte for byte, and the whole change can be undone from the same window. Other file types
  are listed but never touched. This is for songs from many different artists in one folder, where album lookups cannot help.
- **Group music by album or by artist, whatever folders it is in** (Options → Group music by): *Albums (by folder and
  tags)* is the usual way; *Albums (by tags, ignoring folders)* makes one album of a record whose songs are spread over
  several folders, and puts untagged songs together under their artist; *Artists* makes one entry per artist holding all
  their songs, with the album named beside each one. Sorting and type-to-jump follow the artist's name, and the choice
  is remembered. (Artists are not looked up online as albums.)
- **A "Spoken" shelf for audiobooks and podcasts**, so Music is music alone. A recording is spoken when it is an `.m4b`
  file, its genre says Audiobook, Podcast, Spoken Word, Speech or Talk, or it lives in a folder named Audiobooks or
  Podcasts; an album moves to Spoken when most of its tracks are. The shelf only appears when it has something in it,
  and works like Music (search, sorting, lookups, covers). Spoken albums stay on Spoken even without a cover.
- **A "No cover art" shelf for music**, like "No artwork" for videos: albums that have no cover in their files or
  folder and none found online (or no album name to look up) are kept apart from the rest. It only appears when it has
  something in it, behaves like Music in every way (search, sorting, lookups), and an album moves back to Music as soon
  as it gets a cover. Albums that have not been looked up yet stay in Music until they have been.

### Fixed
- **The shelf tabs no longer run off the window.** With every shelf showing (Music, Spoken, No cover art, Videos,
  Continue, No artwork, Photos, Albums) the last tabs were cut off and the PgUp / PgDn boxes sat on top of the names.
  The row now measures itself and tightens in steps (drops the boxes, then icons and spacing, then counts), and keeps the
  chosen shelf in view.
- **Arrow keys in a long menu no longer jump back to the mouse.** When a list scrolled under a resting mouse, the
  browser repeated the pointer position as a move and the selection snapped to the row under it.
- The player's control bar fits narrow windows (smaller buttons, no volume bar below 640 px).
- A "ResizeObserver loop" error that could appear in the log when resizing the window.
- **Opening a movie could play the first movie of the shelf instead** (for example always "3:10 to Yuma"). After the
  library refreshed in the background, the shelf could still hold an older copy of each entry, the clicked movie was
  "not found", and the player fell back to the first one. Movies, photos and search results are now matched by id.
- Switching to another video (next, previous, or another episode) now stops the old one at once. Before, it kept
  playing until the next video had been looked at, which could take seconds on a big file, and in that gap its
  position could be saved as the new video's resume point.

### Under the hood
- The page's bridge to the app now has three abilities: it also sets the window's zoom (clamped to 75–200%).
- 188 automated tests (up from 158); the real app is checked at startup for the zoom bridge and the backdrop's pixels.

## 1.2.0

### New
- **12 richer themes** (31 in all): Nebula, Deep Space, Fireflies, Midnight City, Dusk Skyline, Plasma, Vaporwave,
  Wireframe, Cinema, Lagoon, and the light themes Silk and Daybreak.
- **Five new animated backgrounds**, each in dark and light: Nebula, Fireflies, Ribbons, Skyline and Plasma.
- **Four new theme settings** in Customize: **Cover frame** (Soft, Glass, Sharp, Neon, Film), **Glow**, **Film grain**
  and **Particles** (how thick the moving things are). Themes you saved or exported before keep their exact look;
  theme files carry the new settings.
- **Flowdeck remembers its window:** size, position and maximised state are restored on the next launch. If a monitor
  has been unplugged, the window opens on a screen that is still there.
- **Drag a folder onto the window to add it.** Flowdeck asks whether it is music and video or photos (a folder of
  pictures is offered as photos first).
- **The library keeps itself up to date:** files added, deleted or renamed in your library folders appear within a few
  seconds, with no Rescan. (Half-written files and downloads in progress are ignored until they finish.)
- **Options → Open log folder** shows the log file, which records errors from the server, the window and the page.
  Please include it in bug reports.
- **An installer:** `Install Flowdeck.cmd` in the release zip installs for your user account (no administrator),
  adds Start-menu and desktop shortcuts and a Settings → Apps entry, and upgrades cleanly over an older version.
  `packaging/make-release.ps1` builds the release zip.

### Under the hood
- The app talks to the page through a small, fixed bridge (`preload.js`) with exactly two abilities: finding where a
  dropped folder lives, and showing the log folder.
- 158 automated tests (up from 115), including the installer run against a fake release, a real file watcher, and every
  background drawn in dark and light.

## 1.1.0

### New
- **Search** across music, movies, shows, clips and photos: press `/`, or use the search button. Results update as you
  type; accents, word order and partial words don't matter.
- **Continue watching:** a "Continue" shelf of movies and shows you have started, with progress bars and a tick on
  finished ones. Shows open at the next episode up. Mark anything watched or not watched from Options.
- **Choose the sound track** of a video (language and format), switching without losing your place. The language you
  choose is remembered for the next video. Needs ffmpeg, which Flowdeck already offers to download.
- **Photo albums:** photos grouped by folder, on an "Albums" shelf, with an album screen to browse each folder.
- **Photos only from folders you pick for photos.** Music/video folders and photo folders are separate lists.
- **"No artwork" shelf** keeps videos that no artwork was found for online, and home clips, apart from the rest.
- **A second source for movie details and posters** (iTunes), so movies work without a TMDB key. A TMDB key now adds
  ratings and more matches.
- **Mouse navigation:** Back, Search and Options buttons in the status bar, arrows beside the cover flow, clickable
  key hints, a clickable shelf switcher, and the mouse's Back button.

### Faster and smoother
- Cover flow draws only the covers that can be seen; the animated background redraws at 30 fps (15 while the shelf
  moves, none behind a video or photo). Idle frame rate on a large library roughly tripled in testing.
- Grid view opens instantly on thousands of photos.
- Scanning a very large library no longer re-sends and rebuilds the whole library every second.
- Thumbnails and colour sampling wait while the shelf is moving.

### Fixed
- Subtitles split correctly when a blank line between cues holds stray spaces or tabs.
- Numeric movie titles (`1917.mkv`, `300.mkv`) are no longer treated as phone clips; titles ending in a year-like
  number (`Wonder Woman 1984`) are matched; remakes (`Doctor Who (2005)`) keep their year for lookups.
- Subtitles of `Alien 3.srt` no longer attach to `Alien.mkv`.
- The prefs API can no longer be used to modify `Object.prototype`.
- A failed file swap while saving tags no longer leaves a stale entry in the undo journal.
- Overlapping library saves no longer collide.
- Runtimes like "1 hr 60 min" now read "2 hr 0 min".
- A resume point no longer carries over to the next video when skipping quickly; audio-only video files are no
  longer treated as broken; music resumes after a video; failed preference saves are retried; and more.

### Under the hood
- 115 automated tests (`npm test`), and the source is now in a git repository.
