Flowdeck - installing
=====================

Two ways to use it:

1. Install (recommended)
   Unzip this whole folder anywhere, then double-click "Install Flowdeck.cmd".
   It installs for your user account only (no administrator needed), adds Flowdeck to the Start menu and the
   desktop, and to Settings > Apps so you can uninstall it there. Installing a newer version over an older one
   upgrades it. Your library and settings are kept.

2. Run without installing
   Unzip the folder and run Flowdeck\Flowdeck.exe. Nothing else is changed on your computer.

Windows may show a "Windows protected your PC" notice the first time: Flowdeck is not code-signed.
Choose "More info", then "Run anyway".

Where your data lives
   %APPDATA%\Flowdeck   your library, covers, preferences and the log folder (Options > Open log folder).
   Uninstalling keeps it, so reinstalling picks up where you left off. To remove it as well, run
   Install-Flowdeck.ps1 -Uninstall -RemoveUserData.

If something goes wrong, Options > Open log folder shows flowdeck.log: please include it in a bug report.
