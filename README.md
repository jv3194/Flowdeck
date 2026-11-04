# Flowdeck

A cover-flow media player for **music, videos and photos**, styled after console launcher UIs
(RetroFlow / LiveArea): a 3D carousel of covers with reflections, a wave-and-bubble backdrop that
re-tints itself to the focused cover, glass panels, and controller-style button hints.
All artwork and icons are original. The look is yours to change: nineteen built-in themes, a Customize sheet, and
themes you can save, export and share.

## Run it

```
start.bat            # Windows: desktop window (or browser if Electron isn't available)
npm install          # once, for a self-contained Electron
npm start            # desktop window
npm run serve        # no Electron: serves http://127.0.0.1:4173 and opens your browser
npm test             # tag-parser tests
npm run package      # build dist\Flowdeck\Flowdeck.exe and dist\Flowdeck-win-x64.zip
```

**Standalone build.** `dist\Flowdeck\` is a portable app: no installer, no Node or Electron needed on the
target PC. Copy the folder anywhere (or unzip `Flowdeck-win-x64.zip`) and run `Flowdeck.exe`. The build script
(`tools/build-exe.ps1`) copies an Electron runtime, adds the app, and stamps Flowdeck's icon and version info
onto the exe. The exe is unsigned, so Windows SmartScreen may show an "unknown publisher" prompt on other PCs.

First launch shows an empty shelf. Press **Enter** (or the *Add a folder* button) and pick a folder;
subfolders are scanned too. The library is cached, so later launches open instantly and refresh in the
background. Removing a folder only removes it from the library, never from disk.

## Using it

| | Keyboard | Gamepad |
|---|---|---|
| Browse | ← → | D-pad / left stick |
| Open / play | Enter | ✕ |
| Back | Esc / Backspace | ○ |
| Options menu | Tab / right-click | △ |
| Flow ⇄ grid | V | □ |
| Category | PgUp / PgDn (or `[` `]`) | L1 / R1 |
| Jump to a letter | type it | |
| Play / pause (music anywhere) | Space | Start |
| Fullscreen | F11 | |

The hint bar at the bottom switches between key caps and ✕ ○ △ □ glyphs depending on which device you used last.

- **Music** is shelved as albums (grouped by album + album artist, CD1/CD2 merged). Covers come from embedded
  art, then `cover.jpg` / `folder.jpg` in the album folder. Playback continues behind a mini player;
  the Now Playing screen has a spectrum ring that drives the background.
- **Videos** are shelved as posters. Movies are recognised from file names (`The.Matrix.1999.1080p.mkv`,
  `Inception (2010)/movie.mp4`) and TV episodes from `S01E02`, `1x02` or `Show/Season 2/03 - Title.mkv`; episodes
  are grouped into one **show** that opens to a season-by-season episode list with a *Continue* button. Camera
  clips (`VID_2023…`) are left alone. Playback resumes where you left off. `← →` seek 5s (Shift: 30s), `↑ ↓` volume,
  `J`/`L` ±10s, `M` mute, `F` fullscreen, `, .` playback speed, `N`/`P` next/previous, `C` subtitles, `G`/`H` subtitle
  delay, `Tab` (△) the playback options sheet. Thumbnails are taken from the video itself.
- **Photos** crossfade; `↑ ↓` or the wheel zoom, drag to pan, `Space` starts a slideshow, `I` shows details.

### Themes and styles

**Options → Theme & style** lists the themes. Moving over one previews it live; **Enter** keeps it, **Esc** puts
everything back. Built in, dark: *Wave* (the original), *Aurora*, *Neon Grid*, *Midnight*, *Bubbles*, *Sunset*,
*OLED* (true black, no motion), *Terminal* (green rain, monospace), *Neon Rain*, *Ember* (sparks rising off a hot
floor), *Frost* (snowfall), *Deep Sea*, *Outrun* (a striped sun over a neon grid), *Obsidian* (black and gold),
*Northern Lights*, *Amethyst* and *Blood Moon*. Light: *Daylight* and *Paper*.

**Customize this theme…** changes any of these, and each change applies instantly (`← →` nudge a value, or click a gauge):

| Setting | Choices |
|---|---|
| Light or dark | the whole interface switches, including sheets, text and the Now Playing ring |
| Background | Waves, Aurora, Retro grid, Starfield, Bubbles, Rain, Embers, Snowfall, Soft gradient, Solid colour (each works in light and dark) |
| Accent colour | *Follows the cover* (the default look), or *One colour* with its own hue and strength |
| Brightness, Glass, Corners | how bright the backdrop is, how frosted the panels are, how round the corners are |
| Reflections, Motion | the mirror under covers on/off; backdrop speed, down to *Still* (the backdrop stops redrawing) |
| Cover layout | Cover flow, Carousel, Stack, Fan, Flat row, with an angle control; covers glide when you change it |
| Font | Soft, Serif, Tech, Mono (fonts already on your PC, nothing is downloaded) |

Built-in themes can't be overwritten: **Save as a new theme…** keeps your changes as a theme of your own (up to 30),
which you can then update, rename or delete. **Export** writes a small `.json` file; **Import** reads one back.
A theme file only ever carries these settings, never code or CSS. Anything unknown in it is dropped, numbers are
clamped to their limits, and names are stripped of markup, so a file from someone else can't do more than
change how Flowdeck looks. (Import uses a file picker, so it needs a mouse or keyboard rather than a gamepad.)
Video and photo viewing stay dark in every theme, as a cinema should.

### Subtitles

The player finds subtitles on its own, with no setup:

- **Files next to the video**: `Movie.srt`, `Movie.en.srt`, `Movie.eng.forced.srt`, `Show.S01E02.es.SDH.ass`, in
  SRT, WebVTT or ASS/SSA. Files in a `Subs/` (or `Subtitles/`) folder work too, including the scene-release layout
  `Subs/<video name>/2_English.srt`. If a folder holds a single video, any subtitle file in it belongs to that video.
  A file dropped in is picked up the next time you open the video, with no rescan.
- **Text subtitles inside MKV/WebM files** (SRT, ASS/SSA, WebVTT). Browsers can't read these, so the server pulls them
  out the first time you pick one (a large file can take a few seconds) and caches them.

Language and flags (forced, SDH) come from the file name or the track's own tags. **`C`** cycles Off → each track,
**CC** in the control bar or **Tab → Subtitles** lists them, and **Tab** also has text size, delay (`←` `→` nudge it
by 0.1 s, or `G`/`H` while playing) and speed. Flowdeck remembers your language (it switches on by itself for the next
video, preferring full subtitles over forced, SDH or commentary tracks), your size, and the delay per video.
Old text files are decoded as UTF-8, UTF-16, or the language's usual Windows code page.

Not supported: image-based subtitles (PGS from Blu-rays, VobSub), which are listed greyed out; subtitles inside MP4
files (`mov_text`); and downloading subtitles from the internet. Subtitles are drawn by Flowdeck itself, using only
italic, bold and underline, so a subtitle file can't inject anything into the page.

### Videos the player can't decode (HEVC 10-bit, Dolby Digital, DTS…)

Chromium, which draws the player, can't decode everything. On a typical PC it plays H.264, VP9, AV1 and 8-bit HEVC
(with the graphics card's help), but **not** 10-bit HEVC (most modern HEVC releases and all HDR ones), 4:2:2/4:4:4
pictures, old codecs such as MPEG-4 ASP or VC-1, or the sound formats AC-3, E-AC-3 (Dolby Digital / Digital Plus),
DTS, TrueHD and ALAC. Without help those play with no sound or no picture.

Flowdeck works out, for each video, what it can't decode, and converts **only that** while you watch, using
[ffmpeg](https://ffmpeg.org):

| What is wrong | What Flowdeck does | Cost |
|---|---|---|
| Only the sound (e.g. E-AC-3 on an H.264 picture) | keeps the picture as it is, converts the sound to AAC (keeps 5.1) | almost nothing |
| The picture (e.g. HEVC 10-bit) | converts to H.264 (hardware decoding where available, at most 1080p, with HDR tone-mapped to standard colours) | about the speed of a normal encode |
| Nothing | plays the file as it is | none |

A small badge in the corner says **Converted** or **Sound converted**. Seeking, resuming, skipping, speed and subtitles
all work (a seek restarts the conversion from that point). Nothing is saved to disk and your files are never changed.
Leaving the video stops ffmpeg at once.

**ffmpeg isn't bundled.** The first time a video needs it, Flowdeck asks, saying exactly what it would fetch: the
official Windows "essentials" build from gyan.dev (about 115 MB), checked against the SHA-256 that gyan.dev publishes
(a download that doesn't match is thrown away), unpacked into `<data>/ffmpeg` (only `ffmpeg.exe` and `ffprobe.exe`).
Or install it yourself: Flowdeck also uses `FLOWDECK_FFMPEG` (a folder), or an `ffmpeg` on your PATH. **Options → Video
conversion** shows the state, downloads or removes Flowdeck's own copy, and turns conversion off (so *Don't ask again*
is reversible). Choosing *Play it without converting* is respected for that video.

How it decides: with ffmpeg present it asks ffprobe about the file. Without it, Matroska (`.mkv`) files can still be
judged from their own headers, so Flowdeck can tell you ffmpeg is needed before it is installed. Other containers can't
be inspected without ffmpeg: if one opens with no picture (or fails), Flowdeck notices and offers the conversion then.
Limits: only the default sound track is played (as before), HDR tone-mapping needs the zscale filter (the gyan.dev build
has it), and a very weak PC may not convert 4K faster than real time.

### Artwork and metadata from the internet

**Options → Artwork & metadata** looks up covers, posters, years, genres, synopses and episode titles.
The first time, Flowdeck says plainly what gets sent and asks once. After that, *Fetch automatically for new
items* (on by default) looks up whatever is new each time you open the program, and *Save details into my music
files* (also on by default) writes what it finds into the files, so you only ever do this once per album.

| | Source | Setup |
|---|---|---|
| Music | MusicBrainz + Cover Art Archive, then iTunes Search | none |
| TV shows | TVMaze | none |
| Movies | TMDB | a free API key: themoviedb.org → Settings → API, then paste it under *TMDB key* |

- **Fetch missing** does a whole shelf (or everything) in the background, one lookup at a time, and reports
  how many were found. Items with no confident match are remembered so they aren't retried every time.
- **Match…** shows what the services returned for the selected album, show or movie, with thumbnails, so you can
  pick the right one when the automatic guess is wrong or you want different art.
- **Remove fetched data** forgets a lookup for the selected item in the app (it doesn't touch files).
- Only names are sent (artist and album, show name, movie title and year), never files or paths. The TMDB key is
  kept in a file in the data folder and is never sent back to the page.
- Album years are the first release, not a reissue.

#### Saved into your music files

What's found for an album is written into its tracks, so it survives reinstalling, moving to another PC, or losing
the app's data folder, and shows up in any other player:

- **MP3 and FLAC**: the cover art (front cover), the year and the genre go into each file's tags.
  Only the tag header is rewritten; every byte of audio is copied unchanged.
- **Other audio** (M4A, WAV, Ogg, Opus…) can't be tagged safely here, so the cover is saved as `cover.jpg` in the
  album's folder instead (never over one that's already there).
- **Nothing existing is overwritten.** A year, genre or cover the file already has is left alone, with one exception:
  art you pick yourself with **Match…** replaces the file's cover.
- **Safe by construction.** The new file is built next to the original and checked (the audio must be
  bit-identical and the new tag must read back) before it replaces it, so a failure leaves the original untouched.
  Unusual tags (ID3v2.2, unsynchronised or damaged) are skipped, not guessed at. A locked or read-only file is
  reported and retried next launch.
- **Undo.** Before each change the original tag is saved, and **Undo file changes for the selected album** puts every
  file back byte-for-byte (it refuses if a file has been edited by something else since).
- Videos are not modified: movie and show details live in the app's data folder (rewriting multi-gigabyte
  video containers isn't worth the risk).

Turn it off with *Save details into my music files* in the same menu; switching it on again saves anything fetched
in the meantime.

This product uses the TMDB API but is not endorsed or certified by TMDB.

**TMDB credit.** TMDB's free tier asks for this notice plus one of their approved logos in an About/Credits
section, and **Options → About and credits** shows both next to the list of sources. `web/assets/tmdb-logo.svg`
is TMDB's own short blue logo, unmodified, from
[themoviedb.org/about/logos-attribution](https://www.themoviedb.org/about/logos-attribution). It is TMDB's artwork,
not covered by this project, and is used only to credit them. To use a different approved logo, replace that file.
If it is missing, the sheet shows just the notice.

Supported: mp3 flac m4a/m4b aac wav ogg/opus · mp4 m4v webm mkv mov ogv · jpg png gif webp bmp avif.
What plays directly is up to Chromium's codecs; videos that need more are converted on the fly (see above).
Tags are read for mp3 (ID3v1/v2), flac and m4a; other formats fall back to filenames and folder names
(`Artist/Album/01 - Title.ext`).

## How it works

```
server/   zero-dependency Node server: folder scan, tag + cover extraction, ranged media streaming, JSON API;
          names.js (file-name parsing, fuzzy matching), providers.js (online lookups), enrich.js (lookup queue),
          subtitles.js (SRT/VTT/ASS parsing, sidecar discovery), mkv.js (embedded subtitle tracks),
          tagwrite.js (safe MP3/FLAC tag writing), writeback.js (saving fetched details into files, undo),
          transcode.js (what a video needs, and the ffmpeg commands: pure rules), ffmpeg.js (finding ffmpeg, streaming
          a conversion, the verified download), zip.js (reads two files out of that download)
web/      vanilla ES-module UI (no build step): flow.js carousel, bg.js backdrop, screens/*, convert.js (ffmpeg prompts);
          themes.js (theme model, validation, import/export), layouts.js (cover arrangements as pure math),
          themeui.js (the picker and Customize sheet); every colour in css/app.css is a variable the theme sets
main.js   Electron shell: starts the server in-process, shows a window
tests/    tag parsers (ID3 v1/v2.2/2.3/2.4, FLAC, MP4, WAV) from in-memory fixtures; file-name parsing; the online
          providers, lookup queue and API endpoints against a fake `fetch` (the suite never touches the network);
          subtitle parsers and sidecar discovery; the MKV reader against Matroska files built in the test;
          the tag writer (audio identical, nothing overwritten, exact undo) and the lookup-to-files path;
          theme validation, tweaks, saving, importing hostile files, and the cover layouts' geometry;
          the conversion rules and commands, the download and its checksum (against a fake `fetch`: no ffmpeg is run and
          nothing is downloaded), and the conversion endpoints and their Host/Origin guard
```

The server binds to `127.0.0.1` only and rejects requests with an unexpected `Host` or `Origin`, so a web
page you happen to have open can't reach your files through it.

Data (library cache, covers, preferences including your themes, the undo journal) lives in `%APPDATA%\Flowdeck\data` under Electron, or
`~/.flowdeck` for `npm run serve` (override with `--data <dir>` or `FLOWDECK_DATA`). The library file keeps a
`.bak` copy of its previous version as a fallback. For music, the files themselves are the lasting record (see
above), so the data folder is a cache you could delete without losing anything you fetched (a downloaded ffmpeg, in
`ffmpeg\` there, would just be offered again).

`FLOWDECK_SMOKE=1` starts the app hidden, prints what rendered, and exits. It uses a throwaway profile in the temp
folder, so it can never touch your real data.
