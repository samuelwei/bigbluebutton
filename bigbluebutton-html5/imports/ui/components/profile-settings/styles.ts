import styled, { css, keyframes } from 'styled-components';
import {
  colorBlackBorder,
  colorBlackSurface,
  colorBorder,
  colorDanger,
  colorGrayDark,
  colorGrayLight,
  colorInfoSurfaceAlt,
  colorLink,
  colorPrimary,
  colorSuccess,
  colorText,
  colorWhite,
  colorWhiteSurface,
  palettePlaceholderText,
} from '/imports/ui/stylesheets/styled-components/palette';
import {
  smPadding,
  contentSidebarPadding,
  contentSidebarBorderRadius,
  lgBorderRadius,
} from '/imports/ui/stylesheets/styled-components/general';
import {
  fontSizeSmall, fontSizeBase, textFontWeight, titlesFontWeight, fontSizeLarge,
} from '/imports/ui/stylesheets/styled-components/typography';
import { smallOnly, mediumOnly } from '/imports/ui/stylesheets/styled-components/breakpoints';
import { ScrollboxVertical } from '/imports/ui/stylesheets/styled-components/scrollable';
import CameraIcon from '@mui/icons-material/Videocam';
import WbSunny from '@mui/icons-material/WbSunny';
import Headphones from '@mui/icons-material/Headphones';
import AddCircleIcon from '@mui/icons-material/AddCircle';
import ArrowCircleLeft from '@mui/icons-material/ArrowCircleLeftTwoTone';
import ArrowCircleRight from '@mui/icons-material/ArrowCircleRightTwoTone';
import Mic from '@mui/icons-material/Mic';
import Select from '@mui/material/Select';
import Switch from '@mui/material/Switch';
import Slider from '@mui/material/Slider';
import { styled as materialStyled } from '@mui/material/styles';
import FormControlLabel from '@mui/material/FormControlLabel';
import Button from '/imports/ui/components/common/button/component';

const RootContainer = styled.div`
  display: flex;
  flex-direction: column;
  height: 100%;
  background: ${colorWhiteSurface};
`;

const ProfileSettings = styled(ScrollboxVertical)`
  display: flex;
  flex: 1;
  margin: 0 ${smPadding} 0;
  flex-direction: column;
  gap: 0.65rem;
  border-radius: ${contentSidebarBorderRadius};
  background: ${colorWhiteSurface};
  overflow-y: auto;
  overflow-x: hidden;
`;

interface VideoPreviewProps {
  mirroredVideo: boolean;
}

const VideoPreview = styled.video<VideoPreviewProps>`
  max-height: 14rem;
  width: 100%;
  border-radius: 0.5rem;
  box-shadow: 8px 8px 24px 0px rgba(0, 0, 0, 0.10);

  @media ${smallOnly} {
    height: 10rem;
  }

  ${({ mirroredVideo }) => mirroredVideo && `
    transform: scale(-1, 1);
  `}
`;

const VideoPreviewWrapper = styled.div`
  flex: 1;
  width: 100%;
  min-width: 0;
  display: flex;
  justify-content: stretch;
  position: relative;
  overflow: hidden;
  border-radius: 0.5rem;
`;

const VideoPreviewContainer = styled.div<{ $inset?: boolean }>`
  display: flex;
  align-items: stretch;
  justify-content: stretch;
  width: 100%;
  padding: 0px ${contentSidebarPadding};

  ${({ $inset }) => $inset && css`
    padding: 0;
    align-items: flex-start;

    ${VideoPreviewWrapper} {
      /* Match shared webcam tiles: 4:3, black fill, 2px black border, 10px radius.
         Clip children here — a second radius on the <video> left white AA crescents
         at the corners over the page background. */
      width: auto;
      max-width: 100%;
      height: 8rem;
      aspect-ratio: 4 / 3;
      background-color: ${colorBlackSurface};
      border: 2px solid ${colorBlackBorder};
      border-radius: 10px;
      box-sizing: border-box;
      overflow: hidden;
      box-shadow: none;

      @media ${smallOnly} {
        height: 7rem;
      }
    }

    /* Kill the default white preview chrome that showed as bright crescents
       through the rounded black tile corners. */
    ${VideoPreviewWrapper} > * {
      background-color: ${colorBlackSurface};
      margin: 0;
      width: 100%;
      height: 100%;
    }

    ${VideoPreview} {
      width: 100%;
      height: 100%;
      max-height: none;
      box-shadow: none !important;
      object-fit: contain;
      background-color: ${colorBlackSurface};
      border-radius: 0;

      @media ${smallOnly} {
        height: 100%;
      }
    }
  `}
`;

const PreviewArrowButton = styled.button<{ position: 'left' | 'right' }>`
  background: transparent;
  border: none;
  font-size: 2rem;
  cursor: pointer;
  padding: 0;
  align-self: stretch;
  display: flex;
  align-items: center;
  position: absolute;
  top: 0;
  bottom: 0;
  z-index: 2;
  ${({ position }) => (position === 'left' ? 'left: 0;' : 'right: 0;')}

  &:hover {
    & > svg {
      opacity: 0.8;
    }
  }

  &:disabled {
    cursor: not-allowed;
    opacity: 0.6;
  }
`;

const VideoPreviewContent = styled.div`
  width: 100%;
  display: flex;
  justify-content: stretch;
  align-items: stretch;
  background: ${colorWhiteSurface};

  color: ${colorText};
  font-weight: normal;

  @media ${smallOnly} {
    display: flex;
    flex-wrap: wrap;
    flex-direction: row;
    margin: 0;
  }
`;

const Col = styled.div`
  display: flex;
  flex-direction: column;
  height: 100%;
  justify-content: center;

  @media ${smallOnly}, ${mediumOnly} {
    justify-content: space-between;
    align-items: center;
    overflow: auto;
    margin: 0;
  }
`;

const VideoCol = styled(Col)`
  width: 100%;
  align-items: stretch;
`;

interface FetchingAnimationProps {
  animations: boolean;
}

const ellipsis = keyframes`
  to {
    width: 1.5em;
  }
`;

const FetchingAnimation = styled.span<FetchingAnimationProps>`
  margin: auto;
  display: inline-block;
  width: 1.5em;

  &:after {
    overflow: hidden;
    display: inline-block;
    vertical-align: bottom;
    content: "\\2026"; /* ascii code for the ellipsis character */
    width: 0;
    margin-left: 0.25em;

    ${({ animations }) => animations && css`
      animation: ${ellipsis} steps(4, end) 900ms infinite;
    `}
  }
`;

const UsernameContainer = styled.div`
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  width: 100%;
  padding: 0.5rem ${contentSidebarPadding} 0px ${contentSidebarPadding};
`;

const UsernameTitle = styled.div`
  color: ${colorGrayDark};
  font-size: ${fontSizeSmall};
  font-weight: ${textFontWeight};
`;

const Username = styled.div`
  color: ${colorGrayDark};
  font-size: ${fontSizeLarge};
  font-weight: ${titlesFontWeight};
`;

const UserPresenceRoot = styled.div`
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 0.5rem;
  width: 100%;
  padding: 0px ${contentSidebarPadding};
`;

const UserPresenceField = styled.div`
  display: flex;
  align-items: center;
  gap: 1rem;
  width: 100%;
`;

const UserPresenceIndicator = styled.div`
  display: flex;
  align-items: center;
  justify-content: center;
  width: 1.5rem;
  flex-shrink: 0;
`;

const UserPresenceDropdown = styled(Select)`
  flex: 1;
  height: 3rem;
  border-radius: 0.5rem !important;
  overflow: hidden;
`;

const UserPresenceValueContainer = styled.div`
  display: flex;
  align-items: center;
  gap: 0.5rem;
`;

const UserPresenceStatusDot = styled.div<{ away?: boolean }>`
  width: 0.625rem;
  height: 0.625rem;
  border-radius: 50%;
  flex-shrink: 0;
  background-color: ${({ away }) => (away ? colorGrayLight : colorSuccess)};
`;

const UserPresenceText = styled.span`
  color: ${colorGrayDark};
  font-size: ${fontSizeBase};
  font-weight: ${textFontWeight};
`;

const Separator = styled.hr`
  width: 100%;
  border: 0;
  border-bottom: 1px solid ${colorBorder};
`;

const CameraSection = styled.div`
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
  width: 100%;
`;

const DevicesSettingsContainer = styled.div`
  display: flex;
  width: 100%;
  flex-direction: column;
  gap: 0.75rem;
  padding: 0px ${contentSidebarPadding};
`;

const DeviceContainer = styled.div<{ extraPadding?: boolean }>`
  display: flex;
  flex-direction: row;
  flex-shrink: 0;
  align-items: center;
  gap: 0.75rem;
  width: 100%;
  min-width: 0;
  ${({ extraPadding }) => extraPadding && `
    padding-left: 2.25rem;
  `}

  /* Icon + select rows (audio): select fills leftover width instead of
     width:100% of the row (that overflowed and clipped the right edge). */
  & > *:last-child {
    flex: 1 1 0%;
    min-width: 0;
    width: auto;
    max-width: 100%;
  }
`;

const PreviewRow = styled.div`
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  width: 100%;
`;

/* Same icon + content row metrics as audio DeviceContainer / selects. */
const PreviewTitle = styled.div`
  display: flex;
  flex-direction: row;
  align-items: center;
  gap: 0.75rem;
  width: 100%;
  min-width: 0;
  height: 3rem;
`;

const PreviewTitleText = styled.div`
  color: ${colorGrayDark};
  /* Match MUI Select value text (not the smaller field labels). */
  font-size: ${fontSizeBase};
  font-weight: ${textFontWeight};
  line-height: 1.25;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  min-width: 0;
  flex: 1 1 0%;
`;

/** Full-width labeled control stack (brightness, quality, …). */
const FieldStack = styled.div`
  display: flex;
  flex-direction: column;
  align-items: stretch;
  width: 100%;
  gap: 0.25rem;
`;

const FieldLabel = styled.div`
  color: ${colorGrayDark};
  font-size: ${fontSizeSmall};
  font-weight: ${textFontWeight};
`;

const Icon = `
  width: 1.5rem !important;
  height: 1.5rem !important;
  font-size: 1.5rem !important;
  flex-shrink: 0;
  color: ${colorPrimary};
  display: block;
`;

const IconCamera = styled(CameraIcon)`
  ${Icon}
`;

const WbSunnyIcon = styled(WbSunny)`
  ${Icon}
`;

const HeadphonesIcon = styled(Headphones)`
  ${Icon}
`;

const MicIcon = styled(Mic)`
  ${Icon}
`;

const ArrowLeftIcon = styled(ArrowCircleLeft)`
  ${Icon}
  width: 2rem !important;
  height: 2rem !important;
  & path:first-of-type {
    fill: ${colorPrimary};
    fill-opacity: 1;
    opacity: 1;
  }

  & path:last-of-type {
    fill: ${colorWhite};
  }
`;

const ArrowRightIcon = styled(ArrowCircleRight)`
  ${Icon}
  width: 2rem !important;
  height: 2rem !important;
  & path:first-of-type {
    fill: ${colorPrimary};
    fill-opacity: 1;
    opacity: 1;
  }

  & path:last-of-type {
    fill: ${colorWhite};
  }
`;

const AddCameraIcon = styled(AddCircleIcon)`
  ${Icon}
`;

const DeviceSelector = styled(Select)`
  /* Match Status / audio selects (UserPresenceDropdown is 3rem). */
  height: 3rem;
  border-radius: 0.5rem !important;
  overflow: hidden;
  width: 100%;
  min-width: 0;
  box-sizing: border-box;

  & .MuiSelect-select {
    display: flex;
    align-items: center;
    box-sizing: border-box;
    min-height: 3rem !important;
    height: 3rem;
    line-height: 1.25;
    padding-top: 0;
    padding-bottom: 0;
  }

  /* Doubled: MUI's own error outline has the same specificity and its
     stylesheet is injected after this one. */
  &&.Mui-error .MuiOutlinedInput-notchedOutline {
    border-color: ${colorDanger};
  }
`;

const DevicePlaceholder = styled.span`
  color: ${palettePlaceholderText};
`;

// Under the selector it flags, past the row's icon: the row's 1rem gap would
// read as the next row's caption.
const DeviceFieldError = styled.div`
  margin-top: -0.5rem;
  padding-inline-start: 2.5rem;
  color: ${colorDanger};
  font-size: ${fontSizeSmall};
  font-weight: ${textFontWeight};
`;

const CameraQualityContainer = styled(FieldStack)``;

const CameraQualityText = styled(FieldLabel)``;

/* Same control as device/status — do not re-override height here. */
const CameraQualitySelector = styled(DeviceSelector)`
  width: 100%;
  flex: none;
`;

const CameraNameLabel = styled.div`
  position: absolute;
  bottom: 0.5rem;
  left: 0.5rem;
  background-color: rgba(0, 0, 0, 0.5);
  color: ${colorWhite};
  padding: 0.25rem 0.5rem;
  border-radius: 0.25rem;
  font-size: ${fontSizeSmall};
  z-index: 2;
`;

const VirtualBackgroundContainer = styled.div<{ extraPadding?: boolean }>`
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 0.75rem;
  align-self: stretch;
  padding: 0px ${contentSidebarPadding};
`;

const SwitchTitle = styled(FormControlLabel)`
  flex-shrink: 0;
  align-items: center;
  margin-left: 0;
  margin-right: 0;

  .MuiFormControlLabel-label {
    color: ${colorGrayDark};
    font-size: ${fontSizeBase};
    font-weight: ${textFontWeight};
  }
`;

/* Same dimensions as settings / lock-viewers MaterialSwitch (not the tiny 24×14). */
const MaterialSwitch = materialStyled(Switch)(({ theme }) => ({
  width: '2.3rem',
  height: '1.2rem',
  padding: 0,
  display: 'flex',
  flexShrink: 0,
  '&:active': {
    '& .MuiSwitch-switchBase.Mui-checked': {
      transform: 'translateX(1.2rem)',
    },
  },
  '& .MuiSwitch-switchBase': {
    padding: '0.2rem',
    '&.Mui-checked': {
      transform: 'translateX(1.2rem)',
      color: '#fff',
      '& + .MuiSwitch-track': {
        opacity: 1,
        backgroundColor: colorPrimary,
        ...theme.applyStyles('dark', {
          backgroundColor: colorPrimary,
        }),
      },
    },
  },
  '& .MuiSwitch-thumb': {
    boxShadow: '0 2px 4px 0 rgb(0 35 11 / 20%)',
    width: '0.6rem',
    height: '0.6rem',
    borderRadius: '0.5rem',
    transition: theme.transitions.create(['width'], {
      duration: 200,
    }),
    transform: 'translateY(1px)',
  },
  '& .MuiSwitch-track': {
    borderRadius: '0.6rem',
    opacity: 1,
    backgroundColor: 'rgba(0,0,0,.25)',
    boxSizing: 'border-box',
    ...theme.applyStyles('dark', {
      backgroundColor: 'rgba(255,255,255,.35)',
    }),
  },
}));

const BrightnessSlider = styled(Slider)`
  width: 100%;
  padding: 0.75rem 0 !important;
  box-sizing: border-box;

  & .MuiSlider-thumb {
    height: 1rem;
    width: 1rem;
  };
  & .MuiSlider-track {
    height: 5px;
  }
`;

const VirtualBgSelectorBorder = styled.div`
  width: 100%;
  border-radius: 0.25rem;
  border: 1px solid ${colorBorder};
`;

const CaptionsContainer = styled.div`
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  align-self: stretch;
  gap: 1.0rem;
  padding: 0px ${contentSidebarPadding};
`;

const CaptionsToggleContainer = styled.div`
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  align-self: stretch;
`;

const CaptionsSelectorContainer = styled.div`
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  width: 100%;
  gap: 0.5rem;
`;

const CaptionsLanguageText = styled.div`
  color: ${colorGrayDark};
  font-size: ${fontSizeSmall};
  font-weight: ${textFontWeight};
`;

const CaptionsTerms = styled.div`
  padding-left: 2.7rem;
  color: ${colorGrayDark};
  font-size: ${fontSizeSmall};
  font-weight: ${textFontWeight};
`;

const CaptionsTermsLink = styled.a`
  color: ${colorLink};
`;

const AddCameraContainer = styled.div`
  padding: 0.25rem ${contentSidebarPadding} 1rem;
`;

const AddCameraButtonAndText = styled.div<{ disabled?: boolean }>`
  cursor: pointer;
  padding: 0.35rem 0.25rem;
  display: flex;
  align-items: center;
  gap: 0.75rem;
  color: ${colorGrayDark};
  font-size: ${fontSizeBase};
  &:hover {
    border-radius: 0.5rem;
    background: ${colorInfoSurfaceAlt};
  }

  ${({ disabled }) => disabled && `
    cursor: not-allowed;
    opacity: 0.6;
    pointer-events: none;
  `}
`;

const SaveButtonContainer = styled.div`
  display: flex;
  flex-direction: column;
  align-items: stretch;
  gap: 0.5rem;
  padding: 0.15rem 0 0;
  width: 100%;
`;

// @ts-ignore - JS code
const SaveButton = styled(Button)`
  border-radius: ${lgBorderRadius};
  height: 2.75rem;
  width: 100%;
`;

const RemoveCameraButtonText = styled.button`
  appearance: none;
  border: 0;
  background: transparent;
  padding: 0;
  margin: 0 auto;
  cursor: pointer;
  color: ${colorDanger};
  text-decoration: underline;
  text-underline-offset: 0.15em;
  font-size: ${fontSizeSmall};
  font-weight: ${textFontWeight};
  align-self: center;
`;

export default {
  RootContainer,
  ProfileSettings,
  VideoPreview,
  VideoPreviewContainer,
  VideoPreviewWrapper,
  PreviewArrowButton,
  VideoPreviewContent,
  VideoCol,
  FetchingAnimation,
  UsernameContainer,
  UsernameTitle,
  Username,
  UserPresenceRoot,
  UserPresenceField,
  UserPresenceIndicator,
  UserPresenceDropdown,
  UserPresenceValueContainer,
  UserPresenceStatusDot,
  UserPresenceText,
  Separator,
  CameraSection,
  DevicesSettingsContainer,
  DeviceContainer,
  PreviewRow,
  PreviewTitle,
  PreviewTitleText,
  FieldStack,
  FieldLabel,
  IconCamera,
  WbSunnyIcon,
  HeadphonesIcon,
  MicIcon,
  ArrowLeftIcon,
  ArrowRightIcon,
  AddCameraIcon,
  DeviceSelector,
  DevicePlaceholder,
  DeviceFieldError,
  CameraQualityContainer,
  CameraQualityText,
  CameraQualitySelector,
  CameraNameLabel,
  VirtualBackgroundContainer,
  SwitchTitle,
  MaterialSwitch,
  BrightnessSlider,
  VirtualBgSelectorBorder,
  CaptionsContainer,
  CaptionsToggleContainer,
  CaptionsSelectorContainer,
  CaptionsLanguageText,
  CaptionsTerms,
  CaptionsTermsLink,
  SaveButton,
  SaveButtonContainer,
  AddCameraContainer,
  AddCameraButtonAndText,
  RemoveCameraButtonText,
};
