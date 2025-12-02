module.exports = async ({ github, context }) => {
  try {
    const permission = await github.rest.repos.getCollaboratorPermissionLevel({
      owner: context.repo.owner,
      repo: context.repo.repo,
      username: context.actor
    });
    
    const hasPermission = ['admin', 'write'].includes(permission.data.permission);
    console.log(`User ${context.actor} has permission: ${permission.data.permission}`);
    return hasPermission ? 'true' : 'false';
  } catch (error) {
    console.error('Error checking permissions:', error);
    return 'false';
  }
};
