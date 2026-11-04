import { appendFile, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// Trust is confined to this throwaway browser HOME, never the operator's profile.
export async function prepareTls(directory) {
  const root = directory ? resolve(directory) : await mkdtemp(join(tmpdir(), 'profile-browser-tls-'));
  await mkdir(root, { recursive: true, mode: 0o700 });
  const home = join(root, 'home');
  const nss = join(home, '.pki', 'nssdb');
  await mkdir(nss, { recursive: true, mode: 0o700 });
  const caKey = join(root, 'test-ca.key');
  const ca = join(root, 'test-ca.crt');
  const key = join(root, 'localhost.key');
  const csr = join(root, 'localhost.csr');
  const cert = join(root, 'localhost.crt');
  const extensions = join(root, 'localhost.ext');
  const run = (command, args) => execFileSync(command, args, { stdio: ['ignore', 'ignore', 'pipe'] });
  run('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', caKey, '-out', ca,
    '-days', '2', '-subj', '/CN=StudentHub disposable browser acceptance CA',
    '-addext', 'basicConstraints=critical,CA:TRUE', '-addext', 'keyUsage=critical,keyCertSign,cRLSign']);
  run('openssl', ['req', '-new', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', csr, '-subj', '/CN=localhost']);
  await writeFile(extensions, 'subjectAltName=DNS:localhost,IP:127.0.0.1\nbasicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\n', { mode: 0o600 });
  run('openssl', ['x509', '-req', '-in', csr, '-CA', ca, '-CAkey', caKey, '-CAcreateserial', '-out', cert,
    '-days', '2', '-sha256', '-extfile', extensions]);
  run('certutil', ['-N', '--empty-password', '-d', `sql:${nss}`]);
  run('certutil', ['-A', '-d', `sql:${nss}`, '-n', 'StudentHub disposable browser acceptance CA', '-t', 'C,,', '-i', ca]);
  run('openssl', ['verify', '-CAfile', ca, cert]);
  return { root, home, ca, cert, key };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const paths = await prepareTls(process.argv[2]);
  const values = {
    HOME: paths.home,
    BROWSER_ACCEPTANCE_TLS_CERT: paths.cert,
    BROWSER_ACCEPTANCE_TLS_KEY: paths.key,
    BROWSER_ACCEPTANCE_TLS_CA: paths.ca,
    NODE_EXTRA_CA_CERTS: paths.ca,
  };
  if (process.env.GITHUB_ENV) {
    await appendFile(process.env.GITHUB_ENV, Object.entries(values).map(([k, v]) => `${k}=${v}\n`).join(''));
  } else {
    // Paths only. Private keys and session credentials never reach stdout.
    process.stdout.write(JSON.stringify(values) + '\n');
  }
}
