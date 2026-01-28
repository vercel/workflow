#!/usr/bin/env node
import{a as m,b as h}from"./chunk-GTNBSMZR.js";import"./chunk-KGOUQS5A.js";var y={name:"ln",summary:"make links between files",usage:"ln [OPTIONS] TARGET LINK_NAME",options:["-s      create a symbolic link instead of a hard link","-f      remove existing destination files","-n      treat LINK_NAME as a normal file if it is a symbolic link to a directory","-v      print name of each linked file","    --help display this help and exit"]},p={name:"ln",async execute(i,s){if(h(i))return m(y);let r=!1,a=!1,d=!1,t=0;for(;t<i.length&&i[t].startsWith("-");){let e=i[t];if(e==="-s"||e==="--symbolic")r=!0,t++;else if(e==="-f"||e==="--force")a=!0,t++;else if(e==="-v"||e==="--verbose")d=!0,t++;else if(e==="-n"||e==="--no-dereference")t++;else if(/^-[sfvn]+$/.test(e))e.includes("s")&&(r=!0),e.includes("f")&&(a=!0),e.includes("v")&&(d=!0),t++;else if(e==="--"){t++;break}else return{stdout:"",stderr:`ln: invalid option -- '${e.slice(1)}'
`,exitCode:1}}let f=i.slice(t);if(f.length<2)return{stdout:"",stderr:`ln: missing file operand
`,exitCode:1};let n=f[0],l=f[1],o=s.fs.resolvePath(s.cwd,l);if(await s.fs.exists(o))if(a)try{await s.fs.rm(o,{force:!0})}catch{return{stdout:"",stderr:`ln: cannot remove '${l}': Permission denied
`,exitCode:1}}else return{stdout:"",stderr:`ln: failed to create ${r?"symbolic ":""}link '${l}': File exists
`,exitCode:1};try{if(r)await s.fs.symlink(n,o);else{let e=s.fs.resolvePath(s.cwd,n);if(!await s.fs.exists(e))return{stdout:"",stderr:`ln: failed to access '${n}': No such file or directory
`,exitCode:1};await s.fs.link(e,o)}}catch(e){let u=e;return u.message.includes("EPERM")?{stdout:"",stderr:`ln: '${n}': hard link not allowed for directory
`,exitCode:1}:{stdout:"",stderr:`ln: ${u.message}
`,exitCode:1}}let c="";return d&&(c=`'${l}' -> '${n}'
`),{stdout:c,stderr:"",exitCode:0}}};export{p as lnCommand};
