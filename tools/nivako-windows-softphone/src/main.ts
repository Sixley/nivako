import "./styles.css";
import brandLogoUrl from "./assets/nivako-softphone-logo.png";
import { loadAudioDevices, type AudioDeviceState } from "./audioDevices";
import { parseManyVCards } from "./carddav";
import { normalizePhoneNumber } from "./phoneNumber";
import { syncCardDavContacts } from "./contactsRepository";
import { deleteCardDavContactNative, getPresenceNative, getSipStatusNative, hasSecretNative, isTauriRuntime, saveSecretNative, setMiniModeNative, writeCardDavContactNative } from "./nativeBridge";
import { canUseNativeTelephony, NativeTelephonyAdapter } from "./nativeTelephony";
import { searchContacts } from "./search";
import { loadContacts, loadFavoriteIds, loadHistory, loadSettings, saveContacts, saveFavoriteIds, saveHistory, saveSettings } from "./storage";
import { SafeTelephonyAdapter, WebRtcSipAdapter, type TelephonyAdapter } from "./telephony";
import type { CallEntry, Contact, ContactPhone, NativeSipSnapshot, PhoneLabel, Settings, SoftphoneState } from "./types";
import { restoreAndTrackWindow } from "./windowState";

const app = document.querySelector<HTMLDivElement>("#app");
if (!app) throw new Error("App root missing");
const root = app;
const cardDavRefreshMs = 15 * 60 * 1000;
const sipReconnectMs = 60 * 1000;
const sipStatusPollMs = 2000;

type View = "contacts" | "history" | "favorites" | "audio" | "settings";

const defaultSettings: Settings = {
  cardDavUrl: "https://threesix.de/remote.php/dav/addressbooks/users/hagen.bjoern@nivako.de/nivako-crm/",
  cardDavUser: "hagen.bjoern@nivako.de",
  sipServer: import.meta.env.VITE_SIP_DOMAIN || "pbx.nivako.de;transport=tcp",
  sipExtension: import.meta.env.VITE_SIP_EXTENSION || "101",
  sipAuthUser: import.meta.env.VITE_SIP_AUTH_USER || "101",
  sipWebSocketUrl: "wss://pbx.nivako.de:8089/ws",
  sipDisplayName: "NIVAKO 101",
  allowedTestNumbers: isTauriRuntime() ? "" : "101,*43",
  safeCallMode: !isTauriRuntime(),
  useTelLinks: false,
  enableWebRtcSip: false,
  selectedMicrophoneId: "",
  selectedSpeakerId: "",
  launchAtStartup: false,
  doNotDisturb: false,
  closeToTray: true,
  speakerVolume: 85,
  microphoneVolume: 70,
  ringtone: "standard",
  compactMode: false,
  parkExtension: "700",
  pickupCode: "*8",
  speedDialNumbers: "102",
  searchShortcut: "Ctrl+F",
  dialShortcut: "Ctrl+Enter",
  muteShortcut: "Ctrl+M"
};

let settings = loadSettings(defaultSettings);
settings = {
  ...settings,
  sipAuthUser: settings.sipAuthUser || settings.sipExtension
};
if (isTauriRuntime() && !localStorage.getItem("nivako-softphone.desktop-webrtc-v1")) {
  settings = {
    ...settings,
    allowedTestNumbers: settings.allowedTestNumbers === "101,*43" ? "" : settings.allowedTestNumbers,
    safeCallMode: false,
    enableWebRtcSip: true,
    sipAuthUser: settings.sipAuthUser || settings.sipExtension
  };
  saveSettings(settings);
  localStorage.setItem("nivako-softphone.desktop-webrtc-v1", "1");
}
if (isTauriRuntime() && !localStorage.getItem("nivako-softphone.desktop-native-v1")) {
  settings = {
    ...settings,
    allowedTestNumbers: "",
    safeCallMode: false,
    enableWebRtcSip: false,
    sipAuthUser: settings.sipAuthUser || settings.sipExtension
  };
  saveSettings(settings);
  localStorage.setItem("nivako-softphone.desktop-native-v1", "1");
}
if (isTauriRuntime() && !localStorage.getItem("nivako-softphone.desktop-native-tcp-v1")) {
  settings = {
    ...settings,
    sipServer: settings.sipServer === "pbx.nivako.de" ? "pbx.nivako.de;transport=tcp" : settings.sipServer,
    safeCallMode: false,
    enableWebRtcSip: false,
    sipAuthUser: settings.sipAuthUser || settings.sipExtension
  };
  saveSettings(settings);
  localStorage.setItem("nivako-softphone.desktop-native-tcp-v1", "1");
}
let telephony: TelephonyAdapter = new SafeTelephonyAdapter(() => settings.useTelLinks && !settings.safeCallMode);
let contacts = applyFavorites(loadContacts([]), loadFavoriteIds());
let callHistory = loadHistory();
let audioDevices: AudioDeviceState = { inputs: [], outputs: [], permission: "unknown" };
let sipPassword = "";
let cardDavPassword = "";
let hasStoredCardDavPassword = false;
let hasStoredSipPassword = false;
let query = "";
let historyQuery = "";
let historyFilter: "all" | CallEntry["direction"] = "all";
let activeView: View = "contacts";
let settingsOpen = false;
let appVersion = "0.9.0";
let callAction: "transfer" | "second" | null = null;
let callActionQuery = "";
let hasSecondCall = false;
let waitingCallNumber = "";
let waitingCallName = "";
let contactMenu: { contactId: string; x: number; y: number } | null = null;
let phonePicker: { contactId: string; callImmediately: boolean } | null = null;
let editingContactId: string | null = null;
let editingContactDraft: Contact | null = null;
let cardDavTimer: number | undefined;
let sipReconnectTimer: number | undefined;
let sipStatusTimer: number | undefined;
let presenceTimer: number | undefined;
let callbackReminderTimer: number | undefined;
const remindedCallbackIds = new Set<string>();
let notice = isTauriRuntime()
  ? "Softphone bereit."
  : "Bereit. CardDAV kann synchronisiert werden; echte Anrufe bleiben blockiert, solange der Anrufschutz aktiv ist.";
let sipNotice = "SIP nicht registriert.";
let syncState: "idle" | "syncing" | "ok" | "error" = "idle";
let lastCardDavSyncAt = Number(localStorage.getItem("nivako-softphone.carddav-last-sync-at")) || 0;
let lastCardDavSyncCount = Number(localStorage.getItem("nivako-softphone.carddav-last-sync-count")) || 0;
let state: SoftphoneState = {
  registered: false,
  activeNumber: "",
  callState: "idle"
};
let incomingWindowVisible = false;
let lastToastNotice = notice;
let toastUntil = 0;
let toastTimer: number | undefined;
let callStartedAt: number | undefined;
let activeHistoryId: string | undefined;
let dndRejecting = false;
let incomingCallRecorded = false;
let editingHistoryId: string | null = null;
let assigningHistoryId: string | null = null;
let historyAssignmentQuery = "";
let microphoneRecordingUrl = "";
let ringtoneTimer: number | undefined;
let contactLayout: "alphabetical" | "companies" = "alphabetical";
let expandedCompanies = new Set<string>();
let callClockTimer: number | undefined;
let closeSettingsAfterSave = false;
let miniMode = false;
let presenceStates: Record<string, string> = {};

function stopRingtone(): void {
  if (ringtoneTimer !== undefined) window.clearInterval(ringtoneTimer);
  ringtoneTimer = undefined;
}

function playRingtonePulse(): void {
  if (settings.ringtone === "silent") return;
  const context = new AudioContext();
  const gain = context.createGain();
  gain.gain.value = Math.max(0.03, settings.speakerVolume / 100 * 0.12);
  gain.connect(context.destination);
  const frequencies = settings.ringtone === "soft" ? [440, 554] : settings.ringtone === "bright" ? [740, 988] : [620, 780];
  frequencies.forEach((frequency, index) => {
    const oscillator = context.createOscillator();
    oscillator.frequency.value = frequency;
    oscillator.connect(gain);
    oscillator.start(context.currentTime + index * 0.22);
    oscillator.stop(context.currentTime + index * 0.22 + 0.18);
  });
  window.setTimeout(() => void context.close(), 800);
}

function setRingtoneActive(active: boolean): void {
  stopRingtone();
  if (!active || settings.ringtone === "silent") return;
  playRingtonePulse();
  ringtoneTimer = window.setInterval(playRingtonePulse, 3200);
}

async function setIncomingWindow(visible: boolean): Promise<void> {
  if (!isTauriRuntime() || incomingWindowVisible === visible) return;
  incomingWindowVisible = visible;
  const api = await import("@tauri-apps/api/core");
  if (visible) {
    await api.invoke("show_incoming_window", {
      callerName: state.activeContact?.displayName || state.remoteIdentity || "Unbekannter Anrufer",
      callerNumber: state.activeNumber || state.remoteIdentity || ""
    });
  } else {
    await api.invoke("hide_incoming_window");
  }
}

type Tone = "ok" | "warn" | "error" | "neutral";

function notificationTone(message: string): Tone {
  const lower = message.toLowerCase();
  if (lower.includes("fehl") || lower.includes("gesperrt") || lower.includes("abgelehnt")) return "error";
  if (lower.includes("wartet") || lower.includes("nicht registriert") || lower.includes("nicht eingerichtet")) return "warn";
  return "ok";
}

function isEditingElement(element: Element | null): boolean {
  return element instanceof HTMLInputElement
    || element instanceof HTMLTextAreaElement
    || element instanceof HTMLSelectElement;
}

function renderUnlessEditing(): void {
  if (isEditingElement(document.activeElement)) return;
  render();
}

function renderAndRestoreInput(selector: string, start: number | null, end: number | null): void {
  render();
  const input = document.querySelector<HTMLInputElement>(selector);
  if (!input) return;
  input.focus();
  if (start !== null && end !== null) {
    input.setSelectionRange(start, end);
  }
}

function applyTelephonyStatus(status: string, registered?: boolean): void {
  sipNotice = status;
  state = { ...state, registered: registered ?? state.registered };
  if (status.startsWith("Anruf klingelt")) {
    state = { ...state, callState: "ringing" };
    notice = "Eingehender Anruf.";
  }
  if (status.startsWith("Anruf aktiv") || status.startsWith("Anruf verbunden")) {
    state = { ...state, callState: "active" };
    notice = "Anruf verbunden.";
  }
  if (status.startsWith("Nativer Anruf gestartet")) {
    state = { ...state, callState: "dialing" };
    notice = "Anruf wird aufgebaut.";
  }
  if (status.startsWith("Anruf beendet") || status.startsWith("Anruf fehlgeschlagen")) {
    state = { ...state, callState: "idle", muted: false };
    notice = status.startsWith("Anruf beendet") ? "Anruf beendet." : "Anruf fehlgeschlagen.";
  } else if (registered && state.callState === "idle") {
    notice = "Telefonie bereit.";
  }
  renderUnlessEditing();
}

function normalizeCallState(value: string): SoftphoneState["callState"] {
  const lower = value.toLowerCase();
  if (["idle", "ringing", "dialing", "active", "held"].includes(lower)) {
    return lower as SoftphoneState["callState"];
  }
  if (lower.includes("outgoing")) return "dialing";
  if (lower.includes("incoming") || lower.includes("ringing")) return "ringing";
  if (lower.includes("stream") || lower.includes("connect")) return "active";
  if (lower.includes("paused") || lower.includes("hold")) return "held";
  return "idle";
}

function applyNativeSipSnapshot(snapshot: NativeSipSnapshot): void {
  const previousCallState = state.callState;
  const remoteNumber = snapshot.remote_number?.trim() || "";
  const normalizedRemoteNumber = normalizePhoneNumber(remoteNumber);
  const remoteContact = remoteNumber
    ? contacts.find((contact) => contact.phones.some((phone) => phone.normalized === normalizedRemoteNumber || phone.raw === remoteNumber))
    : undefined;
  const nextState = {
    ...state,
    registered: snapshot.registered,
    callState: normalizeCallState(snapshot.call_state),
    muted: snapshot.muted,
    activeNumber: snapshot.call_state !== "idle" && remoteNumber ? remoteNumber : state.activeNumber,
    activeContact: snapshot.call_state !== "idle" && remoteNumber ? remoteContact : state.activeContact,
    remoteIdentity: snapshot.remote_display_name?.trim() || remoteNumber || undefined
  };
  if (nextState.callState === "idle") {
    nextState.muted = false;
    nextState.remoteIdentity = undefined;
  }
  const nextNotice = `${snapshot.provider}: ${snapshot.message}`;
  const changed = sipNotice !== nextNotice
    || state.registered !== nextState.registered
    || state.callState !== nextState.callState
    || Boolean(state.muted) !== Boolean(nextState.muted)
    || state.activeNumber !== nextState.activeNumber
    || state.activeContact?.id !== nextState.activeContact?.id
    || state.remoteIdentity !== nextState.remoteIdentity
    || hasSecondCall !== snapshot.has_second_call;

  if (!changed) return;

  if (previousCallState !== "ringing" && nextState.callState === "ringing") {
    incomingCallRecorded = false;
    setRingtoneActive(true);
  }
  if (previousCallState === "ringing" && nextState.callState !== "ringing") setRingtoneActive(false);
  if (previousCallState !== "active" && nextState.callState === "active") callStartedAt = Date.now();
  if (previousCallState === "active" && nextState.callState === "idle") finishActiveHistory();
  if (previousCallState === "ringing" && nextState.callState === "idle" && !incomingCallRecorded) {
    const number = state.activeNumber || state.remoteIdentity || "eingehend";
    addHistory("missed", number, state.activeContact?.displayName || state.remoteIdentity || number, "completed");
    incomingCallRecorded = true;
  }

  sipNotice = nextNotice;
  hasSecondCall = snapshot.has_second_call;
  waitingCallNumber = snapshot.waiting_number || "";
  waitingCallName = snapshot.waiting_display_name || waitingCallNumber;
  state = nextState;
  if (settings.doNotDisturb && nextState.callState === "ringing" && !dndRejecting && telephony.reject) {
    dndRejecting = true;
    const number = nextState.activeNumber || nextState.remoteIdentity || "eingehend";
    addHistory("missed", number, nextState.activeContact?.displayName || nextState.remoteIdentity || number, "completed");
    incomingCallRecorded = true;
    void telephony.reject().finally(() => { dndRejecting = false; });
    notice = "Anruf durch Nicht stören abgewiesen.";
  }
  void setIncomingWindow(nextState.callState === "ringing");
  renderUnlessEditing();
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#039;" })[char] || char);
}

function errorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === "string" && error.trim()) return error;
  if (typeof error === "number" || typeof error === "boolean") return String(error);
  if (error && typeof error === "object") {
    try {
      return JSON.stringify(error);
    } catch {
      return fallback;
    }
  }
  return fallback;
}

function applyFavorites(nextContacts: Contact[], favoriteIds: string[]): Contact[] {
  const favoriteSet = new Set(favoriteIds);
  return nextContacts
    .filter((contact) => !contact.id.startsWith("demo-"))
    .map((contact) => ({ ...contact, favorite: contact.favorite || favoriteSet.has(contact.id) }));
}

function contactSortName(contact: Contact): string {
  const parts = contact.displayName.trim().split(/\s+/).filter(Boolean);
  if (parts.length > 1) return `${parts.at(-1)} ${parts.slice(0, -1).join(" ")}`;
  return contact.displayName || contact.organization || "#";
}

function contactLetter(contact: Contact): string {
  const first = contactSortName(contact).normalize("NFD").replace(/[\u0300-\u036f]/g, "").charAt(0).toUpperCase();
  return /^[A-Z]$/.test(first) ? first : "#";
}

function sortedContacts(items: Contact[]): Contact[] {
  return [...items].sort((a, b) => contactSortName(a).localeCompare(contactSortName(b), "de", { sensitivity: "base" }));
}

function frequentContactIds(): string[] {
  const counts = new Map<string, number>();
  for (const entry of callHistory) {
    const normalized = normalizePhoneNumber(entry.number);
    const contact = contacts.find((candidate) => candidate.phones.some((phone) => phone.normalized === normalized));
    if (contact) counts.set(contact.id, (counts.get(contact.id) || 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([id]) => id);
}

function duplicateGroups(): Contact[][] {
  const groups: Contact[][] = [];
  const used = new Set<string>();
  for (const contact of contacts) {
    if (used.has(contact.id)) continue;
    const peers = contacts.filter((candidate) => candidate.id !== contact.id && (
      Boolean(contact.email && candidate.email && contact.email.toLowerCase() === candidate.email.toLowerCase())
      || contact.phones.some((phone) => phone.normalized && candidate.phones.some((other) => other.normalized === phone.normalized))
    ));
    if (peers.length) {
      const group = [contact, ...peers].filter((candidate, index, all) => all.findIndex((item) => item.id === candidate.id) === index);
      group.forEach((candidate) => used.add(candidate.id));
      groups.push(group);
    }
  }
  return groups;
}

async function mergeDuplicateContacts(): Promise<void> {
  const groups = duplicateGroups();
  if (!groups.length) {
    notice = "Keine zusammenführbaren Dubletten gefunden.";
    render();
    return;
  }
  if (!window.confirm(`${groups.length} Dublettengruppe(n) zusammenführen? Je Gruppe bleibt ein gemeinsamer CardDAV-Kontakt mit allen eindeutigen Rufnummern erhalten.`)) return;
  try {
    for (const group of groups) {
      const primary = [...group].sort((a, b) => Number(Boolean(b.espoId)) - Number(Boolean(a.espoId)) || Number(b.source === "carddav") - Number(a.source === "carddav"))[0];
      const seenNumbers = new Set<string>();
      const phones = group.flatMap((contact) => contact.phones).filter((phone) => {
        const key = phone.normalized || normalizePhoneNumber(phone.raw) || phone.raw;
        if (seenNumbers.has(key)) return false;
        seenNumbers.add(key);
        return true;
      }).map((phone, index) => ({ ...phone, primary: index === 0 }));
      let merged: Contact = {
        ...primary,
        displayName: primary.displayName || group.find((contact) => contact.displayName)?.displayName || "Kontakt",
        organization: primary.organization || group.find((contact) => contact.organization)?.organization,
        email: primary.email || group.find((contact) => contact.email)?.email,
        espoId: primary.espoId || group.find((contact) => contact.espoId)?.espoId,
        favorite: group.some((contact) => contact.favorite),
        phones
      };
      if (isTauriRuntime()) merged = await writeCardDavContactNative(settings, merged, cardDavPassword);
      for (const duplicate of group.filter((contact) => contact.id !== primary.id && contact.source === "carddav")) {
        if (isTauriRuntime()) await deleteCardDavContactNative(settings, duplicate, cardDavPassword);
      }
      const ids = new Set(group.map((contact) => contact.id));
      contacts = [...contacts.filter((contact) => !ids.has(contact.id)), merged];
    }
    persistContacts();
    notice = `${groups.length} Dublettengruppe(n) wurden zusammengeführt.`;
  } catch (error) {
    notice = errorMessage(error, "Dubletten konnten nicht vollständig zusammengeführt werden");
  }
  render();
}

function persistContacts(): void {
  saveContacts(contacts);
  saveFavoriteIds(contacts.filter((contact) => contact.favorite).map((contact) => contact.id));
}

function allowedNumbers(): string[] {
  return settings.allowedTestNumbers.split(",").map((number) => number.trim()).filter(Boolean);
}

function isNumberAllowed(number: string): boolean {
  const allowed = allowedNumbers();
  return allowed.length > 0 && allowed.includes(number.trim());
}

function mediaConstraints(): MediaStreamConstraints {
  return {
    audio: settings.selectedMicrophoneId ? { deviceId: { exact: settings.selectedMicrophoneId } } : true,
    video: false
  };
}

async function refreshAudioDevices(requestPermission = false): Promise<void> {
  audioDevices = await loadAudioDevices(requestPermission);
  notice = audioDevices.permission === "denied"
    ? "Mikrofonzugriff wurde verweigert."
    : "Audio-Geraete aktualisiert.";
  render();
}

function configureTelephony(): void {
  if (settings.enableWebRtcSip) {
    telephony = new WebRtcSipAdapter({
      webSocketUrl: settings.sipWebSocketUrl,
      sipServer: settings.sipServer,
      extension: settings.sipExtension,
      authUser: settings.sipAuthUser || settings.sipExtension,
      password: sipPassword,
      displayName: settings.sipDisplayName
    }, applyTelephonyStatus, mediaConstraints);
    return;
  }

  if (canUseNativeTelephony()) {
    telephony = new NativeTelephonyAdapter(() => settings, () => sipPassword, applyTelephonyStatus);
    return;
  }

  telephony = new SafeTelephonyAdapter(() => settings.useTelLinks && !settings.safeCallMode);
}

async function registerSip(): Promise<void> {
  try {
    configureTelephony();
    await telephony.register();
  } catch (error) {
    state = { ...state, registered: false };
    sipNotice = errorMessage(error, "SIP Registrierung fehlgeschlagen");
    notice = "SIP-Anmeldung fehlgeschlagen. Bitte Zugangsdaten und Verbindung prüfen.";
    render();
  }
}

function setActiveNumber(number: string, contact?: Contact): void {
  state = { ...state, activeNumber: number, activeContact: contact };
  notice = contact ? `${contact.displayName} ist ausgewaehlt.` : "Nummer ist ausgewaehlt.";
  render();
}

function selectContactNumber(contact: Contact, callImmediately = false): void {
  if (contact.phones.length > 1) {
    contactMenu = null;
    phonePicker = { contactId: contact.id, callImmediately };
    render();
    return;
  }
  const phone = contact.phones[0];
  if (!phone) return;
  setActiveNumber(phone.normalized || phone.raw, contact);
  if (callImmediately) void dial();
}

function selectedContact(): Contact | undefined {
  if (editingContactDraft) return editingContactDraft;
  const id = editingContactId || contactMenu?.contactId;
  return id ? contacts.find((contact) => contact.id === id) : undefined;
}

function closeContactOverlays(): void {
  contactMenu = null;
  phonePicker = null;
  editingContactId = null;
  editingContactDraft = null;
}

async function copyContactValue(value: string, label: string): Promise<void> {
  contactMenu = null;
  try {
    await navigator.clipboard.writeText(value);
    notice = `${label} wurde kopiert.`;
  } catch {
    notice = `${label} konnte nicht kopiert werden.`;
  }
  render();
}

async function deleteContact(contactId: string): Promise<void> {
  const contact = contacts.find((candidate) => candidate.id === contactId);
  if (!contact || !window.confirm(`Kontakt „${contact.displayName}“ aus dem gemeinsamen Telefonbuch entfernen? Der CRM-Datensatz wird dabei nicht endgültig gelöscht.`)) return;
  try {
    if (contact.source === "carddav") {
      if (!isTauriRuntime()) throw new Error("CardDAV-Schreiben ist nur in der Desktop-App verfügbar.");
      await deleteCardDavContactNative(settings, contact, cardDavPassword);
    }
  } catch (error) {
    notice = errorMessage(error, "Kontakt konnte nicht aus CardDAV entfernt werden");
    render();
    return;
  }
  contacts = contacts.filter((candidate) => candidate.id !== contactId);
  if (state.activeContact?.id === contactId) state = { ...state, activeContact: undefined };
  persistContacts();
  closeContactOverlays();
  notice = `${contact.displayName} wurde aus dem Telefonbuch entfernt; der CRM-Datensatz bleibt erhalten.`;
  render();
}

async function saveContactEdit(formElement: HTMLFormElement): Promise<void> {
  if (!editingContactId) return;
  const form = new FormData(formElement);
  const displayName = String(form.get("displayName") || "").trim();
  const rawPhones = form.getAll("phone").map(String);
  const labels = form.getAll("phoneLabel").map(String) as PhoneLabel[];
  const primaryIndex = Number(form.get("primaryPhone") || 0);
  const phones: ContactPhone[] = rawPhones.map((raw, index) => ({
    raw: raw.trim(), normalized: normalizePhoneNumber(raw), label: labels[index] || "other", primary: index === primaryIndex
  })).filter((phone) => phone.raw);
  if (!displayName || !phones.length) {
    notice = "Name und mindestens eine Telefonnummer dürfen nicht leer sein.";
    render();
    return;
  }
  const base = editingContactDraft || contacts.find((contact) => contact.id === editingContactId);
  if (!base) return;
  let updated: Contact = {
    ...base,
    displayName,
    organization: String(form.get("organization") || "").trim() || undefined,
    email: String(form.get("email") || "").trim() || undefined,
    phones
  };
  try {
    if (isTauriRuntime()) updated = await writeCardDavContactNative(settings, updated, cardDavPassword);
    else updated = { ...updated, source: "local" };
  } catch (error) {
    notice = errorMessage(error, "Kontakt konnte nicht in CardDAV gespeichert werden");
    render();
    return;
  }
  const existingIndex = contacts.findIndex((contact) => contact.id === editingContactId);
  contacts = existingIndex === -1 ? [...contacts, updated] : contacts.map((contact, index) => index === existingIndex ? updated : contact);
  persistContacts();
  closeContactOverlays();
  notice = `${updated.displayName} wurde in CardDAV gespeichert und wird mit Espo abgeglichen.`;
  render();
}

function addHistory(direction: CallEntry["direction"], number: string, name = number, result: CallEntry["result"] = "started"): string {
  const id = crypto.randomUUID();
  callHistory = [
    {
      id,
      direction,
      name,
      number,
      time: new Intl.DateTimeFormat("de-DE", { dateStyle: "short", timeStyle: "short" }).format(new Date()),
      result,
      callbackRequested: direction === "missed"
    },
    ...callHistory
  ].slice(0, 100);
  saveHistory(callHistory);
  return id;
}

function finishActiveHistory(): void {
  if (!activeHistoryId) return;
  const durationSeconds = callStartedAt ? Math.max(0, Math.round((Date.now() - callStartedAt) / 1000)) : 0;
  callHistory = callHistory.map((entry) => entry.id === activeHistoryId ? { ...entry, result: "completed", durationSeconds } : entry);
  saveHistory(callHistory);
  activeHistoryId = undefined;
  callStartedAt = undefined;
}

function formatDuration(seconds?: number): string {
  if (seconds === undefined) return "";
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

function callResultText(result?: CallEntry["result"]): string {
  if (result === "blocked") return "Blockiert";
  if (result === "started") return "Gestartet";
  if (result === "failed") return "Fehlgeschlagen";
  if (result === "completed") return "Beendet";
  return "";
}

async function dial(): Promise<void> {
  if (state.callState === "ringing" && telephony.accept) {
    state = { ...state, callState: "active" };
    notice = "Eingehender Anruf wird angenommen.";
    render();
    try {
      await telephony.accept();
      activeHistoryId = addHistory("inbound", state.activeNumber || "eingehend", state.activeContact?.displayName || state.activeNumber || "Eingehender Anruf", "started");
      incomingCallRecorded = true;
      callStartedAt = Date.now();
    } catch (error) {
      notice = errorMessage(error, "Anruf konnte nicht angenommen werden");
      state = { ...state, callState: "idle" };
    }
    render();
    return;
  }
  if (!state.activeNumber) return;
  const realSipTelephony = settings.enableWebRtcSip || canUseNativeTelephony();
  if (settings.safeCallMode) {
    notice = "Anrufschutz aktiv: Es wurde kein echter Anruf gestartet.";
    addHistory("outbound", state.activeNumber, state.activeContact?.displayName || state.activeNumber, "blocked");
    render();
    return;
  }

  if (!realSipTelephony && settings.enableWebRtcSip && !isNumberAllowed(state.activeNumber)) {
    notice = `Anruf blockiert: ${state.activeNumber} ist nicht in den erlaubten Testnummern.`;
    addHistory("outbound", state.activeNumber, state.activeContact?.displayName || state.activeNumber, "blocked");
    render();
    return;
  }

  state = { ...state, callState: "dialing" };
  notice = `Anruf wird gestartet: ${state.activeNumber}`;
  render();
  try {
    await telephony.dial(state.activeNumber);
    activeHistoryId = addHistory("outbound", state.activeNumber, state.activeContact?.displayName || state.activeNumber, "started");
    if (canUseNativeTelephony() && !settings.enableWebRtcSip) {
      notice = "Anruf wird aufgebaut.";
    } else {
      state = { ...state, callState: "active" };
      notice = settings.enableWebRtcSip
      ? "SIP-Anruf gestartet."
      : settings.useTelLinks
        ? "Anruf wurde an den Windows-tel:-Handler uebergeben."
        : "Kein SIP-Core verbunden. Nummer wurde nur im lokalen Verlauf erfasst.";
    }
  } catch (error) {
    addHistory("outbound", state.activeNumber, state.activeContact?.displayName || state.activeNumber, "failed");
    notice = errorMessage(error, "Anruf fehlgeschlagen");
    state = { ...state, callState: "idle" };
  }
  render();
}

async function hangup(): Promise<void> {
  if (state.callState === "ringing" && telephony.reject) {
    await telephony.reject();
    addHistory("missed", state.activeNumber || "eingehend", state.remoteIdentity || state.activeNumber || "Eingehender Anruf", "completed");
    incomingCallRecorded = true;
    state = { ...state, callState: "idle", activeNumber: "", activeContact: undefined, remoteIdentity: undefined };
    notice = "Eingehender Anruf abgelehnt.";
    render();
    return;
  }
  await telephony.hangup();
  finishActiveHistory();
  const snapshot = await getSipStatusNative();
  applyNativeSipSnapshot(snapshot);
  if (snapshot.call_state === "idle") {
    state = { ...state, callState: "idle", activeNumber: "", activeContact: undefined };
    notice = "Anruf beendet.";
  } else {
    notice = "Aktives Gespräch beendet. Das gehaltene Gespräch wurde fortgesetzt.";
  }
  render();
}

async function holdCall(): Promise<void> {
  await telephony.hold();
  const snapshot = await getSipStatusNative();
  applyNativeSipSnapshot(snapshot);
  notice = snapshot.held ? "Anruf gehalten." : "Anruf fortgesetzt.";
  render();
}

async function toggleMute(): Promise<void> {
  if (state.muted) {
    await telephony.unmute?.();
  } else {
    await telephony.mute?.();
  }
  state = { ...state, muted: !state.muted };
  notice = state.muted ? "Mikrofon stumm." : "Mikrofon aktiv.";
  render();
}

async function transferCall(target: string): Promise<void> {
  if (!telephony.transfer) return;
  if (!target) return;
  try {
    await telephony.transfer(target);
    notice = `Anruf wird an ${target} weitergeleitet.`;
  } catch (error) {
    notice = errorMessage(error, "Weiterleitung fehlgeschlagen");
  }
  render();
}

async function startSecondCall(target: string): Promise<void> {
  if (!target) return;
  try {
    if (state.callState === "active") await telephony.hold();
    await telephony.dial(target);
    activeHistoryId = addHistory("outbound", target, contacts.find((contact) => contact.phones.some((phone) => phone.normalized === target || phone.raw === target))?.displayName || target, "started");
    notice = `Zweiter Anruf wird zu ${target} aufgebaut.`;
  } catch (error) {
    notice = errorMessage(error, "Zweiter Anruf konnte nicht aufgebaut werden");
  }
  render();
}

async function switchCall(): Promise<void> {
  if (!telephony.switchCall) return;
  try {
    await telephony.switchCall();
    const snapshot = await getSipStatusNative();
    applyNativeSipSnapshot(snapshot);
    notice = "Aktives Gespräch gewechselt.";
  } catch (error) {
    notice = errorMessage(error, "Gespräch konnte nicht gewechselt werden");
  }
  render();
}

async function startConference(): Promise<void> {
  if (!telephony.conference) return;
  try {
    await telephony.conference();
    const snapshot = await getSipStatusNative();
    applyNativeSipSnapshot(snapshot);
    notice = "Konferenz verbunden – alle drei Teilnehmer können miteinander sprechen.";
  } catch (error) {
    notice = errorMessage(error, "Konferenz konnte nicht verbunden werden");
  }
  render();
}

async function attendedTransfer(): Promise<void> {
  if (!telephony.attendedTransfer) return;
  try {
    await telephony.attendedTransfer();
    applyNativeSipSnapshot(await getSipStatusNative());
    notice = "Rückfrage-Übergabe wurde gestartet.";
  } catch (error) {
    notice = errorMessage(error, "Rückfrage-Übergabe fehlgeschlagen");
  }
  render();
}

function renderCallActionModal(): string {
  if (!callAction) return "";
  const matches = searchContacts(contacts, callActionQuery).filter((contact) => contact.phones.length > 0).slice(0, 6);
  const title = callAction === "transfer" ? "Anruf weiterleiten" : "Zweiten Anruf starten";
  return `<div class="call-action-backdrop"><section class="call-action-modal" role="dialog" aria-modal="true" aria-labelledby="call-action-title">
    <header><div><h1 id="call-action-title">${title}</h1><p>Nummer eingeben oder Kontakt auswählen</p></div><button class="modal-close" id="close-call-action" aria-label="Schließen">×</button></header>
    <form id="call-action-form">
      <input class="search" id="call-action-target" name="target" value="${escapeHtml(callActionQuery)}" placeholder="Name oder Rufnummer" autofocus />
      <div class="call-target-results">${matches.map((contact) => contact.phones.map((phone) => `<button type="button" data-call-target="${escapeHtml(phone.raw)}"><strong>${escapeHtml(contact.displayName)}</strong><small>${escapeHtml(phone.raw)}</small></button>`).join("")).join("")}</div>
      <div class="modal-row"><button class="secondary" type="button" id="cancel-call-action">Abbrechen</button><button class="primary" type="submit">${callAction === "transfer" ? "Weiterleiten" : "Anrufen"}</button></div>
    </form>
  </section></div>`;
}

function renderContactMenu(): string {
  if (!contactMenu) return "";
  const contact = selectedContact();
  if (!contact) return "";
  const phone = contact.phones[0]?.normalized || contact.phones[0]?.raw || "";
  return `<div class="contact-context-menu" role="menu" style="left:${contactMenu.x}px;top:${contactMenu.y}px">
    <button role="menuitem" data-contact-action="call">Anrufen</button>
    <button role="menuitem" data-contact-action="copy-phone" ${phone ? "" : "disabled"}>Nummer kopieren</button>
    ${contact.email ? '<button role="menuitem" data-contact-action="copy-email">E-Mail kopieren</button>' : ""}
    <button role="menuitem" data-contact-action="favorite">${contact.favorite ? "Aus Favoriten entfernen" : "Zu Favoriten hinzufügen"}</button>
    <span class="context-separator"></span>
    <button role="menuitem" data-contact-action="edit">Kontakt bearbeiten</button>
    <button class="context-danger" role="menuitem" data-contact-action="delete">Kontakt löschen</button>
  </div>`;
}

function renderPhonePicker(): string {
  if (!phonePicker) return "";
  const contact = contacts.find((candidate) => candidate.id === phonePicker?.contactId);
  if (!contact) return "";
  return `<div class="settings-modal-backdrop phone-picker-backdrop"><section class="phone-picker" role="dialog" aria-modal="true" aria-labelledby="phone-picker-title">
    <header><div><h1 id="phone-picker-title">Nummer auswählen</h1><p>${escapeHtml(contact.displayName)}</p></div><button class="modal-close" id="close-phone-picker" aria-label="Schließen">×</button></header>
    <div class="phone-picker-list">${contact.phones.map((phone) => `<button type="button" data-picked-phone="${escapeHtml(phone.normalized || phone.raw)}">
      <span><strong>${escapeHtml(phoneLabelNames[phone.label])}</strong>${phone.primary ? "<small>Bevorzugt</small>" : ""}</span><b>${escapeHtml(phone.raw)}</b>
    </button>`).join("")}</div>
  </section></div>`;
}

function renderContactEditor(): string {
  if (!editingContactId) return "";
  const contact = selectedContact();
  if (!contact) return "";
  return `<div class="settings-modal-backdrop contact-editor-backdrop"><section class="contact-editor" role="dialog" aria-modal="true" aria-labelledby="contact-editor-title">
    <header><div><h1 id="contact-editor-title">${contact.source === "local" ? "Kontakt erstellen" : "Kontakt bearbeiten"}</h1><p>Wird in CardDAV gespeichert und anschließend mit Espo abgeglichen</p></div><button class="modal-close" id="close-contact-editor" aria-label="Schließen">×</button></header>
    <form class="settings-list" id="contact-editor-form">
      <label><span>Name</span><input name="displayName" required value="${escapeHtml(contact.displayName)}" /></label>
      <label><span>Firma</span><input name="organization" value="${escapeHtml(contact.organization || "")}" /></label>
      <label><span>E-Mail</span><input name="email" type="email" value="${escapeHtml(contact.email || "")}" /></label>
      <fieldset class="phone-editor"><legend>Telefonnummern</legend><div id="phone-editor-rows">
        ${contact.phones.map((phone, index) => renderPhoneEditorRow(phone, index)).join("") || renderPhoneEditorRow({ label: "work", raw: "", normalized: "", primary: true }, 0)}
      </div><button class="secondary compact" type="button" id="add-phone-row">+ Weitere Nummer</button></fieldset>
      <div class="modal-row"><button class="secondary" type="button" id="cancel-contact-editor">Abbrechen</button><button class="primary" type="submit">Speichern</button></div>
    </form>
  </section></div>`;
}

const phoneLabelNames: Record<PhoneLabel, string> = {
  work: "Geschäftlich", workMobile: "Geschäftliches Handy", mobile: "Handy", home: "Privat",
  homeMobile: "Privates Handy", fax: "Fax", main: "Zentrale", other: "Sonstige"
};

function renderPhoneEditorRow(phone: ContactPhone, index: number): string {
  const options = Object.entries(phoneLabelNames).map(([value, label]) => `<option value="${value}" ${phone.label === value ? "selected" : ""}>${label}</option>`).join("");
  return `<div class="phone-editor-row"><select name="phoneLabel">${options}</select><input name="phone" value="${escapeHtml(phone.raw)}" placeholder="Telefonnummer" />
    <label class="primary-phone"><input type="radio" name="primaryPhone" value="${index}" ${phone.primary || index === 0 ? "checked" : ""} /> Bevorzugt</label>
    <button type="button" class="icon-button remove-phone-row" title="Nummer entfernen">×</button></div>`;
}

function appendDigit(digit: string): void {
  state = { ...state, activeNumber: `${state.activeNumber}${digit}` };
  if (state.callState !== "idle") void telephony.sendDtmf(digit);
  render();
}

function deleteDigit(): void {
  state = { ...state, activeNumber: state.activeNumber.slice(0, -1) };
  render();
}

async function testSpeaker(): Promise<void> {
  const context = new AudioContext();
  const oscillator = context.createOscillator();
  const gain = context.createGain();
  oscillator.frequency.value = 660;
  gain.gain.value = Math.max(0.05, settings.speakerVolume / 100 * 0.2);
  oscillator.connect(gain).connect(context.destination);
  oscillator.start();
  oscillator.stop(context.currentTime + 0.6);
  oscillator.addEventListener("ended", () => void context.close());
  notice = "Testton wird abgespielt.";
  render();
}

async function testMicrophone(): Promise<void> {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: settings.selectedMicrophoneId ? { deviceId: { exact: settings.selectedMicrophoneId } } : true });
    const context = new AudioContext();
    const analyser = context.createAnalyser();
    analyser.fftSize = 256;
    context.createMediaStreamSource(stream).connect(analyser);
    const data = new Uint8Array(analyser.frequencyBinCount);
    const until = Date.now() + 5000;
    const update = () => {
      analyser.getByteFrequencyData(data);
      const level = Math.min(100, Math.round(data.reduce((sum, value) => sum + value, 0) / data.length * 1.6));
      const bar = document.querySelector<HTMLElement>("#microphone-test-level");
      if (bar) bar.style.width = `${level}%`;
      if (Date.now() < until) requestAnimationFrame(update);
      else { stream.getTracks().forEach((track) => track.stop()); void context.close(); }
    };
    update();
  } catch (error) {
    notice = errorMessage(error, "Mikrofontest konnte nicht gestartet werden");
    render();
  }
}

async function recordMicrophoneSample(): Promise<void> {
  try {
    if (microphoneRecordingUrl) URL.revokeObjectURL(microphoneRecordingUrl);
    const stream = await navigator.mediaDevices.getUserMedia({ audio: settings.selectedMicrophoneId ? { deviceId: { exact: settings.selectedMicrophoneId } } : true });
    const chunks: BlobPart[] = [];
    const recorder = new MediaRecorder(stream);
    recorder.addEventListener("dataavailable", (event) => { if (event.data.size) chunks.push(event.data); });
    recorder.addEventListener("stop", () => {
      stream.getTracks().forEach((track) => track.stop());
      microphoneRecordingUrl = URL.createObjectURL(new Blob(chunks, { type: recorder.mimeType || "audio/webm" }));
      notice = "Testaufnahme ist bereit zur Wiedergabe.";
      render();
    });
    recorder.start();
    notice = "Mikrofon wird 5 Sekunden aufgenommen …";
    render();
    window.setTimeout(() => recorder.state === "recording" && recorder.stop(), 5000);
  } catch (error) {
    notice = errorMessage(error, "Testaufnahme konnte nicht gestartet werden");
    render();
  }
}

function handleKeyboardShortcut(event: KeyboardEvent): void {
  const target = event.target as HTMLElement | null;
  const editing = target?.matches("input, textarea, select") || target?.isContentEditable;
  if (matchesShortcut(event, settings.searchShortcut)) {
    event.preventDefault();
    activeView = "contacts";
    render();
    document.querySelector<HTMLInputElement>("#search")?.focus();
    return;
  }
  if (matchesShortcut(event, settings.dialShortcut) && state.callState === "idle" && state.activeNumber) { event.preventDefault(); void dial(); return; }
  if (matchesShortcut(event, settings.muteShortcut) && ["active", "held"].includes(state.callState)) { event.preventDefault(); void toggleMute(); return; }
  if (event.key === "Escape") {
    if (assigningHistoryId) { assigningHistoryId = null; historyAssignmentQuery = ""; render(); return; }
    if (editingHistoryId) { void requestFormClose("#history-note-form", () => { editingHistoryId = null; render(); }); return; }
    if (editingContactId) { void requestFormClose("#contact-editor-form", () => { closeContactOverlays(); render(); }); return; }
    if (settingsOpen) { void requestSettingsClose(); return; }
    callAction = null; phonePicker = null; contactMenu = null;
    render();
    return;
  }
  if (!editing && event.key === "Enter" && state.callState === "idle" && state.activeNumber) void dial();
  if (!editing && event.key.toLowerCase() === "m" && ["active", "held"].includes(state.callState)) void toggleMute();
  if (!editing && event.key.toLowerCase() === "h" && ["active", "held"].includes(state.callState)) void holdCall();
  if (!editing && event.key === "Escape" && state.callState !== "idle") void hangup();
}

function matchesShortcut(event: KeyboardEvent, shortcut: string): boolean {
  const parts = shortcut.toLowerCase().split("+").map((part) => part.trim()).filter(Boolean);
  const key = parts.at(-1);
  return !!key && event.key.toLowerCase() === key
    && event.ctrlKey === parts.includes("ctrl")
    && event.altKey === parts.includes("alt")
    && event.shiftKey === parts.includes("shift");
}

async function parkCall(): Promise<void> {
  if (!telephony.transfer || !settings.parkExtension.trim()) return;
  try {
    await telephony.transfer(settings.parkExtension.trim());
    notice = `Gespräch wurde auf ${settings.parkExtension.trim()} geparkt.`;
  } catch (error) { notice = errorMessage(error, "Gespräch konnte nicht geparkt werden"); }
  render();
}

function pickupCall(): void {
  setActiveNumber(settings.pickupCode.trim());
  void dial();
}

async function toggleMiniMode(): Promise<void> {
  miniMode = !miniMode;
  if (isTauriRuntime()) await setMiniModeNative(miniMode).catch((error) => { notice = errorMessage(error, "Mini-Modus konnte nicht umgeschaltet werden"); });
  render();
}

function speedDials(): string[] {
  return settings.speedDialNumbers.split(",").map((number) => number.trim()).filter(Boolean).slice(0, 8);
}

function speedDialLabel(number: string): string {
  return contacts.find((contact) => contact.phones.some((phone) => phone.normalized === normalizePhoneNumber(number) || phone.raw === number))?.displayName || number;
}

function internalExtension(contact: Contact): string | undefined {
  return contact.phones.map((phone) => phone.raw.trim()).find((number) => /^\d{2,5}$/.test(number));
}

function presenceLabel(extension?: string): string {
  if (!extension) return "";
  const labels: Record<string, string> = { online: "Frei", busy: "Besetzt", dnd: "Nicht stören", offline: "Offline", pending: "Prüfe …", unknown: "Unbekannt" };
  return labels[presenceStates[extension] || "pending"];
}

async function refreshPresence(): Promise<void> {
  if (!isTauriRuntime() || !state.registered) return;
  const extensions = [...new Set(contacts.map(internalExtension).filter((value): value is string => !!value))];
  if (!extensions.length) return;
  presenceStates = await getPresenceNative(extensions).catch(() => presenceStates);
  renderUnlessEditing();
}

function checkDueCallbacks(): void {
  const due = callHistory.filter((entry) => entry.callbackRequested && entry.callbackDueAt && new Date(entry.callbackDueAt).getTime() <= Date.now() && !remindedCallbackIds.has(entry.id));
  if (!due.length) return;
  due.forEach((entry) => remindedCallbackIds.add(entry.id));
  notice = due.length === 1 ? `Rückruf fällig: ${due[0].name}` : `${due.length} Rückrufe sind fällig.`;
  renderUnlessEditing();
}

function formSignature(form: HTMLFormElement): string {
  return JSON.stringify(Array.from(new FormData(form).entries()).map(([key, value]) => [key, String(value)]));
}

function markFormClean(form: HTMLFormElement | null): void {
  if (form) form.dataset.initialSignature = formSignature(form);
}

function formIsDirty(form: HTMLFormElement | null): boolean {
  return !!form && form.dataset.initialSignature !== formSignature(form);
}

function showUnsavedPrompt(onSave: () => void, onDiscard: () => void): void {
  if (document.querySelector(".unsaved-prompt-backdrop")) return;
  const prompt = document.createElement("div");
  prompt.className = "unsaved-prompt-backdrop";
  prompt.innerHTML = `<section class="unsaved-prompt" role="alertdialog" aria-modal="true" aria-labelledby="unsaved-title"><h2 id="unsaved-title">Änderungen speichern?</h2><p>Es gibt noch nicht gespeicherte Änderungen.</p><div class="modal-row"><button class="secondary" type="button" data-unsaved="cancel">Abbrechen</button><button class="secondary" type="button" data-unsaved="discard">Verwerfen</button><button class="primary" type="button" data-unsaved="save">Speichern</button></div></section>`;
  document.querySelector(".shell")?.append(prompt);
  prompt.querySelector<HTMLButtonElement>('[data-unsaved="cancel"]')?.addEventListener("click", () => prompt.remove());
  prompt.querySelector<HTMLButtonElement>('[data-unsaved="discard"]')?.addEventListener("click", () => { prompt.remove(); onDiscard(); });
  prompt.querySelector<HTMLButtonElement>('[data-unsaved="save"]')?.addEventListener("click", () => { prompt.remove(); onSave(); });
  prompt.addEventListener("click", (event) => { if (event.target === prompt) prompt.remove(); });
}

async function requestFormClose(selector: string, onDiscard: () => void): Promise<void> {
  const form = document.querySelector<HTMLFormElement>(selector);
  if (!formIsDirty(form)) { onDiscard(); return; }
  showUnsavedPrompt(() => form?.requestSubmit(), onDiscard);
}

async function requestSettingsClose(): Promise<void> {
  const audioForm = document.querySelector<HTMLFormElement>("#audio-form");
  const settingsForm = document.querySelector<HTMLFormElement>("#settings-form");
  const dirtyAudio = formIsDirty(audioForm);
  const dirtySettings = formIsDirty(settingsForm);
  const discard = () => { settingsOpen = false; render(); };
  if (!dirtyAudio && !dirtySettings) { discard(); return; }
  showUnsavedPrompt(() => {
    // Beide Formulare besitzen eigene Speicherwege. Das wichtigere Kontenformular
    // wird zuletzt ausgelöst, weil dessen asynchroner Abschluss die Ansicht rendert.
    closeSettingsAfterSave = true;
    if (dirtyAudio) audioForm?.dispatchEvent(new SubmitEvent("submit", { bubbles: true, cancelable: true }));
    if (dirtySettings) settingsForm?.requestSubmit();
    else { closeSettingsAfterSave = false; settingsOpen = false; render(); }
  }, discard);
}

function toggleFavorite(contactId: string): void {
  contacts = contacts.map((contact) => contact.id === contactId ? { ...contact, favorite: !contact.favorite } : contact);
  persistContacts();
  render();
}

async function syncCardDav(): Promise<void> {
  syncState = "syncing";
  render();

  try {
    const synced = await syncCardDavContacts(settings, cardDavPassword);
    const favoriteIds = loadFavoriteIds();
    const contactsWithPhones = synced.filter((contact) => contact.phones.length > 0);
    contacts = applyFavorites(contactsWithPhones, favoriteIds);
    persistContacts();
    syncState = "ok";
    lastCardDavSyncAt = Date.now();
    lastCardDavSyncCount = contactsWithPhones.length;
    localStorage.setItem("nivako-softphone.carddav-last-sync-at", String(lastCardDavSyncAt));
    localStorage.setItem("nivako-softphone.carddav-last-sync-count", String(lastCardDavSyncCount));
  } catch (error) {
    syncState = "error";
    notice = "Kontakte konnten nicht aktualisiert werden. Bitte CardDAV-Einstellungen prüfen.";
  }

  render();
}

async function updateCredentialState(): Promise<void> {
  if (!isTauriRuntime()) return;
  try {
    hasStoredCardDavPassword = await hasSecretNative("NIVAKO Softphone CardDAV", settings.cardDavUser);
    hasStoredSipPassword = await hasSecretNative("NIVAKO Softphone SIP", settings.sipExtension);
  } catch {
    hasStoredCardDavPassword = false;
    hasStoredSipPassword = false;
  }
}

async function startDesktopServices(): Promise<void> {
  if (!isTauriRuntime()) return;
  const tasks: Promise<void>[] = [];

  if (hasStoredCardDavPassword) {
    tasks.push(syncCardDav());
  }

  if (hasStoredSipPassword && !state.registered) {
    // SIP darf nie auf einen langsamen oder fehlerhaften CardDAV-Abruf warten.
    tasks.push(registerSip());
  }

  if (tasks.length === 0) {
    notice = "Desktop-Modus bereit. Hinterlegte CardDAV-/SIP-Zugangsdaten fehlen noch.";
    render();
    return;
  }

  await Promise.allSettled(tasks);
}

function scheduleDesktopMaintenance(): void {
  if (!isTauriRuntime()) return;
  if (cardDavTimer) window.clearInterval(cardDavTimer);
  if (sipReconnectTimer) window.clearInterval(sipReconnectTimer);
  if (sipStatusTimer) window.clearInterval(sipStatusTimer);

  cardDavTimer = window.setInterval(() => {
    if (hasStoredCardDavPassword && syncState !== "syncing") {
      void syncCardDav();
    }
  }, cardDavRefreshMs);

  sipReconnectTimer = window.setInterval(() => {
    if (hasStoredSipPassword && !state.registered && state.callState === "idle") {
      void registerSip();
    }
  }, sipReconnectMs);

  sipStatusTimer = window.setInterval(() => {
    void getSipStatusNative()
      .then(applyNativeSipSnapshot)
      .catch(() => undefined);
  }, sipStatusPollMs);
  if (presenceTimer !== undefined) window.clearInterval(presenceTimer);
  presenceTimer = window.setInterval(() => void refreshPresence(), 15000);
  void refreshPresence();
}

async function saveEnteredSecrets(): Promise<void> {
  if (!isTauriRuntime()) return;
  if (cardDavPassword) {
    await saveSecretNative("NIVAKO Softphone CardDAV", settings.cardDavUser, cardDavPassword);
    hasStoredCardDavPassword = true;
    cardDavPassword = "";
  }
  if (sipPassword) {
    await saveSecretNative("NIVAKO Softphone SIP", settings.sipExtension, sipPassword);
    hasStoredSipPassword = true;
    sipPassword = "";
  }
}

async function importVCards(file: File): Promise<void> {
  const text = await file.text();
  const imported = parseManyVCards(text).filter((contact) => contact.phones.length > 0);
  const existingIds = new Set(contacts.map((contact) => contact.id));
  contacts = [...contacts, ...imported.filter((contact) => !existingIds.has(contact.id))];
  persistContacts();
  notice = `${imported.length} Kontakte aus vCard-Datei importiert.`;
  render();
}

function renderContact(contact: Contact): string {
  const primaryPhone = contact.phones.find((phone) => phone.primary) || contact.phones[0];
  const initials = contact.displayName.split(" ").map((part) => part[0]).join("").slice(0, 2).toUpperCase();
  const details = [contact.organization, contact.email].filter(Boolean).join(" · ") || contact.source || "Kontakt";
  const extraCount = Math.max(0, contact.phones.length - 1);
  const primaryLabel = primaryPhone ? phoneLabelNames[primaryPhone.label] : "";
  const extension = internalExtension(contact);
  const presence = extension ? presenceStates[extension] || "pending" : "";

  return `
    <div class="contact-row">
      <div class="contact-body">
        <button class="contact-select" data-number="${escapeHtml(primaryPhone?.normalized || "")}" data-contact="${escapeHtml(contact.id)}">
          <span class="avatar">${contact.photoUrl ? `<img src="${escapeHtml(contact.photoUrl)}" alt="" />` : escapeHtml(initials || "?")}</span>
          <span class="contact-main">
            <strong>${escapeHtml(contact.displayName)}${extension ? ` <span class="presence-badge ${escapeHtml(presence)}"><i></i>${escapeHtml(presenceLabel(extension))}</span>` : ""}</strong>
            <small>${escapeHtml(details)}</small>
          </span>
          <span class="contact-number">
            <span>${escapeHtml(primaryPhone?.raw || "Keine Nummer")}</span>
            <small>${escapeHtml(primaryLabel)}${extraCount ? ` · ${extraCount} weitere` : ""}</small>
          </span>
        </button>
      </div>
      <button class="favorite-button ${contact.favorite ? "active" : ""}" title="Favorit umschalten" data-favorite="${escapeHtml(contact.id)}">${contact.favorite ? "★" : "☆"}</button>
    </div>
  `;
}

function renderAlphabeticalContacts(items: Contact[]): string {
  const sorted = sortedContacts(items);
  const letters = [...new Set(sorted.map(contactLetter))];
  if (!sorted.length) return '<div class="empty large">Keine Treffer</div>';
  return `<div class="contact-directory"><div class="contact-list grouped-contact-list">
    ${letters.map((letter) => `<section class="contact-group" id="contacts-${letter === "#" ? "other" : letter}"><h2>${letter}</h2>${sorted.filter((contact) => contactLetter(contact) === letter).map(renderContact).join("")}</section>`).join("")}
  </div><nav class="alphabet-rail" aria-label="Alphabetische Schnellnavigation">${letters.map((letter) => `<button type="button" data-letter="${letter === "#" ? "other" : letter}">${letter}</button>`).join("")}</nav></div>`;
}

function renderCompanyContacts(items: Contact[]): string {
  const companies = new Map<string, Contact[]>();
  for (const contact of sortedContacts(items)) {
    const company = contact.organization?.trim() || "Ohne Firma";
    companies.set(company, [...(companies.get(company) || []), contact]);
  }
  return `<div class="contact-list company-list">${[...companies.entries()].sort(([a], [b]) => a.localeCompare(b, "de")).map(([company, members]) => {
    const open = expandedCompanies.has(company);
    return `<section class="company-group"><button type="button" class="company-toggle" data-company="${escapeHtml(company)}"><span>${open ? "▾" : "▸"}</span><strong>${escapeHtml(company)}</strong><small>${members.length} ${members.length === 1 ? "Kontakt" : "Kontakte"}</small></button>${open ? members.map(renderContact).join("") : ""}</section>`;
  }).join("") || '<div class="empty large">Keine Treffer</div>'}</div>`;
}

function renderHistoryList(emptyText: string): string {
  const entries = [...callHistory].filter((entry) => historyFilter === "all" || entry.direction === historyFilter)
    .filter((entry) => `${entry.name} ${entry.number}`.toLowerCase().includes(historyQuery.toLowerCase()));
  entries.sort((a, b) => Number(Boolean(b.callbackRequested)) - Number(Boolean(a.callbackRequested)) || String(a.callbackDueAt || "9999").localeCompare(String(b.callbackDueAt || "9999")));
  if (entries.length === 0) return `<div class="empty large">${emptyText}</div>`;
  return `
    <div class="contact-list">
      ${entries.map((entry) => `
        <div class="history-entry ${entry.callbackRequested ? "callback-open" : ""} ${entry.callbackRequested && entry.callbackDueAt && new Date(entry.callbackDueAt).getTime() < Date.now() ? "callback-overdue" : ""}"><button class="history-row" data-number="${escapeHtml(entry.number)}">
          <span class="history-icon">${entry.direction === "missed" ? "!" : entry.direction === "inbound" ? "↓" : "↑"}</span>
          <span class="history-main">
            <strong>${escapeHtml(entry.name)}</strong>
            <small>${escapeHtml(entry.number)}</small>
          </span>
          <small class="history-meta">${escapeHtml(callResultText(entry.result))}${entry.durationSeconds !== undefined ? ` · ${formatDuration(entry.durationSeconds)}` : ""} · ${escapeHtml(entry.time)}</small>
        </button><div class="history-actions"><button class="history-callback ${entry.callbackRequested ? "active" : ""}" data-callback-id="${escapeHtml(entry.id)}">${entry.callbackRequested ? "Als erledigt markieren" : "Rückruf öffnen"}</button><button class="history-callback" data-note-id="${escapeHtml(entry.id)}">${entry.note ? "Notiz / Termin" : "Notiz / Termin"}</button><button class="history-callback" data-assign-id="${escapeHtml(entry.id)}">Kontakt zuordnen</button></div>${entry.callbackRequested && entry.callbackDueAt ? `<p class="callback-due">Rückruf ${new Date(entry.callbackDueAt).getTime() < Date.now() ? "überfällig" : "fällig"}: ${escapeHtml(new Date(entry.callbackDueAt).toLocaleString("de-DE"))}</p>` : ""}${entry.note ? `<p class="history-note">${escapeHtml(entry.note)}</p>` : ""}</div>
      `).join("")}
    </div>
  `;
}

function renderHistoryNoteModal(): string {
  if (!editingHistoryId) return "";
  const entry = callHistory.find((candidate) => candidate.id === editingHistoryId);
  if (!entry) return "";
  return `<div class="settings-modal-backdrop"><section class="phone-picker" role="dialog" aria-modal="true"><header><div><h1>Gesprächsnotiz & Rückruf</h1><p>${escapeHtml(entry.name)} · ${escapeHtml(entry.number)}</p></div><button class="modal-close" id="close-history-note">×</button></header><form id="history-note-form" class="settings-list"><textarea name="note" rows="5" placeholder="Ergebnis oder nächste Schritte festhalten">${escapeHtml(entry.note || "")}</textarea><label><span>Rückruf fällig</span><input name="callbackDueAt" type="datetime-local" value="${escapeHtml(entry.callbackDueAt || "")}" /></label><div class="modal-row"><button class="secondary" type="button" id="cancel-history-note">Abbrechen</button><button class="primary" type="submit">Speichern</button></div></form></section></div>`;
}

function renderHistoryAssignmentModal(): string {
  if (!assigningHistoryId) return "";
  const entry = callHistory.find((candidate) => candidate.id === assigningHistoryId);
  if (!entry) return "";
  const initialQuery = entry.name === entry.number ? "" : entry.name;
  const matches = searchContacts(contacts, historyAssignmentQuery || initialQuery);
  return `<div class="settings-modal-backdrop history-assignment-backdrop"><section class="phone-picker history-assignment-modal" role="dialog" aria-modal="true" aria-labelledby="history-assignment-title"><header><div><h1 id="history-assignment-title">Nummer zuordnen</h1><p>${escapeHtml(entry.number)} einem Kontakt hinzufügen</p></div><button class="modal-close" id="close-history-assignment" aria-label="Schließen">×</button></header><div class="history-assignment-search"><input class="search" id="history-assignment-search" value="${escapeHtml(historyAssignmentQuery)}" placeholder="Kontakt oder Firma suchen" autofocus /></div><div class="phone-picker-list history-assignment-list">${matches.map((contact) => `<button type="button" data-assign-contact="${escapeHtml(contact.id)}"><span><strong>${escapeHtml(contact.displayName)}</strong><small>${escapeHtml(contact.organization || contact.email || "Kontakt")}</small></span><b>Hinzufügen</b></button>`).join("") || "<p>Keine Kontakte gefunden.</p>"}</div></section></div>`;
}

async function assignHistoryNumberToContact(contactId: string): Promise<void> {
  const entry = callHistory.find((candidate) => candidate.id === assigningHistoryId);
  const contact = contacts.find((candidate) => candidate.id === contactId);
  if (!entry || !contact) return;
  const normalized = normalizePhoneNumber(entry.number);
  if (contact.phones.some((phone) => phone.normalized === normalized)) {
    assigningHistoryId = null;
    notice = "Diese Nummer gehört bereits zum Kontakt.";
    render();
    return;
  }
  let updated: Contact = { ...contact, phones: [...contact.phones, { label: "other", raw: entry.number, normalized }] };
  try {
    if (isTauriRuntime()) updated = await writeCardDavContactNative(settings, updated, cardDavPassword);
    contacts = contacts.map((candidate) => candidate.id === contactId ? updated : candidate);
    callHistory = callHistory.map((candidate) => candidate.number === entry.number ? { ...candidate, name: updated.displayName } : candidate);
    persistContacts();
    saveHistory(callHistory);
    assigningHistoryId = null;
    notice = `Nummer wurde ${updated.displayName} zugeordnet.`;
  } catch (error) {
    notice = errorMessage(error, "Nummer konnte nicht zugeordnet werden");
  }
  render();
}

function renderMainPanel(visibleContacts: Contact[]): string {
  if (activeView === "history") {
    return `
      <section class="contacts-panel">
        <div class="panel-header">
          <div>
            <h1>Verlauf</h1>
            <p>Ihre letzten Anrufe auf diesem Gerät</p>
          </div>
          <button class="sync-button" id="clear-history">Leeren</button>
        </div>
        <input class="search" id="history-search" placeholder="Verlauf durchsuchen" value="${escapeHtml(historyQuery)}" />
        <div class="history-filters">${([['all','Alle'],['missed','Verpasst'],['inbound','Eingehend'],['outbound','Ausgehend']] as const).map(([value,label]) => `<button class="${historyFilter === value ? 'active' : ''}" data-history-filter="${value}">${label}</button>`).join("")}</div>
        ${renderHistoryList("Keine passenden Anrufe vorhanden.")}
      </section>
    `;
  }

  if (activeView === "favorites") {
    const frequentIds = frequentContactIds();
    const favorites = sortedContacts(visibleContacts.filter((contact) => contact.favorite));
    const frequent = frequentIds
      .map((id) => visibleContacts.find((contact) => contact.id === id))
      .filter((contact): contact is Contact => Boolean(contact))
      .filter((contact) => !contact.favorite);
    return `
      <section class="contacts-panel">
        <div class="panel-header">
          <div>
            <h1>Favoriten</h1>
            <p>${favorites.length} lokale Favoriten</p>
          </div>
        </div>
        <input class="search" id="search" placeholder="Favoriten suchen" value="${escapeHtml(query)}" />
        <div class="contact-list">${favorites.length ? `<h2>Favoriten</h2>${favorites.map(renderContact).join("")}` : ""}${frequent.length ? `<h2 class="list-subheading">Häufig angerufen</h2>${frequent.map(renderContact).join("")}` : ""}${!favorites.length && !frequent.length ? '<div class="empty large">Noch keine Favoriten oder häufigen Kontakte vorhanden.</div>' : ""}</div>
      </section>
    `;
  }

  if (activeView === "audio") {
    const inputOptions = audioDevices.inputs.map((device, index) => `<option value="${escapeHtml(device.deviceId)}" ${settings.selectedMicrophoneId === device.deviceId ? "selected" : ""}>${escapeHtml(device.label || `Mikrofon ${index + 1}`)}</option>`).join("");
    const outputOptions = audioDevices.outputs.map((device, index) => `<option value="${escapeHtml(device.deviceId)}" ${settings.selectedSpeakerId === device.deviceId ? "selected" : ""}>${escapeHtml(device.label || `Lautsprecher ${index + 1}`)}</option>`).join("");
    return `
      <section class="contacts-panel">
        <div class="panel-header">
          <div>
            <h1>Audio</h1>
            <p>${audioDevices.inputs.length} Eingaben · ${audioDevices.outputs.length} Ausgaben · Zugriff: ${audioDevices.permission}</p>
          </div>
          <button class="sync-button" id="refresh-audio">Geraete suchen</button>
        </div>
        <form class="settings-list" id="audio-form">
          <label><span>Mikrofon</span><select name="selectedMicrophoneId"><option value="">Systemstandard</option>${inputOptions}</select></label>
          <label><span>Lautsprecher</span><select name="selectedSpeakerId"><option value="">Systemstandard</option>${outputOptions}</select></label>
          <div class="modal-row"><button class="secondary" type="button" id="test-speaker">Testton</button><button class="primary" type="submit">Audio speichern</button></div>
        </form>
      </section>
    `;
  }

  if (activeView === "settings") {
    return `
      <section class="contacts-panel">
        <div class="panel-header">
          <div>
            <h1>Einstellungen</h1>
            <p>Lokale Konfiguration fuer CardDAV und ausgehende Anrufe</p>
          </div>
        </div>
        <form class="settings-list" id="settings-form">
          <label><span>CardDAV URL</span><input name="cardDavUrl" value="${escapeHtml(settings.cardDavUrl)}" /></label>
          <label><span>CardDAV Benutzer</span><input name="cardDavUser" value="${escapeHtml(settings.cardDavUser)}" /></label>
          <label><span>CardDAV Passwort ${isTauriRuntime() && hasStoredCardDavPassword ? "(gespeichert)" : ""}</span><input name="cardDavPassword" type="password" value="${escapeHtml(cardDavPassword)}" autocomplete="off" /></label>
          <label><span>SIP-Server</span><input name="sipServer" value="${escapeHtml(settings.sipServer)}" /></label>
          <label><span>SIP-Benutzer</span><input name="sipExtension" value="${escapeHtml(settings.sipExtension)}" /></label>
          <label><span>SIP Auth-ID</span><input name="sipAuthUser" value="${escapeHtml(settings.sipAuthUser || settings.sipExtension)}" /></label>
          <label><span>SIP Anzeigename</span><input name="sipDisplayName" value="${escapeHtml(settings.sipDisplayName)}" /></label>
          <label><span>SIP WebSocket</span><input name="sipWebSocketUrl" value="${escapeHtml(settings.sipWebSocketUrl)}" /></label>
          <label><span>Erlaubte Testnummern</span><input name="allowedTestNumbers" value="${escapeHtml(settings.allowedTestNumbers)}" /></label>
          <label><span>SIP Passwort ${isTauriRuntime() && hasStoredSipPassword ? "(gespeichert)" : "nur fuer diese Sitzung"}</span><input name="sipPassword" type="password" value="${escapeHtml(sipPassword)}" autocomplete="off" /></label>
          <label class="check-row"><input type="checkbox" name="safeCallMode" ${settings.safeCallMode ? "checked" : ""} /><span>Anrufschutz aktiv</span></label>
          <label class="check-row"><input type="checkbox" name="useTelLinks" ${settings.useTelLinks ? "checked" : ""} /><span>Ausgehende Anrufe an Windows tel:-Handler uebergeben</span></label>
          <label class="check-row"><input type="checkbox" name="enableWebRtcSip" ${settings.enableWebRtcSip ? "checked" : ""} /><span>SIP ueber WebRTC/WebSocket aktivieren</span></label>
          <button class="primary" type="submit">Speichern</button>
        </form>
      </section>
    `;
  }

  return `
    <section class="contacts-panel">
      <div class="panel-header">
        <div>
          <h1>Telefonbuch</h1>
          <p>${contacts.length} Kontakte</p>
        </div>
        <button class="sync-button" id="new-contact">+ Kontakt</button>
      </div>
      <div class="directory-toolbar"><input class="search" id="search" placeholder="Name, Firma oder Nummer suchen" value="${escapeHtml(query)}" /><div class="layout-switch"><button type="button" data-layout="alphabetical" class="${contactLayout === "alphabetical" ? "active" : ""}">A–Z</button><button type="button" data-layout="companies" class="${contactLayout === "companies" ? "active" : ""}">Firmen</button></div></div>
      ${contactLayout === "alphabetical" ? renderAlphabeticalContacts(visibleContacts) : renderCompanyContacts(visibleContacts)}
    </section>
  `;
}

function navButton(view: View, label: string): string {
  return `<button data-view="${view}" class="${activeView === view ? "active" : ""}">${label}</button>`;
}

function telephonyStatusText(): string {
  if (state.registered) return settings.sipDisplayName ? `${settings.sipDisplayName} ist online` : "Benutzer online";
  if (settings.safeCallMode) return "Anrufschutz aktiv";
  if (settings.enableWebRtcSip) return "SIP-WebRTC bereit";
  if (canUseNativeTelephony()) return "Telefonie noch nicht verbunden";
  if (settings.useTelLinks) return "tel:-Uebergabe aktiv";
  return "SIP-Core fehlt";
}

function renderSettingsModal(): string {
  const inputOptions = audioDevices.inputs.map((device, index) => `<option value="${escapeHtml(device.deviceId)}" ${settings.selectedMicrophoneId === device.deviceId ? "selected" : ""}>${escapeHtml(device.label || `Mikrofon ${index + 1}`)}</option>`).join("");
  const outputOptions = audioDevices.outputs.map((device, index) => `<option value="${escapeHtml(device.deviceId)}" ${settings.selectedSpeakerId === device.deviceId ? "selected" : ""}>${escapeHtml(device.label || `Lautsprecher ${index + 1}`)}</option>`).join("");
  return `<div class="settings-modal-backdrop"><section class="settings-modal" role="dialog" aria-modal="true" aria-labelledby="settings-title">
    <header><div><h1 id="settings-title">Einstellungen</h1><p>Telefonie, Kontakte und Audio</p></div><div class="settings-header-meta"><span>Version: ${escapeHtml(appVersion)}</span><button class="modal-close" id="close-settings" aria-label="Schließen">×</button></div></header>
    <div class="settings-modal-content">
      <h2>Audio</h2>
      <form class="settings-list compact-settings" id="audio-form">
        <label><span>Mikrofon</span><select name="selectedMicrophoneId"><option value="">Systemstandard</option>${inputOptions}</select></label>
        <label><span>Lautsprecher</span><select name="selectedSpeakerId"><option value="">Systemstandard</option>${outputOptions}</select></label>
        <label><span id="speaker-volume-label">Lautstärke (${settings.speakerVolume} %)</span><input name="speakerVolume" type="range" min="0" max="100" value="${settings.speakerVolume}" /></label>
        <label><span id="microphone-volume-label">Mikrofonpegel (${settings.microphoneVolume} %)</span><input name="microphoneVolume" type="range" min="0" max="100" value="${settings.microphoneVolume}" /></label>
        <label><span>Klingelton</span><select name="ringtone"><option value="standard" ${settings.ringtone === "standard" ? "selected" : ""}>NIVAKO Standard</option><option value="soft" ${settings.ringtone === "soft" ? "selected" : ""}>Sanft</option><option value="bright" ${settings.ringtone === "bright" ? "selected" : ""}>Klar</option><option value="silent" ${settings.ringtone === "silent" ? "selected" : ""}>Lautlos</option></select></label>
        <div class="microphone-meter"><i id="microphone-test-level"></i></div><div class="modal-row"><button class="secondary" type="button" id="test-microphone">Pegel testen</button><button class="secondary" type="button" id="record-microphone">5-Sek.-Aufnahme</button>${microphoneRecordingUrl ? `<audio class="microphone-playback" controls src="${escapeHtml(microphoneRecordingUrl)}"></audio>` : ""}<button class="secondary" type="button" id="test-ringtone">Klingelton testen</button><button class="secondary" type="button" id="test-speaker">Testton</button><button class="secondary" type="button" id="refresh-audio">Geräte aktualisieren</button><button class="primary" type="submit">Audio speichern</button></div>
      </form>
      <h2>Konten</h2>
      <form class="settings-list compact-settings" id="settings-form">
        <h2>App-Verhalten</h2>
        <label class="check-row"><input type="checkbox" name="launchAtStartup" ${settings.launchAtStartup ? "checked" : ""} /><span>Softphone automatisch mit Windows starten</span></label>
        <label class="check-row"><input type="checkbox" name="closeToTray" ${settings.closeToTray ? "checked" : ""} /><span>Beim Schließen im Infobereich weiterlaufen</span></label>
        <label class="check-row"><input type="checkbox" name="compactMode" ${settings.compactMode ? "checked" : ""} /><span>Kompaktmodus für kleine Fenster</span></label>
        <label><span>Parkposition / Park-Erweiterung</span><input name="parkExtension" value="${escapeHtml(settings.parkExtension)}" /></label>
        <label><span>Übernahme-Code</span><input name="pickupCode" value="${escapeHtml(settings.pickupCode)}" /></label>
        <label><span>Kurzwahlen (Komma-getrennt)</span><input name="speedDialNumbers" value="${escapeHtml(settings.speedDialNumbers)}" placeholder="102, 103, +495021..." /></label>
        <h2>Tastenkürzel</h2>
        <label><span>Suche</span><input name="searchShortcut" value="${escapeHtml(settings.searchShortcut)}" /></label>
        <label><span>Anrufen</span><input name="dialShortcut" value="${escapeHtml(settings.dialShortcut)}" /></label>
        <label><span>Stummschalten</span><input name="muteShortcut" value="${escapeHtml(settings.muteShortcut)}" /></label>
        <label><span>CardDAV URL</span><input name="cardDavUrl" value="${escapeHtml(settings.cardDavUrl)}" /></label>
        <label><span>CardDAV Benutzer</span><input name="cardDavUser" value="${escapeHtml(settings.cardDavUser)}" /></label>
        <label><span>CardDAV Passwort ${isTauriRuntime() && hasStoredCardDavPassword ? "(gespeichert)" : ""}</span><input name="cardDavPassword" type="password" value="${escapeHtml(cardDavPassword)}" autocomplete="off" /></label>
        <label><span>SIP-Server</span><input name="sipServer" value="${escapeHtml(settings.sipServer)}" /></label>
        <label><span>SIP-Benutzer</span><input name="sipExtension" value="${escapeHtml(settings.sipExtension)}" /></label>
        <label><span>SIP Auth-ID</span><input name="sipAuthUser" value="${escapeHtml(settings.sipAuthUser || settings.sipExtension)}" /></label>
        <label><span>SIP Anzeigename</span><input name="sipDisplayName" value="${escapeHtml(settings.sipDisplayName)}" /></label>
        <label><span>SIP Passwort ${isTauriRuntime() && hasStoredSipPassword ? "(gespeichert)" : ""}</span><input name="sipPassword" type="password" value="${escapeHtml(sipPassword)}" autocomplete="off" /></label>
        <details><summary>Erweiterte Einstellungen</summary>
          <label><span>SIP WebSocket</span><input name="sipWebSocketUrl" value="${escapeHtml(settings.sipWebSocketUrl)}" /></label>
          <label><span>Erlaubte Testnummern</span><input name="allowedTestNumbers" value="${escapeHtml(settings.allowedTestNumbers)}" /></label>
          <label class="check-row"><input type="checkbox" name="safeCallMode" ${settings.safeCallMode ? "checked" : ""} /><span>Anrufschutz aktiv</span></label>
          <label class="check-row"><input type="checkbox" name="useTelLinks" ${settings.useTelLinks ? "checked" : ""} /><span>Windows-Telefonhandler verwenden</span></label>
          <label class="check-row"><input type="checkbox" name="enableWebRtcSip" ${settings.enableWebRtcSip ? "checked" : ""} /><span>SIP über WebRTC aktivieren</span></label>
        </details>
        <button class="primary" type="submit">Einstellungen speichern</button>
      </form>
      <h2>Kontakte</h2>
      <div class="contact-settings-actions">
        <button class="secondary" id="sync-carddav" ${syncState === "syncing" ? "disabled" : ""}>${syncState === "syncing" ? "Kontakte werden aktualisiert …" : "CardDAV jetzt aktualisieren"}</button>
        <button class="secondary" id="merge-duplicates" ${duplicateGroups().length ? "" : "disabled"}>Dubletten zusammenführen</button>
        <label class="file-button">vCard-Datei importieren<input id="vcard-import" type="file" accept=".vcf,text/vcard,text/x-vcard" /></label>
      </div>
      <p class="settings-status">Dublettenprüfung: ${duplicateGroups().length ? `${duplicateGroups().length} mögliche Dublettengruppe(n) erkannt. Gleiche Rufnummern oder E-Mail-Adressen bitte vor dem Löschen im CRM prüfen.` : "Keine Dubletten anhand identischer Rufnummern oder E-Mail-Adressen erkannt."}</p>
      <p class="settings-status">${syncState === "syncing"
        ? "CardDAV wird gerade aktualisiert …"
        : lastCardDavSyncAt
          ? `Zuletzt erfolgreich synchronisiert: ${new Date(lastCardDavSyncAt).toLocaleString("de-DE")} · ${lastCardDavSyncCount} Kontakte mit Telefonnummer`
          : "CardDAV wurde noch nicht erfolgreich synchronisiert."}</p>
      <details class="diagnostics"><summary>Diagnose</summary>
        <dl><div><dt>Telefonie</dt><dd>${escapeHtml(state.registered ? "Verbunden" : "Getrennt")}</dd></div><div><dt>Letzter SIP-Status</dt><dd>${escapeHtml(sipNotice)}</dd></div><div><dt>CardDAV</dt><dd>${escapeHtml(syncState === "error" ? "Fehler beim letzten Abgleich" : syncState === "syncing" ? "Abgleich läuft" : lastCardDavSyncAt ? `Zuletzt erfolgreich ${new Date(lastCardDavSyncAt).toLocaleString("de-DE")}` : "Noch kein erfolgreicher Abgleich")}</dd></div></dl>
      </details>
    </div>
  </section></div>`;
}

function render(): void {
  const previousContactScroll = document.querySelector<HTMLElement>(".contact-list")?.scrollTop;
  const visibleContacts = searchContacts(contacts, query);
  const keypad = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "*", "0", "#"];
  if (notice !== lastToastNotice) {
    lastToastNotice = notice;
    toastUntil = Date.now() + 3600;
    if (toastTimer !== undefined) window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => renderUnlessEditing(), 3650);
  }
  const showToast = toastUntil > Date.now();
  const incomingName = state.activeContact?.displayName || state.remoteIdentity || "Unbekannter Anrufer";
  const incomingInitials = incomingName.split(" ").map((part) => part[0]).join("").slice(0, 2).toUpperCase() || "?";

  root.innerHTML = `
    <section class="shell ${settings.compactMode ? "compact-mode" : ""} ${miniMode ? "mini-mode" : ""}">
      <header class="topbar">
        <div class="brand">
          <img class="brand-logo" src="${brandLogoUrl}" alt="NIVAKO Softphone – VoIP Client" />
        </div>
        <nav class="nav">
          ${navButton("contacts", "Kontakte")}
          ${navButton("history", `Verlauf${callHistory.filter((entry) => entry.direction === "missed" && entry.callbackRequested).length ? ` (${callHistory.filter((entry) => entry.direction === "missed" && entry.callbackRequested).length})` : ""}`)}
          ${navButton("favorites", "Favoriten")}
        </nav>
        <div class="topbar-actions">
          <span class="user-presence ${state.registered ? "online" : "offline"}"><i></i>${escapeHtml(settings.sipExtension)} · ${state.registered ? "Online" : "Offline"}</span>
          <button class="dnd-trigger ${settings.doNotDisturb ? "active" : ""}" id="toggle-dnd" title="Nicht stören" aria-pressed="${settings.doNotDisturb}">Nicht stören</button>
          <button class="dnd-trigger ${miniMode ? "active" : ""}" id="toggle-mini" title="Mini-Anrufmodus">Mini</button>
          <button class="settings-trigger" id="open-settings" title="Einstellungen" aria-label="Einstellungen">⚙</button>
        </div>
      </header>

      ${renderMainPanel(visibleContacts)}

      <section class="phone-panel">
        <div class="call-card ${state.callState !== "idle" ? "in-call" : "idle-call"}">
          ${state.registered ? "" : `<div class="connection-alert"><strong>${escapeHtml(telephonyStatusText())}</strong><span>Telefonie verbinden, um Anrufe zu starten.</span></div>`}
          <div class="callee">
            <strong>${escapeHtml(state.activeContact?.displayName || state.remoteIdentity || state.activeNumber || "Nummer wählen")}</strong>
            <small>${escapeHtml(state.activeContact?.organization || state.activeNumber || "Nummer eingeben oder Kontakt auswählen")}</small>
          </div>
          ${state.callState !== "idle" ? `<div class="live-call-status"><span id="live-call-duration">${formatDuration(callStartedAt ? Math.round((Date.now() - callStartedAt) / 1000) : 0)}</span><span>${state.muted ? "Mikrofon stumm" : "Mikrofon aktiv"}</span><span>${escapeHtml(canUseNativeTelephony() ? "liblinphone" : settings.enableWebRtcSip ? "WebRTC-SIP" : "Telefonhandler")}</span></div>` : ""}
          <input class="number-input" id="number-input" value="${escapeHtml(state.activeNumber)}" placeholder="+49..." />
          ${speedDials().length ? `<div class="speed-dials" aria-label="Kurzwahlen">${speedDials().map((number) => `<button class="secondary" type="button" data-speed-dial="${escapeHtml(number)}">${escapeHtml(speedDialLabel(number))}</button>`).join("")}</div>` : ""}
          <div class="keypad">
            ${keypad.map((digit) => `<button data-digit="${digit}">${digit}</button>`).join("")}
          </div>
          <div class="call-actions">
            ${state.registered ? "" : `<button class="secondary" id="register-sip" ${settings.enableWebRtcSip || canUseNativeTelephony() ? "" : "disabled"}>Verbinden</button>`}
            <button class="primary" id="dial" ${!state.activeNumber && state.callState !== "ringing" ? "disabled" : ""}>${state.callState === "ringing" ? "Annehmen" : settings.safeCallMode ? "Lokal erfassen" : "Anrufen"}</button>
            ${state.callState === "idle" ? "" : `<button class="danger" id="hangup">${state.callState === "ringing" ? "Ablehnen" : "Auflegen"}</button>`}
          </div>
          <div class="call-actions compact-actions">
            ${state.callState === "idle" ? `<button class="secondary backspace-action" id="backspace" ${!state.activeNumber ? "disabled" : ""}>⌫ Löschen</button>` : `
              <button class="secondary" id="hold">${state.callState === "held" ? "Fortsetzen" : "Halten"}</button>
              <button class="secondary" id="mute">${state.muted ? "Mikrofon an" : "Stumm"}</button>
              <button class="secondary" id="transfer" ${state.callState === "active" || state.callState === "held" ? "" : "disabled"}>Weiterleiten</button>
              <button class="secondary" id="park-call" ${state.callState === "active" || state.callState === "held" ? "" : "disabled"}>Parken</button>
              <button class="secondary" id="second-call" ${state.callState === "active" ? "" : "disabled"}>Weiteres Gespräch</button>
              ${hasSecondCall ? '<button class="secondary active" id="switch-call">Gespräch wechseln</button>' : ""}
              ${hasSecondCall ? '<button class="secondary active" id="attended-transfer">Nach Rückfrage übergeben</button>' : ""}
              ${hasSecondCall ? '<button class="secondary active conference-action" id="conference">Konferenz starten</button>' : ""}
            `}
          </div>
          ${state.callState === "idle" && settings.pickupCode ? `<button class="secondary pickup-action" id="pickup-call">Geparkten/Gruppenruf übernehmen (${escapeHtml(settings.pickupCode)})</button>` : ""}
          ${hasSecondCall ? `<div class="line-overview"><div class="line-card active"><small>Aktives Gespräch</small><strong>${escapeHtml(state.activeContact?.displayName || state.remoteIdentity || state.activeNumber)}</strong><span>${escapeHtml(state.activeNumber)}</span></div><div class="line-card held"><small>Gehaltenes Gespräch</small><strong>${escapeHtml(waitingCallName || "Zweite Leitung")}</strong><span>${escapeHtml(waitingCallNumber)}</span></div></div>` : ""}
        </div>

      </section>
      ${showToast ? `<div class="toast ${notificationTone(notice)}" role="status"><strong>${escapeHtml(notice)}</strong></div>` : ""}
      ${state.callState === "ringing" ? `<div class="in-app-call-backdrop"><section class="in-app-call" role="dialog" aria-modal="true"><div class="incoming-avatar">${state.activeContact?.photoUrl ? `<img src="${escapeHtml(state.activeContact.photoUrl)}" alt="" />` : escapeHtml(incomingInitials)}</div><div class="incoming-copy"><span>Eingehender Anruf</span><strong>${escapeHtml(incomingName)}</strong><small>${escapeHtml([state.activeContact?.organization, state.activeNumber || state.remoteIdentity].filter(Boolean).join(" · "))}</small></div><div class="incoming-actions">${state.activeContact ? "" : '<button class="secondary" id="create-incoming-contact">Kontakt anlegen</button>'}<button class="danger" id="overlay-reject">Ablehnen</button><button class="primary" id="overlay-accept">Annehmen</button></div></section></div>` : ""}
      ${settingsOpen ? renderSettingsModal() : ""}
      ${renderCallActionModal()}
      ${renderContactMenu()}
      ${renderPhonePicker()}
      ${renderContactEditor()}
      ${renderHistoryNoteModal()}
      ${renderHistoryAssignmentModal()}
    </section>
  `;

  bindEvents();
  if (callClockTimer !== undefined) window.clearInterval(callClockTimer);
  callClockTimer = state.callState === "active" || state.callState === "held" ? window.setInterval(() => {
    const clock = document.querySelector<HTMLElement>("#live-call-duration");
    if (clock) clock.textContent = formatDuration(callStartedAt ? Math.round((Date.now() - callStartedAt) / 1000) : 0);
  }, 1000) : undefined;
  if (previousContactScroll !== undefined) {
    const list = document.querySelector<HTMLElement>(".contact-list");
    if (list) list.scrollTop = previousContactScroll;
  }
}

function bindPhoneRowEvents(): void {
  const rows = Array.from(document.querySelectorAll<HTMLElement>(".phone-editor-row"));
  rows.forEach((row, index) => {
    const radio = row.querySelector<HTMLInputElement>('input[name="primaryPhone"]');
    if (radio) radio.value = String(index);
    row.querySelector<HTMLButtonElement>(".remove-phone-row")?.addEventListener("click", () => {
      if (document.querySelectorAll(".phone-editor-row").length <= 1) return;
      const wasPrimary = radio?.checked;
      row.remove();
      const remaining = Array.from(document.querySelectorAll<HTMLElement>(".phone-editor-row"));
      remaining.forEach((item, nextIndex) => {
        const itemRadio = item.querySelector<HTMLInputElement>('input[name="primaryPhone"]');
        if (itemRadio) itemRadio.value = String(nextIndex);
      });
      if (wasPrimary) remaining[0]?.querySelector<HTMLInputElement>('input[name="primaryPhone"]')?.click();
    }, { once: true });
  });
}

function bindEvents(): void {
  document.addEventListener("click", (event) => {
    if (contactMenu && !(event.target as Element).closest(".contact-context-menu")) {
      contactMenu = null;
      render();
    }
  }, { once: true });

  document.querySelectorAll<HTMLElement>(".contact-row").forEach((row) => {
    row.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      const contactId = row.querySelector<HTMLElement>("[data-contact]")?.dataset.contact;
      if (!contactId) return;
      contactMenu = {
        contactId,
        x: Math.min(event.clientX, window.innerWidth - 250),
        y: Math.min(event.clientY, window.innerHeight - 310)
      };
      render();
    });
  });

  document.querySelectorAll<HTMLButtonElement>("[data-contact-action]").forEach((button) => button.addEventListener("click", () => {
    const contact = selectedContact();
    if (!contact) return;
    const action = button.dataset.contactAction;
    if (action === "call") {
      selectContactNumber(contact, true);
    }
    if (action === "copy-phone") void copyContactValue(contact.phones[0]?.raw || "", "Telefonnummer");
    if (action === "copy-email") void copyContactValue(contact.email || "", "E-Mail-Adresse");
    if (action === "favorite") {
      contactMenu = null;
      toggleFavorite(contact.id);
    }
    if (action === "edit") {
      editingContactId = contact.id;
      editingContactDraft = { ...contact, phones: contact.phones.map((phone) => ({ ...phone })) };
      contactMenu = null;
      render();
    }
    if (action === "delete") void deleteContact(contact.id);
  }));

  document.querySelector<HTMLButtonElement>("#new-contact")?.addEventListener("click", () => {
    editingContactId = `local-${crypto.randomUUID()}`;
    editingContactDraft = { id: editingContactId, displayName: "", phones: [{ label: "work", raw: "", normalized: "", primary: true }], source: "local" };
    render();
  });

  const closeContactEditor = () => void requestFormClose("#contact-editor-form", () => { closeContactOverlays(); render(); });
  document.querySelector<HTMLButtonElement>("#close-contact-editor")?.addEventListener("click", closeContactEditor);
  document.querySelector<HTMLButtonElement>("#cancel-contact-editor")?.addEventListener("click", closeContactEditor);
  document.querySelector<HTMLDivElement>(".contact-editor-backdrop")?.addEventListener("click", (event) => {
    if (event.target === event.currentTarget) closeContactEditor();
  });
  document.querySelector<HTMLFormElement>("#contact-editor-form")?.addEventListener("submit", (event) => {
    event.preventDefault();
    void saveContactEdit(event.currentTarget as HTMLFormElement);
  });
  document.querySelector<HTMLButtonElement>("#add-phone-row")?.addEventListener("click", () => {
    const rows = document.querySelector<HTMLElement>("#phone-editor-rows");
    if (!rows) return;
    rows.insertAdjacentHTML("beforeend", renderPhoneEditorRow({ label: "other", raw: "", normalized: "" }, rows.children.length));
    bindPhoneRowEvents();
  });
  bindPhoneRowEvents();

  document.querySelectorAll<HTMLButtonElement>("[data-view]").forEach((button) => {
    button.addEventListener("click", () => {
      activeView = button.dataset.view as View;
      render();
    });
  });
  document.querySelectorAll<HTMLButtonElement>("[data-layout]").forEach((button) => button.addEventListener("click", () => {
    contactLayout = button.dataset.layout as typeof contactLayout;
    render();
  }));
  document.querySelectorAll<HTMLButtonElement>("[data-letter]").forEach((button) => button.addEventListener("click", () => {
    document.querySelector<HTMLElement>(`#contacts-${button.dataset.letter}`)?.scrollIntoView({ behavior: "smooth", block: "start" });
  }));
  document.querySelectorAll<HTMLButtonElement>("[data-company]").forEach((button) => button.addEventListener("click", () => {
    const company = button.dataset.company || "";
    if (expandedCompanies.has(company)) expandedCompanies.delete(company); else expandedCompanies.add(company);
    render();
  }));
  document.querySelector<HTMLButtonElement>("#open-settings")?.addEventListener("click", () => {
    settingsOpen = true;
    render();
  });
  document.querySelector<HTMLButtonElement>("#toggle-dnd")?.addEventListener("click", () => {
    settings = { ...settings, doNotDisturb: !settings.doNotDisturb };
    saveSettings(settings);
    notice = settings.doNotDisturb ? "Nicht stören ist aktiv." : "Nicht stören ist aus.";
    render();
  });
  document.querySelector<HTMLButtonElement>("#toggle-mini")?.addEventListener("click", () => void toggleMiniMode());
  document.querySelector<HTMLButtonElement>("#park-call")?.addEventListener("click", () => void parkCall());
  document.querySelector<HTMLButtonElement>("#pickup-call")?.addEventListener("click", pickupCall);
  document.querySelectorAll<HTMLButtonElement>("[data-speed-dial]").forEach((button) => button.addEventListener("click", () => {
    setActiveNumber(button.dataset.speedDial || "");
    void dial();
  }));
  document.querySelector<HTMLButtonElement>("#close-settings")?.addEventListener("click", () => {
    void requestSettingsClose();
  });
  document.querySelector<HTMLDivElement>(".settings-modal-backdrop:not(.phone-picker-backdrop):not(.contact-editor-backdrop):not(.history-assignment-backdrop)")?.addEventListener("click", (event) => {
    if (event.target === event.currentTarget) {
      void requestSettingsClose();
    }
  });
  document.querySelector<HTMLButtonElement>("#overlay-accept")?.addEventListener("click", () => void dial());
  document.querySelector<HTMLButtonElement>("#overlay-reject")?.addEventListener("click", () => void hangup());
  document.querySelector<HTMLButtonElement>("#create-incoming-contact")?.addEventListener("click", () => {
    const number = state.activeNumber || state.remoteIdentity || "";
    editingContactId = `local-${crypto.randomUUID()}`;
    editingContactDraft = { id: editingContactId, displayName: "", phones: [{ label: "work", raw: number, normalized: normalizePhoneNumber(number), primary: true }], source: "local" };
    render();
  });

  document.querySelector<HTMLInputElement>("#search")?.addEventListener("input", (event) => {
    const input = event.target as HTMLInputElement;
    query = input.value;
    renderAndRestoreInput("#search", input.selectionStart, input.selectionEnd);
  });
  document.querySelector<HTMLInputElement>("#history-search")?.addEventListener("input", (event) => {
    const input = event.currentTarget as HTMLInputElement;
    historyQuery = input.value;
    renderAndRestoreInput("#history-search", input.selectionStart, input.selectionEnd);
  });
  document.querySelectorAll<HTMLButtonElement>("[data-history-filter]").forEach((button) => button.addEventListener("click", () => {
    historyFilter = button.dataset.historyFilter as typeof historyFilter;
    render();
  }));

  document.querySelector<HTMLInputElement>("#number-input")?.addEventListener("input", (event) => {
    const input = event.target as HTMLInputElement;
    state = { ...state, activeNumber: input.value, activeContact: undefined };
    renderAndRestoreInput("#number-input", input.selectionStart, input.selectionEnd);
  });

  document.querySelectorAll<HTMLButtonElement>("[data-digit]").forEach((button) => {
    button.addEventListener("click", () => appendDigit(button.dataset.digit || ""));
  });

  document.querySelectorAll<HTMLButtonElement>("[data-number]").forEach((button) => {
    button.addEventListener("click", () => {
      const contact = contacts.find((candidate) => candidate.id === button.dataset.contact);
      if (contact && button.classList.contains("contact-select")) selectContactNumber(contact);
      else setActiveNumber(button.dataset.number || "", contact);
    });
  });

  document.querySelector<HTMLButtonElement>("#close-phone-picker")?.addEventListener("click", () => { phonePicker = null; render(); });
  document.querySelectorAll<HTMLButtonElement>("[data-picked-phone]").forEach((button) => button.addEventListener("click", () => {
    const picker = phonePicker;
    const contact = contacts.find((candidate) => candidate.id === picker?.contactId);
    if (!picker || !contact) return;
    phonePicker = null;
    setActiveNumber(button.dataset.pickedPhone || "", contact);
    if (picker.callImmediately) void dial();
  }));

  document.querySelectorAll<HTMLButtonElement>("[data-favorite]").forEach((button) => {
    button.addEventListener("click", () => toggleFavorite(button.dataset.favorite || ""));
  });

  document.querySelector<HTMLButtonElement>("#dial")?.addEventListener("click", () => void dial());
  document.querySelector<HTMLButtonElement>("#hangup")?.addEventListener("click", () => void hangup());
  document.querySelector<HTMLButtonElement>("#register-sip")?.addEventListener("click", () => void registerSip());
  document.querySelector<HTMLButtonElement>("#hold")?.addEventListener("click", () => void holdCall());
  document.querySelector<HTMLButtonElement>("#mute")?.addEventListener("click", () => void toggleMute());
  document.querySelector<HTMLButtonElement>("#transfer")?.addEventListener("click", () => { callAction = "transfer"; callActionQuery = ""; render(); });
  document.querySelector<HTMLButtonElement>("#second-call")?.addEventListener("click", () => { callAction = "second"; callActionQuery = ""; render(); });
  document.querySelector<HTMLButtonElement>("#switch-call")?.addEventListener("click", () => void switchCall());
  document.querySelector<HTMLButtonElement>("#conference")?.addEventListener("click", () => void startConference());
  document.querySelector<HTMLButtonElement>("#attended-transfer")?.addEventListener("click", () => void attendedTransfer());
  const closeCallAction = () => { callAction = null; callActionQuery = ""; render(); };
  document.querySelector<HTMLButtonElement>("#close-call-action")?.addEventListener("click", closeCallAction);
  document.querySelector<HTMLButtonElement>("#cancel-call-action")?.addEventListener("click", closeCallAction);
  document.querySelector<HTMLInputElement>("#call-action-target")?.addEventListener("input", (event) => {
    const input = event.target as HTMLInputElement;
    callActionQuery = input.value;
    renderAndRestoreInput("#call-action-target", input.selectionStart, input.selectionEnd);
  });
  document.querySelectorAll<HTMLButtonElement>("[data-call-target]").forEach((button) => button.addEventListener("click", () => {
    callActionQuery = button.dataset.callTarget || "";
    render();
  }));
  document.querySelector<HTMLFormElement>("#call-action-form")?.addEventListener("submit", (event) => {
    event.preventDefault();
    const target = String(new FormData(event.currentTarget as HTMLFormElement).get("target") || "").trim();
    const action = callAction;
    callAction = null;
    callActionQuery = "";
    if (action === "transfer") void transferCall(target);
    if (action === "second") void startSecondCall(target);
  });
  document.querySelector<HTMLButtonElement>("#backspace")?.addEventListener("click", deleteDigit);
  document.querySelector<HTMLButtonElement>("#sync-carddav")?.addEventListener("click", () => void syncCardDav());
  document.querySelector<HTMLButtonElement>("#merge-duplicates")?.addEventListener("click", () => void mergeDuplicateContacts());
  document.querySelector<HTMLButtonElement>("#refresh-audio")?.addEventListener("click", () => void refreshAudioDevices(true));
  document.querySelector<HTMLButtonElement>("#test-speaker")?.addEventListener("click", () => void testSpeaker());
  document.querySelector<HTMLButtonElement>("#test-microphone")?.addEventListener("click", () => void testMicrophone());
  document.querySelector<HTMLButtonElement>("#record-microphone")?.addEventListener("click", () => void recordMicrophoneSample());
  document.querySelector<HTMLButtonElement>("#test-ringtone")?.addEventListener("click", playRingtonePulse);
  document.querySelector<HTMLButtonElement>("#clear-history")?.addEventListener("click", () => {
    callHistory = [];
    saveHistory(callHistory);
    render();
  });
  document.querySelectorAll<HTMLButtonElement>("[data-callback-id]").forEach((button) => button.addEventListener("click", () => {
    callHistory = callHistory.map((entry) => entry.id === button.dataset.callbackId ? { ...entry, callbackRequested: !entry.callbackRequested } : entry);
    saveHistory(callHistory);
    render();
  }));
  document.querySelectorAll<HTMLButtonElement>("[data-note-id]").forEach((button) => button.addEventListener("click", () => {
    editingHistoryId = button.dataset.noteId || null;
    render();
  }));
  document.querySelectorAll<HTMLButtonElement>("[data-assign-id]").forEach((button) => button.addEventListener("click", () => {
    assigningHistoryId = button.dataset.assignId || null;
    historyAssignmentQuery = "";
    render();
  }));
  const closeHistoryNote = () => void requestFormClose("#history-note-form", () => { editingHistoryId = null; render(); });
  document.querySelector<HTMLButtonElement>("#close-history-note")?.addEventListener("click", closeHistoryNote);
  document.querySelector<HTMLButtonElement>("#cancel-history-note")?.addEventListener("click", closeHistoryNote);
  document.querySelector<HTMLFormElement>("#history-note-form")?.addEventListener("submit", (event) => {
    event.preventDefault();
    const note = String(new FormData(event.currentTarget as HTMLFormElement).get("note") || "").trim();
    const callbackDueAt = String(new FormData(event.currentTarget as HTMLFormElement).get("callbackDueAt") || "");
    callHistory = callHistory.map((entry) => entry.id === editingHistoryId ? { ...entry, note: note || undefined, callbackDueAt: callbackDueAt || undefined, callbackRequested: callbackDueAt ? true : entry.callbackRequested } : entry);
    saveHistory(callHistory);
    editingHistoryId = null;
    notice = "Gesprächsnotiz gespeichert.";
    render();
  });
  const closeHistoryAssignment = () => { assigningHistoryId = null; historyAssignmentQuery = ""; render(); };
  document.querySelector<HTMLButtonElement>("#close-history-assignment")?.addEventListener("click", closeHistoryAssignment);
  document.querySelector<HTMLDivElement>(".history-assignment-backdrop")?.addEventListener("click", (event) => {
    if (event.target === event.currentTarget) closeHistoryAssignment();
  });
  document.querySelector<HTMLInputElement>("#history-assignment-search")?.addEventListener("input", (event) => {
    const input = event.currentTarget as HTMLInputElement;
    historyAssignmentQuery = input.value;
    renderAndRestoreInput("#history-assignment-search", input.selectionStart, input.selectionEnd);
  });
  document.querySelectorAll<HTMLButtonElement>("[data-assign-contact]").forEach((button) => button.addEventListener("click", () => void assignHistoryNumberToContact(button.dataset.assignContact || "")));
  document.querySelector<HTMLInputElement>("#vcard-import")?.addEventListener("change", (event) => {
    const file = (event.target as HTMLInputElement).files?.[0];
    if (file) void importVCards(file);
  });
  document.querySelector<HTMLFormElement>("#settings-form")?.addEventListener("submit", (event) => {
    event.preventDefault();
    void (async () => {
    const formElement = event.currentTarget as HTMLFormElement;
    const form = new FormData(formElement);
    settings = {
      cardDavUrl: String(form.get("cardDavUrl") || defaultSettings.cardDavUrl),
      cardDavUser: String(form.get("cardDavUser") || defaultSettings.cardDavUser),
      sipServer: String(form.get("sipServer") || defaultSettings.sipServer),
      sipExtension: String(form.get("sipExtension") || defaultSettings.sipExtension),
      sipAuthUser: String(form.get("sipAuthUser") || form.get("sipExtension") || defaultSettings.sipAuthUser),
      sipDisplayName: String(form.get("sipDisplayName") || defaultSettings.sipDisplayName),
      sipWebSocketUrl: String(form.get("sipWebSocketUrl") || defaultSettings.sipWebSocketUrl),
      allowedTestNumbers: String(form.get("allowedTestNumbers") || defaultSettings.allowedTestNumbers),
      safeCallMode: form.get("safeCallMode") === "on",
      useTelLinks: form.get("useTelLinks") === "on",
      enableWebRtcSip: form.get("enableWebRtcSip") === "on",
      selectedMicrophoneId: settings.selectedMicrophoneId,
      selectedSpeakerId: settings.selectedSpeakerId,
      launchAtStartup: form.get("launchAtStartup") === "on",
      doNotDisturb: settings.doNotDisturb,
      closeToTray: form.get("closeToTray") === "on",
      compactMode: form.get("compactMode") === "on",
      speakerVolume: settings.speakerVolume,
      microphoneVolume: settings.microphoneVolume,
      ringtone: settings.ringtone
      ,parkExtension: String(form.get("parkExtension") || defaultSettings.parkExtension)
      ,pickupCode: String(form.get("pickupCode") || defaultSettings.pickupCode)
      ,speedDialNumbers: String(form.get("speedDialNumbers") || "")
      ,searchShortcut: String(form.get("searchShortcut") || defaultSettings.searchShortcut)
      ,dialShortcut: String(form.get("dialShortcut") || defaultSettings.dialShortcut)
      ,muteShortcut: String(form.get("muteShortcut") || defaultSettings.muteShortcut)
    };
    cardDavPassword = String(form.get("cardDavPassword") || "");
    sipPassword = String(form.get("sipPassword") || "");
    saveSettings(settings);
    try {
      if (isTauriRuntime()) {
        const api = await import("@tauri-apps/api/core");
        await api.invoke("set_autostart", { enabled: settings.launchAtStartup });
        await api.invoke("set_close_to_tray", { enabled: settings.closeToTray });
      }
      await saveEnteredSecrets();
      await updateCredentialState();
      configureTelephony();
      scheduleDesktopMaintenance();
      notice = "Einstellungen gespeichert.";
    } catch (error) {
      await updateCredentialState();
      configureTelephony();
      scheduleDesktopMaintenance();
      notice = `Einstellungen gespeichert, aber Passwort-Speicherung fehlgeschlagen: ${errorMessage(error, "Unbekannter Fehler")}. Das eingegebene Passwort bleibt fuer diese Sitzung nutzbar.`;
    }
    if (closeSettingsAfterSave) {
      closeSettingsAfterSave = false;
      settingsOpen = false;
    }
    render();
    })();
  });
  document.querySelector<HTMLFormElement>("#audio-form")?.addEventListener("submit", (event) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget as HTMLFormElement);
    settings = {
      ...settings,
      selectedMicrophoneId: String(form.get("selectedMicrophoneId") || ""),
      selectedSpeakerId: String(form.get("selectedSpeakerId") || ""),
      speakerVolume: Number(form.get("speakerVolume") || settings.speakerVolume),
      microphoneVolume: Number(form.get("microphoneVolume") || settings.microphoneVolume),
      ringtone: String(form.get("ringtone") || settings.ringtone) as Settings["ringtone"]
    };
    saveSettings(settings);
    if (isTauriRuntime()) {
      void import("@tauri-apps/api/core").then((api) => api.invoke("sip_set_audio_levels", { playback: settings.speakerVolume, microphone: settings.microphoneVolume }));
    }
    configureTelephony();
    notice = "Audio-Einstellungen gespeichert.";
    if (!closeSettingsAfterSave) render();
  });
  document.querySelector<HTMLInputElement>('input[name="speakerVolume"]')?.addEventListener("input", (event) => {
    const value = (event.currentTarget as HTMLInputElement).value;
    const label = document.querySelector<HTMLElement>("#speaker-volume-label");
    if (label) label.textContent = `Lautstärke (${value} %)`;
  });
  document.querySelector<HTMLInputElement>('input[name="microphoneVolume"]')?.addEventListener("input", (event) => {
    const value = (event.currentTarget as HTMLInputElement).value;
    const label = document.querySelector<HTMLElement>("#microphone-volume-label");
    if (label) label.textContent = `Mikrofonpegel (${value} %)`;
  });
  markFormClean(document.querySelector<HTMLFormElement>("#settings-form"));
  markFormClean(document.querySelector<HTMLFormElement>("#audio-form"));
  markFormClean(document.querySelector<HTMLFormElement>("#contact-editor-form"));
  markFormClean(document.querySelector<HTMLFormElement>("#history-note-form"));
}

async function boot(): Promise<void> {
  await restoreAndTrackWindow().catch(() => undefined);
  if (isTauriRuntime()) {
    try {
      const appApi = await import("@tauri-apps/api/app");
      appVersion = await appApi.getVersion();
      const api = await import("@tauri-apps/api/core");
      settings = { ...settings, launchAtStartup: await api.invoke<boolean>("get_autostart") };
      await api.invoke("set_close_to_tray", { enabled: settings.closeToTray });
      saveSettings(settings);
    } catch {
      // Die App bleibt auch nutzbar, wenn Windows den Autostartstatus nicht lesen kann.
    }
  }
  configureTelephony();
  window.addEventListener("keydown", handleKeyboardShortcut);
  render();
  await updateCredentialState();
  await refreshAudioDevices(false);
  scheduleDesktopMaintenance();
  if (callbackReminderTimer !== undefined) window.clearInterval(callbackReminderTimer);
  callbackReminderTimer = window.setInterval(checkDueCallbacks, 60000);
  checkDueCallbacks();
  await startDesktopServices();
  if (isTauriRuntime()) {
    const api = await import("@tauri-apps/api/core");
    await api.invoke("sip_set_audio_levels", { playback: settings.speakerVolume, microphone: settings.microphoneVolume }).catch(() => undefined);
  }
}

void boot();
