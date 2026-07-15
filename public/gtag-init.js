// Google Analytics, loaded lazily.
//
// The dataLayer/gtag stub is set up synchronously so the `config` call (and any
// early events) queue into dataLayer immediately. The heavy gtag.js library —
// third-party JS that competes for bandwidth and blocks the main thread when it
// parses — is fetched only after the app signals that its first paint is ready,
// or after a delayed fallback on static pages. Queued calls flush when it arrives.
//
// Kept as an external file (not inlined) so it satisfies the strict CSP
// `script-src 'self' https://www.googletagmanager.com` with no 'unsafe-inline'.
(function () {
  // Respect both the established DNT signal and Global Privacy Control before
  // creating the analytics queue or making any request to Google.
  if (
    navigator.globalPrivacyControl === true ||
    navigator.doNotTrack === "1" ||
    window.doNotTrack === "1"
  ) {
    return;
  }

  window.dataLayer = window.dataLayer || [];
  window.gtag = function () {
    window.dataLayer.push(arguments);
  };
  window.gtag("js", new Date());
  var pageType = document.documentElement.getAttribute("data-page-type") || "app";
  var isAppShell = document.documentElement.hasAttribute("data-app-shell");

  // Analytics receives the page's controlled canonical URL, never the live
  // address bar. That drops share hashes, OAuth/billing/guild values, short-link
  // ids, arbitrary 404 paths and attacker-supplied query strings in one rule.
  // Generated discovery pages have exact canonicals; the SPA/404 shell points
  // to `/` and records bounded product events for its internal state instead.
  function safePageLocation(loc) {
    var node = document.querySelector('link[rel="canonical"]');
    if (!node || !node.href) return loc.origin + "/";
    try {
      var canonical = new URL(node.href, loc.origin);
      if (canonical.origin !== loc.origin) return loc.origin + "/";
      return canonical.origin + canonical.pathname;
    } catch (_) {
      return loc.origin + "/";
    }
  }

  window.gtag("config", "G-GQRDJZRCTS", {
    // Gives the generated templates, features, guides, and product landing page
    // clean cohorts without internal UTM parameters corrupting organic source
    // attribution. The normal page URL/title remain available in GA as usual.
    content_group: pageType,
    page_location: safePageLocation(window.location),
    // Keep referral-domain attribution without transmitting a referrer's path,
    // query or fragment. `page_referrer` is an explicit GA4 config field.
    page_referrer: (function () {
      if (!document.referrer) return "";
      try {
        var referrer = new URL(document.referrer);
        return /^https?:$/.test(referrer.protocol) ? referrer.origin + "/" : "";
      } catch (_) {
        return "";
      }
    })(),
  });

  // Search landing pages mark their builder CTAs declaratively. Persist only
  // the bounded entry token + placement for the same-tab hop. The destination
  // validates the token against the exact public catalog before emitting both
  // click and builder-open events, so a fast click cannot be lost while the
  // deliberately delayed analytics library is still loading.
  document.addEventListener("click", function (event) {
    var node = event.target;
    if (!node || node.nodeType !== 1) node = node && node.parentElement;
    var link = node && node.closest ? node.closest("a[data-analytics]") : null;
    if (!link) return;
    try {
      var destination = new URL(link.href, window.location.origin);
      var entry = destination.searchParams.get("entry");
      var placement = link.getAttribute("data-analytics-location") || "";
      if (
        destination.origin === window.location.origin &&
        entry &&
        /^(?:landing|template|feature|guide):[a-z0-9][a-z0-9-]{0,79}$/.test(entry) &&
        /^(?:hero|body|nav|footer)$/.test(placement)
      ) {
        window.sessionStorage.setItem(
          "dweeb:seo-cta",
          JSON.stringify({ entry: entry, location: placement, at: Date.now() }),
        );
      }
    } catch (_) {
      // Storage can be unavailable in hardened/private browsing contexts. The
      // URL token still records the builder-open conversion after navigation.
    }
  });

  var loaded = false;
  var events = ["pointerdown", "keydown", "touchstart", "scroll"];
  var opts = { once: true, passive: true, capture: true };
  var requested = false;

  function load() {
    if (loaded) return;
    loaded = true;
    var s = document.createElement("script");
    s.async = true;
    s.src = "https://www.googletagmanager.com/gtag/js?id=G-GQRDJZRCTS";
    document.head.appendChild(s);
  }

  function requestLoad() {
    if (requested) return;
    requested = true;
    for (var i = 0; i < events.length; i++) {
      window.removeEventListener(events[i], requestLoad, opts);
    }
    // Give the triggering interaction/first app paint breathing room before
    // asking the browser for idle time. The timeout still guarantees analytics
    // eventually loads on a busy page.
    setTimeout(
      function () {
        if ("requestIdleCallback" in window) {
          window.requestIdleCallback(load, { timeout: 3000 });
        } else {
          setTimeout(load, 1000);
        }
      },
      isAppShell ? 4000 : 1000,
    );
  }

  for (var i = 0; i < events.length; i++) {
    window.addEventListener(events[i], requestLoad, opts);
  }
  window.addEventListener("dweeb:app-ready", requestLoad, { once: true });
  // The root document is both the product landing page and the SPA shell. Use
  // the app delay even though its analytics content group is `landing`, so the
  // third-party library cannot race the editor's slower mobile first paint.
  setTimeout(requestLoad, isAppShell ? 8000 : 4000);
})();
