import { registerStepFunction } from "workflow/internal/private";
import fs from 'fs/promises';
/**__internal_workflows{"steps":{"input.js":{"myFactory/myStep":{"stepId":"step//input.js//myFactory/myStep"}}}}*/;
var myFactory$myStep = async ()=>{
    await fs.mkdir('test');
};
const myFactory = ()=>({
        myStep: myFactory$myStep
    });
export default myFactory;
registerStepFunction("step//input.js//myFactory/myStep", myFactory$myStep);
