import { registerStepFunction } from "workflow/internal/private";
import fs from 'fs/promises';
/**__internal_workflows{"steps":{"step//./input//myFactory/myStep":{"name":"myFactory/myStep","source":"input.js"}}}*/;
var myFactory$myStep = async ()=>{
    await fs.mkdir('test');
};
const myFactory = ()=>({
        myStep: myFactory$myStep
    });
export default myFactory;
registerStepFunction("step//./input//myFactory/myStep", myFactory$myStep);
