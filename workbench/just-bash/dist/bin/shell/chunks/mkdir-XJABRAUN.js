#!/usr/bin/env node
import{a}from"./chunk-TA7RUHGQ.js";import{a as l}from"./chunk-4VDEBYW7.js";import"./chunk-GTNBSMZR.js";import"./chunk-KGOUQS5A.js";var g={recursive:{short:"p",long:"parents",type:"boolean"},verbose:{short:"v",long:"verbose",type:"boolean"}},y={name:"mkdir",async execute(u,o){let e=a("mkdir",u,g);if(!e.ok)return e.error;let m=e.result.flags.recursive,f=e.result.flags.verbose,n=e.result.positional;if(n.length===0)return{stdout:"",stderr:`mkdir: missing operand
`,exitCode:1};let c="",t="",d=0;for(let r of n)try{let i=o.fs.resolvePath(o.cwd,r);await o.fs.mkdir(i,{recursive:m}),f&&(c+=`mkdir: created directory '${r}'
`)}catch(i){let s=l(i);s.includes("ENOENT")||s.includes("no such file")?t+=`mkdir: cannot create directory '${r}': No such file or directory
`:s.includes("EEXIST")||s.includes("already exists")?t+=`mkdir: cannot create directory '${r}': File exists
`:t+=`mkdir: cannot create directory '${r}': ${s}
`,d=1}return{stdout:c,stderr:t,exitCode:d}}};export{y as mkdirCommand};
