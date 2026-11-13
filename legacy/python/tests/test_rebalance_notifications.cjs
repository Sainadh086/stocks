const fs=require('node:fs');
const vm=require('node:vm');
const assert=require('node:assert/strict');
const source=fs.readFileSync(require('node:path').join(__dirname,'../brokers/robinhood/assets/notifications.js'),'utf8').replace('export default function','function render');
const storage=new Map();
const notifications=[];
let permissionsRequested=0;
function Notification(title,options) { this.title=title;this.options=options;notifications.push(this);this.close=()=>{}; }
Notification.permission='default';
Notification.requestPermission=async()=>{permissionsRequested++;Notification.permission='granted';return 'granted';};
const window={Notification,isSecureContext:true,focus:()=>{window.focused=true;}};
let clock=Date.now();
class MockDate extends Date {static now(){return clock;}}
const context=vm.createContext({window,Notification,Date:MockDate,localStorage:{getItem:k=>storage.get(k)??null,setItem:(k,v)=>storage.set(k,v)},Set,JSON});
vm.runInContext(source,context);
const elements={enable:{},disable:{},test:{},status:{}};
const parentElement={querySelector:selector=>selector==='[data-enable]'?elements.enable:selector==='[data-disable]'?elements.disable:selector==='[data-test]'?elements.test:elements.status};
const data={account_key:'anon',day:'2026-10-06',actions:[{key:'buy:AAPL',symbol:'AAPL',side:'BUY'}]};
(async()=>{
    context.render({data,parentElement});
    assert.equal(permissionsRequested,0);assert.equal(notifications.length,0);
    await elements.enable.onclick();
    assert.equal(permissionsRequested,1);assert.equal(notifications.length,1);
    assert.match(notifications[0].options.body,/BUY AAPL/);
    context.render({data,parentElement});assert.equal(notifications.length,1);
    context.render({data:{...data,actions:[...data.actions,{key:'sell:MSFT',symbol:'MSFT',side:'SELL'}]},parentElement});
    assert.equal(notifications.length,2);assert.match(notifications[1].options.body,/SELL MSFT/);
    notifications[1].onclick();assert.equal(window.focused,true);
    // Once an opportunity disappears, it can alert again the same day.
    context.render({data:{...data,actions:[]},parentElement});
    clock+=61000;context.render({data,parentElement});assert.equal(notifications.length,3);
    // Unattended eligible opportunities get a reminder after fifteen minutes.
    clock+=15*60*1000;context.render({data,parentElement});assert.equal(notifications.length,4);
    elements.test.onclick();assert.equal(notifications.length,5);
    assert.match(notifications[4].title,/test notification/);
    elements.disable.onclick();
    context.render({data:{...data,day:'2026-10-07'},parentElement});assert.equal(notifications.length,5);
    await elements.enable.onclick();assert.equal(notifications.length,6);
    // A failed delivery is not permanently suppressed as already delivered.
    notifications[5].onerror();
    context.render({data:{...data,day:'2026-10-07'},parentElement});assert.equal(notifications.length,7);
    Notification.permission='denied';context.render({data,parentElement});assert.equal(elements.enable.disabled,true);
    delete window.Notification;context.render({data,parentElement});assert.match(elements.status.textContent,/supported browser/);
    console.log('Browser notification checks passed: permission, new opportunities, reminders, test delivery, error recovery, deduplication, disable, click-to-focus.');
})().catch(error=>{console.error(error);process.exitCode=1;});
