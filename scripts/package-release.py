#!/usr/bin/env python3
"""Package the source repository from explicit allowlists, never local state."""
import argparse
import hashlib
import stat
import zipfile
from pathlib import Path
parser = argparse.ArgumentParser()
parser.add_argument('--output', required=True)
args = parser.parse_args()
root = Path(__file__).resolve().parent.parent
output = Path(args.output).resolve()
output.parent.mkdir(parents=True, exist_ok=True)
root_files = {
    'package.json', 'package-lock.json', 'tsconfig.json', 'README.md', 'LICENSE',
    'CONTRIBUTING.md', 'SECURITY.md', 'CHANGELOG.md', 'THIRD_PARTY_NOTICES.md',
    '.gitignore', '.gitattributes', '.pr-slicer.example.json',
}
source_suffixes = {'src': {'.ts', '.json'}, 'test': {'.mjs', '.json', '.md'},
                   'scripts': {'.mjs', '.py'}, '.github': {'.yml', '.yaml', '.md'}}
doc_files = {'architecture.md', 'algorithm.md', 'configuration.md', 'security.md',
             'implementation-status.md'}
forbidden_parts = {'.git', 'node_modules', 'coverage', '__pycache__', '.demo', 'releases'}
allowed = set()
for name in root_files:
    allowed.add(root / name)
for directory, suffixes in source_suffixes.items():
    for file in (root / directory).rglob('*'):
        if file.suffix in suffixes:
            allowed.add(file)
allowed.update(root / 'docs' / name for name in doc_files)
# Only compiler outputs corresponding to shipped source files may enter the ZIP.
for source in (root / 'src').rglob('*.ts'):
    if not source.name.endswith('.d.ts'):
        target = root / 'dist' / source.relative_to(root / 'src').with_suffix('.js')
        allowed.update({target, target.with_suffix('.d.ts')})
allowed.update({root / 'dist/config/schema.json', root / 'dist/core/plan-schema.json'})
with zipfile.ZipFile(output, 'w', zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
    for file in sorted(allowed):
        rel = file.relative_to(root)
        if not file.is_file() or file.resolve() == output:
            continue
        if forbidden_parts.intersection(rel.parts):
            continue
        if file.is_symlink() or any(parent.is_symlink() for parent in file.parents if parent != root and root in parent.parents):
            continue
        if not file.resolve().is_relative_to(root):
            raise ValueError(f'Path escapes package root: {rel}')
        info = zipfile.ZipInfo('pr-slicer/' + rel.as_posix(), (2026, 9, 5, 0, 0, 0))
        info.compress_type = zipfile.ZIP_DEFLATED
        mode = 0o755 if rel.as_posix() == 'dist/cli/main.js' or file.stat().st_mode & 0o111 else 0o644
        info.create_system = 3
        info.external_attr = (stat.S_IFREG | mode) << 16
        archive.writestr(info, file.read_bytes())
print(f'{output.name}: {output.stat().st_size} bytes')
print('SHA256 ' + hashlib.sha256(output.read_bytes()).hexdigest())
