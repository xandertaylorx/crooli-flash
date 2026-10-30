'use strict';

/*
 * Lists the drives Crooli Flash is willing to touch: removable and USB drives only. The system disk,
 * internal disks and anything the operating system booted from are never listed, so there is no way
 * to point the writer at them from the interface.
 */

const { execFile } = require('child_process');

const dev = process.env.CROOLI_FLASH_DEV === '1';

function exec(command, args, input) {
  return new Promise((resolve, reject) => {
    const child = execFile(command, args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, windowsHide: true }, (error, stdout) => {
      if (error) reject(error);
      else resolve(stdout);
    });
    if (input !== undefined) child.stdin.end(input);
  });
}

async function plist(args) {
  const xml = await exec('diskutil', args);
  return JSON.parse(await exec('plutil', ['-convert', 'json', '-o', '-', '-'], xml));
}

async function listMac() {
  const listing = await plist(['list', '-plist', 'external', ...(dev ? [] : ['physical'])]);
  const byId = new Map((listing.AllDisksAndPartitions || []).map((disk) => [disk.DeviceIdentifier, disk]));
  const drives = [];

  for (const id of listing.WholeDisks || []) {
    let info;
    try {
      info = await plist(['info', '-plist', id]);
    } catch {
      continue;
    }
    if (info.Internal && !dev) continue;
    if (info.WritableMedia === false) continue;

    const entry = byId.get(id) || {};
    const parts = entry.Partitions || [];
    const mounts = parts.map((part) => part.MountPoint).filter(Boolean);
    if (mounts.some((point) => point === '/' || point.startsWith('/System/Volumes'))) continue;

    drives.push({
      id,
      raw: `/dev/r${id}`,
      name: (info.MediaName || '').trim() || 'USB drive',
      size: info.TotalSize || info.Size || entry.Size || 0,
      volumes: parts.map((part) => part.VolumeName).filter(Boolean),
      bus: info.BusProtocol || 'USB',
    });
  }
  return drives;
}

async function listWindows() {
  const script = `
    $ErrorActionPreference = 'SilentlyContinue'
    $out = @(Get-Disk | Where-Object { $_.BusType -in 'USB','SD','MMC' -and -not $_.IsBoot -and -not $_.IsSystem } | ForEach-Object {
      $d = $_
      $names = @(Get-Partition -DiskNumber $d.Number | ForEach-Object {
        $v = $_ | Get-Volume
        if ($v) { $l = if ($v.DriveLetter) { "$($v.DriveLetter):" } else { '' }; ("$l $($v.FileSystemLabel)").Trim() }
      } | Where-Object { $_ })
      [pscustomobject]@{ Number = $d.Number; Name = $d.FriendlyName; Size = $d.Size; Bus = [string]$d.BusType; Volumes = $names }
    })
    ConvertTo-Json -InputObject $out -Compress -Depth 4
  `;
  const text = (await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script])).trim();
  if (!text) return [];
  const parsed = JSON.parse(text);
  return (Array.isArray(parsed) ? parsed : [parsed]).map((disk) => ({
    id: `disk${disk.Number}`,
    number: disk.Number,
    raw: `\\\\.\\PhysicalDrive${disk.Number}`,
    name: (disk.Name || '').trim() || 'USB drive',
    size: disk.Size || 0,
    volumes: [].concat(disk.Volumes || []),
    bus: disk.Bus || 'USB',
  }));
}

async function listDrives() {
  try {
    if (process.platform === 'darwin') return await listMac();
    if (process.platform === 'win32') return await listWindows();
  } catch (error) {
    console.error('drive listing failed:', error.message);
  }
  return [];
}

module.exports = { listDrives };
