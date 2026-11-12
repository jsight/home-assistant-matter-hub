import type {
  CoverDeviceAttributes,
  HomeAssistantEntityInformation,
  HomeAssistantEntityState,
} from "@home-assistant-matter-hub/common";
import { Logger } from "@matter/general";
import { ClosureControlServer as Base } from "@matter/main/behaviors/closure-control";
import { ClosureControl } from "@matter/main/clusters";
import { applyPatchState } from "../../utils/apply-patch-state.js";
import { HomeAssistantEntityBehavior } from "./home-assistant-entity-behavior.js";
import type { ValueGetter, ValueSetter } from "./utils/cluster-config.js";

const logger = Logger.get("ClosureControlServer");

export interface ClosureControlServerConfig {
  getMainState: ValueGetter<ClosureControl.MainState>;
  getCurrentState: ValueGetter<ClosureControl.OverallCurrentState | null>;
  getTargetState: ValueGetter<ClosureControl.OverallTargetState | null>;
  moveTo: ValueSetter<ClosureControl.TargetPosition>;
  stop: ValueSetter<void>;
}

const FeaturedBase = Base.with("Positioning");

class ClosureControlServerBase extends FeaturedBase {
  declare state: ClosureControlServerBase.State;

  override async initialize() {
    this.state.mainState ??= ClosureControl.MainState.Stopped;
    this.state.currentErrorList ??= [];
    this.state.overallCurrentState ??= null;
    this.state.overallTargetState ??= null;

    await super.initialize();
    const homeAssistant = await this.agent.load(HomeAssistantEntityBehavior);
    this.update(homeAssistant.entity);
    this.reactTo(homeAssistant.onChange, this.update, { lock: true });
  }

  private update(entity: HomeAssistantEntityInformation) {
    if (!entity.state || !entity.state.attributes) return;

    const config = this.state.config;
    applyPatchState(this.state, {
      mainState: config.getMainState(entity.state, this.agent),
      currentErrorList: [],
      overallCurrentState: config.getCurrentState(entity.state, this.agent),
      overallTargetState: config.getTargetState(entity.state, this.agent),
    });
  }

  override moveTo(request: ClosureControl.MoveToRequest) {
    const position =
      request.position ?? this.state.overallTargetState?.position;
    const homeAssistant = this.agent.get(HomeAssistantEntityBehavior);
    const positionName =
      position == null
        ? "unset"
        : (ClosureControl.TargetPosition[position] ?? "unknown");

    logger.info(
      `[${homeAssistant.entityId}] ClosureControl MoveTo received: request=${JSON.stringify(request)} currentTarget=${JSON.stringify(this.state.overallTargetState)} resolvedPosition=${String(position)} (${positionName})`,
    );

    if (
      position !== ClosureControl.TargetPosition.MoveToFullyClosed &&
      position !== ClosureControl.TargetPosition.MoveToFullyOpen
    ) {
      logger.warn(
        `[${homeAssistant.entityId}] Ignoring ClosureControl MoveTo with unsupported or missing position: ${String(position)} (${positionName})`,
      );
      return;
    }

    const action = this.state.config.moveTo(position, this.agent);
    logger.info(
      `[${homeAssistant.entityId}] ClosureControl MoveTo mapped to Home Assistant action: ${JSON.stringify(action)}`,
    );
    try {
      homeAssistant.callAction(action);
    } catch (error) {
      logger.error(
        `[${homeAssistant.entityId}] ClosureControl MoveTo dispatch failed synchronously: ${error}`,
      );
      throw error;
    }
  }

  override stop() {
    const homeAssistant = this.agent.get(HomeAssistantEntityBehavior);
    const action = this.state.config.stop(void 0, this.agent);
    logger.info(
      `[${homeAssistant.entityId}] ClosureControl Stop received; mapped to Home Assistant action: ${JSON.stringify(action)}`,
    );
    try {
      homeAssistant.callAction(action);
    } catch (error) {
      logger.error(
        `[${homeAssistant.entityId}] ClosureControl Stop dispatch failed synchronously: ${error}`,
      );
      throw error;
    }
  }
}

namespace ClosureControlServerBase {
  export class State extends FeaturedBase.State {
    config!: ClosureControlServerConfig;
  }
}

export function ClosureControlServer(config: ClosureControlServerConfig) {
  return ClosureControlServerBase.set({ config });
}

export function closureCurrentPosition(
  entity: HomeAssistantEntityState,
): ClosureControl.CurrentPosition | null {
  switch (entity.state) {
    case "open":
      return ClosureControl.CurrentPosition.FullyOpened;
    case "closed":
      return ClosureControl.CurrentPosition.FullyClosed;
    case "opening":
    case "closing":
      return ClosureControl.CurrentPosition.PartiallyOpened;
  }

  const position = (entity.attributes as CoverDeviceAttributes)
    .current_position;
  if (typeof position !== "number" || !Number.isFinite(position)) return null;
  if (position <= 0) return ClosureControl.CurrentPosition.FullyClosed;
  if (position >= 100) return ClosureControl.CurrentPosition.FullyOpened;
  return ClosureControl.CurrentPosition.PartiallyOpened;
}
