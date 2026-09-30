// Phone-only features via Capacitor plugins. In a desktop browser each function falls back
// to the web behaviour or does nothing, so callers never need to check the platform.
import { App } from "@capacitor/app";
import { Capacitor } from "@capacitor/core";
import { Directory, Encoding, Filesystem } from "@capacitor/filesystem";
import { Haptics, ImpactStyle } from "@capacitor/haptics";
import { LocalNotifications } from "@capacitor/local-notifications";
import { Share } from "@capacitor/share";

export const isNative = Capacitor.isNativePlatform();

/**
 * Android back button: close an open sheet, else go back a screen, else (on Today) leave the app.
 * Uses the page's own history: the WebView's canGoBack doesn't count in-app route (#) changes.
 */
export function initBackButton() {
  if (!isNative) return;
  void App.addListener("backButton", () => {
    const open = [...document.querySelectorAll<HTMLDialogElement>("dialog[open]")].at(-1);
    if (open) open.close();
    else if (!location.hash || location.hash === "#/day") void App.exitApp();
    else if (history.length > 1) history.back();
    else location.hash = "#/day";
  });
}

/** Save an exported file: a download in a browser; the share sheet (Files, Drive, ...) on a phone. */
export async function saveFile(name: string, contents: string, type: string): Promise<void> {
  if (isNative) {
    const { uri } = await Filesystem.writeFile({ path: name, data: contents, directory: Directory.Cache, encoding: Encoding.UTF8 });
    await Share.share({ title: name, url: uri, dialogTitle: "Save your FitApp backup" });
    return;
  }
  const url = URL.createObjectURL(new Blob([contents], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** A short tap of vibration (set checked off). */
export function tapHaptic() {
  if (isNative) void Haptics.impact({ style: ImpactStyle.Light }).catch(() => {});
}

/** The rest-over buzz: native vibration on a phone, the Vibration API elsewhere. */
export function alarmHaptic() {
  if (isNative) void Haptics.vibrate({ duration: 600 }).catch(() => {});
  else navigator.vibrate?.([200, 100, 200, 100, 200]);
}

// ---------- rest timer notification ----------
// Scheduled only while the app is in the background (a phone can't run the in-app alarm then)
// and cancelled when it comes back, so the in-app alarm and the notification never both fire.
const REST_NOTIFICATION = 1;

export async function scheduleRestAlarm(endsAt: number): Promise<void> {
  if (!isNative || endsAt <= Date.now()) return;
  try {
    let { display } = await LocalNotifications.checkPermissions();
    if (display === "prompt" || display === "prompt-with-rationale") ({ display } = await LocalNotifications.requestPermissions());
    if (display !== "granted") return;
    await LocalNotifications.schedule({
      notifications: [{
        id: REST_NOTIFICATION,
        title: "Rest over",
        body: "Time for your next set.",
        schedule: { at: new Date(endsAt), allowWhileIdle: true },
      }],
    });
  } catch (e) {
    console.warn("Couldn't schedule the rest alarm", e);
  }
}

export async function cancelRestAlarm(): Promise<void> {
  if (!isNative) return;
  try {
    await LocalNotifications.cancel({ notifications: [{ id: REST_NOTIFICATION }] });
  } catch {
    /* nothing scheduled */
  }
}

/** Ask for notification permission ahead of time (the first rest timer start), so it isn't asked mid-rest. */
export async function prepareRestAlarms(): Promise<void> {
  if (!isNative) return;
  try {
    const { display } = await LocalNotifications.checkPermissions();
    if (display === "prompt" || display === "prompt-with-rationale") await LocalNotifications.requestPermissions();
  } catch {
    /* not critical */
  }
}
