'use strict';

/* The whole interface. No framework: views are built once and then updated in place, so nothing
   flickers while a drive list or progress bar changes underneath it. */

const api = window.flash;
const stage = document.getElementById('stage');

const icons = {
  usb: '<svg viewBox="0 0 24 24"><rect x="7" y="3" width="10" height="7" rx="1.5"/><path d="M10 6h.01M14 6h.01"/><path d="M8.5 10h7v8a3 3 0 0 1-3 3h-1a3 3 0 0 1-3-3v-8Z"/></svg>',
  disc: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8.5"/><circle cx="12" cy="12" r="2.4"/><path d="M12 3.5a8.5 8.5 0 0 1 8.5 8.5"/></svg>',
  check: '<svg viewBox="0 0 24 24"><path d="m5 12.5 4.5 4.5L19 7.5"/></svg>',
  cross: '<svg viewBox="0 0 24 24"><path d="M6.5 6.5 17.5 17.5M17.5 6.5 6.5 17.5"/></svg>',
  bolt: '<svg viewBox="0 0 24 24"><path d="M13 3 5 13.5h6L10 21l8-10.5h-6L13 3Z"/></svg>',
  shield: '<svg viewBox="0 0 24 24"><path d="M12 3.5 5 6.2v5.1c0 4.2 2.8 7.4 7 9.2 4.2-1.8 7-5 7-9.2V6.2l-7-2.7Z"/><path d="m9 12 2.2 2.2L15.5 10"/></svg>',
  erase: '<svg viewBox="0 0 24 24"><rect x="5" y="3.5" width="14" height="17" rx="3"/><path d="M9 8h6M9 12h6"/></svg>',
};

const state = {
  view: 'flash',
  info: { platform: 'darwin', version: '' },
  image: null,
  imageError: '',
  driveId: null,
  drives: [],
  verify: true,
  fmt: { fs: 'exfat', label: 'CROOLI', scheme: 'mbr', erase: 'quick' },
  job: null,
};

/* ------------------------------------------------------------- helpers */

function h(tag, attrs, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs || {})) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'html') node.innerHTML = value;
    else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, value === true ? '' : value);
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child.nodeType ? child : document.createTextNode(child));
  }
  return node;
}

const fmtSize = (bytes) => {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(bytes >= 1e11 ? 0 : 1)} GB`;
  if (bytes >= 1e6) return `${Math.round(bytes / 1e6)} MB`;
  return `${Math.round(bytes / 1e3)} KB`;
};

const fmtTime = (seconds) => {
  if (seconds === null || seconds === undefined || !isFinite(seconds)) return '--';
  const s = Math.round(seconds);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m}m ${String(s % 60).padStart(2, '0')}s` : `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
};

const isWin = () => state.info.platform === 'win32';
const selectedDrive = () => state.drives.find((drive) => drive.id === state.driveId) || null;

/* ------------------------------------------------------------- steps */

function step(title, content) {
  const node = h(
    'section',
    { class: 'step' },
    h('div', { class: 'step__no', html: `<span></span>${icons.check}` }),
    h('div', { class: 'step__body' }, h('h3', { class: 'step__title' }, title), content),
  );
  return node;
}

function setDone(node, done, number) {
  node.classList.toggle('is-done', done);
  node.querySelector('.step__no span').textContent = number;
}

/* ------------------------------------------------------------- image picker */

async function chooseImage(result) {
  const picked = result === undefined ? await api.pickImage() : result;
  if (!picked) return;
  if (picked.error) {
    state.imageError = picked.error;
    state.image = null;
  } else {
    state.imageError = '';
    state.image = picked;
  }
  refresh();
}

function imageStep() {
  const button = h('button', { type: 'button', class: 'image', onclick: () => chooseImage() });
  const error = h('p', { class: 'error-line', hidden: true });
  const root = h('div', {}, button, error);
  let shown;
  root.sync = () => {
    const image = state.image;
    if (shown === image && root.dataset.ready) return;
    shown = image;
    root.dataset.ready = '1';
    button.classList.toggle('is-set', !!image);
    button.replaceChildren(
      h('span', { class: 'image__disc', html: icons.disc }),
      h(
        'span',
        { class: 'image__text' },
        h('strong', {}, image ? image.name : 'Choose a disk image'),
        h('span', {}, image ? `${fmtSize(image.size)}${image.label ? ` · ${image.label}` : ''}` : 'Click here, or drop an .iso or .img file anywhere'),
      ),
      h('span', { class: 'image__change' }, image ? 'Change' : 'Browse'),
    );
  };
  root.syncError = () => {
    error.hidden = !state.imageError;
    error.textContent = state.imageError;
  };
  const sync = root.sync;
  root.sync = () => {
    sync();
    root.syncError();
  };
  return root;
}

/* ------------------------------------------------------------- drive list */

const driveLists = new Set();

function driveStep() {
  const list = h('div', { class: 'drives', role: 'radiogroup', 'aria-label': 'Drives' });
  const empty = h(
    'div',
    { class: 'empty' },
    h('div', { class: 'empty__plug', html: icons.usb }),
    h('div', {}, h('strong', {}, 'Plug in a USB drive'), h('span', {}, 'It will appear here the moment it is connected.')),
  );
  const root = h('div', {}, list, empty);

  root.sync = () => {
    const wanted = new Map(state.drives.map((drive) => [drive.id, drive]));
    for (const el of [...list.children]) {
      if (!wanted.has(el.dataset.id) && !el.classList.contains('leave')) {
        el.classList.add('leave');
        setTimeout(() => el.remove(), 240);
      }
    }
    for (const drive of state.drives) {
      let el = [...list.children].find((child) => child.dataset.id === drive.id && !child.classList.contains('leave'));
      if (!el) {
        el = h(
          'button',
          { type: 'button', class: 'drive', role: 'radio', 'data-id': drive.id, onclick: () => selectDrive(drive.id) },
          h('span', { class: 'drive__icon', html: icons.usb }),
          h('span', { class: 'drive__text' }, h('strong'), h('span')),
          h('span', { class: 'drive__radio', html: icons.check }),
        );
        list.append(el);
      }
      el.querySelector('strong').textContent = drive.name;
      el.querySelector('.drive__text span').textContent = [fmtSize(drive.size), ...(drive.volumes || []).slice(0, 2)].join(' · ');
      const on = drive.id === state.driveId;
      el.classList.toggle('is-selected', on);
      el.setAttribute('aria-checked', String(on));
    }
    empty.hidden = state.drives.length > 0;
  };
  driveLists.add(root);
  return root;
}

function selectDrive(id) {
  state.driveId = state.driveId === id ? null : id;
  refresh();
}

/* ------------------------------------------------------------- controls */

function segmented(options, get, set, label) {
  const thumb = h('span', { class: 'seg__thumb' });
  const buttons = options.map((option) =>
    h('button', { type: 'button', 'data-value': option.value, onclick: () => set(option.value) }, option.label),
  );
  const root = h('div', { class: 'seg', role: 'radiogroup', 'aria-label': label }, thumb, buttons);
  thumb.style.width = `calc((100% - 6px) / ${options.length})`;
  root.sync = () => {
    const index = Math.max(0, options.findIndex((option) => option.value === get()));
    thumb.style.transform = `translateX(${index * 100}%)`;
    buttons.forEach((button, i) => {
      button.classList.toggle('is-on', i === index);
      button.disabled = !!(options[i].disabled && options[i].disabled());
    });
  };
  return root;
}

function toggle(label, get, set) {
  const node = h(
    'button',
    { type: 'button', class: 'switch', role: 'switch', onclick: () => set(!get()) },
    h('span', { class: 'switch__track' }),
    label,
  );
  node.sync = () => node.setAttribute('aria-checked', String(get()));
  return node;
}

function actionButton(label, icon, onclick) {
  const button = h('button', { type: 'button', class: 'btn', onclick }, h('span', { html: icon }), label);
  button.firstChild.style.display = 'contents';
  return button;
}

/* ------------------------------------------------------------- views */

const syncers = [];
const track = (node) => {
  syncers.push(node);
  return node;
};

function head(title, text) {
  return h('header', { class: 'head' }, h('h1', {}, title), h('p', {}, text));
}

function imageAndDriveView(kind) {
  const flashing = kind === 'flash';
  const imageNode = track(imageStep());
  const driveNode = track(driveStep());
  const imageBlock = step(flashing ? 'Disk image' : 'Image to check against', imageNode);
  const driveBlock = step('USB drive', driveNode);

  const go = actionButton(flashing ? 'Flash' : 'Verify drive', flashing ? icons.bolt : icons.shield, () => begin(kind));
  const actions = h('div', { class: 'actions' }, go);
  if (flashing) actions.append(track(toggle('Verify after writing', () => state.verify, (value) => ((state.verify = value), refresh()))));
  const goBlock = step(flashing ? 'Write it' : 'Check it', actions);

  const root = h('div', { class: 'view' }, head(
    flashing ? 'Flash an image' : 'Verify a drive',
    flashing
      ? 'Write an ISO to a USB drive, then check every byte.'
      : 'Compare a drive with its image, byte for byte. Nothing is changed.',
  ), h('div', { class: 'steps' }, imageBlock, driveBlock, goBlock));

  track({
    sync: () => {
      const ready = !!state.image && !!selectedDrive();
      setDone(imageBlock, !!state.image, 1);
      setDone(driveBlock, !!selectedDrive(), 2);
      setDone(goBlock, false, 3);
      go.disabled = !ready;
      go.classList.toggle('is-ready', ready);
    },
  });
  return root;
}

function formatView() {
  const kinds = isWin()
    ? [
        { value: 'fat32', label: 'FAT32', disabled: () => (selectedDrive()?.size || 0) > 32 * 1024 ** 3 },
        { value: 'exfat', label: 'exFAT' },
        { value: 'ntfs', label: 'NTFS' },
      ]
    : [
        { value: 'fat32', label: 'FAT32' },
        { value: 'exfat', label: 'exFAT' },
        { value: 'hfs', label: 'Mac OS Extended' },
      ];
  const notes = {
    exfat: 'Works on Mac and Windows, with no file size limit.',
    fat32: 'Works almost everywhere. Files must be under 4 GB.',
    ntfs: 'Windows only. A Mac can read it but not write to it.',
    hfs: 'Mac only. Windows cannot read it.',
  };

  const driveBlock = step('USB drive', track(driveStep()));

  const fsSeg = track(segmented(kinds, () => state.fmt.fs, (value) => ((state.fmt.fs = value), refresh()), 'File system'));
  const note = h('p', { class: 'hint' });
  const label = h('input', {
    class: 'text',
    type: 'text',
    spellcheck: 'false',
    autocomplete: 'off',
    maxlength: '11',
    'aria-label': 'Name',
    oninput: (event) => {
      state.fmt.label = event.target.value;
    },
  });
  const scheme = track(
    segmented(
      [
        { value: 'mbr', label: 'MBR' },
        { value: 'gpt', label: 'GPT' },
      ],
      () => state.fmt.scheme,
      (value) => ((state.fmt.scheme = value), refresh()),
      'Partition map',
    ),
  );
  const erase = track(
    segmented(
      [
        { value: 'quick', label: 'Quick' },
        { value: 'zero', label: 'Full erase' },
      ],
      () => state.fmt.erase,
      (value) => ((state.fmt.erase = value), refresh()),
      'Erase',
    ),
  );
  const eraseNote = h('p', { class: 'hint hint--flush' });

  const options = h(
    'div',
    { class: 'options' },
    h('div', { class: 'field field--wide' }, h('span', {}, 'File system'), fsSeg, note),
    h('div', { class: 'field' }, h('label', {}, 'Name'), label),
    h('div', { class: 'field' }, h('span', {}, 'Partition map'), scheme),
    h('div', { class: 'field' }, h('span', {}, 'Erase'), erase),
    h('div', { class: 'field--wide' }, eraseNote),
  );
  const optionsBlock = step('Options', options);

  const go = actionButton('Format', icons.erase, () => begin('format'));
  const goBlock = step('Erase it', h('div', { class: 'actions' }, go));

  const root = h('div', { class: 'view view--format' }, head('Format a drive', 'Wipe a USB drive and give it a fresh file system.'), h('div', { class: 'steps' }, driveBlock, optionsBlock, goBlock));

  track({
    sync: () => {
      if (!kinds.some((kind) => kind.value === state.fmt.fs && !(kind.disabled && kind.disabled()))) state.fmt.fs = 'exfat';
      note.textContent = notes[state.fmt.fs];
      label.maxLength = state.fmt.fs === 'ntfs' ? 32 : 11;
      if (document.activeElement !== label) label.value = state.fmt.label;
      eraseNote.textContent =
        state.fmt.erase === 'zero'
          ? 'Writes zeros over the whole drive. Thorough, and it can take a long while.'
          : 'Clears the file table. Takes a few seconds.';
      setDone(driveBlock, !!selectedDrive(), 1);
      setDone(optionsBlock, !!selectedDrive(), 2);
      setDone(goBlock, false, 3);
      go.disabled = !selectedDrive();
      go.classList.toggle('is-ready', !!selectedDrive());
    },
  });
  return root;
}

/* ------------------------------------------------------------- navigation */

function buildView() {
  syncers.length = 0;
  driveLists.clear();
  stage.parentElement.scrollTop = 0;
  stage.replaceChildren(state.view === 'format' ? formatView() : imageAndDriveView(state.view));
  refresh();
}

function refresh() {
  for (const node of syncers) node.sync && node.sync();
  for (const list of driveLists) list.sync();
}

function show(view) {
  if (state.job || view === state.view) return;
  state.view = view;
  const nav = [...document.querySelectorAll('.nav button')];
  nav.forEach((button) => button.classList.toggle('is-active', button.dataset.view === view));
  document.querySelector('.nav__pill').style.transform = `translateY(${nav.findIndex((b) => b.dataset.view === view) * 42}px)`;
  const current = stage.firstElementChild;
  if (current) current.classList.add('view--leaving');
  setTimeout(buildView, current ? 150 : 0);
}

document.querySelectorAll('.nav button').forEach((button) => button.addEventListener('click', () => show(button.dataset.view)));
document.querySelectorAll('[data-link]').forEach((link) =>
  link.addEventListener('click', (event) => {
    event.preventDefault();
    api.openExternal(link.href);
  }),
);

/* ------------------------------------------------------------- confirm sheet */

const sheet = document.getElementById('sheet');

function confirmSheet(title, body, ok) {
  return new Promise((resolve) => {
    document.getElementById('sheet-title').textContent = title;
    document.getElementById('sheet-body').textContent = body;
    const confirm = document.getElementById('sheet-confirm');
    const cancel = document.getElementById('sheet-cancel');
    confirm.textContent = ok;
    sheet.hidden = false;
    cancel.focus();
    const close = (value) => {
      sheet.hidden = true;
      confirm.onclick = cancel.onclick = null;
      document.removeEventListener('keydown', onKey);
      resolve(value);
    };
    const onKey = (event) => event.key === 'Escape' && close(false);
    document.addEventListener('keydown', onKey);
    confirm.onclick = () => close(true);
    cancel.onclick = () => close(false);
  });
}

/* ------------------------------------------------------------- running a job */

const chipPlans = {
  flash: () => [
    ['Allow', ['authorizing']],
    ['Write', state.verify ? ['preparing', 'writing'] : ['preparing', 'writing', 'finishing']],
    ...(state.verify ? [['Verify', ['verifying', 'finishing']]] : []),
  ],
  verify: () => [
    ['Allow', ['authorizing']],
    ['Read image', ['hashing']],
    ['Check drive', ['verifying']],
  ],
  format: () => [
    ['Allow', ['authorizing']],
    ['Prepare', ['preparing']],
    ...(state.fmt.erase === 'zero' ? [['Erase', ['erasing']]] : []),
    ['Format', ['formatting', 'finishing']],
  ],
};

const headlines = {
  authorizing: () => [
    'Allow Crooli Flash',
    isWin() ? 'Approve the Windows prompt so it can write to the drive.' : 'Enter your Mac password when asked. It goes straight to macOS and is never seen by this app.',
  ],
  preparing: () => ['Getting ready', 'Keep the drive plugged in.'],
  writing: (job) => [`Writing to ${job.driveName}`, 'Keep the drive plugged in. This can take a few minutes.'],
  hashing: () => ['Reading the image', 'Working out its fingerprint.'],
  verifying: (job) => [job.op === 'flash' ? 'Checking every byte' : `Checking ${job.driveName}`, 'Comparing the drive with the image.'],
  erasing: () => ['Erasing the drive', 'Writing zeros over every byte.'],
  formatting: () => ['Formatting', 'Nearly there.'],
  finishing: () => ['Finishing up', 'Making sure everything is flushed to the drive.'],
};

async function begin(op) {
  const drive = selectedDrive();
  if (!drive) return;

  if (op === 'flash') {
    const ok = await confirmSheet(`Erase ${drive.name}?`, `Everything on this ${fmtSize(drive.size)} drive will be deleted and replaced with ${state.image.name}.`, 'Erase and flash');
    if (!ok) return;
  } else if (op === 'format') {
    const ok = await confirmSheet(`Format ${drive.name}?`, `Everything on this ${fmtSize(drive.size)} drive will be permanently deleted.`, 'Erase and format');
    if (!ok) return;
  }

  const result = await api.start({
    op,
    driveId: drive.id,
    image: state.image && state.image.path,
    verify: state.verify,
    ...(op === 'format' ? state.fmt : {}),
  });
  if (result.error) {
    state.imageError = result.error;
    refresh();
    if (!state.image) await confirmSheet('Cannot start', result.error, 'OK');
    return;
  }

  state.job = { op, driveName: drive.name, imageName: state.image && state.image.name, phase: 'authorizing', fraction: 0, ended: null, startedAt: Date.now() };
  buildJob();
}

const CIRCUMFERENCE = 2 * Math.PI * 108;
let jobRefs = null;

function buildJob() {
  const gradient =
    '<defs><linearGradient id="ring-gradient" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#3291ff"/><stop offset="1" stop-color="#50e3c2"/></linearGradient></defs>';
  const svg = h('div', {
    html: `<svg class="ring__svg" viewBox="0 0 232 232" aria-hidden="true">${gradient}<circle class="ring__track" cx="116" cy="116" r="108"/><circle class="ring__bar" cx="116" cy="116" r="108" stroke-dasharray="${CIRCUMFERENCE}" stroke-dashoffset="${CIRCUMFERENCE}"/></svg>`,
  }).firstChild;

  jobRefs = {
    root: h('div', { class: 'job', 'aria-live': 'polite' }),
    ring: h('div', { class: 'ring' }),
    bar: svg.querySelector('.ring__bar'),
    pct: h('div', { class: 'ring__pct' }, '0', h('sup', {}, '%')),
    label: h('div', { class: 'ring__label' }),
    icon: h('div', { class: 'ring__icon-wrap' }),
    title: h('h2'),
    text: h('p'),
    chips: h('div', { class: 'chips' }),
    stats: h('div', { class: 'stats' }),
    actions: h('div', { class: 'actions' }),
  };
  const r = jobRefs;
  r.ring.append(h('div', { class: 'ring__halo' }), svg, h('div', { class: 'ring__center' }, r.pct, r.label, r.icon));
  r.speed = h('b', {}, '--');
  r.left = h('b', {}, '--');
  r.done = h('b', {}, '--');
  r.stats.append(
    h('div', { class: 'stat' }, r.speed, h('span', {}, 'Speed')),
    h('div', { class: 'stat' }, r.left, h('span', {}, 'Time left')),
    h('div', { class: 'stat' }, r.done, h('span', {}, 'Done')),
  );
  r.cancel = h('button', { type: 'button', class: 'btn btn--ghost', onclick: () => api.cancel() }, 'Cancel');
  r.actions.append(r.cancel);
  r.root.append(r.ring, r.title, r.text, r.chips, r.stats, r.actions);

  stage.parentElement.scrollTop = 0;
  stage.replaceChildren(r.root);
  document.querySelectorAll('.nav button').forEach((button) => (button.disabled = true));
  paintJob();
}

function paintJob() {
  const job = state.job;
  const r = jobRefs;
  if (!job || !r) return;
  const plan = chipPlans[job.op]();
  const active = plan.findIndex(([, phases]) => phases.includes(job.phase));

  r.chips.replaceChildren(
    ...plan.map(([name], index) => {
      const done = job.ended === 'ok' || index < active;
      return h('span', { class: `chip${done ? ' is-done' : ''}${!job.ended && index === active ? ' is-active' : ''}` }, h('i'), name);
    }),
  );

  const waiting = !job.ended && (job.phase === 'authorizing' || (job.phase === 'preparing' && job.fraction === 0));
  r.ring.classList.toggle('is-wait', waiting);
  r.root.classList.toggle('is-ended', !!job.ended);
  r.root.classList.toggle('is-ok', job.ended === 'ok');
  r.root.classList.toggle('is-bad', job.ended === 'bad' || job.ended === 'soft');

  if (!job.ended) {
    const [title, text] = (headlines[job.phase] || headlines.preparing)(job);
    r.title.textContent = title;
    r.text.textContent = text;
    const pct = Math.min(100, Math.floor(job.fraction * 100));
    r.pct.firstChild.nodeValue = String(pct);
    r.label.textContent = waiting ? (job.phase === 'authorizing' ? 'Waiting for permission' : 'Preparing') : plan[Math.max(0, active)][0];
    r.bar.style.strokeDashoffset = String(CIRCUMFERENCE * (1 - job.fraction));
    r.stats.hidden = waiting;
    r.cancel.hidden = false;
    r.cancel.disabled = job.phase === 'authorizing';
  }
}

function endJob(kind, title, text, extras = []) {
  const job = state.job;
  job.ended = kind;
  paintJob();
  const r = jobRefs;
  r.title.textContent = title;
  r.text.textContent = text;
  r.stats.hidden = true;
  r.cancel.hidden = true;
  r.bar.style.strokeDashoffset = kind === 'ok' ? '0' : String(CIRCUMFERENCE * (1 - Math.max(job.fraction, 0.02)));
  r.icon.innerHTML = kind === 'ok' ? '<svg class="ring__icon" viewBox="0 0 24 24"><path d="m5 12.5 4.5 4.5L19 7.5"/></svg>' : '<svg class="ring__icon" viewBox="0 0 24 24"><path d="M6.5 6.5 17.5 17.5M17.5 6.5 6.5 17.5"/></svg>';
  r.chips.append(...extras);
  r.actions.replaceChildren(
    h('button', { type: 'button', class: 'btn', onclick: leaveJob }, kind === 'ok' ? 'Done' : 'Back'),
  );
}

function leaveJob() {
  const wasOk = state.job && state.job.ended === 'ok';
  const op = state.job && state.job.op;
  state.job = null;
  jobRefs = null;
  document.querySelectorAll('.nav button').forEach((button) => (button.disabled = false));
  if (wasOk && op !== 'verify') state.driveId = null;
  buildView();
}

const hashChip = (hash) =>
  h(
    'button',
    {
      type: 'button',
      class: 'chip chip--mono',
      title: 'Copy the SHA-256 fingerprint',
      onclick: (event) => {
        navigator.clipboard && navigator.clipboard.writeText(hash);
        event.currentTarget.lastChild.nodeValue = 'copied';
        setTimeout(() => event.currentTarget && (event.currentTarget.lastChild.nodeValue = `sha256 ${hash.slice(0, 8)}…${hash.slice(-6)}`), 1200);
      },
    },
    h('i'),
    `sha256 ${hash.slice(0, 8)}…${hash.slice(-6)}`,
  );

api.onProgress((event) => {
  const job = state.job;
  if (!job) return;
  if (event.type === 'phase') {
    job.phase = event.phase;
  } else if (event.type === 'progress') {
    job.fraction = Math.max(job.fraction, event.fraction);
    jobRefs.speed.textContent = event.rate ? `${Math.round(event.rate / 1e6)} MB/s` : '--';
    jobRefs.left.textContent = fmtTime(event.eta);
    jobRefs.done.textContent = `${fmtSize(event.done)} of ${fmtSize(event.total)}`;
  } else if (event.type === 'done') {
    if (job.op === 'flash') {
      endJob(
        'ok',
        'Your drive is ready',
        `${job.imageName} was written to ${job.driveName}${event.verified ? ' and checked byte for byte' : ''}. ${isWin() ? 'Eject it from the tray before you unplug it.' : 'It is safe to unplug.'}`,
        [hashChip(event.sha256)],
      );
    } else if (job.op === 'verify') {
      if (event.matches) endJob('ok', 'It matches', `${job.driveName} holds exactly the same bytes as ${job.imageName}.`, [hashChip(event.sha256)]);
      else endJob('bad', 'It does not match', `${job.driveName} is different from ${job.imageName}. Flash it again, or try another drive.`);
    } else {
      endJob('ok', `Formatted as ${{ fat32: 'FAT32', exfat: 'exFAT', ntfs: 'NTFS', hfs: 'Mac OS Extended' }[event.fs] || 'a new drive'}`, `${job.driveName} is blank and named ${event.label}.`);
    }
    return;
  } else if (event.type === 'error') {
    endJob('bad', 'That did not work', event.message);
    return;
  } else if (event.type === 'declined') {
    endJob('soft', 'Permission was not given', 'Nothing was changed on your drive.');
    return;
  } else if (event.type === 'cancelled') {
    endJob('soft', 'Cancelled', job.op === 'verify' ? 'Nothing was changed.' : 'The drive may be left half finished. Run it again to make it usable.');
    return;
  }
  paintJob();
});

/* ------------------------------------------------------------- drag and drop */

const drop = document.getElementById('drop');
let dragDepth = 0;
const canDrop = () => !state.job && state.view !== 'format';

window.addEventListener('dragenter', (event) => {
  event.preventDefault();
  if (!canDrop()) return;
  dragDepth++;
  drop.classList.add('is-on');
});
window.addEventListener('dragover', (event) => event.preventDefault());
window.addEventListener('dragleave', () => {
  dragDepth = Math.max(0, dragDepth - 1);
  if (!dragDepth) drop.classList.remove('is-on');
});
window.addEventListener('drop', async (event) => {
  event.preventDefault();
  dragDepth = 0;
  drop.classList.remove('is-on');
  if (!canDrop()) return;
  const file = event.dataTransfer.files[0];
  if (file) chooseImage(await api.inspectImage(api.pathForFile(file)));
});

/* ------------------------------------------------------------- updates */

const update = document.getElementById('update');
const updateFill = document.getElementById('update-fill');
const updateTitle = document.getElementById('update-title');
const updateSub = document.getElementById('update-sub');
const updateBtn = document.getElementById('update-btn');

function showUpdate(event) {
  if (!event) return;
  update.hidden = false;
  update.dataset.state = event.state;
  updateBtn.hidden = event.state !== 'available' && event.state !== 'error';
  updateBtn.disabled = !!state.job;
  if (event.state === 'available') {
    updateTitle.textContent = `Version ${event.version} is out`;
    updateSub.textContent = 'Updates in a few seconds.';
    updateBtn.textContent = 'Update';
    updateFill.style.transform = 'scaleX(0)';
  } else if (event.state === 'downloading') {
    updateTitle.textContent = 'Downloading update';
    updateSub.textContent = `${Math.round((event.fraction || 0) * 100)}%`;
    updateFill.style.transform = `scaleX(${event.fraction || 0})`;
  } else if (event.state === 'installing') {
    updateTitle.textContent = 'Restarting';
    updateSub.textContent = 'Crooli Flash will reopen on its own.';
    updateFill.style.transform = 'scaleX(1)';
  } else if (event.state === 'error') {
    updateTitle.textContent = 'Update did not finish';
    updateSub.textContent = event.message || 'Try again in a moment.';
    updateBtn.textContent = 'Retry';
  }
}

updateBtn.addEventListener('click', () => api.installUpdate());
api.onUpdate(showUpdate);

/* ------------------------------------------------------------- start */

(async function init() {
  state.info = await api.info();
  document.body.classList.toggle('win', state.info.platform === 'win32');
  document.getElementById('version').textContent = `v${state.info.version}`;
  state.drives = await api.listDrives();
  api.onDrives((drives) => {
    state.drives = drives;
    if (state.driveId && !drives.some((drive) => drive.id === state.driveId)) state.driveId = null;
    if (!state.job) refresh();
  });
  buildView();
  showUpdate(await api.currentUpdate());
})();
