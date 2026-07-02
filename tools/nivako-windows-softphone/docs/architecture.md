# Architektur

## Entscheidung

Primäre Kontaktquelle ist CardDAV, nicht LDAP. Die App synchronisiert das Nextcloud-Adressbuch in einen lokalen Cache und sucht anschließend lokal. Das entspricht eher dem Handy-Workflow: Kontakte sind sichtbar vorhanden, schnell filterbar und nicht von einer schwer beobachtbaren LDAP-Remote-Suche abhängig.

## Schichten

- `TelephonyAdapter`: SIP-Registrierung, Call-Control, Audio-Geräte, DTMF
- `ContactsRepository`: CardDAV-Sync, vCard-Parsing, lokaler Cache
- `SearchIndex`: Name, Firma, E-Mail und normalisierte Nummern
- `Shell`: Windows-Tray, Autostart, `tel:`-Protocol-Handler
- `UI`: Wählfeld, Kontaktliste, Favoriten, Verlauf, Einstellungen

## SIP-Core

Favorit ist `liblinphone`, weil SIP, TLS, SRTP, Audio/Video und NAT bereits reif vorhanden sind. `PJSUA2` bleibt Alternative, falls Packaging oder API-Zugriff unter Windows besser passt.

Die konkrete App-Schale ist Tauri:

- Frontend: vorhandene Vite/TypeScript-Oberflaeche
- Native Commands: Rust in `src-tauri/src/lib.rs`
- Credentials: Windows Credential Manager via `keyring`-Crate
- CardDAV: native Tauri-Command im Desktop, lokaler Proxy nur fuer Browser-Testmodus
- Telefonie: `TelephonyAdapter` im Frontend, nativer liblinphone-Core hinter Tauri-Commands fuer Registrierung, Wahl, Auflegen, Halten/Fortsetzen, Stumm und DTMF

## CardDAV

Die App soll CardDAV selbst sprechen:

- `PROPFIND` für Adressbuch-Metadaten
- `REPORT addressbook-query` für initialen Sync
- `REPORT sync-collection` oder ETag-basierter Delta-Sync
- vCard 3.0/4.0 Parser
- lokale SQLite-Ablage

Keine Delegation an Windows Kontakte. Wir brauchen kontrollierbares Mapping, Logs und saubere Fehlerdiagnose.

Der aktuelle Browser-/Vite-Stand nutzt dafuer einen lokalen Dev-Server-Proxy unter `/api/carddav/contacts`. So funktionieren echte Nextcloud-Syncs im Prototyp bereits, ohne Basic-Auth-Zugangsdaten an den Browser zu geben oder an CORS zu scheitern.

## Sicherheitsmodus

Ausgehende Anrufe sind standardmaessig geschuetzt. Der Button erzeugt im Schutzmodus nur einen lokalen Verlaufseintrag. Erst wenn der Anrufschutz in den Einstellungen deaktiviert ist und ein SIP-Adapter aktiv ist, wird ein echter Call gestartet. Im Browser-Testmodus kann optional `tel:` genutzt werden; in der Desktop-App laeuft Telefonie ueber liblinphone.

Im Browser-Prototyp existiert zusaetzlich ein `JsSIP`-basierter WebRTC/SIP-Adapter. Er registriert ueber einen konfigurierbaren WSS-Endpunkt und blockiert ausgehende Ziele, die nicht in der Liste erlaubter Testnummern stehen. Der passive Check am 2026-07-02 gegen `pbx.nivako.de:8089` lieferte keinen verwertbaren WSS-Handshake; produktive Browser-Telefonie ist deshalb PBX-seitig noch nicht verifiziert.

Im Desktop-Modus ist Browser-WebRTC nicht der Zielweg. Die Tauri-App nutzt liblinphone nativ, weil damit Windows-Audio, SIP-Registrierung, Codecs und NAT sauberer kontrollierbar sind. Auf dem Linux-Buildhost ist die native liblinphone-Anbindung gegen `liblinphone-dev` 5.1.65 gebaut und per `cargo build` gelinkt; der Windows-Build braucht danach noch das passende Windows-SDK/Packaging.

## V1

- eine SIP-Identität, vorkonfigurierbar für Nebenstelle 101
- ausgehende und eingehende Anrufe
- Halten, Stumm, DTMF, Auflegen
- CardDAV-Kontakte lesen und lokal suchen
- Anrufliste lokal
- Einstellungen für SIP, Audio und CardDAV

## Später

- Blind/Attended Transfer
- mehrere Konten
- BLF/Präsenz
- EspoCRM-Screenpop
- Gesprächsnotizen und Transkript-Anbindung über PBX/n8n
