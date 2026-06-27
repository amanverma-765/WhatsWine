// Minimal in-app screen-share source picker for getDisplayMedia.
//
// Electron 42's setDisplayMediaRequestHandler { useSystemPicker } is macOS-15-only, so on
// Linux WE must enumerate sources and choose. On X11 desktopCapturer returns every screen +
// window (full choice needs a picker). On Wayland it returns a single PipeWire placeholder and
// the OS portal does the real pick — so we auto-pass a lone source straight through.

import { BrowserWindow, desktopCapturer, ipcMain } from 'electron';

const PICK_CHANNEL = 'wwine:screen-pick';

/**
 * Show the picker and resolve the chosen capture source, or null if the user cancelled
 * (or there is nothing to capture). Resolving null lets the caller deny getDisplayMedia,
 * which rejects with NotAllowedError in the page — the call keeps running.
 */
export async function pickDisplaySource(
  parent: BrowserWindow,
): Promise<Electron.DesktopCapturerSource | null> {
  const sources = await desktopCapturer.getSources({
    types: ['screen', 'window'],
    thumbnailSize: { width: 320, height: 180 },
    fetchWindowIcons: true,
  });
  if (sources.length === 0) return null;
  // One source → no point showing a 1-button dialog. On Wayland this is the portal
  // placeholder; the GNOME/KDE portal dialog then does the real screen/window pick.
  if (sources.length === 1) return sources[0];

  const items = sources.map((s) => ({
    id: s.id,
    name: s.name,
    thumb: s.thumbnail.toDataURL(),
    icon: s.appIcon ? s.appIcon.toDataURL() : '',
    isScreen: s.id.startsWith('screen:'),
  }));

  const picker = new BrowserWindow({
    parent,
    modal: true,
    width: 760,
    height: 560,
    title: 'Choose what to share',
    autoHideMenuBar: true,
    minimizable: false,
    maximizable: false,
    backgroundColor: '#111b21',
    webPreferences: {
      // ponytail: local trusted data-URL chooser (no remote content ever loads here), so
      // nodeIntegration/contextIsolation-off lets the inline script use ipcRenderer directly
      // and avoids adding a second vite preload build entry. Upgrade to a dedicated preload
      // if this window ever loads anything but the data URL below.
      nodeIntegration: true,
      contextIsolation: false,
    },
  });

  return new Promise((resolve) => {
    let settled = false;
    const finish = (id: string | null) => {
      if (settled) return;
      settled = true;
      ipcMain.removeListener(PICK_CHANNEL, onPick);
      const chosen = id ? sources.find((s) => s.id === id) ?? null : null;
      if (!picker.isDestroyed()) picker.close();
      resolve(chosen);
    };
    const onPick = (e: Electron.IpcMainEvent, id: string | null) => {
      if (e.sender === picker.webContents) finish(id);
    };
    ipcMain.on(PICK_CHANNEL, onPick);
    picker.on('closed', () => finish(null)); // window-frame close / Esc → cancel

    picker.loadURL(pickerHtml(items, PICK_CHANNEL)).catch(() => finish(null));
  });
}

// Self-contained picker page as a data: URL. Renders the thumbnails in a grid and sends the
// chosen source id (or null on cancel) back over IPC. JSON is embedded, not interpolated into
// markup, so window titles can't break out of the HTML.
function pickerHtml(
  items: Array<{ id: string; name: string; thumb: string; icon: string; isScreen: boolean }>,
  channel: string,
): string {
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>
  :root { color-scheme: dark; }
  body { margin:0; font:14px system-ui,sans-serif; background:#111b21; color:#e9edef;
         display:flex; flex-direction:column; height:100vh; }
  h1 { font-size:15px; font-weight:600; margin:0; padding:14px 18px; border-bottom:1px solid #222d34; }
  .grid { flex:1; overflow:auto; display:grid; gap:12px; padding:16px;
          grid-template-columns:repeat(auto-fill,minmax(210px,1fr)); align-content:start; }
  .card { background:#202c33; border:2px solid transparent; border-radius:8px; padding:8px;
          cursor:pointer; display:flex; flex-direction:column; gap:8px; text-align:left; }
  .card:hover { border-color:#2a3942; background:#2a3942; }
  .card.sel { border-color:#00a884; }
  .card img.t { width:100%; aspect-ratio:16/9; object-fit:contain; background:#0b141a; border-radius:4px; }
  .label { display:flex; align-items:center; gap:6px; min-width:0; }
  .label img { width:16px; height:16px; flex:none; }
  .label span { white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .bar { padding:12px 18px; border-top:1px solid #222d34; display:flex; justify-content:flex-end; gap:10px; }
  button { font:inherit; padding:8px 18px; border-radius:6px; border:0; cursor:pointer; }
  #share { background:#00a884; color:#0b141a; font-weight:600; } #share:disabled { opacity:.4; cursor:default; }
  #cancel { background:#2a3942; color:#e9edef; }
  </style></head><body>
  <h1>Choose what to share</h1>
  <div class="grid" id="grid"></div>
  <div class="bar"><button id="cancel">Cancel</button><button id="share" disabled>Share</button></div>
  <script>
  const { ipcRenderer } = require('electron');
  const CH = ${JSON.stringify(channel)};
  const items = ${JSON.stringify(items)};
  let selected = null;
  const grid = document.getElementById('grid');
  const shareBtn = document.getElementById('share');
  const send = (id) => ipcRenderer.send(CH, id);
  for (const it of items) {
    const card = document.createElement('div');
    card.className = 'card';
    const label = it.icon
      ? '<div class="label"><img src="'+it.icon+'"><span></span></div>'
      : '<div class="label"><span></span></div>';
    card.innerHTML = '<img class="t" src="'+it.thumb+'">'+label;
    card.querySelector('.label span').textContent = it.name;
    card.onclick = () => {
      document.querySelectorAll('.card.sel').forEach(c => c.classList.remove('sel'));
      card.classList.add('sel'); selected = it.id; shareBtn.disabled = false;
    };
    card.ondblclick = () => send(it.id);
    grid.appendChild(card);
  }
  shareBtn.onclick = () => selected && send(selected);
  document.getElementById('cancel').onclick = () => send(null);
  window.addEventListener('keydown', (e) => { if (e.key === 'Escape') send(null); });
  </script></body></html>`;
  return 'data:text/html;charset=utf-8,' + encodeURIComponent(html);
}
