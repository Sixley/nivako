import { dialNative, hangupNative, holdNative, isTauriRuntime, muteNative, registerSipNative, sendDtmfNative } from "./nativeBridge";
import type { Settings } from "./types";
import type { TelephonyAdapter } from "./telephony";

export class NativeTelephonyAdapter implements TelephonyAdapter {
  constructor(
    private readonly settings: () => Settings,
    private readonly password: () => string,
    private readonly onStatus: (status: string, registered?: boolean) => void
  ) {}

  async register(): Promise<void> {
    const result = await registerSipNative(this.settings(), this.password());
    this.onStatus(result.message, result.registered);
  }

  async dial(number: string): Promise<void> {
    const result = await dialNative(number, this.settings());
    this.onStatus(result.message, result.registered);
  }

  async hangup(): Promise<void> {
    const result = await hangupNative();
    this.onStatus(result.message, result.registered);
  }

  async hold(): Promise<void> {
    const result = await holdNative();
    this.onStatus(result.message, result.registered);
  }

  async mute(): Promise<void> {
    const result = await muteNative(true);
    this.onStatus(result.message, result.registered);
  }

  async unmute(): Promise<void> {
    const result = await muteNative(false);
    this.onStatus(result.message, result.registered);
  }

  async sendDtmf(digit: string): Promise<void> {
    const result = await sendDtmfNative(digit);
    this.onStatus(result.message, result.registered);
  }
}

export function canUseNativeTelephony(): boolean {
  return isTauriRuntime();
}
