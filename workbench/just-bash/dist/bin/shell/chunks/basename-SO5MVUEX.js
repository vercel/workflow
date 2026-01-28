#!/usr/bin/env node
import{a as r,b as m}from"./chunk-GTNBSMZR.js";import"./chunk-KGOUQS5A.js";var p={name:"basename",summary:"strip directory and suffix from filenames",usage:`basename NAME [SUFFIX]
basename OPTION... NAME...`,options:["-a, --multiple   support multiple arguments","-s, --suffix=SUFFIX  remove a trailing SUFFIX","    --help       display this help and exit"]},c={name:"basename",async execute(n,u){if(m(n))return r(p);let i=!1,s="",a=[];for(let t=0;t<n.length;t++){let e=n[t];e==="-a"||e==="--multiple"?i=!0:e==="-s"&&t+1<n.length?(s=n[++t],i=!0):e.startsWith("--suffix=")?(s=e.slice(9),i=!0):e.startsWith("-")||a.push(e)}if(a.length===0)return{stdout:"",stderr:`basename: missing operand
`,exitCode:1};!i&&a.length>=2&&(s=a.pop()??"");let o=[];for(let t of a){let e=t.replace(/\/+$/,""),l=e.split("/").pop()||e;s&&l.endsWith(s)&&(l=l.slice(0,-s.length)),o.push(l)}return{stdout:`${o.join(`
`)}
`,stderr:"",exitCode:0}}};export{c as basenameCommand};
