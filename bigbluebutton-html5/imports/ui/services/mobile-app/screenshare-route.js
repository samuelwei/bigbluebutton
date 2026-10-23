/** Meeting screenshare bridge id. Default matches screenshare/service.js. */
let screenshareBridgeName = 'livekit';

export function setScreenshareBridgeName(bridgeName) {
  if (typeof bridgeName === 'string' && bridgeName.length > 0) {
    screenshareBridgeName = bridgeName;
  }
}

/**
 * Native screen-share SDP routing exists for the SFU broker. LiveKit publishes
 * the captured track on its own peer connection, which must stay in the WebView.
 */
export function screenshareUsesNativePeer() {
  return screenshareBridgeName === 'bbb-webrtc-sfu';
}
