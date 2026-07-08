#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    if std::env::args().any(|arg| arg == "--nivako-sip-sidecar") {
        nivako_softphone_lib::run_sip_sidecar();
        return;
    }

    nivako_softphone_lib::run();
}
