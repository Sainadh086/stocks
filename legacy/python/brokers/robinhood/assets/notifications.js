export default function ({ data, parentElement }) {
    const button=parentElement.querySelector('[data-enable]');
    const disable=parentElement.querySelector('[data-disable]');
    const test=parentElement.querySelector('[data-test]');
    const status=parentElement.querySelector('[role="status"]');
    const enabledKey='stocks:us-alerts:enabled';
    const activeKey=`stocks:us-alerts:active:${data.account_key}:${data.day}`;
    const sentKey=`stocks:us-alerts:sent:${data.account_key}:${data.day}`;
    const supported='Notification' in window && window.isSecureContext;
    const read=(key,fallback)=>{try{return JSON.parse(localStorage.getItem(key))??fallback;}catch{return fallback;}};
    const write=(key,value)=>{
        try{localStorage.setItem(key,JSON.stringify(value));return true;}
        catch{status.textContent='Browser storage is unavailable. Alerts cannot be enabled reliably.';return false;}
    };
    const show=(title,body,onFailure=()=>{})=>{
        try{
            const message=new Notification(title,{body,tag:`us-rebalance-${data.account_key}`,renotify:true});
            message.onclick=()=>{window.focus();message.close();};
            message.onerror=()=>{
                onFailure();
                status.textContent='Notification delivery failed. Check browser and macOS notification settings; use Test alert to verify.';
            };
            status.textContent='Alert requested. If no notification appears, check browser and operating-system notification settings.';
            return true;
        }catch{
            onFailure();status.textContent='Notification could not be displayed. Check browser and operating-system settings.';
            return false;
        }
    };
    const send=(force=false)=>{
        const active=read(activeKey,[]);
        const current=data.actions.map(a=>a.key).sort();
        // Empty eligible actions clear the previous opportunity so reappearance can alert.
        write(activeKey,current);
        if (!supported || Notification.permission!=='granted' || !read(enabledKey,false) || !current.length)return;
        const sent=read(sentKey,{keys:[],time:0});
        const now=Date.now();
        const appeared=current.some(key=>!active.includes(key));
        const changed=JSON.stringify(sent.keys)!==JSON.stringify(current);
        const reminder=now-sent.time>=15*60*1000;
        // Short cooldown prevents conflicting/background tabs from duplicating the same alert.
        if (!force && !(changed || reminder || (appeared && now-sent.time>=60000)))return;
        if (!write(sentKey,{keys:current,time:now}))return;
        const rollback=()=>write(sentKey,sent);
        show('US portfolio: rebalance ready',data.actions.map(a=>`${a.side} ${a.symbol}`).join(' · ')+
             ' — open the dashboard to review and confirm.',rollback);
    };
    const update=()=>{
        const allowed=supported&&Notification.permission==='granted';
        button.disabled=!supported||Notification.permission==='denied';
        disable.disabled=!read(enabledKey,false);
        if(test)test.disabled=!allowed;
        const sent=read(sentKey,{time:0});
        status.textContent=!supported?'Desktop notifications need a supported browser on HTTPS or localhost.':
            Notification.permission==='denied'?'Notifications are blocked. Allow this site in browser settings.':
            allowed&&read(enabledKey,false)?'US alerts enabled. '+(sent.time?'Last alert requested: '+new Date(sent.time).toLocaleTimeString()+'. ':'')+
            'Keep this tab running. Use Test alert to check delivery.':'US alerts are off. Click Enable and allow browser notifications.';
    };
    button.onclick=async()=>{
        if(!supported)return;
        try{
            const permission=await Notification.requestPermission();
            if(permission==='granted'){write(enabledKey,true);update();send(true);}else update();
        }catch{status.textContent='Could not request permission. Check browser notification settings.';}
    };
    disable.onclick=()=>{write(enabledKey,false);update();};
    if(test)test.onclick=()=>{
        if(supported&&Notification.permission==='granted')show('US trading: test notification','Test alert received. Rebalance alerts will appear here when eligible actions are available.');
    };
    update();send();
    return ()=>{button.onclick=null;disable.onclick=null;if(test)test.onclick=null;};
}
