import { Action } from "@mat3ra/esse/dist/js/types";

import type { ReplHostConfig } from "../config/hostConfig";
import IframeChildTransport from "./IframeChildTransport";

/**
 * What a host returns from its `get-data` handler: how to set the REPL up, and its current data.
 * Both optional — a host that only wants a bare Python REPL returns nothing.
 */
export interface HostReply {
    config?: ReplHostConfig;
    data?: unknown;
}

/**
 * How long a request waits before concluding there is no host. Opening the page directly is
 * legitimate: it then runs as a plain Python REPL with no host data.
 */
const HOST_RESPONSE_TIMEOUT_MS = 2000;

/**
 * The page's line to whatever embeds it, over the two ESSE actions JupyterLite hosts already
 * speak: `get-data` asks the host for its config and data, `set-data` hands results back.
 *
 * Deliberately free of any domain shape — the host's own Python decides what `data` means and what
 * results look like (see ReplHostConfig).
 */
export default class HostConnection {
    private transport = new IframeChildTransport();

    private latestReply: HostReply | null = null;

    private pendingRequest: ((reply: HostReply) => void) | null = null;

    constructor() {
        // Two actions need no handler registry: inbound traffic is set-data or nothing.
        this.transport.init((action, payload) => {
            if (action === Action.setData) this.receiveHostReply(payload);
        });
    }

    /**
     * A host may answer a request or push unprompted whenever its state changes (JupyterLite's
     * `sendData` pattern); either way the newest reply wins and resolves anyone waiting.
     */
    private receiveHostReply(payload: object): void {
        if (!payload || typeof payload !== "object") return;
        this.latestReply = payload as HostReply;
        this.pendingRequest?.(this.latestReply);
        this.pendingRequest = null;
    }

    /** Ask the host for config and data; resolves empty when unembedded or the host stays silent. */
    requestFromHost(): Promise<HostReply> {
        return new Promise((resolve) => {
            const timeout = window.setTimeout(() => {
                this.pendingRequest = null;
                resolve(this.latestReply ?? {});
            }, HOST_RESPONSE_TIMEOUT_MS);
            this.pendingRequest = (reply) => {
                window.clearTimeout(timeout);
                resolve(reply);
            };
            this.transport.send(Action.getData, {});
        });
    }

    /** Hand results back to the host, exactly as the host's own Python produced them. */
    sendToHost(payload: object): void {
        this.transport.send(Action.setData, payload);
    }

    destroy(): void {
        this.transport.destroy();
    }
}
