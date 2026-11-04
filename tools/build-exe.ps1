# Builds a portable Windows app: dist\Flowdeck\Flowdeck.exe (+ dist\Flowdeck-win-x64.zip).
#
# It copies an Electron runtime, drops the app into resources\app, renames electron.exe to
# Flowdeck.exe and stamps assets\icon.ico onto it. Needs an Electron distribution: run
# `npm install` in this folder, or pass -ElectronDist <...\node_modules\electron\dist>.
[CmdletBinding()]
param(
  [string]$ElectronDist,
  [switch]$NoZip
)
$ErrorActionPreference = 'Stop'

$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$out = Join-Path $root 'dist'
$app = Join-Path $out 'Flowdeck'
$zip = Join-Path $out 'Flowdeck-win-x64.zip'

if (-not $ElectronDist) {
  foreach ($c in @("$root\node_modules\electron\dist", "$root\..\electron-app\node_modules\electron\dist")) {
    if (Test-Path "$c\electron.exe") { $ElectronDist = (Resolve-Path $c).Path; break }
  }
}
if (-not $ElectronDist -or -not (Test-Path "$ElectronDist\electron.exe")) {
  throw 'Electron not found. Run "npm install" in the flowdeck folder, or pass -ElectronDist <path>.'
}
$ver = (Get-Content (Join-Path $ElectronDist 'version') -ErrorAction SilentlyContinue)
Write-Host "Electron runtime: $ElectronDist ($ver)"

# Fresh output folder (only ever inside dist\).
if (Test-Path $app) {
  if (-not $app.StartsWith($out)) { throw "Refusing to delete $app" }
  Remove-Item $app -Recurse -Force
}
New-Item -ItemType Directory -Path $app -Force | Out-Null
Copy-Item "$ElectronDist\*" $app -Recurse

# Trim what the app never uses. LICENSE files stay: Electron requires shipping them.
Remove-Item "$app\resources\default_app.asar" -ErrorAction SilentlyContinue
Get-ChildItem "$app\locales" -Exclude 'en-US.pak' | Remove-Item -Force
Rename-Item "$app\electron.exe" 'Flowdeck.exe'

# The app itself.
$res = Join-Path $app 'resources\app'
New-Item -ItemType Directory -Path $res -Force | Out-Null
foreach ($item in 'main.js', 'server', 'web', 'assets') { Copy-Item (Join-Path $root $item) $res -Recurse }
$pkg = Get-Content (Join-Path $root 'package.json') -Raw | ConvertFrom-Json
$slim = [ordered]@{ name = $pkg.name; productName = $pkg.productName; version = $pkg.version; description = $pkg.description; main = 'main.js'; license = $pkg.license }
[IO.File]::WriteAllText("$res\package.json", ($slim | ConvertTo-Json), (New-Object Text.UTF8Encoding $false))

# Replace Electron's icon resources in the exe with ours.
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.IO;
using System.Runtime.InteropServices;

public static class IconPatcher
{
    static readonly IntPtr RT_ICON = (IntPtr)3, RT_GROUP_ICON = (IntPtr)14;
    delegate bool EnumNames(IntPtr h, IntPtr type, IntPtr name, IntPtr p);
    delegate bool EnumLangs(IntPtr h, IntPtr type, IntPtr name, ushort lang, IntPtr p);
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)] static extern IntPtr LoadLibraryEx(string f, IntPtr h, uint flags);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool FreeLibrary(IntPtr h);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool EnumResourceNames(IntPtr h, IntPtr type, EnumNames cb, IntPtr p);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool EnumResourceLanguages(IntPtr h, IntPtr type, IntPtr name, EnumLangs cb, IntPtr p);
    [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr FindResourceEx(IntPtr h, IntPtr type, IntPtr name, ushort lang);
    [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr LoadResource(IntPtr h, IntPtr res);
    [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr LockResource(IntPtr r);
    [DllImport("kernel32.dll", SetLastError = true)] static extern uint SizeofResource(IntPtr h, IntPtr res);
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)] static extern IntPtr BeginUpdateResource(string f, bool del);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool UpdateResource(IntPtr h, IntPtr type, IntPtr name, ushort lang, byte[] data, uint cb);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool EndUpdateResource(IntPtr h, bool discard);

    class Group { public IntPtr Name; public ushort Lang; public List<ushort> IconIds = new List<ushort>(); }

    static void Check(bool ok, string what) { if (!ok) throw new InvalidOperationException(what + " failed (Win32 error " + Marshal.GetLastWin32Error() + ")"); }

    public static void Apply(string exe, string ico)
    {
        // 1. Find the exe's existing icon groups (and the icons they own).
        IntPtr mod = LoadLibraryEx(exe, IntPtr.Zero, 0x2); // LOAD_LIBRARY_AS_DATAFILE
        Check(mod != IntPtr.Zero, "LoadLibraryEx");
        var groups = new List<Group>();
        var names = new List<IntPtr>();
        EnumResourceNames(mod, RT_GROUP_ICON, delegate (IntPtr h, IntPtr t, IntPtr n, IntPtr p)
        {
            // String names are only valid inside the callback, so keep a private copy.
            names.Add(((long)n >> 16) == 0 ? n : Marshal.StringToHGlobalUni(Marshal.PtrToStringUni(n)));
            return true;
        }, IntPtr.Zero);
        foreach (IntPtr name in names)
        {
            var langs = new List<ushort>();
            EnumResourceLanguages(mod, RT_GROUP_ICON, name, delegate (IntPtr h, IntPtr t, IntPtr n, ushort l, IntPtr p) { langs.Add(l); return true; }, IntPtr.Zero);
            foreach (ushort lang in langs)
            {
                var g = new Group { Name = name, Lang = lang };
                IntPtr res = FindResourceEx(mod, RT_GROUP_ICON, name, lang);
                IntPtr ptr = LockResource(LoadResource(mod, res));
                byte[] data = new byte[SizeofResource(mod, res)];
                Marshal.Copy(ptr, data, 0, data.Length);
                int count = BitConverter.ToUInt16(data, 4);
                for (int i = 0; i < count; i++) g.IconIds.Add(BitConverter.ToUInt16(data, 6 + i * 14 + 12));
                groups.Add(g);
            }
        }
        FreeLibrary(mod);
        if (groups.Count == 0) throw new InvalidOperationException("No icon group found in " + exe);

        // 2. Parse the .ico: header, then one directory entry (16 bytes) per image.
        byte[] file = File.ReadAllBytes(ico);
        int iconCount = BitConverter.ToUInt16(file, 4);
        var grp = new MemoryStream();
        var bw = new BinaryWriter(grp);
        bw.Write((ushort)0); bw.Write((ushort)1); bw.Write((ushort)iconCount);
        var images = new List<byte[]>();
        for (int i = 0; i < iconCount; i++)
        {
            int e = 6 + i * 16;
            int size = BitConverter.ToInt32(file, e + 8), off = BitConverter.ToInt32(file, e + 12);
            byte[] img = new byte[size];
            Array.Copy(file, off, img, 0, size);
            images.Add(img);
            bw.Write(file, e, 12);            // width, height, colours, reserved, planes, bit count, size
            bw.Write((ushort)(1000 + i));     // resource id of the RT_ICON entry (clear of the exe's own)
        }
        byte[] groupData = grp.ToArray();

        // 3. Rewrite: drop the old icons, add ours, point every existing group at them.
        IntPtr upd = BeginUpdateResource(exe, false);
        Check(upd != IntPtr.Zero, "BeginUpdateResource");
        foreach (Group g in groups)
            foreach (ushort id in g.IconIds)
                UpdateResource(upd, RT_ICON, (IntPtr)id, g.Lang, null, 0); // delete
        ushort lang0 = groups[0].Lang;
        for (int i = 0; i < images.Count; i++)
            Check(UpdateResource(upd, RT_ICON, (IntPtr)(1000 + i), lang0, images[i], (uint)images[i].Length), "UpdateResource(icon)");
        foreach (Group g in groups)
            Check(UpdateResource(upd, RT_GROUP_ICON, g.Name, g.Lang, groupData, (uint)groupData.Length), "UpdateResource(group)");
        Check(EndUpdateResource(upd, false), "EndUpdateResource");
    }

    // One node of a VS_VERSIONINFO tree. Children are DWORD-aligned; a node's length excludes trailing padding.
    static byte[] Node(string key, ushort valueLen, ushort type, byte[] value, params byte[][] kids)
    {
        var ms = new MemoryStream();
        var w = new BinaryWriter(ms);
        w.Write((ushort)0); w.Write(valueLen); w.Write(type);
        w.Write(System.Text.Encoding.Unicode.GetBytes(key + "\0"));
        while (ms.Position % 4 != 0) w.Write((byte)0);
        if (value != null) w.Write(value);
        foreach (byte[] k in kids)
        {
            while (ms.Position % 4 != 0) w.Write((byte)0);
            w.Write(k);
        }
        byte[] b = ms.ToArray();
        BitConverter.GetBytes((ushort)b.Length).CopyTo(b, 0);
        return b;
    }

    static byte[] Str(string key, string value)
    {
        return Node(key, (ushort)(value.Length + 1), 1, System.Text.Encoding.Unicode.GetBytes(value + "\0"));
    }

    /// Replaces the exe's version resource so Task Manager and Explorer say `name` instead of "Electron".
    public static void SetVersion(string exe, string version, string name)
    {
        var parts = version.Split('.');
        uint ms = 0, ls = 0;
        uint a = parts.Length > 0 ? uint.Parse(parts[0]) : 0, b = parts.Length > 1 ? uint.Parse(parts[1]) : 0;
        uint c = parts.Length > 2 ? uint.Parse(parts[2]) : 0;
        ms = (a << 16) | b; ls = c << 16;
        var fixedInfo = new MemoryStream();
        var fw = new BinaryWriter(fixedInfo);
        fw.Write(0xFEEF04BDu); fw.Write(0x00010000u); fw.Write(ms); fw.Write(ls); fw.Write(ms); fw.Write(ls);
        fw.Write(0x3Fu); fw.Write(0u); fw.Write(0x00040004u); fw.Write(1u); fw.Write(0u); fw.Write(0u); fw.Write(0u);
        byte[] table = Node("040904b0", 0, 1, null,
            Str("CompanyName", name), Str("FileDescription", name), Str("FileVersion", version),
            Str("InternalName", name), Str("OriginalFilename", name + ".exe"), Str("ProductName", name), Str("ProductVersion", version));
        byte[] translation = new byte[] { 0x09, 0x04, 0xB0, 0x04 };
        byte[] blob = Node("VS_VERSION_INFO", 52, 0, fixedInfo.ToArray(),
            Node("StringFileInfo", 0, 1, null, table),
            Node("VarFileInfo", 0, 1, null, Node("Translation", 4, 0, translation)));

        // Replace the resource in every language the exe already has it in.
        IntPtr RT_VERSION = (IntPtr)16, id1 = (IntPtr)1;
        IntPtr mod = LoadLibraryEx(exe, IntPtr.Zero, 0x2);
        Check(mod != IntPtr.Zero, "LoadLibraryEx");
        var langs = new List<ushort>();
        EnumResourceLanguages(mod, RT_VERSION, id1, delegate (IntPtr h, IntPtr t, IntPtr nm, ushort l, IntPtr p) { langs.Add(l); return true; }, IntPtr.Zero);
        FreeLibrary(mod);
        if (langs.Count == 0) langs.Add(1033);
        IntPtr upd = BeginUpdateResource(exe, false);
        Check(upd != IntPtr.Zero, "BeginUpdateResource");
        foreach (ushort l in langs) Check(UpdateResource(upd, RT_VERSION, id1, l, blob, (uint)blob.Length), "UpdateResource(version)");
        Check(EndUpdateResource(upd, false), "EndUpdateResource");
    }
}
'@
[IconPatcher]::Apply("$app\Flowdeck.exe", (Join-Path $root 'assets\icon.ico'))
[IconPatcher]::SetVersion("$app\Flowdeck.exe", $pkg.version, $pkg.productName)
Write-Host 'Icon and version info stamped on Flowdeck.exe'

if (-not $NoZip) {
  # Some files in the Electron runtime carry pre-1980 timestamps, which zip cannot store.
  Get-ChildItem $app -Recurse -File | Where-Object { $_.LastWriteTime.Year -lt 1980 } | ForEach-Object { $_.LastWriteTime = Get-Date }
  if (Test-Path $zip) { Remove-Item $zip -Force }
  Compress-Archive -Path $app -DestinationPath $zip -CompressionLevel Optimal
}

$mb = { param($p) '{0:N0} MB' -f ((Get-ChildItem $p -Recurse -File | Measure-Object Length -Sum).Sum / 1MB) }
Write-Host ("Done: $app ({0})" -f (& $mb $app))
if (-not $NoZip) { Write-Host ("      $zip ({0:N0} MB)" -f ((Get-Item $zip).Length / 1MB)) }
