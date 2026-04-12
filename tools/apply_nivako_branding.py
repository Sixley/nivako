#!/usr/bin/env python3
import json
import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parents[1]
PROFILES = ROOT / 'branding' / 'nivako' / 'profiles.json'

TARGETS = {
    'runner_rc': ROOT / 'flutter' / 'windows' / 'runner' / 'Runner.rc',
    'runner_main': ROOT / 'flutter' / 'windows' / 'runner' / 'main.cpp',
    'windows_cmake': ROOT / 'flutter' / 'windows' / 'CMakeLists.txt',
    'portable_cargo': ROOT / 'libs' / 'portable' / 'Cargo.toml',
    'app_config': ROOT / 'libs' / 'hbb_common' / 'src' / 'config.rs',
}


def replace_regex(path: pathlib.Path, pattern: str, replacement: str):
    text = path.read_text(encoding='utf-8')
    new_text, count = re.subn(pattern, lambda _m: replacement, text, flags=re.MULTILINE)
    if count < 1:
        raise RuntimeError(f'No match for pattern in {path}: {pattern}')
    path.write_text(new_text, encoding='utf-8')


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

    print(f'Applied NIVAKO branding profile: {profile_name}')


if __name__ == '__main__':
    main()
