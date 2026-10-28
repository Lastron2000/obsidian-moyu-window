'use strict';

const { Plugin, PluginSettingTab, Setting, Notice, Modal } = require('obsidian');

const CSS_CLASS = 'moyu-hidden';

const DEFAULT_SETTINGS = {
  opacity: 100,
  alwaysOnTop: true,
  contentProtection: false,
  autoEnableOnStart: false,
  bossKey: 'Alt+Z',
  pureReading: false,
  wallpaperFallback: false,
  autoTheme: true,
  themeMode: '',
};

/* 把 keydown 事件翻译成 Electron 认可的 accelerator，比如 "Alt+Shift+Z"。
 * 必须有至少一个修饰键，否则会抢走普通打字。 */
function toAccelerator(evt) {
  const mods = [];
  if (evt.ctrlKey) mods.push('Control');
  if (evt.altKey) mods.push('Alt');
  if (evt.shiftKey) mods.push('Shift');
  if (evt.metaKey) mods.push('Super');

  const k = evt.key;
  if (!k) return null;
  if (k === 'Control' || k === 'Alt' || k === 'Shift' || k === 'Meta') return null;
  if (k === 'Escape') return null;
  if (mods.length === 0) return null;

  let key = k;
  if (k.length === 1) key = k.toUpperCase();
  else if (k === ' ') key = 'Space';
  else if (k === 'ArrowUp') key = 'Up';
  else if (k === 'ArrowDown') key = 'Down';
  else if (k === 'ArrowLeft') key = 'Left';
  else if (k === 'ArrowRight') key = 'Right';

  return mods.concat([key]).join('+');
}

/* ------------------------------------------------------------------ 窗口通道
 * Obsidian 内置了 @electron/remote（app.asar/main.js 第 9-12 行注册的），
 * 所以渲染进程能拿主进程的窗口对象。三种取法按可靠性排序，逐个试。
 */
function getRemote() {
  try {
    const r = require('@electron/remote');
    if (r && typeof r.getCurrentWindow === 'function') return r;
  } catch (err) { /* 下一条 */ }

  try {
    const e = require('electron');
    if (e && e.remote && typeof e.remote.getCurrentWindow === 'function') return e.remote;
  } catch (err) { /* 下一条 */ }

  return null;
}

function getWin() {
  const remote = getRemote();
  if (remote) {
    try {
      const w = remote.getCurrentWindow();
      if (w && typeof w.setOpacity === 'function') return w;
    } catch (err) { /* 下一条 */ }
    try {
      const w = remote.BrowserWindow.getFocusedWindow();
      if (w && typeof w.setOpacity === 'function') return w;
    } catch (err) { /* 下一条 */ }
  }

  try {
    const e = require('electron');
    if (e && e.BrowserWindow && typeof e.BrowserWindow.getFocusedWindow === 'function') {
      const w = e.BrowserWindow.getFocusedWindow();
      if (w && typeof w.setOpacity === 'function') return w;
    }
  } catch (err) { /* ignore */ }

  return null;
}

function getGlobalShortcut() {
  const remote = getRemote();
  if (remote && remote.globalShortcut) {
    try {
      if (typeof remote.globalShortcut.register === 'function') return remote.globalShortcut;
    } catch (err) { /* ignore */ }
  }
  try {
    const e = require('electron');
    if (e && e.globalShortcut && typeof e.globalShortcut.register === 'function') return e.globalShortcut;
  } catch (err) { /* ignore */ }
  return null;
}

/* ------------------------------------------------------------------ 插件主体 */

class MoyuWindowPlugin extends Plugin {
  async onload() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    this.active = false;
    this.pure = false;
    this.exitEl = null;
    this.registeredAccel = null;
    this.bossKeyOk = false;
    this.bossKeyError = '';
    this.domFallbackInstalled = false;
    this.autoThemeApplied = false;
    this.prevTheme = null;

    /* 状态栏三个独立开关，各管各的，不再挤在一个按钮上 */
    this.statusEl = this.addStatusBarItem();
    this.statusEl.addClass('moyu-status', 'moyu-status-mode');
    this.statusEl.addEventListener('click', () => this.toggle());

    this.pureEl = this.addStatusBarItem();
    this.pureEl.addClass('moyu-status', 'moyu-status-pure');
    this.pureEl.addEventListener('click', () => this.togglePure());

    this.themeEl = this.addStatusBarItem();
    this.themeEl.addClass('moyu-status', 'moyu-status-theme');
    this.themeEl.addEventListener('click', () => this.toggleTheme());

    this.renderStatus();

    this.addCommand({
      id: 'toggle',
      name: '切换隐身模式',
      callback: () => this.toggle(),
    });

    this.addCommand({
      id: 'enable',
      name: '开启隐身模式',
      callback: () => this.enable(),
    });

    this.addCommand({
      id: 'disable',
      name: '关闭隐身模式',
      callback: () => this.disable(),
    });

    this.addCommand({
      id: 'toggle-always-on-top',
      name: '只切换置顶',
      callback: () => this.toggleAlwaysOnTop(),
    });

    this.addCommand({
      id: 'toggle-protect',
      name: '只切换防截屏',
      callback: () => this.toggleProtect(),
    });

    this.addCommand({
      id: 'toggle-pure',
      name: '纯文字模式（藏掉所有界面，只留正文）',
      callback: () => this.togglePure(),
    });

    this.addCommand({
      id: 'opacity',
      name: '调不透明度',
      callback: () => new OpacityModal(this.app, this).open(),
    });

    this.addCommand({
      id: 'minimize',
      name: '老板键：最小化 / 恢复',
      callback: () => this.toggleMinimize(),
    });

    this.addSettingTab(new MoyuSettingTab(this.app, this));

    /* 全局老板键：能拿到 globalShortcut 就注册真的，拿不到退化成窗口内热键 */
    this.setupBossKey();

    if (this.settings.autoEnableOnStart) {
      this.app.workspace.onLayoutReady(() => {
        setTimeout(() => this.enable(true), 800);
      });
    }
    // 纯文字模式不跨会话持久化，避免启动后缺少可见出口。
  }

  onunload() {
    document.body.classList.remove(CSS_CLASS, 'moyu-pure');
    this.hideExitButton();
    this.clearWallpaper();
    this.releaseBossKey();
    const win = getWin();
    if (win) {
      try { win.setOpacity(1); } catch (err) { /* ignore */ }
      try { win.setAlwaysOnTop(false); } catch (err) { /* ignore */ }
      try { win.setContentProtection(false); } catch (err) { /* ignore */ }
    }
  }

  /* ------------------------------------------------------------ 开关 */

  async toggle() {
    if (this.active) return this.disable();
    return this.enable();
  }

  async enable(silent) {
    if (this.active) return;

    document.body.classList.add(CSS_CLASS);

    // 窗口已通过 asar 补丁开启 transparent，背景 alpha 归零，透出真实桌面。
    // applyWallpaper 作为降级方案保留：补丁失效时可用壁纸垫底。
    if (this.settings.wallpaperFallback) this.applyWallpaper();

    // 透明之后桌面会露出来，跟着桌面明暗换深浅色，否则深色桌面上黑字看不清
    this.applyAutoTheme();

    const win = getWin();
    if (win) {
      // 不调用 setBackgroundColor('#00000000')：非 transparent 窗口会丢弃
      // alpha 通道并读回 #000000。透明能力在窗口创建时确定，运行时无法追加。

      if (this.settings.alwaysOnTop) {
        try { win.setAlwaysOnTop(true, 'screen-saver'); } catch (err) { /* ignore */ }
      }
      if (this.settings.contentProtection) {
        try { win.setContentProtection(true); } catch (err) { /* ignore */ }
      }
      try {
        win.setOpacity(Math.max(0.01, this.settings.opacity / 100));
      } catch (err) { /* ignore */ }
    }

    this.active = true;
    this.renderStatus();

    if (!silent) {
      if (!win) {
        new Notice('拿不到窗口对象，只改了样式。置顶、防截屏、老板键都不可用。', 6000);
      } else {
        new Notice('隐身模式：开　' + this.bossKeyHint(), 3000);
      }
    }
  }

  async disable() {
    if (!this.active) return;

    document.body.classList.remove(CSS_CLASS);
    this.clearWallpaper();
    this.restoreAutoTheme();

    const win = getWin();
    if (win) {
      try { win.setAlwaysOnTop(false); } catch (err) { /* ignore */ }
      try { win.setContentProtection(false); } catch (err) { /* ignore */ }
      try { win.setOpacity(1); } catch (err) { /* ignore */ }
    }

    this.active = false;
    this.renderStatus();
    new Notice('隐身模式：关', 2000);
  }

  async toggleAlwaysOnTop() {
    const win = getWin();
    if (!win) { new Notice('拿不到窗口对象，置顶不可用。'); return; }
    const next = !this.settings.alwaysOnTop;
    this.settings.alwaysOnTop = next;
    await this.saveData(this.settings);
    try { win.setAlwaysOnTop(next, next ? 'screen-saver' : 'normal'); } catch (err) { /* ignore */ }
    new Notice(next ? '置顶：开' : '置顶：关');
  }

  async toggleProtect() {
    const win = getWin();
    if (!win) { new Notice('拿不到窗口对象，防截屏不可用。'); return; }
    const next = !this.settings.contentProtection;
    this.settings.contentProtection = next;
    await this.saveData(this.settings);
    try { win.setContentProtection(next); } catch (err) { /* ignore */ }
    new Notice(next ? '防截屏：开（截图里显示为黑块）' : '防截屏：关');
  }

  async setOpacity(percent) {
    this.settings.opacity = Math.max(10, Math.min(100, Math.round(percent)));
    await this.saveData(this.settings);
    const win = getWin();
    if (win) {
      try { win.setOpacity(Math.max(0.01, this.settings.opacity / 100)); } catch (err) { /* ignore */ }
    }
    new Notice('不透明度：' + this.settings.opacity + '%');
  }

  toggleMinimize() {
    const win = getWin();
    if (!win) { new Notice('拿不到窗口对象。'); return; }
    try {
      if (win.isMinimized() || !win.isVisible()) {
        if (win.isMinimized()) win.restore();
        win.show();
        win.focus();
      } else {
        win.minimize();
      }
    } catch (err) {
      new Notice('操作失败：' + err.message);
    }
  }

  /* ------------------------------------------------------- 桌面壁纸对位 */

  loadWallpaper() {
    try {
      const { nativeImage } = require('electron');
      const remote = getRemote();
      if (!remote || !remote.screen) return null;

      const p = (process.env.APPDATA || '') + '\\Microsoft\\Windows\\Themes\\TranscodedWallpaper';
      const img = nativeImage.createFromPath(p);
      if (!img || img.isEmpty()) return null;

      const disp = remote.screen.getPrimaryDisplay();
      const d = disp.bounds;
      const k = Math.min(disp.scaleFactor || 1, 1.5);
      const resized = img.resize({
        width: Math.round(d.width * k),
        height: Math.round(d.height * k),
      });
      const b64 = resized.toJPEG(82).toString('base64');
      return { url: 'data:image/jpeg;base64,' + b64, display: d };
    } catch (err) {
      return null;
    }
  }

  applyWallpaper() {
    const wp = this.loadWallpaper();
    if (!wp) {
      this.wpBound = false;
      return false;
    }
    document.body.style.setProperty('--moyu-wp', 'url("' + wp.url + '")');
    document.body.style.setProperty('--moyu-wp-size', wp.display.width + 'px ' + wp.display.height + 'px');
    this.wpBound = true;
    this.syncWallpaperPos();
    this.bindWindowMove();
    return true;
  }

  syncWallpaperPos() {
    if (!this.wpBound) return;
    const win = getWin();
    const remote = getRemote();
    if (!win || !remote || !remote.screen) return;
    try {
      const b = win.getBounds();
      const d = remote.screen.getDisplayMatching(b).bounds;
      document.body.style.setProperty('--moyu-wp-size', d.width + 'px ' + d.height + 'px');
      document.body.style.setProperty('--moyu-wp-pos', -(b.x - d.x) + 'px ' + -(b.y - d.y) + 'px');
    } catch (err) { /* ignore */ }
  }

  bindWindowMove() {
    if (this.wpMoveBound) return;
    const win = getWin();
    if (!win || typeof win.on !== 'function') return;
    const handler = () => this.syncWallpaperPos();
    try {
      win.on('move', handler);
      win.on('resize', handler);
      this.wpMoveHandler = handler;
      this.wpMoveBound = true;
    } catch (err) { /* ignore */ }
  }

  clearWallpaper() {
    this.wpBound = false;
    document.body.style.removeProperty('--moyu-wp');
    document.body.style.removeProperty('--moyu-wp-size');
    document.body.style.removeProperty('--moyu-wp-pos');
  }

  /* ------------------------------------------------------------ 纯文字模式 */

  async togglePure(force) {
    const next = typeof force === 'boolean' ? force : !this.pure;
    this.pure = next;
    document.body.classList.toggle('moyu-pure', next);
    this.settings.pureReading = next;
    await this.saveData(this.settings);
    this.renderStatus();

    if (next) {
      this.showExitButton();
      new Notice('纯文字模式：开。\n退出走这三条任一：右上角小圆点、状态栏「摸鱼」、Ctrl+P 搜「纯文字模式」。', 8000);
    } else {
      this.hideExitButton();
      new Notice('纯文字模式：关', 2000);
    }
  }

  /* 右上角那个小圆点 —— 纯文字模式下的唯一可见出口 */
  showExitButton() {
    if (this.exitEl) return;
    const el = document.createElement('div');
    el.className = 'moyu-exit';
    el.textContent = '×';
    el.setAttribute('aria-label', '退出纯文字模式');
    el.title = '退出纯文字模式';
    el.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.togglePure(false);
    });
    document.body.appendChild(el);
    this.exitEl = el;
  }

  hideExitButton() {
    if (this.exitEl && this.exitEl.parentNode) {
      this.exitEl.parentNode.removeChild(this.exitEl);
    }
    this.exitEl = null;
  }

  /* ------------------------------------------------------------ 老板键 */

  setupBossKey() {
    this.releaseBossKey();

    const accel = (this.settings.bossKey || '').trim();
    this.bossKeyOk = false;
    this.bossKeyError = '';
    if (!accel) return;   // 用户主动关掉了

    const gs = getGlobalShortcut();
    if (!gs) {
      this.bossKeyError = '当前环境拿不到全局快捷键';
      this.installDomFallback();
      return;
    }

    try {
      const ok = gs.register(accel, () => this.toggleMinimize());
      if (ok) {
        this.registeredAccel = accel;
        this.bossKeyOk = true;
      } else {
        this.bossKeyError = accel + ' 被别的程序占用了';
        this.installDomFallback();
      }
    } catch (err) {
      this.bossKeyError = String((err && err.message) || err);
      this.installDomFallback();
    }
  }

  /* 全局注册不了时的兜底：只在窗口聚焦时生效 */
  installDomFallback() {
    if (this.domFallbackInstalled) return;
    this.domFallbackInstalled = true;
    this.registerDomEvent(document, 'keydown', (evt) => {
      if (!evt.altKey || evt.ctrlKey || evt.shiftKey || evt.metaKey) return;
      if (evt.key !== 'z' && evt.key !== 'Z') return;
      if (evt.target && evt.target.closest && evt.target.closest('.cm-editor')) return;
      evt.preventDefault();
      this.toggleMinimize();
    }, true);
  }

  releaseBossKey() {
    // 精确注销自己注册的那一个，不用 unregisterAll（会清掉别的插件的）
    const accel = this.registeredAccel;
    if (accel) {
      const gs = getGlobalShortcut();
      if (gs) {
        try { gs.unregister(accel); } catch (err) { /* ignore */ }
      }
      this.registeredAccel = null;
    }
    this.bossKeyOk = false;
  }

  async saveBossKey(accel) {
    this.settings.bossKey = accel || '';
    await this.saveData(this.settings);
    this.setupBossKey();

    if (!this.settings.bossKey) {
      new Notice('老板键已关闭。');
    } else if (this.bossKeyOk) {
      new Notice('老板键已改为 ' + this.settings.bossKey);
    } else {
      new Notice('没注册成功：' + (this.bossKeyError || '未知原因') + '\n换一个组合试试。', 6000);
    }
  }

  bossKeyHint() {
    if (this.bossKeyOk) return this.settings.bossKey + ' 最小化';
    if (!this.settings.bossKey) return '老板键已关';
    return '老板键未注册';
  }

  /* ------------------------------------------------------------ 状态栏 */

  renderStatus() {
    if (this.statusEl) {
      this.statusEl.setText(this.active ? '摸鱼 开' : '摸鱼');
      this.statusEl.toggleClass('moyu-on', this.active);
      this.statusEl.setAttribute('aria-label', this.active ? '隐身模式已开启，点此关闭' : '点此开启隐身模式');
    }
    if (this.pureEl) {
      this.pureEl.setText(this.pure ? '纯文字 开' : '纯文字');
      this.pureEl.toggleClass('moyu-on', this.pure);
      this.pureEl.setAttribute('aria-label', this.pure ? '纯文字模式已开启，点此关闭' : '点此藏起所有界面');
    }
    if (this.themeEl) {
      const dark = this.isDark();
      this.themeEl.setText(dark ? '夜' : '日');
      this.themeEl.toggleClass('moyu-dark', dark);
      this.themeEl.setAttribute('aria-label', dark ? '当前夜间模式，点此切白天' : '当前白天模式，点此切夜间');
    }
  }

  /* ------------------------------------------------------------ 白天 / 夜间 */

  isDark() {
    return document.body.classList.contains('theme-dark');
  }

  setTheme(mode) {
    try { this.app.vault.setConfig('theme', mode); } catch (err) { /* ignore */ }
    document.body.classList.remove('theme-light', 'theme-dark');
    document.body.classList.add('theme-' + mode);
    this.renderStatus();
  }

  toggleTheme() {
    const next = this.isDark() ? 'light' : 'dark';
    this.setTheme(next);
    this.settings.themeMode = next;
    this.saveData(this.settings);
    new Notice(next === 'dark' ? '夜间模式' : '白天模式', 1200);
  }

  /* 读壁纸平均亮度，决定隐身时该用浅字还是深字 */
  wallpaperLuminance() {
    try {
      const { nativeImage } = require('electron');
      const p = (process.env.APPDATA || '') + '\\Microsoft\\Windows\\Themes\\TranscodedWallpaper';
      const img = nativeImage.createFromPath(p);
      if (!img || img.isEmpty()) return null;
      const one = img.resize({ width: 1, height: 1 });
      const bmp = one.toBitmap();   // BGRA
      if (!bmp || bmp.length < 4) return null;
      return (0.299 * bmp[2] + 0.587 * bmp[1] + 0.114 * bmp[0]) / 255;
    } catch (err) {
      return null;
    }
  }

  /* 隐身时自动选对比度高的那一套：亮桌面用夜(浅字)，暗桌面用日(深字) */
  applyAutoTheme() {
    if (!this.settings.autoTheme) return;
    if (this.autoThemeApplied) return;
    const lum = this.wallpaperLuminance();
    if (lum === null) return;

    this.prevTheme = this.isDark() ? 'dark' : 'light';
    // 亮桌面 → 用浅色主题（深字）；暗桌面 → 用深色主题（浅字）。
    // 取反会导致暗桌面配合深色文字，对比度不足。
    const want = lum > 0.5 ? 'light' : 'dark';
    if (want !== this.prevTheme) this.setTheme(want);
    this.autoThemeApplied = true;
  }

  restoreAutoTheme() {
    if (!this.autoThemeApplied) return;
    if (this.prevTheme) this.setTheme(this.prevTheme);
    this.autoThemeApplied = false;
    this.prevTheme = null;
  }
}

/* ------------------------------------------------------------------ 不透明度弹窗 */

class OpacityModal extends Modal {
  constructor(app, plugin) {
    super(app);
    this.plugin = plugin;
    this.value = plugin.settings.opacity;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.createEl('h3', { text: '窗口不透明度' });

    const label = contentEl.createEl('div', {
      text: this.value + '%　（100 = 完全不透明）',
      cls: 'moyu-opacity-label',
    });

    new Setting(contentEl)
      .setName('透明度')
      .addSlider((s) => s
        .setLimits(10, 100, 1)
        .setValue(this.value)
        .setDynamicTooltip()
        .onChange((v) => {
          this.value = v;
          label.setText(v + '%　（100 = 完全不透明）');
          this.plugin.setOpacity(v);
        }));
  }

  onClose() {
    this.contentEl.empty();
  }
}

/* ------------------------------------------------------------------ 设置页 */

class MoyuSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  /* 点按钮后进入录制状态，抓下一次 keydown */
  recordHotkey(btn) {
    if (this.recording) return;
    this.recording = true;
    const old = btn.textContent;
    btn.textContent = '按下组合键…';
    btn.addClass('moyu-recording');

    const cleanup = () => {
      this.recording = false;
      document.removeEventListener('keydown', handler, true);
      btn.removeClass('moyu-recording');
      btn.textContent = old;
    };

    const handler = (evt) => {
      if (evt.key === 'Escape') {
        evt.preventDefault();
        evt.stopPropagation();
        cleanup();
        return;
      }
      const accel = toAccelerator(evt);
      if (!accel) return;   // 只按了修饰键，继续等主键
      evt.preventDefault();
      evt.stopPropagation();
      cleanup();
      this.plugin.saveBossKey(accel).then(() => this.display());
    };

    document.addEventListener('keydown', handler, true);
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();

    const win = getWin();
    const gs = getGlobalShortcut();

    const box = containerEl.createDiv({ cls: 'moyu-state-box' });
    box.createDiv({
      text: win ? '窗口：已接管' : '窗口：未接管（置顶/防截屏/老板键不可用）',
      cls: win ? 'moyu-ok' : 'moyu-bad',
    });
    box.createDiv({
      text: gs ? '老板键：全局生效' : '老板键：仅窗口内生效',
      cls: gs ? 'moyu-ok' : 'moyu-bad',
    });
    box.createDiv({
      text: '背景透出桌面：Windows 上做不到（窗口建时就没开透明，运行时无解）',
      cls: 'moyu-bad',
    });

    containerEl.createEl('h3', { text: '快捷键' });

    new Setting(containerEl)
      .setName('老板键')
      .setDesc('全局生效，窗口失焦也能按。点右边的键名就能改。')
      .addButton((b) => {
        b.setButtonText(this.plugin.settings.bossKey || '未设置')
          .setTooltip('点击录制新组合键')
          .onClick(() => this.recordHotkey(b.buttonEl));
      })
      .addButton((b) => b
        .setButtonText('清除')
        .onClick(async () => {
          await this.plugin.saveBossKey('');
          this.display();
        }));

    const keyState = containerEl.createDiv({ cls: 'moyu-state-box' });
    if (this.plugin.bossKeyOk) {
      keyState.createDiv({ text: '已注册：' + this.plugin.settings.bossKey + '（全局）', cls: 'moyu-ok' });
    } else if (!this.plugin.settings.bossKey) {
      keyState.createDiv({ text: '老板键已关闭，不占用任何按键', cls: 'moyu-bad' });
    } else {
      keyState.createDiv({
        text: '注册失败：' + (this.plugin.bossKeyError || '未知') + '。换一个组合，或先关掉占用它的软件。',
        cls: 'moyu-bad',
      });
    }
    keyState.createDiv({
      text: '切换隐身默认是 Alt+Q，在 设置 → 快捷键 里搜「切换隐身模式」自己改。',
    });

    containerEl.createEl('h3', { text: '外观' });

    new Setting(containerEl)
      .setName('隐身时自动切换深浅色')
      .setDesc('按桌面壁纸的平均亮度定：亮桌面用夜间（浅字），暗桌面用白天（深字）。退出时还原。')
      .addToggle((t) => t
        .setValue(Boolean(this.plugin.settings.autoTheme))
        .onChange(async (v) => {
          this.plugin.settings.autoTheme = v;
          await this.plugin.saveData(this.plugin.settings);
        }));

    new Setting(containerEl)
      .setName('不透明度')
      .setDesc('100 = 完全不透明。90 左右在多数桌面上都看得清字。')
      .addSlider((s) => s
        .setLimits(10, 100, 1)
        .setValue(this.plugin.settings.opacity)
        .setDynamicTooltip()
        .onChange(async (v) => {
          this.plugin.settings.opacity = v;
          await this.plugin.saveData(this.plugin.settings);
          const w = getWin();
          if (w && this.plugin.active) {
            try { w.setOpacity(Math.max(0.01, v / 100)); } catch (err) { /* ignore */ }
          }
        }));

    new Setting(containerEl)
      .setName('开启时置顶')
      .setDesc('用最高层级，能压住全屏播放器和演示。')
      .addToggle((t) => t
        .setValue(this.plugin.settings.alwaysOnTop)
        .onChange(async (v) => {
          this.plugin.settings.alwaysOnTop = v;
          await this.plugin.saveData(this.plugin.settings);
          const w = getWin();
          if (w && this.plugin.active) {
            try { w.setAlwaysOnTop(v, v ? 'screen-saver' : 'normal'); } catch (err) { /* ignore */ }
          }
        }));

    new Setting(containerEl)
      .setName('开启时防截屏')
      .setDesc('截图、录屏、投屏里这个窗口显示为黑块。')
      .addToggle((t) => t
        .setValue(this.plugin.settings.contentProtection)
        .onChange(async (v) => {
          this.plugin.settings.contentProtection = v;
          await this.plugin.saveData(this.plugin.settings);
          const w = getWin();
          if (w && this.plugin.active) {
            try { w.setContentProtection(v); } catch (err) { /* ignore */ }
          }
        }));

    containerEl.createEl('h3', { text: '阅读' });

    new Setting(containerEl)
      .setName('纯文字模式')
      .setDesc('藏掉侧栏、标签页、标题栏、状态栏，只留正文。配上窗口透明就是「只显示文字」。')
      .addToggle((t) => t
        .setValue(Boolean(this.plugin.pure))
        .onChange(async (v) => {
          await this.plugin.togglePure(v);
        }));

    new Setting(containerEl)
      .setName('壁纸兜底')
      .setDesc('万一下次 Obsidian 更新把透明补丁冲掉，用桌面壁纸垫底冒充透明。平时不用开。')
      .addToggle((t) => t
        .setValue(Boolean(this.plugin.settings.wallpaperFallback))
        .onChange(async (v) => {
          this.plugin.settings.wallpaperFallback = v;
          await this.plugin.saveData(this.plugin.settings);
          if (v && this.active) this.applyWallpaper();
          if (!v) this.clearWallpaper();
        }));

    containerEl.createEl('h3', { text: '启动' });
    new Setting(containerEl)
      .setName('打开 Obsidian 时自动进入隐身')
      .setDesc('适合专用阅读库。日常写作库建议关。')
      .addToggle((t) => t
        .setValue(this.plugin.settings.autoEnableOnStart)
        .onChange(async (v) => {
          this.plugin.settings.autoEnableOnStart = v;
          await this.plugin.saveData(this.plugin.settings);
        }));

    containerEl.createEl('h3', { text: '怎么用' });

    const ul = containerEl.createEl('ul', { cls: 'moyu-help' });
    [
      '右下角状态栏点「摸鱼」两个字，开关隐身模式。',
      '命令面板搜「切换隐身模式」，可以自己去 设置 → 快捷键 绑组合键。',
      '老板键 Alt+Z：最小化 / 恢复。失焦状态下也能按。',
      '防截屏开了，截图和录屏里这个窗口是黑块。',
      '要真正透出桌面，只能在 Obsidian 之外再套一层壳，或者改 obsidian.asar。插件做不到。',
    ].forEach((t) => ul.createEl('li', { text: t }));

    new Setting(containerEl)
      .setName('恢复默认设置')
      .addButton((b) => b
        .setButtonText('恢复')
        .setWarning()
        .onClick(async () => {
          this.plugin.settings = Object.assign({}, DEFAULT_SETTINGS);
          await this.plugin.saveData(this.plugin.settings);
          this.display();
          new Notice('已恢复默认设置。');
        }));
  }
}

module.exports = MoyuWindowPlugin;
