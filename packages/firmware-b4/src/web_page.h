/*
 * web_page.h — the page the device serves itself.
 *
 * WHY THIS IS A HEADER AND NOT PART OF THE .ino
 *
 * Arduino's .ino preprocessor generates C++ prototypes by scanning the sketch
 * for things that look like function definitions. It does not understand that
 * a raw string literal is data, so it read the JavaScript inside this page and
 * emitted prototypes from it:
 *
 *     error: 'function' does not name a type; did you mean 'union'?
 *     error: 'async' does not name a type
 *
 * `.h` files are not run through that generator. Keeping the page here is the
 * fix, and it also keeps 60 lines of HTML out of the control code.
 *
 * Included AFTER the globals it uses (`server`), which is why the include sits
 * in the middle of the sketch rather than at the top.
 *
 * ── Why the device serves a page at all ───────────────────────────────────
 * Because of where it is used: you are standing at a lens turning a focus
 * ring, and the numbers are on a laptop across the room. A page the device
 * serves itself is readable from a phone on the same Ethernet that carries
 * the control.
 *
 * Deliberately one file, no framework, no CDN. A control device that cannot
 * show its own state without fetching a megabyte from the internet is a
 * control device that stops working in an OB truck.
 */
#pragma once

static void handleRoot() {
  static const char PAGE[] PROGMEM = R"HTML(<!doctype html>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>B4 Lens Control</title>
<style>
 :root{color-scheme:light dark;--fg:#111;--bg:#fafafa;--mut:#666;--ok:#1a7f37;--bad:#b42318;--line:#ddd}
 @media(prefers-color-scheme:dark){:root{--fg:#eee;--bg:#161616;--mut:#999;--line:#333}}
 body{margin:0;padding:16px;font:14px/1.5 system-ui,sans-serif;background:var(--bg);color:var(--fg)}
 h1{font-size:18px;margin:0 0 4px}
 .sub{color:var(--mut);margin-bottom:16px}
 .grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;margin-bottom:16px}
 .card{border:1px solid var(--line);border-radius:8px;padding:12px}
 .k{color:var(--mut);font-size:12px;text-transform:uppercase;letter-spacing:.04em}
 .v{font-size:24px;font-variant-numeric:tabular-nums;margin-top:2px}
 .u{color:var(--mut);font-size:13px}
 .na{color:var(--mut);font-size:16px;font-style:italic}
 .row{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:8px}
 .pill{padding:2px 8px;border-radius:99px;font-size:12px;border:1px solid var(--line)}
 .on{color:var(--ok);border-color:var(--ok)} .off{color:var(--bad);border-color:var(--bad)}
 table{border-collapse:collapse;width:100%;font-variant-numeric:tabular-nums}
 td,th{border-bottom:1px solid var(--line);padding:4px 6px;text-align:right}
 th:first-child,td:first-child{text-align:left}
 button{font:inherit;padding:6px 12px;border:1px solid var(--line);border-radius:6px;background:transparent;color:inherit;cursor:pointer}
 input[type=range]{width:100%}
 .warn{border-left:3px solid var(--bad);padding-left:10px;color:var(--mut);margin:12px 0}
</style>
<h1>B4 Lens Control</h1>
<div class="sub">Canon/Fujinon 2/3&quot; B4 &mdash; Hirose 12-pin</div>
<div class="row" id="pills"></div>
<div class="grid" id="vals"></div>
<div id="drive"></div>
<h2 style="font-size:15px">Bench</h2>
<div class="card"><div class="k" id="benchk">Bench drive</div>
<input type=range min=0 max=4095 value=0 id="bd" disabled>
<div class="sub" id="benchn">Sets the DAC directly, no calibration. Drive build only, refused while armed.</div></div>
<h2 style="font-size:15px">Zoom</h2>
<div class="card"><div class="k" id="zoomk">Zoom speed</div>
<input type=range min=-100 max=100 value=0 id="zs">
<div class="sub">Hold to zoom, let go to stop. Left = one direction, right = the other. Stops by itself 0.4 s after the last command.</div></div>
<div class="warn">Every electrical figure this device reports rests on a divider
ratio you entered in <code>config.h</code>. It is measuring, not certifying.</div>
<h2 style="font-size:15px">Calibration</h2>
<div id="cal"></div>
<script>
const $=s=>document.querySelector(s);
function cell(k,v,u){return `<div class="card"><div class="k">${k}</div>`+
 (v===undefined?`<div class="na">not read</div>`:`<div class="v">${v}<span class="u">${u||''}</span></div>`)+`</div>`}
async function tick(){
 let s; try{ s=await (await fetch('/api/status')).json() }catch(e){ return }
 $('#pills').innerHTML=
  `<span class="pill ${s.i2c.adc?'on':'off'}">ADC ${s.i2c.adc?'ok':'missing'}</span>`+
  `<span class="pill ${s.i2c.dac?'on':'off'}">DAC ${s.i2c.dac?'ok':'missing'}</span>`+
  `<span class="pill ${s.calibrated?'on':'off'}">${s.calibrated?'calibrated ('+s.calPoints+' pts)':'not calibrated'}</span>`+
  `<span class="pill ${s.armed?'on':'off'}">${s.armed?'ARMED':'disarmed'}</span>`+
  (s.driveCompiledIn?'':'<span class="pill off">drive not compiled in</span>');
 const L=s.lens||{};
 $('#vals').innerHTML=
  cell('Iris',L.iris,' / 255')+
  cell('Iris volts',L.irisVolts,' V')+
  cell('Zoom volts',L.zoomVolts,' V')+
  cell('Zoom',L.zoomVolts===undefined?undefined:focal(L.zoomVolts),'')+
  cell('Iris',L.irisVolts===undefined?undefined:fstop(L.irisVolts),'')+
  cell('Focus volts',L.focusVolts,' V')+
  cell('Amp out (A3)',s.ampVolts,' V');
 const d=s.drive;
 $('#drive').innerHTML=`<div class="card"><div class="k">Setpoint ${d.setpoint} &mdash; DAC ${d.dacCode}`+
  (d.fault?` &mdash; <span style="color:var(--bad)">${d.fault}</span>`:(d.holding?' &mdash; holding':''))+`</div>`+
  `<input type=range min=0 max=255 value="${d.setpoint}" id="sp" ${s.armed&&s.calibrated?'':'disabled'}></div>`;
 $('#sp').oninput=e=>fetch('/api/iris',{method:'POST',body:JSON.stringify({value:+e.target.value})});
 $('#cal').innerHTML=s.calPoints? '<a href="/api/calibration.csv">download calibration.csv</a>'
  : 'No table recorded. Run <code>packages/firmware-b4/tools/record_calibration.py</code>; the device refuses to drive until then.';
}
let dragging=false, lastSent=0, pend=null;
function sendBench(v){ fetch('/api/bench/dac',{method:'POST',body:JSON.stringify({code:+v})}) }
$('#bd').addEventListener('pointerdown',()=>dragging=true);
$('#bd').addEventListener('pointerup',()=>dragging=false);
$('#bd').addEventListener('input',e=>{
 const v=e.target.value, now=Date.now();
 clearTimeout(pend);
 if(now-lastSent>120){ lastSent=now; sendBench(v) } else pend=setTimeout(()=>sendBench(v),130);
});
$('#bd').addEventListener('change',e=>sendBench(e.target.value));
// Iris voltage (pin 7) -> F-number. Measured on the Canon J15ax8B4 IRS SX12,
// 2026-10-10 (docs/b4/measurements/20261010-canon-j15ax8b4-fstop-scale.md).
// Another lens has another curve; this is an orientation, not a calibration.
const FSCALE=[[2.98,16],[3.51,11],[4.09,8],[4.75,5.6],[5.20,4],[5.75,2.8],[6.46,1.7]];
function fstop(v){
 if(v===undefined) return '';
 if(v<2.3) return 'C (zu)';
 if(v<FSCALE[0][0]) return '\u2248 F16\u2013C';
 if(v>=6.6) return 'offen (> F1.7)';
 for(let i=0;i<FSCALE.length-1;i++){
  const [v0,f0]=FSCALE[i],[v1,f1]=FSCALE[i+1];
  if(v<=v1){ const k=(v-v0)/(v1-v0), f=Math.exp(Math.log(f0)+k*(Math.log(f1)-Math.log(f0)));
   return '\u2248 F'+(f>=10?f.toFixed(0):f.toFixed(1)) }
 }
 return '\u2248 F1.7';
}
// Zoom position (pin 10) -> focal length, same lens, same evening
// (docs/b4/measurements/20261010-canon-j15ax8b4-zoom-scale.md).
const ZSCALE=[[1.69,8],[3.32,15],[4.67,30],[5.69,60],[6.77,120]];
function focal(v){
 if(v===undefined) return '';
 if(v<=ZSCALE[0][0]) return '\u2248 8 mm';
 if(v>=ZSCALE[ZSCALE.length-1][0]) return '\u2248 120 mm';
 for(let i=0;i<ZSCALE.length-1;i++){
  const [v0,f0]=ZSCALE[i],[v1,f1]=ZSCALE[i+1];
  if(v<=v1){ const k=(v-v0)/(v1-v0); return '\u2248 '+Math.round(Math.exp(Math.log(f0)+k*(Math.log(f1)-Math.log(f0))))+' mm' }
 }
}
async function benchTick(){
 let s; try{ s=await (await fetch('/api/status')).json() }catch(e){ return }
 const ok=s.driveCompiledIn && !s.armed && s.i2c.dac, b=$('#bd');
 b.disabled=!ok;
 if(!dragging) b.value=s.drive.dacCode;
 const vdac=3.3*b.value/4095;
 $('#benchk').textContent=`Bench drive \u2014 DAC ${b.value} (${vdac.toFixed(2)} V)`+(s.ampVolts!==undefined?` \u2014 pin 5 \u2248 ${s.ampVolts} V (A3 reading)`:'')+
  (s.lens&&s.lens.irisVolts!==undefined?` \u2014 Iris ${fstop(s.lens.irisVolts)} (pin 7 ${s.lens.irisVolts} V)`:'');
 if(!s.driveCompiledIn) $('#benchn').textContent='Safe build: drive not compiled in.';
 else if(s.armed) $('#benchn').textContent='Armed: use the calibrated slider above.';
}
let zNull=1560, zHeld=false, zTimer=null;
function zCode(p){ return Math.round(p<0? zNull+p/100*zNull : zNull+p/100*(4095-zNull)) }
function zSend(){ fetch('/api/zoom',{method:'POST',body:JSON.stringify({code:zCode(+$('#zs').value)})}) }
function zStart(){ zHeld=true; clearInterval(zTimer); zSend(); zTimer=setInterval(zSend,150) }
function zStop(){ zHeld=false; clearInterval(zTimer); $('#zs').value=0; fetch('/api/zoom',{method:'POST',body:JSON.stringify({code:zNull})}) }
$('#zs').addEventListener('pointerdown',zStart);
$('#zs').addEventListener('input',()=>{ if(!zHeld) zStart() });
['pointerup','pointercancel','pointerleave','blur'].forEach(e=>$('#zs').addEventListener(e,()=>{ if(zHeld) zStop() }));
async function zoomTick(){
 let s; try{ s=await (await fetch('/api/status')).json() }catch(e){ return }
 if(s.zoom){ zNull=s.zoom.null }
 const L=s.lens||{};
 $('#zoomk').textContent='Zoom speed'+(s.zoom?` \u2014 code ${s.zoom.code} (stop ${s.zoom.null}${s.zoom.holding?', hold':''})`:'')+(L.zoomVolts!==undefined?` \u2014 ${focal(L.zoomVolts)}`:'');
}
tick(); setInterval(tick,500); benchTick(); setInterval(benchTick,500); zoomTick(); setInterval(zoomTick,500);
</script>
)HTML";
  server.send_P(200, "text/html", PAGE);
}
