/**
 * Classic HTML5 boot: browser gate + load the Vite client entry.
 * Kept as a classic script so unsupported UAs can still show the banner.
 * window.__BBB_ENTRY__ is set by index.html (dev / prod via htmlBootPlugin).
 */
(function () {
  var ua = navigator.userAgent;
  var isSafari = /^((?!chrome|android).)*safari/i.test(ua);

  var MIN_VERSIONS = {
    safari: 16,
    chrome: 87,
    firefox: 80,
    edge: 85,
    miui: 0,
  };

  function parseVersion(regex) {
    var match = ua.match(regex);
    return match ? parseInt(match[1], 10) : null;
  }

  var safariVersion = parseVersion(/Version\/(\d+).*Safari/);
  var chromeVersion = parseVersion(/(?:Chrome|CriOS)\/(\d+)/);
  var firefoxVersion = parseVersion(/Firefox\/(\d+)/);
  var edgeVersion = parseVersion(/Edg\/(\d+)/);
  var miuiVersion = parseVersion(/MiuiBrowser\/(\d+)/);
  // WebRTC support check is based on LiveKit's isBrowserSupported util
  var supportsWebRTC = !!(
    typeof RTCPeerConnection !== 'undefined'
    && RTCPeerConnection
    && navigator.mediaDevices
    && RTCPeerConnection.prototype
    && 'addTransceiver' in RTCPeerConnection.prototype
    && 'addTrack' in RTCPeerConnection.prototype
  );
  var supportedUA = !(
    (isSafari && safariVersion && safariVersion < MIN_VERSIONS.safari)
    || (chromeVersion && chromeVersion < MIN_VERSIONS.chrome)
    || (firefoxVersion && firefoxVersion < MIN_VERSIONS.firefox)
    || (edgeVersion && edgeVersion < MIN_VERSIONS.edge)
    || (miuiVersion !== null)
  );

  if (supportedUA && supportsWebRTC) {
    var entry = window.__BBB_ENTRY__;
    if (!entry || String(entry).indexOf('__') === 0) {
      document.body.textContent = 'Missing client entry URL.';
      return;
    }
    var script = document.createElement('script');
    script.type = 'module';
    script.crossOrigin = 'anonymous';
    script.src = entry;
    document.head.appendChild(script);
    return;
  }

  var CHROME_LINK = '<a href="https://www.google.com/chrome/" rel="noopener noreferrer">Chrome</a>';
  var FIREFOX_LINK = '<a href="https://getfirefox.com" rel="noopener noreferrer">Firefox</a>';
  var msg;
  if (miuiVersion !== null || !(chromeVersion || firefoxVersion || edgeVersion || isSafari)) {
    msg = 'It looks like you\'re using a browser that is not supported. Please use a recent version of either '
      + CHROME_LINK + ' or ' + FIREFOX_LINK + ' for full support.';
  } else if (isSafari && safariVersion && safariVersion < MIN_VERSIONS.safari) {
    msg = 'Please upgrade your browser to Safari 16 or newer for full support.';
  } else {
    msg = 'It looks like you\'re using an older version of a supported browser. Please upgrade your browser to a recent version for full support.';
  }

  var banner = document.createElement('p');
  banner.className = 'browserWarning';
  banner.innerHTML = msg;
  var appRoot = document.getElementById('app');
  if (appRoot) {
    appRoot.appendChild(banner);
  } else {
    document.body.appendChild(banner);
  }
})();
