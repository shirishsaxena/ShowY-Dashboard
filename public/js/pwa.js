// Installation metadata is public, including while the dashboard is locked.
let metadataRequest = 0;

export async function refreshInstallMetadata(refreshManifest = false) {
  const request = ++metadataRequest;
  try {
    const response = await fetch("/manifest.webmanifest", { cache: "no-cache" });
    if (!response.ok) return;
    const manifest = await response.json();
    if (request !== metadataRequest || typeof manifest.name !== "string") return;
    const title = document.querySelector('meta[name="apple-mobile-web-app-title"]');
    if (title) title.content = manifest.name;
    // Ask the browser to re-read metadata after a saved configuration change.
    // The manifest's explicit id remains stable; this does not create a new app.
    const link = document.querySelector('link[rel="manifest"]');
    if (refreshManifest && link)
      link.href = `/manifest.webmanifest?v=${Date.now()}`;
  } catch {
    // Metadata/network failures must never block login or dashboard startup.
  }
}

export function initInstallMetadata() {
  void refreshInstallMetadata();
  document.addEventListener("config-saved", () => void refreshInstallMetadata(true));
}
