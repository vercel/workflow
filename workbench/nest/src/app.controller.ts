import { Body, Controller, Post } from '@nestjs/common';

@Controller('api')
export class AppController {
  @Post('test-direct-step-call')
  async invokeStepDirectly(@Body() body: { x: number; y: number }) {
    // This route tests calling step functions directly outside of any workflow context
    // After the SWC compiler changes, step functions in client mode have their directive removed
    // and keep their original implementation, allowing them to be called as regular async functions
    const { add } = await import('./workflows/98_duplicate_case.js');

    const { x, y } = body;

    console.log(`Calling step function directly with x=${x}, y=${y}`);

    // Call step function directly as a regular async function (no workflow context)
    const result = await add(x, y);
    console.log(`add(${x}, ${y}) = ${result}`);

    return { result };
  }
}
