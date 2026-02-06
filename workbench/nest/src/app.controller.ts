import {
  Body,
  Controller,
  HttpCode,
  HttpException,
  HttpStatus,
  Post,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';
import { getHookByToken, resumeHook } from 'workflow/api';
import { getWorld, healthCheck } from 'workflow/runtime';

@Controller('api')
export class AppController {
  @Post('hook')
  async resumeWorkflowHook(
    @Body() body: { token: string; data: any } | string,
    @Res() res: Response
  ) {
    // Handle body as string (when Content-Type is not application/json) or object
    const parsedBody = typeof body === 'string' ? JSON.parse(body) : body;
    const { token, data } = parsedBody;

    let hook: Awaited<ReturnType<typeof getHookByToken>>;
    try {
      hook = await getHookByToken(token);
      console.log('hook', hook);
    } catch (error) {
      console.log('error during getHookByToken', error);
      // Return 422 for invalid token with null body (matching other workbench apps)
      return res.status(HttpStatus.UNPROCESSABLE_ENTITY).json(null);
    }

    await resumeHook(hook.token, {
      ...data,
      // @ts-expect-error metadata is not typed
      customData: hook.metadata?.customData,
    });

    return res.status(HttpStatus.OK).json(hook);
  }

  @Post('test-health-check')
  @HttpCode(HttpStatus.OK)
  async testHealthCheck(@Body() body: { endpoint?: string; timeout?: number }) {
    // This route tests the queue-based health check functionality
    try {
      const { endpoint = 'workflow', timeout = 30000 } = body;

      console.log(
        `Testing queue-based health check for endpoint: ${endpoint}, timeout: ${timeout}ms`
      );

      const world = getWorld();
      const result = await healthCheck(world, endpoint as 'workflow' | 'step', {
        timeout,
      });

      console.log(`Health check result:`, result);

      return result;
    } catch (error) {
      console.error('Health check test failed:', error);
      throw new HttpException(
        {
          healthy: false,
          error: error instanceof Error ? error.message : String(error),
        },
        HttpStatus.INTERNAL_SERVER_ERROR
      );
    }
  }

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
