export interface AudioDeviceState {
  inputs: MediaDeviceInfo[];
  outputs: MediaDeviceInfo[];
  permission: "unknown" | "granted" | "denied" | "unsupported";
}

export async function loadAudioDevices(requestPermission = false): Promise<AudioDeviceState> {
  if (!navigator.mediaDevices?.enumerateDevices) {
    return { inputs: [], outputs: [], permission: "unsupported" };
  }

  let permission: AudioDeviceState["permission"] = "unknown";
  if (requestPermission) {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      stream.getTracks().forEach((track) => track.stop());
      permission = "granted";
    } catch {
      permission = "denied";
    }
  }

  const devices = await navigator.mediaDevices.enumerateDevices();
  return {
    inputs: devices.filter((device) => device.kind === "audioinput"),
    outputs: devices.filter((device) => device.kind === "audiooutput"),
    permission
  };
}
