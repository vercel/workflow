export const get403ErrorMessage = (error: Error): string => {
  // Check if it's a 403 error
  if (
    error.message?.includes('403') ||
    error.message?.includes('Forbidden') ||
    (error as any).status === 403
  ) {
    return 'Your current Vercel account does not have access to this data. Please use `vercel login` to log in, or use `vercel switch` to ensure you can access the correct team.';
  }
  return error instanceof Error ? error.message : 'An error occurred';
};
