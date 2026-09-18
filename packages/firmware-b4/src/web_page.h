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
  cell('Focus volts',L.focusVolts,' V');
 const d=s.drive;
 $('#drive').innerHTML=`<div class="card"><div class="k">Setpoint ${d.setpoint} &mdash; DAC ${d.dacCode}`+
  (d.fault?` &mdash; <span style="color:var(--bad)">${d.fault}</span>`:(d.holding?' &mdash; holding':''))+`</div>`+
  `<input type=range min=0 max=255 value="${d.setpoint}" id="sp" ${s.armed&&s.calibrated?'':'disabled'}></div>`;
 $('#sp').oninput=e=>fetch('/api/iris',{method:'POST',body:JSON.stringify({value:+e.target.value})});
 $('#cal').innerHTML=s.calPoints? '<a href="/api/calibration.csv">download calibration.csv</a>'
  : 'No table recorded. Run <code>packages/firmware-b4/tools/record_calibration.py</code>; the device refuses to drive until then.';
}
tick(); setInterval(tick,500);
</script>
)HTML";
  server.send_P(200, "text/html", PAGE);
}
