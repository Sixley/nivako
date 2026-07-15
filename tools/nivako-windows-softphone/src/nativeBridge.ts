import { parseCardDavMultistatus, parseVCard } from "./carddav";
import type { Contact, NativeSipSnapshot, NativeSipStatus, Settings } from "./types";

type Invoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;

interface CardDavSyncResult {
  xml: string;
  url: string;
  vcard_count: number;
  tried: string[];
}

let lastCardDavDiagnostic = "";
const nativeSipTimeoutMs = 15000;

async function tauriInvoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  const api = await import("@tauri-apps/api/core");
  return (api.invoke as Invoke)<T>(command, args);
}

async function tauriInvokeWithTimeout<T>(
  command: string,
  args: Record<string, unknown> | undefined,
  timeoutMs: number,
  timeoutMessage: string
): Promise<T> {
  let timer: number | undefined;
  try {
    return await Promise.race([
      tauriInvoke<T>(command, args),
      new Promise<T>((_, reject) => {
        timer = window.setTimeout(() => reject(new Error(timeoutMessage)), timeoutMs);
      })
    ]);
  } finally {
    if (timer !== undefined) window.clearTimeout(timer);
  }
}

export function isTauriRuntime(): boolean {
  return "__TAURI_INTERNALS__" in window;
}

export function getLastCardDavDiagnostic(): string {
  return lastCardDavDiagnostic;
}

export async function syncCardDavNative(settings: Settings, password?: string): Promise<Contact[]> {
  const result = await tauriInvoke<CardDavSyncResult>("sync_carddav", {
    url: settings.cardDavUrl,
    username: settings.cardDavUser,
    password: password || null
  });

  lastCardDavDiagnostic = `native URL ${result.url}; ${result.vcard_count} vCards; ${result.tried.length} Pfad(e) getestet`;
  return parseCardDavMultistatus(result.xml).map((resource) => parseVCard(resource.vcard, resource.href));
}

export async function saveSecretNative(service: string, account: string, password: string): Promise<void> {
  await tauriInvoke<void>("save_secret", { service, account, password });
}

export async function hasSecretNative(service: string, account: string): Promise<boolean> {
  return tauriInvoke<boolean>("has_secret", { service, account });
}

export async function loadSecretNative(service: string, account: string): Promise<string | null> {
  return tauriInvoke<string | null>("get_secret", { service, account });
}

export async function registerSipNative(settings: Settings, password?: string): Promise<NativeSipStatus> {
  return tauriInvokeWithTimeout<NativeSipStatus>("sip_register", {
    sipServer: settings.sipServer,
    sipExtension: settings.sipExtension,
    sipAuthUser: settings.sipAuthUser || settings.sipExtension,
    displayName: settings.sipDisplayName,
    password: password || null
  }, nativeSipTimeoutMs, "SIP-Registrierung antwortet nicht innerhalb von 15 Sekunden.");
}

export async function getSipStatusNative(): Promise<NativeSipSnapshot> {
  return tauriInvokeWithTimeout<NativeSipSnapshot>("sip_status", undefined, 5000, "SIP-Status antwortet nicht innerhalb von 5 Sekunden.");
}

export async function dialNative(number: string, settings: Settings): Promise<NativeSipStatus> {
  return tauriInvokeWithTimeout<NativeSipStatus>("sip_dial", {
    number,
    sipServer: settings.sipServer,
    sipExtension: settings.sipExtension
  }, nativeSipTimeoutMs, "Nativer SIP-Anruf antwortet nicht innerhalb von 15 Sekunden.");
}

export async function acceptNative(): Promise<NativeSipStatus> {
  return tauriInvokeWithTimeout<NativeSipStatus>("sip_accept", undefined, nativeSipTimeoutMs, "Annehmen antwortet nicht innerhalb von 15 Sekunden.");
}

export async function hangupNative(): Promise<NativeSipStatus> {
  return tauriInvokeWithTimeout<NativeSipStatus>("sip_hangup", undefined, nativeSipTimeoutMs, "Auflegen antwortet nicht innerhalb von 15 Sekunden.");
}

export async function holdNative(): Promise<NativeSipStatus> {
  return tauriInvokeWithTimeout<NativeSipStatus>("sip_hold", undefined, nativeSipTimeoutMs, "Halten antwortet nicht innerhalb von 15 Sekunden.");
}

export async function muteNative(muted: boolean): Promise<NativeSipStatus> {
  return tauriInvokeWithTimeout<NativeSipStatus>("sip_mute", { muted }, nativeSipTimeoutMs, "Stummschalten antwortet nicht innerhalb von 15 Sekunden.");
}

export async function sendDtmfNative(digit: string): Promise<NativeSipStatus> {
  return tauriInvokeWithTimeout<NativeSipStatus>("sip_dtmf", { digit }, nativeSipTimeoutMs, "DTMF antwortet nicht innerhalb von 15 Sekunden.");
}

export async function setRingVolumeNative(volume: number): Promise<NativeSipStatus> {
  return tauriInvokeWithTimeout<NativeSipStatus>("sip_set_ring_volume", { volume }, nativeSipTimeoutMs, "Klingeltonlautstaerke konnte nicht gesetzt werden.");
}

export async function showIncomingCallWindow(name: string, number: string, volume: number): Promise<void> {
  await tauriInvoke<void>("show_incoming_call_window", { name, number, volume });
}
export async function closeIncomingCallWindow(): Promise<void> { await tauriInvoke<void>("close_incoming_call_window"); }
