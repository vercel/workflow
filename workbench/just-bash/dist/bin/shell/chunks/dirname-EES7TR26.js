#!/usr/bin/env node
import{a as i,b as o}from"./chunk-GTNBSMZR.js";import"./chunk-KGOUQS5A.js";var m={name:"dirname",summary:"strip last component from file name",usage:"dirname [OPTION] NAME...",options:["    --help       display this help and exit"]},p={name:"dirname",async execute(t,l){if(o(t))return i(m);let a=t.filter(n=>!n.startsWith("-"));if(a.length===0)return{stdout:"",stderr:`dirname: missing operand
`,exitCode:1};let e=[];for(let n of a){let r=n.replace(/\/+$/,""),s=r.lastIndexOf("/");s===-1?e.push("."):s===0?e.push("/"):e.push(r.slice(0,s))}return{stdout:`${e.join(`
`)}
`,stderr:"",exitCode:0}}};export{p as dirnameCommand};
