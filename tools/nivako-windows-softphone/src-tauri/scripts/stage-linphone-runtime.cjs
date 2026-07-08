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

const shareSrc = path.join(src, "share");
if (fs.existsSync(shareSrc)) {
  fs.cpSync(shareSrc, path.join(dest, "share"), { recursive: true, force: true });
}

if (!fs.existsSync(path.join(dest, "liblinphone.dll"))) {
  throw new Error("liblinphone.dll was not copied next to nivako-softphone.exe");
}

const vcardGrammar = path.join(dest, "share", "belr", "grammars", "vcard_grammar.belr");
if (!fs.existsSync(vcardGrammar)) {
  throw new Error("BELR vCard grammar was not copied next to nivako-softphone.exe");
}

console.log(`Staged ${dlls.length} Linphone runtime DLLs and share resources next to the release executable.`);
