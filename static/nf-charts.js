"use strict";var NFCharts=(()=>{var g=Object.defineProperty;var D=Object.getOwnPropertyDescriptor;var E=Object.getOwnPropertyNames;var T=Object.prototype.hasOwnProperty;var M=(t,e)=>{for(var r in e)g(t,r,{get:e[r],enumerable:!0})},A=(t,e,r,s)=>{if(e&&typeof e=="object"||typeof e=="function")for(let a of E(e))!T.call(t,a)&&a!==r&&g(t,a,{get:()=>e[a],enumerable:!(s=D(e,a))||s.enumerable});return t};var H=t=>A(g({},"__esModule",{value:!0}),t);var O={};M(O,{dashboardShell:()=>w,default:()=>L,gauge:()=>y,multiTimeseries:()=>p,poll:()=>x,stat:()=>b,timeseries:()=>h});var u={primary:"#605AEA",primaryLight:"rgba(96, 90, 234, 0.1)",secondary:"#ABDFE7",secondaryLight:"rgba(171, 223, 231, 0.1)",success:"#287d3c",warning:"#eeb102",error:"#da1414",gray:"#6b7280",gridLight:"rgba(0,0,0,0.05)"},f=["#605AEA","#ABDFE7","#287d3c","#eeb102","#da1414","#8b5cf6","#06b6d4","#f97316","#ec4899","#14b8a6"];function h(t,e={}){let r=document.getElementById(t);if(!r)throw new Error(`Canvas element '${t}' not found`);let s=e.color??u.primary,a=s+"1a",l=(e.hours??2)*60*60*1e3,n=new Chart(r.getContext("2d"),{type:"line",data:{datasets:[{label:e.title??"Value",data:[],borderColor:s,backgroundColor:e.fill!==!1?a:"transparent",fill:e.fill!==!1,tension:.3,pointRadius:2,pointHoverRadius:5,borderWidth:2}]},options:{responsive:!0,animation:{duration:200},scales:{x:{type:"time",time:{unit:l>1440*60*1e3?"hour":"minute",displayFormats:{minute:"HH:mm",hour:"HH:mm"}},grid:{display:!1}},y:{min:e.min,max:e.max,title:e.unit?{display:!0,text:e.unit}:{display:!1},grid:{color:u.gridLight}}},plugins:{legend:{display:!1},tooltip:{callbacks:{label:o=>`${o.parsed.y.toFixed(2)}${e.unit?" "+e.unit:""}`}}}}});function i(o){let d=Date.now()-l;for(;o.length>0&&o[0].x.getTime()<d;)o.shift()}function m(o){if(o.length===0)return{min:0,max:0,mean:0,count:0};let d=o.map(c=>c.y),C=d.reduce((c,$)=>c+$,0);return{min:Math.min(...d),max:Math.max(...d),mean:C/d.length,count:d.length}}return{setData(o){n.data.datasets[0].data=o.map(d=>({x:new Date(d.x),y:d.y})),i(n.data.datasets[0].data),n.update("none")},append(o){let d=n.data.datasets[0].data;d.push({x:new Date(o.x),y:o.y}),i(d),n.update("none")},getData(){return n.data.datasets[0].data},stats(){return m(n.data.datasets[0].data)},raw:n}}function p(t,e){let r=document.getElementById(t);if(!r)throw new Error(`Canvas element '${t}' not found`);let s=(e.hours??2)*60*60*1e3,a=e.series.map((n,i)=>({label:n.label,data:[],borderColor:n.color??f[i%f.length],backgroundColor:"transparent",fill:!1,tension:.3,pointRadius:1,borderWidth:2})),l=new Chart(r.getContext("2d"),{type:"line",data:{datasets:a},options:{responsive:!0,animation:{duration:200},scales:{x:{type:"time",time:{unit:"minute",displayFormats:{minute:"HH:mm"}},grid:{display:!1}},y:{min:e.min,max:e.max,title:e.unit?{display:!0,text:e.unit}:{display:!1},grid:{color:u.gridLight}}},plugins:{legend:{display:!0,position:"bottom"}}}});return{setSeriesData(n,i){l.data.datasets[n].data=i,l.update("none")},appendToSeries(n,i){let m=l.data.datasets[n].data;m.push(i);let o=Date.now()-s;for(;m.length>0&&m[0].x.getTime()<o;)m.shift();l.update("none")},raw:l}}function y(t,e={}){let r=document.getElementById(t);if(!r)throw new Error(`Element '${t}' not found`);let s=e.min??0,a=e.max??100;function l(n){if(!e.thresholds?.length)return u.primary;for(let i=e.thresholds.length-1;i>=0;i--)if(n>=e.thresholds[i].value)return e.thresholds[i].color;return u.primary}return{setValue(n){let i=Math.max(0,Math.min(100,(n-s)/(a-s)*100)),m=l(n);r.innerHTML=`
        <div style="text-align:center">
          <div style="font-size:2.5rem;font-weight:700;color:${m}">${n.toFixed(1)}</div>
          ${e.unit?`<div style="font-size:0.75rem;color:#6b7280">${e.unit}</div>`:""}
          <div style="margin-top:0.5rem;height:6px;background:#e5e7eb;border-radius:3px;overflow:hidden">
            <div style="width:${i}%;height:100%;background:${m};border-radius:3px;transition:width 0.3s"></div>
          </div>
        </div>
      `}}}function b(t,e,r,s){let a=document.getElementById(t);a&&(a.innerHTML=`
    <div style="font-size:0.65rem;text-transform:uppercase;letter-spacing:0.05em;color:#9ca3af">${e}</div>
    <div style="font-size:1.125rem;font-weight:600;color:${s?.color??"#1f2937"}">${r}</div>
  `)}function x(t,e){let r=!0;return(async()=>{for(;r;){try{await t()}catch(a){console.error("[NFCharts.poll]",a)}await new Promise(a=>setTimeout(a,e))}})(),{stop:()=>{r=!1}}}function w(t,e){return`
    <link href="https://fonts.googleapis.com/css2?family=Noto+Sans:wght@400;500;600;700&display=swap" rel="stylesheet">
    <style>
      body { font-family: 'Noto Sans', sans-serif; margin: 0; padding: 1.5rem; background: #f9fafb; }
      .nf-header { margin-bottom: 1.5rem; }
      .nf-header h1 { font-size: 1.5rem; font-weight: 600; color: #20144C; margin: 0; }
      .nf-header p { font-size: 0.875rem; color: #6b7280; margin: 0.25rem 0 0; }
      .nf-card { background: white; border-radius: 0.75rem; box-shadow: 0 1px 2px rgba(0,0,0,0.05); border: 1px solid #e5e7eb; padding: 1.5rem; margin-bottom: 1rem; }
      .nf-grid { display: grid; gap: 1rem; }
      .nf-grid-2 { grid-template-columns: repeat(2, 1fr); }
      .nf-grid-3 { grid-template-columns: repeat(3, 1fr); }
      .nf-grid-4 { grid-template-columns: repeat(4, 1fr); }
    </style>
    <div class="nf-header">
      <h1>${t}</h1>
      ${e?`<p>${e}</p>`:""}
    </div>
  `}var v={timeseries:h,multiTimeseries:p,gauge:y,stat:b,poll:x,dashboardShell:w,COLORS:u,SERIES_COLORS:f};globalThis.NFCharts=v;var L=v;return H(O);})();
//# sourceMappingURL=nf-charts.js.map
