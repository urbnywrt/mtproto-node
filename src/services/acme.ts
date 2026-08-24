import acme from 'acme-client';
import fs from 'fs';
import path from 'path';
import { config } from '../config';
import { ProxyConfig } from '../types';
import * as store from '../store';
import * as cloudflare from './cloudflare';
import { lookupTxt } from './dns';

/**
 * acme-client ships with axios configured for no timeout at all, so a stalled request
 * to the ACME directory hangs forever. Observed in production as issuance going silent
 * after the challenge was published: no success, no error, nothing to act on. A bounded
 * request turns that into an ordinary failure that reaches certLastError.
 */
acme.axios.defaults.timeout = 30000;

const CERTS_DIR = path.join(config.dataDir, 'certs');
const ACCOUNT_KEY_FILE = path.join(config.dataDir, 'acme', 'account.key');

export interface StoredCertificate {
  cert: string;
  key: string;
  expiresAt: string;
  /** Whether this certificate came from the Let's Encrypt staging directory. */
  staging: boolean;
}

interface CertMeta {
  expiresAt: string;
  issuedAt: string;
  staging: boolean;
}

function certDir(domain: string): string {
  return path.join(CERTS_DIR, domain);
}

export function readCertificate(domain: string): StoredCertificate | null {
  const dir = certDir(domain);
  try {
    const meta = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf-8')) as CertMeta;
    return {
      cert: fs.readFileSync(path.join(dir, 'fullchain.pem'), 'utf-8'),
      key: fs.readFileSync(path.join(dir, 'privkey.pem'), 'utf-8'),
      expiresAt: meta.expiresAt,
      staging: !!meta.staging,
    };
  } catch {
    return null;
  }
}

export function removeCertificate(domain: string): void {
  fs.rmSync(certDir(domain), { recursive: true, force: true });
}

/** Every domain that currently has a certificate on disk. */
export function listCertifiedDomains(): string[] {
  try {
    return fs
      .readdirSync(CERTS_DIR, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .filter((domain) => readCertificate(domain) !== null);
  } catch {
    return [];
  }
}

function needsRenewal(existing: StoredCertificate): boolean {
  // A staging certificate is untrusted by clients, and a production one issued while
  // testing wastes rate limit. Either way, flipping ACME_STAGING must take effect —
  // waiting for the renewal window would silently leave the wrong certificate in place
  // for months.
  if (existing.staging !== config.acmeStaging) return true;

  const remainingMs = new Date(existing.expiresAt).getTime() - Date.now();
  return remainingMs < config.certRenewDays * 24 * 60 * 60 * 1000;
}

async function loadAccountKey(): Promise<Buffer> {
  try {
    return fs.readFileSync(ACCOUNT_KEY_FILE);
  } catch {
    const key = await acme.crypto.createPrivateKey();
    fs.mkdirSync(path.dirname(ACCOUNT_KEY_FILE), { recursive: true });
    fs.writeFileSync(ACCOUNT_KEY_FILE, key, { mode: 0o600 });
    return key;
  }
}

/**
 * Wait until the challenge TXT record is visible from public resolvers.
 *
 * Best effort on purpose: the CA queries the authoritative nameservers itself, so this
 * only reduces the chance of a premature order. Failing to confirm is not proof the
 * record is missing — the lookup itself may be blocked — so on timeout it warns and
 * proceeds rather than abandoning an issuance that would have succeeded.
 */
async function waitForTxtRecord(name: string, expected: string): Promise<void> {
  const deadline = Date.now() + 120000;

  while (Date.now() < deadline) {
    if ((await lookupTxt(name)).includes(expected)) return;
    await new Promise((resolve) => setTimeout(resolve, 5000));
  }

  console.warn(
    `ACME: не удалось подтвердить распространение TXT ${name} за 120 с, ` +
      'продолжаю — проверять запись будет сам центр сертификации'
  );
}

function resolveToken(proxy: Pick<ProxyConfig, 'acmeDnsToken'>): string {
  const token = proxy.acmeDnsToken || config.cfApiToken;
  if (!token) {
    throw new Error(
      'Не задан токен Cloudflare: укажите CF_API_TOKEN на ноде или токен в настройках прокси.'
    );
  }
  return token;
}

/**
 * Issue a certificate for `domain` using ACME DNS-01 against Cloudflare.
 *
 * DNS-01 rather than HTTP-01 because :80 is not guaranteed to be free on a node that
 * also runs another service, and because it works identically in both 443 schemes.
 */
export async function issueCertificate(
  domain: string,
  email: string,
  token: string
): Promise<StoredCertificate> {
  const zoneId = await cloudflare.findZoneId(token, domain);
  const accountKey = await loadAccountKey();

  const client = new acme.Client({
    directoryUrl: config.acmeStaging
      ? acme.directory.letsencrypt.staging
      : acme.directory.letsencrypt.production,
    accountKey,
  });

  const [key, csr] = await acme.crypto.createCsr({ commonName: domain });

  // Records created during this order, removed in the finally block even on failure —
  // a leaked _acme-challenge TXT would confuse the next attempt.
  const created: Array<{ id: string }> = [];

  try {
    const cert = await client.auto({
      csr,
      email,
      termsOfServiceAgreed: true,
      challengePriority: ['dns-01'],
      // acme-client verifies the challenge itself before handing it to the CA, using
      // the system resolver over UDP/53. On a host where that is blocked the check
      // cannot succeed, and it retries ten times with up to 30s backoff — several
      // minutes of complete silence, then a failure that says nothing useful.
      // waitForTxtRecord above already does this over DoH, and the CA performs the
      // authoritative check regardless, so the local one is redundant.
      skipChallengeVerification: true,
      challengeCreateFn: async (authz, challenge, keyAuthorization) => {
        if (challenge.type !== 'dns-01') throw new Error(`Неожиданный тип челленджа: ${challenge.type}`);
        const recordName = `_acme-challenge.${authz.identifier.value}`;

        // Clear anything left at this name first. The finally block below cannot run
        // if the process is killed mid-order — and it will be: issuance waits up to
        // two minutes, and `update.sh` takes the container down. Without this the
        // records accumulate on every interrupted attempt.
        const stale = await cloudflare.listTxtRecords(token, zoneId, recordName).catch(() => []);
        for (const staleId of stale) {
          await cloudflare.deleteRecord(token, zoneId, staleId).catch(() => {});
        }
        if (stale.length > 0) {
          console.log(`ACME: убрано ${stale.length} брошенных TXT-записей ${recordName}`);
        }

        const id = await cloudflare.createTxtRecord(token, zoneId, recordName, keyAuthorization);
        created.push({ id });
        await waitForTxtRecord(recordName, keyAuthorization);
      },
      challengeRemoveFn: async () => {
        // Cleanup is handled once in the finally block so a partial order cannot
        // leave records behind.
      },
    });

    const info = acme.crypto.readCertificateInfo(cert);
    const expiresAt = info.notAfter.toISOString();

    const dir = certDir(domain);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'fullchain.pem'), cert);
    fs.writeFileSync(path.join(dir, 'privkey.pem'), key, { mode: 0o600 });
    const meta: CertMeta = {
      expiresAt,
      issuedAt: new Date().toISOString(),
      staging: config.acmeStaging,
    };
    fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify(meta, null, 2));

    return { cert: cert.toString(), key: key.toString(), expiresAt, staging: config.acmeStaging };
  } finally {
    for (const record of created) {
      await cloudflare.deleteRecord(token, zoneId, record.id).catch((err) => {
        console.warn(`Не удалось убрать TXT-запись ${record.id}:`, err.message);
      });
    }
  }
}

/**
 * Issuance in flight, keyed by domain.
 *
 * Two orders for the same domain sabotage each other: each one clears stale TXT
 * records before creating its own, so the later one deletes the challenge the earlier
 * one is still being validated against. Observed in production when the operator
 * pressed "reissue" again while the first attempt was still waiting.
 */
const inFlight = new Map<string, Promise<StoredCertificate>>();

function issueOnce(domain: string, email: string, token: string): Promise<StoredCertificate> {
  const running = inFlight.get(domain);
  if (running) {
    console.log(`ACME: выпуск для ${domain} уже идёт, жду его вместо нового запуска`);
    return running;
  }

  const started = withOneRetry(() => issueCertificate(domain, email, token)).finally(() => {
    inFlight.delete(domain);
  });
  inFlight.set(domain, started);
  return started;
}

/**
 * Retry issuance once after a short pause.
 *
 * Observed on a freshly created domain: the first order came back with
 * "Unable to update challenge :: authorization must be pending", and an immediate
 * manual retry succeeded. Creating a proxy is exactly when the DNS record is newest,
 * so this transient lands on the most common path — and without a retry it leaves the
 * operator with a proxy that looks broken until the 12-hour timer comes round.
 */
async function withOneRetry<T>(attempt: () => Promise<T>): Promise<T> {
  try {
    return await attempt();
  } catch (err: any) {
    console.warn(`ACME: первая попытка не удалась (${err?.message || err}), повтор через 10 с`);
    await new Promise((resolve) => setTimeout(resolve, 10000));
    return attempt();
  }
}

/**
 * Ensure a WEB proxy has a usable certificate, issuing or renewing as needed.
 * Certificate state is mirrored onto the proxy record so the panel can show it.
 * Returns true when the certificate on disk changed and nginx needs a reload.
 */
export async function ensureCertificate(proxy: ProxyConfig): Promise<boolean> {
  if (proxy.type !== 'web') return false;

  const existing = readCertificate(proxy.domain);
  if (existing && !needsRenewal(existing)) {
    store.updateProxy(proxy.id, {
      certStatus: 'active',
      certExpiresAt: existing.expiresAt,
      certLastError: undefined,
    });
    return false;
  }

  if (!proxy.acmeEmail) {
    store.updateProxy(proxy.id, { certStatus: 'error', certLastError: 'Не задан email для ACME' });
    return false;
  }

  try {
    const token = resolveToken(proxy);
    console.log(`ACME: выпуск сертификата для ${proxy.domain}...`);
    const issued = await issueOnce(proxy.domain, proxy.acmeEmail!, token);
    if (issued.staging) console.warn(`ACME: ${proxy.domain} использует staging-сертификат, клиенты ему не доверяют`);
    store.updateProxy(proxy.id, {
      certStatus: 'active',
      certExpiresAt: issued.expiresAt,
      certLastError: undefined,
    });
    console.log(`ACME: сертификат для ${proxy.domain} действует до ${issued.expiresAt}`);
    return true;
  } catch (err: any) {
    const message = err?.message || String(err);
    console.error(`ACME: не удалось выпустить сертификат для ${proxy.domain}:`, message);
    store.updateProxy(proxy.id, {
      // An expired-but-present certificate is still worth reporting as active-ish;
      // callers distinguish via certLastError.
      certStatus: existing ? 'active' : 'error',
      certLastError: message,
    });
    return false;
  }
}

/** Issue or renew certificates for every WEB proxy. Returns true if any changed. */
export async function renewDueCertificates(): Promise<boolean> {
  const webProxies = store.getAllProxies().filter((p) => p.type === 'web');
  let changed = false;
  for (const proxy of webProxies) {
    if (await ensureCertificate(proxy)) changed = true;
  }
  return changed;
}
