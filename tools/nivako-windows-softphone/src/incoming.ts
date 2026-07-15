import "./styles.css";
import { acceptNative, getSipStatusNative, hangupNative } from "./nativeBridge";

const root = document.querySelector<HTMLDivElement>("#incoming-app");
if (!root) throw new Error("Incoming call root missing");
const popupRoot = root;

const params = new URLSearchParams(window.location.search);
const volume = Math.max(0, Math.min(100, Number(params.get("volume") || 75)));
let context: AudioContext | undefined;
let timer: number | undefined;
let closed = false;

const escapeHtml = (value: string): string => value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#039;" })[char] || char);

function stop(): void {
  if (timer !== undefined) window.clearInterval(timer);
  timer = undefined;
  void context?.close();
  context = undefined;
}

function closePopup(): void {
  if (closed) return;
  closed = true;
  stop();
  window.close();
}

function ring(): void {
  if (!context || volume <= 0) return;
  const now = context.currentTime;
  const gain = context.createGain();
  const level = Math.pow(volume / 100, 1.8) * 0.6;
  gain.gain.setValueAtTime(0, now);
  gain.gain.linearRampToValueAtTime(level, now + 0.03);
  gain.gain.setValueAtTime(level, now + 0.65);
  gain.gain.linearRampToValueAtTime(0, now + 0.8);
  gain.connect(context.destination);
  for (const frequency of [440, 520]) {
    const oscillator = context.createOscillator();
    oscillator.frequency.value = frequency;
    oscillator.connect(gain);
    oscillator.start(now);
    oscillator.stop(now + 0.82);
  }
}

function render(name: string, number: string): void {
  popupRoot.innerHTML = `<main class="desktop-call-popup"><div class="desktop-call-symbol">☎</div><div><span>Eingehender Anruf</span><strong>${escapeHtml(name)}</strong><small>${escapeHtml(number)}</small></div><div class="desktop-call-actions"><button class="primary" id="popup-accept">Annehmen</button><button class="danger" id="popup-reject">Ablehnen</button></div></main>`;
  document.querySelector<HTMLButtonElement>("#popup-accept")?.addEventListener("click", async () => {
    try { await acceptNative(); } finally { closePopup(); }
  });
  document.querySelector<HTMLButtonElement>("#popup-reject")?.addEventListener("click", async () => {
    try { await hangupNative(); } finally { closePopup(); }
  });
}

const initialNumber = params.get("number") || "Nummer unterdrueckt";
render(params.get("name") || initialNumber, initialNumber);

try {
  context = new AudioContext();
  void context.resume().then(ring);
  timer = window.setInterval(ring, 2200);
} catch { /* Windows WebView may block audio before activation. */ }

async function refresh(): Promise<void> {
  const snapshot = await getSipStatusNative();
  if (snapshot.call_state.toLowerCase() !== "ringing") {
    closePopup();
    return;
  }
  const number = snapshot.remote_number || initialNumber;
  render(snapshot.remote_name || params.get("name") || number, number);
}

void refresh().catch(() => undefined);
window.setInterval(() => void refresh().catch(() => undefined), 500);
