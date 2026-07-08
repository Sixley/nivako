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

async function tauriInvoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  const api = await import("@tauri-apps/api/core");
  return (api.invoke as Invoke)<T>(command, args);
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
  return tauriInvoke<NativeSipStatus>("sip_register", {
    sipServer: settings.sipServer,
    sipExtension: settings.sipExtension,
    sipAuthUser: settings.sipAuthUser || settings.sipExtension,
    displayName: settings.sipDisplayName,
    password: password || null
  });
}

export async function getSipStatusNative(): Promise<NativeSipSnapshot> {
  return tauriInvoke<NativeSipSnapshot>("sip_status");
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
