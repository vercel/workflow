#!/usr/bin/env node
import{a as c,b as f,c as u}from"./chunk-GTNBSMZR.js";import"./chunk-KGOUQS5A.js";var x={name:"timeout",summary:"run a command with a time limit",usage:"timeout [OPTION] DURATION COMMAND [ARG]...",description:`Start COMMAND, and kill it if still running after DURATION.

DURATION is a number with optional suffix:
  s - seconds (default)
  m - minutes
  h - hours
  d - days`,options:["-k, --kill-after=DURATION  send KILL signal after DURATION if still running","-s, --signal=SIGNAL        specify signal to send (default: TERM)","    --preserve-status      exit with same status as COMMAND, even on timeout","    --foreground           run command in foreground","    --help                 display this help and exit"]};function O(r){let i=r.match(/^(\d+\.?\d*)(s|m|h|d)?$/);if(!i)return null;let n=parseFloat(i[1]);switch(i[2]||"s"){case"s":return n*1e3;case"m":return n*60*1e3;case"h":return n*60*60*1e3;case"d":return n*24*60*60*1e3;default:return null}}var w={name:"timeout",async execute(r,i){if(f(r))return c(x);let n=!1,s=0;for(let t=0;t<r.length;t++){let e=r[t];if(e==="--preserve-status")n=!0,s=t+1;else if(e==="--foreground")s=t+1;else if(e==="-k"||e==="--kill-after")t++,s=t+1;else if(e.startsWith("--kill-after="))s=t+1;else if(e==="-s"||e==="--signal")t++,s=t+1;else if(e.startsWith("--signal="))s=t+1;else{if(e.startsWith("--")&&e!=="--")return u("timeout",e);if(e.startsWith("-")&&e.length>1&&e!=="--")if(e.startsWith("-k"))s=t+1;else if(e.startsWith("-s"))s=t+1;else return u("timeout",e);else{s=t;break}}}let o=r.slice(s);if(o.length===0)return{stdout:"",stderr:`timeout: missing operand
`,exitCode:1};let a=o[0],l=O(a);if(l===null)return{stdout:"",stderr:`timeout: invalid time interval '${a}'
`,exitCode:1};let m=o.slice(1);if(m.length===0)return{stdout:"",stderr:`timeout: missing operand
`,exitCode:1};if(!i.exec)return{stdout:"",stderr:`timeout: exec not available
`,exitCode:1};let h=m.map(t=>t.includes(" ")||t.includes("	")?`'${t.replace(/'/g,"'\\''")}'`:t).join(" "),p=new Promise(t=>{setTimeout(()=>t({timedOut:!0}),l)}),g=i.exec(h,{cwd:i.cwd}).then(t=>({timedOut:!1,result:t})),d=await Promise.race([p,g]);return d.timedOut?{stdout:"",stderr:"",exitCode:124}:d.result}};export{w as timeoutCommand};
