/** Bootstrap a local release identity only inside an already protected, empty signing directory. */
import { createHash, createPublicKey, generateKeyPairSync } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const option = name => { const i = args.indexOf(name); if (i < 0 || !args[i + 1]) throw new Error(`required: ${name}`); return args[i + 1]; };
try {
  const directory = fs.realpathSync(option('--directory'));
  const keyId = option('--key-id');
  const registryPath = path.resolve(option('--registry'));
  if (!/^[A-Za-z0-9._-]{1,80}$/.test(keyId)) throw new Error('invalid release key id');
  const privatePath = path.join(directory, `${keyId}.private.pem`);
  if (fs.readdirSync(directory).length || fs.existsSync(privatePath)) throw new Error('signing directory is not empty; existing keys are never overwritten');
  const registry = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
  if (registry.schema_version !== '1.0.0' || !Array.isArray(registry.keys) || registry.keys.length) throw new Error('bootstrap requires an empty public registry; use an explicit rotation procedure for existing roots');
  if (process.platform === 'win32') {
    const verifyAcl = `$ErrorActionPreference='Stop'; $user=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value; $acl=Get-Acl -LiteralPath $env:APEXFORMZ_KEY_DIRECTORY; $rules=@($acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])); if(-not $acl.AreAccessRulesProtected -or $rules.Count -ne 2){throw 'Signing directory must disable inherited access and have two explicit rules'}; foreach($r in $rules){if($r.IdentityReference.Value -notin @($user,'S-1-5-18') -or $r.IsInherited -or $r.AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow -or $r.FileSystemRights -ne [Security.AccessControl.FileSystemRights]::FullControl -or ($r.InheritanceFlags -band [Security.AccessControl.InheritanceFlags]::ObjectInherit) -eq 0){throw 'Signing directory must allow only current user and SYSTEM'}}`;
    try {
      execFileSync(process.env.APEXFORMZ_POWERSHELL_EXE ?? 'pwsh.exe', ['-NoProfile', '-NonInteractive', '-Command', verifyAcl], { env: { ...process.env, APEXFORMZ_KEY_DIRECTORY: directory }, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
      throw new Error(`Signing ACL preflight failed: ${String(error.stderr ?? '').split(/\r?\n/).find(Boolean) ?? 'PowerShell could not verify directory access'}`);
    }
  } else {
    const stat = fs.statSync(directory);
    if ((stat.mode & 0o077) !== 0 || stat.uid !== process.getuid()) throw new Error('signing directory must be owned by this user with mode 0700');
  }
  const { privateKey } = generateKeyPairSync('ed25519');
  const jwk = createPublicKey(privateKey).export({ format: 'jwk' });
  const rawPublic = Buffer.from(jwk.x, 'base64url');
  const entry = { key_id: keyId, algorithm: 'ed25519', public_key: rawPublic.toString('hex'), status: 'active', purpose: 'production' };
  fs.writeFileSync(privatePath, privateKey.export({ type: 'pkcs8', format: 'pem' }), { flag: 'wx', mode: 0o600 });
  registry.keys.push(entry);
  fs.writeFileSync(registryPath, JSON.stringify(registry, null, 2) + '\n');
  const info = { schema_version: 1, key_id: keyId, algorithm: 'ed25519', public_key_sha256: createHash('sha256').update(rawPublic).digest('hex'),
    private_key_path: privatePath, registry_path: registryPath, custody: 'local user + SYSTEM; no remote transfer or managed-secret provisioning',
    created_at: new Date().toISOString(), private_material_logged: false };
  fs.writeFileSync(path.join(directory, 'key-info.json'), JSON.stringify(info, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  console.log(JSON.stringify(info));
} catch (error) {
  // Subprocess errors can include command/environment context; never dump the error object.
  console.error(error instanceof Error ? error.message.split('\n')[0] : 'local key bootstrap failed');
  process.exitCode = 1;
}
