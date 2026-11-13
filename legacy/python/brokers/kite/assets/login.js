export default function ({ data, parentElement, setTriggerValue }) {
    const button = parentElement.querySelector('button');
    const status = parentElement.querySelector('[role="status"]');
    const messageType = 'stock-dashboard:kite-connected';
    if (data.mode === 'complete') {
        button.textContent = 'Return to dashboard';
        const returnToOpener = () => {
            if (!window.opener || window.opener.closed) {
                status.textContent = 'Kite connected. Return to your dashboard tab.';
                return;
            }
            // Only a completion signal crosses tabs, never a token or credential.
            window.opener.postMessage({ type: messageType }, '*');
            window.opener.focus();
        };
        const receiveAck = (event) => {
            if (event.source === window.opener && event.data?.type === `${messageType}:ack`) {
                window.close();
            }
        };
        window.addEventListener('message', receiveAck);
        button.onclick = returnToOpener;
        status.textContent = 'Kite connected. Returning to your dashboard…';
        returnToOpener();
        const timer = window.setInterval(returnToOpener, 1000);
        return () => {
            window.clearInterval(timer);
            window.removeEventListener('message', receiveAck);
        };
    }
    const receiveCompletion = (event) => {
        if (event.source !== window.__stockKiteLoginTab ||
            event.origin !== new URL(data.redirectUrl).origin ||
            event.data?.type !== messageType) return;
        event.source.postMessage({ type: `${messageType}:ack` }, event.origin);
        window.focus();
        setTriggerValue('connected', true);
    };
    window.addEventListener('message', receiveCompletion);
    button.onclick = () => {
        window.__stockKiteLoginTab = window.open(data.loginUrl, 'stock-dashboard-kite-login');
        if (!window.__stockKiteLoginTab) {
            status.textContent = 'Allow popups for this dashboard, then try again.';
        } else {
            status.textContent = 'Finish signing in with Kite. This tab will reconnect automatically.';
            window.__stockKiteLoginTab.focus();
        }
    };
    return () => window.removeEventListener('message', receiveCompletion);
}
