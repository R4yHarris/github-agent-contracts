#!/usr/bin/env node
const login = "r4yharris-agent-coder[bot]";
const id = "334673250";
const email = `${id}+${login}@users.noreply.github.com`;
process.stdout.write(`GIT_AUTHOR_NAME=${login}\n`);
process.stdout.write(`GIT_AUTHOR_EMAIL=${email}\n`);
process.stdout.write(`GIT_COMMITTER_NAME=${login}\n`);
process.stdout.write(`GIT_COMMITTER_EMAIL=${email}\n`);
