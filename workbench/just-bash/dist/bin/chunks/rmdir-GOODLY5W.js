#!/usr/bin/env node
import{a as p}from"./chunk-TA7RUHGQ.js";import{a as g}from"./chunk-4VDEBYW7.js";import"./chunk-GTNBSMZR.js";import"./chunk-KGOUQS5A.js";var x=`Usage: rmdir [-pv] DIRECTORY...
Remove empty directories.

Options:
  -p, --parents   Remove DIRECTORY and its ancestors
  -v, --verbose   Output a diagnostic for every directory processed`,y={parents:{short:"p",long:"parents",type:"boolean"},verbose:{short:"v",long:"verbose",type:"boolean"},help:{long:"help",type:"boolean"}},D={name:"rmdir",async execute(t,r){let e=p("rmdir",t,y);if(!e.ok)return e.error;if(e.result.flags.help)return{stdout:`${x}
`,stderr:"",exitCode:0};let a=e.result.flags.parents,o=e.result.flags.verbose,s=e.result.positional;if(s.length===0)return{stdout:"",stderr:`rmdir: missing operand
`,exitCode:1};let f="",n="",i=0;for(let u of s){let d=await b(r,u,a,o);f+=d.stdout,n+=d.stderr,d.exitCode!==0&&(i=d.exitCode)}return{stdout:f,stderr:n,exitCode:i}}};async function b(t,r,e,a){let o="",s="",n=t.fs.resolvePath(t.cwd,r),i=await v(t,n,r,a);if(o+=i.stdout,s+=i.stderr,i.exitCode!==0)return{stdout:o,stderr:s,exitCode:i.exitCode};if(e){let u=n,d=r;for(;;){let c=C(u),l=C(d);if(c===u||c==="/"||c==="."||l==="."||l==="")break;let m=await v(t,c,l,a);if(o+=m.stdout,m.exitCode!==0)break;u=c,d=l}}return{stdout:o,stderr:s,exitCode:0}}async function v(t,r,e,a){try{if(!await t.fs.exists(r))return{stdout:"",stderr:`rmdir: failed to remove '${e}': No such file or directory
`,exitCode:1};if(!(await t.fs.stat(r)).isDirectory)return{stdout:"",stderr:`rmdir: failed to remove '${e}': Not a directory
`,exitCode:1};if((await t.fs.readdir(r)).length>0)return{stdout:"",stderr:`rmdir: failed to remove '${e}': Directory not empty
`,exitCode:1};await t.fs.rm(r,{recursive:!1,force:!1});let n="";return a&&(n=`rmdir: removing directory, '${e}'
`),{stdout:n,stderr:"",exitCode:0}}catch(o){let s=g(o);return{stdout:"",stderr:`rmdir: failed to remove '${e}': ${s}
`,exitCode:1}}}function C(t){let r=t.replace(/\/+$/,""),e=r.lastIndexOf("/");return e===-1?".":e===0?"/":r.substring(0,e)}export{D as rmdirCommand};
