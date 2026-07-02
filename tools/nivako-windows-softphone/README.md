# NIVAKO Windows Softphone

Eigene Windows-Softphone-App mit Groundwire-nahem Bedienfluss, aber eigenem NIVAKO-Design und eigener CardDAV-Integration.

## Zielbild

- SIP-Telefonie über VitalPBX
- CardDAV-Telefonbuch über Nextcloud `nivako-crm`
- lokaler Kontakt-Cache statt LDAP-Live-Suche
- schnelle Suche nach Name, Firma und normalisierter Telefonnummer
- Desktop-taugliche Bedienung mit Tray, Headset-Auswahl und `tel:`-Links

## Aktueller Stand

Dieses Repo enthält eine lauffähige lokale Softphone-Arbeitsoberfläche:

- Tauri-Desktop-App-Struktur für Windows-Installer (`src-tauri/`)
- native Commands für CardDAV-Sync, Credential-Speicherung und SIP-Adapter-Grenze
- CardDAV-Sync über lokalen Dev-Server-Proxy, damit keine Nextcloud-Zugangsdaten im Browser landen
- lokaler Kontakt-Cache mit Suche, Favoriten und vCard-Import
- lokaler Verlauf für Aktionen aus der App
- Einstellungen für CardDAV, SIP-Ziel und sicheren Call-Modus
- Audio-Geräteerkennung im sicheren Browser-Kontext
- SIP/WebRTC-Adapter über `JsSIP`, sofern VitalPBX einen erreichbaren WSS-Endpunkt und passende Nebenstellen-Credentials bereitstellt
- ausgehender Telefoniepfad über sicheren Adapter: standardmäßig blockiert, optional `tel:`-Übergabe an Windows oder WebRTC/SIP

Der echte Desktop-SIP-Core ist bewusst als Adapter vorbereitet, damit `liblinphone` darunter gehängt werden kann, ohne die Oberfläche neu zu bauen. Ohne erreichbaren WSS-Endpunkt oder Windows-SIP-Core werden keine echten Anrufe ausgelöst.

## Entwicklung

```bash
npm install
npm run dev
npm test
npm run build
npm run tauri -- info
npm run tauri:dev
npm run tauri:build
```

Credentials gehören nicht ins Repo. Für CardDAV wird später ein App-Passwort im Windows Credential Manager gespeichert.

Im lokalen OpenClaw-Setup liest `npm run dev` CardDAV-Zugangsdaten serverseitig aus `NIVAKO_CARDDAV_ENV` oder dem bekannten lokalen Secret-Pfad. Der Browser bekommt nur die synchronisierten vCards.

Der Dev-Server liefert parallel:

- `http://65.21.178.102:5179/` fuer reine UI-/CardDAV-Tests
- `https://65.21.178.102:5443/` fuer Audio/WebRTC-Tests mit Self-Signed-Zertifikat

Stand 2026-07-02: CardDAV live geprueft mit 22 Kontakten. Passiver Check auf `https://pbx.nivako.de:8089/ws` lieferte keinen Handshake; echte Browser-Telefonie braucht daher noch PBX-WSS-Freischaltung oder eine Windows-Core-Integration.

Der Tauri/Rust-Teil wurde auf dem Linux-Host mit `cargo check` erfolgreich kompiliert. Ein echter Windows-Installer braucht eine Windows-Buildstrecke mit WebView2 und liblinphone SDK. Auf diesem Linux-Host ist Crossbuild fuer Windows nicht final verifiziert.
