#!/usr/bin/env python3
import json
import pathlib
import re
import shutil
import sys

ROOT = pathlib.Path(__file__).resolve().parents[1]
PROFILES = ROOT / 'branding' / 'nivako' / 'profiles.json'

TARGETS = {
    'runner_rc': ROOT / 'flutter' / 'windows' / 'runner' / 'Runner.rc',
    'runner_main': ROOT / 'flutter' / 'windows' / 'runner' / 'main.cpp',
    'windows_cmake': ROOT / 'flutter' / 'windows' / 'CMakeLists.txt',
    'portable_cargo': ROOT / 'libs' / 'portable' / 'Cargo.toml',
    'app_config': ROOT / 'libs' / 'hbb_common' / 'src' / 'config.rs',
    'branding_icon': ROOT / 'branding' / 'nivako' / 'assets' / 'app_icon.ico',
    'runner_icon': ROOT / 'flutter' / 'windows' / 'runner' / 'resources' / 'app_icon.ico',
    'portable_icon': ROOT / 'res' / 'icon.ico',
    'flutter_asset_icon': ROOT / 'flutter' / 'assets' / 'icon.ico',
    'flutter_asset_png': ROOT / 'flutter' / 'assets' / 'icon.png',
    'portable_png': ROOT / 'res' / 'icon.png',
}


def replace_regex(path: pathlib.Path, pattern: str, replacement: str):
    text = path.read_text(encoding='utf-8')
    new_text, count = re.subn(pattern, lambda _m: replacement, text, flags=re.MULTILINE)
    if count < 1:
        raise RuntimeError(f'No match for pattern in {path}: {pattern}')
    path.write_text(new_text, encoding='utf-8')


def copy_branding_icon():
    source = TARGETS['branding_icon']
    if not source.exists():
        raise RuntimeError(f'Branding icon not found: {source}')
    for key in ('runner_icon', 'portable_icon', 'flutter_asset_icon'):
        target = TARGETS[key]
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(source, target)

    png_bytes = extract_largest_png_from_ico(source)
    for key in ('flutter_asset_png', 'portable_png'):
        target = TARGETS[key]
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(png_bytes)


def extract_largest_png_from_ico(path: pathlib.Path) -> bytes:
    data = path.read_bytes()
    if len(data) < 6:
        raise RuntimeError(f'Invalid ICO header in {path}')

    _reserved, icon_type, count = int.from_bytes(data[0:2], 'little'), int.from_bytes(data[2:4], 'little'), int.from_bytes(data[4:6], 'little')
    if icon_type != 1 or count < 1:
        raise RuntimeError(f'Unsupported ICO content in {path}')

    best_blob = None
    best_area = -1
    for index in range(count):
        entry = data[6 + index * 16: 6 + (index + 1) * 16]
        if len(entry) != 16:
            raise RuntimeError(f'Truncated ICO directory entry in {path}')
        width = entry[0] or 256
        height = entry[1] or 256
        size = int.from_bytes(entry[8:12], 'little')
        offset = int.from_bytes(entry[12:16], 'little')
        blob = data[offset:offset + size]
        if blob.startswith(b'\x89PNG\r\n\x1a\n'):
            area = width * height
            if area > best_area:
                best_area = area
                best_blob = blob

    if best_blob is None:
        raise RuntimeError(f'No PNG frame found in {path}')
    return best_blob


def main():
    if len(sys.argv) != 2:
        print('Usage: tools/apply_nivako_branding.py <quicksupport|remote>', file=sys.stderr)
        sys.exit(1)

    profile_name = sys.argv[1].strip().lower()
    profiles = json.loads(PROFILES.read_text(encoding='utf-8'))
    if profile_name not in profiles:
        print(f'Unknown profile: {profile_name}', file=sys.stderr)
        sys.exit(1)
    p = profiles[profile_name]

    replace_regex(
        TARGETS['runner_rc'],
        r'VALUE "FileDescription", ".*?" "\\0"',
        f'VALUE "FileDescription", "{p["file_description"]}" "\\0"',
    )
    replace_regex(
        TARGETS['runner_rc'],
        r'VALUE "InternalName", ".*?" "\\0"',
        f'VALUE "InternalName", "{p["binary_name"]}" "\\0"',
    )
    replace_regex(
        TARGETS['runner_rc'],
        r'VALUE "OriginalFilename", ".*?" "\\0"',
        f'VALUE "OriginalFilename", "{p["original_filename"]}" "\\0"',
    )
    replace_regex(
        TARGETS['runner_rc'],
        r'VALUE "ProductName", ".*?" "\\0"',
        f'VALUE "ProductName", "{p["product_name"]}" "\\0"',
    )

    replace_regex(
        TARGETS['runner_main'],
        r'std::wstring app_name = L".*?";',
        f'std::wstring app_name = L"{p["app_name"]}";',
    )

    replace_regex(
        TARGETS['windows_cmake'],
        r'set\(BINARY_NAME ".*?"\)',
        f'set(BINARY_NAME "{p["binary_name"]}")',
    )

    replace_regex(
        TARGETS['portable_cargo'],
        r'^description = ".*?"$',
        f'description = "{p["portable_description"]}"',
    )
    replace_regex(
        TARGETS['portable_cargo'],
        r'^ProductName = ".*?"$',
        f'ProductName = "{p["product_name"]}"',
    )
    replace_regex(
        TARGETS['portable_cargo'],
        r'^OriginalFilename = ".*?"$',
        f'OriginalFilename = "{p["original_filename"]}"',
    )
    replace_regex(
        TARGETS['portable_cargo'],
        r'^FileDescription = ".*?"$',
        f'FileDescription = "{p["file_description"]}"',
    )

    replace_regex(
        TARGETS['app_config'],
        r'pub static ref APP_NAME: RwLock<String> = RwLock::new\(".*?"\.to_owned\(\)\);',
        f'pub static ref APP_NAME: RwLock<String> = RwLock::new("{p["app_name"]}".to_owned());',
    )

    copy_branding_icon()

    print(f'Applied NIVAKO branding profile: {profile_name}')


if __name__ == '__main__':
    main()
