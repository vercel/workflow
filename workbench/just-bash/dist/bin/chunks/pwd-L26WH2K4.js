#!/usr/bin/env node
import"./chunk-KGOUQS5A.js";var f={name:"pwd",async execute(r,t){let s=!1;for(let e of r)if(e==="-P")s=!0;else if(e==="-L")s=!1;else{if(e==="--")break;e.startsWith("-")}let a=t.cwd;if(s)try{a=await t.fs.realpath(t.cwd)}catch{}return{stdout:`${a}
`,stderr:"",exitCode:0}}};export{f as pwdCommand};
