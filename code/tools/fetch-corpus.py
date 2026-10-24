"""Fetches the public SysML v2 corpus used in the evaluation and verifies it file by file.

usage: python -B fetch-corpus.py [--repo <existing clone>] [--dest <code dir>] [--manifest <file>] [--release-only]

The artifact does not redistribute the third-party corpus. corpus-manifest.json (next to this script's
parent directory by default) records, for every file the experiments read, its path and SHA-256:

  corpus/SysML-v2-Release/...        tag 2026-08 of https://github.com/Systems-Modeling/SysML-v2-Release
  corpus-history/tags/<tag>/...      the same directories for each of the 43 release tags (edit history, E5)

Steps: clone the repository (or use --repo), export each tag with `git archive` (core.autocrlf=false),
write every listed file below --dest (default: the code directory that contains this script's tools/), and
check its SHA-256. The experiments read a Windows checkout, so text files were stored with CRLF line ends;
a file whose repository bytes do not match is converted LF -> CRLF and checked again. Nothing else is
modified, and existing files are not overwritten unless they already have the recorded hash.
Requires git and Python 3.8+ (standard library only). Exit code 0 only if every listed file verifies.
"""
import hashlib
import io
import json
import os
import subprocess
import sys
import tarfile
import tempfile

URL = 'https://github.com/Systems-Modeling/SysML-v2-Release'


def sha(b):
    return hashlib.sha256(b).hexdigest()


def git(repo, *args):
    return subprocess.run(['git', '-C', repo, '-c', 'core.autocrlf=false', *args], check=True,
                          stdout=subprocess.PIPE).stdout


def main():
    a = sys.argv[1:]
    here = os.path.dirname(os.path.abspath(__file__))
    dest = os.path.abspath(a[a.index('--dest') + 1]) if '--dest' in a else os.path.dirname(here)
    man_path = a[a.index('--manifest') + 1] if '--manifest' in a else os.path.join(dest, 'corpus-manifest.json')
    with open(man_path, encoding='utf-8') as f:
        man = json.load(f)
    if '--repo' in a:
        repo = os.path.abspath(a[a.index('--repo') + 1])
    else:
        repo = os.path.join(tempfile.mkdtemp(prefix='sysml-v2-release-'), 'repo')
        subprocess.run(['git', 'clone', '--quiet', '--no-checkout', man.get('source', URL), repo], check=True)
    targets = man['targets'][:1] if '--release-only' in a else man['targets']
    report = {'targets': 0, 'files': 0, 'verified': 0, 'crlfConverted': 0, 'missing': [], 'mismatch': [], 'refMismatch': []}
    for t in targets:
        report['targets'] += 1
        rev = git(repo, 'rev-parse', 'refs/tags/' + t['tag']).decode().strip()
        if t.get('ref') and rev != t['ref']:
            report['refMismatch'].append({'tag': t['tag'], 'recorded': t['ref'], 'repository': rev})
            continue
        tops = sorted({p.split('/')[0] for p in t['files']})
        tar = tarfile.open(fileobj=io.BytesIO(git(repo, 'archive', '--format=tar', rev, '--', *tops)))
        members = {m.name: m for m in tar.getmembers() if m.isfile()}
        for rel, want in sorted(t['files'].items()):
            report['files'] += 1
            m = members.get(rel)
            if m is None:
                report['missing'].append(t['dest'] + '/' + rel)
                continue
            data = tar.extractfile(m).read()
            if sha(data) != want:
                conv = data.replace(b'\r\n', b'\n').replace(b'\n', b'\r\n')
                if sha(conv) == want:
                    data = conv
                    report['crlfConverted'] += 1
                else:
                    report['mismatch'].append(t['dest'] + '/' + rel)
                    continue
            out = os.path.join(dest, *t['dest'].split('/'), *rel.split('/'))
            if os.path.exists(out):
                with open(out, 'rb') as f:
                    if sha(f.read()) != want:
                        report['mismatch'].append(t['dest'] + '/' + rel + ' (existing file differs; not overwritten)')
                        continue
            else:
                os.makedirs(os.path.dirname(out), exist_ok=True)
                with open(out, 'wb') as f:
                    f.write(data)
            report['verified'] += 1
    ok = report['verified'] == report['files'] and not report['refMismatch']
    print(json.dumps({**report, 'missing': report['missing'][:20], 'mismatch': report['mismatch'][:20], 'ok': ok}, indent=1))
    sys.exit(0 if ok else 1)


if __name__ == '__main__':
    main()
