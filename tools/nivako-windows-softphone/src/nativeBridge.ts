import { parseCardDavMultistatus, parseVCard } from "./carddav";
import type { Contact, NativeSipStatus, Settings } from "./types";

type Invoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;

async function tauriInvoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  const api = await import("@tauri-apps/api/core");
  return (api.invoke as Invoke)<T>(command, args);
}

export function isTauriRuntime(): boolean {
  return "__TAURI_INTERNALS__" in window;
}

export async function syncCardDavNative(settings: Settings): Promise<Contact[]> {
  const xml = await tauriInvoke<string>("sync_carddav", {
    url: settings.cardDavUrl,
    username: settings.cardDavUser
  });

  return parseCardDavMultistatus(xml).map((resource) => parseVCard(resource.vcard, resource.href));
}

export async function saveSecretNative(service: string, account: string, password: string): Promise<void> {
  await tauriInvoke<void>("save_secret", { service, account, password });
}

export async function hasSecretNative(service: string, account: string): Promise<boolean> {
  return tauriInvoke<boolean>("has_secret", { service, account });
}

export async function registerSipNative(settings: Settings): Promise<NativeSipStatus> {
  return tauriInvoke<NativeSipStatus>("sip_register", {
    sipServer: settings.sipServer,
    sipExtension: settings.sipExtension,
    displayName: settings.sipDisplayName
  });
}

export async function dialNative(number: string, settings: Settings): Promise<NativeSipStatus> {
  return tauriInvoke<NativeSipStatus>("sip_dial", {
    number,
    sipServer: settings.sipServer,
    sipExtension: settings.sipExtension
  });
}

export async function hangupNative(): Promise<NativeSipStatus> {
  return tauriInvoke<NativeSipStatus>("sip_hangup");
}

export async function holdNative(): Promise<NativeSipStatus> {
  return tauriInvoke<NativeSipStatus>("sip_hold");
}

export async function muteNative(muted: boolean): Promise<NativeSipStatus> {
  return tauriInvoke<NativeSipStatus>("sip_mute", { muted });
}

export async function sendDtmfNative(digit: string): Promise<NativeSipStatus> {
  return tauriInvoke<NativeSipStatus>("sip_dtmf", { digit });
}
