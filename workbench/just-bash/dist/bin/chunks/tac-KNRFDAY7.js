#!/usr/bin/env node
import"./chunk-KGOUQS5A.js";async function i(t,o){if(t.length>0&&t[0]!=="-"){let c=t[0].startsWith("/")?t[0]:`${o.cwd}/${t[0]}`;try{let n=(await o.fs.readFile(c)).split(`
`);n[n.length-1]===""&&n.pop();let s=n.reverse();return{stdout:s.length>0?`${s.join(`
`)}
`:"",stderr:"",exitCode:0}}catch{return{stdout:"",stderr:`tac: ${t[0]}: No such file or directory
`,exitCode:1}}}let e=o.stdin.split(`
`);e[e.length-1]===""&&e.pop();let r=e.reverse();return{stdout:r.length>0?`${r.join(`
`)}
`:"",stderr:"",exitCode:0}}var l={name:"tac",execute:i};export{l as tac};
