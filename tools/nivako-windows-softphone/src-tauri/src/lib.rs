use base64::Engine;
use once_cell::sync::Lazy;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashMap};
use std::ffi::{CStr, CString};
use std::fs;
use std::io::{self, BufRead, BufReader, Write};
use std::net::{ToSocketAddrs, UdpSocket};
use std::os::raw::{c_char, c_int, c_void};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::ptr;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

const CARDDAV_SERVICE: &str = "NIVAKO Softphone CardDAV";
const SIP_SERVICE: &str = "NIVAKO Softphone SIP";

#[derive(Clone, Debug, Deserialize, Serialize)]
struct NativeSipStatus {
    registered: bool,
    message: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
struct NativeSipSnapshot {
    registered: bool,
    call_state: String,
    provider: String,
    message: String,
    held: bool,
    muted: bool,
}

#[derive(Debug, Serialize)]
struct CardDavSyncResult {
    xml: String,
    url: String,
    vcard_count: usize,
    tried: Vec<String>,
}

type LinphoneCore = c_void;
type LinphoneCall = c_void;
type LinphoneAddress = c_void;
type LinphoneAuthInfo = c_void;
type LinphoneProxyConfig = c_void;

#[allow(non_camel_case_types)]
type bool_t = c_int;

#[repr(C)]
struct LinphoneSipTransports {
    udp_port: c_int,
    tcp_port: c_int,
    dtls_port: c_int,
    tls_port: c_int,
}

#[cfg_attr(target_os = "windows", link(name = "liblinphone"))]
#[cfg_attr(not(target_os = "windows"), link(name = "linphone"))]
extern "C" {
    fn linphone_core_new(
        vtable: *const c_void,
        config_path: *const c_char,
        factory_config_path: *const c_char,
        userdata: *mut c_void,
    ) -> *mut LinphoneCore;
    fn linphone_core_start(core: *mut LinphoneCore) -> c_int;
    fn linphone_core_iterate(core: *mut LinphoneCore);
    fn linphone_core_unref(core: *mut LinphoneCore);
    fn linphone_core_set_network_reachable(core: *mut LinphoneCore, reachable: bool_t);
    fn linphone_core_set_sip_network_reachable(core: *mut LinphoneCore, reachable: bool_t);
    fn linphone_core_set_media_network_reachable(core: *mut LinphoneCore, reachable: bool_t);
    fn linphone_core_set_sip_transports(
        core: *mut LinphoneCore,
        transports: *const LinphoneSipTransports,
    ) -> c_int;
    fn linphone_core_add_auth_info(core: *mut LinphoneCore, auth_info: *mut LinphoneAuthInfo);
    fn linphone_auth_info_new(
        username: *const c_char,
        userid: *const c_char,
        passwd: *const c_char,
        ha1: *const c_char,
        realm: *const c_char,
        domain: *const c_char,
    ) -> *mut LinphoneAuthInfo;
    fn linphone_auth_info_unref(auth_info: *mut LinphoneAuthInfo);
    fn linphone_core_create_proxy_config(core: *mut LinphoneCore) -> *mut LinphoneProxyConfig;
    fn linphone_proxy_config_set_identity_address(
        proxy_config: *mut LinphoneProxyConfig,
        identity: *const LinphoneAddress,
    ) -> c_int;
    fn linphone_proxy_config_set_server_addr(
        proxy_config: *mut LinphoneProxyConfig,
        server_address: *const c_char,
    ) -> c_int;
    fn linphone_proxy_config_enable_register(
        proxy_config: *mut LinphoneProxyConfig,
        enable: bool_t,
    );
    fn linphone_proxy_config_set_expires(proxy_config: *mut LinphoneProxyConfig, expires: c_int);
    fn linphone_core_add_proxy_config(
        core: *mut LinphoneCore,
        config: *mut LinphoneProxyConfig,
    ) -> c_int;
    fn linphone_core_set_default_proxy_config(
        core: *mut LinphoneCore,
        config: *mut LinphoneProxyConfig,
    );
    fn linphone_proxy_config_refresh_register(proxy_config: *mut LinphoneProxyConfig);
    fn linphone_core_refresh_registers(core: *mut LinphoneCore);
    fn linphone_core_ensure_registered(core: *mut LinphoneCore);
    fn linphone_proxy_config_get_state(proxy_config: *const LinphoneProxyConfig) -> c_int;
    fn linphone_registration_state_to_string(state: c_int) -> *const c_char;
    fn linphone_address_new(address: *const c_char) -> *mut LinphoneAddress;
    fn linphone_address_unref(address: *mut LinphoneAddress);
    fn linphone_core_invite_address(
        core: *mut LinphoneCore,
        address: *const LinphoneAddress,
    ) -> *mut LinphoneCall;
    fn linphone_core_get_current_call(core: *const LinphoneCore) -> *mut LinphoneCall;
    fn linphone_call_get_state(call: *const LinphoneCall) -> c_int;
    fn linphone_call_state_to_string(state: c_int) -> *const c_char;
    fn linphone_core_terminate_all_calls(core: *mut LinphoneCore) -> c_int;
    fn linphone_core_pause_call(core: *mut LinphoneCore, call: *mut LinphoneCall) -> c_int;
    fn linphone_core_resume_call(core: *mut LinphoneCore, call: *mut LinphoneCall) -> c_int;
    fn linphone_core_enable_mic(core: *mut LinphoneCore, enable: bool_t);
    fn linphone_call_send_dtmf(call: *mut LinphoneCall, dtmf: c_char) -> c_int;
}

struct LinphoneSession {
    core: *mut LinphoneCore,
    proxy: *mut LinphoneProxyConfig,
    sip_server: String,
    sip_extension: String,
    held: bool,
    muted: bool,
}

unsafe impl Send for LinphoneSession {}

impl Drop for LinphoneSession {
    fn drop(&mut self) {
        unsafe {
            linphone_core_terminate_all_calls(self.core);
            linphone_core_unref(self.core);
        }
    }
}

static SIP_SESSION: Lazy<Arc<Mutex<Option<LinphoneSession>>>> =
    Lazy::new(|| Arc::new(Mutex::new(None)));
static SIP_SNAPSHOT: Lazy<Arc<Mutex<NativeSipSnapshot>>> = Lazy::new(|| {
    Arc::new(Mutex::new(NativeSipSnapshot {
        registered: false,
        call_state: "idle".to_string(),
        provider: "none".to_string(),
        message: "SIP nicht registriert.".to_string(),
        held: false,
        muted: false,
    }))
});
static SIP_WORKER_STARTED: AtomicBool = AtomicBool::new(false);
static SIP_SIDECAR: Lazy<Arc<Mutex<Option<SipSidecarClient>>>> =
    Lazy::new(|| Arc::new(Mutex::new(None)));

#[derive(Debug, Deserialize, Serialize)]
#[serde(tag = "command", rename_all = "snake_case")]
enum SipSidecarCommand {
    Register {
        sip_server: String,
        sip_extension: String,
        sip_auth_user: String,
        display_name: String,
        password: String,
    },
    Status,
    Dial {
        number: String,
        sip_server: String,
        sip_extension: String,
    },
    Hangup,
    Hold,
    Mute {
        muted: bool,
    },
    Dtmf {
        digit: String,
    },
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
enum SipSidecarReply {
    Status { status: NativeSipStatus },
    Snapshot { snapshot: NativeSipSnapshot },
    Error { message: String },
}

struct SipSidecarClient {
    child: Child,
    stdin: ChildStdin,
    stdout: BufReader<ChildStdout>,
}

#[derive(Debug, thiserror::Error)]
enum AppError {
    #[error("{0}")]
    Message(String),
    #[error("HTTP Fehler: {0}")]
    Http(#[from] reqwest::Error),
    #[error("Credential Fehler: {0}")]
    Credential(#[from] keyring::Error),
}

impl serde::Serialize for AppError {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::ser::Serializer,
    {
        serializer.serialize_str(&self.to_string())
    }
}

fn cstring(value: &str, field: &str) -> Result<CString, AppError> {
    CString::new(value)
        .map_err(|_| AppError::Message(format!("{field} enthaelt ungueltige Null-Bytes")))
}

fn c_string_or_empty(ptr: *const c_char) -> String {
    if ptr.is_null() {
        return String::new();
    }
    unsafe { CStr::from_ptr(ptr).to_string_lossy().into_owned() }
}

fn is_sip_sidecar_process() -> bool {
    std::env::args().any(|arg| arg == "--nivako-sip-sidecar")
}

fn normalize_sip_server(sip_server: &str) -> String {
    let trimmed = sip_server.trim();
    if trimmed.starts_with("sip:") || trimmed.starts_with("sips:") {
        trimmed.to_string()
    } else {
        format!("sip:{trimmed}")
    }
}

fn normalize_domain(sip_server: &str) -> String {
    sip_server
        .trim()
        .trim_start_matches("sip:")
        .trim_start_matches("sips:")
        .split(';')
        .next()
        .unwrap_or(sip_server.trim())
        .split(':')
        .next()
        .unwrap_or(sip_server.trim())
        .to_string()
}

fn sip_host_port(sip_server: &str) -> Result<(String, u16), AppError> {
    let server = sip_server
        .trim()
        .trim_start_matches("sip:")
        .trim_start_matches("sips:")
        .split(';')
        .next()
        .unwrap_or(sip_server.trim());
    let (host, port) = match server.rsplit_once(':') {
        Some((host, port)) if port.chars().all(|char| char.is_ascii_digit()) => {
            let parsed = port
                .parse::<u16>()
                .map_err(|error| AppError::Message(format!("Ungueltiger SIP-Port: {error}")))?;
            (host.to_string(), parsed)
        }
        _ => (server.to_string(), 5060),
    };
    if host.trim().is_empty() {
        return Err(AppError::Message("SIP-Server fehlt".to_string()));
    }
    Ok((host, port))
}

fn sip_token(prefix: &str) -> String {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or_default();
    format!("{prefix}{nanos:x}")
}

fn sip_register_message(
    domain: &str,
    extension: &str,
    display_name: &str,
    local_addr: &str,
    branch: &str,
    tag: &str,
    call_id: &str,
    cseq: u32,
    authorization: Option<&str>,
) -> String {
    let auth_line = authorization
        .map(|value| format!("Authorization: {value}\r\n"))
        .unwrap_or_default();
    format!(
        "REGISTER sip:{domain} SIP/2.0\r\n\
         Via: SIP/2.0/UDP {local_addr};branch={branch};rport\r\n\
         Max-Forwards: 70\r\n\
         From: \"{display_name}\" <sip:{extension}@{domain}>;tag={tag}\r\n\
         To: <sip:{extension}@{domain}>\r\n\
         Call-ID: {call_id}\r\n\
         CSeq: {cseq} REGISTER\r\n\
         Contact: <sip:{extension}@{local_addr};transport=udp>\r\n\
         Expires: 120\r\n\
         User-Agent: NIVAKO Softphone\r\n\
         {auth_line}\
         Content-Length: 0\r\n\r\n"
    )
}

fn parse_sip_status(response: &str) -> Option<(u16, String)> {
    let line = response.lines().next()?.trim();
    let mut parts = line.splitn(3, ' ');
    let _version = parts.next()?;
    let code = parts.next()?.parse::<u16>().ok()?;
    let reason = parts.next().unwrap_or("").to_string();
    Some((code, reason))
}

fn find_sip_header<'a>(response: &'a str, name: &str) -> Option<&'a str> {
    let prefix = format!("{}:", name.to_ascii_lowercase());
    response.lines().find_map(|line| {
        let trimmed = line.trim();
        if trimmed.to_ascii_lowercase().starts_with(&prefix) {
            trimmed.split_once(':').map(|(_, value)| value.trim())
        } else {
            None
        }
    })
}

fn parse_digest_challenge(header: &str) -> HashMap<String, String> {
    let mut value = header.trim();
    if value.to_ascii_lowercase().starts_with("digest ") {
        value = value[7..].trim();
    }
    let mut parts = Vec::new();
    let mut current = String::new();
    let mut in_quotes = false;
    for char in value.chars() {
        match char {
            '"' => {
                in_quotes = !in_quotes;
                current.push(char);
            }
            ',' if !in_quotes => {
                parts.push(current.trim().to_string());
                current.clear();
            }
            _ => current.push(char),
        }
    }
    if !current.trim().is_empty() {
        parts.push(current.trim().to_string());
    }
    parts
        .into_iter()
        .filter_map(|part| {
            let (key, raw_value) = part.split_once('=')?;
            Some((
                key.trim().to_ascii_lowercase(),
                raw_value.trim().trim_matches('"').to_string(),
            ))
        })
        .collect()
}

fn md5_hex(value: &str) -> String {
    format!("{:x}", md5::compute(value.as_bytes()))
}

fn sip_digest_authorization(
    auth_username: &str,
    display_username: &str,
    password: &str,
    domain: &str,
    challenge: &HashMap<String, String>,
) -> Result<String, AppError> {
    let realm = challenge
        .get("realm")
        .ok_or_else(|| AppError::Message("SIP 401 ohne Digest-Realm".to_string()))?;
    let nonce = challenge
        .get("nonce")
        .ok_or_else(|| AppError::Message("SIP 401 ohne Digest-Nonce".to_string()))?;
    let uri = format!("sip:{domain}");
    let qop = challenge.get("qop").and_then(|value| {
        value
            .split(',')
            .map(str::trim)
            .map(|candidate| candidate.trim_matches('"'))
            .find(|candidate| *candidate == "auth")
    });
    let ha1 = md5_hex(&format!("{auth_username}:{realm}:{password}"));
    let ha2 = md5_hex(&format!("REGISTER:{uri}"));
    if let Some(qop) = qop {
        let nc = "00000001";
        let cnonce = sip_token("cn");
        let response = md5_hex(&format!("{ha1}:{nonce}:{nc}:{cnonce}:{qop}:{ha2}"));
        Ok(format!(
            "Digest username=\"{display_username}\", realm=\"{realm}\", nonce=\"{nonce}\", uri=\"{uri}\", response=\"{response}\", algorithm=MD5, qop={qop}, nc={nc}, cnonce=\"{cnonce}\""
        ))
    } else {
        let response = md5_hex(&format!("{ha1}:{nonce}:{ha2}"));
        Ok(format!(
            "Digest username=\"{display_username}\", realm=\"{realm}\", nonce=\"{nonce}\", uri=\"{uri}\", response=\"{response}\", algorithm=MD5"
        ))
    }
}

fn sip_auth_user_candidates(extension: &str, domain: &str) -> Vec<String> {
    let mut candidates = vec![extension.trim().to_string()];
    if !extension.contains('@') {
        candidates.push(format!("{}@{}", extension.trim(), domain));
    }
    candidates.sort();
    candidates.dedup();
    candidates
}

fn challenge_summary(challenge: &HashMap<String, String>) -> String {
    let realm = challenge
        .get("realm")
        .map(String::as_str)
        .unwrap_or("unbekannt");
    let qop = challenge
        .get("qop")
        .map(String::as_str)
        .unwrap_or("nicht angegeben");
    let algorithm = challenge
        .get("algorithm")
        .map(String::as_str)
        .unwrap_or("MD5");
    format!("Realm {realm}, qop {qop}, Algorithmus {algorithm}")
}

fn receive_sip_response(socket: &UdpSocket) -> Result<String, AppError> {
    let mut buf = [0_u8; 8192];
    let len = socket
        .recv(&mut buf)
        .map_err(|error| AppError::Message(format!("SIP UDP Antwort fehlgeschlagen: {error}")))?;
    Ok(String::from_utf8_lossy(&buf[..len]).into_owned())
}

fn sip_register_udp(
    sip_server: &str,
    sip_extension: &str,
    sip_auth_user: &str,
    display_name: &str,
    password: &str,
) -> Result<NativeSipStatus, AppError> {
    let domain = normalize_domain(sip_server);
    let (host, port) = sip_host_port(sip_server)?;
    let remote = (host.as_str(), port)
        .to_socket_addrs()
        .map_err(|error| {
            AppError::Message(format!(
                "SIP-Server konnte nicht aufgeloest werden: {host}:{port}: {error}"
            ))
        })?
        .next()
        .ok_or_else(|| {
            AppError::Message(format!(
                "SIP-Server hat keine Adresse geliefert: {host}:{port}"
            ))
        })?;
    let socket = UdpSocket::bind("0.0.0.0:0").map_err(|error| {
        AppError::Message(format!(
            "SIP UDP Socket konnte nicht erstellt werden: {error}"
        ))
    })?;
    socket
        .set_read_timeout(Some(Duration::from_secs(8)))
        .map_err(|error| {
            AppError::Message(format!("SIP Timeout konnte nicht gesetzt werden: {error}"))
        })?;
    socket.connect(remote).map_err(|error| {
        AppError::Message(format!(
            "SIP UDP Verbindung zu {remote} fehlgeschlagen: {error}"
        ))
    })?;
    let local_addr = socket
        .local_addr()
        .map_err(|error| {
            AppError::Message(format!(
                "Lokale SIP-Adresse konnte nicht ermittelt werden: {error}"
            ))
        })?
        .to_string();
    let branch = sip_token("z9hG4bK");
    let tag = sip_token("tag");
    let call_id = format!("{}@{}", sip_token("call"), local_addr.replace(':', "-"));
    let first = sip_register_message(
        &domain,
        sip_extension,
        display_name,
        &local_addr,
        &branch,
        &tag,
        &call_id,
        1,
        None,
    );
    socket.send(first.as_bytes()).map_err(|error| {
        AppError::Message(format!(
            "SIP REGISTER konnte nicht gesendet werden: {error}"
        ))
    })?;
    let first_response = receive_sip_response(&socket)?;
    let (first_code, first_reason) = parse_sip_status(&first_response).ok_or_else(|| {
        AppError::Message(format!(
            "SIP Antwort konnte nicht gelesen werden: {first_response}"
        ))
    })?;

    if first_code == 200 {
        return Ok(NativeSipStatus {
            registered: true,
            message: format!("SIP REGISTER OK ohne Challenge: {sip_extension}@{domain} ({first_code} {first_reason}). Nativer Anruf-Core bleibt zum Crashschutz deaktiviert."),
        });
    }
    if first_code != 401 && first_code != 407 {
        return Ok(NativeSipStatus {
            registered: false,
            message: format!("SIP REGISTER abgelehnt: {first_code} {first_reason} fuer {sip_extension}@{domain}."),
        });
    }

    let challenge_header = find_sip_header(&first_response, "WWW-Authenticate")
        .or_else(|| find_sip_header(&first_response, "Proxy-Authenticate"))
        .ok_or_else(|| AppError::Message(format!("SIP {first_code} ohne Authenticate-Header")))?
        .to_string();
    let challenge = parse_digest_challenge(&challenge_header);
    let mut auth_failures = Vec::new();
    let mut auth_candidates = vec![sip_auth_user.trim().to_string()];
    auth_candidates.extend(sip_auth_user_candidates(sip_extension, &domain));
    auth_candidates.retain(|candidate| !candidate.is_empty());
    auth_candidates.sort();
    auth_candidates.dedup();
    for (index, auth_username) in auth_candidates.into_iter().enumerate() {
        let authorization = sip_digest_authorization(
            &auth_username,
            &auth_username,
            password,
            &domain,
            &challenge,
        )?;
        let branch = sip_token("z9hG4bK");
        let second = sip_register_message(
            &domain,
            sip_extension,
            display_name,
            &local_addr,
            &branch,
            &tag,
            &call_id,
            (index as u32) + 2,
            Some(&authorization),
        );
        socket.send(second.as_bytes()).map_err(|error| {
            AppError::Message(format!(
                "SIP REGISTER mit Auth konnte nicht gesendet werden: {error}"
            ))
        })?;
        let second_response = receive_sip_response(&socket)?;
        let (second_code, second_reason) = parse_sip_status(&second_response).ok_or_else(|| {
            AppError::Message(format!(
                "SIP Auth-Antwort konnte nicht gelesen werden: {second_response}"
            ))
        })?;
        if second_code == 200 {
            return Ok(NativeSipStatus {
                registered: true,
                message: format!("SIP REGISTER OK: {display_name} / {sip_extension}@{domain} ({second_code} {second_reason}) mit Auth-User {auth_username}. App bleibt stabil; nativer Anruf-Core bleibt zum Crashschutz deaktiviert."),
            });
        }
        auth_failures.push(format!("{auth_username}: {second_code} {second_reason}"));
        if second_code != 401 && second_code != 407 {
            return Ok(NativeSipStatus {
                registered: false,
                message: format!("SIP REGISTER abgelehnt: {second_code} {second_reason} fuer {sip_extension}@{domain} mit Auth-User {auth_username}."),
            });
        }
    }

    Ok(NativeSipStatus {
        registered: false,
        message: format!(
            "SIP REGISTER fehlgeschlagen: Auth-Challenge beantwortet, aber PBX lehnt weiter ab. {}. Versucht: {}. Bitte SIP-Benutzer/Auth-ID und SIP-Passwort pruefen.",
            challenge_summary(&challenge),
            auth_failures.join(", ")
        ),
    })
}

fn registration_state(proxy: *mut LinphoneProxyConfig) -> (bool, String) {
    let state = unsafe { linphone_proxy_config_get_state(proxy) };
    let label = c_string_or_empty(unsafe { linphone_registration_state_to_string(state) });
    (state == 2, label)
}

fn call_state(core: *mut LinphoneCore) -> String {
    let call = unsafe { linphone_core_get_current_call(core) };
    if call.is_null() {
        return "idle".to_string();
    }
    let state = unsafe { linphone_call_get_state(call) };
    let label = c_string_or_empty(unsafe { linphone_call_state_to_string(state) });
    let lower = label.to_ascii_lowercase();
    if lower.contains("streams running") || lower.contains("connected") {
        "active".to_string()
    } else if lower.contains("paused") || lower.contains("pausing") {
        "held".to_string()
    } else if lower.contains("incoming") || lower.contains("outgoing") || lower.contains("ringing")
    {
        "ringing".to_string()
    } else if lower.contains("end") || lower.contains("released") || lower.contains("error") {
        "idle".to_string()
    } else {
        label
    }
}

fn set_sip_snapshot(snapshot: NativeSipSnapshot) {
    if let Ok(mut guard) = SIP_SNAPSHOT.lock() {
        *guard = snapshot;
    }
}

fn session_snapshot(session: &LinphoneSession, message: String) -> NativeSipSnapshot {
    let (registered, registration_label) = registration_state(session.proxy);
    NativeSipSnapshot {
        registered,
        call_state: call_state(session.core),
        provider: "liblinphone".to_string(),
        message: format!("{message} SIP-Status: {registration_label}"),
        held: session.held,
        muted: session.muted,
    }
}

fn refresh_sip_snapshot_from_session(message: String) -> Option<NativeSipSnapshot> {
    let Ok(mut guard) = SIP_SESSION.lock() else {
        return None;
    };
    let session = guard.as_mut()?;
    unsafe { linphone_core_iterate(session.core) };
    let snapshot = session_snapshot(session, message);
    set_sip_snapshot(snapshot.clone());
    Some(snapshot)
}

fn ensure_sip_worker() {
    if SIP_WORKER_STARTED.swap(true, Ordering::SeqCst) {
        return;
    }

    let session = Arc::clone(&SIP_SESSION);
    thread::spawn(move || loop {
        if let Ok(mut guard) = session.lock() {
            if let Some(active) = guard.as_mut() {
                unsafe { linphone_core_iterate(active.core) };
                let snapshot = session_snapshot(active, "Native SIP aktiv.".to_string());
                set_sip_snapshot(snapshot);
            }
        }
        thread::sleep(Duration::from_millis(50));
    });
}

fn tick_session_for(rounds: usize, delay_ms: u64) {
    for _ in 0..rounds {
        if let Ok(mut guard) = SIP_SESSION.lock() {
            if let Some(active) = guard.as_mut() {
                unsafe { linphone_core_iterate(active.core) };
            }
        }
        thread::sleep(Duration::from_millis(delay_ms));
    }
}

fn tick_core_for(core: *mut LinphoneCore, rounds: usize, delay_ms: u64) {
    for _ in 0..rounds {
        unsafe { linphone_core_iterate(core) };
        thread::sleep(Duration::from_millis(delay_ms));
    }
}

fn with_session<T>(
    action: impl FnOnce(&mut LinphoneSession) -> Result<T, AppError>,
) -> Result<T, AppError> {
    let mut guard = SIP_SESSION
        .lock()
        .map_err(|_| AppError::Message("SIP-Sitzung ist blockiert".to_string()))?;
    let session = guard
        .as_mut()
        .ok_or_else(|| AppError::Message("SIP ist nicht registriert".to_string()))?;
    action(session)
}

fn fallback_secret_path() -> Result<PathBuf, AppError> {
    let base = std::env::var_os("APPDATA")
        .or_else(|| std::env::var_os("LOCALAPPDATA"))
        .map(PathBuf::from)
        .or_else(|| std::env::current_dir().ok())
        .ok_or_else(|| {
            AppError::Message("App-Datenordner konnte nicht ermittelt werden".to_string())
        })?;
    Ok(base.join("NIVAKO Softphone").join("secrets-fallback.json"))
}

fn app_data_dir() -> Result<PathBuf, AppError> {
    let base = std::env::var_os("APPDATA")
        .or_else(|| std::env::var_os("LOCALAPPDATA"))
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("XDG_DATA_HOME").map(PathBuf::from))
        .or_else(|| {
            std::env::var_os("HOME")
                .map(PathBuf::from)
                .map(|home| home.join(".local").join("share"))
        })
        .or_else(|| std::env::current_dir().ok())
        .ok_or_else(|| {
            AppError::Message("App-Datenordner konnte nicht ermittelt werden".to_string())
        })?;
    Ok(base.join("NIVAKO Softphone"))
}

fn linphone_config_path() -> Result<CString, AppError> {
    let dir = app_data_dir()?.join("linphone");
    fs::create_dir_all(&dir).map_err(|error| {
        AppError::Message(format!(
            "liblinphone-Datenordner konnte nicht erstellt werden: {error}"
        ))
    })?;
    if let Some(home) = std::env::var_os("HOME").map(PathBuf::from) {
        let _ = fs::create_dir_all(home.join(".local").join("share").join("linphone"));
    }
    if let Some(appdata) = std::env::var_os("APPDATA").map(PathBuf::from) {
        let _ = fs::create_dir_all(appdata.join("linphone"));
    }
    if let Some(localappdata) = std::env::var_os("LOCALAPPDATA").map(PathBuf::from) {
        let _ = fs::create_dir_all(localappdata.join("linphone"));
    }
    let config = dir.join(format!("linphone-sidecar-{}.rc", std::process::id()));
    let _ = fs::write(
        &config,
        "[sip]\nregister_only_when_network_is_up=0\nregister_only_when_upnp_is_ok=0\nguess_hostname=1\n\n[net]\nfirewall_policy=0\n",
    );
    let config = config.to_string_lossy().into_owned();
    cstring(&config, "liblinphone-Konfigurationspfad")
}

fn fallback_secret_key(service: &str, account: &str) -> String {
    base64::engine::general_purpose::STANDARD.encode(format!("{service}\n{account}"))
}

fn read_fallback_secrets() -> Result<BTreeMap<String, String>, AppError> {
    let path = fallback_secret_path()?;
    if !path.exists() {
        return Ok(BTreeMap::new());
    }
    let text = fs::read_to_string(path).map_err(|error| {
        AppError::Message(format!(
            "Fallback-Credentials konnten nicht gelesen werden: {error}"
        ))
    })?;
    serde_json::from_str(&text)
        .map_err(|error| AppError::Message(format!("Fallback-Credentials sind unlesbar: {error}")))
}

fn write_fallback_secret(service: &str, account: &str, password: &str) -> Result<(), AppError> {
    let path = fallback_secret_path()?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| {
            AppError::Message(format!(
                "Fallback-Credential-Ordner konnte nicht erstellt werden: {error}"
            ))
        })?;
    }
    let mut secrets = read_fallback_secrets()?;
    secrets.insert(
        fallback_secret_key(service, account),
        base64::engine::general_purpose::STANDARD.encode(password),
    );
    let text = serde_json::to_string_pretty(&secrets).map_err(|error| {
        AppError::Message(format!(
            "Fallback-Credentials konnten nicht serialisiert werden: {error}"
        ))
    })?;
    fs::write(path, text).map_err(|error| {
        AppError::Message(format!(
            "Fallback-Credentials konnten nicht gespeichert werden: {error}"
        ))
    })
}

fn read_fallback_secret(service: &str, account: &str) -> Result<Option<String>, AppError> {
    let secrets = read_fallback_secrets()?;
    let Some(encoded) = secrets.get(&fallback_secret_key(service, account)) else {
        return Ok(None);
    };
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(encoded)
        .map_err(|error| {
            AppError::Message(format!("Fallback-Credential ist beschaedigt: {error}"))
        })?;
    String::from_utf8(bytes)
        .map(Some)
        .map_err(|error| AppError::Message(format!("Fallback-Credential ist kein UTF-8: {error}")))
}

fn keyring_secret(service: &str, account: &str) -> Result<Option<String>, AppError> {
    let entry = match keyring::Entry::new(service, account) {
        Ok(entry) => entry,
        Err(error) => {
            eprintln!("Windows Credential Manager nicht verfuegbar: {error}");
            return Ok(None);
        }
    };
    match entry.get_password() {
        Ok(password) => Ok(Some(password)),
        Err(error) => {
            eprintln!("Windows Credential Manager lieferte kein Passwort: {error}");
            Ok(None)
        }
    }
}

fn stored_or_supplied_secret(
    service: &str,
    account: &str,
    supplied: Option<String>,
) -> Result<String, AppError> {
    if let Some(password) = supplied.filter(|value| !value.is_empty()) {
        let _ = write_fallback_secret(service, account, &password);
        return Ok(password);
    }
    if let Some(password) = keyring_secret(service, account)? {
        return Ok(password);
    }
    if let Some(password) = read_fallback_secret(service, account)? {
        return Ok(password);
    }
    Err(AppError::Message(format!(
        "Passwort fehlt fuer {service} / {account}. Bitte in den Einstellungen erneut eintragen und speichern."
    )))
}

fn carddav_query_body() -> &'static str {
    r#"<?xml version="1.0" encoding="UTF-8"?>
<card:addressbook-query xmlns:d="DAV:" xmlns:card="urn:ietf:params:xml:ns:carddav">
  <d:prop>
    <d:getetag />
    <card:address-data />
  </d:prop>
</card:addressbook-query>"#
}

fn normalize_url_slash(url: &str) -> String {
    let trimmed = url.trim();
    if trimmed.ends_with('/') {
        trimmed.to_string()
    } else {
        format!("{trimmed}/")
    }
}

fn carddav_candidate_urls(url: &str, username: &str) -> Vec<String> {
    let mut candidates = Vec::new();
    let direct = normalize_url_slash(url);
    candidates.push(direct.clone());

    let lower_user = username.to_lowercase();
    if username != lower_user {
        candidates.push(direct.replace(
            &format!("/users/{username}/"),
            &format!("/users/{lower_user}/"),
        ));
    }

    if let Ok(parsed) = reqwest::Url::parse(&direct) {
        let origin = parsed.origin().ascii_serialization();
        for user in [username.to_string(), lower_user.clone()] {
            for book in ["nivako-crm", "contacts", "kontakte"] {
                candidates.push(format!(
                    "{origin}/remote.php/dav/addressbooks/users/{user}/{book}/"
                ));
            }
        }
    }

    candidates.dedup();
    candidates
}

fn report_carddav_url(
    client: &reqwest::blocking::Client,
    url: &str,
    auth: &str,
) -> Result<Option<String>, AppError> {
    let method = reqwest::Method::from_bytes(b"REPORT")
        .map_err(|error| AppError::Message(error.to_string()))?;
    let response = client
        .request(method, url)
        .header("Authorization", format!("Basic {auth}"))
        .header("Content-Type", "application/xml; charset=utf-8")
        .header("Depth", "1")
        .body(carddav_query_body())
        .send()?;

    let status = response.status();
    let text = response.text()?;
    if (status.is_success() || status.as_u16() == 207) && text.contains("BEGIN:VCARD") {
        return Ok(Some(text));
    }
    if status.as_u16() == 401 || status.as_u16() == 403 {
        return Err(AppError::Message(format!(
            "CardDAV HTTP {status}: Zugangsdaten abgelehnt"
        )));
    }
    Ok(None)
}

fn sip_register_linphone(
    sip_server: &str,
    sip_extension: &str,
    sip_auth_user: &str,
    display_name: &str,
    password: &str,
) -> Result<NativeSipStatus, AppError> {
    let domain = normalize_domain(sip_server);
    let server_addr = normalize_sip_server(sip_server);
    let identity = format!("sip:{sip_extension}@{domain}");
    let username = cstring(sip_auth_user, "SIP-Auth-ID")?;
    let userid = cstring(sip_extension, "SIP-Benutzer")?;
    let passwd = cstring(password, "SIP-Passwort")?;
    let c_domain = cstring(&domain, "SIP-Domain")?;
    let c_identity = cstring(&identity, "SIP-Identitaet")?;
    let c_server = cstring(&server_addr, "SIP-Server")?;
    let config_path = linphone_config_path()?;

    let core = unsafe {
        linphone_core_new(
            ptr::null(),
            config_path.as_ptr(),
            ptr::null(),
            ptr::null_mut(),
        )
    };
    if core.is_null() {
        return Err(AppError::Message(
            "liblinphone Core konnte nicht erstellt werden".to_string(),
        ));
    }
    unsafe {
        let transports = LinphoneSipTransports {
            udp_port: -1,
            tcp_port: -1,
            dtls_port: 0,
            tls_port: 0,
        };
        linphone_core_set_sip_transports(core, &transports);
        linphone_core_set_network_reachable(core, 1);
        linphone_core_set_sip_network_reachable(core, 1);
        linphone_core_set_media_network_reachable(core, 1);
    }

    let result: Result<*mut LinphoneProxyConfig, AppError> = unsafe {
        let auth = linphone_auth_info_new(
            username.as_ptr(),
            userid.as_ptr(),
            passwd.as_ptr(),
            ptr::null(),
            ptr::null(),
            c_domain.as_ptr(),
        );
        if auth.is_null() {
            linphone_core_unref(core);
            return Err(AppError::Message(
                "SIP-Auth konnte nicht erstellt werden".to_string(),
            ));
        }
        linphone_core_add_auth_info(core, auth);
        linphone_auth_info_unref(auth);

        let proxy = linphone_core_create_proxy_config(core);
        if proxy.is_null() {
            linphone_core_unref(core);
            return Err(AppError::Message(
                "SIP-Proxy konnte nicht erstellt werden".to_string(),
            ));
        }

        let address = linphone_address_new(c_identity.as_ptr());
        if address.is_null() {
            linphone_core_unref(core);
            return Err(AppError::Message(format!(
                "Ungueltige SIP-Identitaet: {identity}"
            )));
        }

        let identity_status = linphone_proxy_config_set_identity_address(proxy, address);
        linphone_address_unref(address);
        let server_status = linphone_proxy_config_set_server_addr(proxy, c_server.as_ptr());
        linphone_proxy_config_set_expires(proxy, 600);
        linphone_proxy_config_enable_register(proxy, 1);
        let add_status = linphone_core_add_proxy_config(core, proxy);
        linphone_core_set_default_proxy_config(core, proxy);
        let start_status = linphone_core_start(core);
        linphone_core_set_network_reachable(core, 1);
        linphone_core_set_sip_network_reachable(core, 1);
        linphone_core_set_media_network_reachable(core, 1);
        linphone_proxy_config_refresh_register(proxy);
        linphone_core_refresh_registers(core);
        linphone_core_ensure_registered(core);

        if identity_status != 0 || server_status != 0 || add_status != 0 || start_status != 0 {
            linphone_core_unref(core);
            return Err(AppError::Message(format!(
                "SIP-Konfiguration wurde von liblinphone abgelehnt (identity={identity_status}, server={server_status}, add={add_status}, start={start_status})"
            )));
        }

        Ok(proxy)
    };

    let proxy = result?;
    let session = LinphoneSession {
        core,
        proxy,
        sip_server: sip_server.to_string(),
        sip_extension: sip_extension.to_string(),
        held: false,
        muted: false,
    };

    let mut guard = SIP_SESSION
        .lock()
        .map_err(|_| AppError::Message("SIP-Sitzung ist blockiert".to_string()))?;
    *guard = Some(session);
    drop(guard);

    ensure_sip_worker();
    tick_session_for(80, 100);
    let snapshot = refresh_sip_snapshot_from_session(format!(
        "SIP-Registrierung geprueft: {display_name} / {sip_extension}@{domain}."
    ))
    .ok_or_else(|| {
        AppError::Message("SIP-Sitzung wurde nach Registrierung nicht erstellt".to_string())
    })?;

    Ok(NativeSipStatus {
        registered: snapshot.registered,
        message: snapshot.message,
    })
}

fn start_sip_sidecar() -> Result<SipSidecarClient, AppError> {
    let executable = std::env::current_exe().map_err(|error| {
        AppError::Message(format!(
            "SIP-Sidecar konnte App-Pfad nicht ermitteln: {error}"
        ))
    })?;
    let mut child = Command::new(executable)
        .arg("--nivako-sip-sidecar")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|error| AppError::Message(format!("SIP-Sidecar konnte nicht starten: {error}")))?;
    let stdin = child
        .stdin
        .take()
        .ok_or_else(|| AppError::Message("SIP-Sidecar stdin fehlt".to_string()))?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| AppError::Message("SIP-Sidecar stdout fehlt".to_string()))?;
    Ok(SipSidecarClient {
        child,
        stdin,
        stdout: BufReader::new(stdout),
    })
}

fn sip_sidecar_call(command: SipSidecarCommand) -> Result<SipSidecarReply, AppError> {
    let mut guard = SIP_SIDECAR
        .lock()
        .map_err(|_| AppError::Message("SIP-Sidecar ist blockiert".to_string()))?;

    let needs_new_child = match guard.as_mut() {
        Some(client) => client
            .child
            .try_wait()
            .map(|status| status.is_some())
            .unwrap_or(true),
        None => true,
    };
    if needs_new_child {
        *guard = Some(start_sip_sidecar()?);
    }

    let client = guard
        .as_mut()
        .ok_or_else(|| AppError::Message("SIP-Sidecar ist nicht aktiv".to_string()))?;
    let request = serde_json::to_string(&command).map_err(|error| {
        AppError::Message(format!(
            "SIP-Sidecar Kommando konnte nicht serialisiert werden: {error}"
        ))
    })?;
    if let Err(error) = writeln!(client.stdin, "{request}").and_then(|_| client.stdin.flush()) {
        *guard = None;
        return Err(AppError::Message(format!(
            "SIP-Sidecar Kommando fehlgeschlagen: {error}"
        )));
    }

    let mut response = String::new();
    match client.stdout.read_line(&mut response) {
        Ok(0) => {
            *guard = None;
            Err(AppError::Message(
                "SIP-Sidecar wurde ohne Antwort beendet".to_string(),
            ))
        }
        Ok(_) => serde_json::from_str::<SipSidecarReply>(&response).map_err(|error| {
            AppError::Message(format!("SIP-Sidecar Antwort ist unlesbar: {error}"))
        }),
        Err(error) => {
            *guard = None;
            Err(AppError::Message(format!(
                "SIP-Sidecar Antwort fehlgeschlagen: {error}"
            )))
        }
    }
}

fn sidecar_reply(command: SipSidecarCommand) -> SipSidecarReply {
    match command {
        SipSidecarCommand::Register {
            sip_server,
            sip_extension,
            sip_auth_user,
            display_name,
            password,
        } => match sip_register_linphone(
            &sip_server,
            &sip_extension,
            &sip_auth_user,
            &display_name,
            &password,
        ) {
            Ok(status) => SipSidecarReply::Status { status },
            Err(error) => SipSidecarReply::Error {
                message: error.to_string(),
            },
        },
        SipSidecarCommand::Status => match sip_status() {
            Ok(snapshot) => SipSidecarReply::Snapshot { snapshot },
            Err(error) => SipSidecarReply::Error {
                message: error.to_string(),
            },
        },
        SipSidecarCommand::Dial {
            number,
            sip_server,
            sip_extension,
        } => match sip_dial(number, sip_server, sip_extension) {
            Ok(status) => SipSidecarReply::Status { status },
            Err(error) => SipSidecarReply::Error {
                message: error.to_string(),
            },
        },
        SipSidecarCommand::Hangup => match sip_hangup() {
            Ok(status) => SipSidecarReply::Status { status },
            Err(error) => SipSidecarReply::Error {
                message: error.to_string(),
            },
        },
        SipSidecarCommand::Hold => match sip_hold() {
            Ok(status) => SipSidecarReply::Status { status },
            Err(error) => SipSidecarReply::Error {
                message: error.to_string(),
            },
        },
        SipSidecarCommand::Mute { muted } => match sip_mute(muted) {
            Ok(status) => SipSidecarReply::Status { status },
            Err(error) => SipSidecarReply::Error {
                message: error.to_string(),
            },
        },
        SipSidecarCommand::Dtmf { digit } => match sip_dtmf(digit) {
            Ok(status) => SipSidecarReply::Status { status },
            Err(error) => SipSidecarReply::Error {
                message: error.to_string(),
            },
        },
    }
}

pub fn run_sip_sidecar() {
    let stdin = io::stdin();
    let mut stdout = io::stdout();
    for line in stdin.lock().lines() {
        let reply = match line {
            Ok(line) => match serde_json::from_str::<SipSidecarCommand>(&line) {
                Ok(command) => sidecar_reply(command),
                Err(error) => SipSidecarReply::Error {
                    message: format!("SIP-Sidecar Kommando ist unlesbar: {error}"),
                },
            },
            Err(error) => SipSidecarReply::Error {
                message: format!("SIP-Sidecar Eingabe fehlgeschlagen: {error}"),
            },
        };
        if let Ok(serialized) = serde_json::to_string(&reply) {
            let _ = writeln!(stdout, "{serialized}");
            let _ = stdout.flush();
        }
    }
}

#[tauri::command]
fn save_secret(service: String, account: String, password: String) -> Result<(), AppError> {
    write_fallback_secret(&service, &account, &password)?;
    match keyring::Entry::new(&service, &account) {
        Ok(entry) => {
            if let Err(error) = entry.set_password(&password) {
                eprintln!("Windows Credential Manager konnte nicht speichern: {error}; App-Fallback wurde gespeichert");
                return Ok(());
            }
            match entry.get_password() {
                Ok(stored) if stored == password => Ok(()),
                Ok(_) => {
                    eprintln!("Windows Credential Manager Rueckpruefung ist fehlgeschlagen; App-Fallback wurde gespeichert");
                    Ok(())
                }
                Err(error) => {
                    eprintln!("Windows Credential Manager Rueckpruefung fehlgeschlagen: {error}; App-Fallback wurde gespeichert");
                    Ok(())
                }
            }
        }
        Err(error) => {
            eprintln!("Windows Credential Manager nicht verfuegbar: {error}; App-Fallback wurde gespeichert");
            Ok(())
        }
    }
}

#[tauri::command]
fn has_secret(service: String, account: String) -> Result<bool, AppError> {
    if keyring_secret(&service, &account)?.is_some() {
        return Ok(true);
    }
    Ok(read_fallback_secret(&service, &account)?.is_some())
}

#[tauri::command]
fn get_secret(service: String, account: String) -> Result<Option<String>, AppError> {
    if let Some(password) = keyring_secret(&service, &account)? {
        return Ok(Some(password));
    }
    read_fallback_secret(&service, &account)
}

#[tauri::command]
fn sync_carddav(
    url: String,
    username: String,
    password: Option<String>,
) -> Result<CardDavSyncResult, AppError> {
    let password = stored_or_supplied_secret(CARDDAV_SERVICE, &username, password)?;
    let auth = base64::engine::general_purpose::STANDARD.encode(format!("{username}:{password}"));
    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(20))
        .user_agent("NIVAKO Softphone CardDAV")
        .build()?;

    let candidates = carddav_candidate_urls(&url, &username);
    let mut tried = Vec::new();
    for candidate in &candidates {
        tried.push(candidate.clone());
        if let Some(xml) = report_carddav_url(&client, candidate, &auth)? {
            let vcard_count = xml.matches("BEGIN:VCARD").count();
            return Ok(CardDavSyncResult {
                xml,
                url: candidate.clone(),
                vcard_count,
                tried,
            });
        }
    }

    Err(AppError::Message(format!(
        "CardDAV hat unter keiner getesteten Adresse Kontakte geliefert: {}",
        tried.join(", ")
    )))
}

#[tauri::command]
fn sip_register(
    sip_server: String,
    sip_extension: String,
    sip_auth_user: String,
    display_name: String,
    password: Option<String>,
) -> Result<NativeSipStatus, AppError> {
    let password = stored_or_supplied_secret(SIP_SERVICE, &sip_extension, password)?;
    if !is_sip_sidecar_process() {
        return match sip_sidecar_call(SipSidecarCommand::Register {
            sip_server: sip_server.clone(),
            sip_extension: sip_extension.clone(),
            sip_auth_user: sip_auth_user.clone(),
            display_name: display_name.clone(),
            password: password.clone(),
        }) {
            Ok(SipSidecarReply::Status { status }) => {
                set_sip_snapshot(NativeSipSnapshot {
                    registered: status.registered,
                    call_state: "idle".to_string(),
                    provider: "liblinphone-sidecar".to_string(),
                    message: status.message.clone(),
                    held: false,
                    muted: false,
                });
                Ok(status)
            }
            Ok(SipSidecarReply::Error { message }) => {
                let diagnostic = sip_register_udp(
                    &sip_server,
                    &sip_extension,
                    &sip_auth_user,
                    &display_name,
                    &password,
                )
                .map(|status| status.message)
                .unwrap_or_else(|error| format!("UDP-Diagnose ebenfalls fehlgeschlagen: {error}"));
                let message = format!(
                    "REGISTER-Diagnose: {diagnostic} Nativer Call-Core nicht aktiv: {message}"
                );
                set_sip_snapshot(NativeSipSnapshot {
                    registered: false,
                    call_state: "idle".to_string(),
                    provider: "liblinphone-sidecar".to_string(),
                    message: message.clone(),
                    held: false,
                    muted: false,
                });
                Ok(NativeSipStatus {
                    registered: false,
                    message,
                })
            }
            Ok(SipSidecarReply::Snapshot { snapshot }) => Ok(NativeSipStatus {
                registered: snapshot.registered,
                message: snapshot.message,
            }),
            Err(error) => {
                let diagnostic = sip_register_udp(
                    &sip_server,
                    &sip_extension,
                    &sip_auth_user,
                    &display_name,
                    &password,
                )
                .map(|status| status.message)
                .unwrap_or_else(|udp_error| {
                    format!("UDP-Diagnose ebenfalls fehlgeschlagen: {udp_error}")
                });
                let message = format!("SIP-Sidecar Fehler: {error}. {diagnostic}");
                set_sip_snapshot(NativeSipSnapshot {
                    registered: false,
                    call_state: "idle".to_string(),
                    provider: "liblinphone-sidecar".to_string(),
                    message: message.clone(),
                    held: false,
                    muted: false,
                });
                Ok(NativeSipStatus {
                    registered: false,
                    message: format!(
                        "REGISTER-Diagnose: {diagnostic} Nativer Call-Core nicht aktiv: {error}"
                    ),
                })
            }
        };
    }

    if is_sip_sidecar_process()
        || std::env::var("NIVAKO_ENABLE_LIBLINPHONE").ok().as_deref() == Some("1")
    {
        return match sip_register_linphone(
            &sip_server,
            &sip_extension,
            &sip_auth_user,
            &display_name,
            &password,
        ) {
            Ok(status) => Ok(status),
            Err(linphone_error) => {
                let udp_status = sip_register_udp(
                    &sip_server,
                    &sip_extension,
                    &sip_auth_user,
                    &display_name,
                    &password,
                )?;
                let message = format!(
                    "{} liblinphone-Core nicht aktiv: {linphone_error}",
                    udp_status.message
                );
                set_sip_snapshot(NativeSipSnapshot {
                    registered: false,
                    call_state: "idle".to_string(),
                    provider: "udp-diagnostic".to_string(),
                    message: message.clone(),
                    held: false,
                    muted: false,
                });
                Ok(NativeSipStatus {
                    registered: false,
                    message,
                })
            }
        };
    }

    let udp_status = sip_register_udp(
        &sip_server,
        &sip_extension,
        &sip_auth_user,
        &display_name,
        &password,
    )?;
    let message = format!(
        "{} App-Core stabilisiert: liblinphone wird in diesem Build nicht automatisch geladen.",
        udp_status.message
    );
    set_sip_snapshot(NativeSipSnapshot {
        registered: false,
        call_state: "idle".to_string(),
        provider: "udp-diagnostic".to_string(),
        message: message.clone(),
        held: false,
        muted: false,
    });
    Ok(NativeSipStatus {
        registered: false,
        message,
    })
}

#[tauri::command]
fn sip_status() -> Result<NativeSipSnapshot, AppError> {
    if !is_sip_sidecar_process() {
        if let Ok(SipSidecarReply::Snapshot { snapshot }) =
            sip_sidecar_call(SipSidecarCommand::Status)
        {
            set_sip_snapshot(snapshot.clone());
            return Ok(snapshot);
        }
    }
    if let Some(snapshot) = refresh_sip_snapshot_from_session("Native SIP aktiv.".to_string()) {
        return Ok(snapshot);
    }
    SIP_SNAPSHOT
        .lock()
        .map(|guard| guard.clone())
        .map_err(|_| AppError::Message("SIP-Status ist blockiert".to_string()))
}

#[tauri::command]
fn sip_dial(
    number: String,
    sip_server: String,
    sip_extension: String,
) -> Result<NativeSipStatus, AppError> {
    if !is_sip_sidecar_process() {
        return match sip_sidecar_call(SipSidecarCommand::Dial {
            number,
            sip_server,
            sip_extension,
        })? {
            SipSidecarReply::Status { status } => Ok(status),
            SipSidecarReply::Error { message } => Err(AppError::Message(message)),
            SipSidecarReply::Snapshot { snapshot } => Ok(NativeSipStatus {
                registered: snapshot.registered,
                message: snapshot.message,
            }),
        };
    }

    with_session(|session| {
        if session.sip_server != sip_server || session.sip_extension != sip_extension {
            return Err(AppError::Message(
                "SIP-Registrierung passt nicht zu den aktuellen Einstellungen".to_string(),
            ));
        }

        let domain = normalize_domain(&sip_server);
        let target = if number.starts_with("sip:") || number.starts_with("sips:") {
            number.clone()
        } else {
            format!("sip:{}@{}", number.trim(), domain)
        };
        let c_target = cstring(&target, "Zielnummer")?;
        let address = unsafe { linphone_address_new(c_target.as_ptr()) };
        if address.is_null() {
            return Err(AppError::Message(format!("Ungueltiges SIP-Ziel: {target}")));
        }
        let call = unsafe {
            let call = linphone_core_invite_address(session.core, address);
            linphone_address_unref(address);
            call
        };
        tick_core_for(session.core, 10, 100);
        let (_registered, state_label) = registration_state(session.proxy);
        if call.is_null() {
            return Err(AppError::Message(format!(
                "Anruf konnte nicht gestartet werden. SIP-Status: {state_label}"
            )));
        }
        let snapshot = session_snapshot(
            session,
            format!(
                "Nativer Anruf gestartet: {} -> {number}.",
                session.sip_extension
            ),
        );
        set_sip_snapshot(snapshot.clone());
        Ok(NativeSipStatus {
            registered: snapshot.registered,
            message: snapshot.message,
        })
    })
}

#[tauri::command]
fn sip_hangup() -> Result<NativeSipStatus, AppError> {
    if !is_sip_sidecar_process() {
        return match sip_sidecar_call(SipSidecarCommand::Hangup)? {
            SipSidecarReply::Status { status } => Ok(status),
            SipSidecarReply::Error { message } => Err(AppError::Message(message)),
            SipSidecarReply::Snapshot { snapshot } => Ok(NativeSipStatus {
                registered: snapshot.registered,
                message: snapshot.message,
            }),
        };
    }

    with_session(|session| {
        unsafe { linphone_core_terminate_all_calls(session.core) };
        tick_core_for(session.core, 5, 80);
        session.held = false;
        let snapshot = session_snapshot(session, "Anruf beendet.".to_string());
        set_sip_snapshot(snapshot.clone());
        Ok(NativeSipStatus {
            registered: snapshot.registered,
            message: snapshot.message,
        })
    })
}

#[tauri::command]
fn sip_hold() -> Result<NativeSipStatus, AppError> {
    if !is_sip_sidecar_process() {
        return match sip_sidecar_call(SipSidecarCommand::Hold)? {
            SipSidecarReply::Status { status } => Ok(status),
            SipSidecarReply::Error { message } => Err(AppError::Message(message)),
            SipSidecarReply::Snapshot { snapshot } => Ok(NativeSipStatus {
                registered: snapshot.registered,
                message: snapshot.message,
            }),
        };
    }

    with_session(|session| {
        let call = unsafe { linphone_core_get_current_call(session.core) };
        if call.is_null() {
            return Err(AppError::Message(
                "Kein aktiver Anruf zum Halten".to_string(),
            ));
        }
        let status = if session.held {
            unsafe { linphone_core_resume_call(session.core, call) }
        } else {
            unsafe { linphone_core_pause_call(session.core, call) }
        };
        if status != 0 {
            return Err(AppError::Message(
                "Halten/Fortsetzen wurde von liblinphone abgelehnt".to_string(),
            ));
        }
        session.held = !session.held;
        tick_core_for(session.core, 5, 80);
        let snapshot = session_snapshot(
            session,
            if session.held {
                "Anruf gehalten.".to_string()
            } else {
                "Anruf fortgesetzt.".to_string()
            },
        );
        set_sip_snapshot(snapshot.clone());
        Ok(NativeSipStatus {
            registered: snapshot.registered,
            message: snapshot.message,
        })
    })
}

#[tauri::command]
fn sip_mute(muted: bool) -> Result<NativeSipStatus, AppError> {
    if !is_sip_sidecar_process() {
        return match sip_sidecar_call(SipSidecarCommand::Mute { muted })? {
            SipSidecarReply::Status { status } => Ok(status),
            SipSidecarReply::Error { message } => Err(AppError::Message(message)),
            SipSidecarReply::Snapshot { snapshot } => Ok(NativeSipStatus {
                registered: snapshot.registered,
                message: snapshot.message,
            }),
        };
    }

    with_session(|session| {
        unsafe { linphone_core_enable_mic(session.core, if muted { 0 } else { 1 }) };
        session.muted = muted;
        tick_core_for(session.core, 2, 60);
        let snapshot = session_snapshot(
            session,
            if muted {
                "Mikrofon stumm.".to_string()
            } else {
                "Mikrofon aktiv.".to_string()
            },
        );
        set_sip_snapshot(snapshot.clone());
        Ok(NativeSipStatus {
            registered: snapshot.registered,
            message: snapshot.message,
        })
    })
}

#[tauri::command]
fn sip_dtmf(digit: String) -> Result<NativeSipStatus, AppError> {
    if !is_sip_sidecar_process() {
        return match sip_sidecar_call(SipSidecarCommand::Dtmf { digit })? {
            SipSidecarReply::Status { status } => Ok(status),
            SipSidecarReply::Error { message } => Err(AppError::Message(message)),
            SipSidecarReply::Snapshot { snapshot } => Ok(NativeSipStatus {
                registered: snapshot.registered,
                message: snapshot.message,
            }),
        };
    }

    with_session(|session| {
        let call = unsafe { linphone_core_get_current_call(session.core) };
        if call.is_null() {
            return Err(AppError::Message(
                "Kein aktiver Anruf fuer DTMF".to_string(),
            ));
        }
        let dtmf = digit
            .chars()
            .next()
            .ok_or_else(|| AppError::Message("DTMF-Zeichen fehlt".to_string()))?;
        let status = unsafe { linphone_call_send_dtmf(call, dtmf as c_char) };
        if status != 0 {
            return Err(AppError::Message(
                "DTMF wurde von liblinphone abgelehnt".to_string(),
            ));
        }
        tick_core_for(session.core, 2, 60);
        let snapshot = session_snapshot(session, format!("DTMF gesendet: {dtmf}."));
        set_sip_snapshot(snapshot.clone());
        Ok(NativeSipStatus {
            registered: snapshot.registered,
            message: snapshot.message,
        })
    })
}

pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            save_secret,
            has_secret,
            get_secret,
            sync_carddav,
            sip_register,
            sip_status,
            sip_dial,
            sip_hangup,
            sip_hold,
            sip_mute,
            sip_dtmf
        ])
        .run(tauri::generate_context!())
        .expect("error while running NIVAKO Softphone");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_digest_challenge_with_quoted_commas() {
        let challenge = parse_digest_challenge(
            "Digest realm=\"asterisk\", nonce=\"abc123\", qop=\"auth,auth-int\", algorithm=MD5",
        );

        assert_eq!(challenge.get("realm").map(String::as_str), Some("asterisk"));
        assert_eq!(challenge.get("nonce").map(String::as_str), Some("abc123"));
        assert_eq!(
            challenge.get("qop").map(String::as_str),
            Some("auth,auth-int")
        );
        assert_eq!(challenge.get("algorithm").map(String::as_str), Some("MD5"));
    }

    #[test]
    fn sip_auth_candidates_include_extension_and_full_user() {
        assert_eq!(
            sip_auth_user_candidates("101", "pbx.nivako.de"),
            vec!["101".to_string(), "101@pbx.nivako.de".to_string()]
        );
    }
}
