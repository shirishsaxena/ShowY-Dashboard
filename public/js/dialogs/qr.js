// QR code dialog for a service link (local / public).

import { $, h, fill, svg } from '../dom.js';
import { safeUrl, primaryUrl } from '../utils.js';
import { QR } from '../qr.js';

export function openQr(svc) {
  const urls = [
    { label: 'Local', icon: 'home', url: safeUrl(svc.url) },
    { label: 'Public', icon: 'globe', url: safeUrl(svc.altUrl) },
  ].filter((u) => u.url);
  let current = urls.find((u) => u.url === primaryUrl(svc)) || urls[0];

  const show = () => {
    fill($('#qrCode'), QR.toSvg(current.url));
    const link = $('#qrUrl');
    link.href = current.url;
    link.textContent = current.url;
    const switcher = $('#qrSwitch');
    fill(
      switcher,
      urls.map((u) =>
        h(
          'button',
          {
            type: 'button',
            'aria-pressed': String(u === current),
            onclick: () => {
              current = u;
              show();
            },
          },
          svg(u.icon),
          u.label
        )
      )
    );
    switcher.hidden = urls.length < 2;
  };
  $('#qrTitle').textContent = svc.name;
  show();
  $('#qrDialog').showModal();
}
