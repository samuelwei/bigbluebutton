import browserInfo from '/imports/utils/browserInfo';
import logger from '/imports/startup/client/logger';
import { callNativeMethod } from './native-bridge';

/**
 * Ask the tablet native shell to tear down broadcast upload.
 * Uses the shared bridge — does not import the RTCPeerConnection patch module.
 */
const onScreenshareStopRequest = () => {
  if (!browserInfo.isTabletApp) return;
  callNativeMethod('stopScreenShare').catch((error) => {
    const message = error && error.message ? error.message : error;
    logger.error(`Failure calling native stopScreenShare: ${message}`);
  });
};

export default onScreenshareStopRequest;
