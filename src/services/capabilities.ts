import { config } from '../config';

/**
 * Whether this node can host WEB proxies, and under which of the two 443 schemes.
 *
 * Mode 1 — nginx owns 443 on the main IP. WEB domains are routed out of the existing
 *          stream block by SNI into a loopback L7 vhost.
 * Mode 2 — 443 on the main IP belongs to something else (typically a remnawave/Xray
 *          node). WEB gets its own public IP via WEB_BIND_IP and bypasses stream.
 *
 * The Telegram Desktop client always connects on 443 and telemt validates public_addr
 * as IP:443, so a node with neither scheme available cannot host WEB at all.
 */
export interface NodeCapabilities {
  web: boolean;
  mode: 1 | 2 | null;
  /**
   * IP the WEB domain's A record must point at. null in mode 1, where the node does
   * not know its own public address — the panel substitutes the IP it has on file.
   */
  bindIp: string | null;
  /** Whether CF_API_TOKEN is set, so the panel knows if a per-proxy token is required. */
  acmeTokenConfigured: boolean;
  reason: string;
}

export function getCapabilities(): NodeCapabilities {
  const base = { acmeTokenConfigured: !!config.cfApiToken };

  if (config.webBindIp && config.nginxPort === 443) {
    // stream would bind 0.0.0.0:443 while the WEB vhost binds <webBindIp>:443.
    return {
      ...base,
      web: false,
      mode: null,
      bindIp: null,
      reason:
        'Конфликт биндов: WEB_BIND_IP задан, но NGINX_PORT=443. ' +
        'Переведите faketls-прокси на другой порт или уберите WEB_BIND_IP.',
    };
  }

  if (config.webBindIp) {
    return {
      ...base,
      web: true,
      mode: 2,
      bindIp: config.webBindIp,
      reason: '',
    };
  }

  if (config.nginxPort === 443) {
    return { ...base, web: true, mode: 1, bindIp: null, reason: '' };
  }

  return {
    ...base,
    web: false,
    mode: null,
    bindIp: null,
    reason:
      `NGINX_PORT=${config.nginxPort}, то есть 443 занят другим сервисом. ` +
      'Выделите второй публичный IP и задайте WEB_BIND_IP.',
  };
}
