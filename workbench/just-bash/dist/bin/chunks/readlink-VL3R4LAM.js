#!/usr/bin/env node
import{a as h,b as u}from"./chunk-GTNBSMZR.js";import"./chunk-KGOUQS5A.js";var m={name:"readlink",summary:"print resolved symbolic links or canonical file names",usage:"readlink [OPTIONS] FILE...",options:["-f      canonicalize by following every symlink in every component of the given name recursively","    --help display this help and exit"]},y={name:"readlink",async execute(i,r){if(u(i))return h(m);let s=!1,t=0;for(;t<i.length&&i[t].startsWith("-");){let n=i[t];if(n==="-f"||n==="--canonicalize")s=!0,t++;else if(n==="--"){t++;break}else return{stdout:"",stderr:`readlink: invalid option -- '${n.slice(1)}'
`,exitCode:1}}let d=i.slice(t);if(d.length===0)return{stdout:"",stderr:`readlink: missing operand
`,exitCode:1};let l="",c=!1;for(let n of d){let a=r.fs.resolvePath(r.cwd,n);try{if(s){let e=a,f=new Set;for(;!f.has(e);){f.add(e);try{let o=await r.fs.readlink(e);if(o.startsWith("/"))e=o;else{let k=e.substring(0,e.lastIndexOf("/"))||"/";e=r.fs.resolvePath(k,o)}}catch{break}}l+=`${e}
`}else{let e=await r.fs.readlink(a);l+=`${e}
`}}catch{s?l+=`${a}
`:c=!0}}return{stdout:l,stderr:"",exitCode:c?1:0}}};export{y as readlinkCommand};
