const { execSync } = require('child_process');

try {
  execSync('npm run lint:links', { stdio: 'inherit' });
} catch (error) {
  console.log('Link validation failed, but continuing with installation...');
}
