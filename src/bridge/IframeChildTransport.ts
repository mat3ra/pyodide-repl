import { IframeMessageSchema, Type } from "@mat3ra/esse/dist/js/types";

export type BridgeReceive = (action: IframeMessageSchema["action"], payload: object) => void;

/**
 * The iframe-child half of the mat3ra data bridge: the exact mirror of cove's host-side
 * `IframeTransport`. The host posts `fromHostToIframe` messages into this window; this page answers
 * with `fromIframeToHost` messages to `window.parent`. Message shape and actions come from ESSE's
 * `IframeMessageSchema` — the same contract JupyterLite speaks, so any host that embeds JupyterLite
 * can embed this page with the handler code it already has.
 */
export default class IframeChildTransport {
    private receive?: BridgeReceive;

    /**
     * The embedding page's origin, from the referrer when the browser provides it, refined by the
     * first host message. Falls back to "*" only when opened standalone, where parent === window
     * and nothing leaves the page.
     */
    private hostOriginURL = document.referrer ? new URL(document.referrer).origin : "*";

    init(receive: BridgeReceive): void {
        this.receive = receive;
        window.addEventListener("message", this.receiveMessage);
    }

    destroy(): void {
        window.removeEventListener("message", this.receiveMessage);
    }

    private receiveMessage = (event: MessageEvent<IframeMessageSchema>) => {
        // Only the window that embeds this page is the host — never a sibling or nested frame.
        if (event.source !== window.parent) return;
        if (event.data?.type !== Type.fromHostToIframe) return;
        this.hostOriginURL = event.origin;
        this.receive?.(event.data.action, event.data.payload);
    };

    send(action: IframeMessageSchema["action"], payload: object): void {
        // Standalone (no embedding host): parent === window, and the message is our own — ignored
        // by receiveMessage's type check, so sending is harmless.
        window.parent.postMessage(
            { type: Type.fromIframeToHost, action, payload },
            this.hostOriginURL,
        );
    }
}
