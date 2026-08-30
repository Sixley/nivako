import { isTauriRuntime } from "./nativeBridge";
import { loadWindowState, saveWindowState } from "./storage";

export async function restoreAndTrackWindow(): Promise<void> {
  if (!isTauriRuntime()) return;
  const { LogicalPosition, LogicalSize, availableMonitors, getCurrentWindow } = await import("@tauri-apps/api/window");
  const appWindow = getCurrentWindow();
  const stored = loadWindowState();
  if (stored) {
    const monitors = await availableMonitors();
    const visible = monitors.some((monitor) => {
      const scale = monitor.scaleFactor || 1;
      const left = monitor.position.x / scale;
      const top = monitor.position.y / scale;
      const right = left + monitor.size.width / scale;
      const bottom = top + monitor.size.height / scale;
      return stored.x + 80 >= left && stored.x <= right - 80 && stored.y + 40 >= top && stored.y <= bottom - 40;
    });
    await appWindow.setSize(new LogicalSize(Math.max(900, stored.width), Math.max(640, stored.height)));
    if (visible) await appWindow.setPosition(new LogicalPosition(stored.x, stored.y));
    if (stored.maximized) await appWindow.maximize();
  }
  let timer: number | undefined;
  const persist = (): void => {
    globalThis.clearTimeout(timer);
    timer = globalThis.setTimeout(() => void saveCurrentWindowState(), 180);
  };
  await appWindow.onMoved(persist);
  await appWindow.onResized(persist);
  await appWindow.onCloseRequested(() => void saveCurrentWindowState());
}

async function saveCurrentWindowState(): Promise<void> {
  const { getCurrentWindow } = await import("@tauri-apps/api/window");
  const appWindow = getCurrentWindow();
  const [position, size, maximized, scale] = await Promise.all([
    appWindow.outerPosition(), appWindow.outerSize(), appWindow.isMaximized(), appWindow.scaleFactor()
  ]);
  saveWindowState({
    x: Math.round(position.x / scale), y: Math.round(position.y / scale),
    width: Math.round(size.width / scale), height: Math.round(size.height / scale), maximized
  });
}
