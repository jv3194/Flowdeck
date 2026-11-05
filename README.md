# Flowdeck

A cover-flow player for music, videos and photos. This folder is the app's source: the Electron runtime
(`Flowdeck.exe` and friends) sits one level up and is not part of this repository.

```
main.js        Electron shell: starts the server in-process and opens the window
server/        local HTTP server: library scan, tags, metadata lookups, subtitles, ffmpeg conversion
web/           the interface (plain ES modules, no build step)
assets/        icons
test/          automated tests
```

## Tests

```
npm test
```

Uses Node's built-in test runner (Node 20 or newer), so there is nothing to install.

- `test/server/*.test.js` run the server code against real temporary folders and files, a fake network, and
  (for the API) a real server on a random port. Nothing touches your own library or the internet.
- `test/web/*.test.mjs` run the interface's plain-logic modules (shelves, watching, search, themes, layouts)
  in Node, with no browser.

When fixing a bug, add a test that fails without the fix. Several of the tests exist because of a bug that was
found and fixed once already.

## Running it

Run `Flowdeck.exe`, or start the server on its own for development:

```js
require('./server').startServer({ port: 4177, dataDir: '<a folder for the library>', webDir: require('path').join(__dirname, 'web') })
```

then open the printed address in a browser.
