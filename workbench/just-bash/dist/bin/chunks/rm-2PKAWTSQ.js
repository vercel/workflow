#!/usr/bin/env node
import{a as u}from"./chunk-TA7RUHGQ.js";import{a as m}from"./chunk-4VDEBYW7.js";import"./chunk-GTNBSMZR.js";import"./chunk-KGOUQS5A.js";var v={recursive:{short:"r",long:"recursive",type:"boolean"},recursiveUpper:{short:"R",type:"boolean"},force:{short:"f",long:"force",type:"boolean"},verbose:{short:"v",long:"verbose",type:"boolean"}},y={name:"rm",async execute(d,s){let e=u("rm",d,v);if(!e.ok)return e.error;let a=e.result.flags.recursive||e.result.flags.recursiveUpper,c=e.result.flags.force,p=e.result.flags.verbose,l=e.result.positional;if(l.length===0)return c?{stdout:"",stderr:"",exitCode:0}:{stdout:"",stderr:`rm: missing operand
`,exitCode:1};let f="",t="",i=0;for(let r of l)try{let n=s.fs.resolvePath(s.cwd,r);if((await s.fs.stat(n)).isDirectory&&!a){t+=`rm: cannot remove '${r}': Is a directory
`,i=1;continue}await s.fs.rm(n,{recursive:a,force:c}),p&&(f+=`removed '${r}'
`)}catch(n){if(!c){let o=m(n);o.includes("ENOENT")||o.includes("no such file")?t+=`rm: cannot remove '${r}': No such file or directory
`:o.includes("ENOTEMPTY")||o.includes("not empty")?t+=`rm: cannot remove '${r}': Directory not empty
`:t+=`rm: cannot remove '${r}': ${o}
`,i=1}}return{stdout:f,stderr:t,exitCode:i}}};export{y as rmCommand};
