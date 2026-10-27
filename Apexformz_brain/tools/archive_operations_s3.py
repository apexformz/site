"""Back up explicit current source inputs and operations evidence to private S3."""
import datetime as dt
import hashlib
import io
import json
import pathlib
import subprocess
import tarfile
import tempfile
from provision_s3 import aws_session


def main():
    root = pathlib.Path(__file__).resolve().parents[1]
    audit = root / 'data/audit/operations'
    subprocess.run(['node', '--import', 'tsx', '-e',
        'const {sourceInventory}=require("./tools/release_artifacts.ts"); const fs=require("fs"); '
        'fs.writeFileSync("data/audit/operations/source-inventory.json",JSON.stringify(sourceInventory(process.cwd(),true),null,2));'],
        cwd=root, check=True)
    source = json.loads((audit / 'source-inventory.json').read_text())
    names = {f['path'] for f in source['files']}
    names.update(['docs/PRODUCTION_SERVICE_OPERATIONS.md', 'infrastructure/deployment/.env.example'])
    for name in ('s3-stack-integration.json', 'legacy-baseline-review.json', 'legacy-s3-backup-and-migration.json',
                 'canary-rollback-final.json', 'release-s3-archive.json', 'source-inventory.json'):
        names.add('data/audit/operations/' + name)
    manifest = {'kind': 'operations-source-backup', 'production_eligible': False,
                'created_at': dt.datetime.now(dt.timezone.utc).isoformat(), 'source_sha256': source['sha256'], 'files': [],
                'note': 'Current source and operational evidence. Locked model binaries are in the separate engineering baseline archive. No private captures or credentials.'}
    config = json.loads((root / 'infrastructure/deployment/aws-storage.json').read_text())
    s3 = aws_session('apexformz-owner', config['region']).client('s3')
    key = 'releases/operations-source-' + source['sha256'][:16] + '.tar.gz'
    with tempfile.TemporaryDirectory(prefix='apexformz-source-') as directory:
        archive = pathlib.Path(directory) / 'source.tar.gz'
        with tarfile.open(archive, 'w:gz') as tar:
            for name in sorted(names):
                path = root / name
                if path.is_symlink() or not path.resolve().is_relative_to(root.resolve()) or not path.is_file():
                    raise ValueError('Archive input must be a regular in-workspace file')
                if path.suffix.lower() in {'.pem', '.key', '.p12', '.pfx'} or (path.name.startswith('.env') and path.name != '.env.example'):
                    raise ValueError('Secrets are not source backup inputs')
                content = path.read_bytes()
                manifest['files'].append({'path': name, 'bytes': len(content), 'sha256': hashlib.sha256(content).hexdigest()})
                info = tarfile.TarInfo('source/' + name)
                info.size = len(content)
                tar.addfile(info, io.BytesIO(content))
            content = json.dumps(manifest, indent=2).encode()
            info = tarfile.TarInfo('source/operations-source-manifest.json')
            info.size = len(content)
            tar.addfile(info, io.BytesIO(content))
        digest = hashlib.sha256(archive.read_bytes()).hexdigest()
        s3.upload_file(str(archive), config['bucket'], key, ExtraArgs={'ServerSideEncryption': 'AES256',
            'Metadata': {'sha256': digest, 'production-eligible': 'false'}})
        head = s3.head_object(Bucket=config['bucket'], Key=key)
        verified = hashlib.sha256()
        with s3.get_object(Bucket=config['bucket'], Key=key, VersionId=head['VersionId'])['Body'] as body:
            for chunk in iter(lambda: body.read(1024 * 1024), b''):
                verified.update(chunk)
        if verified.hexdigest() != digest:
            raise RuntimeError('S3 source backup checksum mismatch')
    receipt = {'status': 'passed', 'bucket': config['bucket'], 'key': key, 'version_id': head['VersionId'],
               'sha256': digest, 'source_sha256': source['sha256'], 'files': len(manifest['files']), 'bytes': head['ContentLength'],
               'production_eligible': False, 'kind': manifest['kind']}
    (audit / 'operations-source-s3-archive.json').write_text(json.dumps(receipt, indent=2) + '\n')
    print(json.dumps(receipt))


if __name__ == '__main__':
    main()
