import type { CallEntry, Contact, Settings } from "./types";

const keys = {
  contacts: "nivako-softphone.contacts",
  history: "nivako-softphone.history",
  favorites: "nivako-softphone.favorites",
  settings: "nivako-softphone.settings"
};

function readJson<T>(key: string, fallback: T): T {
  const raw = localStorage.getItem(key);
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function writeJson<T>(key: string, value: T): void {
  localStorage.setItem(key, JSON.stringify(value));
}

export function loadContacts(fallback: Contact[]): Contact[] {
  return readJson(keys.contacts, fallback);
}

export function saveContacts(contacts: Contact[]): void {
  writeJson(keys.contacts, contacts);
}

export function loadHistory(): CallEntry[] {
  return readJson(keys.history, []);
}

export function saveHistory(history: CallEntry[]): void {
  writeJson(keys.history, history.slice(0, 100));
}

export function loadFavoriteIds(): string[] {
  return readJson(keys.favorites, []);
}

export function saveFavoriteIds(ids: string[]): void {
  writeJson(keys.favorites, ids);
}

export function loadSettings(defaults: Settings): Settings {
  return { ...defaults, ...readJson(keys.settings, {}) };
}

export function saveSettings(settings: Settings): void {
  writeJson(keys.settings, settings);
}
