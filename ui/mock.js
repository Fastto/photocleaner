/* Dev-only mock of the Tauri bridge so the UI can be previewed in a plain browser
   (`npm run ui`, then open http://localhost:1420). Inert inside the real app. */
(function () {
  if (window.__TAURI__) return;

  const svg = (hue, light, blur) => {
    const l = Math.round(light * 100);
    const s = `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="240"><defs><filter id="b"><feGaussianBlur stdDeviation="${blur}"/></filter></defs>
      <rect width="320" height="240" fill="hsl(${hue},45%,${l}%)"/>
      <g filter="url(#b)"><circle cx="${90 + (hue % 80)}" cy="110" r="55" fill="hsl(${(hue + 120) % 360},60%,${Math.min(95, l + 15)}%)"/>
      <rect x="170" y="60" width="90" height="130" fill="hsl(${(hue + 200) % 360},50%,${Math.max(8, l - 20)}%)"/></g></svg>`;
    return 'data:image/svg+xml;utf8,' + encodeURIComponent(s);
  };
  const images = {};
  const photos = [];
  let seed = 7;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const toHex = (bytes) => bytes.map((b) => b.toString(16).padStart(2, '0')).join('');
  const t0 = Date.UTC(2024, 6, 14, 10, 0, 0);
  let clock = t0, n = 0;

  function add(o) {
    n++;
    const path = `/mock/IMG_${String(1000 + n)}.jpg`;
    images[path] = svg(o.hue, o.mean / 255, o.blur);
    photos.push({
      path, name: `IMG_${1000 + n}.jpg`, size: 2e6 + Math.floor(rnd() * 3e6), width: 4032, height: 3024, takenMs: o.t,
      mean: o.mean, bright: o.bright ?? 0.02, dark: o.dark ?? 0.02, sharp: o.sharp, hash: o.hash, thumb: path,
    });
  }
  // series of similar shots
  for (let s = 0; s < 8; s++) {
    const base = Array.from({ length: 32 }, () => Math.floor(rnd() * 256));
    const hue = 20 + s * 40;
    clock += 600000;
    for (let i = 0, k = 3 + (s % 3); i < k; i++) {
      const h = base.slice(); h[Math.floor(rnd() * 32)] ^= 1 << Math.floor(rnd() * 8);
      add({ t: clock + i * 3000, hue, mean: 120 + Math.floor(rnd() * 20), sharp: i === 1 ? 420 : 60 + Math.floor(rnd() * 150), blur: i === 1 ? 0 : 2 + rnd() * 3, hash: toHex(h) });
    }
  }
  // singles of each kind
  for (let i = 0; i < 9; i++) { clock += 900000; add({ t: clock, hue: 40, mean: 205 + i * 4, bright: 0.3 + i * 0.03, sharp: 300, blur: 0, hash: toHex(Array.from({ length: 32 }, () => Math.floor(rnd() * 256))) }); }
  for (let i = 0; i < 7; i++) { clock += 900000; add({ t: clock, hue: 230, mean: 14 + i * 6, dark: 0.7, sharp: 200, blur: 0, hash: toHex(Array.from({ length: 32 }, () => Math.floor(rnd() * 256))) }); }
  for (let i = 0; i < 8; i++) { clock += 900000; add({ t: clock, hue: 300, mean: 125, sharp: 8 + i * 6, blur: 6 + (8 - i), hash: toHex(Array.from({ length: 32 }, () => Math.floor(rnd() * 256))) }); }
  for (let i = 0; i < 12; i++) { clock += 900000; add({ t: clock, hue: 90 + i * 15, mean: 130, sharp: 350, blur: 0, hash: toHex(Array.from({ length: 32 }, () => Math.floor(rnd() * 256))) }); }

  // exact duplicate pair + low-res photos
  { const h = toHex(Array.from({ length: 32 }, () => Math.floor(rnd() * 256))); clock += 900000; add({ t: clock, hue: 10, mean: 130, sharp: 300, blur: 0, hash: h }); photos[photos.length - 1].size = 3333333; add({ t: clock + 8e5, hue: 10, mean: 130, sharp: 300, blur: 0, hash: h }); photos[photos.length - 1].size = 3333333; }
  for (let i = 0; i < 3; i++) { clock += 900000; add({ t: clock, hue: 160, mean: 130, sharp: 200, blur: 1, hash: toHex(Array.from({ length: 32 }, () => Math.floor(rnd() * 256))) }); const p = photos[photos.length - 1]; p.width = 640; p.height = 480; }

  class Channel { set onmessage(f) { this._f = f; } get onmessage() { return this._f; } }
  window.__TAURI__ = {
    core: {
      Channel,
      convertFileSrc: (p) => images[p] || p,
      invoke: async (cmd, args) => {
        if (cmd === 'scan') {
          args.onEvent.onmessage?.({ event: 'total', data: { total: photos.length } });
          for (let d = 0; d < photos.length; d += 6) {
            args.onEvent.onmessage?.({ event: 'photos', data: { items: photos.slice(d, d + 6).map((p) => ({ ...p })) } });
            args.onEvent.onmessage?.({ event: 'progress', data: { done: Math.min(d + 6, photos.length), total: photos.length, failed: 0 } });
            await new Promise((r) => setTimeout(r, 120));
          }
          return { failed: [], cancelled: false };
        }
        if (cmd === 'delete_files') return { deleted: args.paths, errors: [] };
        return null;
      },
    },
    dialog: { open: async () => ['/Users/demo/Pictures/Trip'], ask: async () => true },
  };
})();
