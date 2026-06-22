// Startup + shell-lifecycle bridges. Method names + ToWeb callbacks follow the
// decompiled WinRT interface tables (catalog / docs 30, 32). The bundle opens its
// OWN pairing WebSocket, so ConnectionBridge stays passive (it only matters for
// suspend/resume + push, post-login).

import { app, Notification } from 'electron';
import type { BridgeFactory, BridgeContext } from '../types';
import { toWeb } from '../eventtarget';
import { appIcon } from '../../icon';
import { playTone as playToneSound, playWaTone } from '../../sound';

const LAUNCH_TS = Date.now();

// ConnectionBridge (LifecycleBridge, doc 30 §3.11): web suspend/resume + push ack.
// ToWeb: connect / disconnect / updateNotificationsToken.
function connectionBridge(): ReturnType<BridgeFactory> {
  const tw = toWeb();
  return {
    subscribe: tw.subscribe,
    changeSuspending: () => undefined,
    handleConnectionState: () => undefined,
    acknowledgeNotificationsToken: () => undefined,
  };
}

// NativeAppStateBridge (doc 30 §3.11): "normal"/"minimizedToTray" state, launch/
// restore timestamps, clock-skew. ToWeb: appStateChanged(appState).
function nativeAppStateBridge(): ReturnType<BridgeFactory> {
  const tw = toWeb();
  return {
    subscribe: tw.subscribe,
    getAppState: () => 'normal',
    takeAppLaunchTimeStamp: () => LAUNCH_TS,
    getAppRestoreTimeStamp: () => LAUNCH_TS,
    getFirstAppRestoreTimeStamp: () => LAUNCH_TS,
    getLastAppRestoreTimeStamp: () => LAUNCH_TS,
    detectNativeClockSkew: (webTs: unknown) => Date.now() - Number(webTs ?? Date.now()),
  };
}

// PreferencesBridge (doc 32 §5): small KV in the native sqlite. ToWeb: changes.
function preferencesBridge(ctx: BridgeContext): ReturnType<BridgeFactory> {
  const tw = toWeb();
  const db = () => {
    const d = ctx.nativeDb();
    d.exec('CREATE TABLE IF NOT EXISTS prefs (k TEXT PRIMARY KEY, v TEXT)');
    return d;
  };
  return {
    subscribe: tw.subscribe,
    initialize: () => undefined,
    clean: () => { db().exec('DELETE FROM prefs'); },   // wipe on logout/reset
    updateLocalSetting: (key: string, value: unknown) => {
      db().prepare('INSERT INTO prefs(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v')
        .run(String(key), JSON.stringify(value ?? null));
      tw.call('localSettingChanged', key, value);
    },
    getLocalSetting: (key: string) => {
      const row = db().prepare('SELECT v FROM prefs WHERE k=?').get(String(key)) as { v: string } | undefined;
      if (!row) return null;
      try { return JSON.parse(row.v); } catch { return null; }   // corrupt value reads as absent, not a bridge error
    },
  };
}

// SystemIntegrationsBridge (doc 30 §3, catalog #21): native toasts, taskbar badge,
// startup task, screen/tone hints. ToWeb: messageNotificationAction(args).
function systemIntegrationsBridge(): ReturnType<BridgeFactory> {
  const tw = toWeb();
  const open = new Map<string, Notification>();
  return {
    subscribe: tw.subscribe,
    showMessageNotification: (
      key: string, tag: string, header: string, body: string,
      thumbnailPath: string, _footer: string, _ctxMenu: string[], _ctxIds: string[],
      _replyPlaceholder: string, _replyButton: string, suppressToast: boolean,
    ) => {
      if (suppressToast || !Notification.isSupported()) return;
      // Branded WA icon when the message has no avatar; toast is silent because we
      // play the real WhatsApp tone ourselves (sound.ts) — matches the native client.
      const n = new Notification({ title: header || 'WhatsApp', body: body || '', icon: thumbnailPath || appIcon(), silent: true });
      // ponytail: reply/context actions need libnotify action wiring — basic toast now.
      n.on('click', () => tw.call('messageNotificationAction', { tag: tag || key, action: 'open', additionalData: '' }));
      n.show();
      playWaTone();
      open.set(`${key}|${tag}`, n);
    },
    closeMessageNotification: (key: string, tag: string) => {
      const k = `${key}|${tag}`;
      open.get(k)?.close();
      open.delete(k);
    },
    isNotificationEnabledInSystem: async () => Notification.isSupported(),
    updateTaskbarBadge: (count: unknown) => app.setBadgeCount(Number(count) || 0),
    getStartupTaskState: async () => (app.getLoginItemSettings().openAtLogin ? 'enabled' : 'disabled'),
    updateStartupTask: (enabled: unknown) => app.setLoginItemSettings({ openAtLogin: !!enabled }),
    updateCurrentWebAppScreen: () => undefined,   // jumplist hint — no-op on Linux
    playTone: (toneId: unknown) => playToneSound(Number(toneId)),
  };
}

// WebUpdateBridge (doc 30 §3.12): JS reports its bundle revision. One-way.
function webUpdateBridge(ctx: BridgeContext): ReturnType<BridgeFactory> {
  let revision = '';
  return {
    updateWebRevision: (rev: unknown) => { revision = String(rev ?? ''); ctx.log('web revision', revision); },
    getWebRevision: () => revision,
  };
}

// BrowserExtensionsBridge — Windows Zoom WebView2 extension. No Linux equivalent.
// ponytail: report not-bootstrapped, no-op install/remove/enable.
function browserExtensionsBridge(): ReturnType<BridgeFactory> {
  return {
    hasBootstrappedSuccessfully: () => false,
    installZoomBrowserExtensionAsync: async () => false,
    enableBrowserExtensionAsync: async () => false,
    removeBrowserExtensionAsync: async () => true,
  };
}

// SeamlessMigrationBridge — account migration + logout plumbing. executeLogout is
// destructive (App.Restart(UserLogout)); it can be probed at startup, so only
// clear secrets here and let the bundle drive any restart.
function seamlessMigrationBridge(ctx: BridgeContext): ReturnType<BridgeFactory> {
  const tw = toWeb();
  return {
    subscribe: tw.subscribe,
    executeLogout: () => { ctx.secretDel('clientKey'); ctx.secretDel('serverEncKeySalt'); },
    requestFilesCleanup: () => undefined,
    isMigrationAvailable: () => false,
  };
}

export const bridges: Record<string, BridgeFactory> = {
  ConnectionBridge: () => connectionBridge(),
  NativeAppStateBridge: () => nativeAppStateBridge(),
  PreferencesBridge: (ctx) => preferencesBridge(ctx),
  SystemIntegrationsBridge: () => systemIntegrationsBridge(),
  WebUpdateBridge: (ctx) => webUpdateBridge(ctx),
  BrowserExtensionsBridge: () => browserExtensionsBridge(),
  SeamlessMigrationBridge: (ctx) => seamlessMigrationBridge(ctx),
};
