fn main() {
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows") {
        if let Ok(sdk_dir) = std::env::var("LINPHONE_SDK_DIR") {
            let candidates = [
                "lib",
                "lib64",
                "bin",
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
    }

    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows") {
        println!("cargo:rustc-link-lib=liblinphone");
    } else {
        println!("cargo:rustc-link-lib=linphone");
    }
    tauri_build::build();
}
