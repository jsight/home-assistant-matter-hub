import {
  type CoverDeviceAttributes,
  CoverSupportedFeatures,
} from "@home-assistant-matter-hub/common";
import { Logger } from "@matter/general";
import type { EndpointType } from "@matter/main";
import { DescriptorServer } from "@matter/main/behaviors";
import { ClosureControl, type WindowCovering } from "@matter/main/clusters";
import { ClosureDevice, WindowCoveringDevice } from "@matter/main/devices";
import { Namespace } from "@matter/main/types";

const logger = Logger.get("CoverDevice");

import type { FeatureSelection } from "../../../../utils/feature-selection.js";
import { testBit } from "../../../../utils/test-bit.js";
import { BasicInformationServer } from "../../../behaviors/basic-information-server.js";
import {
  ClosureControlServer,
  closureCurrentPosition,
} from "../../../behaviors/closure-control-server.js";
import { HomeAssistantEntityBehavior } from "../../../behaviors/home-assistant-entity-behavior.js";
import { IdentifyServer } from "../../../behaviors/identify-server.js";
import { DefaultPowerSourceServer } from "../../../behaviors/power-source-server.js";
import {
  CoverAsDimmableLightType,
  CoverAsDimmableLightWithBatteryType,
} from "./behaviors/cover-as-light.js";
import {
  CoverWindowCoveringServer,
  coverHasTilt,
  closureCloseAction,
  closureOpenAction,
} from "./behaviors/cover-window-covering-server.js";

const CoverDeviceType = (
  supportedFeatures: number,
  hasBattery: boolean,
  entityId: string,
) => {
  const features: FeatureSelection<typeof WindowCovering.Complete> = new Set();

  // Always add Lift and PositionAwareLift for all covers.
  // Apple Home requires PositionAwareLift to properly recognize WindowCovering devices.
  // Without it, Apple Home may show the device as "clima" (thermostat) instead (#78).
  // For binary covers (gates, garage doors), we report 0% (open) or 100% (closed)
  // based on the cover state - see cover-window-covering-server.ts getCurrentLiftPosition.
  if (testBit(supportedFeatures, CoverSupportedFeatures.support_open)) {
    features.add("Lift");
    features.add("PositionAwareLift");
  } else {
    // Fallback: add features even if support_open is not set so the
    // WindowCovering device comes up with a valid descriptor.
    logger.warn(
      `[${entityId}] Cover has no support_open feature (supported_features=${supportedFeatures}), adding Lift anyway`,
    );
    features.add("Lift");
    features.add("PositionAwareLift");
  }

  // Tilt on open_tilt or set_tilt_position; PA_TL still needs set_tilt_position (#405).
  if (coverHasTilt(supportedFeatures)) {
    features.add("Tilt");
    if (
      testBit(
        supportedFeatures,
        CoverSupportedFeatures.support_set_tilt_position,
      )
    ) {
      features.add("PositionAwareTilt");
    }
  }

  logger.info(
    `[${entityId}] Creating WindowCovering with features: [${[...features].join(", ")}], supported_features=${supportedFeatures}`,
  );

  const baseBehaviors = [
    BasicInformationServer,
    IdentifyServer,
    HomeAssistantEntityBehavior,
    CoverWindowCoveringServer.with(...features),
  ] as const;

  if (hasBattery) {
    return WindowCoveringDevice.with(
      ...baseBehaviors,
      DefaultPowerSourceServer,
    );
  }
  return WindowCoveringDevice.with(...baseBehaviors);
};

const closureTagForDeviceClass = (deviceClass: string | undefined): number => {
  switch (deviceClass?.toLowerCase()) {
    case "garage":
    case "garage_door":
      return 5; // Closure.GarageDoor
    case "gate":
      return 4; // Closure.Gate
    case "window":
      return 1; // Closure.Window
    case "door":
      return 6; // Closure.Door
    default:
      return 0; // Closure.Covering
  }
};

function CoverClosureDevice(
  homeAssistantEntity: HomeAssistantEntityBehavior.State,
) {
  const attributes = homeAssistantEntity.entity.state
    .attributes as CoverDeviceAttributes & {
    device_class?: string;
    battery?: number;
    battery_level?: number;
  };
  const hasBattery =
    attributes.battery_level != null ||
    attributes.battery != null ||
    !!homeAssistantEntity.mapping?.batteryEntity;
  const tag = closureTagForDeviceClass(attributes.device_class);
  const descriptor = DescriptorServer.with("TagList").set({
    tagList: [{ mfgCode: null, namespaceId: Namespace.Closure, tag }],
  });

  const closureControl = ClosureControlServer({
    getMainState: (entity) =>
      entity.state === "opening" || entity.state === "closing"
        ? ClosureControl.MainState.Moving
        : ClosureControl.MainState.Stopped,
    getCurrentState: (entity) => {
      const position = closureCurrentPosition(entity);
      if (position == null) return null;
      return {
        position,
        secureState:
          position === ClosureControl.CurrentPosition.FullyClosed
            ? true
            : position === ClosureControl.CurrentPosition.FullyOpened ||
                position === ClosureControl.CurrentPosition.PartiallyOpened
              ? false
              : null,
      };
    },
    getTargetState: (entity) => {
      if (entity.state === "opening") {
        return {
          position: ClosureControl.TargetPosition.MoveToFullyOpen,
        };
      }
      if (entity.state === "closing") {
        return {
          position: ClosureControl.TargetPosition.MoveToFullyClosed,
        };
      }
      return null;
    },
    moveTo: (position, agent) =>
      position === ClosureControl.TargetPosition.MoveToFullyOpen
        ? closureOpenAction(agent)
        : closureCloseAction(agent),
    stop: () => ({ action: "cover.stop_cover" }),
  });

  const baseBehaviors = [
    descriptor,
    BasicInformationServer,
    IdentifyServer,
    HomeAssistantEntityBehavior,
    closureControl,
  ] as const;

  if (hasBattery) {
    return ClosureDevice.with(...baseBehaviors, DefaultPowerSourceServer);
  }
  return ClosureDevice.with(...baseBehaviors);
}

export function ClosureCoverDevice(
  homeAssistantEntity: HomeAssistantEntityBehavior.State,
): EndpointType | undefined {
  if (homeAssistantEntity.entity.entity_id.split(".")[0] !== "cover") {
    return undefined;
  }
  return CoverClosureDevice(homeAssistantEntity).set({
    homeAssistantEntity,
  });
}

export function CoverDevice(
  homeAssistantEntity: HomeAssistantEntityBehavior.State,
): EndpointType {
  const entityId = homeAssistantEntity.entity.entity_id;
  const attributes = homeAssistantEntity.entity.state
    .attributes as CoverDeviceAttributes & {
    battery?: number;
    battery_level?: number;
  };
  const hasBatteryAttr =
    attributes.battery_level != null || attributes.battery != null;
  const hasBatteryEntity = !!homeAssistantEntity.mapping?.batteryEntity;
  const hasBattery = hasBatteryAttr || hasBatteryEntity;

  if (hasBattery) {
    logger.info(
      `[${entityId}] Creating cover with PowerSource cluster, ` +
        `batteryAttr=${hasBatteryAttr}, batteryEntity=${homeAssistantEntity.mapping?.batteryEntity ?? "none"}`,
    );
  } else {
    logger.debug(
      `[${entityId}] Creating cover without battery (batteryAttr=${hasBatteryAttr}, batteryEntity=${homeAssistantEntity.mapping?.batteryEntity ?? "none"})`,
    );
  }

  // Alexa stopped sending WindowCovering position commands; expose the cover
  // as a Dimmable Light so its slider still works (#372).
  if (homeAssistantEntity.mapping?.coverExposeAsDimmableLight) {
    logger.info(`[${entityId}] Exposing cover as a Dimmable Light (#372)`);
    const type = hasBattery
      ? CoverAsDimmableLightWithBatteryType
      : CoverAsDimmableLightType;
    return type.set({ homeAssistantEntity });
  }

  return CoverDeviceType(
    attributes.supported_features ?? 0,
    hasBattery,
    entityId,
  ).set({
    homeAssistantEntity,
  });
}
