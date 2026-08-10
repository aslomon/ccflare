import type { AckMessage, IncomingWorkerMessage } from "./worker-messages";

type ProcessMessage = (message: IncomingWorkerMessage) => void | Promise<void>;
type PostAcknowledgement = (message: AckMessage) => void;

function createAcknowledgement(
	message: IncomingWorkerMessage,
): AckMessage | null {
	if (!message.messageId) return null;

	return {
		type: "ack",
		messageId: message.messageId,
		requestId: "requestId" in message ? message.requestId : undefined,
		acknowledgedType: message.type,
	};
}

export async function processWorkerMessageWithAck(
	message: IncomingWorkerMessage,
	processMessage: ProcessMessage,
	postAcknowledgement: PostAcknowledgement,
): Promise<void> {
	await processMessage(message);
	const acknowledgement = createAcknowledgement(message);
	if (acknowledgement) postAcknowledgement(acknowledgement);
}
