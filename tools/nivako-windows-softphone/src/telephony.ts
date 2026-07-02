export interface TelephonyAdapter {
  register(): Promise<void>;
  dial(number: string): Promise<void>;
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
      password: this.config.password,
      display_name: this.config.displayName || this.config.extension,
      register: true
    });

    this.ua.on("registered", () => this.onStatus("SIP registriert", true));
    this.ua.on("unregistered", () => this.onStatus("SIP nicht registriert", false));
    this.ua.on("registrationFailed", (event: any) => this.onStatus(`SIP Registrierung fehlgeschlagen: ${event?.cause || "unbekannt"}`, false));
    this.ua.on("newRTCSession", (event: any) => {
      this.session = event.session;
      this.bindSessionEvents(this.session);
    });

    this.ua.start();
    this.onStatus("SIP Registrierung gestartet", false);
  }

  async dial(number: string): Promise<void> {
    if (!this.ua) throw new Error("SIP ist nicht registriert");
    const target = `sip:${number}@${this.config.sipServer}`;
    this.session = this.ua.call(target, {
      mediaConstraints: this.getMediaConstraints(),
      rtcOfferConstraints: { offerToReceiveAudio: true, offerToReceiveVideo: false }
    });
    this.bindSessionEvents(this.session);
  }

  async hangup(): Promise<void> {
    this.session?.terminate();
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
    session.on("progress", () => this.onStatus("Anruf klingelt", true));
    session.on("accepted", () => this.onStatus("Anruf aktiv", true));
    session.on("ended", () => this.onStatus("Anruf beendet", true));
    session.on("failed", (event: any) => this.onStatus(`Anruf fehlgeschlagen: ${event?.cause || "unbekannt"}`, true));
  }
}
