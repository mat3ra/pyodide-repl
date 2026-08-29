import { Action } from "@mat3ra/esse/dist/js/types";

import IframeChildTransport from "./IframeChildTransport";

/** One entity in a sync payload; `config` is the entity's serialized schema (e.g. a material). */
export interface SyncEntity {
    type: string;
    name: string;
    config: object;
}

export interface ScopedSyncPayload {
    syncScope: string;
    entities: SyncEntity[];
}

/** What a host's `getData` handler may return: a bare config array, or configs plus a selection. */
export interface HostEntitiesPayload {
    entityConfigs: object[];
    selectedIndex: number;
}

/**
 * How long a materials request waits for the host before concluding there is none. Standalone use
 * (opening the page directly) is legitimate — the REPL then starts with no input entities.
 */
const HOST_RESPONSE_TIMEOUT_MS = 2000;

/**
 * The page's line to its embedding host, over the same protocol JupyterLite uses:
 * `getData` asks the host for its current entities; the host replies (or pushes unprompted) with
 * `setData`; this page sends results back as a `setData` carrying a {@link ScopedSyncPayload}.
 */
export default class HostConnection {
    private transport = new IframeChildTransport();

    private latestPayload: HostEntitiesPayload | null = null;

    private pendingRequest: ((payload: HostEntitiesPayload) => void) | null = null;

    constructor() {
        // Two actions do not need a handler registry: inbound traffic is setData or nothing.
        this.transport.init((action, payload) => {
            if (action === Action.setData) this.receiveHostData(payload);
        });
    }

    /**
     * The host's reply to `getData` is its handler's return value. Two shapes are accepted: a bare
     * config array (what JupyterLite hosts already return today), or `{materials, selectedIndex}`
     * for hosts that also track a selection. Hosts may push either shape unprompted whenever their
     * state changes (JupyterLite's `sendData` pattern), which refreshes the cache for the next run.
     */
    private receiveHostData(payload: object): void {
        const normalized = HostConnection.normalizeHostPayload(payload);
        if (!normalized) return;
        this.latestPayload = normalized;
        this.pendingRequest?.(normalized);
        this.pendingRequest = null;
    }

    private static normalizeHostPayload(payload: object): HostEntitiesPayload | null {
        if (Array.isArray(payload)) return { entityConfigs: payload, selectedIndex: 0 };
        const { materials, selectedIndex } = payload as {
            materials?: object[];
            selectedIndex?: number;
        };
        if (!Array.isArray(materials)) return null;
        return { entityConfigs: materials, selectedIndex: selectedIndex ?? 0 };
    }

    /** Ask the host for its current entities; empty when unembedded or the host stays silent. */
    requestEntities(): Promise<HostEntitiesPayload> {
        return new Promise((resolve) => {
            const timeout = window.setTimeout(() => {
                this.pendingRequest = null;
                resolve(this.latestPayload ?? { entityConfigs: [], selectedIndex: 0 });
            }, HOST_RESPONSE_TIMEOUT_MS);
            this.pendingRequest = (payload) => {
                window.clearTimeout(timeout);
                resolve(payload);
            };
            this.transport.send(Action.getData, {});
        });
    }

    sendScopedSync(payload: ScopedSyncPayload): void {
        this.transport.send(Action.setData, payload);
    }

    destroy(): void {
        this.transport.destroy();
    }
}
