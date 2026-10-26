import React, {
  useCallback, useEffect, useLayoutEffect, useRef, useState,
} from 'react';
import { flushSync } from 'react-dom';
import { defineMessages, useIntl } from 'react-intl';
import { useMutation } from '@apollo/client';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import MenuItem from '@mui/material/MenuItem';
import { Input } from '/imports/ui/components/layout/layoutTypes';
import Styled from './styles';
import {
  CameraBrightnessInput,
  CameraDeviceSelector,
  CameraQualitySelector,
  CameraVirtualBackground,
} from '/imports/ui/components/camera-settings/component';
import { layoutSelectInput } from '/imports/ui/components/layout/context';
import { PANELS } from '/imports/ui/components/layout/enums';
import { useStorageKey } from '../../services/storage/hooks';
import VideoService from '/imports/ui/components/video-provider/service';
import PreviewService from '/imports/ui/components/video-preview/service';
import { getSettingsSingletonInstance } from '/imports/ui/services/settings';
import useCurrentUser from '/imports/ui/core/hooks/useCurrentUser';
import { SET_AWAY } from '../user-list/user-list-participants/list-item/mutations';
import { muteAway } from '/imports/ui/components/audio/audio-graphql/audio-controls/input-stream-live-selector/service';
import useToggleVoice from '/imports/ui/components/audio/audio-graphql/hooks/useToggleVoice';
import useWhoIsUnmuted from '/imports/ui/core/hooks/useWhoIsUnmuted';
import Auth from '/imports/ui/services/auth';
import {
  EFFECT_TYPES,
  getCameraBrightnessInfoWithDefault,
  getSessionVirtualBackgroundInfo,
} from '/imports/ui/services/virtual-background/service';
import {
  useSharedDevices, useIsCamSharingLocked, useStopVideo, useStreams,
} from '/imports/ui/components/video-provider/hooks';
import { useIsCustomVirtualBackgroundsEnabled, useIsVirtualBackgroundsEnabled } from '../../services/features';
import AudioSelectors from './audio-selectors/component';
import { useVideoPreview } from '/imports/ui/components/video-preview/hooks/useVideoPreview';
import { BBBVideoStream, CustomBgParams } from '/imports/ui/components/video-preview/hooks/types';
import usePreviousValue from '/imports/ui/hooks/usePreviousValue';
import getFromUserSettings from '../../services/users-settings';
import PanelHeader from '/imports/ui/components/common/panel-header/component';
import CameraPreview from '/imports/ui/components/media-setup/camera-preview/component';

const intlMessages: { [key: string]: { id: string; description?: string } } = defineMessages({
  title: {
    id: 'app.profileSettings.title',
    description: 'Label for the profile settings panel title',
  },
  username: {
    id: 'app.profileSettings.usernameTitle',
    description: 'Label for the username title in profile settings',
  },
  cameraLabel: {
    id: 'app.videoPreview.cameraLabel',
    description: 'Camera dropdown label',
  },
  sharedCameraLabel: {
    id: 'app.videoPreview.sharedCameraLabel',
    description: 'Already Shared camera label',
  },
  findingWebcamsLabel: {
    id: 'app.videoPreview.findingWebcamsLabel',
    description: 'Finding webcams label',
  },
  awayLabel: {
    id: 'app.actionsBar.reactions.away',
    description: 'Away Label',
  },
  availableLabel: {
    id: 'app.actionsBar.reactions.available',
    description: 'Available Label',
  },
  statusLabel: {
    id: 'app.profileSettings.statusTitle',
    description: 'Label for the status section in profile settings',
  },
  joinVideoLabel: {
    id: 'app.video.joinVideo',
    description: 'Join Video Label',
  },
  stopSharingLabel: {
    id: 'app.videoPreview.stopSharingLabel',
    description: 'Stop Sharing Label',
  },
  addExtraCameraLabel: {
    id: 'app.profileSettings.addExtraCamera',
    description: 'Add Extra Camera Button Label',
  },
  removeCameraLabel: {
    id: 'app.profileSettings.removeCamera',
    description: 'Remove an extra camera section that is not being shared',
  },
});

// The states with no stream to show keep the preview box's footprint.
const PREVIEW_STATUS_STYLE: React.CSSProperties = {
  width: '100%',
  height: '100%',
  minHeight: '6rem',
  display: 'flex',
  justifyContent: 'center',
  alignItems: 'center',
  boxSizing: 'border-box',
};

const PreviewStatus: React.FC<{ children?: React.ReactNode }> = ({ children }) => (
  <Styled.VideoPreviewContent>
    <Styled.VideoCol>
      <div style={PREVIEW_STATUS_STYLE}>{children}</div>
    </Styled.VideoCol>
  </Styled.VideoPreviewContent>
);

interface SecondarySectionPreviewProps {
  deviceId: string;
  /** Still listed as shared by GraphQL (publisher may still own the tracks). */
  isServerShared: boolean;
  /** User asked to unshare; LiveKit teardown may still be in flight. */
  isPendingUnshare: boolean;
  /** Device currently held by useVideoPreview — skip capturing it a second time. */
  activeWebcamDeviceId: string | null;
  findingLabel: string;
  animations: boolean;
}

/**
 * Live preview for a camera section that is not the active useVideoPreview target.
 * Shared cameras reuse the stored stream; others open a dedicated getUserMedia capture
 * so every section can show video at once (the active section owns the editable stream).
 */
const SecondarySectionPreview: React.FC<SecondarySectionPreviewProps> = ({
  deviceId,
  isServerShared,
  isPendingUnshare,
  activeWebcamDeviceId,
  findingLabel,
  animations,
}) => {
  const videoElRef = useRef<HTMLVideoElement>(null);
  const ownedStreamRef = useRef<BBBVideoStream | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const attachStream = useCallback((stream: BBBVideoStream | null) => {
    const videoEl = videoElRef.current;
    if (!videoEl) return;
    videoEl.srcObject = stream?.mediaStream ?? null;
  }, []);

  const stopOwnedStream = useCallback(() => {
    if (ownedStreamRef.current) {
      PreviewService.terminateCameraStream(ownedStreamRef.current);
      ownedStreamRef.current = null;
    }
    attachStream(null);
  }, [attachStream]);

  // useLayoutEffect so the track is released before the active section's doGUM
  // (setPreviewToIndex flushSync's the active index change first).
  useLayoutEffect(() => {
    let cancelled = false;

    // Unshare clicked but bridge still owns the publisher stream — do not stop()
    // or re-gUM (that fires LiveKit inactiveError). Show a spinner until GraphQL
    // drops the share and destroyStream finishes.
    if (isServerShared && isPendingUnshare) {
      stopOwnedStream();
      attachStream(null);
      setIsLoading(true);
      setError(null);
      return undefined;
    }

    if (isServerShared) {
      stopOwnedStream();
      const storedStream = PreviewService.getStream(deviceId) as BBBVideoStream | undefined;
      const media = storedStream?.mediaStream;
      const live = !!media?.active
        && media.getVideoTracks().some((t) => t.readyState === 'live');
      if (live) {
        attachStream(storedStream);
        setIsLoading(false);
        setError(null);
      } else {
        // Shared entry missing/dead (race after publish) — keep placeholder.
        attachStream(null);
        setIsLoading(true);
        setError(null);
      }

      return () => {
        attachStream(null);
      };
    }

    // Still the primary preview's device: wait until useVideoPreview switches away
    // so we do not open a second capture on the same camera.
    if (deviceId === activeWebcamDeviceId) {
      stopOwnedStream();
      setIsLoading(true);
      setError(null);
      return undefined;
    }

    setIsLoading(true);
    setError(null);
    // Bridge already stopped the publisher; drop any stale map entry without
    // risking a second stop on a live LiveKit stream.
    PreviewService.forgetStream(deviceId);
    const profile = PreviewService.getDefaultProfile();

    PreviewService.doGUM(deviceId, profile)
      .then((stream: BBBVideoStream) => {
        if (cancelled) {
          PreviewService.terminateCameraStream(stream);
          return;
        }
        ownedStreamRef.current = stream;
        attachStream(stream);
        setIsLoading(false);
      })
      .catch((err: Error) => {
        if (cancelled) return;
        setError(err?.message || 'previewError');
        setIsLoading(false);
      });

    return () => {
      cancelled = true;
      stopOwnedStream();
    };
  }, [
    deviceId, isServerShared, isPendingUnshare, activeWebcamDeviceId,
    stopOwnedStream, attachStream,
  ]);

  // Keep the <video> mounted while loading so attachStream can set srcObject as
  // soon as doGUM resolves (unmounting it for the spinner would drop the ref).
  return (
    <Styled.VideoPreviewContainer $inset>
      <Styled.VideoPreviewWrapper>
        {(isLoading || error) ? (
          <PreviewStatus>
            {error || (
              <>
                <span>{findingLabel}</span>
                <Styled.FetchingAnimation animations={animations} />
              </>
            )}
          </PreviewStatus>
        ) : null}
        <Styled.VideoPreviewContent style={{ display: (isLoading || error) ? 'none' : undefined }}>
          <Styled.VideoCol>
            <Styled.VideoPreview
              mirroredVideo={VideoService.mirrorOwnWebcam()}
              data-test="secondaryVideoPreview"
              ref={videoElRef}
              autoPlay
              playsInline
              muted
            />
          </Styled.VideoCol>
        </Styled.VideoPreviewContent>
      </Styled.VideoPreviewWrapper>
    </Styled.VideoPreviewContainer>
  );
};

interface CameraSection {
  deviceId: string | null;
  brightness: number;
  virtualBackgroundChecked: boolean;
  virtualBackground: {
    type: string;
    name: string;
    uniqueId?: string | null;
  };
}

const createCameraSection = (deviceId: string | null): CameraSection => {
  const vbgInfo = deviceId ? getSessionVirtualBackgroundInfo(deviceId) : null;
  const brightnessInfo = deviceId
    ? getCameraBrightnessInfoWithDefault(deviceId)
    : { brightness: 100 };

  return {
    deviceId,
    brightness: brightnessInfo.brightness,
    virtualBackgroundChecked: vbgInfo ? vbgInfo.type !== EFFECT_TYPES.NONE_TYPE : false,
    virtualBackground: vbgInfo || { type: EFFECT_TYPES.NONE_TYPE, name: 'None' },
  };
};

const updateCameraSections = (
  prevSections: CameraSection[],
  sharedDevices: string[],
  prevSharedDevices: string[] | undefined,
  lastUsedWebcamDeviceId: string | null,
  _stoppedDeviceIds: string[],
  newlySharedDeviceIds: string[],
): CameraSection[] => {
  let newSections: CameraSection[];

  if (prevSharedDevices === undefined) {
    if (sharedDevices.length > 0) {
      newSections = sharedDevices.map(createCameraSection);
    } else {
      newSections = [createCameraSection(lastUsedWebcamDeviceId)];
    }
  } else {
    let currentSections = [...prevSections];

    // Do not remove sections when a cam is unshared — keep extras as drafts so
    // unsharing cam 2 does not collapse the panel and risk stopping cam 1 next.
    // Sections leave via explicit "Remove camera", or when only one device remains.

    newlySharedDeviceIds.forEach((deviceId) => {
      if (!currentSections.some((s) => s.deviceId === deviceId)) {
        currentSections.push(createCameraSection(deviceId));
      }
    });
    newSections = currentSections;
  }

  if (newSections.length === 0) {
    newSections.push(createCameraSection(lastUsedWebcamDeviceId));
  }

  // Keep list order stable — re-sorting shared cams to the top made unsharing
  // the first section jump positions and risked stopping the wrong camera next.
  const seen = new Set<string>();
  const finalSections = newSections.filter((s) => {
    if (!s.deviceId) {
      if (seen.has('__null')) return false;
      seen.add('__null');
      return true;
    }
    if (seen.has(s.deviceId)) return false;
    seen.add(s.deviceId);
    return true;
  });

  if (JSON.stringify(finalSections) === JSON.stringify(prevSections)) {
    return prevSections;
  }

  return finalSections;
};

interface ProfileSettingsProps {
}
const ProfileSettings: React.FC<ProfileSettingsProps> = () => {
  const { formatMessage } = useIntl();
  const sharedDevices = useSharedDevices();
  const isCamLocked = useIsCamSharingLocked();
  const stopVideo = useStopVideo();
  const streams = useStreams();
  const isVirtualBackgroundsEnabled = useIsVirtualBackgroundsEnabled();
  const isCustomVirtualBackgroundsEnabled = useIsCustomVirtualBackgroundsEnabled();

  // @ts-ignore
  const settingsStorage = window.meetingClientSettings.public.app.userSettingsStorage;
  const lastUsedWebcamDeviceId = useStorageKey('WebcamDeviceId', settingsStorage) as string || null;

  const [cameraSections, setCameraSections] = React.useState<CameraSection[]>([]);
  const [activePreviewIndex, setActivePreviewIndex] = React.useState(0);
  // Unshare is async (GraphQL). Until sharedDevices drops the id, Secondary would keep
  // painting the just-stopped publisher stream — mark these as unshared immediately.
  const [optimisticUnshared, setOptimisticUnshared] = useState<Set<string>>(() => new Set());
  const prevSharedDevices = usePreviousValue(sharedDevices);
  const { hideNotificationToasts } = layoutSelectInput((i: Input) => i.notificationsBar);
  const hideNotifications = hideNotificationToasts || getFromUserSettings('bbb_hide_notifications', false);

  const isAlreadyShared = useCallback((webcamId: string | null) => {
    return !!webcamId
      && sharedDevices.includes(webcamId)
      && !optimisticUnshared.has(webcamId);
  }, [sharedDevices, optimisticUnshared]);

  const initialWebcamDeviceId = (sharedDevices && sharedDevices.length > 0)
    ? sharedDevices[0]
    : lastUsedWebcamDeviceId;

  const {
    webcamDeviceId,
    virtualBackgroundActive,
    availableWebcams,
    selectedProfile,
    viewState,
    deviceError,
    previewError,
    isCameraLoading,
    videoRef,
    currentVideoStream,
    handleSelectWebcam,
    handleSelectProfile,
    handleVirtualBgSelected,
    setCameraBrightness,
    stopVirtualBackground,
    applyStoredVirtualBg,
    displayPreview,
    cleanupStreamAndVideo,
  } = useVideoPreview({
    initialDeviceId: initialWebcamDeviceId,
    initialProfileId: PreviewService.getDefaultProfile().id,
    isCameraShared: isAlreadyShared(initialWebcamDeviceId),
    forceOpen: true,
  });

  const prevWebcamDeviceId = usePreviousValue(webcamDeviceId);
  // Switching cameras while the preview loads would race two getUserMedia calls.
  // A preview error leaves the loading flag on, so keep switching open to recover.
  const isCameraSwitchLocked = isCameraLoading && !previewError;

  useEffect(() => {
    if (!webcamDeviceId) return;

    if (!prevWebcamDeviceId) {
      const emptySectionIndex = cameraSections.findIndex((s) => !s.deviceId);
      if (emptySectionIndex !== -1) {
        setCameraSections((prevSections) => {
          const newSections = [...prevSections];
          newSections[emptySectionIndex] = {
            ...newSections[emptySectionIndex],
            ...createCameraSection(webcamDeviceId),
          };
          return newSections;
        });
      }
      return;
    }

    if (cameraSections.length === 1 && !cameraSections[0].deviceId) {
      setCameraSections([createCameraSection(webcamDeviceId)]);
    }
  }, [webcamDeviceId, cameraSections, prevWebcamDeviceId]);

  useEffect(() => {
    const pSharedDevices = prevSharedDevices || [];
    const stoppedDeviceIds = pSharedDevices.filter((d: string) => !sharedDevices.includes(d));
    const newlySharedDeviceIds = sharedDevices.filter((d: string) => !pSharedDevices.includes(d));

    if (
      stoppedDeviceIds.length === 0
      && newlySharedDeviceIds.length === 0
      && prevSharedDevices !== undefined
    ) {
      return;
    }

    setCameraSections((prevSections) => {
      const newSections = updateCameraSections(
        prevSections,
        sharedDevices,
        prevSharedDevices,
        lastUsedWebcamDeviceId,
        stoppedDeviceIds,
        newlySharedDeviceIds,
      );

      if (activePreviewIndex >= newSections.length) {
        const newActiveIndex = newSections.findIndex((s) => s.deviceId === webcamDeviceId);
        setActivePreviewIndex(newActiveIndex > -1 ? newActiveIndex : 0);
      }

      return newSections;
    });
  }, [sharedDevices, lastUsedWebcamDeviceId, activePreviewIndex, webcamDeviceId]);

  useEffect(() => {
    const newActiveIndex = cameraSections.findIndex((s) => s.deviceId === webcamDeviceId);
    if (newActiveIndex !== -1 && newActiveIndex !== activePreviewIndex) {
      setActivePreviewIndex(newActiveIndex);
    }
  }, [webcamDeviceId, cameraSections]);

  const { data: currentUserData } = useCurrentUser((user) => ({
    name: user.name,
    away: user.away,
    inAudio: user.voice,
  }));

  const voiceToggle = useToggleVoice();
  const { data: unmuted } = useWhoIsUnmuted(Auth.userID as string);

  const muted = !unmuted;
  const away = currentUserData?.away ?? false;

  const [setAway] = useMutation(SET_AWAY);

  const handleSetStatus = useCallback((status: string) => {
    const isAway = status === 'away';

    if (isAway === away) return;

    muteAway(muted, away, voiceToggle);
    setAway({
      variables: {
        away: isAway,
      },
    });
  }, [muted, away, voiceToggle, setAway]);

  const setPreviewToIndex = useCallback(async (index: number, newDeviceId: string) => {
    if (index !== activePreviewIndex) {
      // Flush so SecondarySectionPreview's layout effect releases this device's
      // secondary capture before useVideoPreview opens it as the active stream.
      flushSync(() => {
        setActivePreviewIndex(index);
      });
    }
    if (newDeviceId !== webcamDeviceId) {
      const fakeEvent = { target: { value: newDeviceId } } as unknown as React.ChangeEvent<HTMLSelectElement>;
      const resolvedDeviceId = await handleSelectWebcam(fakeEvent);
      const streamingDeviceId = resolvedDeviceId || newDeviceId;

      if (streamingDeviceId !== newDeviceId) {
        setCameraSections((prevSections) => (
          prevSections.some((s, i) => i !== index && s.deviceId === streamingDeviceId)
            ? prevSections
            : prevSections.map((s, i) => (i === index ? { ...s, deviceId: streamingDeviceId } : s))
        ));
      }

      if (!isAlreadyShared(streamingDeviceId) && cameraSections[index]) {
        setCameraBrightness(cameraSections[index].brightness, streamingDeviceId);
      }
    }
  }, [
    cameraSections, activePreviewIndex, webcamDeviceId, handleSelectWebcam,
    setCameraBrightness, isAlreadyShared,
  ]);

  const handleAddCamera = useCallback(() => {
    const usedDeviceIds = cameraSections.map((s) => s.deviceId);
    const nextAvailableDevice = availableWebcams.find((d) => !usedDeviceIds.includes(d.deviceId));
    if (!nextAvailableDevice) return;

    const newIndex = cameraSections.length;
    flushSync(() => {
      setCameraSections((prev) => [...prev, createCameraSection(nextAvailableDevice.deviceId)]);
      setActivePreviewIndex(newIndex);
    });
    setPreviewToIndex(newIndex, nextAvailableDevice.deviceId);
  }, [cameraSections, availableWebcams, setPreviewToIndex]);

  const handleCameraSectionChange = useCallback((index: number, newDeviceId: string) => {
    const newSections = [...cameraSections];
    newSections[index].deviceId = newDeviceId;
    setCameraSections(newSections);
    setPreviewToIndex(index, newDeviceId);
  }, [cameraSections, setPreviewToIndex]);

  const handleBrightnessChange = useCallback((index: number, value: number) => {
    const newSections = [...cameraSections];
    newSections[index].brightness = value;
    const deviceId = newSections[index].deviceId;

    setPreviewToIndex(index, deviceId as string).then(() => {
      setCameraBrightness(value, deviceId);
      setCameraSections(newSections);
    });
  }, [cameraSections, setPreviewToIndex, setCameraBrightness]);

  const handleVirtualBgChange = useCallback((index: number, checked: boolean) => {
    const newSections = [...cameraSections];
    newSections[index].virtualBackgroundChecked = checked;
    setCameraSections(newSections);

    setPreviewToIndex(index, newSections[index].deviceId as string).then(() => {
      if (!checked) {
        stopVirtualBackground(currentVideoStream.current);
      } else {
        applyStoredVirtualBg(newSections[index].deviceId);
      }
    });
  }, [cameraSections, setPreviewToIndex, stopVirtualBackground, currentVideoStream, applyStoredVirtualBg]);

  const handleVirtualBgSelectedForSection = useCallback((
    index: number, type: string, name: string, customParams?: CustomBgParams,
  ) => {
    const newSections = [...cameraSections];
    const section = newSections[index];
    section.virtualBackground = { type, name, ...customParams };
    setCameraSections(newSections);

    return setPreviewToIndex(index, section.deviceId as string).then(
      () => handleVirtualBgSelected(type, name, customParams, section?.deviceId),
    );
  }, [cameraSections, setPreviewToIndex, handleVirtualBgSelected]);

  const handleShareWebcam = useCallback(async (sectionIndex: number) => {
    const section = cameraSections[sectionIndex];
    if (!section?.deviceId) return;

    await setPreviewToIndex(sectionIndex, section.deviceId);

    if (!currentVideoStream.current) return;

    const { type } = section.virtualBackground;
    const deviceId = PreviewService.getVideoStreamDeviceId(currentVideoStream.current)
      || section.deviceId;

    setOptimisticUnshared((prev) => {
      if (!prev.has(deviceId)) return prev;
      const next = new Set(prev);
      next.delete(deviceId);
      return next;
    });

    PreviewService.changeWebcam(deviceId);
    PreviewService.changeProfile(selectedProfile);

    if (
      currentVideoStream.current.virtualBgService
      && section.brightness === 100
      && type === EFFECT_TYPES.NONE_TYPE
    ) {
      stopVirtualBackground(currentVideoStream.current);
    }

    if (!PreviewService.storeStream(deviceId, currentVideoStream.current)
      && PreviewService.getStream(deviceId) !== currentVideoStream.current) {
      currentVideoStream.current.stop();
    }
    VideoService.joinVideo(deviceId, isCamLocked);
  }, [
    cameraSections,
    setPreviewToIndex,
    currentVideoStream,
    selectedProfile,
    isCamLocked,
    stopVirtualBackground,
  ]);

  // Called after GraphQL confirms unshare (LiveKit destroyStream already stopped
  // the publisher). Safe to open a fresh local capture for the sidebar preview.
  const refreshLocalPreview = useCallback(async (deviceId: string) => {
    const sectionIndex = cameraSections.findIndex((s) => s.deviceId === deviceId);
    const isActiveSection = sectionIndex === activePreviewIndex
      || deviceId === webcamDeviceId;

    PreviewService.forgetStream(deviceId);

    if (!isActiveSection) {
      // SecondarySectionPreview switches to doGUM when isServerShared goes false.
      return;
    }

    const fakeEvent = {
      target: { value: deviceId },
    } as unknown as React.ChangeEvent<HTMLSelectElement>;
    await handleSelectWebcam(fakeEvent);
    displayPreview();
  }, [
    cameraSections,
    activePreviewIndex,
    webcamDeviceId,
    handleSelectWebcam,
    displayPreview,
  ]);

  const handleUnshareWebcam = useCallback((deviceId: string | null) => {
    if (!deviceId) return;
    setOptimisticUnshared((prev) => new Set(prev).add(deviceId));
    const streamId = VideoService.getMyStreamId(deviceId, streams);
    if (streamId) stopVideo(streamId);

    // Do not stop publisher tracks here — LiveKit treats that as inactiveError.
    // Detach the preview ref only (forget map entry + clear video); re-gUM after
    // sharedDevices drops and destroyStream has finished (effect below).
    PreviewService.forgetStream(deviceId);
    const sectionIndex = cameraSections.findIndex((s) => s.deviceId === deviceId);
    const isActiveSection = sectionIndex === activePreviewIndex
      || deviceId === webcamDeviceId;
    if (isActiveSection) {
      cleanupStreamAndVideo();
    }
  }, [
    streams, stopVideo, cameraSections, activePreviewIndex, webcamDeviceId,
    cleanupStreamAndVideo,
  ]);

  const handleRemoveCamera = useCallback(async (sectionIndex: number, deviceId: string | null) => {
    if (deviceId && isAlreadyShared(deviceId)) {
      handleUnshareWebcam(deviceId);
    }

    // Keep at least one camera section.
    if (cameraSections.length <= 1) return;

    const newSections = cameraSections.filter((_, i) => i !== sectionIndex);
    setCameraSections(newSections);

    if (activePreviewIndex === sectionIndex) {
      const newActiveIndex = 0;
      setActivePreviewIndex(newActiveIndex);
      const newDeviceId = newSections[newActiveIndex]?.deviceId;
      if (newDeviceId) {
        const fakeEvent = { target: { value: newDeviceId } } as unknown as React.ChangeEvent<HTMLSelectElement>;
        await handleSelectWebcam(fakeEvent);
      }
    } else if (activePreviewIndex > sectionIndex) {
      setActivePreviewIndex((prev) => prev - 1);
    }
  }, [
    streams, stopVideo, cameraSections, activePreviewIndex, handleSelectWebcam,
    isAlreadyShared, handleUnshareWebcam,
  ]);

  // Only one physical camera left — drop surplus draft sections (keep shared first).
  useEffect(() => {
    if (availableWebcams.length > 1) return;

    setCameraSections((prev) => {
      if (prev.length <= 1) return prev;
      const sharedSection = prev.find((s) => s.deviceId && sharedDevices.includes(s.deviceId));
      return [sharedSection || prev[0]];
    });
  }, [availableWebcams.length, sharedDevices]);

  useEffect(() => {
    const activeSection = cameraSections[activePreviewIndex];
    if (activeSection && virtualBackgroundActive !== activeSection.virtualBackgroundChecked) {
      const newSections = [...cameraSections];
      newSections[activePreviewIndex].virtualBackgroundChecked = virtualBackgroundActive;
      if (virtualBackgroundActive) {
        newSections[activePreviewIndex].virtualBackground = {
          type: currentVideoStream.current?.virtualBgType || EFFECT_TYPES.BLUR_TYPE,
          name: currentVideoStream.current?.virtualBgName || 'Blur',
          uniqueId: currentVideoStream.current?.virtualBgUniqueId,
        };
      }
      setCameraSections(newSections);
    }
  }, [virtualBackgroundActive]);

  // Server confirmed unshare — wait briefly so LiveKit destroyStream can release
  // the device, then open a local preview again.
  useEffect(() => {
    if (prevSharedDevices === undefined) return;
    const stoppedDeviceIds = prevSharedDevices.filter((d) => !sharedDevices.includes(d));
    if (!stoppedDeviceIds.length) return;

    const timers = stoppedDeviceIds.map((deviceId) => window.setTimeout(() => {
      void refreshLocalPreview(deviceId).finally(() => {
        setOptimisticUnshared((prev) => {
          if (!prev.has(deviceId)) return prev;
          const next = new Set(prev);
          next.delete(deviceId);
          return next;
        });
      });
    }, 150));

    return () => timers.forEach((id) => window.clearTimeout(id));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sharedDevices, prevSharedDevices]);

  function renderSectionPreview(section: CameraSection, sectionIndex: number): React.ReactNode {
    const Settings = getSettingsSingletonInstance();
    const { animations } = Settings.application;
    const isActive = sectionIndex === activePreviewIndex;
    const findingLabel = formatMessage(intlMessages.findingWebcamsLabel);
    const currentDevice = availableWebcams.find((d) => d.deviceId === section.deviceId);
    const cameraName = currentDevice?.label
      || (section.deviceId
        ? formatMessage(intlMessages.cameraLabel)
        : `${formatMessage(intlMessages.cameraLabel)} ${sectionIndex + 1}`);
    const isServerShared = !!section.deviceId && sharedDevices.includes(section.deviceId);
    const isPendingUnshare = !!section.deviceId && optimisticUnshared.has(section.deviceId);

    let previewContent: React.ReactNode;

    if (isActive) {
      previewContent = (
        <CameraPreview
          viewState={viewState}
          videoRef={videoRef}
          findingLabel={findingLabel}
          animations={animations}
          statusContainer={PreviewStatus}
          deviceError={deviceError}
          previewError={previewError}
          inset
          onVideoElementReady={displayPreview}
        >
          {isPendingUnshare ? (
            <div style={{
              ...PREVIEW_STATUS_STYLE,
              position: 'absolute',
              inset: 0,
              zIndex: 1,
              backgroundColor: 'inherit',
            }}
            >
              <span>{findingLabel}</span>
              <Styled.FetchingAnimation animations={animations} />
            </div>
          ) : null}
        </CameraPreview>
      );
    } else if (section.deviceId) {
      previewContent = (
        <SecondarySectionPreview
          key={`${section.deviceId}-${isServerShared ? 'srv' : 'loc'}-${isPendingUnshare ? 'pend' : 'idle'}`}
          deviceId={section.deviceId}
          isServerShared={isServerShared}
          isPendingUnshare={isPendingUnshare}
          activeWebcamDeviceId={webcamDeviceId}
          findingLabel={findingLabel}
          animations={animations}
        />
      );
    } else {
      previewContent = <PreviewStatus />;
    }

    return (
      <Styled.PreviewRow>
        <Styled.PreviewTitle>
          <Styled.IconCamera aria-hidden />
          <Styled.PreviewTitleText title={cameraName}>{cameraName}</Styled.PreviewTitleText>
        </Styled.PreviewTitle>
        {previewContent}
      </Styled.PreviewRow>
    );
  }

  return (
    <Styled.RootContainer>
      <PanelHeader
        panelId={PANELS.PROFILE}
        title={formatMessage(intlMessages.title)}
        dataTest="profileSettingsTitle"
        closeButtonDataTest="closeProfileSettings"
      />
      <Styled.Separator />
      <Styled.ProfileSettings>
        <Styled.UsernameContainer>
          <Styled.UsernameTitle>{formatMessage(intlMessages.username)}</Styled.UsernameTitle>
          <Styled.Username>{currentUserData?.name ?? ''}</Styled.Username>
        </Styled.UsernameContainer>
        <Styled.UserPresenceRoot>
          <Styled.UsernameTitle id="status-label-id">{formatMessage(intlMessages.statusLabel)}</Styled.UsernameTitle>
          <Styled.UserPresenceField>
            <Styled.UserPresenceIndicator aria-hidden>
              <Styled.UserPresenceStatusDot away={away} />
            </Styled.UserPresenceIndicator>
            <Styled.UserPresenceDropdown
              labelId="status-label-id"
              value={away ? 'away' : 'available'}
              onChange={(e) => handleSetStatus(e.target.value as string)}
              IconComponent={ExpandMoreIcon}
              renderValue={(val) => (
                <Styled.UserPresenceText>
                  {val === 'away'
                    ? formatMessage(intlMessages.awayLabel)
                    : formatMessage(intlMessages.availableLabel)}
                </Styled.UserPresenceText>
              )}
            >
              <MenuItem value="available">
                <Styled.UserPresenceValueContainer>
                  <Styled.UserPresenceStatusDot away={false} />
                  <Styled.UserPresenceText>{formatMessage(intlMessages.availableLabel)}</Styled.UserPresenceText>
                </Styled.UserPresenceValueContainer>
              </MenuItem>
              <MenuItem value="away">
                <Styled.UserPresenceValueContainer>
                  <Styled.UserPresenceStatusDot away />
                  <Styled.UserPresenceText>{formatMessage(intlMessages.awayLabel)}</Styled.UserPresenceText>
                </Styled.UserPresenceValueContainer>
              </MenuItem>
            </Styled.UserPresenceDropdown>
          </Styled.UserPresenceField>
        </Styled.UserPresenceRoot>
        <Styled.Separator />
        <Styled.DevicesSettingsContainer>
          <AudioSelectors inAudio={!!currentUserData?.voice} />
        </Styled.DevicesSettingsContainer>
        <Styled.Separator />
        {cameraSections.map((section: CameraSection, sectionIndex) => {
          const usedDeviceIds = cameraSections
            .map((s) => s.deviceId)
            .filter((id) => id && id !== section.deviceId);
          const selectValue = section.deviceId || '';
          let availableDevicesForSection = availableWebcams
            .filter((d) => !usedDeviceIds.includes(d.deviceId));
          if (
            selectValue
            && !availableDevicesForSection.some((d) => d.deviceId === selectValue)
          ) {
            const fromAll = availableWebcams.find((d) => d.deviceId === selectValue);
            availableDevicesForSection = [
              fromAll || { deviceId: selectValue, label: selectValue },
              ...availableDevicesForSection,
            ];
          }

          const shared = isAlreadyShared(section.deviceId);
          const canRemove = cameraSections.length > 1 && !shared;

          return (
            <React.Fragment key={section.deviceId || `section-${sectionIndex}`}>
              <Styled.CameraSection>
                <Styled.DevicesSettingsContainer>
                  {renderSectionPreview(section, sectionIndex)}
                  <CameraDeviceSelector
                    devices={availableDevicesForSection}
                    value={selectValue}
                    onChange={(deviceId) => handleCameraSectionChange(sectionIndex, deviceId)}
                    disabled={isCameraSwitchLocked}
                    dataTest={`cameraDeviceSelector-${sectionIndex}`}
                  />
                  <CameraBrightnessInput
                    brightness={section.brightness}
                    onChange={(value) => handleBrightnessChange(sectionIndex, value)}
                    disabled={isCameraLoading}
                  />
                  <CameraQualitySelector
                    value={selectedProfile || ''}
                    onChange={handleSelectProfile}
                    disabled={shared || isCameraSwitchLocked}
                    tooltip={shared
                      ? formatMessage(intlMessages.sharedCameraLabel)
                      : undefined}
                    dataTest={`cameraQualitySelector-${sectionIndex}`}
                  />
                </Styled.DevicesSettingsContainer>
                <Styled.VirtualBackgroundContainer>
                  {isVirtualBackgroundsEnabled && (
                    <CameraVirtualBackground
                      checked={section.virtualBackgroundChecked}
                      onCheckedChange={(checked) => handleVirtualBgChange(sectionIndex, checked)}
                      onSelected={(type, name, customParams) => handleVirtualBgSelectedForSection(
                        sectionIndex, type, name, customParams as CustomBgParams,
                      )}
                      initialState={section.virtualBackground}
                      isCustomVirtualBackgroundsEnabled={isCustomVirtualBackgroundsEnabled}
                      locked={isCameraLoading}
                      disabled={!isVirtualBackgroundsEnabled || isCameraLoading}
                      hideNotificationToasts={hideNotifications}
                    />
                  )}
                  <Styled.SaveButtonContainer>
                    {shared ? (
                      <Styled.SaveButton
                        color="danger"
                        label={formatMessage(intlMessages.stopSharingLabel)}
                        onClick={() => handleUnshareWebcam(section.deviceId)}
                        data-test={`stopSharingCamera-${sectionIndex}`}
                      />
                    ) : (
                      <Styled.SaveButton
                        color="primary"
                        label={formatMessage(intlMessages.joinVideoLabel)}
                        disabled={
                          isCameraLoading
                          || !section.deviceId
                          || (sectionIndex === activePreviewIndex && !!(deviceError || previewError))
                        }
                        onClick={() => handleShareWebcam(sectionIndex)}
                        data-test={`shareCamera-${sectionIndex}`}
                      />
                    )}
                    {canRemove && (
                      <Styled.RemoveCameraButtonText
                        type="button"
                        onClick={() => handleRemoveCamera(sectionIndex, section.deviceId)}
                        data-test={`removeCameraButton-${sectionIndex}`}
                      >
                        {formatMessage(intlMessages.removeCameraLabel)}
                      </Styled.RemoveCameraButtonText>
                    )}
                  </Styled.SaveButtonContainer>
                </Styled.VirtualBackgroundContainer>
              </Styled.CameraSection>
              {sectionIndex < cameraSections.length - 1 && <Styled.Separator />}
            </React.Fragment>
          );
        })}
        {availableWebcams && availableWebcams.length > 1 && (
          <Styled.AddCameraContainer>
            <Styled.AddCameraButtonAndText
              onClick={handleAddCamera}
              disabled={cameraSections.length >= availableWebcams.length || isCameraSwitchLocked}
              data-test="addExtraCameraButton"
            >
              <Styled.AddCameraIcon />
              {formatMessage(intlMessages.addExtraCameraLabel)}
            </Styled.AddCameraButtonAndText>
          </Styled.AddCameraContainer>
        )}
      </Styled.ProfileSettings>
    </Styled.RootContainer>
  );
};

export default ProfileSettings;
