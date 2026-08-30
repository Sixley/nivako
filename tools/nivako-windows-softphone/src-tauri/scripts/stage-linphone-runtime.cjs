const fs = require("fs");
const path = require("path");

if (process.platform !== "win32") {
  process.exit(0);
}

const appRoot = process.cwd();
const src = path.join(appRoot, "src-tauri", "linphone-runtime");
const dest = path.join(appRoot, "src-tauri", "target", "release");

if (!fs.existsSync(src)) {
  throw new Error(`Linphone runtime directory is missing: ${src}`);
}

fs.mkdirSync(dest, { recursive: true });

const dlls = fs.readdirSync(src).filter((name) => name.toLowerCase().endsWith(".dll"));
if (dlls.length === 0) {
  throw new Error(`No Linphone runtime DLLs found in ${src}`);
}

for (const dll of dlls) {
  fs.copyFileSync(path.join(src, dll), path.join(dest, dll));
}

function copyDir(source, target) {
  if (!fs.existsSync(source)) return;
  fs.mkdirSync(target, { recursive: true });
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    const sourcePath = path.join(source, entry.name);
    const targetPath = path.join(target, entry.name);
    if (entry.isDirectory()) {
      copyDir(sourcePath, targetPath);
    } else {
      fs.copyFileSync(sourcePath, targetPath);
    }
  }
}

copyDir(path.join(src, "lib"), path.join(dest, "lib"));
copyDir(path.join(src, "share"), path.join(dest, "share"));
copyDir(path.join(appRoot, "src-tauri", "ringtones"), path.join(dest, "ringtones"));

if (!fs.existsSync(path.join(dest, "liblinphone.dll"))) {
  throw new Error("liblinphone.dll was not copied next to nivako-softphone.exe");
}

const wasapiPlugin = path.join(dest, "lib", "mediastreamer", "plugins", "libmswasapi.dll");
if (!fs.existsSync(wasapiPlugin)) {
  throw new Error("libmswasapi.dll was not copied into lib/mediastreamer/plugins");
}

console.log(`Staged ${dlls.length} Linphone runtime DLLs and plugin resources next to the release executable.`);
