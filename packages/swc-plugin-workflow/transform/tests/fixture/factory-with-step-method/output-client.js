/**__internal_workflows{"steps":{"input.js":{"myFactory/myStep":{"stepId":"step//./input//myFactory/myStep"}}}}*/;
var myFactory$myStep = async function() {
    await fs.mkdir('test');
};
const myFactory = ()=>({
        myStep: myFactory$myStep
    });
export default myFactory;
myFactory$myStep.stepId = "step//./input//myFactory/myStep";
