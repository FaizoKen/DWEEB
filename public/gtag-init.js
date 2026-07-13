// Google Analytics, loaded lazily.
//
// The dataLayer/gtag stub is set up synchronously so the `config` call (and any
// early events) queue into dataLayer immediately. The heavy gtag.js library —
// ~90 kB of third-party JS that competes for bandwidth and blocks the main
// thread when it parses — is fetched only once the page is idle or the user
// first interacts, whichever comes first. This keeps it entirely off the
// critical path: first paint and time-to-interactive no longer wait on, or
// contend with, analytics. Queued calls flush the moment the library arrives.
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
  window.gtag("config", "G-GQRDJZRCTS");

  var loaded = false;
  var events = ["pointerdown", "keydown", "touchstart", "scroll"];
  var opts = { once: true, passive: true, capture: true };

  function load() {
    if (loaded) return;
    loaded = true;
    for (var i = 0; i < events.length; i++) {
      window.removeEventListener(events[i], load, opts);
    }
    var s = document.createElement("script");
    s.async = true;
    s.src = "https://www.googletagmanager.com/gtag/js?id=G-GQRDJZRCTS";
    document.head.appendChild(s);
  }

  for (var i = 0; i < events.length; i++) {
    window.addEventListener(events[i], load, opts);
  }
  if ("requestIdleCallback" in window) {
    requestIdleCallback(load, { timeout: 4000 });
  } else {
    setTimeout(load, 2500);
  }
})();
