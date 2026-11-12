import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HomeAssistantEntityInformation } from "@home-assistant-matter-hub/common";
import { Environment, VariableService } from "@matter/general";
import { ControllerBehavior, Endpoint, VendorId } from "@matter/main";
import { ClosureControl } from "@matter/main/clusters";
import { ServerNode } from "@matter/main/node";
import { Invoke } from "@matter/main/protocol";
import { StatusCode } from "@matter/main/types";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BridgeDataProvider } from "../../../../services/bridges/bridge-data-provider.js";
import {
  type HomeAssistantAction,
  HomeAssistantActions,
} from "../../../../services/home-assistant/home-assistant-actions.js";
import { AggregatorEndpoint } from "../../aggregator-endpoint.js";
import { ClosureCoverDevice } from "./index.js";

let dir: string;
let env: Environment;
let calls: { action: HomeAssistantAction; entityId?: string }[];
let server: ServerNode | undefined;
let controller: ServerNode | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "hamh-closure-loopback-"));
  env = new Environment("test", Environment.default);
  env.get(VariableService).set("storage.path", dir);
  calls = [];
  env.set(HomeAssistantActions, {
    call(action: HomeAssistantAction, entityId?: string) {
      calls.push({ action, entityId });
    },
    // biome-ignore lint/suspicious/noExplicitAny: test stub
  } as any);
  env.set(
    BridgeDataProvider,
    new BridgeDataProvider({
      id: "b",
      name: "b",
      port: 0,
      filter: { include: [], exclude: [], includeMode: "any" },
      basicInformation: {
        vendorId: 0xfff1,
        vendorName: "t",
        productName: "t",
        productLabel: "t",
        hardwareVersion: 1,
        softwareVersion: 1,
        // biome-ignore lint/suspicious/noExplicitAny: test fixture
      } as any,
      // biome-ignore lint/suspicious/noExplicitAny: test fixture
    } as any),
  );
});

afterEach(async () => {
  await controller?.close().catch(() => {});
  controller = undefined;
  await server?.close().catch(() => {});
  server = undefined;
  rmSync(dir, { recursive: true, force: true });
});

function garageEntity(): HomeAssistantEntityInformation {
  const state = {
    entity_id: "cover.garage_door",
    state: "closed",
    attributes: {
      friendly_name: "Garage Door",
      device_class: "garage",
      supported_features: 7,
    },
    context: { id: "ctx" },
    last_changed: "2026-01-01T00:00:00",
    last_updated: "2026-01-01T00:00:00",
  };
  // biome-ignore lint/suspicious/noExplicitAny: test fixture
  return { entity_id: "cover.garage_door", state: state as any };
}

async function invokeMoveTo(
  // biome-ignore lint/suspicious/noExplicitAny: matter.js remote client API is loosely typed
  client: any,
  endpoint: number,
  position: ClosureControl.TargetPosition,
) {
  const statuses: unknown[] = [];
  const responses: unknown[] = [];
  const result = client.interaction.invoke(
    Invoke({
      commands: [
        {
          endpoint,
          cluster: ClosureControl,
          command: "moveTo",
          fields: { position },
          // biome-ignore lint/suspicious/noExplicitAny: Matter invoke command fixture
        } as any,
      ],
    }),
  );
  for await (const chunk of result) {
    for (const entry of chunk) {
      if (entry.kind === "cmd-status") statuses.push(entry.status);
      if (entry.kind === "cmd-response") responses.push(entry.data);
    }
  }
  return { statuses, responses };
}

describe("ClosureControl MoveTo loopback", () => {
  it(
    "returns Matter success and calls the matching HA service for open and close",
    { timeout: 120_000 },
    async () => {
      const nodeId = "closure-control-loopback";
      server = await ServerNode.create({
        // biome-ignore lint/suspicious/noExplicitAny: env valid at runtime
        environment: env as any,
        id: nodeId,
        network: { port: 0 },
        commissioning: { passcode: 20202021, discriminator: 3840 },
        basicInformation: { vendorId: VendorId(0xfff1), productId: 0x8000 },
      });
      const aggregator = new AggregatorEndpoint("aggregator");
      await server.add(aggregator);
      const garage = new Endpoint(
        ClosureCoverDevice({ entity: garageEntity() } as never)!,
        { id: "garage_door" },
      );
      await aggregator.add(garage);
      await server.start();

      // biome-ignore lint/suspicious/noExplicitAny: read runtime state
      const port = (server.state as any).network.operationalPort as number;
      controller = await ServerNode.create(
        ServerNode.RootEndpoint.with(ControllerBehavior),
        {
          // biome-ignore lint/suspicious/noExplicitAny: env valid at runtime
          environment: env as any,
          id: "closure-control-controller",
          network: { port: 0 },
          basicInformation: { vendorId: VendorId(0xfff1), productId: 0x8001 },
        },
      );
      await controller.start();

      const client = await controller.peers.forDescriptor({
        addresses: [{ type: "udp", ip: "127.0.0.1", port }],
        deviceIdentifier: nodeId,
        D: 3840,
        CM: 1,
        // biome-ignore lint/suspicious/noExplicitAny: matter.js discovery descriptor
      } as any);
      await client.commission({
        passcode: 20202021,
        discriminator: 3840,
        autoSubscribe: false,
        autoStateInitialize: false,
      });

      const open = await invokeMoveTo(
        client,
        garage.number,
        ClosureControl.TargetPosition.MoveToFullyOpen,
      );
      expect(open.statuses).toEqual([StatusCode.Success]);
      expect(calls).toEqual([
        {
          action: { action: "cover.open_cover" },
          entityId: "cover.garage_door",
        },
      ]);

      calls.length = 0;
      const close = await invokeMoveTo(
        client,
        garage.number,
        ClosureControl.TargetPosition.MoveToFullyClosed,
      );
      expect(close.statuses).toEqual([StatusCode.Success]);
      expect(calls).toEqual([
        {
          action: { action: "cover.close_cover" },
          entityId: "cover.garage_door",
        },
      ]);
    },
  );
});
