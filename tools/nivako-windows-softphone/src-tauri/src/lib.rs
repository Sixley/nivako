use base64::Engine;
use once_cell::sync::Lazy;
use serde::Serialize;
use std::ffi::{CStr, CString};
use std::os::raw::{c_char, c_int, c_void};
use std::ptr;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

const CARDDAV_SERVICE: &str = "NIVAKO Softphone CardDAV";
const SIP_SERVICE: &str = "NIVAKO Softphone SIP";

#[derive(Debug, Serialize)]
struct NativeSipStatus {
    registered: bool,
    message: String,
}

type LinphoneCore = c_void;
type LinphoneCall = c_void;
type LinphoneAddress = c_void;
type LinphoneAuthInfo = c_void;
type LinphoneProxyConfig = c_void;

#[allow(non_camel_case_types)]
type bool_t = c_int;

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
    fn linphone_proxy_config_enable_register(proxy_config: *mut LinphoneProxyConfig, enable: bool_t);
    fn linphone_core_add_proxy_config(core: *mut LinphoneCore, config: *mut LinphoneProxyConfig) -> c_int;
    fn linphone_core_set_default_proxy_config(core: *mut LinphoneCore, config: *mut LinphoneProxyConfig);
    fn linphone_proxy_config_get_state(proxy_config: *const LinphoneProxyConfig) -> c_int;
    fn linphone_registration_state_to_string(state: c_int) -> *const c_char;
    fn linphone_address_new(address: *const c_char) -> *mut LinphoneAddress;
    fn linphone_address_unref(address: *mut LinphoneAddress);
    fn linphone_core_invite_address(core: *mut LinphoneCore, address: *const LinphoneAddress) -> *mut LinphoneCall;
    fn linphone_core_get_current_call(core: *const LinphoneCore) -> *mut LinphoneCall;
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

static SIP_SESSION: Lazy<Arc<Mutex<Option<LinphoneSession>>>> = Lazy::new(|| Arc::new(Mutex::new(None)));
static SIP_WORKER_STARTED: AtomicBool = AtomicBool::new(false);

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
    CString::new(value).map_err(|_| AppError::Message(format!("{field} enthaelt ungueltige Null-Bytes")))
}

fn c_string_or_empty(ptr: *const c_char) -> String {
    if ptr.is_null() {
        return String::new();
    }
    unsafe { CStr::from_ptr(ptr).to_string_lossy().into_owned() }
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

fn registration_state(proxy: *mut LinphoneProxyConfig) -> (bool, String) {
    let state = unsafe { linphone_proxy_config_get_state(proxy) };
    let label = c_string_or_empty(unsafe { linphone_registration_state_to_string(state) });
    (state == 2, label)
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

fn with_session<T>(action: impl FnOnce(&mut LinphoneSession) -> Result<T, AppError>) -> Result<T, AppError> {
    let mut guard = SIP_SESSION
        .lock()
        .map_err(|_| AppError::Message("SIP-Sitzung ist blockiert".to_string()))?;
    let session = guard
        .as_mut()
        .ok_or_else(|| AppError::Message("SIP ist nicht registriert".to_string()))?;
    action(session)
}

fn stored_or_supplied_secret(service: &str, account: &str, supplied: Option<String>) -> Result<String, AppError> {
    if let Some(password) = supplied.filter(|value| !value.is_empty()) {
        return Ok(password);
    }
    keyring::Entry::new(service, account)?.get_password().map_err(AppError::from)
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
        candidates.push(direct.replace(&format!("/users/{username}/"), &format!("/users/{lower_user}/")));
    }

    if let Ok(parsed) = reqwest::Url::parse(&direct) {
        let origin = parsed.origin().ascii_serialization();
        for user in [username.to_string(), lower_user.clone()] {
            for book in ["nivako-crm", "contacts", "kontakte"] {
                candidates.push(format!("{origin}/remote.php/dav/addressbooks/users/{user}/{book}/"));
            }
        }
    }

    candidates.dedup();
    candidates
}

fn report_carddav_url(client: &reqwest::blocking::Client, url: &str, auth: &str) -> Result<Option<String>, AppError> {
    let method = reqwest::Method::from_bytes(b"REPORT").map_err(|error| AppError::Message(error.to_string()))?;
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
        return Err(AppError::Message(format!("CardDAV HTTP {status}: Zugangsdaten abgelehnt")));
    }
    Ok(None)
}

#[tauri::command]
fn save_secret(service: String, account: String, password: String) -> Result<(), AppError> {
    let entry = keyring::Entry::new(&service, &account)?;
    entry.set_password(&password)?;
    let stored = entry.get_password()?;
    if stored != password {
        return Err(AppError::Message("Credential wurde gespeichert, aber die Rueckpruefung ist fehlgeschlagen".to_string()));
    }
    Ok(())
}

#[tauri::command]
fn has_secret(service: String, account: String) -> Result<bool, AppError> {
    match keyring::Entry::new(&service, &account)?.get_password() {
        Ok(_) => Ok(true),
        Err(keyring::Error::NoEntry) => Ok(false),
        Err(error) => Err(error.into()),
    }
}

#[tauri::command]
fn sync_carddav(url: String, username: String, password: Option<String>) -> Result<String, AppError> {
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
            return Ok(xml);
        }
    }

    Err(AppError::Message(format!(
        "CardDAV hat unter keiner getesteten Adresse Kontakte geliefert: {}",
        tried.join(", ")
    )))
}

#[tauri::command]
fn sip_register(sip_server: String, sip_extension: String, display_name: String, password: Option<String>) -> Result<NativeSipStatus, AppError> {
    let password = stored_or_supplied_secret(SIP_SERVICE, &sip_extension, password)?;
    let domain = normalize_domain(&sip_server);
    let server_addr = normalize_sip_server(&sip_server);
    let identity = format!("sip:{sip_extension}@{domain}");
    let username = cstring(&sip_extension, "SIP-Benutzer")?;
    let passwd = cstring(&password, "SIP-Passwort")?;
    let c_domain = cstring(&domain, "SIP-Domain")?;
    let c_identity = cstring(&identity, "SIP-Identitaet")?;
    let c_server = cstring(&server_addr, "SIP-Server")?;

    let core = unsafe { linphone_core_new(ptr::null(), ptr::null(), ptr::null(), ptr::null_mut()) };
    if core.is_null() {
        return Err(AppError::Message("liblinphone Core konnte nicht erstellt werden".to_string()));
    }

    let result: Result<*mut LinphoneProxyConfig, AppError> = unsafe {
        let auth = linphone_auth_info_new(
            username.as_ptr(),
            ptr::null(),
            passwd.as_ptr(),
            ptr::null(),
            ptr::null(),
            c_domain.as_ptr(),
        );
        if auth.is_null() {
            linphone_core_unref(core);
            return Err(AppError::Message("SIP-Auth konnte nicht erstellt werden".to_string()));
        }
        linphone_core_add_auth_info(core, auth);
        linphone_auth_info_unref(auth);

        let proxy = linphone_core_create_proxy_config(core);
        if proxy.is_null() {
            linphone_core_unref(core);
            return Err(AppError::Message("SIP-Proxy konnte nicht erstellt werden".to_string()));
        }

        let address = linphone_address_new(c_identity.as_ptr());
        if address.is_null() {
            linphone_core_unref(core);
            return Err(AppError::Message(format!("Ungueltige SIP-Identitaet: {identity}")));
        }

        let identity_status = linphone_proxy_config_set_identity_address(proxy, address);
        linphone_address_unref(address);
        let server_status = linphone_proxy_config_set_server_addr(proxy, c_server.as_ptr());
        linphone_proxy_config_enable_register(proxy, 1);
        let add_status = linphone_core_add_proxy_config(core, proxy);
        linphone_core_set_default_proxy_config(core, proxy);
        let start_status = linphone_core_start(core);

        if identity_status != 0 || server_status != 0 || add_status != 0 || start_status != 0 {
            linphone_core_unref(core);
            return Err(AppError::Message("SIP-Konfiguration wurde von liblinphone abgelehnt".to_string()));
        }

        Ok(proxy)
    };

    let proxy = result?;
    let session = LinphoneSession {
        core,
        proxy,
        sip_server,
        sip_extension: sip_extension.clone(),
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
    let (registered, state_label) = with_session(|session| Ok(registration_state(session.proxy)))?;

    Ok(NativeSipStatus {
        registered,
        message: format!(
            "SIP-Registrierung geprueft: {display_name} / {sip_extension}@{domain}. Status: {state_label}"
        ),
    })
}

#[tauri::command]
fn sip_dial(number: String, sip_server: String, sip_extension: String) -> Result<NativeSipStatus, AppError> {
    with_session(|session| {
        if session.sip_server != sip_server || session.sip_extension != sip_extension {
            return Err(AppError::Message("SIP-Registrierung passt nicht zu den aktuellen Einstellungen".to_string()));
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
        let (registered, state_label) = registration_state(session.proxy);
        if call.is_null() {
            return Err(AppError::Message(format!("Anruf konnte nicht gestartet werden. SIP-Status: {state_label}")));
        }
        Ok(NativeSipStatus {
            registered,
            message: format!("Nativer Anruf gestartet: {} -> {number}. SIP-Status: {state_label}", session.sip_extension),
        })
    })
}

#[tauri::command]
fn sip_hangup() -> Result<NativeSipStatus, AppError> {
    with_session(|session| {
        unsafe { linphone_core_terminate_all_calls(session.core) };
        tick_core_for(session.core, 5, 80);
        let (registered, state_label) = registration_state(session.proxy);
        Ok(NativeSipStatus {
            registered,
            message: format!("Anruf beendet. SIP-Status: {state_label}"),
        })
    })
}

#[tauri::command]
fn sip_hold() -> Result<NativeSipStatus, AppError> {
    with_session(|session| {
        let call = unsafe { linphone_core_get_current_call(session.core) };
        if call.is_null() {
            return Err(AppError::Message("Kein aktiver Anruf zum Halten".to_string()));
        }
        let status = if session.held {
            unsafe { linphone_core_resume_call(session.core, call) }
        } else {
            unsafe { linphone_core_pause_call(session.core, call) }
        };
        if status != 0 {
            return Err(AppError::Message("Halten/Fortsetzen wurde von liblinphone abgelehnt".to_string()));
        }
        session.held = !session.held;
        tick_core_for(session.core, 5, 80);
        let (registered, state_label) = registration_state(session.proxy);
        Ok(NativeSipStatus {
            registered,
            message: if session.held {
                format!("Anruf gehalten. SIP-Status: {state_label}")
            } else {
                format!("Anruf fortgesetzt. SIP-Status: {state_label}")
            },
        })
    })
}

#[tauri::command]
fn sip_mute(muted: bool) -> Result<NativeSipStatus, AppError> {
    with_session(|session| {
        unsafe { linphone_core_enable_mic(session.core, if muted { 0 } else { 1 }) };
        session.muted = muted;
        tick_core_for(session.core, 2, 60);
        let (registered, state_label) = registration_state(session.proxy);
        Ok(NativeSipStatus {
            registered,
            message: if muted {
                format!("Mikrofon stumm. SIP-Status: {state_label}")
            } else {
                format!("Mikrofon aktiv. SIP-Status: {state_label}")
            },
        })
    })
}

#[tauri::command]
fn sip_dtmf(digit: String) -> Result<NativeSipStatus, AppError> {
    with_session(|session| {
        let call = unsafe { linphone_core_get_current_call(session.core) };
        if call.is_null() {
            return Err(AppError::Message("Kein aktiver Anruf fuer DTMF".to_string()));
        }
        let dtmf = digit
            .chars()
            .next()
            .ok_or_else(|| AppError::Message("DTMF-Zeichen fehlt".to_string()))?;
        let status = unsafe { linphone_call_send_dtmf(call, dtmf as c_char) };
        if status != 0 {
            return Err(AppError::Message("DTMF wurde von liblinphone abgelehnt".to_string()));
        }
        tick_core_for(session.core, 2, 60);
        let (registered, state_label) = registration_state(session.proxy);
        Ok(NativeSipStatus {
            registered,
            message: format!("DTMF gesendet: {dtmf}. SIP-Status: {state_label}"),
        })
    })
}

pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            save_secret,
            has_secret,
            sync_carddav,
            sip_register,
            sip_dial,
            sip_hangup,
            sip_hold,
            sip_mute,
            sip_dtmf
        ])
        .run(tauri::generate_context!())
        .expect("error while running NIVAKO Softphone");
}
