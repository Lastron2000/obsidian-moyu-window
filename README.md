# Moyu Window

Make Obsidian's window actually transparent. The background drops out, your notes float straight over the desktop, and one key hides everything.

> *moyu* (摸鱼) is Chinese slang for slacking off at work.

## What it does

| Feature | Description |
|---|---|
| **True transparency** | Window background alpha drops to 0 — you see the real desktop, not a screenshot |
| **Reading mode** | Hides sidebar, tab bar, title bar and status bar, leaving only the note |
| **Panic key** | Global shortcut minimizes the window, works even when Obsidian is not focused |
| **Always on top** | Uses the `screen-saver` level, stays above fullscreen apps |
| **Capture protection** | Window appears black in screenshots and screen recordings |
| **Auto day/night** | Switches theme based on your wallpaper's average brightness |

## Requirements

- Obsidian desktop (Windows / macOS / Linux)
- **A one-time patch to Obsidian's application package for transparency.** Everything else works without it.

Stock Electron windows cannot be made transparent after creation — the flag is read once, when the window is constructed. Obsidian creates its window without it, so no plugin can add it later. The only way in is editing the packaged `main.js` inside `obsidian.asar`.

If you would rather not patch, leave `Wallpaper fallback` enabled in settings: the plugin then paints your desktop wallpaper behind the note, aligned to the window position. It looks the same until another window opens on the desktop.

## Install

### 1. Copy the plugin

Put `main.js`, `manifest.json` and `styles.css` into:

```
<vault>/.obsidian/plugins/moyu-window/
```

Then enable it under **Settings → Community plugins**.

### 2. Enable true transparency (optional)

The plugin folder only ships three files. Grab `scripts/patch-asar.js` from this repository, run it with Node.js:

```bash
node scripts/patch-asar.js
```

It locates the active `obsidian-*.asar`, backs it up to `.bak`, and injects three window options:

```diff
  minWidth:200, minHeight:150,
+ transparent:!0, backgroundMaterial:"none", thickFrame:!1,
  backgroundColor:"#00000000",
```

- `transparent` — allows per-pixel alpha
- `backgroundMaterial:"none"` — Electron 39 defaults to `auto`, which paints a Mica backdrop on Windows 11 and covers the transparency completely
- `thickFrame:false` — Windows adds a DWM frame otherwise, which leaks

**Obsidian updates replace the asar and undo the patch.** Re-run the script after each update. The script is idempotent — it detects an already-patched package and exits.

To revert, copy `obsidian-<version>.asar.bak` back over the original.

## Usage

The status bar gets three independent toggles:

| Toggle | Controls |
|---|---|
| **Moyu** | Transparency + always-on-top + capture protection |
| **Text** | Distraction-free mode |
| **Day / Night** | Theme |

Turn both on for text floating over the desktop.

### Commands

| Command | Default |
|---|---|
| Toggle hidden mode | `Alt+Q` |
| Minimize (panic key) | `Alt+Z` — rebindable in settings |
| Toggle reading mode | — |
| Set opacity | — |

### Settings

- Panic key (click to record a new combination)
- Auto day/night based on wallpaper brightness
- Opacity
- Always on top when enabled
- Capture protection when enabled
- Reading mode
- Wallpaper fallback
- Enter hidden mode on startup

## How transparency works

The plugin does three things at once:

1. **Window layer** — the asar patch above. Without it, nothing else can reveal the desktop.
2. **Content layer** — CSS clears background colors on `html`, `body` and every layout container, keeping text and borders where they carry meaning. Scrollbars are excluded so long notes stay draggable.
3. **Interaction layer** — an Electron `globalShortcut` for the panic key, plus `setAlwaysOnTop('screen-saver')` so the window beats fullscreen players.

Verified by counting the alpha channel of `webContents.capturePage()` output:

| State | Transparent pixels |
|---|---|
| Idle | 0% |
| Hidden mode | 89.5% |
| Hidden + reading mode | 90.7% |

## Limitations

- **Transparency needs the asar patch.** Without it, the plugin degrades to the wallpaper approximation.
- **Mouse-leave auto-hide is not implemented.** A renderer process receives no pointer events once the window loses focus; doing it properly needs an OS-level hook.
- **Per-pixel opacity is not implemented.** `setOpacity` has no visible effect on this window configuration.
- Reading mode hides the status bar's neighbours but keeps the status bar itself, so there is always a visible way out.

## License

MIT
