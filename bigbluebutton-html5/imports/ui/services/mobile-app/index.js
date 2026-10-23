import browserInfo from '/imports/utils/browserInfo';
import logger from '/imports/startup/client/logger';
import Auth from '/imports/ui/services/auth';
import { fetchStunTurnServers } from '/imports/utils/fetchStunTurnServers';
import {
  WEBRTC_CALL_TYPE_FULL_AUDIO,
  WEBRTC_CALL_TYPE_SCREEN_SHARE,
  WEBRTC_CALL_TYPE_STANDARD,
} from './constants';
import { callNativeMethod, installNativeMethodCallResult } from './native-bridge';
import { screenshareUsesNativePeer } from './screenshare-route';

function asError(error, fallbackMessage) {
  if (error instanceof Error) return error;
  const message = (error && error.message) || fallbackMessage;
  const wrapped = new Error(message);
  if (error && error.name) wrapped.name = error.name;
  return wrapped;
}

function defineGetter(target, property, get) {
  Object.defineProperty(target, property, {
    configurable: true,
    get,
  });
}

// Must run at import time: patches navigator/RTCPeerConnection before
// ScreenshareBridgeService and peers inspect them.
(function installTabletWebRtcPatches() {
  if (!browserInfo.isTabletApp) return;

  logger.debug('BBB-MOBILE - Mobile APP detected');
  installNativeMethodCallResult();

  const originalNavigatorGetDisplayMedia = typeof navigator.getDisplayMedia === 'function'
    ? navigator.getDisplayMedia.bind(navigator)
    : null;
  const originalMediaDevicesGetDisplayMedia = navigator.mediaDevices
    && typeof navigator.mediaDevices.getDisplayMedia === 'function'
    ? navigator.mediaDevices.getDisplayMedia.bind(navigator.mediaDevices)
    : null;

  const nativeScreenStream = {};
  const nativeListeners = {
    icecandidate: new Map(),
    signalingstatechange: new Map(),
  };

  function resolveWebRtcCallType(peerConnection) {
    if (peerConnection.webRtcCallType === undefined) {
      return WEBRTC_CALL_TYPE_STANDARD;
    }
    return peerConnection.webRtcCallType;
  }

  function isStandardPeer(peerConnection) {
    return resolveWebRtcCallType(peerConnection) === WEBRTC_CALL_TYPE_STANDARD;
  }

  function listenerFor(event) {
    const listeners = nativeListeners[event];
    if (!listeners) return null;
    return listeners.get(WEBRTC_CALL_TYPE_SCREEN_SHARE)
      || listeners.get(WEBRTC_CALL_TYPE_FULL_AUDIO)
      || null;
  }

  function rememberListener(event, peerConnection, callback) {
    const listeners = nativeListeners[event];
    if (!listeners) return;
    listeners.set(resolveWebRtcCallType(peerConnection), { peerConnection, callback });
  }

  function browserGetDisplayMedia(constraints) {
    if (originalNavigatorGetDisplayMedia) {
      return originalNavigatorGetDisplayMedia(constraints);
    }
    if (originalMediaDevicesGetDisplayMedia) {
      return originalMediaDevicesGetDisplayMedia(constraints);
    }
    return Promise.reject(new Error('getDisplayMedia is not supported'));
  }

  function buildNativeScreenStream() {
    const fakeVideoTrack = {
      kind: 'video',
      enabled: true,
      readyState: 'live',
      onended: null,
      oninactive: null,
      applyConstraints() {
        return Promise.resolve();
      },
      addEventListener() {},
      stop() {
        this.readyState = 'ended';
      },
    };
    const videoTracks = [fakeVideoTrack];
    nativeScreenStream.getTracks = () => videoTracks;
    nativeScreenStream.getVideoTracks = () => videoTracks;
    nativeScreenStream.getAudioTracks = () => [];
    nativeScreenStream.active = true;
    return nativeScreenStream;
  }

  function publishNativeIceState(peerConnection) {
    try {
      defineGetter(peerConnection, 'iceGatheringState', () => 'complete');
      defineGetter(peerConnection, 'iceConnectionState', () => 'completed');
      if (peerConnection.onicegatheringstatechange) {
        peerConnection.onicegatheringstatechange({ target: peerConnection });
      }
      if (peerConnection.oniceconnectionstatechange) {
        peerConnection.oniceconnectionstatechange({ target: peerConnection });
      }
    } catch (error) {
      logger.error('BBB-MOBILE - failed to publish native ICE state', asError(error, 'ICE state').message);
    }
  }

  navigator.getDisplayMedia = function getDisplayMedia(constraints) {
    logger.info('BBB-MOBILE - getDisplayMedia called', constraints);

    // LiveKit publishes this track on its room peer connection. That peer is
    // unstamped, so it must be a real capture. Native SDP routing is SFU-only.
    if (!screenshareUsesNativePeer()) {
      return browserGetDisplayMedia(constraints);
    }

    return callNativeMethod('initializeScreenShare')
      .then(() => buildNativeScreenStream())
      .catch((error) => {
        const wrapped = asError(error, 'initializeScreenShare failed');
        logger.error('Failure calling native initializeScreenShare', wrapped.message);
        throw wrapped;
      });
  };

  const { prototype } = window.RTCPeerConnection;

  prototype.originalCreateOffer = prototype.createOffer;
  prototype.createOffer = function createOffer(...args) {
    const webRtcCallType = resolveWebRtcCallType(this);
    if (webRtcCallType === WEBRTC_CALL_TYPE_STANDARD) {
      return prototype.originalCreateOffer.apply(this, args);
    }

    const [options] = args;
    logger.info('BBB-MOBILE - createOffer called', { options });
    const createOfferMethod = webRtcCallType === WEBRTC_CALL_TYPE_SCREEN_SHARE
      ? 'createScreenShareOffer'
      : 'createFullAudioOffer';

    return fetchStunTurnServers(Auth._authToken)
      .then((stunTurn) => callNativeMethod(createOfferMethod, [stunTurn]))
      .then((sdp) => {
        if (typeof sdp !== 'string' || sdp.length === 0) {
          throw new Error(`${createOfferMethod} returned an empty SDP`);
        }
        logger.info('BBB-MOBILE - createOffer resolved', { sdp });
        return { type: 'offer', sdp };
      });
  };

  prototype.originalCreateAnswer = prototype.createAnswer;
  prototype.createAnswer = function createAnswer(...args) {
    const webRtcCallType = resolveWebRtcCallType(this);
    if (webRtcCallType === WEBRTC_CALL_TYPE_STANDARD) {
      return prototype.originalCreateAnswer.apply(this, args);
    }

    // The shell has no answer API. Offerers hit this during ICE restart, after
    // setRemoteDescription has already forwarded the remote SDP. Answerers are
    // left unstamped and use the WebView peer for the whole negotiation.
    const [options] = args;
    logger.info('BBB-MOBILE - createAnswer called', { options, webRtcCallType });
    const sdp = this._localDescription && this._localDescription.sdp;
    if (typeof sdp !== 'string' || sdp.length === 0) {
      return Promise.reject(new Error('Native peer cannot create an answer'));
    }
    return Promise.resolve({ type: 'answer', sdp });
  };

  window.bbbMobileScreenShareIceCandidateCallback = function onNativeIceCandidate(...args) {
    logger.info('Received a bbbMobileScreenShareIceCandidateCallback call with arguments', args);
    const entry = listenerFor('icecandidate');
    if (entry && entry.callback) {
      entry.callback.apply(entry.peerConnection, args);
    }
    return true;
  };

  window.bbbMobileScreenShareSignalingStateChangeCallback = function onNativeSignalingState(
    newState,
  ) {
    const entry = listenerFor('signalingstatechange');
    if (!entry) return;
    try {
      defineGetter(entry.peerConnection, 'signalingState', () => newState);
    } catch (error) {
      logger.error('BBB-MOBILE - failed to set signalingState', asError(error, 'signalingState').message);
    }
    if (entry.callback) entry.callback.call(entry.peerConnection);
  };

  prototype.originalAddEventListener = prototype.addEventListener;
  prototype.addEventListener = function addEventListener(event, callback, ...rest) {
    if (isStandardPeer(this)) {
      return prototype.originalAddEventListener.call(this, event, callback, ...rest);
    }

    logger.info('BBB-MOBILE - addEventListener called', { event, callback });
    if (event === 'icecandidate' || event === 'signalingstatechange') {
      rememberListener(event, this, callback);
    }
    return undefined;
  };

  prototype.originalSetLocalDescription = prototype.setLocalDescription;
  prototype.setLocalDescription = function setLocalDescription(...args) {
    if (isStandardPeer(this)) {
      return prototype.originalSetLocalDescription.apply(this, args);
    }
    const [description, successCallback, failureCallback] = args;
    logger.info('BBB-MOBILE - setLocalDescription called', {
      description, successCallback, failureCallback,
    });

    if (description && typeof description.sdp === 'string' && description.sdp.length > 0) {
      this._localDescription = JSON.parse(JSON.stringify(description));
      defineGetter(this, 'localDescription', () => this._localDescription);
    }
    return Promise.resolve();
  };

  prototype.originalSetRemoteDescription = prototype.setRemoteDescription;
  prototype.setRemoteDescription = function setRemoteDescription(...args) {
    const webRtcCallType = resolveWebRtcCallType(this);
    if (webRtcCallType === WEBRTC_CALL_TYPE_STANDARD) {
      return prototype.originalSetRemoteDescription.apply(this, args);
    }

    const [description, successCallback, failureCallback] = args;
    logger.info('BBB-MOBILE - setRemoteDescription called', {
      description, successCallback, failureCallback,
    });
    const peerConnection = this;
    peerConnection._remoteDescription = JSON.parse(JSON.stringify(description));
    defineGetter(peerConnection, 'remoteDescription', () => peerConnection._remoteDescription);

    const setRemoteDescriptionMethod = webRtcCallType === WEBRTC_CALL_TYPE_SCREEN_SHARE
      ? 'setScreenShareRemoteSDP'
      : 'setFullAudioRemoteSDP';

    return callNativeMethod(setRemoteDescriptionMethod, [description])
      .then(() => {
        logger.info('BBB-MOBILE - setRemoteDescription resolved');
        if (webRtcCallType === WEBRTC_CALL_TYPE_FULL_AUDIO) {
          publishNativeIceState(peerConnection);
        }
      });
  };

  prototype.originalAddTrack = prototype.addTrack;
  prototype.addTrack = function addTrack(...args) {
    if (isStandardPeer(this)) {
      return prototype.originalAddTrack.apply(this, args);
    }
    const [description, successCallback, failureCallback] = args;
    logger.info('BBB-MOBILE - addTrack called', { description, successCallback, failureCallback });
    return undefined;
  };

  prototype.originalGetLocalStreams = prototype.getLocalStreams;
  prototype.getLocalStreams = function getLocalStreams(...args) {
    if (isStandardPeer(this)) {
      return prototype.originalGetLocalStreams.apply(this, args);
    }
    logger.info('BBB-MOBILE - getLocalStreams called', args);
    return [nativeScreenStream];
  };

  prototype.originalAddTransceiver = prototype.addTransceiver;
  prototype.addTransceiver = function addTransceiver(...args) {
    if (isStandardPeer(this)) {
      return prototype.originalAddTransceiver.apply(this, args);
    }
    logger.info('BBB-MOBILE - addTransceiver called', args);
    return undefined;
  };

  function forgetListener(peerConnection, event) {
    const listeners = nativeListeners[event];
    if (!listeners) return;
    const callType = resolveWebRtcCallType(peerConnection);
    const entry = listeners.get(callType);
    if (entry && entry.peerConnection === peerConnection) {
      listeners.delete(callType);
    }
  }

  prototype.originalClose = prototype.close;
  prototype.close = function close(...args) {
    if (!isStandardPeer(this)) {
      forgetListener(this, 'icecandidate');
      forgetListener(this, 'signalingstatechange');
    }
    return prototype.originalClose.apply(this, args);
  };

  prototype.originalAddIceCandidate = prototype.addIceCandidate;
  prototype.addIceCandidate = function addIceCandidate(candidate) {
    if (isStandardPeer(this)) {
      return prototype.originalAddIceCandidate.call(this, candidate);
    }
    logger.info('BBB-MOBILE - addIceCandidate called', { candidate });
    return callNativeMethod('addRemoteIceCandidate', [candidate])
      .then(() => {
        logger.info('BBB-MOBILE - addRemoteIceCandidate resolved');
      });
  };

  window.bbbMobileScreenShareBroadcastFinishedCallback = function onBroadcastFinished() {
    const stopButton = document.querySelector('[data-test="stopScreenShare"]');
    if (stopButton) stopButton.click();
  };
}());
