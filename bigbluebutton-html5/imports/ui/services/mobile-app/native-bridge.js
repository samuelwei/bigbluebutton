import logger from '/imports/startup/client/logger';

const sequenceHolder = { sequence: 0 };
const promisesHolder = {};

/**
 * Invoke a method in the tablet native shell and return a promise settled by
 * window.nativeMethodCallResult (installed via installNativeMethodCallResult).
 * Side-effect-free to import: does not patch WebRTC.
 */
export function callNativeMethod(method, args = []) {
  const webView = window.ReactNativeWebView;
  if (!webView || typeof webView.postMessage !== 'function') {
    const error = new Error(`ReactNativeWebView is not available for ${method}`);
    logger.error(error.message, error);
    return Promise.reject(error);
  }

  sequenceHolder.sequence += 1;
  const { sequence } = sequenceHolder;

  return new Promise((resolve, reject) => {
    promisesHolder[sequence] = { resolve, reject };

    try {
      webView.postMessage(JSON.stringify({
        sequence,
        method,
        arguments: args,
      }));
    } catch (error) {
      delete promisesHolder[sequence];
      logger.error(`Error on callNativeMethod ${error.message}`, error);
      reject(error);
    }
  });
}

/**
 * Called by the native app to settle a callNativeMethod promise.
 * Install once when the tablet WebRTC bridge is armed.
 */
export function installNativeMethodCallResult() {
  window.nativeMethodCallResult = (sequence, isResolve, resultOrException) => {
    const promise = promisesHolder[sequence];
    if (promise) {
      if (isResolve) {
        promise.resolve(resultOrException);
      } else {
        promise.reject(resultOrException);
      }
      delete promisesHolder[sequence];
    }
    return true;
  };
}
