'use strict';

/* Only used when the interface is opened in a plain browser (no Electron bridge), so the screens can
   be designed and checked without touching a real drive. Inside the app this file does nothing.
   Options: ?win  pretend to be Windows   ?empty  no drives   ?fail  make the job fail   ?fast  quick run */
if (!window.flash) {
  const q = new URLSearchParams(location.search);
  const speed = q.has('fast') ? 6 : 1;
  let drives = q.has('empty')
    ? []
    : [
        { id: 'disk4', name: 'SanDisk Ultra USB 3.0', size: 32010928128, volumes: ['CROOLI'], bus: 'USB' },
        { id: 'disk5', name: 'Samsung BAR Plus', size: 128043712512, volumes: [], bus: 'USB' },
      ];
  const listeners = { drives: [], event: [] };
  let timer = null;
  let cancelled = false;

  window.flash = {
    info: async () => ({ version: '1.0.0', platform: q.has('win') ? 'win32' : 'darwin', arch: 'arm64', dev: true }),
    listDrives: async () => drives,
    onDrives: (cb) => listeners.drives.push(cb),
    pickImage: async () => ({ path: '/Users/me/Downloads/crooli-os-amd64.iso', name: 'crooli-os-amd64.iso', size: 2147483648, label: 'CROOLI_OS_1_1_2' }),
    inspectImage: async () => ({ error: 'That is not a disk image. Choose an .iso or .img file.' }),
    pathForFile: () => '',
    openExternal: () => {},
    onUpdate: (cb) => q.has('update') && setTimeout(() => cb({ state: 'available', version: '1.0.2' }), 800),
    currentUpdate: async () => null,
    installUpdate: async () => {},
    cancel: async () => (cancelled = true),
    onProgress: (cb) => listeners.event.push(cb),
    start: async (job) => {
      cancelled = false;
      const emit = (event) => listeners.event.forEach((cb) => cb(event));
      const total = 2147483648;
      const plan = job.op === 'format' ? [['preparing', 0.25], ['formatting', 1]] : job.op === 'verify' ? [['hashing', 0.5], ['verifying', 1]] : [['preparing', 0.02], ['writing', job.verify === false ? 1 : 0.5], ...(job.verify === false ? [] : [['verifying', 1]])];
      emit({ type: 'phase', phase: 'authorizing' });
      let fraction = 0;
      let index = 0;
      setTimeout(() => {
        emit({ type: 'phase', phase: plan[0][0] });
        timer = setInterval(() => {
          if (cancelled) {
            clearInterval(timer);
            return emit({ type: 'cancelled' });
          }
          fraction += 0.006 * speed;
          if (fraction >= plan[index][1]) {
            index++;
            if (index >= plan.length) {
              clearInterval(timer);
              if (q.has('fail')) return emit({ type: 'error', message: 'The drive stopped responding. It may be damaged or was unplugged.' });
              return emit({ type: 'done', sha256: 'de42501a762a0aaa6739a38b142717ab8607a0bd695ed443a1206289a9af7e4a', verified: true, matches: true, fs: job.fs, label: job.label, bytes: total });
            }
            emit({ type: 'phase', phase: plan[index][0] });
          }
          emit({ type: 'progress', fraction, done: fraction * total, total, rate: 38e6 + Math.sin(fraction * 20) * 4e6, eta: (1 - fraction) * 62 });
        }, 60);
      }, 1800 / speed);
      return { ok: true };
    },
  };

  window.__mock = {
    plug: () => {
      drives = [...drives, { id: 'disk9', name: 'Kingston DataTraveler', size: 16008609792, volumes: [], bus: 'USB' }];
      listeners.drives.forEach((cb) => cb(drives));
    },
    unplug: () => {
      drives = drives.slice(0, -1);
      listeners.drives.forEach((cb) => cb(drives));
    },
  };
}
