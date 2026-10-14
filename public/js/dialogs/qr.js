// QR code dialog for all labeled service URLs.

import { $, h, fill, svg } from "../dom.js";
import { serviceUrls, primaryUrl } from "../utils.js";
import { QR } from "../qr.js";

export function openQr(svc) {
  const urls = serviceUrls(svc);
  if (!urls.length) return;
  let current = urls.find((u) => u.url === primaryUrl(svc)) || urls[0];

  const show = () => {
    fill($("#qrCode"), QR.toSvg(current.url));
    const link = $("#qrUrl");
    link.href = current.url;
    link.textContent = current.url;
    const switcher = $("#qrSwitch");
    fill(
      switcher,
      urls.map((u) =>
        h(
          "button",
          {
            type: "button",
            title: u.url,
            "aria-label": `${u.label}: ${u.url}`,
            "aria-pressed": String(u === current),
            onclick: () => {
              current = u;
              show();
            },
          },
          svg("globe"),
          u.label,
        ),
      ),
    );
    switcher.hidden = urls.length < 2;
  };
  $("#qrTitle").textContent = svc.name;
  show();
  $("#qrDialog").showModal();
}
