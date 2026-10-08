const API_ACCEPT = 'Application/vnd.pterodactyl.v1+json';

function getEndpoint(config, resource) {
  const panel = config.panelUrl.trim().replace(/\/+$/, '');
  const serverId = encodeURIComponent(config.serverId.trim());
  if (!/^https?:\/\//i.test(panel)) throw new Error('Panel URL must start with https:// (or http:// for a trusted local panel).');
  if (!config.apiKey.trim() || !serverId) throw new Error('Add the Client API key and server ID in Settings.');
  return `${panel}/api/client/servers/${serverId}/${resource}`;
}

async function request(config, resource, options = {}) {
  const response = await fetch(getEndpoint(config, resource), {
    ...options,
    headers: {
      Accept: API_ACCEPT,
      Authorization: `Bearer ${config.apiKey.trim()}`,
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...options.headers,
    },
  });
  const text = await response.text();
  let body;
  try { body = text ? JSON.parse(text) : {}; } catch { body = {}; }
  if (!response.ok) {
    const detail = body?.errors?.[0]?.detail || body?.errors?.[0]?.code;
    throw new Error(detail || `Panel API request failed (${response.status}).`);
  }
  return body;
}

export async function getServerPowerState(config) {
  const body = await request(config, 'resources');
  const state = body?.attributes?.current_state;
  if (typeof state !== 'string') throw new Error('The Panel API response did not include the server power state.');
  return state.toLowerCase();
}

export async function sendPowerAction(config, signal) {
  await request(config, 'power', {
    method: 'POST',
    body: JSON.stringify({ signal }),
  });
}
