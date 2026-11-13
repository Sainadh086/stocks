export default function ({ parentElement }) {
    // Activate the dialog's own dismissal control, preserving the rest of the page.
    let node=parentElement;
    let dialog=null;
    while (node && !dialog) {
        dialog=node.closest?.('[role="dialog"]') || null;
        node=node.getRootNode?.().host || null;
    }
    if (!dialog) return;
    const close=dialog.querySelector('button[aria-label="Close"]') ||
        dialog.querySelector('button[data-testid="stDialogDismissButton"]');
    if (!close) return;
    const timer=window.setTimeout(()=>close.click(),300);
    return ()=>window.clearTimeout(timer);
}
