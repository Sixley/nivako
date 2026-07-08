import "./styles.css";
import { loadAudioDevices, type AudioDeviceState } from "./audioDevices";
import { parseManyVCards } from "./carddav";
import { syncCardDavContacts } from "./contactsRepository";
import { getLastCardDavDiagnostic, getSipStatusNative, hasSecretNative, isTauriRuntime, loadSecretNative, saveSecretNative } from "./nativeBridge";
import { canUseNativeTelephony, NativeTelephonyAdapter } from "./nativeTelephony";
import { searchContacts } from "./search";
import { loadContacts, loadFavoriteIds, loadHistory, loadSettings, saveContacts, saveFavoriteIds, saveHistory, saveSettings } from "./storage";
import { SafeTelephonyAdapter, WebRtcSipAdapter, type TelephonyAdapter } from "./telephony";
import type { CallEntry, Contact, NativeSipSnapshot, Settings, SoftphoneState } from "./types";

const app = document.querySelector<HTMLDivElement>("#app");
if (!app) throw new Error("App root missing");
const root = app;
const appVersion = "0.2.10";
const buildLabel = "0.2.10 Native Start Tolerant";
const cardDavRefreshMs = 15 * 60 * 1000;
const sipReconnectMs = 60 * 1000;
const sipStatusPollMs = 2000;

type View = "contacts" | "history" | "favorites" | "audio" | "settings";

const defaultSettings: Settings = {
  cardDavUrl: "https://threesix.de/remote.php/dav/addressbooks/users/Nivako/nivako-crm/",
  cardDavUser: "Nivako",
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
  selectedSpeakerId: ""
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
let activeView: View = "contacts";
let lastCardDavSync = "";
let lastSipRegister = "";
let cardDavTimer: number | undefined;
let sipReconnectTimer: number | undefined;
let sipStatusTimer: number | undefined;
let notice = isTauriRuntime()
  ? `Desktop-Modus bereit. Build ${buildLabel}.`
  : "Bereit. CardDAV kann synchronisiert werden; echte Anrufe bleiben blockiert, solange der Anrufschutz aktiv ist.";
let sipNotice = "SIP nicht registriert.";
let syncState: "idle" | "syncing" | "ok" | "error" = "idle";
let state: SoftphoneState = {
  registered: false,
  activeNumber: "",
  callState: "idle"
};

type Tone = "ok" | "warn" | "error" | "neutral";

function statusTone(): Tone {
  if (syncState === "error") return "error";
  if (state.registered) return "ok";
  if (sipNotice.toLowerCase().includes("fehlgeschlagen") || sipNotice.toLowerCase().includes("unauthorized")) return "warn";
  return "neutral";
}

function primaryStatusText(): string {
  if (state.registered) return `Nebenstelle ${settings.sipExtension} ist registriert.`;
  if (sipNotice.toLowerCase().includes("unauthorized")) {
    return "SIP-Anmeldung abgelehnt. Bitte Benutzer, Auth-ID und Passwort pruefen.";
  }
  if (syncState === "error") return "CardDAV braucht Aufmerksamkeit.";
  if (hasStoredSipPassword) return "SIP wird automatisch erneut verbunden.";
  return "SIP-Zugangsdaten fehlen noch.";
}

function serviceLine(): string {
  const cardDav = syncState === "ok"
    ? `CardDAV aktuell${lastCardDavSync ? ` um ${lastCardDavSync}` : ""}`
    : contacts.length
      ? `${contacts.length} Kontakte lokal verfuegbar`
      : "Noch keine Kontakte geladen";
  const sip = state.registered
    ? "Telefonie bereit"
    : hasStoredSipPassword
      ? "SIP wartet auf erfolgreiche Registrierung"
      : "SIP noch nicht eingerichtet";
  return `${cardDav} · ${sip}`;
}

function renderDiagnostics(): string {
  const lines = [
    `Letzte Meldung: ${notice}`,
    `Telefonie: ${settings.enableWebRtcSip ? "WebRTC/WSS-Fallback" : canUseNativeTelephony() ? "Native SIP/liblinphone" : "Browser-Modus"}`,
    `SIP-Status: ${sipNotice}`,
    `CardDAV: ${settings.cardDavUser || "kein Benutzer"} · ${settings.cardDavUrl || "keine URL"}`,
    `Autopilot: CardDAV alle 15 Minuten${lastCardDavSync ? `, zuletzt ${lastCardDavSync}` : ""} · SIP-Reconnect alle 60 Sekunden${lastSipRegister ? `, zuletzt ${lastSipRegister}` : ""}`,
    `Build: ${buildLabel}`
  ];

  return `
    <details class="diagnostics">
      <summary>Diagnose anzeigen</summary>
      <div>${lines.map((line) => `<p>${escapeHtml(line)}</p>`).join("")}</div>
    </details>
  `;
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

function applyTelephonyStatus(status: string, registered?: boolean): void {
  sipNotice = status;
  state = { ...state, registered: registered ?? state.registered };
  if (status.startsWith("Anruf klingelt")) state = { ...state, callState: "ringing" };
  if (status.startsWith("Anruf aktiv") || status.startsWith("Anruf verbunden")) state = { ...state, callState: "active" };
  if (status.startsWith("Nativer Anruf gestartet")) state = { ...state, callState: "dialing" };
  if (status.startsWith("Anruf beendet") || status.startsWith("Anruf fehlgeschlagen")) {
    state = { ...state, callState: "idle", muted: false };
  }
  notice = status;
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
  const nextState = {
    ...state,
    registered: snapshot.registered,
    callState: normalizeCallState(snapshot.call_state),
    muted: snapshot.muted
  };
  if (nextState.callState === "idle") {
    nextState.muted = false;
  }
  const nextNotice = `${snapshot.provider}: ${snapshot.message}`;
  const changed = sipNotice !== nextNotice
    || state.registered !== nextState.registered
    || state.callState !== nextState.callState
    || Boolean(state.muted) !== Boolean(nextState.muted);

  if (!changed) return;

  sipNotice = nextNotice;
  state = nextState;
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

function nowLabel(): string {
  return new Intl.DateTimeFormat("de-DE", { hour: "2-digit", minute: "2-digit" }).format(new Date());
}

function applyFavorites(nextContacts: Contact[], favoriteIds: string[]): Contact[] {
  const favoriteSet = new Set(favoriteIds);
  return nextContacts
    .filter((contact) => !contact.id.startsWith("demo-"))
    .map((contact) => ({ ...contact, favorite: contact.favorite || favoriteSet.has(contact.id) }));
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
    if (isTauriRuntime() && !sipPassword && hasStoredSipPassword) {
      sipPassword = await loadSecretNative("NIVAKO Softphone SIP", settings.sipExtension) || "";
    }
    configureTelephony();
    await telephony.register();
    lastSipRegister = nowLabel();
  } catch (error) {
    state = { ...state, registered: false };
    sipNotice = errorMessage(error, "SIP Registrierung fehlgeschlagen");
    notice = sipNotice;
    render();
  }
}

function setActiveNumber(number: string, contact?: Contact): void {
  state = { ...state, activeNumber: number, activeContact: contact };
  notice = contact ? `${contact.displayName} ist ausgewaehlt.` : "Nummer ist ausgewaehlt.";
  render();
}

function addHistory(direction: CallEntry["direction"], number: string, name = number, result: CallEntry["result"] = "started"): void {
  callHistory = [
    {
      id: crypto.randomUUID(),
      direction,
      name,
      number,
      time: new Intl.DateTimeFormat("de-DE", { dateStyle: "short", timeStyle: "short" }).format(new Date()),
      result
    },
    ...callHistory
  ].slice(0, 100);
  saveHistory(callHistory);
}

async function dial(): Promise<void> {
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
  try {
    await telephony.dial(state.activeNumber);
    addHistory("outbound", state.activeNumber, state.activeContact?.displayName || state.activeNumber, "started");
    if (canUseNativeTelephony() && !settings.enableWebRtcSip) {
      notice = sipNotice || "Nativer SIP-Anruf gestartet.";
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
  await telephony.hangup();
  state = { ...state, callState: "idle", activeNumber: "", activeContact: undefined };
  notice = "Anruf beendet.";
  render();
}

async function holdCall(): Promise<void> {
  await telephony.hold();
  state = { ...state, callState: state.callState === "held" ? "active" : "held" };
  notice = state.callState === "held" ? "Anruf gehalten." : "Anruf fortgesetzt.";
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

function appendDigit(digit: string): void {
  state = { ...state, activeNumber: `${state.activeNumber}${digit}` };
  if (state.callState !== "idle") void telephony.sendDtmf(digit);
  render();
}

function deleteDigit(): void {
  state = { ...state, activeNumber: state.activeNumber.slice(0, -1) };
  render();
}

function toggleFavorite(contactId: string): void {
  contacts = contacts.map((contact) => contact.id === contactId ? { ...contact, favorite: !contact.favorite } : contact);
  persistContacts();
  render();
}

async function syncCardDav(): Promise<void> {
  syncState = "syncing";
  notice = "Synchronisiere CardDAV-Kontakte...";
  render();

  try {
    const synced = await syncCardDavContacts(settings, cardDavPassword);
    const favoriteIds = loadFavoriteIds();
    const contactsWithPhones = synced.filter((contact) => contact.phones.length > 0);
    contacts = applyFavorites(contactsWithPhones, favoriteIds);
    persistContacts();
    syncState = "ok";
    lastCardDavSync = nowLabel();
    const nativeDiagnostic = isTauriRuntime() ? ` ${getLastCardDavDiagnostic()}` : "";
    notice = `CardDAV OK: ${synced.length} Kontakte gelesen, ${contactsWithPhones.length} mit Telefonnummer.${nativeDiagnostic}`;
  } catch (error) {
    syncState = "error";
    notice = `CardDAV-Sync fehlgeschlagen: ${errorMessage(error, "Unbekannter Fehler")}`;
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
  const tasks: string[] = [];

  if (hasStoredCardDavPassword) {
    tasks.push("CardDAV");
    await syncCardDav();
  }

  if (hasStoredSipPassword && !state.registered) {
    tasks.push("SIP");
    await registerSip();
  }

  if (tasks.length === 0) {
    notice = "Desktop-Modus bereit. Hinterlegte CardDAV-/SIP-Zugangsdaten fehlen noch.";
    render();
  }
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
  const primaryPhone = contact.phones[0];
  const initials = contact.displayName.split(" ").map((part) => part[0]).join("").slice(0, 2).toUpperCase();
  const details = [contact.organization, contact.email].filter(Boolean).join(" · ") || contact.source || "Kontakt";
  const extraCount = Math.max(0, contact.phones.length - 1);

  return `
    <div class="contact-row">
      <div class="contact-body">
        <button class="contact-select" data-number="${escapeHtml(primaryPhone?.normalized || "")}" data-contact="${escapeHtml(contact.id)}">
          <span class="avatar">${escapeHtml(initials || "?")}</span>
          <span class="contact-main">
            <strong>${escapeHtml(contact.displayName)}</strong>
            <small>${escapeHtml(details)}</small>
          </span>
          <span class="contact-number">
            <span>${escapeHtml(primaryPhone?.raw || "Keine Nummer")}</span>
            ${extraCount ? `<small>+${extraCount}</small>` : ""}
          </span>
        </button>
        ${contact.phones.length > 1 ? `<div class="phone-chips">${contact.phones.slice(1).map((phone) => `<button class="phone-chip" data-number="${escapeHtml(phone.normalized)}" data-contact="${escapeHtml(contact.id)}">${escapeHtml(phone.label)} ${escapeHtml(phone.raw)}</button>`).join("")}</div>` : ""}
      </div>
      <button class="favorite-button ${contact.favorite ? "active" : ""}" title="Favorit umschalten" data-favorite="${escapeHtml(contact.id)}">${contact.favorite ? "★" : "☆"}</button>
    </div>
  `;
}

function renderHistoryList(emptyText: string): string {
  if (callHistory.length === 0) return `<div class="empty large">${emptyText}</div>`;
  return `
    <div class="contact-list">
      ${callHistory.map((entry) => `
        <button class="history-row" data-number="${escapeHtml(entry.number)}">
          <span>${entry.direction === "missed" ? "!" : entry.direction === "inbound" ? "↓" : "↑"}</span>
          <strong>${escapeHtml(entry.name)}</strong>
          <small>${escapeHtml(entry.result || "")} · ${escapeHtml(entry.time)}</small>
        </button>
      `).join("")}
    </div>
  `;
}

function renderMainPanel(visibleContacts: Contact[]): string {
  if (activeView === "history") {
    return `
      <section class="contacts-panel">
        <div class="panel-header">
          <div>
            <h1>Verlauf</h1>
            <p>Lokaler Verlauf dieser App, keine erfundene PBX-Historie</p>
          </div>
          <button class="sync-button" id="clear-history">Leeren</button>
        </div>
        ${renderHistoryList("Noch kein lokaler Verlauf vorhanden.")}
      </section>
    `;
  }

  if (activeView === "favorites") {
    const favorites = visibleContacts.filter((contact) => contact.favorite);
    return `
      <section class="contacts-panel">
        <div class="panel-header">
          <div>
            <h1>Favoriten</h1>
            <p>${favorites.length} lokale Favoriten</p>
          </div>
        </div>
        <input class="search" id="search" placeholder="Favoriten suchen" value="${escapeHtml(query)}" />
        <div class="contact-list">
          ${favorites.map(renderContact).join("") || '<div class="empty large">Noch keine Favoriten markiert.</div>'}
        </div>
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
          <button class="primary" type="submit">Audio speichern</button>
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
          <p>${contacts.length} lokale Kontakte ${syncState === "ok" ? "· CardDAV synchronisiert" : ""}</p>
        </div>
        <div class="panel-actions">
          <label class="file-button">vCard importieren<input id="vcard-import" type="file" accept=".vcf,text/vcard,text/x-vcard" /></label>
          <button class="sync-button" id="sync-carddav" ${syncState === "syncing" ? "disabled" : ""}>${syncState === "syncing" ? "Sync laeuft..." : "CardDAV sync"}</button>
        </div>
      </div>
      <input class="search" id="search" placeholder="Name, Firma oder Nummer suchen" value="${escapeHtml(query)}" />
      <div class="contact-list">
        ${visibleContacts.map(renderContact).join("") || '<div class="empty large">Keine Treffer</div>'}
      </div>
    </section>
  `;
}

function navButton(view: View, label: string): string {
  return `<button data-view="${view}" class="${activeView === view ? "active" : ""}">${label}</button>`;
}

function healthPill(label: string, value: string, stateClass = ""): string {
  return `
    <div class="health-pill ${stateClass}">
      <span>${escapeHtml(label)}</span>
      <strong>${escapeHtml(value)}</strong>
    </div>
  `;
}

function telephonyStatusText(): string {
  if (state.registered) return "SIP registriert";
  if (settings.safeCallMode) return "Anrufschutz aktiv";
  if (settings.enableWebRtcSip) return "SIP-WebRTC bereit";
  if (canUseNativeTelephony()) return "Desktop-SIP bereit";
  if (settings.useTelLinks) return "tel:-Uebergabe aktiv";
  return "SIP-Core fehlt";
}

function render(): void {
  const visibleContacts = searchContacts(contacts, query);
  const keypad = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "*", "0", "#"];
  const tone = statusTone();

  root.innerHTML = `
    <section class="shell">
      <aside class="sidebar">
        <div class="brand">
          <span class="brand-mark">N</span>
          <div>
            <strong>NIVAKO Softphone</strong>
            <small>v${appVersion} · ${state.registered ? `${escapeHtml(settings.sipExtension)} registriert` : "SIP nicht registriert"}</small>
          </div>
        </div>
        <nav class="nav">
          ${navButton("contacts", "Kontakte")}
          ${navButton("history", "Verlauf")}
          ${navButton("favorites", "Favoriten")}
          ${navButton("audio", "Audio")}
          ${navButton("settings", "Einstellungen")}
        </nav>
        <div class="health-strip">
          ${healthPill("SIP", state.registered ? "online" : "offline", state.registered ? "ok" : "warn")}
          ${healthPill("CardDAV", syncState === "ok" ? `ok ${lastCardDavSync}` : syncState === "syncing" ? "sync" : contacts.length ? `${contacts.length} lokal` : "leer", syncState === "error" ? "error" : syncState === "ok" ? "ok" : "")}
          ${healthPill("Audio", audioDevices.permission === "denied" ? "gesperrt" : audioDevices.inputs.length ? `${audioDevices.inputs.length} Mic` : "Standard", audioDevices.permission === "denied" ? "error" : "")}
        </div>
      </aside>

      ${renderMainPanel(visibleContacts)}

      <section class="phone-panel">
        <div class="notice ${tone}">
          <strong>${escapeHtml(primaryStatusText())}</strong>
          <span>${escapeHtml(serviceLine())}</span>
        </div>
        <div class="call-card">
          <div class="status-line">
            <span class="status-dot ${state.registered ? "" : "offline"}"></span>
            <span>${telephonyStatusText()}</span>
          </div>
          <div class="callee">
            <strong>${escapeHtml(state.activeContact?.displayName || state.activeNumber || "Nummer waehlen")}</strong>
            <small>${escapeHtml(state.activeContact?.organization || state.activeNumber || settings.sipServer)}</small>
          </div>
          <input class="number-input" id="number-input" value="${escapeHtml(state.activeNumber)}" placeholder="+49..." />
          <div class="keypad">
            ${keypad.map((digit) => `<button data-digit="${digit}">${digit}</button>`).join("")}
          </div>
          <div class="call-actions">
            <button class="secondary" id="register-sip" ${settings.enableWebRtcSip || canUseNativeTelephony() ? "" : "disabled"}>Registrieren</button>
            <button class="primary" id="dial" ${!state.activeNumber ? "disabled" : ""}>${settings.safeCallMode ? "Lokal erfassen" : "Anrufen"}</button>
            <button class="danger" id="hangup" ${state.callState === "idle" ? "disabled" : ""}>Auflegen</button>
          </div>
          <div class="call-actions compact-actions">
            <button class="secondary" id="backspace" ${!state.activeNumber ? "disabled" : ""}>Rueck</button>
            <button class="secondary" id="hold" ${state.callState === "idle" ? "disabled" : ""}>${state.callState === "held" ? "Weiter" : "Halten"}</button>
            <button class="secondary" id="mute" ${state.callState === "idle" ? "disabled" : ""}>${state.muted ? "Mikro an" : "Stumm"}</button>
          </div>
          ${renderDiagnostics()}
        </div>

        <div class="history">
          <h2>Letzte Aktionen <small>lokal gespeichert</small></h2>
          ${callHistory.slice(0, 5).map((entry) => `
            <button class="history-row" data-number="${escapeHtml(entry.number)}">
              <span>${entry.direction === "missed" ? "!" : entry.direction === "inbound" ? "↓" : "↑"}</span>
              <strong>${escapeHtml(entry.name)}</strong>
              <small>${escapeHtml(entry.result || "")} · ${escapeHtml(entry.time)}</small>
            </button>
          `).join("") || '<div class="empty">Noch keine Aktionen</div>'}
        </div>
      </section>
    </section>
  `;

  bindEvents();
}

function bindEvents(): void {
  document.querySelectorAll<HTMLButtonElement>("[data-view]").forEach((button) => {
    button.addEventListener("click", () => {
      activeView = button.dataset.view as View;
      render();
    });
  });

  document.querySelector<HTMLInputElement>("#search")?.addEventListener("input", (event) => {
    query = (event.target as HTMLInputElement).value;
    render();
  });

  document.querySelector<HTMLInputElement>("#number-input")?.addEventListener("input", (event) => {
    state = { ...state, activeNumber: (event.target as HTMLInputElement).value };
  });

  document.querySelectorAll<HTMLButtonElement>("[data-digit]").forEach((button) => {
    button.addEventListener("click", () => appendDigit(button.dataset.digit || ""));
  });

  document.querySelectorAll<HTMLButtonElement>("[data-number]").forEach((button) => {
    button.addEventListener("click", () => {
      const contact = contacts.find((candidate) => candidate.id === button.dataset.contact);
      setActiveNumber(button.dataset.number || "", contact);
    });
  });

  document.querySelectorAll<HTMLButtonElement>("[data-favorite]").forEach((button) => {
    button.addEventListener("click", () => toggleFavorite(button.dataset.favorite || ""));
  });

  document.querySelector<HTMLButtonElement>("#dial")?.addEventListener("click", () => void dial());
  document.querySelector<HTMLButtonElement>("#hangup")?.addEventListener("click", () => void hangup());
  document.querySelector<HTMLButtonElement>("#register-sip")?.addEventListener("click", () => void registerSip());
  document.querySelector<HTMLButtonElement>("#hold")?.addEventListener("click", () => void holdCall());
  document.querySelector<HTMLButtonElement>("#mute")?.addEventListener("click", () => void toggleMute());
  document.querySelector<HTMLButtonElement>("#backspace")?.addEventListener("click", deleteDigit);
  document.querySelector<HTMLButtonElement>("#sync-carddav")?.addEventListener("click", () => void syncCardDav());
  document.querySelector<HTMLButtonElement>("#refresh-audio")?.addEventListener("click", () => void refreshAudioDevices(true));
  document.querySelector<HTMLButtonElement>("#clear-history")?.addEventListener("click", () => {
    callHistory = [];
    saveHistory(callHistory);
    render();
  });
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
      selectedSpeakerId: settings.selectedSpeakerId
    };
    cardDavPassword = String(form.get("cardDavPassword") || "");
    sipPassword = String(form.get("sipPassword") || "");
    saveSettings(settings);
    try {
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
    render();
    })();
  });
  document.querySelector<HTMLFormElement>("#audio-form")?.addEventListener("submit", (event) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget as HTMLFormElement);
    settings = {
      ...settings,
      selectedMicrophoneId: String(form.get("selectedMicrophoneId") || ""),
      selectedSpeakerId: String(form.get("selectedSpeakerId") || "")
    };
    saveSettings(settings);
    configureTelephony();
    notice = "Audio-Einstellungen gespeichert.";
    render();
  });
}

async function boot(): Promise<void> {
  configureTelephony();
  render();
  await updateCredentialState();
  await refreshAudioDevices(false);
  scheduleDesktopMaintenance();
  await startDesktopServices();
}

void boot();
