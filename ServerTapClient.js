export async function fetchServerTapPlayers(settings) {
  const base = settings.serverTapUrl.trim().replace(/\/+$/, '');
  if (!base) throw new Error('Add the ServerTap API URL in Settings.');

  const headers = { Accept: 'application/json' };
  if (settings.serverTapKey.trim()) headers.key = settings.serverTapKey.trim();

  const request = async (path) => {
    const response = await fetch(`${base}${path}`, { method: 'GET', headers });
    if (!response.ok) throw new Error(`ServerTap returned HTTP ${response.status}.`);
    const data = await response.json();
    if (!Array.isArray(data)) throw new Error('ServerTap returned an unexpected player list.');
    return data;
  };

  const [allPlayers, onlinePlayers] = await Promise.all([
    request('/v1/players/all'),
    request('/v1/players').catch(() => null),
  ]);
  const onlineIds = new Set((onlinePlayers || []).map((player) => String(player.uuid || player.name || player.displayName || '').toLowerCase()).filter(Boolean));
  const normalize = (player) => {
    const id = String(player.uuid || player.name || player.displayName || '').toLowerCase();
    const online = typeof player.online === 'boolean' ? player.online : onlineIds.has(id);
    return { ...player, online };
  };
  return allPlayers.map(normalize).sort((a, b) => Number(b.online) - Number(a.online) || String(a.displayName || a.name || '').localeCompare(String(b.displayName || b.name || '')));
}
