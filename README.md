<p align="center">
  <img src="src/renderer/assets/icon.svg" width="88" alt="Crooli Flash">
</p>

<h1 align="center">Crooli Flash</h1>

<p align="center">
  A calm, fast USB tool for Mac and Windows.<br>
  Flash an ISO, check every byte, or format a drive.<br>
  <a href="https://crooli.com/flash"><b>crooli.com/flash</b></a>
</p>

---

## Install

Crooli Flash is installed with one command, so macOS Gatekeeper and Windows SmartScreen have nothing to
block and you never have to dig through Settings to approve it.

**macOS** (Terminal)

```sh
curl -fsSL https://crooli.com/flash/install.sh | sh
```

**Windows** (PowerShell)

```powershell
irm https://crooli.com/flash/install.ps1 | iex
```

The scripts are short and live in the Crooli website repository, served from
[crooli.com/flash/install.sh](https://crooli.com/flash/install.sh) and
[install.ps1](https://crooli.com/flash/install.ps1). Each one downloads the latest release from this
repository, installs it, and opens it. A file fetched by `curl` or PowerShell is not marked as "downloaded
from the internet", which is why the app opens without a warning.

To remove it: drag **Crooli Flash** to the Bin on a Mac, or use Settings, Apps on Windows.

## What it does

| | |
|---|---|
| **Flash** | Writes an `.iso` or `.img` to a USB drive, byte for byte. Hybrid images such as Crooli OS work as they are. |
| **Verify** | Reads the whole drive back and compares a SHA-256 fingerprint with the image. Also available on its own, to check a drive you made earlier. |
| **Format** | FAT32, exFAT, NTFS (Windows) or Mac OS Extended (Mac). Quick, or a full erase that zeroes every byte. MBR or GPT. |

It only lists USB and removable drives. The system disk and internal disks are never offered, and the app
confirms before it erases anything. Writing to a raw drive needs administrator rights, so macOS or Windows
shows its own password or UAC prompt when you start a job. The password goes to the operating system and
never reaches this app.

## How it is built

Electron, with no front-end framework and no runtime dependencies.

```
src/main/main.js      window, drive polling, job control (the only thing the interface can ask for)
src/main/drives.js    lists removable drives (diskutil on macOS, Get-Disk on Windows)
src/main/elevate.js   starts the worker with administrator rights through the OS prompt
src/main/worker.js    the part that touches the disk: write, verify, format. Reports by JSON lines
src/main/preload.js   the small bridge the interface can use
src/renderer/         the interface (HTML, CSS and one script)
```

The interface never names a device path. It sends a drive id, and `main.js` looks that id up in the list it
just made itself, so there is no way to point the writer at a disk the app did not list.

### Run it

```sh
npm install
npm start
```

`npm run dev:drives` also lists disk images and virtual disks, which is handy for testing with a RAM disk
(`hdiutil attach -nomount ram://131072` on a Mac) instead of a real stick. Setting
`CROOLI_FLASH_NOELEVATE=1` as well skips the password prompt, for drives your user already owns.

`npm test` runs the worker against ordinary files: writing, read-back verification, a flipped byte being
caught, an image that is too big, cancelling, and a full erase.

You can design the screens without Electron by serving `src/renderer` and opening `index.html` in a browser.
It then uses `dev-mock.js` to pretend to be a Mac with two drives (`?win`, `?empty`, `?fail` and `?fast` change that).

### Build

```sh
npm run icons
npm run dist:mac     # zips for Apple silicon and Intel
npm run dist:win     # NSIS installer
```

Pushing a tag such as `v1.0.1` builds both and publishes a GitHub release, using
`.github/workflows/release.yml`. The app is not notarized or code signed; macOS builds are ad-hoc signed so
they start on Apple silicon.

## Licence

This repository is public, but it is not open source. You can read the code and use the official builds for
free; you cannot copy, modify or redistribute it. See [LICENSE](LICENSE). The bundled Crooli Sans typeface
is under the SIL Open Font License.
