import React, {
  useEffect,
  useRef,
  useCallback,
  useMemo,
} from 'react';
import { defineMessages, useIntl } from 'react-intl';
import { toast } from 'react-toastify';
import {
  type LocalTrack,
  type RemoteParticipant,
  type RemoteTrack,
  type RemoteTrackPublication,
  type LocalTrackPublication,
  ConnectionState,
  RoomEvent,
  Track,
} from 'livekit-client';
import { useConnectionState, useTracks } from '@livekit/components-react';
import { debounce } from '/imports/utils/debounce';
import VideoService from '/imports/ui/components/video-provider/service';
import PreviewService from '/imports/ui/components/video-preview/service';
import { getCameraPublishOptions } from './service';
import VideoListContainer from '/imports/ui/components/video-provider/video-list/container';
import logger from '/imports/startup/client/logger';
import { notifyStreamStateChange } from '/imports/ui/services/bbb-webrtc-sfu/stream-state-service';
import BBBVideoStream from '/imports/ui/services/webrtc-base/bbb-video-stream';
import { GridItem, VideoItem } from '/imports/ui/components/video-provider/types';
import { Output } from '/imports/ui/components/layout/layoutTypes';
import { VIDEO_TYPES } from '/imports/ui/components/video-provider/enums';
import {
  lkIsCameraSource,
  liveKitRoomRegistry,
} from '/imports/ui/services/livekit';
import useMeetingSettings from '/imports/ui/core/local-states/useMeetingSettings';
import { notify } from '/imports/ui/services/notification';
import {
  expectStreamStop,
  consumeExpectedStreamStop,
} from '/imports/ui/components/video-provider/state';

// Survive React remounts (Strict Mode / HMR / GraphQL flaps). Instance refs alone
// allow two startStream calls to publishTrack the same MediaStreamTrack → Cancelled.
const publishingStreamIds = new Set<string>();
const publishedLocalTracks: Record<string, LocalTrack> = {};

const intlClientErrors = defineMessages({
  permissionError: {
    id: 'app.video.permissionError',
    description: 'Webcam permission error',
  },
  iceConnectionStateError: {
    id: 'app.video.iceConnectionStateError',
    description: 'Ice connection state failed',
  },
  virtualBgGenericError: {
    id: 'app.video.virtualBackground.genericError',
    description: 'Failed to apply camera effect',
  },
  inactiveError: {
    id: 'app.video.inactiveError',
    description: 'Camera stopped unexpectedly',
  },
  mediaTimedOutError: {
    id: 'app.video.mediaTimedOutError',
    description: 'Camera stream was interrupted',
  },
});

const CAMERA_STOPPED_TOAST_ID = 'livekit-camera-stopped';

const intlSFUErrors = defineMessages({
  2000: {
    id: 'app.sfu.mediaServerConnectionError2000',
    description: 'SFU connection to the media server',
  },
  2001: {
    id: 'app.sfu.mediaServerOffline2001',
    description: 'SFU is offline',
  },
});

interface LiveKitCameraBridgeProps {
  cameraDock: Output['cameraDock'];
  focusedId: string;
  handleVideoFocus: (id: string) => void;
  isGridEnabled: boolean;
  isClientConnected: boolean;
  isUserLocked: boolean;
  currentVideoPageIndex: number;
  streams: VideoItem[];
  playStart: (cameraId: string) => void;
  exitVideo: (expected?: boolean) => void;
  lockUser: () => void;
  stopVideo: (cameraId?: string, expected?: boolean) => void;
  overflowCount: number;
  overflowUsers: GridItem[];
}

interface LiveKitCameraBridgeRefs {
  connectingStreams: Record<string, boolean>;
  remoteTracks: Record<string, RemoteTrack<Track.Kind>>;
  localTracks: Record<string, LocalTrack<Track.Kind>>;
  localVideoStreams: Record<string, BBBVideoStream>;
  videoTags: Record<string, HTMLVideoElement>;
  publications: Map<string, RemoteTrackPublication | LocalTrackPublication>;
  subscriptions: Map<string, {
    track: RemoteTrack;
    publication: RemoteTrackPublication;
  }>;
}

const LiveKitCameraBridge: React.FC<LiveKitCameraBridgeProps> = ({
  cameraDock,
  focusedId,
  handleVideoFocus,
  isGridEnabled,
  isClientConnected,
  isUserLocked,
  currentVideoPageIndex,
  streams,
  playStart,
  exitVideo,
  lockUser,
  stopVideo,
  overflowCount,
  overflowUsers,
}) => {
  const intl = useIntl();
  const room = liveKitRoomRegistry.getPrimary();
  const connectionState = useConnectionState(room);
  const cameraTracks = useTracks([Track.Source.Camera], {
    room,
    onlySubscribed: false,
    updateOnlyOn: [
      RoomEvent.TrackPublished, RoomEvent.TrackUnpublished,
      RoomEvent.TrackSubscribed, RoomEvent.TrackUnsubscribed,
      RoomEvent.TrackSubscriptionStatusChanged, RoomEvent.TrackSubscriptionPermissionChanged,
      RoomEvent.TrackSubscriptionFailed,
      RoomEvent.ConnectionStateChanged,
    ],
  });
  const [meetingSettings] = useMeetingSettings();
  const watchedRemoteTracks = useRef(new WeakSet<MediaStreamTrack>());
  const bridgeRefs = useRef<LiveKitCameraBridgeRefs>({
    remoteTracks: {},
    localTracks: {},
    connectingStreams: {},
    localVideoStreams: {},
    videoTags: {},
    publications: new Map(),
    subscriptions: new Map(),
  });
  // This is a hacky way to break circular deps between some effects and callbacks - prlanzarin
  const streamsRef = useRef(streams);
  streamsRef.current = streams;

  const withSelectiveSubscription = meetingSettings.public.media?.livekit?.selectiveSubscription?.enabled ?? true;

  // Streams whose failures were already surfaced to the end user. Avoids trailing toasts.
  const announcedFailures = useRef(new Set<string>());
  // Intentional / in-progress teardowns — MediaStream.stop() fires `inactive`, which
  // must not be treated as a user-facing unexpected camera failure.
  const tearingDownStreams = useRef(new Set<string>());
  // Transient publish retries per stream id (Cancelled / TrackInvalid / reconnect).
  const publishRetryCounts = useRef(new Map<string, number>());
  const MAX_PUBLISH_RETRIES = 3;

  const handleStreamFailure = useCallback((error: Error, stream: string, isLocal: boolean) => {
    // destroyStream / intentional unshare already owns this camera
    if (tearingDownStreams.current.has(stream)) return;

    const { name: errorName, message: errorMessage } = error;
    const errorLocale = intlClientErrors[errorName as keyof typeof intlClientErrors]
      || intlClientErrors[errorMessage as keyof typeof intlClientErrors]
      || intlSFUErrors[error as unknown as keyof typeof intlSFUErrors];

    logger.error({
      logCode: 'livekit_camera_failure',
      extraInfo: {
        cameraId: stream,
        role: VideoService.getRole(isLocal),
        errorName: error.name,
        errorMessage: error.message,
        errorStack: error.stack,
      },
    }, `LiveKit: camera failure ${errorName} - ${errorMessage}`);

    if (isLocal) {
      if (errorLocale) announcedFailures.current.add(stream);

      stopStream(stream, false);

      if (errorLocale) VideoService.notify(intl.formatMessage(errorLocale));
    } else {
      const stillExists = streamsRef.current.some(
        (item) => item.type === VIDEO_TYPES.STREAM && item.stream === stream,
      );
      stopStream(stream, stillExists);
    }
  }, [intl]);

  const handleLocalStreamInactive = useCallback((stream: string) => {
    const track = bridgeRefs.current.localTracks[stream];
    const isLocal = VideoService.isLocalStream(stream);

    if (track == null || !isLocal) return;
    // Intentional unshare stops the MediaStream → `inactive`. That is not a failure.
    if (tearingDownStreams.current.has(stream)) return;

    handleStreamFailure(
      new Error('inactiveError'),
      stream,
      isLocal,
    );
  }, [handleStreamFailure]);

  const stopStream = useCallback((stream: string, restarting = false) => {
    const isLocal = VideoService.isLocalStream(stream);
    const role = VideoService.getRole(isLocal);

    logger.info({
      logCode: 'livekit_camera_feed_stop_requested',
      extraInfo: { role, cameraId: stream, restarting },
    }, `LiveKit: camera stop requested. Role ${role}, restarting ${restarting}`);

    if (isLocal) {
      if (restarting) expectStreamStop(stream);

      stopVideo(stream, restarting);
    }

    destroyStream(stream);
  }, [stopVideo]);

  const unsubscribeFromRemotePub = (
    stream: string,
    publication: RemoteTrackPublication,
  ) => {
    const track = bridgeRefs.current.remoteTracks[stream];

    if (track) track.detach();
    if (publication?.isSubscribed && withSelectiveSubscription) {
      publication.setSubscribed(false);
    }
  };

  const unpublishLocalCameraByStream = async (stream: string) => {
    const localRoom = liveKitRoomRegistry.getPrimary();
    if (!localRoom) return;

    const tracked = bridgeRefs.current.localTracks[stream];
    const unpublishJobs: Promise<void>[] = [];

    localRoom.localParticipant.videoTrackPublications.forEach((pub: LocalTrackPublication) => {
      if (!lkIsCameraSource(pub) || !pub.track) return;

      // Match by stream name / LiveKit sid only — matching MediaStreamTrack.id would
      // cancel an in-flight republish of the same camera capture.
      const matchesName = pub.trackName === stream;
      const matchesSid = !!tracked && tracked.sid === pub.track.sid;

      if (!matchesName && !matchesSid) return;

      unpublishJobs.push(
        localRoom.localParticipant.unpublishTrack(pub.track)
          .then(() => {
            logger.debug({
              logCode: 'livekit_camera_unpublished',
              extraInfo: {
                cameraId: stream,
                trackName: pub.trackName,
                trackSid: pub?.trackSid,
              },
            }, `LiveKit: camera unpublished - ${pub.trackSid}`);
          })
          .catch((error) => {
            logger.error({
              logCode: 'livekit_camera_unpublish_error',
              extraInfo: {
                cameraId: stream,
                trackName: pub.trackName,
                trackSid: pub.trackSid,
                errorMessage: error.message,
                errorStack: error.stack,
              },
            }, `LiveKit: failed to unpublish track: ${error.message}`);
          })
          .finally(() => {
            bridgeRefs.current.publications.delete(pub.trackName);
          }),
      );
    });

    await Promise.all(unpublishJobs);
  };

  const destroyStream = (stream: string) => {
    const localStream = bridgeRefs.current.localVideoStreams[stream];
    const publication = bridgeRefs.current.publications.get(stream);
    const isLocal = VideoService.isLocalStream(stream);
    const wasPublished = !!bridgeRefs.current.localTracks[stream];
    const wasConnecting = !!bridgeRefs.current.connectingStreams[stream];

    tearingDownStreams.current.add(stream);

    try {
      if (localStream) {
        if (typeof localStream.inactivationHandler === 'function') {
          localStream.removeListener('inactive', localStream.inactivationHandler);
        }
        // `once('inactive', …)` wraps the handler — removeListener alone can miss it.
        // Clear before stop() so intentional unshare does not surface inactiveError.
        if (typeof localStream.removeAllListeners === 'function') {
          localStream.removeAllListeners('inactive');
        }

        // Publish failures / in-flight teardown run destroyStream before localTracks is
        // set. Stopping the preloaded BBBVideoStream empties VIDEO_STREAM_STORAGE and
        // leaves retries with "no preloaded camera stream to publish".
        if (wasPublished) {
          localStream.stop();
        }
      }

      if (isLocal) {
        const alreadyAnnounced = announcedFailures.current.delete(stream);
        const wasExpected = consumeExpectedStreamStop(stream);
        // Intentional unshare removes the stream from the GraphQL list first, then
        // updateStreams → destroyStream. By then expectStreamStop may already have
        // been consumed by a parallel teardown — "still in streamsRef" is the
        // reliable signal that this stop was unexpected (media died while wanted).
        const stillWanted = streamsRef.current.some((item) => item.stream === stream);

        if (wasPublished && !wasConnecting && !alreadyAnnounced && !wasExpected && stillWanted) {
          logger.warn({
            logCode: 'livekit_camera_stopped_unexpectedly',
            extraInfo: { cameraId: stream },
          }, 'LiveKit: camera stopped without the user asking');
          notify(
            intl.formatMessage(intlClientErrors.mediaTimedOutError),
            'error',
            'video',
            { autoClose: false, toastId: CAMERA_STOPPED_TOAST_ID },
          );
        }

        // Never unpublish while publishTrack may still be in flight. Doing so cancels
        // pendingTrackResolvers ("Cancelled publication" / "missing track resolver").
        // A second destroyStream after the connecting flag was cleared used to fall
        // through and unpublish mid-publish — keep all !wasPublished paths here.
        // Keep localVideoStreams so a still-wanted publish can attach to <video>.
        if (!wasPublished) {
          bridgeRefs.current.connectingStreams[stream] = false;
          delete bridgeRefs.current.connectingStreams[stream];
          return;
        }

        void unpublishLocalCameraByStream(stream);

        delete bridgeRefs.current.localTracks[stream];
        delete publishedLocalTracks[stream];
        publishingStreamIds.delete(stream);
        delete bridgeRefs.current.localVideoStreams[stream];
        delete bridgeRefs.current.connectingStreams[stream];
      } else if (publication) {
        unsubscribeFromRemotePub(stream, publication as RemoteTrackPublication);
      }
    } finally {
      tearingDownStreams.current.delete(stream);
    }
  };

  const attachLiveKitStream = (stream: string) => {
    const videoElement = bridgeRefs.current.videoTags[stream];
    const isLocal = VideoService.isLocalStream(stream);

    if (!videoElement) return;

    if (isLocal) {
      const localStream = bridgeRefs.current.localVideoStreams[stream];
      const localTrack = bridgeRefs.current.localTracks[stream]
        ?? publishedLocalTracks[stream];

      // Prefer the BBB preview MediaStream; after remount / spurious destroyStream
      // localVideoStreams may be gone while the LiveKit LocalTrack is still live.
      if (localStream?.mediaStream?.active) {
        videoElement.pause();
        videoElement.srcObject = localStream.mediaStream;
        videoElement.load();
        notifyStreamStateChange(stream, 'completed');
      } else if (localTrack?.attach) {
        localTrack.attach(videoElement);
        notifyStreamStateChange(stream, 'completed');
      } else if (localTrack?.mediaStreamTrack) {
        videoElement.pause();
        videoElement.srcObject = new MediaStream([localTrack.mediaStreamTrack]);
        videoElement.load();
        notifyStreamStateChange(stream, 'completed');
      }
    } else {
      const track = bridgeRefs.current.remoteTracks[stream];

      if (track?.attach) {
        track.attach(videoElement);
        notifyStreamStateChange(stream, 'completed');
      }
    }
  };

  const findRemoteCameraPublication = (stream: string): RemoteTrackPublication | undefined => {
    let found: RemoteTrackPublication | undefined;

    liveKitRoomRegistry.getPrimary()?.remoteParticipants.forEach((participant: RemoteParticipant) => {
      participant.videoTrackPublications.forEach((publication: RemoteTrackPublication) => {
        if (!found && lkIsCameraSource(publication) && publication.trackName === stream) found = publication;
      });
    });

    return found;
  };

  const subscribeToRemotePub = (stream: string) => {
    // Pull the remote publish fresh to avoid staleness during reconnects
    const remotePub = findRemoteCameraPublication(stream);
    const publication = remotePub
      ?? (bridgeRefs.current.publications.get(stream) as RemoteTrackPublication | undefined);

    if (remotePub) bridgeRefs.current.publications.set(stream, remotePub);

    // If a publication is not present yet, it will be added when we receive
    // the publish event from the server and this function will be called again
    if (publication) {
      if (publication.isSubscribed) {
        attachLiveKitStream(stream);
        notifyStreamStateChange(stream, 'completed');
        return;
      }

      if (withSelectiveSubscription) {
        publication.setSubscribed(true);
      }
    }
  };

  const startStream = useCallback(async (stream: string, isLocal: boolean) => {
    if (bridgeRefs.current.localTracks[stream] || bridgeRefs.current.connectingStreams[stream]) return;

    if (!isLocal) {
      subscribeToRemotePub(stream);
      return;
    }

    // Remount-safe: another instance already published or is publishing this camera.
    if (publishedLocalTracks[stream]) {
      bridgeRefs.current.localTracks[stream] = publishedLocalTracks[stream];
      const deviceId = VideoService.getDeviceIdFromStreamName(stream);
      const stored = deviceId ? PreviewService.getStream(deviceId) : null;
      if (stored) bridgeRefs.current.localVideoStreams[stream] = stored;
      attachLiveKitStream(stream);
      notifyStreamStateChange(stream, 'completed');
      playStart(stream);
      return;
    }
    if (publishingStreamIds.has(stream)) return;

    bridgeRefs.current.connectingStreams[stream] = true;
    publishingStreamIds.add(stream);

    try {
      const deviceId = VideoService.getDeviceIdFromStreamName(stream);
      // stopConnectingStream clears VideoService.deviceId on publish failure; resolve
      // the stored preview from the stream name so retries still find it.
      if (deviceId) VideoService.setDeviceId(deviceId);

      let localBBBStream = VideoService.getPreloadedStream(deviceId);
      let mediaStream = localBBBStream?.mediaStream;
      let videoTracks = mediaStream?.getVideoTracks().filter((t) => t.readyState === 'live') ?? [];

      // Preview handoff can be missing after a failed/cancelled publish cleared
      // VIDEO_STREAM_STORAGE. Acquire a fresh capture so share can still proceed.
      if (!deviceId) throw new Error('LiveKit: cannot resolve deviceId for camera stream');
      if (!localBBBStream || videoTracks.length === 0) {
        logger.warn({
          logCode: 'livekit_camera_preload_missing',
          extraInfo: { cameraId: stream, deviceId, hadStream: !!localBBBStream },
        }, 'LiveKit: no usable preloaded camera stream, acquiring via getUserMedia');
        const profile = VideoService.getCameraProfile();
        localBBBStream = await PreviewService.doGUM(deviceId, profile);
        PreviewService.storeStream(deviceId, localBBBStream);
        mediaStream = localBBBStream.mediaStream;
        videoTracks = mediaStream?.getVideoTracks().filter((t) => t.readyState === 'live') ?? [];
      }

      if (!localBBBStream || !mediaStream || videoTracks.length === 0) {
        throw new Error('LiveKit: no live video track to publish');
      }

      bridgeRefs.current.localVideoStreams[stream] = localBBBStream;

      const LIVEKIT_SETTINGS = meetingSettings.public.media.livekit?.camera;
      const basePubOptions = {
        dtx: true,
        videoCodec: 'vp8' as const,
        ...LIVEKIT_SETTINGS?.publishOptions,
      };
      const simulcastOptions = getCameraPublishOptions(mediaStream);
      const publishOptions = {
        ...basePubOptions,
        ...simulcastOptions,
        source: Track.Source.Camera,
        name: stream,
      };

      const publishRoom = liveKitRoomRegistry.getPrimary();

      if (!publishRoom) throw new Error('LiveKit room not available');

      if (publishRoom.state !== ConnectionState.Connected) {
        throw new Error('LiveKit: room not connected');
      }

      // Guard: destroyed while we prepared
      if (!bridgeRefs.current.connectingStreams[stream]) {
        publishingStreamIds.delete(stream);
        return;
      }

      const [track] = videoTracks;

      const findExistingLocalPub = (): LocalTrackPublication | undefined => {
        let found: LocalTrackPublication | undefined;
        publishRoom.localParticipant.videoTrackPublications.forEach((pub) => {
          if (found || !lkIsCameraSource(pub) || !pub.track) return;
          const sameName = pub.trackName === stream;
          const sameMediaTrack = pub.track.mediaStreamTrack?.id === track.id;
          if (sameName || sameMediaTrack) found = pub;
        });
        return found;
      };

      // A prior attempt may have landed on the SFU while the client saw Cancelled /
      // missing track resolver. Reuse that publication instead of republishing.
      let publication = findExistingLocalPub();

      if (!publication) {
        try {
          publication = await publishRoom.localParticipant.publishTrack(track, publishOptions);
        } catch (error) {
          const err = error as Error;
          const alreadyPublished = err?.name === 'TrackInvalidError'
            || err?.message?.includes('same ID has already been published');

          if (!alreadyPublished) throw error;

          publication = findExistingLocalPub();
          if (!publication) {
            // Clear by MediaStreamTrack — name-based unpublish misses orphan pubs
            // left after Cancelled / missing track resolver.
            try {
              await publishRoom.localParticipant.unpublishTrack(track);
            } catch (unpubErr) {
              logger.debug({
                logCode: 'livekit_camera_unpublish_stale_track',
                extraInfo: {
                  cameraId: stream,
                  errorMessage: (unpubErr as Error).message,
                },
              }, 'LiveKit: stale track unpublish before retry');
            }
            await unpublishLocalCameraByStream(stream);
            if (!bridgeRefs.current.connectingStreams[stream]) throw error;

            // Fresh capture → new MediaStreamTrack id, avoids TrackInvalidError loops
            const profile = VideoService.getCameraProfile();
            localBBBStream = await PreviewService.doGUM(deviceId, profile);
            PreviewService.storeStream(deviceId, localBBBStream);
            bridgeRefs.current.localVideoStreams[stream] = localBBBStream;
            const freshTracks = localBBBStream.mediaStream?.getVideoTracks()
              .filter((t) => t.readyState === 'live') ?? [];
            if (freshTracks.length === 0) throw error;
            publication = await publishRoom.localParticipant.publishTrack(
              freshTracks[0],
              publishOptions,
            );
          }
        }
      }

      if (publication == null || publication?.track == null) {
        throw new Error('Failed to publish track: publication or track is missing');
      }

      logger.debug({
        logCode: 'livekit_camera_published',
        extraInfo: {
          cameraId: stream,
          trackName: publication?.trackName,
          trackSid: publication?.trackSid,
        },
      }, `LiveKit: camera published - ${publication?.trackSid}`);

      // Connecting flag cleared while publish was in flight (spurious destroyStream /
      // list flap). Keep the track if the camera is still wanted; only drop it when
      // the user actually stopped sharing.
      if (!bridgeRefs.current.connectingStreams[stream]) {
        const stillWanted = streamsRef.current.some((item) => item.stream === stream);
        if (!stillWanted) {
          await publishRoom.localParticipant.unpublishTrack(publication.track);
          delete publishedLocalTracks[stream];
          publishingStreamIds.delete(stream);
          return;
        }
      }

      bridgeRefs.current.localTracks[stream] = publication.track;
      publishedLocalTracks[stream] = publication.track;
      publishRetryCounts.current.delete(stream);
      consumeExpectedStreamStop(stream);
      announcedFailures.current.delete(stream);
      toast.dismiss(CAMERA_STOPPED_TOAST_ID);
      localBBBStream.on('streamSwapped', ({ newStream }: { oldStream: MediaStream, newStream: MediaStream }) => {
        if (newStream) replaceVideoTracks(stream, newStream);
      });
      localBBBStream.inactivationHandler = () => handleLocalStreamInactive(stream);
      localBBBStream.once('inactive', localBBBStream.inactivationHandler);

      playStart(stream);
      attachLiveKitStream(stream);
      notifyStreamStateChange(stream, 'completed');
    } catch (error) {
      const err = error as Error;
      const deviceId = VideoService.getDeviceIdFromStreamName(stream);
      const bbbStream = bridgeRefs.current.localVideoStreams[stream]
        ?? (deviceId ? PreviewService.getStream(deviceId) : null);
      if (deviceId && bbbStream?.mediaStream?.active) {
        PreviewService.storeStream(deviceId, bbbStream);
        VideoService.setDeviceId(deviceId);
        bridgeRefs.current.localVideoStreams[stream] = bbbStream;
      }

      // Transient: unpublish raced us, or LiveKit reconnect cleared pending resolvers.
      // Keep the preload + stream list entry so updateStreams can retry — do not stopVideo.
      const transient = err?.message?.includes('Cancelled publication')
        || err?.message?.includes('room not connected')
        || err?.message?.includes('timed out')
        || err?.name === 'TrackInvalidError'
        || err?.message?.includes('same ID has already been published');

      const retries = publishRetryCounts.current.get(stream) ?? 0;
      const canRetry = transient
        && retries < MAX_PUBLISH_RETRIES
        && streamsRef.current.some((item) => item.stream === stream);
      let willRetry = false;
      if (canRetry) {
        willRetry = true;
        publishRetryCounts.current.set(stream, retries + 1);
        logger.warn({
          logCode: 'livekit_camera_publish_transient',
          extraInfo: {
            cameraId: stream,
            errorName: err.name,
            errorMessage: err.message,
            retry: retries + 1,
          },
        }, `LiveKit: transient camera publish failure, will retry - ${err.message}`);
        // Keep connectingStreams true across the delay so updateStreams does not
        // treat this camera as disconnected and tear down a parallel attempt.
        bridgeRefs.current.connectingStreams[stream] = true;
        // Release the module lock so the delayed startStream can enter again.
        publishingStreamIds.delete(stream);
        setTimeout(() => {
          if (bridgeRefs.current.localTracks[stream] || publishedLocalTracks[stream]) {
            bridgeRefs.current.connectingStreams[stream] = false;
            if (publishedLocalTracks[stream]) {
              bridgeRefs.current.localTracks[stream] = publishedLocalTracks[stream];
            }
            return;
          }
          if (!streamsRef.current.some((item) => item.stream === stream)) {
            bridgeRefs.current.connectingStreams[stream] = false;
            return;
          }
          bridgeRefs.current.connectingStreams[stream] = false;
          startStream(stream, true);
        }, 500 * (retries + 1));
      } else {
        publishRetryCounts.current.delete(stream);
        handleStreamFailure(err, stream, isLocal);
      }

      if (!willRetry) {
        bridgeRefs.current.connectingStreams[stream] = false;
        publishingStreamIds.delete(stream);
      }
      return;
    }
    bridgeRefs.current.connectingStreams[stream] = false;
    publishingStreamIds.delete(stream);
  }, [handleLocalStreamInactive, handleStreamFailure, playStart]);

  const watchRemoteTrackEnd = (mediaStreamTrack: MediaStreamTrack) => {
    if (mediaStreamTrack == null) return;
    if (watchedRemoteTracks.current.has(mediaStreamTrack)) return;

    watchedRemoteTracks.current.add(mediaStreamTrack);

    const onEnded = () => {
      const carried = Object.entries(bridgeRefs.current.remoteTracks)
        .find(([, track]) => track.mediaStreamTrack === mediaStreamTrack);

      if (!carried) return;

      const [stream, track] = carried;
      logger.debug({
        logCode: 'livekit_camera_track_ended',
        extraInfo: { cameraId: stream, trackSid: track.sid },
      }, `LiveKit: camera track ended - ${track.sid}`);

      // Failed makes the camera container render the placeholder instead
      notifyStreamStateChange(stream, 'failed');
    };

    if (mediaStreamTrack.readyState === 'ended') {
      onEnded();
      return;
    }

    mediaStreamTrack.addEventListener('ended', onEnded, { once: true });
  };

  const handleTrackSubscribed = (
    track: RemoteTrack,
    publication: RemoteTrackPublication,
  ) => {
    const { trackSid } = publication;

    if (!lkIsCameraSource(track)) return;

    bridgeRefs.current.subscriptions.set(trackSid, { track, publication });

    if (track?.kind === 'video' && publication) {
      const stream = publication.trackName;
      bridgeRefs.current.remoteTracks[stream] = track;
      attachLiveKitStream(stream);
      watchRemoteTrackEnd(track?.mediaStreamTrack);
      logger.info({
        logCode: 'livekit_camera_subscribed',
        extraInfo: {
          cameraId: stream,
          trackName: publication.trackName,
          trackSid: publication.trackSid,
        },
      }, `LiveKit: camera subscribed - ${trackSid}`);
    }
  };

  const handleTrackUnsubscribed = (
    track: RemoteTrack,
    publication: RemoteTrackPublication,
  ) => {
    const { trackSid } = publication;

    if (!lkIsCameraSource(track)) return;

    bridgeRefs.current.subscriptions.delete(trackSid);
    const stream = publication?.trackName;

    logger.info({
      logCode: 'livekit_camera_unsubscribed',
      extraInfo: {
        cameraId: stream,
        trackName: publication.trackName,
        trackSid: publication.trackSid,
      },
    }, `LiveKit: camera unsubscribed - ${trackSid}`);

    // Failed makes the camera container render the placeholder instead
    notifyStreamStateChange(stream, 'failed');

    delete bridgeRefs.current.remoteTracks[stream];
  };

  const handleTrackPublished = useCallback((publication: RemoteTrackPublication) => {
    const { trackName, trackSid } = publication;

    if (!lkIsCameraSource(publication)) return;
    // A republished stream carries a new sid; let it replace the cached entry.
    if (bridgeRefs.current.publications.get(trackName)?.trackSid === trackSid) return;

    bridgeRefs.current.publications.set(trackName, publication);

    if (publication.track) bridgeRefs.current.remoteTracks[trackName] = publication.track;

    const isLocal = VideoService.isLocalStream(trackName);
    // If the track is remote, should be subscribed to and is not already,
    // subscribe to it
    if (!isLocal
      && !publication.isSubscribed
      && streamsRef.current.some(
        (item) => item.type === VIDEO_TYPES.STREAM && item.stream === trackName,
      )) {
      subscribeToRemotePub(trackName);
    }
  }, []);

  const handleTrackUnpublished = (publication: RemoteTrackPublication) => {
    const { trackSid, trackName } = publication;

    if (!lkIsCameraSource(publication)) return;

    bridgeRefs.current.publications.delete(trackName);
    bridgeRefs.current.subscriptions.delete(trackSid);
  };

  const syncLiveKitRefs = useCallback((clearRefs = true) => {
    if (clearRefs) {
      bridgeRefs.current.publications.clear();
      bridgeRefs.current.subscriptions.clear();
    }

    liveKitRoomRegistry.getPrimary()?.remoteParticipants.forEach((participant: RemoteParticipant) => {
      participant.trackPublications.forEach((publication: RemoteTrackPublication) => {
        if (lkIsCameraSource(publication)) {
          handleTrackPublished(publication);

          if (publication.isSubscribed && publication.track) {
            handleTrackSubscribed(publication.track, publication);
          }
        }
      });
    });
  }, [handleTrackPublished]);

  useEffect(() => {
    if (connectionState === ConnectionState.Connected) {
      // On reconnection, clear refs to start fresh as old refs
      // might be stale and won't work for subscriptions anymore
      const isReconnection = bridgeRefs.current.publications.size > 0
        || bridgeRefs.current.subscriptions.size > 0;
      syncLiveKitRefs(isReconnection);
    }
  }, [connectionState, syncLiveKitRefs]);

  useEffect(() => {
    const evtRoom = liveKitRoomRegistry.getPrimary();

    if (!evtRoom) return undefined;

    evtRoom.on(RoomEvent.TrackPublished, handleTrackPublished);

    return () => {
      evtRoom.off(RoomEvent.TrackPublished, handleTrackPublished);
    };
  }, [handleTrackPublished]);

  useEffect(() => {
    const evtRoom = liveKitRoomRegistry.getPrimary();
    const handleBeforeUnload = () => exitVideo();

    window.addEventListener('beforeunload', handleBeforeUnload);
    evtRoom?.on(RoomEvent.TrackUnpublished, handleTrackUnpublished);
    evtRoom?.on(RoomEvent.TrackSubscribed, handleTrackSubscribed);
    evtRoom?.on(RoomEvent.TrackUnsubscribed, handleTrackUnsubscribed);

    return () => {
      window.removeEventListener('beforeunload', handleBeforeUnload);
      evtRoom?.off(RoomEvent.TrackUnpublished, handleTrackUnpublished);
      evtRoom?.off(RoomEvent.TrackSubscribed, handleTrackSubscribed);
      evtRoom?.off(RoomEvent.TrackUnsubscribed, handleTrackUnsubscribed);

      VideoService.updatePeerDictionaryReference({});
      // Mark local stops expected so destroyStream does not toast mediaTimedOutError
      // when HMR / transient unmount races a still-populated streamsRef.
      Object.keys(bridgeRefs.current.localTracks).forEach((stream) => {
        expectStreamStop(stream);
      });
      exitVideo(true);
      Object.keys(bridgeRefs.current.localTracks).forEach((stream) => {
        stopStream(stream, true);
      });
      Object.keys(bridgeRefs.current.remoteTracks).forEach((stream) => {
        stopStream(stream, false);
      });
      bridgeRefs.current.publications.clear();
      bridgeRefs.current.subscriptions.clear();
    };
  }, []);

  const connectStreams = useCallback((streamsToConnect: string[]) => {
    streamsToConnect.forEach((stream) => {
      const isLocal = VideoService.isLocalStream(stream);
      startStream(stream, isLocal);
    });
  }, [startStream]);

  const destroyStreams = (streamsToDisconnect: string[]) => {
    streamsToDisconnect.forEach(destroyStream);
  };

  // We're using a ref to avoid recreating the debounced function on every render
  // If that were the case, we'd lose the timer reference for the debounce and
  // it wouldn't work as expected (ie.: no debounce) - prlanzarin
  const connectStreamsRef = useRef(connectStreams);
  connectStreamsRef.current = connectStreams;
  const debouncedConnectStreams = useMemo(
    () => debounce(
      (streamsToConnect: string[]) => connectStreamsRef.current(streamsToConnect),
      VideoService.getPageChangeDebounceTime(),
      { leading: false, trailing: true },
    ),
    [],
  );

  const updateStreams = useCallback((streamsList: VideoItem[], shouldDebounce = false) => {
    // Count in-flight publishes as connected. Otherwise a streams/cameraTracks
    // re-render disconnects+reconnects mid-publish and LiveKit throws
    // TrackInvalidError ("a track with the same ID has already been published").
    const connectingIds = Object.keys(bridgeRefs.current.connectingStreams)
      .filter((id) => bridgeRefs.current.connectingStreams[id]);
    const connectedStreamIds = [
      ...Object.keys(bridgeRefs.current.localTracks),
      ...Object.keys(bridgeRefs.current.remoteTracks),
      ...connectingIds,
    ];
    const [
      streamsToConnect,
      streamsToDisconnect,
    ] = VideoService.getStreamsToConnectAndDisconnect(streamsList, connectedStreamIds);

    if (shouldDebounce) {
      debouncedConnectStreams(streamsToConnect);
    } else {
      connectStreams(streamsToConnect);
    }

    destroyStreams(streamsToDisconnect);
  }, [connectStreams, debouncedConnectStreams]);

  const replaceVideoTracks = (streamId: string, mediaStream: MediaStream) => {
    const track = bridgeRefs.current.localTracks[streamId];
    const videoElement = bridgeRefs.current.videoTags[streamId];

    if (track && track.replaceTrack && videoElement) {
      const newTracks = mediaStream.getVideoTracks();
      track.replaceTrack(newTracks[0]).then(() => {
        attachLiveKitStream(streamId);
      }).catch((error) => {
        logger.error({
          logCode: 'livekit_camera_replace_track_error',
          extraInfo: {
            cameraId: streamId,
            trackSid: track?.sid,
            errorMessage: error.message,
            errorStack: error.stack,
          },
        }, `LiveKit: failed to replace camera track - ${error.message}`);
      });
    }
  };

  // Downstream prop - useCallback to make it stable
  const createVideoTag = useCallback((stream: string, video: HTMLVideoElement) => {
    const isLocal = VideoService.isLocalStream(stream);
    const track = isLocal
      ? bridgeRefs.current.localTracks[stream]
      : bridgeRefs.current.remoteTracks[stream];

    bridgeRefs.current.videoTags[stream] = video;

    if (track) attachLiveKitStream(stream);
  }, []);

  // Downstream prop - useCallback to make it stable
  const destroyVideoTag = useCallback((stream: string) => {
    const videoElement = bridgeRefs.current.videoTags[stream];

    if (videoElement == null) return;

    if (typeof videoElement.pause === 'function') {
      videoElement.pause();
      videoElement.srcObject = null;
    }

    delete bridgeRefs.current.videoTags[stream];
  }, []);

  const startVirtualBackgroundByDrop = useCallback(async (
    stream: string,
    backgroundType: string,
    name: string,
    data: string,
  ) => {
    try {
      const bbbVideoStream = bridgeRefs.current.localVideoStreams[stream];
      await VideoService.startVirtualBackground(bbbVideoStream, backgroundType, name, data);
    } catch (error) {
      const errorLocale = intlClientErrors.virtualBgGenericError;
      if (errorLocale) VideoService.notify(intl.formatMessage(errorLocale));
    }
  }, [intl]);

  useEffect(() => {
    const isLiveKitConnected = connectionState === ConnectionState.Connected;
    // Local connecting streams are client-side only (joinVideo). Keep driving
    // their LiveKit publish even while GraphQL flaps (Code 3001) — otherwise
    // share never starts until the socket recovers.
    const hasLocalConnecting = streams.some(
      (item) => item.type === VIDEO_TYPES.CONNECTING && VideoService.isLocalStream(item.stream),
    );

    if (isLiveKitConnected && (isClientConnected || hasLocalConnecting)) {
      const shouldDebounce = VideoService.isPaginationEnabled()
        && currentVideoPageIndex !== undefined
        && !hasLocalConnecting;
      updateStreams(streams, shouldDebounce);
    }
  }, [
    connectionState,
    isClientConnected,
    streams,
    currentVideoPageIndex,
    updateStreams,
    // cameraTracks is used to trigger a re-render when the camera tracks change,
    // even if not used explicitly. Not ideal, but it works (_for now_) - prlanzarin
    cameraTracks,
    overflowCount,
    overflowUsers,
  ]);

  useEffect(() => {
    if (!isUserLocked) return;
    lockUser();
  }, [isUserLocked, lockUser]);

  return (
    <VideoListContainer
      streams={streams}
      currentVideoPageIndex={currentVideoPageIndex}
      cameraDock={cameraDock}
      focusedId={focusedId}
      handleVideoFocus={handleVideoFocus}
      isGridEnabled={isGridEnabled}
      onVideoItemMount={createVideoTag}
      onVideoItemUnmount={destroyVideoTag}
      onVirtualBgDrop={startVirtualBackgroundByDrop}
      overflowCount={overflowCount}
      overflowUsers={overflowUsers}
    />
  );
};

export default React.memo(LiveKitCameraBridge);
