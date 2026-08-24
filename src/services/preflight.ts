import Docker from 'dockerode';
import { config } from '../config';
import * as store from '../store';
import * as cloudflare from './cloudflare';
import { lookupA } from './dns';
import { getCapabilities } from './capabilities';

const docker = new Docker({ socketPath: '/var/run/docker.sock' });

export interface PreflightInput {
  domain: string;
  /** Public IP the panel has on file for this node. Used in mode 1. */
  nodeIp?: string;
  acmeDnsToken?: string;
  /** Set when re-validating an existing proxy, so its own domain does not clash. */
  excludeProxyId?: string;
}

export interface PreflightResult {
  /** IP the domain must resolve to, and which telemt records as public_addr. */
  targetIp: string;
  mode: 1 | 2;
}

export class PreflightError extends Error {}

/** Canonical lowercase ACE FQDN, no scheme, port, path or trailing dot. */
export function isValidWebDomain(domain: string): boolean {
  if (!domain || domain.length > 253) return false;
  if (domain !== domain.toLowerCase()) return false;
  if (/[:/\\ ]/.test(domain) || domain.endsWith('.')) return false;
  return /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(domain);
}

/**
 * Addresses of the host, read through the nginx container.
 *
 * The service node runs on the bridge network and only sees its own container address,
 * so os.networkInterfaces() cannot answer this. nginx uses host networking, which makes
 * it a usable vantage point.
 */
async function getHostAddresses(): Promise<string[]> {
  const container = docker.getContainer(config.nginxContainerName);
  const exec = await container.exec({
    Cmd: ['hostname', '-I'],
    AttachStdout: true,
    AttachStderr: true,
  });
  const stream = (await exec.start({})) as unknown as NodeJS.ReadableStream;

  const output = await new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    stream.on('data', (chunk: Buffer) => chunks.push(chunk));
    stream.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    stream.on('error', reject);
  });

  return output.match(/\d{1,3}(?:\.\d{1,3}){3}/g) || [];
}

async function resolveDomain(domain: string): Promise<string[]> {
  // Same dual path as the ACME propagation check: a node whose outbound UDP/53 is
  // blocked would otherwise fail preflight and never be able to host a WEB proxy.
  const addresses = await lookupA(domain);
  if (addresses.length === 0) {
    throw new PreflightError(
      `Домен ${domain} не резолвится в A-запись. Создайте A-запись на IP ноды ` +
        'и дождитесь распространения. Если запись точно есть — проверьте, что с ноды ' +
        'работает разрешение имён и исходящий HTTPS.'
    );
  }
  return addresses;
}

/**
 * Everything that must hold before a WEB proxy is created. Runs before any container,
 * certificate or DNS record is made, so a failure leaves nothing behind.
 */
export async function preflightWebProxy(input: PreflightInput): Promise<PreflightResult> {
  const capabilities = getCapabilities();
  if (!capabilities.web) {
    throw new PreflightError(capabilities.reason || 'Нода не может держать WEB-прокси');
  }
  const mode = capabilities.mode as 1 | 2;

  if (!isValidWebDomain(input.domain)) {
    throw new PreflightError(
      `Некорректный домен "${input.domain}": нужен FQDN в нижнем регистре, без схемы, порта и точки в конце.`
    );
  }

  const clash = store.getAllProxies().find((p) => p.domain === input.domain && p.id !== input.excludeProxyId);
  if (clash) {
    throw new PreflightError(`Домен ${input.domain} уже занят прокси ${clash.name} (${clash.id})`);
  }

  const targetIp = config.webBindIp || config.publicIp || input.nodeIp || '';
  if (!targetIp) {
    throw new PreflightError(
      'Не известен публичный IP ноды. Задайте PUBLIC_IP на ноде или обновите панель, ' +
        'чтобы она передавала nodeIp.'
    );
  }

  if (mode === 2) {
    // A WEB_BIND_IP that is not actually on the host makes nginx reject the whole
    // configuration — which would take the fake TLS proxies down with it. Catch it here
    // rather than at reload time.
    let hostAddresses: string[] = [];
    try {
      hostAddresses = await getHostAddresses();
    } catch {
      console.warn('Не удалось получить адреса хоста, пропускаю проверку WEB_BIND_IP');
    }
    if (hostAddresses.length > 0 && !hostAddresses.includes(config.webBindIp)) {
      throw new PreflightError(
        `WEB_BIND_IP=${config.webBindIp} не поднят на интерфейсах хоста (есть: ${hostAddresses.join(', ')}). ` +
          'nginx отверг бы такой конфиг целиком.'
      );
    }
  }

  const resolved = await resolveDomain(input.domain);

  const proxied = resolved.filter((ip) => cloudflare.isCloudflareProxiedIp(ip));
  if (proxied.length > 0) {
    throw new PreflightError(
      `A-запись ${input.domain} проксируется через Cloudflare (${proxied.join(', ')}). ` +
        'Оранжевое облако терминирует TLS у себя и полностью ломает WEB-каррier — ' +
        'переключите запись в DNS only (серое облако).'
    );
  }

  if (!resolved.includes(targetIp)) {
    throw new PreflightError(
      `${input.domain} резолвится в ${resolved.join(', ')}, а нужен ${targetIp}.`
    );
  }

  const token = input.acmeDnsToken || config.cfApiToken;
  if (!token) {
    throw new PreflightError(
      'Не задан токен Cloudflare для выпуска сертификата: укажите CF_API_TOKEN на ноде ' +
        'или токен в настройках прокси.'
    );
  }
  try {
    await cloudflare.verifyToken(token);
  } catch (err: any) {
    if (err instanceof cloudflare.CloudflareUnreachableError) {
      throw new PreflightError(`Сертификат выпустить не выйдет: ${err.message}`);
    }
    throw new PreflightError(`Токен Cloudflare отвергнут: ${err?.message || err}`);
  }
  try {
    await cloudflare.findZoneId(token, input.domain);
  } catch (err: any) {
    throw new PreflightError(err?.message || String(err));
  }

  return { targetIp, mode };
}
