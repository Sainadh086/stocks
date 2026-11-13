export default function ({ parentElement, setTriggerValue }) {
    // A component event reruns only the progress fragment inside the dialog.
    const timer = window.setTimeout(() => {
        if (!parentElement.isConnected) return;
        let node = parentElement;
        let dialog = null;
        while (node && !dialog) {
            dialog = node.closest?.('[role="dialog"]') || null;
            node = node.getRootNode?.().host || null;
        }
        if (dialog && dialog.isConnected && dialog.getClientRects().length) {
            setTriggerValue('tick', Date.now());
        }
    }, 2000);
    return () => window.clearTimeout(timer);
}
