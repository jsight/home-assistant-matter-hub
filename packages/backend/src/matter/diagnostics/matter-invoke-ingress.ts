import { type Bytes, Logger } from "@matter/general";
import { MessageExchange, MessageType } from "@matter/protocol";
import {
  INTERACTION_PROTOCOL_ID,
  TlvAny,
  TlvInvokeRequest,
} from "@matter/types";

const logger = Logger.get("MatterInvokeIngress");

let installed = false;

function toHex(bytes: Bytes): string {
  const view = ArrayBuffer.isView(bytes)
    ? new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    : new Uint8Array(bytes);
  return Array.from(view, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}

function stringify(value: unknown): string {
  return JSON.stringify(value, (_key, child) =>
    typeof child === "bigint" ? child.toString() : child,
  );
}

/**
 * Log decoded Matter InvokeRequests before InteractionServer validation and
 * endpoint dispatch. This exposes the command path, timed flag, and command
 * fields even when the target cluster rejects the request. Fields from other
 * clusters are redacted to avoid logging unrelated device credentials.
 *
 * A failed top-level TLV decode is logged with raw bytes at DEBUG level. The
 * normal Matter MessageExchange debug trace also records this payload.
 */
export function installMatterInvokeIngressDiagnostics(): void {
  if (installed) return;
  installed = true;
  logger.info("Matter interaction ingress diagnostics installed");

  const receive = MessageExchange.prototype.onMessageReceived;
  MessageExchange.prototype.onMessageReceived = async function (
    message,
    duplicate,
  ) {
    if (message.payloadHeader.protocolId === INTERACTION_PROTOCOL_ID) {
      logger.info(
        `Incoming Matter interaction before validation via ${this.via}: ${stringify({
          messageId: message.packetHeader.messageId,
          messageType: `0x${message.payloadHeader.messageType.toString(16).padStart(2, "0")}`,
          timedRequest: message.payloadHeader.messageType === 0x0a,
          duplicate,
          payloadBytes: message.payload.byteLength,
        })}`,
      );
    }
    if (
      message.payloadHeader.protocolId === INTERACTION_PROTOCOL_ID &&
      message.payloadHeader.messageType === MessageType.InvokeRequest
    ) {
      try {
        const request = TlvInvokeRequest.decode(message.payload);
        const invokes = request.invokeRequests.map(
          ({ commandPath, commandFields }) => {
            const { endpointId, clusterId, commandId } = commandPath;
            const isCoverCommand = clusterId === 0x0102 || clusterId === 0x0104;
            let fields: unknown;
            if (commandFields !== undefined) {
              fields = !isCoverCommand
                ? "<redacted: non-cover command fields>"
                : TlvAny.decodeAnyTlvStream(commandFields);
            }

            return {
              endpointId,
              clusterId: `0x${clusterId.toString(16).padStart(4, "0")}`,
              commandId:
                commandId === undefined
                  ? undefined
                  : `0x${commandId.toString(16).padStart(2, "0")}`,
              fields,
            };
          },
        );

        logger.info(
          `Incoming InvokeRequest before validation via ${this.via}: ${stringify(
            {
              messageId: message.packetHeader.messageId,
              timedRequest: request.timedRequest,
              suppressResponse: request.suppressResponse,
              invokes,
            },
          )}`,
        );
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        logger.warn(
          `Could not decode incoming InvokeRequest before validation via ${this.via}: ${reason}; payloadBytes=${message.payload.byteLength}`,
        );
        logger.debug(
          `Malformed incoming InvokeRequest via ${this.via}: payload=${toHex(message.payload)}`,
        );
      }
    }

    return receive.call(this, message, duplicate);
  };
}
