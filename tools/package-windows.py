"""Build a UTF-8-named ZIP and verify every archived byte against the source.

Usage: python tools/package-windows.py <project-directory> <output.zip>
Python stdlib only; not required to run the game.
"""
import hashlib
import json
from pathlib import Path
import sys
import zipfile

root = Path(sys.argv[1]).resolve()
target = Path(sys.argv[2]).resolve()
if not root.is_dir() or target.is_relative_to(root):
    raise SystemExit('Source must exist; output must be outside the project.')
excluded = {'.DS_Store', '__MACOSX', '.git', 'node_modules', '__pycache__'}
files = sorted(p for p in root.rglob('*') if p.is_file()
               and not any(part in excluded for part in p.relative_to(root).parts))
if any(p.is_symlink() for p in root.rglob('*')):
    raise SystemExit('Resolve symlinks before making a portable package.')
target.parent.mkdir(parents=True, exist_ok=True)
expected = {f'{root.name}/{p.relative_to(root).as_posix()}': p for p in files}
with zipfile.ZipFile(target, 'w', zipfile.ZIP_DEFLATED, compresslevel=6, allowZip64=True) as archive:
    for name, source in expected.items():
        archive.write(source, name)

def digest(stream):
    sha = hashlib.sha256()
    for chunk in iter(lambda: stream.read(1024 * 1024), b''):
        sha.update(chunk)
    return sha.hexdigest()

with zipfile.ZipFile(target) as archive:
    assert set(archive.namelist()) == set(expected), 'Archive file list mismatch'
    for info in archive.infolist():
        if not info.filename.isascii():
            assert info.flag_bits & 0x800, 'Unicode filename lacks UTF-8 flag'
        with archive.open(info) as packed, expected[info.filename].open('rb') as source:
            assert digest(packed) == digest(source), f'Content mismatch: {info.filename}'
with target.open('rb') as stream:
    sha = digest(stream)
target.with_suffix('.zip.sha256').write_text(f'{sha}  {target.name}\n', encoding='utf-8')
print(json.dumps({'files': len(files), 'bytes': target.stat().st_size,
                  'sha256': sha, 'utf8Names': True, 'allFileHashesMatch': True}))
