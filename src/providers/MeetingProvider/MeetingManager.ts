// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  ActiveSpeakerPolicy,
  AudioInputDevice,
  AudioVideoFacade,
  AudioVideoObserver,
  ConsoleLogger,
  DefaultActiveSpeakerPolicy,
  DefaultBrowserBehavior,
  DefaultDeviceController,
  DefaultMeetingSession,
  EventAttributes,
  EventController,
  EventName,
  EventObserver,
  Logger,
  LogLevel,
  MeetingSessionConfiguration,
  // MeetingSessionPOSTLogger,
  MeetingSessionStatus,
  MeetingSessionStatusCode,
  MultiLogger,
  VideoInputDevice,
} from 'amazon-chime-sdk-js';

import { DeviceLabels, DeviceLabelTrigger, MeetingStatus } from '../../types';
import {
  AttendeeResponse,
  DevicePermissionStatus,
  FullDeviceInfoType,
  MeetingManagerJoinOptions,
  ParsedJoinParams,
  PostLoggerConfig,
} from './types';

function noOpDeviceLabelHook(): Promise<MediaStream> {
  return Promise.resolve(new MediaStream());
}

export class MeetingManager implements AudioVideoObserver {
  meetingSession: DefaultMeetingSession | null = null;

  meetingStatus: MeetingStatus = MeetingStatus.Loading;

  meetingStatusObservers: ((meetingStatus: MeetingStatus) => void)[] = [];

  audioVideo: AudioVideoFacade | null = null;

  audioVideoObservers: AudioVideoObserver = {};

  meetingSessionConfiguration: MeetingSessionConfiguration | undefined;

  meetingId: string | null = null;

  getAttendee?: (
    chimeAttendeeId: string,
    externalUserId?: string
  ) => Promise<AttendeeResponse>;

  selectedAudioOutputDevice: string | null;

  selectedAudioOutputDeviceObservers: ((deviceId: string | null) => void)[] =
    [];

  selectedAudioInputDevice: AudioInputDevice | undefined;

  selectedAudioInputDeviceObservers: ((
    device: AudioInputDevice | undefined
  ) => void)[] = [];

  selectedVideoInputDevice: VideoInputDevice | undefined;

  selectedVideoInputDeviceObservers: ((
    device: VideoInputDevice | undefined
  ) => void)[] = [];

  deviceLabelTriggerChangeObservers: (() => void)[] = [];

  audioInputDevices: MediaDeviceInfo[] | null = null;

  audioOutputDevices: MediaDeviceInfo[] | null = null;

  videoInputDevices: MediaDeviceInfo[] | null = null;

  devicePermissionStatus = DevicePermissionStatus.UNSET;

  devicePermissionsObservers: ((permission: DevicePermissionStatus) => void)[] =
    [];

  activeSpeakerListener: ((activeSpeakers: string[]) => void) | null = null;

  activeSpeakerCallbacks: ((activeSpeakers: string[]) => void)[] = [];

  activeSpeakers: string[] = [];

  audioVideoCallbacks: ((audioVideo: AudioVideoFacade | null) => void)[] = [];

  devicesUpdatedCallbacks: ((fullDeviceInfo: FullDeviceInfoType) => void)[] =
    [];

  logger: Logger;

  private meetingEventObserverSet = new Set<
    (name: EventName, attributes: EventAttributes) => void
  >();

  private eventDidReceiveRef: EventObserver;

  constructor() {
    this.eventDidReceiveRef = {
      eventDidReceive: (name: EventName, attributes: EventAttributes) => {
        this.publishEventDidReceiveUpdate(name, attributes);
      },
    };
  }

  initializeMeetingManager(): void {
    this.meetingSession = null;
    this.audioVideo = null;
    this.meetingSessionConfiguration = undefined;
    this.meetingId = null;
    this.selectedAudioOutputDevice = null;
    this.selectedAudioInputDevice = undefined;
    this.selectedVideoInputDevice = undefined;
    this.audioInputDevices = [];
    this.audioOutputDevices = [];
    this.videoInputDevices = [];
    this.activeSpeakers = [];
    this.activeSpeakerListener = null;
    this.audioVideoObservers = {};
  }

  async join(
    meetingSessionConfiguration: MeetingSessionConfiguration,
    options?: MeetingManagerJoinOptions
  ): Promise<void> {
    const {
      deviceLabels,
      eventController,
      logger,
      enableWebAudio,
      activeSpeakerPolicy,
    } = this.parseJoinParams(meetingSessionConfiguration, options);
    this.meetingSessionConfiguration = meetingSessionConfiguration;
    this.meetingId = this.meetingSessionConfiguration.meetingId;
    this.logger = logger;

    const deviceController = new DefaultDeviceController(logger, {
      enableWebAudio: enableWebAudio,
    });
    this.meetingSession = new DefaultMeetingSession(
      meetingSessionConfiguration,
      logger,
      deviceController,
      eventController
    );

    this.audioVideo = this.meetingSession.audioVideo;

    if (eventController) {
      eventController.addObserver(this.eventDidReceiveRef);
    } else {
      this.meetingSession.eventController.addObserver(this.eventDidReceiveRef);
    }

    this.setupAudioVideoObservers();
    this.setupDeviceLabelTrigger(deviceLabels);
    await this.listAndSelectDevices(deviceLabels);
    this.publishAudioVideo();
    this.setupActiveSpeakerDetection(activeSpeakerPolicy);
    this.meetingStatus = MeetingStatus.Loading;
    this.publishMeetingStatus();
  }

  private parseJoinParams(
    meetingSessionConfiguration: MeetingSessionConfiguration,
    options?: MeetingManagerJoinOptions
  ): ParsedJoinParams {
    const deviceLabels: DeviceLabels | DeviceLabelTrigger =
      options?.deviceLabels || DeviceLabels.AudioAndVideo;
    const eventController: EventController | undefined =
      options?.eventController;
    const logLevel: LogLevel = options?.logLevel || LogLevel.WARN;
    const postLoggerConfig: PostLoggerConfig | undefined =
      options?.postLoggerConfig;
    const logger: Logger =
      options?.logger ||
      this.createLogger(
        logLevel,
        meetingSessionConfiguration,
        postLoggerConfig
      );
    const enableWebAudio: boolean = options?.enableWebAudio || false;
    const activeSpeakerPolicy: ActiveSpeakerPolicy =
      options?.activeSpeakerPolicy || new DefaultActiveSpeakerPolicy();

    return {
      deviceLabels,
      eventController,
      logger,
      enableWebAudio,
      activeSpeakerPolicy,
    };
  }

  async start(): Promise<void> {
    this.audioVideo?.start();
  }

  async leave(): Promise<void> {
    if (this.audioVideo) {
      this.audioVideo.stopContentShare();
      this.audioVideo.stopLocalVideoTile();
      this.audioVideo.unbindAudioElement();

      try {
        await this.meetingSession?.deviceController.chooseAudioOutput(null);
        await this.meetingSession?.deviceController.destroy();
      } catch (error) {
        console.log(
          'MeetingManager failed to clean up media resources on leave'
        );
      }

      if (this.activeSpeakerListener) {
        this.audioVideo.unsubscribeFromActiveSpeakerDetector(
          this.activeSpeakerListener
        );
      }

      this.audioVideo.stop();
    }
    this.initializeMeetingManager();
    this.publishAudioVideo();
    this.publishActiveSpeaker();
  }

  private createLogger(
    logLevel: LogLevel,
    meetingSessionConfiguration: MeetingSessionConfiguration,
    postLoggerConfig?: PostLoggerConfig
  ): Logger {
    const consoleLogger = new ConsoleLogger('SDK', logLevel);
    let logger: ConsoleLogger | MultiLogger = consoleLogger;

    if (postLoggerConfig) {
      logger = new MultiLogger(consoleLogger);
      // const { name, batchSize, intervalMs, url, logLevel } = postLoggerConfig;
      // logger = new MultiLogger(
      //   consoleLogger,
      //   new MeetingSessionPOSTLogger(
      //     name,
      //     meetingSessionConfiguration,
      //     batchSize,
      //     intervalMs,
      //     url,
      //     logLevel
      //   )
      // );
    }

    return logger;
  }

  audioVideoDidStart = (): void => {
    console.log(
      '[MeetingManager audioVideoDidStart] Meeting started successfully'
    );
    this.meetingStatus = MeetingStatus.Succeeded;
    this.publishMeetingStatus();
  };

  audioVideoDidStop = (sessionStatus: MeetingSessionStatus): void => {
    const sessionStatusCode = sessionStatus.statusCode();
    switch (sessionStatusCode) {
      case MeetingSessionStatusCode.MeetingEnded:
        console.log(
          `[MeetingManager audioVideoDidStop] Meeting ended for all: ${sessionStatusCode}`
        );
        this.meetingStatus = MeetingStatus.Ended;
        break;
      case MeetingSessionStatusCode.Left:
        console.log(
          `[MeetingManager audioVideoDidStop] Left the meeting: ${sessionStatusCode}`
        );
        this.meetingStatus = MeetingStatus.Left;
        break;
      case MeetingSessionStatusCode.AudioJoinedFromAnotherDevice:
        console.log(
          `[MeetingManager audioVideoDidStop] Meeting joined from another device: ${sessionStatusCode}`
        );
        this.meetingStatus = MeetingStatus.JoinedFromAnotherDevice;
        break;
      default:
        // The following status codes are Failures according to MeetingSessionStatus
        if (sessionStatus.isFailure()) {
          console.log(
            `[MeetingManager audioVideoDidStop] Non-Terminal failure occurred: ${sessionStatusCode}`
          );
          this.meetingStatus = MeetingStatus.Failed;
        } else if (sessionStatus.isTerminal()) {
          console.log(
            `[MeetingManager audioVideoDidStop] Terminal failure occurred: ${sessionStatusCode}`
          );
          this.meetingStatus = MeetingStatus.TerminalFailure;
        } else {
          console.log(
            `[MeetingManager audioVideoDidStop] session stopped with code ${sessionStatusCode}`
          );
        }
    }

    this.publishMeetingStatus();
    this.audioVideo?.removeObserver(this.audioVideoObservers);
    this.leave();
  };

  setupAudioVideoObservers(): void {
    if (!this.audioVideo) {
      return;
    }

    this.audioVideoObservers = {
      audioVideoDidStart: this.audioVideoDidStart,
      audioVideoDidStop: this.audioVideoDidStop,
    };

    this.audioVideo.addObserver(this.audioVideoObservers);
  }

  async updateDeviceLists(): Promise<void> {
    this.audioInputDevices =
      (await this.audioVideo?.listAudioInputDevices()) || [];
    this.videoInputDevices =
      (await this.audioVideo?.listVideoInputDevices()) || [];
    this.audioOutputDevices =
      (await this.audioVideo?.listAudioOutputDevices()) || [];
  }

  setupDeviceLabelTrigger(
    deviceLabels: DeviceLabels | DeviceLabelTrigger = DeviceLabels.AudioAndVideo
  ): void {
    let callback: DeviceLabelTrigger;

    if (typeof deviceLabels === 'function') {
      callback = deviceLabels;
    } else if (deviceLabels === DeviceLabels.None) {
      callback = noOpDeviceLabelHook;
    } else {
      const constraints: MediaStreamConstraints = {};

      switch (deviceLabels) {
        case DeviceLabels.Audio:
          constraints.audio = true;
          break;
        case DeviceLabels.Video:
          constraints.video = true;
          break;
        case DeviceLabels.AudioAndVideo:
          constraints.audio = true;
          constraints.video = true;
          break;
      }

      callback = async (): Promise<MediaStream> => {
        this.devicePermissionStatus = DevicePermissionStatus.IN_PROGRESS;
        this.publishDevicePermissionStatus();
        try {
          const devices = await navigator.mediaDevices.enumerateDevices();
          const hasVideoInput = devices.some(
            (value) => value.kind === 'videoinput'
          );

          const stream = await navigator.mediaDevices.getUserMedia({
            audio: constraints.audio,
            video: constraints.video && hasVideoInput,
          });

          this.devicePermissionStatus = DevicePermissionStatus.GRANTED;
          this.publishDevicePermissionStatus();
          return stream;
        } catch (error) {
          console.error('MeetingManager failed to get device permissions');
          this.devicePermissionStatus = DevicePermissionStatus.DENIED;
          this.publishDevicePermissionStatus();
          throw new Error(error);
        }
      };
    }

    this.audioVideo?.setDeviceLabelTrigger(callback);
  }

  private setupActiveSpeakerDetection(
    activeSpeakerPolicy: ActiveSpeakerPolicy
  ): void {
    this.publishActiveSpeaker();

    this.activeSpeakerListener = (activeSpeakers: string[]) => {
      this.activeSpeakers = activeSpeakers;
      this.activeSpeakerCallbacks.forEach((cb) => cb(activeSpeakers));
    };

    this.audioVideo?.subscribeToActiveSpeakerDetector(
      activeSpeakerPolicy
        ? activeSpeakerPolicy
        : new DefaultActiveSpeakerPolicy(),
      this.activeSpeakerListener
    );
  }

  async listAndSelectDevices(
    deviceLabels: DeviceLabels | DeviceLabelTrigger = DeviceLabels.AudioAndVideo
  ): Promise<void> {
    await this.updateDeviceLists();

    // If `deviceLabels` is of `DeviceLabelTrigger` type, no device will be selected.
    // In this case, you need to handle the device selection yourself.
    if (typeof deviceLabels === 'function') return;

    let isAudioDeviceRequested: boolean = false;
    let isVideoDeviceRequested: boolean = false;

    switch (deviceLabels) {
      case DeviceLabels.None:
        break;
      case DeviceLabels.Audio:
        isAudioDeviceRequested = true;
        break;
      case DeviceLabels.Video:
        isVideoDeviceRequested = true;
        break;
      case DeviceLabels.AudioAndVideo:
        isAudioDeviceRequested = true;
        isVideoDeviceRequested = true;
        break;
    }

    if (
      isAudioDeviceRequested &&
      !this.selectedAudioInputDevice &&
      this.audioInputDevices &&
      this.audioInputDevices.length
    ) {
      this.selectedAudioInputDevice = this.audioInputDevices[0].deviceId;
      try {
        await this.audioVideo?.startAudioInput(
          this.audioInputDevices[0].deviceId
        );
      } catch (error) {
        console.error(
          'MeetingManager failed to select audio input device on join',
          error
        );
      }
      this.publishSelectedAudioInputDevice();
    }
    if (
      isAudioDeviceRequested &&
      !this.selectedAudioOutputDevice &&
      this.audioOutputDevices &&
      this.audioOutputDevices.length
    ) {
      this.selectedAudioOutputDevice = this.audioOutputDevices[0].deviceId;
      if (new DefaultBrowserBehavior().supportsSetSinkId()) {
        try {
          await this.audioVideo?.chooseAudioOutput(
            this.audioOutputDevices[0].deviceId
          );
        } catch (error) {
          console.error(
            'MeetingManager failed to select audio output device on join',
            error
          );
        }
      }
      this.publishSelectedAudioOutputDevice();
    }
    if (
      isVideoDeviceRequested &&
      !this.selectedVideoInputDevice &&
      this.videoInputDevices &&
      this.videoInputDevices.length
    ) {
      this.selectedVideoInputDevice = this.videoInputDevices[0].deviceId;
      this.publishSelectedVideoInputDevice();
    }
  }

  selectAudioInputDevice = async (device: AudioInputDevice): Promise<void> => {
    try {
      await this.audioVideo?.startAudioInput(device);
      this.selectedAudioInputDevice = device;
      this.publishSelectedAudioInputDevice();
    } catch (error) {
      console.error(
        'MeetingManager failed to select audio input device',
        error
      );
      throw new Error('MeetingManager failed to select audio input device');
    }
  };

  selectAudioOutputDevice = async (deviceId: string): Promise<void> => {
    try {
      await this.audioVideo?.chooseAudioOutput(deviceId);
      this.selectedAudioOutputDevice = deviceId;
      this.publishSelectedAudioOutputDevice();
    } catch (error) {
      console.error(
        'MeetingManager failed to select audio output device',
        error
      );
      throw new Error('MeetingManager failed to select audio output device');
    }
  };

  selectVideoInputDevice = async (device: VideoInputDevice): Promise<void> => {
    try {
      await this.audioVideo?.startVideoInput(device);
      this.selectedVideoInputDevice = device;
      this.publishSelectedVideoInputDevice();
    } catch (error) {
      console.error(
        'MeetingManager failed to select video input device',
        error
      );
      throw new Error('MeetingManager failed to select video input device');
    }
  };

  unselectVideoInputDevice = async (): Promise<void> => {
    try {
      await this.audioVideo?.stopVideoInput();
      this.selectedVideoInputDevice = undefined;
      this.publishSelectedVideoInputDevice();
    } catch (error) {
      console.error(
        'MeetingManager failed to unselect video input device',
        error
      );
      throw new Error('MeetingManager failed to unselect video input device');
    }
  };

  invokeDeviceProvider = (deviceLabels: DeviceLabels): void => {
    this.setupDeviceLabelTrigger(deviceLabels);
    this.publishDeviceLabelTriggerChange();
  };

  /**
   * ====================================================================
   * Subscriptions
   * ====================================================================
   */

  subscribeToAudioVideo = (
    callback: (av: AudioVideoFacade | null) => void
  ): void => {
    this.audioVideoCallbacks.push(callback);
  };

  unsubscribeFromAudioVideo = (
    callbackToRemove: (av: AudioVideoFacade | null) => void
  ): void => {
    this.audioVideoCallbacks = this.audioVideoCallbacks.filter(
      (callback) => callback !== callbackToRemove
    );
  };

  publishAudioVideo = (): void => {
    this.audioVideoCallbacks.forEach((callback) => {
      callback(this.audioVideo);
    });
  };

  subscribeToActiveSpeaker = (
    callback: (activeSpeakers: string[]) => void
  ): void => {
    this.activeSpeakerCallbacks.push(callback);
    callback(this.activeSpeakers);
  };

  unsubscribeFromActiveSpeaker = (
    callbackToRemove: (activeSpeakers: string[]) => void
  ): void => {
    this.activeSpeakerCallbacks = this.activeSpeakerCallbacks.filter(
      (callback) => callback !== callbackToRemove
    );
  };

  publishActiveSpeaker = (): void => {
    this.activeSpeakerCallbacks.forEach((callback) => {
      callback(this.activeSpeakers);
    });
  };

  subscribeToDevicePermissionStatus = (
    callback: (permission: DevicePermissionStatus) => void
  ): void => {
    this.devicePermissionsObservers.push(callback);
  };

  unsubscribeFromDevicePermissionStatus = (
    callbackToRemove: (permission: DevicePermissionStatus) => void
  ): void => {
    this.devicePermissionsObservers = this.devicePermissionsObservers.filter(
      (callback) => callback !== callbackToRemove
    );
  };

  private publishDevicePermissionStatus = (): void => {
    for (const observer of this.devicePermissionsObservers) {
      observer(this.devicePermissionStatus);
    }
  };

  subscribeToSelectedVideoInputDevice = (
    callback: (device: VideoInputDevice | undefined) => void
  ): void => {
    this.selectedVideoInputDeviceObservers.push(callback);
  };

  unsubscribeFromSelectedVideoInputDevice = (
    callbackToRemove: (device: VideoInputDevice | undefined) => void
  ): void => {
    this.selectedVideoInputDeviceObservers =
      this.selectedVideoInputDeviceObservers.filter(
        (callback) => callback !== callbackToRemove
      );
  };

  private publishSelectedVideoInputDevice = (): void => {
    for (const observer of this.selectedVideoInputDeviceObservers) {
      observer(this.selectedVideoInputDevice);
    }
  };

  subscribeToSelectedAudioInputDevice = (
    callback: (device: AudioInputDevice) => void
  ): void => {
    this.selectedAudioInputDeviceObservers.push(callback);
  };

  unsubscribeFromSelectedAudioInputDevice = (
    callbackToRemove: (device: AudioInputDevice) => void
  ): void => {
    this.selectedAudioInputDeviceObservers =
      this.selectedAudioInputDeviceObservers.filter(
        (callback) => callback !== callbackToRemove
      );
  };

  private publishSelectedAudioInputDevice = (): void => {
    for (const observer of this.selectedAudioInputDeviceObservers) {
      observer(this.selectedAudioInputDevice);
    }
  };

  subscribeToSelectedAudioOutputDevice = (
    callback: (deviceId: string | null) => void
  ): void => {
    this.selectedAudioOutputDeviceObservers.push(callback);
  };

  unsubscribeFromSelectedAudioOutputDevice = (
    callbackToRemove: (deviceId: string | null) => void
  ): void => {
    this.selectedAudioOutputDeviceObservers =
      this.selectedAudioOutputDeviceObservers.filter(
        (callback) => callback !== callbackToRemove
      );
  };

  private publishSelectedAudioOutputDevice = (): void => {
    for (const observer of this.selectedAudioOutputDeviceObservers) {
      observer(this.selectedAudioOutputDevice);
    }
  };

  subscribeToMeetingStatus = (
    callback: (meetingStatus: MeetingStatus) => void
  ): void => {
    this.meetingStatusObservers.push(callback);
    callback(this.meetingStatus);
  };

  unsubscribeFromMeetingStatus = (
    callbackToRemove: (meetingStatus: MeetingStatus) => void
  ): void => {
    this.meetingStatusObservers = this.meetingStatusObservers.filter(
      (callback) => callback !== callbackToRemove
    );
  };

  private publishMeetingStatus = (): void => {
    this.meetingStatusObservers.forEach((callback) => {
      callback(this.meetingStatus);
    });
  };

  subscribeToDeviceLabelTriggerChange = (callback: () => void): void => {
    this.deviceLabelTriggerChangeObservers.push(callback);
  };

  unsubscribeFromDeviceLabelTriggerChange = (
    callbackToRemove: () => void
  ): void => {
    this.deviceLabelTriggerChangeObservers =
      this.deviceLabelTriggerChangeObservers.filter(
        (callback) => callback !== callbackToRemove
      );
  };

  private publishDeviceLabelTriggerChange = (): void => {
    for (const callback of this.deviceLabelTriggerChangeObservers) {
      callback();
    }
  };

  subscribeToEventDidReceive = (
    callback: (name: EventName, attributes: EventAttributes) => void
  ): void => {
    this.meetingEventObserverSet.add(callback);
  };

  unsubscribeFromEventDidReceive = (
    callbackToRemove: (name: EventName, attributes: EventAttributes) => void
  ): void => {
    this.meetingEventObserverSet.delete(callbackToRemove);
  };

  private publishEventDidReceiveUpdate = (
    name: EventName,
    attributes: EventAttributes
  ): void => {
    this.meetingEventObserverSet.forEach((callback) =>
      callback(name, attributes)
    );
  };
}

export default MeetingManager;
