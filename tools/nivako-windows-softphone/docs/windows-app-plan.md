# Windows-App-Plan

## Ziel

Eine echte NIVAKO Windows-Softphone-App, nicht nur ein Web-Prototyp.

## Stack

- Tauri 2 als Windows-App-Schale
- TypeScript/Vite fuer UI
- Rust fuer lokale Commands und OS-Integration
- Windows Credential Manager fuer Passwoerter
- SQLite fuer Kontakte, Verlauf, Favoriten und Einstellungen
- liblinphone SDK fuer SIP/Audio

## Umsetzungsstand

- UI/CardDAV/Audio/Testmodus laufen im Browser-Prototyp
- Tauri-Projektstruktur ist angelegt
- native Commands fuer CardDAV und Credential-Store sind angelegt
- Build-/Cache-Pfad liegt auf `/mnt/buildspace`, damit Tauri/liblinphone-Artefakte nicht die Root-Disk fuellen
- liblinphone 5.1.65 ist auf dem Linux-Buildhost installiert
- native SIP-Commands sind gegen liblinphone angebunden:
  - `sip_register`
  - `sip_dial`
  - `sip_hangup`
  - `sip_hold`
  - `sip_mute`
  - `sip_dtmf`
- `cargo check`, `cargo build`, `npm test`, `npm run build`, `npm run tauri -- info` und `npm run tauri:build` laufen erfolgreich
- Linux-Release-Binary liegt unter `/mnt/buildspace/project-targets/nivako-windows-softphone/release/nivako-softphone`

## Was fuer echte Telefonie noch fehlt

1. Windows-Buildumgebung mit Rust, WebView2 und Tauri-Voraussetzungen.
2. liblinphone SDK fuer Windows einbinden.
3. Eingehende Anrufe und Call-State-Callbacks sauber in die UI spiegeln.
4. Audio-Geraeteauswahl nativ mit liblinphone verdrahten.
5. Test nur gegen interne Ziele wie `101` oder `*43`, keine Kundennummern.
6. Installer mit Autostart/Tray/tel:-Handler.

## Warum nicht Browser-WebRTC

WebRTC braucht einen erreichbaren SIP-WSS-Endpunkt auf der PBX. Der passive Test auf `pbx.nivako.de:8089/ws` lieferte keinen Handshake. Selbst wenn das freigeschaltet wird, bleiben Browser-Rechte, Zertifikate und Audio-Verhalten unnoetig sperrig fuer eine Windows-Softphone-App.
