/**
 * VPN status client — checks current VPN state via external IP lookup.
 * Works regardless of how the VPN is configured (router-level, ProtonVPN app, etc.)
 */

import https from 'https';

function fetchJson(url, timeout = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Request timed out')), timeout);
    https.get(url, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        clearTimeout(timer);
        try { resolve(JSON.parse(data)); }
        catch { reject(new Error(`Bad response: ${data.slice(0, 200)}`)); }
      });
    }).on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

export async function getVpnStatus() {
  const info = await fetchJson('https://ipinfo.io/json');
  // Proton VPN typically exits via Datacamp Limited or similar providers
  const isVpn = /datacamp|protonvpn|m247|datapacket/i.test(info.org || '');
  return {
    connected: isVpn,
    ip: info.ip,
    city: info.city,
    region: info.region,
    country: info.country,
    org: info.org,
    timezone: info.timezone,
  };
}
