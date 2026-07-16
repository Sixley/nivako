export type PhoneLabel = "work" | "mobile" | "home" | "other";

export interface ContactPhone {
  label: PhoneLabel;
  raw: string;
  normalized: string;
}

export interface Contact {
  id: string;
  displayName: string;
  organization?: string;
  email?: string;
  phones: ContactPhone[];
  favorite?: boolean;
  source?: "carddav" | "local";
}

export interface CallEntry {
  id: string;
  direction: "inbound" | "outbound" | "missed";
  name: string;
  number: string;
  time: string;
  result?: "blocked" | "started" | "failed" | "completed";
}

export interface SoftphoneState {
  registered: boolean;
  activeNumber: string;
  activeContact?: Contact;
  callState: "idle" | "ringing" | "dialing" | "active" | "held";
  muted?: boolean;
  remoteIdentity?: string;
}

export interface Settings {
  cardDavUrl: string;
  cardDavUser: string;
  sipServer: string;
  sipExtension: string;
  sipAuthUser: string;
  sipWebSocketUrl: string;
  sipDisplayName: string;
  allowedTestNumbers: string;
  safeCallMode: boolean;
  useTelLinks: boolean;
  enableWebRtcSip: boolean;
  selectedMicrophoneId: string;
  selectedSpeakerId: string;
}

export interface NativeSipStatus {
  registered: boolean;
  message: string;
}

export interface NativeSipSnapshot {
  registered: boolean;
  call_state: SoftphoneState["callState"] | string;
  provider: string;
  message: string;
  held: boolean;
  muted: boolean;
  remote_number: string;
  remote_display_name: string;
}
