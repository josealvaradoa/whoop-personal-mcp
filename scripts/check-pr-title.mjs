const title = process.argv.slice(2).join(" ").trim();
const conventionalTitle = /^(feat|fix|docs|refactor|test|build|ci|chore|perf|revert|security)(\([a-z0-9._/-]+\))?!?: [^\s].+$/;

if (!title) {
  console.error("PR title is empty.");
  process.exit(1);
}

if (!conventionalTitle.test(title)) {
  console.error(
    "PR title must use Conventional Commit form, for example: " +
    "feat(mcp): add a resource or fix(auth): bind the redirect",
  );
  process.exit(1);
}

console.log(`PR title is valid: ${title}`);
