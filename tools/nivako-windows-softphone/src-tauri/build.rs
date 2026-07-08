fn main() {
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows") {
        if let Ok(lib_dir) = std::env::var("LINPHONE_LIB_DIR") {
            let path = std::path::Path::new(&lib_dir);
            if path.exists() {
                println!("cargo:rustc-link-search=native={}", path.display());
            }
        }

        if let Ok(sdk_dir) = std::env::var("LINPHONE_SDK_DIR") {
            let candidates = [
                "lib",
                "lib64",
                "bin",
                "win64/lib",
                "win64/bin",
                "lib/Win32",
                "lib/x64",
                "lib64/Win32",
                "lib64/x64",
            ];

            for candidate in candidates {
                let path = std::path::Path::new(&sdk_dir).join(candidate);
                if path.exists() {
                    println!("cargo:rustc-link-search=native={}", path.display());
                }
            }

            if let Ok(entries) = std::fs::read_dir(&sdk_dir) {
                for entry in entries.flatten() {
                    let path = entry.path();
                    if path.is_dir() {
                        for candidate in candidates {
                            let nested = path.join(candidate);
                            if nested.exists() {
                                println!("cargo:rustc-link-search=native={}", nested.display());
                            }
                        }
                    }
                }
            }
        }
    } else {
        let runtime_dir = std::path::Path::new("linphone-runtime");
        let _ = std::fs::create_dir_all(runtime_dir);
        let _ = std::fs::write(runtime_dir.join(".cargo-check-placeholder.dll"), []);
    }

    tauri_build::build();
}
