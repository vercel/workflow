#!/usr/bin/env node
import"./chunk-KGOUQS5A.js";var r={"File operations":["ls","cat","head","tail","wc","touch","mkdir","rm","cp","mv","ln","chmod","stat","readlink"],"Text processing":["grep","sed","awk","sort","uniq","cut","tr","tee","diff"],Search:["find"],"Navigation & paths":["pwd","basename","dirname","tree","du"],"Environment & shell":["echo","printf","env","printenv","export","alias","unalias","history","clear","true","false","bash","sh"],"Data processing":["xargs","jq","base64","date"],Network:["curl","html-to-markdown"]};function l(t){let e=[],n=new Set(t);e.push(`Available commands:
`);let s=[];for(let[o,c]of Object.entries(r)){let a=c.filter(i=>n.has(i));if(a.length>0){e.push(`  ${o}:`),e.push(`    ${a.join(", ")}
`);for(let i of a)n.delete(i)}}for(let o of n)s.push(o);return s.length>0&&(e.push("  Other:"),e.push(`    ${s.sort().join(", ")}
`)),e.push("Use '<command> --help' for details on a specific command."),`${e.join(`
`)}
`}var d={name:"help",async execute(t,e){if(t.includes("--help")||t.includes("-h"))return{stdout:`help - display available commands

Usage: help [command]

Options:
  -h, --help    Show this help message

If a command name is provided, shows help for that command.
Otherwise, lists all available commands.
`,stderr:"",exitCode:0};if(t.length>0&&e.exec){let s=t[0];return e.exec(`${s} --help`,{cwd:e.cwd})}let n=e.getRegisteredCommands?.()??[];return{stdout:l(n),stderr:"",exitCode:0}}};export{d as helpCommand};
