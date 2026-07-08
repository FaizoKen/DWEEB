const DEFAULT_WEB_APP_URL = "https://dweeb.faizo.net";
const DEFAULT_MEDIA_PATH = "/media/defaults";

const configuredWebAppUrl = (import.meta.env?.VITE_WEB_APP_URL ?? "").trim().replace(/\/+$/, "");
const mediaOrigin = configuredWebAppUrl || browserWebOrigin() || DEFAULT_WEB_APP_URL;

function browserWebOrigin(): string {
  if (typeof window === "undefined") return "";
  try {
    const params = new URLSearchParams(window.location.search);
    if (params.has("frame_id")) return "";
    return window.location.origin.replace(/\/+$/, "");
  } catch {
    return "";
  }
}

function defaultMediaUrl(fileName: string): string {
  return `${mediaOrigin}${DEFAULT_MEDIA_PATH}/${fileName}`;
}

export const DEFAULT_MEDIA = {
  thumbnail: defaultMediaUrl("dweeb-default-thumbnail.jpg"),
  gallery: defaultMediaUrl("dweeb-default-gallery.jpg"),
  showcaseGallery1: defaultMediaUrl("dweeb-showcase-gallery-1.jpg"),
  showcaseGallery2: defaultMediaUrl("dweeb-showcase-gallery-2.jpg"),
  showcaseGallery3: defaultMediaUrl("dweeb-showcase-gallery-3.jpg"),
  welcomeBanner: defaultMediaUrl("dweeb-welcome-banner.jpg"),
  announcementBanner: defaultMediaUrl("dweeb-announcement-banner.jpg"),
  eventThumb: defaultMediaUrl("dweeb-event-thumb.jpg"),
  giveawayPrize: defaultMediaUrl("dweeb-giveaway-prize.jpg"),
  productHoodie: defaultMediaUrl("dweeb-product-hoodie.jpg"),
  spotlight1: defaultMediaUrl("dweeb-spotlight-1.jpg"),
  spotlight2: defaultMediaUrl("dweeb-spotlight-2.jpg"),
  spotlight3: defaultMediaUrl("dweeb-spotlight-3.jpg"),
  spotlight4: defaultMediaUrl("dweeb-spotlight-4.jpg"),
} as const;
