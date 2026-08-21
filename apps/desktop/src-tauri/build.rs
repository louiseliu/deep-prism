fn main() {
    // Embed ZOTERO credentials at compile time from .env file or system env
    let _ = dotenvy::dotenv(); // load .env if present (local dev)
    for key in ["ZOTERO_CONSUMER_KEY", "ZOTERO_CONSUMER_SECRET"] {
        if let Ok(val) = std::env::var(key) {
            println!("cargo:rustc-env={key}={val}");
        }
    }

    // On macOS, ensure ICU libraries are found by the linker.
    // Required when icu4c is installed via Homebrew and not in system paths.
    // We pass -L early via rustc-link-arg so the linker sees the search path
    // before encountering -licuuc emitted by tectonic_bridge_icu.
    #[cfg(target_os = "macos")]
    {
        if let Ok(output) = std::process::Command::new("pkg-config")
            .args(["--variable=libdir", "icu-uc"])
            .output()
        {
            let path = String::from_utf8_lossy(&output.stdout).trim().to_string();
            if !path.is_empty() {
                println!("cargo:rustc-link-arg=-L{path}");
            }
        }
    }

    // On Linux, apply a version script to hide statically linked ICU/HarfBuzz/
    // FreeType/Fontconfig symbols from the dynamic symbol table.  This prevents
    // symbol collisions with the system copies loaded by WebKit2GTK (segfault).
    // See: https://github.com/delibae/claude-prism/issues/100
    #[cfg(target_os = "linux")]
    {
        let manifest_dir = std::env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR");
        println!(
            "cargo:rustc-link-arg=-Wl,--version-script={}/symbols.map",
            manifest_dir
        );
        println!("cargo:rerun-if-changed=symbols.map");
    }

    tauri_build::build()
}
