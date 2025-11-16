import { MessageData } from '../queue-drivers/types.js';

export const prepareRequestParams = (
  message: MessageData,
  securityToken: string
) => {
  return {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Workflow-Secret': securityToken,
    },
    body: JSON.stringify(MessageData.encode(message)),
  };
};
