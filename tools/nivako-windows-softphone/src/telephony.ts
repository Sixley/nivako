export interface TelephonyAdapter {
  register(): Promise<void>;
  dial(number: string): Promise<void>;
  accept?(): Promise<void>;
  reject?(): Promise<void>;
  hangup(): Promise<void>;
  hold(): Promise<void>;
  mute?(): Promise<void>;
  unmute?(): Promise<void>;
  sendDtmf(digit: string): Promise<void>;
}

export interface SipRegistrationConfig {
  webSocketUrl: string;
  sipServer: string;
  extension: string;
  authUser: string;
  password: string;
  displayName?: string;
}

export class SafeTelephonyAdapter implements TelephonyAdapter {
  constructor(private readonly openTelLinks: () => boolean = () => false) {}

  async register(): Promise<void> {
    await Promise.resolve();
  }

  async dial(number: string): Promise<void> {
    if (this.openTelLinks()) {
      window.location.href = `tel:${encodeURIComponent(number)}`;
    }
    await Promise.resolve();
  }

  async hangup(): Promise<void> {
    await Promise.resolve();
  }

  async accept(): Promise<void> {
    await Promise.resolve();
  }

  async reject(): Promise<void> {
    await Promise.resolve();
  }

  async hold(): Promise<void> {
    await Promise.resolve();
  }

  async sendDtmf(_digit: string): Promise<void> {
    await Promise.resolve();
  }
}

export class WebRtcSipAdapter implements TelephonyAdapter {
  private ua?: any;
  private session?: any;
  private remoteAudio?: HTMLAudioElement;

  constructor(
    private readonly config: SipRegistrationConfig,
    private readonly onStatus: (status: string, registered?: boolean) => void,
    private readonly getMediaConstraints: () => MediaStreamConstraints = () => ({ audio: true, video: false })
  ) {}

  async register(): Promise<void> {
    if (!this.config.webSocketUrl || !this.config.extension || !this.config.password) {
      throw new Error("SIP WSS, Benutzer oder Passwort fehlt");
    }

    const JsSIP = await import("jssip");
    const socket = new JsSIP.WebSocketInterface(this.config.webSocketUrl);
    this.ua = new JsSIP.UA({
      sockets: [socket],
      uri: `sip:${this.config.extension}@${this.config.sipServer}`,
      authorization_user: this.config.authUser || this.config.extension,
      password: this.config.password,
      display_name: this.config.displayName || this.config.extension,
      register: true
    });

    this.ua.on("registered", () => this.onStatus("SIP registriert", true));
    this.ua.on("unregistered", () => this.onStatus("SIP nicht registriert", false));
    this.ua.on("registrationFailed", (event: any) => this.onStatus(`SIP Registrierung fehlgeschlagen: ${sipEventSummary(event)}`, false));
    this.ua.on("newRTCSession", (event: any) => {
      this.session = event.session;
      this.bindSessionEvents(this.session);
    });

    this.ua.start();
    this.onStatus("SIP Registrierung gestartet", false);
  }

  async dial(number: string): Promise<void> {
    if (!this.ua) throw new Error("SIP ist nicht registriert");
    const target = `sip:${normalizeDialNumber(number)}@${this.config.sipServer}`;
    this.session = this.ua.call(target, {
      mediaConstraints: this.getMediaConstraints(),
      rtcOfferConstraints: { offerToReceiveAudio: true, offerToReceiveVideo: false }
    });
    this.bindSessionEvents(this.session);
  }

  async hangup(): Promise<void> {
    this.session?.terminate();
  }

  async accept(): Promise<void> {
    await this.session?.answer?.({
      mediaConstraints: this.getMediaConstraints(),
      rtcOfferConstraints: { offerToReceiveAudio: true, offerToReceiveVideo: false }
    });
  }

  async hold(): Promise<void> {
    this.session?.hold?.();
  }

  async mute(): Promise<void> {
    this.session?.mute?.({ audio: true });
  }

  async unmute(): Promise<void> {
    this.session?.unmute?.({ audio: true });
  }

  async sendDtmf(digit: string): Promise<void> {
    this.session?.sendDTMF?.(digit);
  }

  private bindSessionEvents(session: any): void {
    this.attachRemoteAudio(session);
    session.on("progress", () => this.onStatus("Anruf klingelt", true));
    session.on("accepted", () => this.onStatus("Anruf aktiv", true));
    session.on("confirmed", () => this.onStatus("Anruf verbunden", true));
    session.on("ended", (event: any) => this.onStatus(`Anruf beendet: ${sipEventSummary(event)}`, true));
    session.on("failed", (event: any) => this.onStatus(`Anruf fehlgeschlagen: ${sipEventSummary(event)}`, true));
  }

  private attachRemoteAudio(session: any): void {
    const connection = session?.connection;
    if (!connection?.addEventListener) return;
    const audio = this.ensureRemoteAudioElement();
    connection.addEventListener("track", (event: RTCTrackEvent) => {
      const stream = event.streams?.[0] || new MediaStream([event.track]);
      audio.srcObject = stream;
      void audio.play().catch(() => this.onStatus("Anruf-Audio wartet auf Windows/WebView-Freigabe", true));
    });
  }

  private ensureRemoteAudioElement(): HTMLAudioElement {
    if (this.remoteAudio) return this.remoteAudio;
    const existing = document.querySelector<HTMLAudioElement>("#nivako-remote-audio");
    if (existing) {
      this.remoteAudio = existing;
      return existing;
    }
    const audio = document.createElement("audio");
    audio.id = "nivako-remote-audio";
    audio.autoplay = true;
    audio.setAttribute("playsinline", "true");
    audio.style.display = "none";
    document.body.append(audio);
    this.remoteAudio = audio;
    return audio;
  }
}

function normalizeDialNumber(number: string): string {
  return number.trim().replace(/[\s().-]/g, "");
}

function sipEventSummary(event: any): string {
  const cause = event?.cause || "unbekannt";
  const message = event?.message || event?.response;
  const code = message?.status_code || message?.statusCode;
  const reason = message?.reason_phrase || message?.reasonPhrase;
  const originator = event?.originator;
  const parts = [cause];
  if (code) parts.push(`${code}${reason ? ` ${reason}` : ""}`);
  if (originator) parts.push(`Originator ${originator}`);
  return parts.join(" · ");
}
